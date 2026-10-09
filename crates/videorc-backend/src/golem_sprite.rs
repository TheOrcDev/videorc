//! The Golem's pet on stream (plan 168, Phase B): one textured quad per output
//! leg, drawn by the CPU, Metal and D3D11 paths from a pre-scaled atlas.
//!
//! The backend owns the atlas (D5). The active pack (Alive, `golem_pet::load_pack`)
//! or the persona's state images as a flat pack (Still, `golem_pet::still_pack`)
//! is decoded once, off the compositor, then pre-scaled per leg to the on-canvas
//! cell size (`round(rect.w × canvasWidth)`, never upscaled, Lanczos3 on
//! premultiplied pixels), packed with 2 px transparent gutters and alpha-bled
//! RGB (so linear filtering never pulls a dark halo or a neighbour's pixels),
//! and kept as BGRA only under a process-unique revision. A leg's atlas is
//! rebuilt when the pack, the persona, the leg canvas or the rect size changes;
//! a size change waits 250 ms for the drag to settle and the old atlas keeps
//! drawing, scaled, until the new one lands. Every resident atlas shares one
//! 64 MiB budget: over it the cell size steps down and the log says so.
//!
//! Loading and pre-scaling run on one worker thread (`golem-sprite`), started
//! on demand and gone when idle; the compositor only ever swaps an `Arc`.
//!
//! Per frame each leg asks the slot for a [`GolemLegFrame`]: the atlas, the
//! [`GolemSpriteDraw`] its [`GolemSpriteSource`] picked (Phase B: the cell for
//! the Golem's state at rest; Phase C: the animator) and where the bubble
//! anchors above the head (D16). Z order (D9): captions, the pet, the bubble,
//! then the highlight card.

use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant, SystemTime};

use rayon::prelude::*;

use crate::cohost::{CohostAvatarState, CohostPersona, GolemAvatar};
use crate::golem_pet::{LoadedPack, PetFrameKind};
use crate::overlay_layout::{OverlayItemLayout, OverlayOrientation, OverlayRect};

/// Transparent gutter around every atlas cell (D5).
pub const GOLEM_SPRITE_GUTTER_PX: u32 = 2;
/// How far a transparent texel looks for an opaque neighbour's colour (D5).
pub const GOLEM_SPRITE_BLEED_PX: u32 = 2;
/// Every resident pet atlas together stays under this (D5).
pub const GOLEM_SPRITE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
/// A rect-size change waits this long for the size to settle (D5).
pub const GOLEM_SPRITE_RESCALE_DEBOUNCE: Duration = Duration::from_millis(250);
/// The smallest cell a budget step-down goes to.
pub const GOLEM_SPRITE_MIN_CELL_PX: u32 = 16;
/// Metal content namespace of the pet atlas: a key-addressed texture slot
/// that never moves when another layer appears (D8).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const GOLEM_SPRITE_METAL_NAMESPACE: u64 = 7;
/// Metal content namespace of the bubble raster (D8).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const GOLEM_BUBBLE_METAL_NAMESPACE: u64 = 8;
/// page-pet's transform origin when a manifest names none.
pub const GOLEM_SPRITE_DEFAULT_PIVOT: [f64; 2] = [0.5, 0.9];

/// The decoded pack stays resident this long after the last build, so a
/// second leg or a resize does not decode it again.
const SOURCE_RESIDENT_FOR: Duration = Duration::from_secs(60);
/// The worker thread ends after this long with nothing to do.
const WORKER_IDLE_EXIT: Duration = Duration::from_secs(90);
/// The longest the worker sleeps between looks at the slot.
const WORKER_POLL: Duration = Duration::from_millis(500);

static GOLEM_SPRITE_REVISION: AtomicU64 = AtomicU64::new(1);

fn next_revision() -> u64 {
    GOLEM_SPRITE_REVISION.fetch_add(1, Ordering::Relaxed)
}

// --- Legs and placement ------------------------------------------------------------

/// The two compositor legs (plan 164 D12): the primary canvas (the recording,
/// or the only stream) and the auxiliary (split or vertical stream) canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GolemSpriteLeg {
    Primary,
    Auxiliary,
}

impl GolemSpriteLeg {
    pub const ALL: [Self; 2] = [Self::Primary, Self::Auxiliary];

    pub(crate) fn index(self) -> usize {
        match self {
            Self::Primary => 0,
            Self::Auxiliary => 1,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Auxiliary => "auxiliary",
        }
    }
}

/// The pre-scaled cell side for a rect on a canvas (D5): `round(rect.w ×
/// canvasWidth)`, at least 1.
pub fn golem_cell_px(rect: OverlayRect, canvas_width: u32) -> u32 {
    (rect.w * f64::from(canvas_width.max(1))).round().max(1.0) as u32
}

/// The square the Golem's cell fills on a canvas, canvas pixels `[x, y, side,
/// side]`: the side is [`golem_cell_px`] (at most the canvas's shorter side),
/// centred on the rect horizontally, resting on the rect's bottom edge when the
/// rect sits in the lower half of the canvas (else hanging from its top edge),
/// and kept inside the canvas. Whole pixels, so every path rasterizes the same
/// edges.
pub fn golem_box(rect: OverlayRect, canvas_width: u32, canvas_height: u32) -> [f32; 4] {
    let width = f64::from(canvas_width.max(1));
    let height = f64::from(canvas_height.max(1));
    let side = f64::from(
        golem_cell_px(rect, canvas_width)
            .min(canvas_width.max(1))
            .min(canvas_height.max(1)),
    );
    let left = ((rect.x + rect.w / 2.0) * width - side / 2.0)
        .round()
        .clamp(0.0, width - side);
    let top = if rect.bottom_gravity() {
        ((rect.y + rect.h) * height).round() - side
    } else {
        (rect.y * height).round()
    }
    .clamp(0.0, height - side);
    [left as f32, top as f32, side as f32, side as f32]
}

/// The Golem's rect for a canvas: the layout's horizontal or vertical rect by
/// the canvas orientation.
pub fn golem_rect_for_canvas(
    layout: &OverlayItemLayout,
    canvas_width: u32,
    canvas_height: u32,
) -> OverlayRect {
    match OverlayOrientation::for_canvas(canvas_width, canvas_height) {
        OverlayOrientation::Horizontal => layout.horizontal,
        OverlayOrientation::Vertical => layout.vertical,
    }
}

/// Where the bubble raster's bottom-centre sits (D16): above the pet's head,
/// at the top of the neutral silhouette (`headTop` of the pack's sidecar) in
/// the untransformed box. The bubble never follows squash or rotation, so it
/// stays readable.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GolemBubbleAnchor {
    pub x: f32,
    pub y: f32,
}

pub fn golem_bubble_anchor(golem_box: [f32; 4], head_top: f64) -> GolemBubbleAnchor {
    let [x, y, w, h] = golem_box;
    GolemBubbleAnchor {
        x: x + w / 2.0,
        y: y + (head_top.clamp(0.0, 1.0) as f32) * h,
    }
}

/// The bubble's blit on a canvas, the same tuple as
/// `overlay_layout::overlay_blit_layout`: `(source_left, dest_left, dest_top,
/// draw_width)`. The renderer draws the bubble with its tail tip (plus a small
/// gap) on the bitmap's bottom edge, centred, so the bitmap's bottom-centre
/// goes on the anchor; it is kept inside the canvas, and a bitmap wider than
/// the canvas is centre-cropped. Rows past the canvas height are cut from the
/// bottom by every caller (`min(height, canvas_height)`).
pub fn golem_bubble_blit_layout(
    bubble_width: usize,
    bubble_height: usize,
    canvas_width: usize,
    canvas_height: usize,
    anchor: GolemBubbleAnchor,
) -> (usize, usize, usize, usize) {
    let canvas_width = canvas_width.max(1);
    let canvas_height = canvas_height.max(1);
    let draw_width = bubble_width.min(canvas_width).max(1);
    let draw_height = bubble_height.min(canvas_height).max(1);
    let source_left = bubble_width.saturating_sub(draw_width) / 2;
    let left = (f64::from(anchor.x) - draw_width as f64 / 2.0).round();
    let top = f64::from(anchor.y).round() - draw_height as f64;
    let dest_left = left.clamp(0.0, (canvas_width - draw_width) as f64) as usize;
    let dest_top = top.clamp(0.0, (canvas_height - draw_height) as f64) as usize;
    (source_left, dest_left, dest_top, draw_width)
}

// --- The draw ----------------------------------------------------------------------

/// One frame of the pet on one leg: which atlas cell, where, and how it is
/// turned. Every path maps a point `(u, v)` of the cell (0..1, y down) to the
/// canvas as
///
/// ```text
/// P      = center + (pivot - 0.5) * size          // the pivot, untransformed
/// local  = ((u - pivot.x) * size, (v - pivot.y) * size)
/// canvas = P + A * local + translate,   A = [[a, c], [b, d]]
/// ```
///
/// which is CSS `transform-origin: pivot; transform: matrix(a, b, c, d, e, f)`
/// on a `size` square: feed `affine = css[0..4]`, `translate = css[4..6]` and
/// `pivot = MotionTransform::pivot` straight from `golem_motion`'s
/// `MotionTransform::css_matrix()` (its translation is in canvas pixels at the
/// drawn size, i.e. configure the motion with `size`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GolemSpriteDraw {
    /// The cell to sample, atlas pixels `[x, y, w, h]` (gutters excluded).
    pub cell: [u32; 4],
    /// Canvas pixels: the centre of the untransformed square the cell fills.
    pub center: [f32; 2],
    /// Canvas pixels: that square's side.
    pub size: f32,
    /// Normalized point of the square the linear part turns around
    /// (page-pet's `[0.5, 0.9]` by default: the feet).
    pub pivot: [f32; 2],
    /// The 2x2 linear part in CSS order `[a, b, c, d]`:
    /// `x' = a·x + c·y`, `y' = b·x + d·y` (y down), about the pivot.
    pub affine: [f32; 4],
    /// Canvas pixels added after the linear part (CSS `e`, `f`).
    pub translate: [f32; 2],
    /// 0..1, multiplies the cell's alpha.
    pub opacity: f32,
}

impl GolemSpriteDraw {
    pub const IDENTITY_AFFINE: [f32; 4] = [1.0, 0.0, 0.0, 1.0];

    /// The cell at rest, filling `golem_box` (Phase B's static draw).
    pub fn at_rest(cell: [u32; 4], golem_box: [f32; 4], pivot: [f64; 2]) -> Self {
        let [x, y, w, h] = golem_box;
        Self {
            cell,
            center: [x + w / 2.0, y + h / 2.0],
            size: w.min(h),
            pivot: [pivot[0] as f32, pivot[1] as f32],
            affine: Self::IDENTITY_AFFINE,
            translate: [0.0, 0.0],
            opacity: 1.0,
        }
    }

    /// The pivot's canvas position before the transform.
    #[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))] // D3D11's pivot
    pub fn pivot_point(&self) -> [f32; 2] {
        [
            self.center[0] + (self.pivot[0] - 0.5) * self.size,
            self.center[1] + (self.pivot[1] - 0.5) * self.size,
        ]
    }

    /// The whole map from the cell's unit square to the canvas, `[m00, m10,
    /// m01, m11, tx, ty]`: `x = m00·u + m01·v + tx`, `y = m10·u + m11·v + ty`.
    pub fn unit_to_canvas(&self) -> [f32; 6] {
        let [a, b, c, d] = self.affine.map(f64::from);
        let size = f64::from(self.size);
        let [pivot_u, pivot_v] = self.pivot.map(f64::from);
        let (px, py) = (pivot_u * size, pivot_v * size);
        // The pivot's canvas position: centre + (pivot - 0.5) * size.
        let pivot_x = f64::from(self.center[0]) + (pivot_u - 0.5) * size;
        let pivot_y = f64::from(self.center[1]) + (pivot_v - 0.5) * size;
        [
            (a * size) as f32,
            (b * size) as f32,
            (c * size) as f32,
            (d * size) as f32,
            (pivot_x + f64::from(self.translate[0]) - (a * px + c * py)) as f32,
            (pivot_y + f64::from(self.translate[1]) - (b * px + d * py)) as f32,
        ]
    }

    /// The cell's corners on the canvas: `(u, v)` = (0, 0), (1, 0), (0, 1),
    /// (1, 1), i.e. top-left, top-right, bottom-left, bottom-right.
    #[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))] // Metal's quad
    pub fn corners(&self) -> [[f32; 2]; 4] {
        let [m00, m10, m01, m11, tx, ty] = self.unit_to_canvas();
        [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
            .map(|[u, v]| [m00 * u + m01 * v + tx, m10 * u + m11 * v + ty])
    }

    /// Finite, visible and invertible; anything else draws nothing.
    pub fn is_drawable(&self) -> bool {
        let values = [
            self.center[0],
            self.center[1],
            self.size,
            self.pivot[0],
            self.pivot[1],
            self.affine[0],
            self.affine[1],
            self.affine[2],
            self.affine[3],
            self.translate[0],
            self.translate[1],
            self.opacity,
        ];
        let [a, b, c, d] = self.affine;
        values.iter().all(|value| value.is_finite())
            && self.size > 0.0
            && self.opacity > 0.0
            && (a * d - b * c).abs() > 1e-6
            && self.cell[2] > 0
            && self.cell[3] > 0
    }
}

// --- The atlas ----------------------------------------------------------------------

/// One frame of the pack in a leg's atlas.
#[derive(Debug, Clone, PartialEq)]
pub struct GolemSpriteCell {
    pub id: String,
    pub kind: PetFrameKind,
    /// Gaze frames: page-pet's `[x, y]` in [-1, 1]² (negative x = viewer's
    /// left, negative y = up).
    pub gaze: Option<[f64; 2]>,
    /// The cell's pixels in the atlas, `[x, y, w, h]` (gutters excluded).
    /// Frames drawn from the same source cell share one atlas cell.
    pub rect: [u32; 4],
}

/// What the pack says about itself, shared by every leg's atlas.
#[derive(Debug, Clone, PartialEq)]
pub struct GolemSpritePackMeta {
    /// A uuid, `bundled:<name>`, or `still`.
    pub pack_id: String,
    /// The gaze frame the pet rests on.
    pub neutral: String,
    /// Normalized transform origin (`[0.5, 0.9]` when the manifest has none).
    pub pivot: [f64; 2],
    /// Normalized top of the neutral silhouette in its cell (D16).
    pub head_top: f64,
    /// Talk frames present in the pack (D12), possibly empty.
    pub talk: Vec<String>,
    /// The pack's own largest cell side: an atlas never upscales past it.
    pub source_cell_px: u32,
    /// Distinct source cells (frames on the same rect share one).
    pub unique_cells: usize,
}

/// A leg's pre-scaled atlas: BGRA, straight alpha, every cell `cell_px`
/// square inside a transparent [`GOLEM_SPRITE_GUTTER_PX`] gutter, alpha-bled.
pub struct GolemSpriteAtlas {
    /// Process-unique; the texture caches key on it (Metal namespace 7,
    /// D3D11 upload revision).
    pub revision: u64,
    pub bgra: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub cell_px: u32,
    pub cells: Vec<GolemSpriteCell>,
    pub meta: Arc<GolemSpritePackMeta>,
    built_for: Option<(LegKey, u64)>,
}

impl fmt::Debug for GolemSpriteAtlas {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GolemSpriteAtlas")
            .field("revision", &self.revision)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("cell_px", &self.cell_px)
            .field("cells", &self.cells.len())
            .field("pack_id", &self.meta.pack_id)
            .finish()
    }
}

impl GolemSpriteAtlas {
    pub fn cell(&self, id: &str) -> Option<&GolemSpriteCell> {
        self.cells.iter().find(|cell| cell.id == id)
    }

    pub fn neutral(&self) -> Option<&GolemSpriteCell> {
        self.cell(&self.meta.neutral)
    }

    /// The cell plan 164's state shows: a reaction named after the state
    /// (`talk`, `laugh`, `think`: every still pack has them) when the pack
    /// has it, else the neutral cell.
    pub fn cell_for_state(&self, state: CohostAvatarState) -> Option<&GolemSpriteCell> {
        if state != CohostAvatarState::Idle
            && let Some(cell) = self
                .cells
                .iter()
                .find(|cell| cell.kind == PetFrameKind::Reaction && cell.id == state.as_str())
        {
            return Some(cell);
        }
        self.neutral()
    }

    pub fn bytes(&self) -> u64 {
        self.bgra.len() as u64
    }

    /// An atlas from square RGBA cells already at `cell_px` (the builder and
    /// test fixtures): cell `i` of `cells` serves every frame whose cell
    /// index is `i`.
    pub(crate) fn from_cells(
        cells: &[image::RgbaImage],
        cell_px: u32,
        frames: Vec<AtlasFrame>,
        meta: Arc<GolemSpritePackMeta>,
    ) -> Self {
        let (bgra, width, height, rects) = pack_atlas(cells, cell_px);
        Self {
            revision: next_revision(),
            bgra: Arc::new(bgra),
            width,
            height,
            cell_px,
            cells: frames
                .into_iter()
                .filter_map(|(id, kind, gaze, index)| {
                    rects.get(index).map(|rect| GolemSpriteCell {
                        id,
                        kind,
                        gaze,
                        rect: *rect,
                    })
                })
                .collect(),
            meta,
            built_for: None,
        }
    }
}

/// One frame for [`GolemSpriteAtlas::from_cells`]: its id, kind, gaze and the
/// index of the cell it shows.
pub(crate) type AtlasFrame = (String, PetFrameKind, Option<[f64; 2]>, usize);

/// Columns and rows of an atlas grid for `cells` cells: near square, so the
/// texture stays far under the 16384 px GPU limit (64 cells of 1028 px is
/// 8224 px).
fn atlas_grid(cells: usize) -> (u32, u32) {
    let count = cells.max(1) as u32;
    let columns = (f64::from(count).sqrt().ceil() as u32).max(1);
    (columns, count.div_ceil(columns))
}

/// Resident bytes of an atlas with `cells` cells of `cell_px`.
pub fn golem_atlas_bytes(cell_px: u32, cells: usize) -> u64 {
    let (columns, rows) = atlas_grid(cells);
    let slot = u64::from(cell_px + 2 * GOLEM_SPRITE_GUTTER_PX);
    u64::from(columns) * slot * u64::from(rows) * slot * 4
}

/// The cell sizes one build uses (D5): each leg's requested size, all stepped
/// down together (5 % a step, never under [`GOLEM_SPRITE_MIN_CELL_PX`]) until
/// they and the atlases already resident fit the budget.
pub fn plan_cell_sizes(
    requested: &[u32],
    cells: usize,
    other_resident_bytes: u64,
    budget: u64,
) -> Vec<u32> {
    let available = budget.saturating_sub(other_resident_bytes);
    let fits = |sizes: &[u32]| {
        sizes
            .iter()
            .map(|size| golem_atlas_bytes(*size, cells))
            .sum::<u64>()
            <= available
    };
    if fits(requested) {
        return requested.to_vec();
    }
    let mut factor = 1.0_f64;
    loop {
        factor *= 0.95;
        let sizes = requested
            .iter()
            .map(|size| {
                ((f64::from(*size) * factor).floor() as u32)
                    .min(*size)
                    .max(GOLEM_SPRITE_MIN_CELL_PX)
            })
            .collect::<Vec<_>>();
        if fits(&sizes)
            || sizes
                .iter()
                .zip(requested)
                .all(|(size, requested)| *size == GOLEM_SPRITE_MIN_CELL_PX.min(*requested))
        {
            return sizes;
        }
    }
}

/// Pack square RGBA cells (each `cell_px`) into a BGRA atlas grid. Every cell
/// sits in a slot `cell_px + 2·gutter` wide with transparent gutters, and is
/// alpha-bled inside its own slot (never into a neighbour's). Returns the
/// bytes, the atlas size and each cell's rect (gutters excluded).
fn pack_atlas(cells: &[image::RgbaImage], cell_px: u32) -> (Vec<u8>, u32, u32, Vec<[u32; 4]>) {
    let gutter = GOLEM_SPRITE_GUTTER_PX;
    let slot = cell_px + 2 * gutter;
    let (columns, rows) = atlas_grid(cells.len());
    let width = columns * slot;
    let height = rows * slot;
    let slots = cells
        .par_iter()
        .map(|cell| {
            let mut slot_image = image::RgbaImage::new(slot, slot);
            image::imageops::replace(&mut slot_image, cell, i64::from(gutter), i64::from(gutter));
            alpha_bleed(&mut slot_image, GOLEM_SPRITE_BLEED_PX);
            slot_image
        })
        .collect::<Vec<_>>();
    let row_bytes = width as usize * 4;
    let mut bgra = vec![0_u8; row_bytes * height as usize];
    let mut rects = Vec::with_capacity(cells.len());
    for (index, slot_image) in slots.iter().enumerate() {
        let column = index as u32 % columns;
        let row = index as u32 / columns;
        let (left, top) = (column * slot, row * slot);
        for y in 0..slot {
            let start = (top + y) as usize * row_bytes + left as usize * 4;
            let line = &mut bgra[start..start + slot as usize * 4];
            let source =
                &slot_image.as_raw()[y as usize * slot as usize * 4..][..slot as usize * 4];
            for (out, pixel) in line.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                out.copy_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
        }
        rects.push([left + gutter, top + gutter, cell_px, cell_px]);
    }
    (bgra, width, height, rects)
}

/// Alpha bleed (D5): every fully transparent texel takes the RGB of its
/// nearest non-transparent neighbour within `radius` texels (alpha stays 0),
/// so bilinear filtering at a silhouette edge blends toward the edge's own
/// colour instead of black.
pub(crate) fn alpha_bleed(image: &mut image::RgbaImage, radius: u32) {
    let (width, height) = image.dimensions();
    let radius = radius as i64;
    let source = image.clone();
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            if source.get_pixel(x as u32, y as u32)[3] != 0 {
                continue;
            }
            let mut best: Option<(i64, [u8; 3])> = None;
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= width as i64 || ny >= height as i64 {
                        continue;
                    }
                    let neighbour = source.get_pixel(nx as u32, ny as u32);
                    if neighbour[3] == 0 {
                        continue;
                    }
                    let distance = dx * dx + dy * dy;
                    if best.is_none_or(|(nearest, _)| distance < nearest) {
                        best = Some((distance, [neighbour[0], neighbour[1], neighbour[2]]));
                    }
                }
            }
            if let Some((_, rgb)) = best {
                image.put_pixel(x as u32, y as u32, image::Rgba([rgb[0], rgb[1], rgb[2], 0]));
            }
        }
    }
}

/// One source cell at `cell_px` (never upscaled): Lanczos3 on premultiplied
/// pixels, so transparent RGB never darkens an edge, then straight alpha again.
pub(crate) fn scale_cell(cell: &image::RgbaImage, cell_px: u32) -> image::RgbaImage {
    let (width, height) = cell.dimensions();
    if cell_px >= width && cell_px >= height {
        return cell.clone();
    }
    let premultiplied =
        image::ImageBuffer::<image::Rgba<f32>, Vec<f32>>::from_fn(width, height, |x, y| {
            let pixel = cell.get_pixel(x, y);
            let alpha = f32::from(pixel[3]) / 255.0;
            image::Rgba([
                f32::from(pixel[0]) / 255.0 * alpha,
                f32::from(pixel[1]) / 255.0 * alpha,
                f32::from(pixel[2]) / 255.0 * alpha,
                alpha,
            ])
        });
    let scaled = image::imageops::resize(
        &premultiplied,
        cell_px,
        cell_px,
        image::imageops::FilterType::Lanczos3,
    );
    image::RgbaImage::from_fn(cell_px, cell_px, |x, y| {
        let pixel = scaled.get_pixel(x, y);
        let alpha = pixel[3].clamp(0.0, 1.0);
        let alpha_byte = (alpha * 255.0).round() as u8;
        if alpha_byte == 0 {
            return image::Rgba([0, 0, 0, 0]);
        }
        let channel = |value: f32| ((value / alpha).clamp(0.0, 1.0) * 255.0).round() as u8;
        image::Rgba([
            channel(pixel[0]),
            channel(pixel[1]),
            channel(pixel[2]),
            alpha_byte,
        ])
    })
}

/// What a loaded pack says about itself (see [`GolemSpritePackMeta`]).
pub(crate) fn pack_meta(pack: &LoadedPack) -> Result<GolemSpritePackMeta, String> {
    let neutral = pack
        .manifest
        .neutral_frame()
        .ok_or_else(|| format!("Pack {} has no neutral gaze frame.", pack.pack_id))?;
    let source_cell_px = pack
        .manifest
        .frames
        .iter()
        .map(|frame| frame.rect[2].max(frame.rect[3]))
        .max()
        .unwrap_or(neutral.rect[2])
        .max(1);
    Ok(GolemSpritePackMeta {
        pack_id: pack.pack_id.clone(),
        neutral: neutral.id.clone(),
        pivot: pack.manifest.pivot.unwrap_or(GOLEM_SPRITE_DEFAULT_PIVOT),
        head_top: pack.sidecar.head_top.clamp(0.0, 1.0),
        talk: pack
            .sidecar
            .talk
            .iter()
            .filter(|id| pack.manifest.frame(id).is_some())
            .cloned()
            .collect(),
        source_cell_px,
        unique_cells: unique_source_cells(pack).0.len(),
    })
}

/// The distinct `(sheet, rect)` cells of a pack in manifest order, and for
/// every frame the index of its cell.
fn unique_source_cells(pack: &LoadedPack) -> (Vec<(String, [u32; 4])>, Vec<usize>) {
    let mut unique: Vec<(String, [u32; 4])> = Vec::new();
    let mut indices = Vec::with_capacity(pack.manifest.frames.len());
    for frame in &pack.manifest.frames {
        let key = (frame.sheet.clone(), frame.rect);
        let index = match unique.iter().position(|cell| *cell == key) {
            Some(index) => index,
            None => {
                unique.push(key);
                unique.len() - 1
            }
        };
        indices.push(index);
    }
    (unique, indices)
}

/// Pre-scale a pack into one leg's atlas at `cell_px` (D5). Blocking (decoded
/// pixels in, resized pixels out, cells in parallel): the worker runs it.
pub(crate) fn build_atlas(
    pack: &LoadedPack,
    meta: &Arc<GolemSpritePackMeta>,
    cell_px: u32,
) -> Result<GolemSpriteAtlas, String> {
    let (unique, indices) = unique_source_cells(pack);
    let cells = unique
        .par_iter()
        .map(|(sheet, [x, y, w, h])| {
            let sheet = pack
                .sheets
                .get(sheet)
                .ok_or_else(|| format!("Sheet {sheet} is not loaded."))?;
            if x + w > sheet.width() || y + h > sheet.height() {
                return Err(format!(
                    "A cell of {} lies outside its sheet.",
                    meta.pack_id
                ));
            }
            let source = image::imageops::crop_imm(sheet, *x, *y, *w, *h).to_image();
            // A non-square or small cell is contained in the square, bottom
            // aligned, the way the still pack lays its images out.
            let fitted = scale_cell(&source, cell_px);
            if fitted.dimensions() == (cell_px, cell_px) {
                Ok(fitted)
            } else {
                let mut square = image::RgbaImage::new(cell_px, cell_px);
                let (fw, fh) = fitted.dimensions();
                image::imageops::replace(
                    &mut square,
                    &fitted,
                    i64::from(cell_px.saturating_sub(fw) / 2),
                    i64::from(cell_px.saturating_sub(fh)),
                );
                Ok(square)
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    let frames = pack
        .manifest
        .frames
        .iter()
        .zip(indices)
        .map(|(frame, index)| (frame.id.clone(), frame.kind, frame.gaze, index))
        .collect();
    Ok(GolemSpriteAtlas::from_cells(
        &cells,
        cell_px,
        frames,
        Arc::clone(meta),
    ))
}

// --- The source (what Phase C replaces) ------------------------------------------------

/// Everything one leg knows when it draws the Golem: Phase C's gaze targets,
/// the box the cell fills, the clock and the leg's atlas.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // The animator reads the clock, leg, box, card and state; not yet the caption bar.
pub struct GolemSpriteLegContext<'a> {
    pub leg: GolemSpriteLeg,
    /// Seconds on the frame clock. CPU and Metal: one value per composed frame
    /// (`published_at`), shared by both legs. D3D11: the pump's
    /// `output_sequence / fps`.
    pub now_seconds: f64,
    /// The leg canvas, pixels.
    pub canvas: (u32, u32),
    /// The Golem's placed rect for this canvas orientation (canvas units).
    pub golem_rect: OverlayRect,
    /// The untransformed square the cell fills, canvas pixels `[x, y, w, h]`.
    pub golem_box: [f32; 4],
    /// The highlight card's blit on this leg, canvas pixels `[x, y, w, h]`,
    /// while one shows here.
    pub highlight_rect: Option<[f32; 4]>,
    /// The caption bar's blit on this leg, canvas pixels, while one shows here.
    pub caption_rect: Option<[f32; 4]>,
    /// Plan 164's state: idle, or the bubble's talk / laugh / think, or a
    /// pending answer's think.
    pub avatar_state: CohostAvatarState,
    /// The atlas this leg draws from (cells by frame id, pivot, head top).
    pub atlas: &'a GolemSpriteAtlas,
}

/// Picks what the pet looks like on a leg at a moment. Called once per leg per
/// composed frame, with the same `now_seconds` for both legs of one frame;
/// `None` draws nothing on that leg.
pub trait GolemSpriteSource: Send {
    fn draw(&mut self, context: &GolemSpriteLegContext<'_>) -> Option<GolemSpriteDraw>;

    /// Something happened the pet may react to (plan 168 S-C3), at `at`. The
    /// per-frame call carries no events, so they arrive here, under the
    /// slot's lock, and wait for the next frame. A static source ignores them.
    fn notify(&mut self, _at: Instant, _event: crate::golem_animator::GolemAnimatorEvent) {}
}

/// Phase B's source: the cell for the Golem's state, at rest (identity
/// transform, full opacity). The neutral cell while idle; a still pack's
/// `talk` / `laugh` / `think` image while a bubble or a pending answer shows
/// it, as plan 164 drew it. A slot starts with it; `AppState::new` installs
/// the animator (`golem_animator::GolemAnimatorSource`, Phase C) instead.
#[derive(Debug, Default, Clone, Copy)]
pub struct StaticGolemSpriteSource;

impl GolemSpriteSource for StaticGolemSpriteSource {
    fn draw(&mut self, context: &GolemSpriteLegContext<'_>) -> Option<GolemSpriteDraw> {
        let cell = context.atlas.cell_for_state(context.avatar_state)?;
        Some(GolemSpriteDraw::at_rest(
            cell.rect,
            context.golem_box,
            context.atlas.meta.pivot,
        ))
    }
}

// --- Per frame ------------------------------------------------------------------------

/// One leg's ask for this frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GolemLegRequest {
    pub leg: GolemSpriteLeg,
    pub canvas: (u32, u32),
    pub now_seconds: f64,
    pub highlight_rect: Option<[f32; 4]>,
    pub caption_rect: Option<[f32; 4]>,
}

/// The pet and its draw for one frame on one leg.
#[derive(Debug, Clone)]
pub struct GolemSpriteLayer {
    pub atlas: Arc<GolemSpriteAtlas>,
    pub draw: GolemSpriteDraw,
}

/// One leg's Golem for one frame: the pet (none until its atlas exists, or
/// when the source draws nothing) and where the bubble anchors.
#[derive(Debug, Clone)]
pub struct GolemLegFrame {
    /// The untransformed square on this leg (the context's `golem_box`).
    #[cfg_attr(not(test), allow(dead_code))] // tests and diagnostics read it
    pub golem_box: [f32; 4],
    pub sprite: Option<GolemSpriteLayer>,
    pub bubble_anchor: GolemBubbleAnchor,
}

// --- The slot -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LegKey {
    canvas: (u32, u32),
    rect_px: u32,
}

#[derive(Debug, Clone, Copy)]
struct LegWant {
    key: LegKey,
    since: Instant,
}

#[derive(Default)]
struct LegState {
    atlas: Option<Arc<GolemSpriteAtlas>>,
    want: Option<LegWant>,
}

/// Whether a leg's pending build may run at `now`: at once when the leg has
/// no atlas of this pack generation or the canvas changed; a size change only
/// once it has been stable for [`GOLEM_SPRITE_RESCALE_DEBOUNCE`].
fn want_is_due(
    atlas: Option<&GolemSpriteAtlas>,
    want: LegWant,
    generation: u64,
    now: Instant,
) -> bool {
    match atlas.and_then(|atlas| atlas.built_for) {
        Some((key, built_generation))
            if built_generation == generation && key.canvas == want.key.canvas =>
        {
            now.saturating_duration_since(want.since) >= GOLEM_SPRITE_RESCALE_DEBOUNCE
        }
        _ => true,
    }
}

/// What the atlases were built from: the pack id, or for a still pack the
/// persona's images with their size and modification time (a regenerated
/// image keeps its path).
#[derive(Debug, Clone, PartialEq, Eq)]
enum SourceKey {
    Alive {
        persona_id: String,
        pack_id: String,
    },
    Still {
        persona_id: String,
        images: Vec<(String, Option<ImageStat>)>,
    },
}

/// A still image's size and modification time.
type ImageStat = (u64, Option<SystemTime>);

fn source_key(persona: &CohostPersona, roots: &[PathBuf]) -> SourceKey {
    match &persona.avatar {
        GolemAvatar::Alive { pack_id } => SourceKey::Alive {
            persona_id: persona.id.clone(),
            pack_id: pack_id.clone(),
        },
        GolemAvatar::Still => {
            let images = &persona.images;
            SourceKey::Still {
                persona_id: persona.id.clone(),
                images: [&images.idle, &images.talk, &images.laugh, &images.think]
                    .into_iter()
                    .flatten()
                    .map(|path| {
                        let stat = roots
                            .first()
                            .and_then(|root| std::fs::metadata(root.join(path)).ok())
                            .map(|metadata| (metadata.len(), metadata.modified().ok()));
                        (path.clone(), stat)
                    })
                    .collect(),
            }
        }
    }
}

/// Decode the persona's pack: its Alive pack, else (or when that fails) the
/// still pack. Every fallback taken is a sentence for the log.
fn load_source(
    persona: &CohostPersona,
    roots: &[PathBuf],
) -> Result<(LoadedPack, Vec<String>), String> {
    let mut notes = Vec::new();
    let pack = match &persona.avatar {
        GolemAvatar::Alive { pack_id } => {
            match crate::golem_pet::load_pack(roots, &persona.id, pack_id) {
                Ok(pack) => pack,
                Err(error) => {
                    notes.push(format!(
                        "The Golem pack {pack_id} could not be loaded ({}); the still Golem shows instead.",
                        error.message
                    ));
                    crate::golem_pet::still_pack(persona, roots).map_err(|error| error.message)?
                }
            }
        }
        GolemAvatar::Still => {
            crate::golem_pet::still_pack(persona, roots).map_err(|error| error.message)?
        }
    };
    notes.extend(pack.notes.iter().cloned());
    Ok((pack, notes))
}

struct SlotState {
    persona: CohostPersona,
    layout: OverlayItemLayout,
    avatar_state: CohostAvatarState,
    roots_override: Option<Vec<PathBuf>>,
    /// Bumped on every persona save or invalidation; the worker re-checks the
    /// pack whenever it differs from `checked_epoch`.
    source_epoch: u64,
    checked_epoch: u64,
    /// The epoch whose pack could not load at all: nothing builds until the
    /// next change.
    failed_epoch: Option<u64>,
    loaded_key: Option<SourceKey>,
    meta: Option<Arc<GolemSpritePackMeta>>,
    /// Bumped whenever the pack's pixels changed: atlases of an older
    /// generation are stale (still drawn until replaced).
    generation: u64,
    legs: [LegState; 2],
    source: Box<dyn GolemSpriteSource>,
    worker_running: bool,
    last_activity: Instant,
    clock_origin: Instant,
}

impl SlotState {
    fn roots(&self) -> Vec<PathBuf> {
        self.roots_override
            .clone()
            .unwrap_or_else(crate::resource_authority::configured_managed_golem_roots)
    }

    fn has_work(&self) -> bool {
        self.source_epoch != self.checked_epoch || self.legs.iter().any(|leg| leg.want.is_some())
    }

    fn next_job(&mut self, now: Instant) -> Option<Job> {
        if self.source_epoch != self.checked_epoch {
            return Some(Job::Check {
                epoch: self.source_epoch,
                persona: self.persona.clone(),
                roots: self.roots(),
            });
        }
        if self.failed_epoch == Some(self.source_epoch) {
            return None;
        }
        let generation = self.generation;
        let due = GolemSpriteLeg::ALL
            .into_iter()
            .filter_map(|leg| {
                let state = &self.legs[leg.index()];
                let want = state.want?;
                want_is_due(state.atlas.as_deref(), want, generation, now)
                    .then_some((leg, want.key))
            })
            .collect::<Vec<_>>();
        if due.is_empty() {
            return None;
        }
        let other_resident_bytes = GolemSpriteLeg::ALL
            .into_iter()
            .filter(|leg| due.iter().all(|(due_leg, _)| due_leg != leg))
            .filter_map(|leg| self.legs[leg.index()].atlas.as_ref())
            .filter(|atlas| {
                atlas
                    .built_for
                    .is_some_and(|(_, built)| built == generation)
            })
            .map(|atlas| atlas.bytes())
            .sum();
        Some(Job::Build {
            generation,
            persona: self.persona.clone(),
            roots: self.roots(),
            loaded_key: self.loaded_key.clone(),
            legs: due,
            other_resident_bytes,
        })
    }

    /// The soonest a debounced want comes due.
    fn next_due(&self) -> Option<Instant> {
        self.legs
            .iter()
            .filter_map(|leg| {
                leg.want
                    .map(|want| want.since + GOLEM_SPRITE_RESCALE_DEBOUNCE)
            })
            .min()
    }
}

enum Job {
    Check {
        epoch: u64,
        persona: CohostPersona,
        roots: Vec<PathBuf>,
    },
    Build {
        generation: u64,
        persona: CohostPersona,
        roots: Vec<PathBuf>,
        loaded_key: Option<SourceKey>,
        legs: Vec<(GolemSpriteLeg, LegKey)>,
        other_resident_bytes: u64,
    },
}

/// The decoded pack the worker keeps between builds.
struct ResidentSource {
    key: SourceKey,
    generation: u64,
    pack: LoadedPack,
    meta: Arc<GolemSpritePackMeta>,
    last_used: Instant,
}

struct SlotInner {
    state: Mutex<SlotState>,
    wake: Condvar,
    events: Option<tokio::sync::broadcast::Sender<crate::protocol::ServerEvent>>,
}

impl SlotInner {
    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Log like `AppState::emit_log`: tracing plus the `log` event.
    fn log(&self, level: &str, message: String) {
        match level {
            "error" => tracing::error!("{message}"),
            "warn" => tracing::warn!("{message}"),
            _ => tracing::info!("{message}"),
        }
        if let Some(events) = self.events.as_ref() {
            let _ = events.send(crate::protocol::ServerEvent::new(
                "log",
                crate::protocol::BackendLogEvent {
                    level: level.to_string(),
                    message,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                },
            ));
        }
    }
}

/// The Golem's pet atlases and draws (one per process, on `AppState`).
#[derive(Clone)]
pub struct GolemSpriteSlot {
    inner: Arc<SlotInner>,
}

impl fmt::Debug for GolemSpriteSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GolemSpriteSlot")
            .finish_non_exhaustive()
    }
}

impl GolemSpriteSlot {
    pub fn new(
        persona: &CohostPersona,
        layout: OverlayItemLayout,
        events: Option<tokio::sync::broadcast::Sender<crate::protocol::ServerEvent>>,
    ) -> Self {
        let now = Instant::now();
        Self {
            inner: Arc::new(SlotInner {
                state: Mutex::new(SlotState {
                    persona: persona.clone(),
                    layout,
                    avatar_state: CohostAvatarState::Idle,
                    roots_override: None,
                    source_epoch: 1,
                    checked_epoch: 0,
                    failed_epoch: None,
                    loaded_key: None,
                    meta: None,
                    generation: 0,
                    legs: Default::default(),
                    source: Box::new(StaticGolemSpriteSource),
                    worker_running: false,
                    last_activity: now,
                    clock_origin: now,
                }),
                wake: Condvar::new(),
                events,
            }),
        }
    }

    /// The persona was saved (`cohost.settings.set`): the worker re-checks
    /// the pack (a changed avatar, pack, or still image rebuilds the atlases)
    /// and the source learns the persona's motion and reactions.
    pub fn set_persona(&self, persona: &CohostPersona) {
        let mut state = self.inner.lock();
        state.persona = persona.clone();
        state.source.notify(
            Instant::now(),
            crate::golem_animator::GolemAnimatorEvent::Settings(
                crate::golem_animator::GolemAnimatorSettings::from_persona(persona),
            ),
        );
        self.bump_epoch(&mut state);
    }

    /// A persona image was rewritten in place (a generated image keeps its
    /// path): re-check the pack.
    pub fn invalidate(&self) {
        let mut state = self.inner.lock();
        self.bump_epoch(&mut state);
    }

    fn bump_epoch(&self, state: &mut SlotState) {
        state.source_epoch = state.source_epoch.wrapping_add(1);
        state.last_activity = Instant::now();
        // Nothing to rebuild before anything was drawn: the first leg's ask
        // starts the worker.
        if state
            .legs
            .iter()
            .any(|leg| leg.atlas.is_some() || leg.want.is_some())
        {
            self.ensure_worker(state);
        }
    }

    /// `overlayLayout.golem` changed (`overlays.layout.set`).
    pub fn set_layout(&self, layout: OverlayItemLayout) {
        self.inner.lock().layout = layout;
    }

    /// `AppState::new` installs the animator here (plan 168 Phase C).
    pub fn set_source(&self, source: Box<dyn GolemSpriteSource>) {
        self.inner.lock().source = source;
    }

    /// Hand the source an event (plan 168 S-C3); it applies at the next frame.
    pub fn notify(&self, event: crate::golem_animator::GolemAnimatorEvent) {
        self.inner.lock().source.notify(Instant::now(), event);
    }

    /// Plan 164's state changed (`cohost.golem.state`), with the event that
    /// changed it, in one step: no frame sees the state without its event.
    pub fn set_avatar_state_and_notify(
        &self,
        avatar_state: CohostAvatarState,
        event: Option<crate::golem_animator::GolemAnimatorEvent>,
    ) {
        let mut state = self.inner.lock();
        state.avatar_state = avatar_state;
        if let Some(event) = event {
            state.source.notify(Instant::now(), event);
        }
    }

    /// Seconds since this slot was made, for the CPU/Metal frame clock.
    pub fn clock_seconds(&self, at: Instant) -> f64 {
        let origin = self.inner.lock().clock_origin;
        at.saturating_duration_since(origin).as_secs_f64()
    }

    /// Start building atlases for legs a session is about to draw, so the
    /// first frame has the Golem.
    pub fn prepare(&self, legs: &[(GolemSpriteLeg, (u32, u32))]) {
        let mut state = self.inner.lock();
        let now = Instant::now();
        let mut wake = false;
        for (leg, canvas) in legs {
            let rect = golem_rect_for_canvas(&state.layout, canvas.0, canvas.1);
            let key = LegKey {
                canvas: *canvas,
                rect_px: golem_cell_px(rect, canvas.0),
            };
            wake |= Self::record_want(&mut state, *leg, key, now);
        }
        if wake {
            state.last_activity = now;
            self.ensure_worker(&mut state);
        }
    }

    /// Record a leg's wish for an atlas matching `key`; true when it is new.
    fn record_want(state: &mut SlotState, leg: GolemSpriteLeg, key: LegKey, now: Instant) -> bool {
        let generation = state.generation;
        let leg_state = &mut state.legs[leg.index()];
        let current = leg_state
            .atlas
            .as_ref()
            .and_then(|atlas| atlas.built_for)
            .is_some_and(|built| built == (key, generation))
            && state.meta.is_some();
        if current {
            leg_state.want = None;
            return false;
        }
        if leg_state.want.map(|want| want.key) == Some(key) {
            return false;
        }
        leg_state.want = Some(LegWant { key, since: now });
        true
    }

    /// The Golem on one leg for this frame. Cheap: one short lock, an `Arc`
    /// clone and the source's draw; the pixels are never touched here.
    pub fn leg_frame(&self, request: GolemLegRequest) -> GolemLegFrame {
        let mut state = self.inner.lock();
        let (width, height) = request.canvas;
        let rect = golem_rect_for_canvas(&state.layout, width, height);
        let golem_box = golem_box(rect, width, height);
        let key = LegKey {
            canvas: request.canvas,
            rect_px: golem_cell_px(rect, width),
        };
        let now = Instant::now();
        if Self::record_want(&mut state, request.leg, key, now) {
            state.last_activity = now;
            self.ensure_worker(&mut state);
        } else if state.legs[request.leg.index()].want.is_some() && !state.worker_running {
            self.ensure_worker(&mut state);
        }
        let atlas = state.legs[request.leg.index()].atlas.clone();
        let head_top = atlas
            .as_ref()
            .map(|atlas| atlas.meta.head_top)
            .or_else(|| state.meta.as_ref().map(|meta| meta.head_top))
            .unwrap_or(0.0);
        let avatar_state = state.avatar_state;
        let sprite = atlas.and_then(|atlas| {
            let context = GolemSpriteLegContext {
                leg: request.leg,
                now_seconds: request.now_seconds,
                canvas: request.canvas,
                golem_rect: rect,
                golem_box,
                highlight_rect: request.highlight_rect,
                caption_rect: request.caption_rect,
                avatar_state,
                atlas: &atlas,
            };
            let draw = state.source.draw(&context)?;
            draw.is_drawable().then(|| GolemSpriteLayer {
                atlas: Arc::clone(&atlas),
                draw,
            })
        });
        GolemLegFrame {
            golem_box,
            sprite,
            bubble_anchor: golem_bubble_anchor(golem_box, head_top),
        }
    }

    fn ensure_worker(&self, state: &mut SlotState) {
        if state.worker_running {
            self.inner.wake.notify_all();
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        match std::thread::Builder::new()
            .name("golem-sprite".to_string())
            .spawn(move || worker_loop(weak))
        {
            Ok(_) => state.worker_running = true,
            Err(error) => tracing::error!("Golem sprite worker could not start: {error}"),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_roots(self, roots: Vec<PathBuf>) -> Self {
        self.inner.lock().roots_override = Some(roots);
        self
    }

    /// Test helper: wait until `leg` has an atlas built for its current ask.
    #[cfg(test)]
    pub(crate) fn wait_for_atlas(
        &self,
        leg: GolemSpriteLeg,
        predicate: impl Fn(&GolemSpriteAtlas) -> bool,
        timeout: Duration,
    ) -> Option<Arc<GolemSpriteAtlas>> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let state = self.inner.lock();
                if let Some(atlas) = state.legs[leg.index()].atlas.as_ref()
                    && state.legs[leg.index()].want.is_none()
                    && predicate(atlas)
                {
                    return Some(Arc::clone(atlas));
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(test)]
    pub(crate) fn resident_atlas(&self, leg: GolemSpriteLeg) -> Option<Arc<GolemSpriteAtlas>> {
        self.inner.lock().legs[leg.index()].atlas.clone()
    }

    /// Test helper: put an atlas in place as if the worker built it for the
    /// leg's current ask (fixtures that must not wait on a thread).
    #[cfg(test)]
    pub(crate) fn install_atlas_for_test(
        &self,
        leg: GolemSpriteLeg,
        canvas: (u32, u32),
        mut atlas: GolemSpriteAtlas,
    ) -> Arc<GolemSpriteAtlas> {
        let mut state = self.inner.lock();
        let rect = golem_rect_for_canvas(&state.layout, canvas.0, canvas.1);
        let key = LegKey {
            canvas,
            rect_px: golem_cell_px(rect, canvas.0),
        };
        let generation = state.generation;
        atlas.built_for = Some((key, generation));
        let atlas = Arc::new(atlas);
        state.meta = Some(Arc::clone(&atlas.meta));
        state.checked_epoch = state.source_epoch;
        state.legs[leg.index()] = LegState {
            atlas: Some(Arc::clone(&atlas)),
            want: None,
        };
        atlas
    }
}

fn worker_loop(weak: Weak<SlotInner>) {
    let mut resident: Option<ResidentSource> = None;
    loop {
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let job = {
            let mut state = inner.lock();
            let now = Instant::now();
            match state.next_job(now) {
                Some(job) => job,
                None => {
                    if resident.as_ref().is_some_and(|source| {
                        now.duration_since(source.last_used) >= SOURCE_RESIDENT_FOR
                    }) {
                        resident = None;
                    }
                    let due = state.next_due();
                    if resident.is_none()
                        && !state.has_work()
                        && now.saturating_duration_since(state.last_activity) >= WORKER_IDLE_EXIT
                    {
                        state.worker_running = false;
                        return;
                    }
                    let timeout = due
                        .map(|due| due.saturating_duration_since(now))
                        .unwrap_or(WORKER_POLL)
                        .clamp(Duration::from_millis(1), WORKER_POLL);
                    let _ = inner
                        .wake
                        .wait_timeout(state, timeout)
                        .unwrap_or_else(PoisonError::into_inner);
                    continue;
                }
            }
        };
        match job {
            Job::Check {
                epoch,
                persona,
                roots,
            } => run_check(&inner, epoch, &persona, &roots, &mut resident),
            Job::Build {
                generation,
                persona,
                roots,
                loaded_key,
                legs,
                other_resident_bytes,
            } => run_build(
                &inner,
                generation,
                &persona,
                &roots,
                loaded_key,
                &legs,
                other_resident_bytes,
                &mut resident,
            ),
        }
    }
}

fn run_check(
    inner: &SlotInner,
    epoch: u64,
    persona: &CohostPersona,
    roots: &[PathBuf],
    resident: &mut Option<ResidentSource>,
) {
    let key = source_key(persona, roots);
    {
        let mut state = inner.lock();
        if state.loaded_key.as_ref() == Some(&key) && state.meta.is_some() {
            state.checked_epoch = state.checked_epoch.max(epoch);
            return;
        }
    }
    let loaded = load_source(persona, roots).and_then(|(pack, notes)| {
        let meta = pack_meta(&pack)?;
        Ok((pack, notes, meta))
    });
    let mut state = inner.lock();
    state.checked_epoch = state.checked_epoch.max(epoch);
    state.generation = state.generation.wrapping_add(1);
    match loaded {
        Ok((pack, notes, meta)) => {
            let meta = Arc::new(meta);
            state.failed_epoch = None;
            state.loaded_key = Some(key.clone());
            state.meta = Some(Arc::clone(&meta));
            let generation = state.generation;
            drop(state);
            for note in notes {
                inner.log("warn", format!("Golem on stream: {note}"));
            }
            inner.log(
                "info",
                format!(
                    "Golem on stream: loaded pack {} ({} cells of {} px).",
                    meta.pack_id, meta.unique_cells, meta.source_cell_px
                ),
            );
            *resident = Some(ResidentSource {
                key,
                generation,
                pack,
                meta,
                last_used: Instant::now(),
            });
        }
        Err(reason) => {
            state.failed_epoch = Some(epoch);
            state.loaded_key = None;
            state.meta = None;
            for leg in &mut state.legs {
                *leg = LegState::default();
            }
            drop(state);
            *resident = None;
            inner.log(
                "error",
                format!("Golem on stream: the Golem could not be drawn: {reason}"),
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_build(
    inner: &SlotInner,
    generation: u64,
    persona: &CohostPersona,
    roots: &[PathBuf],
    loaded_key: Option<SourceKey>,
    legs: &[(GolemSpriteLeg, LegKey)],
    other_resident_bytes: u64,
    resident: &mut Option<ResidentSource>,
) {
    if resident.as_ref().is_none_or(|source| {
        source.generation != generation || Some(&source.key) != loaded_key.as_ref()
    }) {
        *resident = None;
        let key = source_key(persona, roots);
        if Some(&key) != loaded_key.as_ref() {
            // The pack changed since it was checked: check again first.
            let mut state = inner.lock();
            state.source_epoch = state.source_epoch.wrapping_add(1);
            return;
        }
        match load_source(persona, roots).and_then(|(pack, _)| {
            let meta = pack_meta(&pack)?;
            Ok((pack, meta))
        }) {
            Ok((pack, meta)) => {
                *resident = Some(ResidentSource {
                    key,
                    generation,
                    pack,
                    meta: Arc::new(meta),
                    last_used: Instant::now(),
                });
            }
            Err(reason) => {
                let mut state = inner.lock();
                let epoch = state.source_epoch;
                state.failed_epoch = Some(epoch);
                drop(state);
                inner.log(
                    "error",
                    format!("Golem on stream: the Golem could not be drawn: {reason}"),
                );
                return;
            }
        }
    }
    let Some(source) = resident.as_mut() else {
        return;
    };
    let meta = Arc::clone(&source.meta);
    let requested = legs
        .iter()
        .map(|(_, key)| key.rect_px.min(meta.source_cell_px).max(1))
        .collect::<Vec<_>>();
    let planned = plan_cell_sizes(
        &requested,
        meta.unique_cells,
        other_resident_bytes,
        GOLEM_SPRITE_BUDGET_BYTES,
    );
    let mut built = Vec::with_capacity(legs.len());
    for ((leg, key), (requested, cell_px)) in legs.iter().zip(requested.iter().zip(&planned)) {
        if cell_px < requested {
            inner.log(
                "warn",
                format!(
                    "Golem on stream: the {} atlas at {requested} px cells would pass the {} MiB budget for all pet atlases; it was built at {cell_px} px.",
                    leg.label(),
                    GOLEM_SPRITE_BUDGET_BYTES / (1024 * 1024)
                ),
            );
        }
        match build_atlas(&source.pack, &meta, *cell_px) {
            Ok(mut atlas) => {
                atlas.built_for = Some((*key, generation));
                built.push((*leg, *key, Arc::new(atlas)));
            }
            Err(reason) => inner.log(
                "error",
                format!(
                    "Golem on stream: the {} atlas could not be built: {reason}",
                    leg.label()
                ),
            ),
        }
    }
    source.last_used = Instant::now();
    let mut state = inner.lock();
    if state.generation != generation {
        return;
    }
    for (leg, key, atlas) in built {
        let leg_state = &mut state.legs[leg.index()];
        leg_state.atlas = Some(atlas);
        if leg_state.want.is_some_and(|want| want.key == key) {
            leg_state.want = None;
        }
    }
}

// --- CPU path (S-B3) ----------------------------------------------------------------

/// The inverse map and bilinear fetch for one draw.
struct SpriteSampler<'a> {
    bgra: &'a [u8],
    atlas_width: usize,
    cell: [f32; 4],
    /// Texel bounds a fetch is clamped to: the cell and its gutter, never a
    /// neighbour's slot.
    clamp: [i64; 4],
    forward: [f32; 6],
    inverse: [f32; 4],
}

impl<'a> SpriteSampler<'a> {
    fn new(atlas: &'a GolemSpriteAtlas, draw: &GolemSpriteDraw) -> Option<Self> {
        if !draw.is_drawable() {
            return None;
        }
        let [x, y, w, h] = draw.cell;
        if x.checked_add(w)? > atlas.width
            || y.checked_add(h)? > atlas.height
            || atlas.bgra.len() < atlas.width as usize * atlas.height as usize * 4
        {
            return None;
        }
        let forward = draw.unit_to_canvas();
        let [m00, m10, m01, m11, _, _] = forward;
        let determinant = m00 * m11 - m01 * m10;
        if determinant.abs() < 1e-9 {
            return None;
        }
        let gutter = i64::from(GOLEM_SPRITE_GUTTER_PX);
        Some(Self {
            bgra: &atlas.bgra,
            atlas_width: atlas.width as usize,
            cell: [x as f32, y as f32, w as f32, h as f32],
            clamp: [
                (i64::from(x) - gutter).max(0),
                (i64::from(y) - gutter).max(0),
                (i64::from(x + w) - 1 + gutter).min(i64::from(atlas.width) - 1),
                (i64::from(y + h) - 1 + gutter).min(i64::from(atlas.height) - 1),
            ],
            forward,
            inverse: [
                m11 / determinant,
                -m10 / determinant,
                -m01 / determinant,
                m00 / determinant,
            ],
        })
    }

    /// The canvas pixels the quad can touch: `(x0, y0, x1, y1)`, half open.
    fn bounds(&self, width: usize, height: usize) -> Option<(usize, usize, usize, usize)> {
        let [m00, m10, m01, m11, tx, ty] = self.forward;
        let corners = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
            .map(|[u, v]: [f32; 2]| [m00 * u + m01 * v + tx, m10 * u + m11 * v + ty]);
        let min_x = corners.iter().map(|c| c[0]).fold(f32::INFINITY, f32::min);
        let max_x = corners
            .iter()
            .map(|c| c[0])
            .fold(f32::NEG_INFINITY, f32::max);
        let min_y = corners.iter().map(|c| c[1]).fold(f32::INFINITY, f32::min);
        let max_y = corners
            .iter()
            .map(|c| c[1])
            .fold(f32::NEG_INFINITY, f32::max);
        let x0 = min_x.floor().max(0.0) as usize;
        let y0 = min_y.floor().max(0.0) as usize;
        let x1 = (max_x.ceil().max(0.0) as usize).min(width);
        let y1 = (max_y.ceil().max(0.0) as usize).min(height);
        (x0 < x1 && y0 < y1).then_some((x0, y0, x1, y1))
    }

    /// Straight RGBA (0..255) at a canvas point, or `None` outside the quad.
    fn sample(&self, x: f32, y: f32) -> Option<[f32; 4]> {
        let [_, _, _, _, tx, ty] = self.forward;
        let [i00, i10, i01, i11] = self.inverse;
        let (dx, dy) = (x - tx, y - ty);
        let u = i00 * dx + i01 * dy;
        let v = i10 * dx + i11 * dy;
        if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
            return None;
        }
        let source_x = self.cell[0] + u * self.cell[2] - 0.5;
        let source_y = self.cell[1] + v * self.cell[3] - 0.5;
        let left = source_x.floor();
        let top = source_y.floor();
        let fx = source_x - left;
        let fy = source_y - top;
        let [min_x, min_y, max_x, max_y] = self.clamp;
        let column = |offset: i64| (left as i64 + offset).clamp(min_x, max_x) as usize;
        let row = |offset: i64| (top as i64 + offset).clamp(min_y, max_y) as usize;
        let texel = |column: usize, row: usize| -> [f32; 4] {
            let index = (row * self.atlas_width + column) * 4;
            let pixel = &self.bgra[index..index + 4];
            [
                f32::from(pixel[2]),
                f32::from(pixel[1]),
                f32::from(pixel[0]),
                f32::from(pixel[3]),
            ]
        };
        let (c0, c1, r0, r1) = (column(0), column(1), row(0), row(1));
        let (t00, t10, t01, t11) = (texel(c0, r0), texel(c1, r0), texel(c0, r1), texel(c1, r1));
        Some(std::array::from_fn(|channel| {
            let top_value = t00[channel] + (t10[channel] - t00[channel]) * fx;
            let bottom_value = t01[channel] + (t11[channel] - t01[channel]) * fx;
            top_value + (bottom_value - top_value) * fy
        }))
    }
}

/// CPU path (S-B3): source-over the sprite into a BT.709 video-range YUV420p
/// frame. Over the transformed quad's bounding box, each pixel centre maps
/// back into the cell (inverse affine), samples it bilinearly (the gutters
/// and alpha bleed make the edge right) and blends with straight alpha;
/// chroma averages the 2x2 block's four blends, as the Metal path's
/// RGB-to-YUV conversion does. Rows run in parallel.
pub(crate) fn blit_sprite_affine_to_yuv420p(
    dest: &mut [u8],
    canvas_width: u32,
    canvas_height: u32,
    atlas: &GolemSpriteAtlas,
    draw: &GolemSpriteDraw,
) {
    let width = canvas_width.max(1) as usize;
    let height = canvas_height.max(1) as usize;
    let luma_len = width * height;
    let chroma_width = width.div_ceil(2);
    let chroma_len = chroma_width * height.div_ceil(2);
    if dest.len() < luma_len + 2 * chroma_len {
        return;
    }
    let Some(sampler) = SpriteSampler::new(atlas, draw) else {
        return;
    };
    let Some((x0, y0, x1, y1)) = sampler.bounds(width, height) else {
        return;
    };
    let opacity = draw.opacity.clamp(0.0, 1.0);
    let (luma, chroma) = dest.split_at_mut(luma_len);
    let (u_plane, v_plane) = chroma.split_at_mut(chroma_len);
    let v_plane = &mut v_plane[..chroma_len];
    let block_top = y0 / 2;
    let block_bottom = y1.div_ceil(2);
    luma.par_chunks_mut(width * 2)
        .zip(u_plane.par_chunks_mut(chroma_width))
        .zip(v_plane.par_chunks_mut(chroma_width))
        .enumerate()
        .skip(block_top)
        .take(block_bottom - block_top)
        .for_each(|(block_y, ((luma_rows, u_row), v_row))| {
            for block_x in x0 / 2..x1.div_ceil(2) {
                let mut alpha_sum = 0.0_f32;
                let mut u_sum = 0.0_f32;
                let mut v_sum = 0.0_f32;
                for dy in 0..2 {
                    let y = block_y * 2 + dy;
                    if y < y0 || y >= y1 || (dy + 1) * width > luma_rows.len() {
                        continue;
                    }
                    for dx in 0..2 {
                        let x = block_x * 2 + dx;
                        if x < x0 || x >= x1 {
                            continue;
                        }
                        let Some([r, g, b, a]) = sampler.sample(x as f32 + 0.5, y as f32 + 0.5)
                        else {
                            continue;
                        };
                        let alpha = a / 255.0 * opacity;
                        if alpha <= 0.0 {
                            continue;
                        }
                        let (y_value, u_value, v_value) =
                            crate::color::rgb_to_yuv_video_range_bt709(
                                r.round().clamp(0.0, 255.0) as u8,
                                g.round().clamp(0.0, 255.0) as u8,
                                b.round().clamp(0.0, 255.0) as u8,
                            );
                        let index = dy * width + x;
                        let current = f32::from(luma_rows[index]);
                        luma_rows[index] = (current + (f32::from(y_value) - current) * alpha)
                            .round()
                            .clamp(0.0, 255.0) as u8;
                        alpha_sum += alpha;
                        u_sum += alpha * f32::from(u_value);
                        v_sum += alpha * f32::from(v_value);
                    }
                }
                if alpha_sum > 0.0 && block_x < u_row.len() {
                    let blend = |current: u8, sum: f32| {
                        let current = f32::from(current);
                        (current + (sum - alpha_sum * current) / 4.0)
                            .round()
                            .clamp(0.0, 255.0) as u8
                    };
                    u_row[block_x] = blend(u_row[block_x], u_sum);
                    v_row[block_x] = blend(v_row[block_x], v_sum);
                }
            }
        });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::overlay_layout::{OverlayItem, OverlaySnap, overlay_snap_rect};

    fn golem_layout() -> OverlayItemLayout {
        crate::overlay_layout::OverlayLayout::default().golem
    }

    fn meta(cells: usize, cell_px: u32) -> Arc<GolemSpritePackMeta> {
        Arc::new(GolemSpritePackMeta {
            pack_id: "fixture".to_string(),
            neutral: "cell-0".to_string(),
            pivot: GOLEM_SPRITE_DEFAULT_PIVOT,
            head_top: 0.25,
            talk: Vec::new(),
            source_cell_px: cell_px,
            unique_cells: cells,
        })
    }

    /// The S-B5 fixture atlas: 3 x 2 cells of flat, distinct colours, each
    /// with a 1 px outer ring at half alpha (the alpha ramp edge).
    pub(crate) fn parity_atlas(cell_px: u32) -> GolemSpriteAtlas {
        const COLOURS: [[u8; 3]; 6] = [
            [230, 40, 40],
            [40, 200, 60],
            [50, 70, 230],
            [240, 200, 40],
            [200, 60, 220],
            [40, 210, 210],
        ];
        let cells = COLOURS
            .iter()
            .map(|[r, g, b]| {
                image::RgbaImage::from_fn(cell_px, cell_px, |x, y| {
                    let edge = x == 0 || y == 0 || x == cell_px - 1 || y == cell_px - 1;
                    image::Rgba([*r, *g, *b, if edge { 128 } else { 255 }])
                })
            })
            .collect::<Vec<_>>();
        let frames = (0..cells.len())
            .map(|index| {
                (
                    format!("cell-{index}"),
                    if index == 0 {
                        PetFrameKind::Gaze
                    } else {
                        PetFrameKind::Reaction
                    },
                    (index == 0).then_some([0.0, 0.0]),
                    index,
                )
            })
            .collect();
        GolemSpriteAtlas::from_cells(&cells, cell_px, frames, meta(6, cell_px))
    }

    fn atlas_pixel(atlas: &GolemSpriteAtlas, x: u32, y: u32) -> [u8; 4] {
        let index = (y * atlas.width + x) as usize * 4;
        let bgra = &atlas.bgra[index..index + 4];
        [bgra[2], bgra[1], bgra[0], bgra[3]]
    }

    #[test]
    fn cell_size_is_the_rect_width_on_the_canvas_and_the_box_sits_on_the_rect() {
        let rect = overlay_snap_rect(
            OverlayItem::Golem,
            OverlayOrientation::Horizontal,
            OverlaySnap::BottomRight,
        );
        // 0.18 x 1920 = 345.6.
        assert_eq!(golem_cell_px(rect, 1920), 346);
        let [x, y, w, h] = golem_box(rect, 1920, 1080);
        assert_eq!((w, h), (346.0, 346.0));
        // Centred on the rect, resting on its bottom edge.
        let (left, _, right, bottom) = rect.pixels(1920, 1080);
        assert!(((x + w / 2.0) - (left + right) as f32 / 2.0).abs() <= 1.0);
        assert_eq!(y + h, bottom as f32);
        // A top rect hangs from its top edge; a huge rect stays on the canvas.
        let top = overlay_snap_rect(
            OverlayItem::Golem,
            OverlayOrientation::Horizontal,
            OverlaySnap::TopLeft,
        );
        assert_eq!(
            golem_box(top, 1920, 1080)[1],
            (top.y * 1080.0).round() as f32
        );
        let [x, y, w, h] = golem_box(OverlayRect::new(0.5, 0.2, 0.5, 0.8), 1280, 720);
        assert!(x >= 0.0 && y >= 0.0 && x + w <= 1280.0 && y + h <= 720.0);
        assert_eq!(w, 640.0);
    }

    #[test]
    fn the_bubble_anchors_above_the_head_and_stays_on_the_canvas() {
        let anchor = golem_bubble_anchor([1500.0, 700.0, 340.0, 340.0], 0.25);
        assert_eq!(
            anchor,
            GolemBubbleAnchor {
                x: 1670.0,
                y: 785.0
            }
        );
        // A 300 x 120 bubble: bottom-centre on the anchor.
        assert_eq!(
            golem_bubble_blit_layout(300, 120, 1920, 1080, anchor),
            (0, 1520, 665, 300)
        );
        // Near the right and top edges it is pushed back inside.
        let corner = GolemBubbleAnchor { x: 1910.0, y: 40.0 };
        assert_eq!(
            golem_bubble_blit_layout(300, 120, 1920, 1080, corner),
            (0, 1620, 0, 300)
        );
        // Wider than the canvas: centre-cropped.
        assert_eq!(
            golem_bubble_blit_layout(400, 50, 320, 240, corner),
            (40, 0, 0, 320)
        );
    }

    #[test]
    fn the_draw_maps_the_cell_like_css_matrix_about_the_pivot() {
        let close =
            |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3;
        let mut draw =
            GolemSpriteDraw::at_rest([0, 0, 100, 100], [100.0, 200.0, 100.0, 100.0], [0.5, 0.9]);
        // At rest the corners are the box.
        for (corner, expected) in draw.corners().into_iter().zip([
            [100.0, 200.0],
            [200.0, 200.0],
            [100.0, 300.0],
            [200.0, 300.0],
        ]) {
            assert!(close(corner, expected), "{corner:?} vs {expected:?}");
        }
        // A 90 degree turn (CSS matrix(0, 1, -1, 0, 3, -4)) about the feet.
        draw.affine = [0.0, 1.0, -1.0, 0.0];
        draw.translate = [3.0, -4.0];
        assert!(close(draw.pivot_point(), [150.0, 290.0]));
        let [top_left, ..] = draw.corners();
        // (u, v) = (0, 0) is (-50, -90) from the pivot; turned: (90, -50).
        assert!((top_left[0] - (150.0 + 90.0 + 3.0)).abs() < 1e-4);
        assert!((top_left[1] - (290.0 - 50.0 - 4.0)).abs() < 1e-4);
        draw.affine = [1.0, 0.0, 0.0, 0.0];
        assert!(!draw.is_drawable(), "a flat quad draws nothing");
    }

    #[test]
    fn pre_scale_never_upscales_and_keeps_edges_free_of_dark_fringes() {
        // A 64 px cell: an opaque orange disc on transparent black.
        let source = image::RgbaImage::from_fn(64, 64, |x, y| {
            let (dx, dy) = (x as f32 - 31.5, y as f32 - 31.5);
            if dx * dx + dy * dy < 20.0 * 20.0 {
                image::Rgba([240, 140, 20, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        });
        assert_eq!(scale_cell(&source, 128).dimensions(), (64, 64));
        let scaled = scale_cell(&source, 24);
        assert_eq!(scaled.dimensions(), (24, 24));
        // Premultiplied resampling: a partly transparent edge texel keeps the
        // disc's colour, never a blend toward black.
        let mut edges = 0;
        for pixel in scaled.pixels() {
            if pixel[3] > 0 && pixel[3] < 255 {
                edges += 1;
                assert!(pixel[0] > 200 && pixel[1] > 100, "dark fringe {pixel:?}");
            }
        }
        assert!(edges > 0, "the disc has an anti-aliased edge");
    }

    #[test]
    fn atlas_cells_sit_in_transparent_gutters_and_transparent_texels_are_bled() {
        let atlas = parity_atlas(20);
        // 3 x 2 grid of 24 px slots.
        assert_eq!((atlas.width, atlas.height), (72, 48));
        assert_eq!(atlas.cell_px, 20);
        let cell = atlas.cell("cell-4").unwrap();
        assert_eq!(cell.rect, [26, 26, 20, 20]);
        // Inside: the flat colour; the outer ring at half alpha.
        assert_eq!(atlas_pixel(&atlas, 36, 36), [200, 60, 220, 255]);
        assert_eq!(atlas_pixel(&atlas, 26, 36), [200, 60, 220, 128]);
        // The 2 px gutter is transparent and carries the edge colour (no
        // texel with alpha 0 next to an opaque edge keeps black RGB).
        for (x, y) in [(25, 36), (24, 36), (36, 24), (47, 47)] {
            assert_eq!(
                atlas_pixel(&atlas, x, y),
                [200, 60, 220, 0],
                "gutter at {x},{y}"
            );
        }
        // Each slot bleeds only its own cell: the gutter left of cell 4 is
        // cell 4's colour, the gutter right of cell 3 (x 21..23) is cell 3's.
        assert_eq!(atlas_pixel(&atlas, 23, 30), [240, 200, 40, 0]);
        for y in 0..atlas.height {
            for x in 0..atlas.width {
                let pixel = atlas_pixel(&atlas, x, y);
                assert!(
                    pixel[3] != 0 || pixel[..3] != [0, 0, 0],
                    "black transparent texel at {x},{y}"
                );
            }
        }
    }

    #[test]
    fn alpha_bleed_reaches_two_texels_and_no_further() {
        let mut image = image::RgbaImage::new(8, 1);
        image.put_pixel(0, 0, image::Rgba([10, 20, 30, 255]));
        alpha_bleed(&mut image, 2);
        assert_eq!(image.get_pixel(1, 0).0, [10, 20, 30, 0]);
        assert_eq!(image.get_pixel(2, 0).0, [10, 20, 30, 0]);
        assert_eq!(image.get_pixel(3, 0).0, [0, 0, 0, 0]);
    }

    #[test]
    fn budget_steps_every_leg_down_until_the_atlases_fit() {
        // 40 cells (page-pet's 37 plus extras) at 4K: 691 px cells.
        let one = golem_atlas_bytes(691, 40);
        assert!(one > GOLEM_SPRITE_BUDGET_BYTES, "a 4K leg alone is over");
        let sizes = plan_cell_sizes(&[691, 346], 40, 0, GOLEM_SPRITE_BUDGET_BYTES);
        assert!(sizes[0] < 691 && sizes[1] < 346);
        let total: u64 = sizes.iter().map(|size| golem_atlas_bytes(*size, 40)).sum();
        assert!(total <= GOLEM_SPRITE_BUDGET_BYTES);
        // Within budget nothing changes; the other leg's resident atlas counts.
        assert_eq!(
            plan_cell_sizes(&[346], 40, 0, GOLEM_SPRITE_BUDGET_BYTES),
            vec![346]
        );
        let resident = GOLEM_SPRITE_BUDGET_BYTES - golem_atlas_bytes(200, 40);
        let squeezed = plan_cell_sizes(&[346], 40, resident, GOLEM_SPRITE_BUDGET_BYTES);
        assert!(squeezed[0] <= 200);
        // Nothing fits: the floor, never zero.
        assert_eq!(
            plan_cell_sizes(
                &[346],
                40,
                GOLEM_SPRITE_BUDGET_BYTES,
                GOLEM_SPRITE_BUDGET_BYTES
            ),
            vec![GOLEM_SPRITE_MIN_CELL_PX]
        );
    }

    #[test]
    fn a_size_change_is_debounced_but_a_new_canvas_or_pack_builds_at_once() {
        let now = Instant::now();
        let built = LegKey {
            canvas: (1920, 1080),
            rect_px: 346,
        };
        let mut atlas = parity_atlas(8);
        atlas.built_for = Some((built, 3));
        let resized = LegWant {
            key: LegKey {
                rect_px: 400,
                ..built
            },
            since: now,
        };
        assert!(!want_is_due(Some(&atlas), resized, 3, now));
        assert!(!want_is_due(
            Some(&atlas),
            resized,
            3,
            now + Duration::from_millis(249)
        ));
        assert!(want_is_due(
            Some(&atlas),
            resized,
            3,
            now + GOLEM_SPRITE_RESCALE_DEBOUNCE
        ));
        // No atlas, a new pack generation or a new canvas: at once.
        assert!(want_is_due(None, resized, 3, now));
        assert!(want_is_due(Some(&atlas), resized, 4, now));
        let new_canvas = LegWant {
            key: LegKey {
                canvas: (1280, 720),
                rect_px: 230,
            },
            since: now,
        };
        assert!(want_is_due(Some(&atlas), new_canvas, 3, now));
    }

    #[test]
    fn the_still_pack_of_the_default_persona_builds_its_four_cells_at_the_rect_size() {
        let pack = crate::golem_pet::still_pack(&CohostPersona::default(), &[]).unwrap();
        let meta = Arc::new(pack_meta(&pack).unwrap());
        // idle, talk, laugh and think: the default Golem's four drawings.
        assert_eq!(meta.unique_cells, 4);
        assert_eq!(meta.neutral, "idle");
        let atlas = build_atlas(&pack, &meta, 346.min(meta.source_cell_px)).unwrap();
        assert_eq!(atlas.cell_px, 346.min(meta.source_cell_px));
        let neutral = atlas.neutral().unwrap();
        // Idle maps to the neutral cell; each other state to its own cell.
        assert_eq!(
            atlas.cell_for_state(CohostAvatarState::Idle).unwrap().rect,
            neutral.rect
        );
        let mut rects = vec![neutral.rect];
        for state in [
            CohostAvatarState::Talk,
            CohostAvatarState::Laugh,
            CohostAvatarState::Think,
        ] {
            let rect = atlas.cell_for_state(state).unwrap().rect;
            assert!(!rects.contains(&rect), "{state:?} has its own cell");
            rects.push(rect);
        }
        // The idle image has a silhouette: some texel is opaque.
        let [x, y, w, h] = neutral.rect;
        let opaque = (y..y + h)
            .flat_map(|row| (x..x + w).map(move |column| (column, row)))
            .any(|(column, row)| atlas_pixel(&atlas, column, row)[3] == 255);
        assert!(opaque);
    }

    #[test]
    fn the_static_source_draws_the_state_cell_at_rest_in_the_box() {
        let atlas = parity_atlas(16);
        let rect = golem_layout().horizontal;
        let golem_box = golem_box(rect, 1920, 1080);
        let mut source = StaticGolemSpriteSource;
        let context = |state| GolemSpriteLegContext {
            leg: GolemSpriteLeg::Primary,
            now_seconds: 1.0,
            canvas: (1920, 1080),
            golem_rect: rect,
            golem_box,
            highlight_rect: None,
            caption_rect: None,
            avatar_state: state,
            atlas: &atlas,
        };
        let idle = source.draw(&context(CohostAvatarState::Idle)).unwrap();
        assert_eq!(idle.cell, atlas.neutral().unwrap().rect);
        assert_eq!(idle.affine, GolemSpriteDraw::IDENTITY_AFFINE);
        assert_eq!(idle.opacity, 1.0);
        let corners = idle.corners();
        let close =
            |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3;
        assert!(close(corners[0], [golem_box[0], golem_box[1]]));
        assert!(close(
            corners[3],
            [golem_box[0] + golem_box[2], golem_box[1] + golem_box[3]]
        ));
        // The parity atlas has no `talk` reaction: neutral again.
        assert_eq!(
            source.draw(&context(CohostAvatarState::Talk)).unwrap().cell,
            idle.cell
        );
    }

    #[test]
    fn an_identity_draw_blits_the_cell_pixel_for_pixel() {
        let atlas = parity_atlas(16);
        let draw = GolemSpriteDraw::at_rest(
            atlas.cell("cell-2").unwrap().rect,
            [10.0, 6.0, 16.0, 16.0],
            GOLEM_SPRITE_DEFAULT_PIVOT,
        );
        let (width, height) = (40_u32, 30_u32);
        let mut frame = vec![0_u8; (width * height + 2 * (width / 2) * (height / 2)) as usize];
        frame[..(width * height) as usize].fill(16);
        frame[(width * height) as usize..].fill(128);
        blit_sprite_affine_to_yuv420p(&mut frame, width, height, &atlas, &draw);
        let (blue_y, blue_u, blue_v) = crate::color::rgb_to_yuv_video_range_bt709(50, 70, 230);
        // An inner pixel is the cell colour exactly; outside is untouched.
        assert_eq!(frame[(14 * width + 18) as usize], blue_y);
        assert_eq!(frame[(3 * width + 3) as usize], 16);
        assert_eq!(frame[(14 * width + 30) as usize], 16);
        let chroma = (width * height) as usize;
        let block = (7 * (width / 2) + 9) as usize;
        assert_eq!(frame[chroma + block], blue_u);
        assert_eq!(
            frame[chroma + ((width / 2) * (height / 2)) as usize + block],
            blue_v
        );
        // The 1 px ring is half alpha: its luma lies between black and blue.
        let ring = frame[(6 * width + 18) as usize];
        assert!(ring > 16 && ring < blue_y, "ring luma {ring}");
    }

    #[test]
    fn the_slot_builds_the_still_pet_for_a_leg_and_rebuilds_on_resize() {
        let slot = GolemSpriteSlot::new(&CohostPersona::default(), golem_layout(), None)
            .with_roots(Vec::new());
        let request = GolemLegRequest {
            leg: GolemSpriteLeg::Primary,
            canvas: (1280, 720),
            now_seconds: 0.0,
            highlight_rect: None,
            caption_rect: None,
        };
        // No atlas yet: no pet, but the bubble already has its anchor.
        let first = slot.leg_frame(request);
        assert!(first.sprite.is_none());
        let rect = golem_layout().horizontal;
        assert_eq!(first.golem_box, golem_box(rect, 1280, 720));
        let atlas = slot
            .wait_for_atlas(GolemSpriteLeg::Primary, |_| true, Duration::from_secs(20))
            .expect("the worker builds the primary atlas");
        assert_eq!(
            atlas.cell_px,
            golem_cell_px(rect, 1280).min(atlas.meta.source_cell_px)
        );
        let frame = slot.leg_frame(request);
        let sprite = frame.sprite.expect("the pet draws once its atlas exists");
        assert_eq!(sprite.atlas.revision, atlas.revision);
        assert_eq!(sprite.draw.size, frame.golem_box[2]);
        // A smaller rect: the old atlas keeps drawing at the new size until
        // the debounced rebuild lands.
        let mut layout = golem_layout();
        layout.horizontal.w = 0.1;
        slot.set_layout(layout);
        let resized = slot.leg_frame(request);
        let drawn = resized.sprite.expect("the old atlas keeps drawing");
        assert_eq!(
            drawn.draw.size,
            golem_cell_px(layout.horizontal, 1280) as f32
        );
        let rebuilt = slot
            .wait_for_atlas(
                GolemSpriteLeg::Primary,
                |next| next.revision != atlas.revision,
                Duration::from_secs(20),
            )
            .expect("the resize rebuilds the atlas");
        assert_eq!(rebuilt.cell_px, golem_cell_px(layout.horizontal, 1280));
        // A talk state picks the still pack's talk cell (here: the idle image).
        slot.set_avatar_state_and_notify(CohostAvatarState::Talk, None);
        assert!(slot.leg_frame(request).sprite.is_some());
    }
}
