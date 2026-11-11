use crate::protocol::{
    ArrangementMode, CameraAspect, CameraCorner, CameraFit, CameraShape, CameraSize,
    CameraTransform, CameraTransformMode, EffectiveSceneBackground, LayoutPreset, LayoutSettings,
    SceneSourceKind, SceneTransform, SideBySideSplit,
};

const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;

/// The protocol's bounds for a scene source's box, as canvas fractions (plan
/// 215 E3, owner decision D2): a source may be up to 400% of the canvas and
/// sit anywhere from three canvases left or above the canvas to four right
/// or below it. These are the coarse limits every render path tolerates
/// (`scene::sanitize_transform_unsnapped` clamps to them); the editor keeps
/// at least 5% of the canvas covered on each axis (the stage's
/// `MIN_SOURCE_FRACTION`). Mirrored by `transform-fields-math.ts`,
/// `stage-transform.ts` and the Windows D3D11 planner.
pub const MAX_SOURCE_SIZE_FRACTION: f64 = 4.0;
pub const MIN_SOURCE_POSITION_FRACTION: f64 = -3.0;
pub const MAX_SOURCE_POSITION_FRACTION: f64 = 4.0;

/// Backend-independent destination rectangle used by the FFmpeg recording and
/// CPU/Metal compositor paths. Renderer-specific syntax and buffer handling
/// deliberately stay in those consumers. Always on the canvas: a source's
/// box before the canvas edge cuts it is a [`SignedPixelRect`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A source's box in canvas pixels before the canvas edge cuts it (plan 215
/// E1): signed, so a box that starts left of or above the canvas keeps its
/// true origin, and as big as its transform says, so one that runs past the
/// right or bottom edge keeps its true size. Every render path fits the
/// source into THIS box and lets the canvas edge cut what hangs off (the GPU
/// paths clip the quad; the CPU path draws `intersect_canvas`); nothing
/// squashes the box onto the canvas any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedPixelRect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// What the canvas edge leaves of a [`SignedPixelRect`]: the part on the
/// canvas, and how many pixels of the box's left and top the edge cut off
/// (the right and bottom cuts follow from the sizes). A consumer that draws
/// `visible` from a source window fitted to the whole box starts the window
/// `cut_left` and `cut_top` box pixels in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasCut {
    pub visible: PixelRect,
    pub cut_left: u32,
    pub cut_top: u32,
}

impl SignedPixelRect {
    pub fn right(self) -> i64 {
        self.x.saturating_add(i64::from(self.width))
    }

    pub fn bottom(self) -> i64 {
        self.y.saturating_add(i64::from(self.height))
    }

    /// The box intersected with a `canvas_width`×`canvas_height` canvas, with
    /// the amount cut off its left and top; `None` when nothing of it is on
    /// the canvas (or the box is empty).
    pub fn intersect_canvas(self, canvas_width: u32, canvas_height: u32) -> Option<CanvasCut> {
        let left = self.x.max(0);
        let top = self.y.max(0);
        let right = self.right().min(i64::from(canvas_width));
        let bottom = self.bottom().min(i64::from(canvas_height));
        if right <= left || bottom <= top {
            return None;
        }
        Some(CanvasCut {
            visible: PixelRect {
                x: left as u32,
                y: top as u32,
                width: (right - left) as u32,
                height: (bottom - top) as u32,
            },
            cut_left: (left - self.x) as u32,
            cut_top: (top - self.y) as u32,
        })
    }

    /// The whole box as an on-canvas rect, only when the canvas edge cuts
    /// nothing off it. Only the Windows recording path asks; elsewhere the
    /// tests still read it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn whole_on_canvas(self, canvas_width: u32, canvas_height: u32) -> Option<PixelRect> {
        let cut = self.intersect_canvas(canvas_width, canvas_height)?;
        (cut.cut_left == 0
            && cut.cut_top == 0
            && cut.visible.width == self.width
            && cut.visible.height == self.height)
            .then_some(cut.visible)
    }
}

impl From<PixelRect> for SignedPixelRect {
    fn from(rect: PixelRect) -> Self {
        Self {
            x: i64::from(rect.x),
            y: i64::from(rect.y),
            width: rect.width,
            height: rect.height,
        }
    }
}

/// A normalized crop in source coordinates. Values are clamped independently
/// to the wire contract's 95% ceiling; `kept_*` keeps malformed legacy pairs
/// renderable instead of producing a zero-sized source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneCrop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl SceneCrop {
    pub const fn none() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        }
    }

    pub fn kept_width(self) -> f64 {
        (1.0 - self.left - self.right).max(0.001)
    }

    pub fn kept_height(self) -> f64 {
        (1.0 - self.top - self.bottom).max(0.001)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneMask {
    None,
    Circle,
    Rounded { radius_pct: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneFit {
    Contain,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CircleGeometry {
    pub center_x: f64,
    pub center_y: f64,
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedRectGeometry {
    pub center_x: f64,
    pub center_y: f64,
    pub radius: f64,
    pub inner_half_width: f64,
    pub inner_half_height: f64,
}

/// Stage margin per side for a scene background. The default visibility of 20
/// yields a 0.10 margin (an 80% content stage); zero stays full-canvas.
pub fn background_stage_margin(background: Option<&EffectiveSceneBackground>) -> f64 {
    background
        .map(|background| (background.visibility_percent / 200.0).clamp(0.0, 0.20))
        .unwrap_or(0.0)
}

pub fn background_zoom_crop(background: Option<&EffectiveSceneBackground>) -> SceneCrop {
    let Some(background) = background else {
        return SceneCrop::none();
    };
    let scale = background.scale.clamp(100.0, 200.0);
    if scale <= 100.0 {
        return SceneCrop::none();
    }
    let total_crop = 1.0 - (100.0 / scale);
    let crop_x = (background.offset_x.clamp(-100.0, 100.0) / 200.0) * total_crop;
    let crop_y = (background.offset_y.clamp(-100.0, 100.0) / 200.0) * total_crop;
    SceneCrop {
        left: ((total_crop / 2.0) + crop_x).clamp(0.0, 0.95),
        right: ((total_crop / 2.0) - crop_x).clamp(0.0, 0.95),
        top: ((total_crop / 2.0) + crop_y).clamp(0.0, 0.95),
        bottom: ((total_crop / 2.0) - crop_y).clamp(0.0, 0.95),
    }
}

pub fn scene_source_render_transform(
    transform: &SceneTransform,
    source_kind: &SceneSourceKind,
    stage_margin: f64,
) -> SceneTransform {
    if stage_margin <= 0.0 || !scene_source_uses_background_stage(source_kind) {
        return transform.clone();
    }
    let stage_scale = 1.0 - (stage_margin * 2.0);
    SceneTransform {
        x: stage_margin + (transform.x * stage_scale),
        y: stage_margin + (transform.y * stage_scale),
        width: transform.width * stage_scale,
        height: transform.height * stage_scale,
        crop_left: transform.crop_left,
        crop_top: transform.crop_top,
        crop_right: transform.crop_right,
        crop_bottom: transform.crop_bottom,
    }
}

pub fn scene_source_uses_background_stage(source_kind: &SceneSourceKind) -> bool {
    matches!(
        source_kind,
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern
    )
}

/// A scene source's box in canvas pixels, uncut (plan 215 E1, D2): its true
/// origin (signed, so a box that starts left of or above the canvas keeps
/// it) and its true size (so a box past the right or bottom edge keeps it).
/// What hangs off the canvas is the render path's to cut, never to squash:
/// before this, the origin was clamped onto the canvas and the size shrunk
/// to what was left, which squeezed the whole picture into the visible part.
/// A box wholly on the canvas comes out exactly as it always did.
pub fn scene_source_rect_pixels(
    transform: &SceneTransform,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<SignedPixelRect> {
    if transform.width <= 0.0 || transform.height <= 0.0 {
        return None;
    }
    Some(SignedPixelRect {
        x: normalized_to_signed_pixel(transform.x, canvas_width),
        y: normalized_to_signed_pixel(transform.y, canvas_height),
        width: normalized_to_span(transform.width, canvas_width),
        height: normalized_to_span(transform.height, canvas_height),
    })
}

pub fn scene_crop_from_transform(transform: &SceneTransform) -> SceneCrop {
    SceneCrop {
        left: transform.crop_left.clamp(0.0, 0.95),
        top: transform.crop_top.clamp(0.0, 0.95),
        right: transform.crop_right.clamp(0.0, 0.95),
        bottom: transform.crop_bottom.clamp(0.0, 0.95),
    }
}

/// The largest box of a picture's aspect inside `rect`, centred: the
/// compositor's Fit (plan 216 B1). `source_width` and `source_height` are
/// the picture after its crop, in source pixels. This is the one contain
/// arithmetic: `compositor::source_fit` draws with it, and
/// [`scene_picture_rect_pixels`] tells the renderer where the picture is,
/// so the Scene stage's box, handles and hit target land on the picture the
/// compositor really draws (`apps/desktop/src/shared/scene-picture-geometry.ts`
/// is its TypeScript twin; `protocol-fixtures/scene-picture-geometry.json`
/// keeps them equal). A degenerate box or picture comes back as the box.
pub fn contain_rect_pixels(
    source_width: f64,
    source_height: f64,
    rect: SignedPixelRect,
) -> SignedPixelRect {
    // A NaN size is not a size either: `NaN > 0.0` is false.
    let fits = source_width > 0.0 && source_height > 0.0 && rect.width > 0 && rect.height > 0;
    if !fits {
        return rect;
    }
    let source_aspect = source_width / source_height;
    let rect_aspect = f64::from(rect.width) / f64::from(rect.height);
    let (width, height) = if source_aspect > rect_aspect {
        let width = rect.width;
        let height = (f64::from(width) / source_aspect).round().max(1.0) as u32;
        (width, height.min(rect.height))
    } else {
        let height = rect.height;
        let width = (f64::from(height) * source_aspect).round().max(1.0) as u32;
        (width.min(rect.width), height)
    };
    SignedPixelRect {
        x: rect.x + i64::from((rect.width - width) / 2),
        y: rect.y + i64::from((rect.height - height) / 2),
        width,
        height,
    }
}

/// Where a scene source's PICTURE lands, in canvas pixels (plan 216 B1,
/// owner decision D2): the source's frame mapped onto the scene background's
/// stage margin ([`scene_source_render_transform`]) and rounded to pixels
/// ([`scene_source_rect_pixels`]), then, on Fit with a known source size,
/// the cropped picture's largest box inside it ([`contain_rect_pixels`]).
/// Fill, the test pattern (drawn at the canvas size) and an unknown size
/// give the frame itself. `None` only for an empty frame.
///
/// The renderer's twin is the consumer today (the fixture keeps the two
/// equal); plan 215 F's rounded-screen mask is the first Rust caller.
#[cfg_attr(not(test), allow(dead_code))]
pub fn scene_picture_rect_pixels(
    transform: &SceneTransform,
    kind: &SceneSourceKind,
    fit: SceneFit,
    source_size: Option<(u32, u32)>,
    stage_margin: f64,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<SignedPixelRect> {
    let staged = scene_source_render_transform(transform, kind, stage_margin);
    let rect = scene_source_rect_pixels(&staged, canvas_width, canvas_height)?;
    let Some((source_width, source_height)) = source_size else {
        return Some(rect);
    };
    if matches!(fit, SceneFit::Cover)
        || matches!(kind, SceneSourceKind::TestPattern)
        || source_width == 0
        || source_height == 0
    {
        return Some(rect);
    }
    let crop = scene_crop_from_transform(&staged);
    Some(contain_rect_pixels(
        f64::from(source_width) * crop.kept_width(),
        f64::from(source_height) * crop.kept_height(),
        rect,
    ))
}

/// [`scene_picture_rect_pixels`] as canvas fractions: the box the Scene
/// stage draws and edits for the source.
#[cfg_attr(not(test), allow(dead_code))]
pub fn scene_picture_rect(
    transform: &SceneTransform,
    kind: &SceneSourceKind,
    fit: SceneFit,
    source_size: Option<(u32, u32)>,
    stage_margin: f64,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<CameraTransform> {
    let pixels = scene_picture_rect_pixels(
        transform,
        kind,
        fit,
        source_size,
        stage_margin,
        canvas_width,
        canvas_height,
    )?;
    let width = f64::from(canvas_width.max(1));
    let height = f64::from(canvas_height.max(1));
    Some(CameraTransform {
        x: pixels.x as f64 / width,
        y: pixels.y as f64 / height,
        width: f64::from(pixels.width) / width,
        height: f64::from(pixels.height) / height,
    })
}

/// True for every vertical-mode preset: their regions are short-form bands
/// that must be FILLED — internal letterboxing is the bug (owner report,
/// 2026-07-13 fill-crop plan), not a fidelity feature.
fn vertical_fill_preset(preset: &LayoutPreset) -> bool {
    matches!(
        preset,
        LayoutPreset::VerticalCameraTop
            | LayoutPreset::VerticalCameraBottom
            | LayoutPreset::VerticalSplit
            | LayoutPreset::VerticalScreenCamera
            | LayoutPreset::VerticalScreenOnly
            | LayoutPreset::VerticalCameraOnly
    )
}

/// True when a vertical-mode scene frames its screen with
/// `VerticalScreenFraming::Fit` (whole screen visible) instead of the
/// short-form fill law. Horizontal presets never consult the field.
pub fn vertical_screen_fits(layout: &LayoutSettings) -> bool {
    vertical_fill_preset(&layout.layout_preset)
        && matches!(
            layout.vertical_screen_framing,
            crate::protocol::VerticalScreenFraming::Fit
        )
}

/// True when a landscape scene fills its screen (plan 213 G3): the user's
/// `HorizontalScreenFraming::Fill`. Vertical presets never consult the field.
pub fn horizontal_screen_fills(layout: &LayoutSettings) -> bool {
    !layout.layout_preset.is_vertical()
        && matches!(
            layout.horizontal_screen_framing,
            crate::protocol::HorizontalScreenFraming::Fill
        )
}

/// The shared fit policy for source status, FFmpeg filters, CPU blits, and
/// Metal placement. Side-by-side and ALL vertical presets cover their regions
/// (short-form bands are filled, center-cropped — never letterboxed); the
/// horizontal full-frame screen/window presets contain so UI edges are never
/// cropped, unless the user chose Fill for them (plan 213 G3). Vertical BAND cameras cover unconditionally — a contain camera
/// band letterboxes exactly like the reported bug; zoom/pan still frame the
/// crop. The vertical screen+camera inset bubble keeps the user's Fit choice
/// like its horizontal twin.
pub fn scene_source_fit(kind: &SceneSourceKind, layout: &LayoutSettings) -> SceneFit {
    match kind {
        SceneSourceKind::Camera => {
            // Band cameras and the full-canvas vertical camera always cover:
            // a contained camera letterboxes its region, which is exactly the
            // vertical fill law's bug. Only the vertical screen+camera inset
            // bubble keeps the user's Fit choice (like its horizontal twin).
            let vertical_filled_camera = matches!(
                layout.layout_preset,
                LayoutPreset::VerticalCameraTop
                    | LayoutPreset::VerticalCameraBottom
                    | LayoutPreset::VerticalSplit
                    | LayoutPreset::VerticalCameraOnly
            );
            if vertical_filled_camera {
                return SceneFit::Cover;
            }
            if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom <= 100 {
                SceneFit::Contain
            } else {
                SceneFit::Cover
            }
        }
        SceneSourceKind::Screen | SceneSourceKind::Window => {
            if vertical_screen_fits(layout) {
                // Fit framing: the whole screen is the content (live screen
                // share). Stacked bands are sized to the screen, so contain
                // only ever shows background when the source is not 16:9.
                SceneFit::Contain
            } else if matches!(layout.layout_preset, LayoutPreset::SideBySide)
                || vertical_fill_preset(&layout.layout_preset)
                || horizontal_screen_fills(layout)
            {
                SceneFit::Cover
            } else {
                SceneFit::Contain
            }
        }
        // The test pattern is synthesised AT the canvas size, so it has no
        // aspect of its own to contain — it covers under every framing.
        SceneSourceKind::TestPattern => SceneFit::Cover,
    }
}

/// Camera masks are overlay policy, not renderer policy. The inset presets
/// (screen+camera) apply the selected bubble shape, and so does Freeform:
/// once the user drags the camera out of a preset it is their own bubble
/// everywhere, not just on the two inset presets it happened to start from.
/// Camera-only and side-by-side stay plain in Preset mode.
pub fn camera_mask(layout: &LayoutSettings) -> SceneMask {
    // Inset presets draw the camera as a shaped bubble regardless of
    // arrangement mode; every other preset keeps the camera rectangular
    // (maskless) in Preset mode, but in Freeform the camera is always the
    // user-owned bubble, so the shape still applies.
    let is_inset_preset = matches!(
        layout.layout_preset,
        LayoutPreset::ScreenCamera | LayoutPreset::VerticalScreenCamera
    );
    if !is_inset_preset && layout.arrangement_mode != ArrangementMode::Freeform {
        return SceneMask::None;
    }
    match layout.camera_shape {
        CameraShape::Rectangle => SceneMask::None,
        CameraShape::Circle => SceneMask::Circle,
        CameraShape::Rounded => SceneMask::Rounded {
            radius_pct: layout.camera_corner_radius_pct.min(50),
        },
    }
}

/// Chroma key spec for the camera layer — THE single source every render path
/// (CPU, Metal shader, FFmpeg filter) derives its keying from.
///
/// The keyer works on chroma DIRECTION, not absolute CbCr distance: a pixel
/// keys when the ANGLE between its CbCr vector and the key color's CbCr
/// direction is small, gated by a saturation floor so near-grey pixels never
/// key. The 0.9.39 absolute-distance model could not key real screens: pure
/// `#00FF00` sits at CbCr saturation ~136 while studio-lit screens sit at
/// 35–62, putting their DISTANCE at 75–101 units regardless of hue — above
/// any usable threshold (owner report + numeric repro, 2026-07-14). Angle is
/// lighting-invariant: bright and shadowed screen tones cluster within ~8° of
/// the key direction while subjects sit 90°+ away. The saturation floor
/// scales with luma for the same reason (plan 227, see
/// [`chroma_key_saturation_floor`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChromaKeySpec {
    pub key_rgb: [u8; 3],
    /// Angle (degrees) from the key's chroma direction at/below which a
    /// pixel is fully transparent.
    pub max_angle_deg: f64,
    /// Ramp band (degrees) beyond `max_angle_deg` over which alpha rises
    /// 0→255 (0 = hard cut).
    pub band_deg: f64,
    /// Spill suppression strength, 0..=1.
    pub spill: f64,
    /// Hide edges (plan 227 B): the part of the camera's SOURCE frame the
    /// key keeps. Everything outside is see-through, green or not, so a
    /// curtain or light stand at the frame's edge never shows.
    pub edges: ChromaKeyEdges,
}

/// The largest share of the camera frame Hide edges may take from one side
/// (percent). Mirrored by `CAMERA_KEY_EDGE_MAX_PCT` in the renderer and the
/// RPC contracts.
pub const CAMERA_KEY_EDGE_MAX_PCT: u32 = 25;

/// Hide edges as fractions of the camera's SOURCE frame (texture space,
/// before any mirror): `left`/`top`/`right`/`bottom` are how much of each
/// source side is see-through. The streamer sets them as seen (mirror
/// applied); [`camera_chroma_key`] resolves the mirror once, so every path
/// tests the texel it samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChromaKeyEdges {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl ChromaKeyEdges {
    pub const NONE: Self = Self {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };

    /// The streamer's percents, as seen (clamped to
    /// [`CAMERA_KEY_EDGE_MAX_PCT`] each). Not mirror-resolved.
    pub fn from_as_seen_pct(edges: &crate::protocol::CameraKeyEdges) -> Self {
        let fraction = |pct: u32| f64::from(pct.min(CAMERA_KEY_EDGE_MAX_PCT)) / 100.0;
        Self {
            left: fraction(edges.left_pct),
            top: fraction(edges.top_pct),
            right: fraction(edges.right_pct),
            bottom: fraction(edges.bottom_pct),
        }
    }

    /// The same edges seen through a horizontal mirror.
    pub fn mirrored(self) -> Self {
        Self {
            left: self.right,
            right: self.left,
            ..self
        }
    }

    pub fn is_none(&self) -> bool {
        *self == Self::NONE
    }

    /// The kept box in normalized source coordinates: `[u_min, v_min, u_max,
    /// v_max]` (the shaders' form).
    pub fn kept_uv(&self) -> [f64; 4] {
        [self.left, self.top, 1.0 - self.right, 1.0 - self.bottom]
    }

    /// Whether source texel (`x`, `y`) of a `width`×`height` frame survives;
    /// its centre is tested, like the shaders test the sample position.
    #[inline]
    pub fn keeps_texel(&self, x: u32, y: u32, width: u32, height: u32) -> bool {
        if self.is_none() {
            return true;
        }
        let u = (f64::from(x) + 0.5) / f64::from(width.max(1));
        let v = (f64::from(y) + 0.5) / f64::from(height.max(1));
        self.keeps_uv(u, v)
    }

    #[inline]
    pub fn keeps_uv(&self, u: f64, v: f64) -> bool {
        let [u_min, v_min, u_max, v_max] = self.kept_uv();
        u >= u_min && u <= u_max && v >= v_min && v <= v_max
    }
}

/// Similarity/smoothness percent → degrees. 100% maps to 60°; the default
/// similarity of 40% is a 24° cone — real screen tones cluster within ~8° of
/// the key direction, subjects sit 90°+ away, so defaults key with margin.
const CHROMA_KEY_PCT_TO_DEGREES: f64 = 0.6;

/// Chroma saturation (|CbCr vector|) floor: at or below it a pixel can never
/// key — greys, whites and blacks have no meaningful hue direction. Above it
/// the pixel ramps to fully keyable over `floor × RAMP_RATIO` units.
///
/// Plan 227 (owner recording, 2026-11-11): the floor used to be a fixed 14,
/// and chroma shrinks with brightness, so a green screen in shadow — the
/// right hue, `(1,23,6)` is 16° off the key — has chroma 9–12 and stayed on
/// the picture. The floor now scales with the pixel's luma, so it is
/// lighting-invariant like the angle: `clamp(PER_LUMA × Y, MIN, MAX)`.
/// Mid and bright pixels (Y ≥ ~93) keep the old 14 exactly; near-black
/// subject pixels (a black t-shirt, the mic arm: chroma under 2) stay below
/// `MIN`. The Metal shader and the D3D11 shader mirror all four constants.
pub const CHROMA_KEY_SATURATION_FLOOR_MIN: f64 = 5.0;
pub const CHROMA_KEY_SATURATION_FLOOR_PER_LUMA: f64 = 0.15;
pub const CHROMA_KEY_SATURATION_FLOOR_MAX: f64 = 14.0;
/// The ramp's width as a share of the floor (the old fixed 6 over 14).
pub const CHROMA_KEY_SATURATION_RAMP_RATIO: f64 = 6.0 / 14.0;

/// The four floor constants in shader order: `(min, per_luma, max,
/// ramp_ratio)`.
pub const CHROMA_KEY_SATURATION_FLOOR_PARAMS: [f64; 4] = [
    CHROMA_KEY_SATURATION_FLOOR_MIN,
    CHROMA_KEY_SATURATION_FLOOR_PER_LUMA,
    CHROMA_KEY_SATURATION_FLOOR_MAX,
    CHROMA_KEY_SATURATION_RAMP_RATIO,
];

/// `(floor, ramp)` for a pixel of full-range BT.601 luma `luma` (0..=255).
pub fn chroma_key_saturation_floor(luma: f64) -> (f64, f64) {
    let floor = (CHROMA_KEY_SATURATION_FLOOR_PER_LUMA * luma).clamp(
        CHROMA_KEY_SATURATION_FLOOR_MIN,
        CHROMA_KEY_SATURATION_FLOOR_MAX,
    );
    (floor, floor * CHROMA_KEY_SATURATION_RAMP_RATIO)
}

impl ChromaKeySpec {
    pub fn key_cb(&self) -> f64 {
        rgb_cb_f64(self.key_rgb)
    }

    pub fn key_cr(&self) -> f64 {
        rgb_cr_f64(self.key_rgb)
    }

    /// Unit vector of the key color's chroma direction. `None` when the key
    /// color is (near-)grey — no direction exists and nothing may key.
    pub fn key_direction(&self) -> Option<(f64, f64)> {
        let cb = self.key_cb() - 128.0;
        let cr = self.key_cr() - 128.0;
        let length = (cb * cb + cr * cr).sqrt();
        if length < 1.0 {
            return None;
        }
        Some((cb / length, cr / length))
    }

    /// Which channel spills: blue screens contaminate blue, everything else
    /// (green screens) contaminates green.
    pub fn spill_is_blue(&self) -> bool {
        self.key_rgb[2] > self.key_rgb[1]
    }
}

/// Full-range BT.601 Cb using the same integer coefficient family as
/// `color::rgb_to_yuv_full_range_bt601`, evaluated in f64 so the keyer's ramp
/// is smooth. The Metal shader mirrors these exact coefficients.
fn rgb_cb_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    128.0 + (-43.0 * r - 85.0 * g + 128.0 * b) / 256.0
}

fn rgb_cr_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    128.0 + (128.0 * r - 107.0 * g - 21.0 * b) / 256.0
}

/// Full-range BT.601 Y of the same family (`color.rs`'s 77/150/29), in f64:
/// what the saturation floor scales with. The shaders mirror it.
fn rgb_luma_f64(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(f64::from);
    (77.0 * r + 150.0 * g + 29.0 * b) / 256.0
}

/// Parse `#RRGGBB` (leading `#` optional, case-insensitive).
pub fn parse_hex_rgb(value: &str) -> Option<[u8; 3]> {
    let hex = value.trim().strip_prefix('#').unwrap_or(value.trim());
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some([channel(0..2)?, channel(2..4)?, channel(4..6)?])
}

/// Chroma key is a camera-layer treatment available in EVERY layout with a
/// camera (unlike the bubble mask, which is overlay policy) — a keyed camera
/// over an Assets background is the headline use case. Returns None when off.
pub fn camera_chroma_key(layout: &LayoutSettings) -> Option<ChromaKeySpec> {
    if !layout.camera_chroma_key_enabled {
        return None;
    }
    let key_rgb = parse_hex_rgb(&layout.camera_chroma_key_color).unwrap_or_else(|| {
        tracing::warn!(
            color = %layout.camera_chroma_key_color,
            "Chroma key color is not #RRGGBB; keying against green."
        );
        [0, 255, 0]
    });
    // Hide edges are set as the streamer sees the camera; the CPU, Metal and
    // D3D11 paths sample the unmirrored source, so resolve the mirror here.
    let as_seen = camera_chroma_key_edges_as_seen(layout);
    let edges = if layout.camera_mirror {
        as_seen.mirrored()
    } else {
        as_seen
    };
    Some(ChromaKeySpec {
        key_rgb,
        max_angle_deg: f64::from(layout.camera_chroma_key_similarity_pct.min(100))
            * CHROMA_KEY_PCT_TO_DEGREES,
        band_deg: f64::from(layout.camera_chroma_key_smoothness_pct.min(100))
            * CHROMA_KEY_PCT_TO_DEGREES,
        spill: f64::from(layout.camera_chroma_key_spill_pct.min(100)) / 100.0,
        edges,
    })
}

/// Hide edges as the streamer sees the camera (mirror applied), for paths
/// that mirror BEFORE keying (the FFmpeg leg runs `hflip` first). Every
/// other path uses the mirror-resolved [`ChromaKeySpec::edges`].
pub fn camera_chroma_key_edges_as_seen(layout: &LayoutSettings) -> ChromaKeyEdges {
    ChromaKeyEdges::from_as_seen_pct(&layout.camera_chroma_key_edges)
}

/// Alpha for one source pixel. Angle model: θ = angle between the pixel's
/// CbCr vector and the key direction; 0 at/below `max_angle_deg`, 255 at/above
/// `max_angle_deg + band_deg`, linear ramp between. The luma-scaled saturation
/// floor then pulls low-chroma pixels back toward opaque (greys never key).
/// This f64 form is the reference the CPU path calls directly and the Metal
/// and D3D11 shaders mirror in f32. Hide edges are positional, so callers
/// test [`ChromaKeySpec::edges`] with the texel they sampled.
pub fn chroma_key_alpha(spec: &ChromaKeySpec, r: u8, g: u8, b: u8) -> u8 {
    let Some((dir_cb, dir_cr)) = spec.key_direction() else {
        return 255;
    };
    let cb = rgb_cb_f64([r, g, b]) - 128.0;
    let cr = rgb_cr_f64([r, g, b]) - 128.0;
    let saturation = (cb * cb + cr * cr).sqrt();
    let (floor, ramp) = chroma_key_saturation_floor(rgb_luma_f64([r, g, b]));
    if saturation <= floor {
        return 255;
    }
    let cos_theta = ((cb * dir_cb + cr * dir_cr) / saturation).clamp(-1.0, 1.0);
    let theta_deg = cos_theta.acos().to_degrees();
    let angle_alpha = if theta_deg <= spec.max_angle_deg {
        0.0
    } else if spec.band_deg <= 0.0 || theta_deg >= spec.max_angle_deg + spec.band_deg {
        255.0
    } else {
        (theta_deg - spec.max_angle_deg) / spec.band_deg * 255.0
    };
    let eligibility = ((saturation - floor) / ramp).clamp(0.0, 1.0);
    (255.0 - eligibility * (255.0 - angle_alpha)).round() as u8
}

/// Spill suppression on kept pixels: pull the key channel down toward the
/// other channels' max, scaled by `spill`. Only pixels where the key channel
/// DOMINATES both others move, so neutral/yellow/cyan subject tones survive.
pub fn chroma_key_despill(spec: &ChromaKeySpec, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    if spec.spill <= 0.0 {
        return (r, g, b);
    }
    if spec.spill_is_blue() {
        let limit = r.max(g);
        if b > limit {
            let suppressed = f64::from(b) - spec.spill * f64::from(b - limit);
            return (r, g, suppressed.round() as u8);
        }
    } else {
        let limit = r.max(b);
        if g > limit {
            let suppressed = f64::from(g) - spec.spill * f64::from(g - limit);
            return (r, suppressed.round() as u8, b);
        }
    }
    (r, g, b)
}

/// Mask geometry over a box that may hang off the canvas (plan 215 E2): the
/// circle or corners belong to the whole box, so a source bigger than the
/// canvas keeps its true shape and the canvas edge cuts the shape, not the
/// other way round. An on-canvas [`PixelRect`] converts; the f64s are the
/// same ones as before for it.
pub fn circle_geometry(rect: impl Into<SignedPixelRect>) -> CircleGeometry {
    let rect = rect.into();
    CircleGeometry {
        center_x: rect.x as f64 + f64::from(rect.width) / 2.0,
        center_y: rect.y as f64 + f64::from(rect.height) / 2.0,
        radius: f64::from(rect.width.min(rect.height)) / 2.0,
    }
}

pub fn rounded_rect_geometry(
    rect: impl Into<SignedPixelRect>,
    radius_pct: u32,
) -> RoundedRectGeometry {
    let rect = rect.into();
    let radius = f64::from(rect.width.min(rect.height)) * f64::from(radius_pct.min(50)) / 100.0;
    RoundedRectGeometry {
        center_x: rect.x as f64 + f64::from(rect.width) / 2.0,
        center_y: rect.y as f64 + f64::from(rect.height) / 2.0,
        radius,
        inner_half_width: (f64::from(rect.width) / 2.0 - radius).max(0.0),
        inner_half_height: (f64::from(rect.height) / 2.0 - radius).max(0.0),
    }
}

/// The single-pixel mask test. Per-pixel loops build a `SceneMaskTester` once
/// instead (plan 191); this is the same tester, so there is one rule.
#[cfg(test)]
pub fn scene_mask_allows(
    mask: SceneMask,
    rect: impl Into<SignedPixelRect>,
    x: usize,
    y: usize,
) -> bool {
    SceneMaskTester::new(mask, rect).allows(x, y)
}

/// A `SceneMask` resolved against one destination rect (plan 191): the circle
/// or rounded-rect geometry, f64 divisions included, is derived once in `new`
/// instead of for every pixel. `allows` runs the same f64 operations in the
/// same order as the per-pixel rule always did, so results are bit-identical.
#[derive(Debug, Clone, Copy)]
pub enum SceneMaskTester {
    None,
    Circle(CircleGeometry),
    Rounded(RoundedRectGeometry),
}

impl SceneMaskTester {
    pub fn new(mask: SceneMask, rect: impl Into<SignedPixelRect>) -> Self {
        let rect = rect.into();
        match mask {
            SceneMask::None => Self::None,
            SceneMask::Circle => Self::Circle(circle_geometry(rect)),
            SceneMask::Rounded { radius_pct } => {
                Self::Rounded(rounded_rect_geometry(rect, radius_pct))
            }
        }
    }

    /// Whether the pixel at canvas `(x, y)` survives; its centre is tested.
    #[inline]
    pub fn allows(&self, x: usize, y: usize) -> bool {
        match *self {
            Self::None => true,
            Self::Circle(geometry) => {
                if geometry.radius <= 0.0 {
                    return false;
                }
                let dx = x as f64 + 0.5 - geometry.center_x;
                let dy = y as f64 + 0.5 - geometry.center_y;
                dx * dx + dy * dy <= geometry.radius * geometry.radius
            }
            Self::Rounded(geometry) => {
                if geometry.radius <= 0.0 {
                    return true;
                }
                let qx = ((x as f64 + 0.5 - geometry.center_x).abs() - geometry.inner_half_width)
                    .max(0.0);
                let qy = ((y as f64 + 0.5 - geometry.center_y).abs() - geometry.inner_half_height)
                    .max(0.0);
                qx * qx + qy * qy <= geometry.radius * geometry.radius
            }
        }
    }
}

pub fn camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
) -> (u32, u32) {
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    let height = match shape {
        CameraShape::Circle => width,
        CameraShape::Rectangle | CameraShape::Rounded => match aspect {
            CameraAspect::Source => (width * 9 + 8) / 16,
            CameraAspect::Square => width,
            CameraAspect::Portrait => (width * 4_u32).div_ceil(3),
        },
    };
    (width, height)
}

pub fn camera_output_scale(output_width: u32, output_height: u32) -> f64 {
    (f64::from(output_width) / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(f64::from(output_height) / f64::from(CAMERA_REFERENCE_HEIGHT))
}

pub fn scale_camera_dimension(value: u32, scale: f64) -> u32 {
    (f64::from(value) * scale).round().max(1.0) as u32
}

pub fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
    output_width: u32,
    output_height: u32,
) -> (u32, u32) {
    let scale = camera_output_scale(output_width, output_height);
    let (width, height) = camera_box_size(size, shape, aspect);
    (
        scale_camera_dimension(width, scale),
        scale_camera_dimension(height, scale),
    )
}

pub fn scaled_camera_margin(layout: &LayoutSettings, output_width: u32, output_height: u32) -> u32 {
    scale_camera_dimension(
        layout.camera_margin.min(160),
        camera_output_scale(output_width, output_height),
    )
}

pub fn crop_for_zoom(zoom: u32, offset: i32) -> (f64, f64) {
    let zoom = zoom.clamp(100, 200);
    if zoom == 100 {
        return (0.0, 0.0);
    }
    let total_crop = 1.0 - (100.0 / f64::from(zoom));
    let offset = (f64::from(offset.clamp(-100, 100)) / 200.0) * total_crop;
    normalize_crop_pair((total_crop / 2.0) + offset, (total_crop / 2.0) - offset)
}

/// Preset camera geometry is the authority used to build the scene consumed by
/// the compositor and the equivalent FFmpeg overlay dimensions/position.
pub fn preset_camera_transform(
    layout: &LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let output_width = output_width.max(1);
    let output_height = output_height.max(1);
    let (camera_width, camera_height) = scaled_camera_box_size(
        &layout.camera_size,
        &layout.camera_shape,
        &layout.camera_aspect,
        output_width,
        output_height,
    );
    let margin = scaled_camera_margin(layout, output_width, output_height);
    let x = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::BottomLeft => margin,
        CameraCorner::TopRight | CameraCorner::BottomRight => output_width
            .saturating_sub(camera_width)
            .saturating_sub(margin),
    };
    let y = match layout.camera_corner {
        CameraCorner::TopLeft | CameraCorner::TopRight => margin,
        CameraCorner::BottomLeft | CameraCorner::BottomRight => output_height
            .saturating_sub(camera_height)
            .saturating_sub(margin),
    };
    let (crop_left, crop_right) =
        if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom == 100 {
            (0.0, 0.0)
        } else {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_x)
        };
    let (crop_top, crop_bottom) =
        if matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom == 100 {
            (0.0, 0.0)
        } else {
            crop_for_zoom(layout.camera_zoom, layout.camera_offset_y)
        };
    SceneTransform {
        x: f64::from(x) / f64::from(output_width),
        y: f64::from(y) / f64::from(output_height),
        width: f64::from(camera_width) / f64::from(output_width),
        height: f64::from(camera_height) / f64::from(output_height),
        crop_left,
        crop_top,
        crop_right,
        crop_bottom,
    }
}

/// Smallest canvas fraction a custom (free-resized) camera box may keep per
/// axis. Mirrors the stage's MIN_SOURCE_FRACTION in
/// `apps/desktop/src/renderer/src/components/scene/stage-transform.ts`.
pub(crate) const MIN_CUSTOM_CAMERA_FRACTION: f64 = 0.05;

pub fn resolved_camera_transform(
    layout: &LayoutSettings,
    output_width: u32,
    output_height: u32,
) -> SceneTransform {
    let mut transform = preset_camera_transform(layout, output_width, output_height);
    if let (CameraTransformMode::Custom, Some(custom)) =
        (layout.camera_transform_mode, layout.camera_transform)
    {
        // Free resize: a custom transform overrides the S/M/L preset box.
        // The camera's aspect LAW still holds — circle boxes stay square and
        // square/portrait aspects keep their pixel ratio — because every
        // render path derives its mask/crop from this one box.
        let (width, height) =
            custom_camera_box_fractions(layout, custom, &transform, output_width, output_height);
        transform.width = width;
        transform.height = height;
        transform.x = finite_or_zero(custom.x).clamp(0.0, (1.0 - transform.width).max(0.0));
        transform.y = finite_or_zero(custom.y).clamp(0.0, (1.0 - transform.height).max(0.0));
    }
    transform
}

/// The normalized box a custom camera transform resolves to. Non-finite or
/// non-positive sizes (legacy custom transforms carried position only in
/// spirit; the wire always had width/height) fall back to the preset box.
/// Shaped cameras (circle, forced square/portrait aspect) keep their pixel
/// ratio: the requested width drives and the height follows, clamped so both
/// axes stay within [5%, 100%] of the canvas.
pub(crate) fn custom_camera_box_fractions(
    layout: &LayoutSettings,
    custom: crate::protocol::CameraTransform,
    preset: &SceneTransform,
    output_width: u32,
    output_height: u32,
) -> (f64, f64) {
    let output_width = f64::from(output_width.max(1));
    let output_height = f64::from(output_height.max(1));
    let min = MIN_CUSTOM_CAMERA_FRACTION;
    let requested_width = if custom.width.is_finite() && custom.width > 0.0 {
        custom.width
    } else {
        preset.width
    };
    let requested_height = if custom.height.is_finite() && custom.height > 0.0 {
        custom.height
    } else {
        preset.height
    };

    // Pixel width : height the mask law enforces, or None for a free box.
    let forced_ratio = match (&layout.camera_shape, &layout.camera_aspect) {
        (CameraShape::Circle, _) => Some(1.0),
        (_, CameraAspect::Square) => Some(1.0),
        (_, CameraAspect::Portrait) => Some(3.0 / 4.0),
        (_, CameraAspect::Source) => None,
    };
    let Some(ratio) = forced_ratio else {
        return (
            requested_width.clamp(min, 1.0),
            requested_height.clamp(min, 1.0),
        );
    };

    let mut width_px = requested_width.clamp(min, 1.0) * output_width;
    let min_width_px = (min * output_width).max(min * output_height * ratio);
    let max_width_px = output_width.min(output_height * ratio);
    width_px = width_px.clamp(min_width_px, max_width_px.max(min_width_px));
    (width_px / output_width, (width_px / ratio) / output_height)
}

pub fn side_by_side_fractions(split: SideBySideSplit) -> (f64, f64) {
    match split {
        SideBySideSplit::Even => (0.5, 0.5),
        SideBySideSplit::SixtyForty => (0.6, 0.4),
        SideBySideSplit::SeventyThirty => (0.7, 0.3),
    }
}

/// Even pixel widths are required by the YUV/encoder paths. The regions always
/// tile the canvas and the screen gets the larger (or equal) share.
pub fn side_by_side_widths(split: SideBySideSplit, total_width: u32) -> (u32, u32) {
    let (screen_fraction, _) = side_by_side_fractions(split);
    let mut screen_width = (f64::from(total_width) * screen_fraction).round() as u32;
    screen_width -= screen_width % 2;
    screen_width = screen_width.clamp(2, total_width.saturating_sub(2));
    (screen_width, total_width - screen_width)
}

/// A box origin in canvas pixels, signed, within the protocol's position
/// bounds (so a malformed transform cannot ask for a box light-years off).
fn normalized_to_signed_pixel(value: f64, span: u32) -> i64 {
    (finite_or_zero(value).clamp(MIN_SOURCE_POSITION_FRACTION, MAX_SOURCE_POSITION_FRACTION)
        * f64::from(span))
    .round() as i64
}

/// A box side in canvas pixels, at least one and at most the protocol's 400%.
fn normalized_to_span(value: f64, span: u32) -> u32 {
    (finite_or_zero(value).clamp(0.0, MAX_SOURCE_SIZE_FRACTION) * f64::from(span))
        .round()
        .max(1.0) as u32
}

fn normalize_crop_pair(first: f64, second: f64) -> (f64, f64) {
    let mut first = finite_or_zero(first).clamp(0.0, 0.95);
    let mut second = finite_or_zero(second).clamp(0.0, 0.95);
    let total = first + second;
    if total > 0.95 {
        let scale = 0.95 / total;
        first *= scale;
        second *= scale;
    }
    (first, second)
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SideBySideCameraSide, default_layout_settings};

    fn layout() -> LayoutSettings {
        default_layout_settings()
    }

    /// Plan 216 B1: the shared fixture pins the Rust picture rect to the TS
    /// `scenePictureRectPixels`, within a pixel, case for case.
    #[test]
    fn picture_rect_reproduces_the_shared_fixture() {
        #[derive(serde::Deserialize)]
        struct FixtureSize {
            width: u32,
            height: u32,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCrop {
            #[serde(default)]
            crop_left: f64,
            #[serde(default)]
            crop_top: f64,
            #[serde(default)]
            crop_right: f64,
            #[serde(default)]
            crop_bottom: f64,
        }
        #[derive(serde::Deserialize)]
        struct FixtureRect {
            x: i64,
            y: i64,
            width: i64,
            height: i64,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCase {
            name: String,
            frame: CameraTransform,
            kind: SceneSourceKind,
            fit: String,
            source: Option<FixtureSize>,
            crop: Option<FixtureCrop>,
            #[serde(default)]
            stage_margin: f64,
            canvas: FixtureSize,
            expected: FixtureRect,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            schema_version: u32,
            cases: Vec<FixtureCase>,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/scene-picture-geometry.json"
        ))
        .expect("protocol-fixtures/scene-picture-geometry.json is valid JSON");
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.cases.len() >= 12);
        for case in fixture.cases {
            let crop = case.crop.unwrap_or(FixtureCrop {
                crop_left: 0.0,
                crop_top: 0.0,
                crop_right: 0.0,
                crop_bottom: 0.0,
            });
            let transform = SceneTransform {
                x: case.frame.x,
                y: case.frame.y,
                width: case.frame.width,
                height: case.frame.height,
                crop_left: crop.crop_left,
                crop_top: crop.crop_top,
                crop_right: crop.crop_right,
                crop_bottom: crop.crop_bottom,
            };
            let fit = match case.fit.as_str() {
                "contain" => SceneFit::Contain,
                "cover" => SceneFit::Cover,
                other => panic!("{}: unknown fit {other}", case.name),
            };
            let pixels = scene_picture_rect_pixels(
                &transform,
                &case.kind,
                fit,
                case.source.as_ref().map(|size| (size.width, size.height)),
                case.stage_margin,
                case.canvas.width,
                case.canvas.height,
            )
            .unwrap_or_else(|| panic!("{}: no picture rect", case.name));
            let within = |actual: i64, expected: i64, what: &str| {
                assert!(
                    (actual - expected).abs() <= 1,
                    "{}: {what} {actual} vs {expected}",
                    case.name
                );
            };
            within(pixels.x, case.expected.x, "x");
            within(pixels.y, case.expected.y, "y");
            within(i64::from(pixels.width), case.expected.width, "width");
            within(i64::from(pixels.height), case.expected.height, "height");
            // The fraction form is the pixel form over the canvas.
            let fraction = scene_picture_rect(
                &transform,
                &case.kind,
                fit,
                case.source.as_ref().map(|size| (size.width, size.height)),
                case.stage_margin,
                case.canvas.width,
                case.canvas.height,
            )
            .unwrap();
            within(
                (fraction.x * f64::from(case.canvas.width)).round() as i64,
                case.expected.x,
                "fraction x",
            );
            within(
                (fraction.width * f64::from(case.canvas.width)).round() as i64,
                case.expected.width,
                "fraction width",
            );
        }
    }

    /// The streamer's numbers (plan 216): a 2228x1440 display Fit in a
    /// 16:9 frame of 2321x1306 px at 9.3% is about 2021 px wide, at x 0.152.
    #[test]
    fn picture_rect_is_the_fitted_picture_not_the_frame() {
        let frame = SceneTransform {
            x: 0.0932,
            y: 0.0932,
            width: 0.9068,
            height: 0.9068,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };
        let picture = scene_picture_rect(
            &frame,
            &SceneSourceKind::Screen,
            SceneFit::Contain,
            Some((2228, 1440)),
            0.0,
            2560,
            1440,
        )
        .unwrap();
        assert!((picture.x - 0.152).abs() < 0.001, "{picture:?}");
        assert!((picture.width - 0.789).abs() < 0.001, "{picture:?}");
        assert!((picture.y - frame.y).abs() < 0.001, "{picture:?}");
        // Fill, an unknown size and the test pattern give the frame.
        for (fit, kind, size) in [
            (SceneFit::Cover, SceneSourceKind::Screen, Some((2228, 1440))),
            (SceneFit::Contain, SceneSourceKind::Screen, None),
            (
                SceneFit::Cover,
                SceneSourceKind::TestPattern,
                Some((2560, 1440)),
            ),
        ] {
            let rect =
                scene_picture_rect_pixels(&frame, &kind, fit, size, 0.0, 2560, 1440).unwrap();
            assert_eq!(
                rect,
                scene_source_rect_pixels(&frame, 2560, 1440).unwrap(),
                "{kind:?} {fit:?}"
            );
        }
        // A scene background's margin moves the screen's picture, never the camera's.
        let staged = scene_picture_rect_pixels(
            &frame,
            &SceneSourceKind::Screen,
            SceneFit::Contain,
            Some((2228, 1440)),
            0.1,
            2560,
            1440,
        )
        .unwrap();
        let expected = scene_source_render_transform(&frame, &SceneSourceKind::Screen, 0.1);
        let expected = contain_rect_pixels(
            2228.0,
            1440.0,
            scene_source_rect_pixels(&expected, 2560, 1440).unwrap(),
        );
        assert_eq!(staged, expected);
    }

    #[test]
    fn horizontal_fill_covers_the_landscape_screen_scenes_only() {
        // Plan 213 G3: Fill makes the landscape screen scenes cover; the
        // default stays Fit (contain), side by side always covers, and a
        // vertical scene ignores the landscape field.
        use crate::protocol::HorizontalScreenFraming;
        assert_eq!(
            layout().horizontal_screen_framing,
            HorizontalScreenFraming::Fit
        );
        for preset in [LayoutPreset::ScreenCamera, LayoutPreset::ScreenOnly] {
            for freeform in [false, true] {
                let mut layout = layout();
                layout.layout_preset = preset.clone();
                if freeform {
                    layout.arrangement_mode = ArrangementMode::Freeform;
                }
                for kind in [SceneSourceKind::Screen, SceneSourceKind::Window] {
                    assert_eq!(scene_source_fit(&kind, &layout), SceneFit::Contain);
                    layout.horizontal_screen_framing = HorizontalScreenFraming::Fill;
                    assert_eq!(
                        scene_source_fit(&kind, &layout),
                        SceneFit::Cover,
                        "{preset:?}"
                    );
                    layout.horizontal_screen_framing = HorizontalScreenFraming::Fit;
                }
                // The camera keeps its own Fit choice.
                layout.horizontal_screen_framing = HorizontalScreenFraming::Fill;
                layout.camera_fit = CameraFit::Fit;
                assert_eq!(
                    scene_source_fit(&SceneSourceKind::Camera, &layout),
                    SceneFit::Contain
                );
            }
        }
        let mut side_by_side = layout();
        side_by_side.layout_preset = LayoutPreset::SideBySide;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &side_by_side),
            SceneFit::Cover
        );
        let mut vertical = layout();
        vertical.layout_preset = LayoutPreset::VerticalScreenOnly;
        vertical.vertical_screen_framing = crate::protocol::VerticalScreenFraming::Fit;
        vertical.horizontal_screen_framing = HorizontalScreenFraming::Fill;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &vertical),
            SceneFit::Contain,
            "a vertical scene reads only its own framing"
        );
    }

    #[test]
    fn fit_framing_contains_the_screen_in_every_vertical_preset_only() {
        use crate::protocol::VerticalScreenFraming;
        for preset in [
            LayoutPreset::VerticalCameraTop,
            LayoutPreset::VerticalCameraBottom,
            LayoutPreset::VerticalSplit,
            LayoutPreset::VerticalScreenCamera,
            LayoutPreset::VerticalScreenOnly,
        ] {
            let mut layout = layout();
            layout.layout_preset = preset.clone();
            layout.vertical_screen_framing = VerticalScreenFraming::Fit;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::TestPattern, &layout),
                SceneFit::Cover,
                "the canvas-sized test pattern has nothing to contain"
            );
            for kind in [SceneSourceKind::Screen, SceneSourceKind::Window] {
                assert_eq!(
                    scene_source_fit(&kind, &layout),
                    SceneFit::Contain,
                    "{preset:?} {kind:?} must show the whole screen under fit"
                );
            }
            // The default stays the short-form fill law.
            layout.vertical_screen_framing = VerticalScreenFraming::Fill;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Screen, &layout),
                SceneFit::Cover
            );
        }

        // Band cameras keep covering under fit: the camera fills whatever the
        // screen leaves, so the canvas never shows a dead band.
        let mut stacked = layout();
        stacked.layout_preset = LayoutPreset::VerticalCameraBottom;
        stacked.vertical_screen_framing = VerticalScreenFraming::Fit;
        stacked.camera_fit = CameraFit::Fit;
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Camera, &stacked),
            SceneFit::Cover
        );

        // Horizontal presets never consult the field.
        let mut side_by_side = layout();
        side_by_side.layout_preset = LayoutPreset::SideBySide;
        side_by_side.vertical_screen_framing = VerticalScreenFraming::Fit;
        assert!(!vertical_screen_fits(&side_by_side));
        assert_eq!(
            scene_source_fit(&SceneSourceKind::Screen, &side_by_side),
            SceneFit::Cover
        );
        assert_eq!(
            scene_source_fit(&SceneSourceKind::TestPattern, &side_by_side),
            SceneFit::Cover
        );
    }

    #[test]
    fn preset_fit_and_mask_policy_table_is_renderer_independent() {
        // Columns: preset, screen fit, camera fit (with CameraFit::Fit set —
        // band cameras must IGNORE it and cover), mask. Every vertical preset
        // covers its regions: short-form bands are filled, never letterboxed
        // (2026-07-13 fill-crop plan, owner report).
        let cases = [
            (
                LayoutPreset::ScreenCamera,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::Rounded { radius_pct: 12 },
            ),
            (
                LayoutPreset::ScreenOnly,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::None,
            ),
            (
                LayoutPreset::CameraOnly,
                SceneFit::Contain,
                SceneFit::Contain,
                SceneMask::None,
            ),
            (
                LayoutPreset::SideBySide,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::None,
            ),
            // The inset twin masks exactly like ScreenCamera and keeps the
            // user's camera Fit for its bubble; its SCREEN covers the frame.
            (
                LayoutPreset::VerticalScreenCamera,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::Rounded { radius_pct: 12 },
            ),
            (
                LayoutPreset::VerticalCameraTop,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            (
                LayoutPreset::VerticalCameraBottom,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            (
                LayoutPreset::VerticalSplit,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
            // Screen-only scenes never render a camera; the camera column
            // just documents the fallthrough (user Fit honored, moot here).
            (
                LayoutPreset::VerticalScreenOnly,
                SceneFit::Cover,
                SceneFit::Contain,
                SceneMask::None,
            ),
            // The full-canvas vertical camera ignores Fit like the bands do
            // (the portrait canvas is always filled) and stays maskless.
            (
                LayoutPreset::VerticalCameraOnly,
                SceneFit::Cover,
                SceneFit::Cover,
                SceneMask::None,
            ),
        ];
        for (preset, expected_screen_fit, expected_camera_fit, expected_mask) in cases {
            let mut layout = layout();
            layout.layout_preset = preset.clone();
            layout.camera_shape = CameraShape::Rounded;
            layout.camera_fit = CameraFit::Fit;
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Screen, &layout),
                expected_screen_fit,
                "screen fit for {preset:?}"
            );
            assert_eq!(
                scene_source_fit(&SceneSourceKind::Camera, &layout),
                expected_camera_fit,
                "camera fit for {preset:?}"
            );
            assert_eq!(camera_mask(&layout), expected_mask, "mask for {preset:?}");
        }
    }

    #[test]
    fn camera_mask_applies_in_freeform_for_any_preset_but_not_preset_side_by_side() {
        // Freeform is the user-owned bubble everywhere: once the camera is
        // dragged out of a preset, the mask shape applies regardless of which
        // preset it was entered from. Preset mode keeps the existing rule
        // (SideBySide stays maskless).
        let mut side_by_side_preset = layout();
        side_by_side_preset.layout_preset = LayoutPreset::SideBySide;
        side_by_side_preset.camera_shape = CameraShape::Circle;
        assert_eq!(
            camera_mask(&side_by_side_preset),
            SceneMask::None,
            "Preset SideBySide stays maskless"
        );

        let mut side_by_side_freeform = side_by_side_preset.clone();
        side_by_side_freeform.arrangement_mode = ArrangementMode::Freeform;
        assert_eq!(
            camera_mask(&side_by_side_freeform),
            SceneMask::Circle,
            "Freeform entered from SideBySide still shows the selected Circle"
        );

        let mut side_by_side_rounded = side_by_side_freeform.clone();
        side_by_side_rounded.camera_shape = CameraShape::Rounded;
        side_by_side_rounded.camera_corner_radius_pct = 20;
        assert_eq!(
            camera_mask(&side_by_side_rounded),
            SceneMask::Rounded { radius_pct: 20 },
            "Freeform Rounded also applies regardless of preset"
        );
    }

    #[test]
    fn parse_hex_rgb_accepts_rrggbb_with_or_without_hash() {
        assert_eq!(parse_hex_rgb("#00FF00"), Some([0, 255, 0]));
        assert_eq!(parse_hex_rgb("00b4ff"), Some([0, 180, 255]));
        assert_eq!(parse_hex_rgb(" #0000FF "), Some([0, 0, 255]));
        assert_eq!(parse_hex_rgb("#0F0"), None);
        assert_eq!(parse_hex_rgb("#GGHHII"), None);
        assert_eq!(parse_hex_rgb(""), None);
    }

    #[test]
    fn camera_chroma_key_is_off_by_default_and_ignores_preset() {
        assert_eq!(camera_chroma_key(&layout()), None);
        // Unlike the bubble mask, keying is NOT overlay policy: any layout
        // that renders a camera keys it (virtual set over a background).
        for preset in [
            LayoutPreset::ScreenCamera,
            LayoutPreset::CameraOnly,
            LayoutPreset::SideBySide,
            LayoutPreset::VerticalCameraOnly,
        ] {
            let mut layout = layout();
            layout.layout_preset = preset;
            layout.camera_chroma_key_enabled = true;
            let spec = camera_chroma_key(&layout).expect("keying enabled");
            assert_eq!(spec.key_rgb, [0, 255, 0]);
            assert_eq!(spec.max_angle_deg, 40.0 * 0.6);
            assert_eq!(spec.band_deg, 8.0 * 0.6);
            assert_eq!(spec.spill, 0.10);
        }
    }

    #[test]
    fn camera_chroma_key_clamps_percents_and_falls_back_to_green() {
        let mut layout = layout();
        layout.camera_chroma_key_enabled = true;
        layout.camera_chroma_key_color = "chartreuse".to_string();
        layout.camera_chroma_key_similarity_pct = 900;
        layout.camera_chroma_key_smoothness_pct = 900;
        layout.camera_chroma_key_spill_pct = 900;
        let spec = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!(spec.key_rgb, [0, 255, 0], "unparseable color keys green");
        assert_eq!(spec.max_angle_deg, 60.0);
        assert_eq!(spec.band_deg, 60.0);
        assert_eq!(spec.spill, 1.0);
    }

    #[test]
    fn chroma_key_cbcr_matches_the_integer_color_path_within_rounding() {
        // The keyer's f64 CbCr and color.rs's integer-shift YUV share one
        // coefficient family; if they drift the CPU key and the encoded frame
        // disagree about what "green" is.
        for rgb in [[0, 255, 0], [0, 0, 255], [255, 0, 0], [60, 180, 70]] {
            let (_, u, v) = crate::color::rgb_to_yuv_full_range_bt601(rgb[0], rgb[1], rgb[2]);
            assert!(
                (rgb_cb_f64(rgb) - f64::from(u)).abs() <= 1.0,
                "cb drift for {rgb:?}"
            );
            assert!(
                (rgb_cr_f64(rgb) - f64::from(v)).abs() <= 1.0,
                "cr drift for {rgb:?}"
            );
        }
    }

    fn default_green_spec() -> ChromaKeySpec {
        ChromaKeySpec {
            key_rgb: [0, 255, 0],
            max_angle_deg: 24.0,
            band_deg: 4.8,
            spill: 0.0,
            edges: ChromaKeyEdges::NONE,
        }
    }

    /// Plan 227 S0, the owner's recording (2026-11-11, raw camera take): the
    /// green screen falls into deep shadow in the bottom corners. These are
    /// its real tones — 13–17° from the key, chroma 9–25 — and they must key
    /// with the shipped defaults. The fixed floor of 14 kept them all.
    #[test]
    fn chroma_key_keys_a_deep_shadowed_screen() {
        let spec = default_green_spec();
        for (label, rgb) in [
            ("bottom-right deep shadow", [1u8, 23, 6]),
            ("bottom-right shadow", [0, 26, 9]),
            ("bottom-right fold", [3, 22, 9]),
            ("bottom-right corner", [1, 25, 6]),
            ("bottom-right mean", [1, 34, 12]),
            ("left-edge shadow", [8, 32, 13]),
            ("bottom-left mean", [4, 56, 20]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                0,
                "{label} {rgb:?} must key with defaults"
            );
        }
    }

    /// Plan 227 S0: the same recording's near-black SUBJECT and the real
    /// curtain at the frame's edge. Their chroma is under 4 and every one of
    /// them must stay opaque, or the t-shirt and the mic arm get holes.
    #[test]
    fn chroma_key_keeps_near_black_subjects() {
        let spec = default_green_spec();
        for (label, rgb) in [
            ("black t-shirt", [27u8, 23, 25]),
            ("mic arm", [6, 9, 6]),
            ("mic arm shadow", [1, 4, 1]),
            ("near-black codec noise", [2, 7, 3]),
            ("t-shirt with green spill", [10, 18, 12]),
            ("curtain strip", [17, 19, 16]),
            ("curtain black", [6, 6, 6]),
            ("pure black", [0, 0, 0]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                255,
                "{label} {rgb:?} must survive with defaults"
            );
        }
    }

    #[test]
    fn chroma_key_saturation_floor_scales_with_luma_and_keeps_the_old_floor_up_high() {
        assert_eq!(chroma_key_saturation_floor(0.0), (5.0, 5.0 * 6.0 / 14.0));
        assert_eq!(chroma_key_saturation_floor(20.0).0, 5.0);
        assert!((chroma_key_saturation_floor(60.0).0 - 9.0).abs() < 1e-9);
        // From Y ≈ 93.3 up the floor is the old 14 with the old ramp of 6.
        for luma in [94.0, 128.0, 255.0] {
            let (floor, ramp) = chroma_key_saturation_floor(luma);
            assert_eq!(floor, 14.0);
            assert!((ramp - 6.0).abs() < 1e-9);
        }
        assert_eq!(
            CHROMA_KEY_SATURATION_FLOOR_PARAMS,
            [5.0, 0.15, 14.0, 6.0 / 14.0]
        );
        assert!((rgb_luma_f64([255, 255, 255]) - 255.0).abs() < 1e-9);
    }

    #[test]
    fn hide_edges_resolve_the_mirror_and_clamp_each_side() {
        let mut layout = layout();
        layout.camera_chroma_key_enabled = true;
        assert!(
            camera_chroma_key(&layout)
                .expect("keying enabled")
                .edges
                .is_none(),
            "no edges by default"
        );
        layout.camera_chroma_key_edges = crate::protocol::CameraKeyEdges {
            left_pct: 2,
            top_pct: 0,
            right_pct: 90,
            bottom_pct: 5,
        };
        let spec = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!(
            spec.edges,
            ChromaKeyEdges {
                left: 0.02,
                top: 0.0,
                right: 0.25,
                bottom: 0.05,
            },
            "each side clamps to 25 %"
        );
        assert_eq!(camera_chroma_key_edges_as_seen(&layout), spec.edges);
        // Mirrored, "left as you see it" is the source's right side.
        layout.camera_mirror = true;
        let mirrored = camera_chroma_key(&layout).expect("keying enabled");
        assert_eq!((mirrored.edges.left, mirrored.edges.right), (0.25, 0.02));
        assert_eq!(camera_chroma_key_edges_as_seen(&layout).left, 0.02);
        assert_eq!(mirrored.edges.kept_uv(), [0.25, 0.0, 0.98, 0.95]);
    }

    #[test]
    fn hide_edges_test_the_texel_centre() {
        let edges = ChromaKeyEdges {
            left: 0.25,
            top: 0.0,
            right: 0.0,
            bottom: 0.5,
        };
        // 4×2 frame: column 0 (centre 0.125) is hidden, column 1 (0.375) kept;
        // row 1 (centre 0.75) is below the kept half.
        assert!(!edges.keeps_texel(0, 0, 4, 2));
        assert!(edges.keeps_texel(1, 0, 4, 2));
        assert!(edges.keeps_texel(3, 0, 4, 2));
        assert!(!edges.keeps_texel(3, 1, 4, 2));
        assert!(ChromaKeyEdges::NONE.keeps_texel(0, 0, 1, 1));
    }

    /// THE calibration pin (2026-07-14 owner report): the keyer must key a
    /// REALISTIC studio-lit screen with the SHIPPED DEFAULTS, not just pure
    /// fixture colors. The 0.9.39 absolute-distance model passed every
    /// pure-color test and keyed nothing real; this table is the regression
    /// guard against that class of miscalibration.
    #[test]
    fn chroma_key_keys_a_realistic_screen_palette_with_defaults() {
        let spec = default_green_spec();
        // Real screen tones across lighting — ALL must key fully.
        for (label, rgb) in [
            ("pure green", [0u8, 255, 0]),
            ("bright lit screen", [80, 200, 90]),
            ("well-lit screen", [60, 180, 70]),
            ("mid screen", [40, 140, 55]),
            ("shadowed screen", [30, 100, 40]),
            ("overexposed edge", [110, 190, 120]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                0,
                "{label} must key with defaults"
            );
        }
        // The subject must survive untouched.
        for (label, rgb) in [
            ("skin", [200u8, 160, 140]),
            ("dark hair", [40, 30, 25]),
            ("white shirt", [230, 230, 230]),
            ("red", [255, 0, 0]),
            ("grey", [128, 128, 128]),
        ] {
            assert_eq!(
                chroma_key_alpha(&spec, rgb[0], rgb[1], rgb[2]),
                255,
                "{label} must survive with defaults"
            );
        }
        // Documented physics (true of every chroma keyer): a saturated green
        // GARMENT keys too — the saturation floor cannot save a green shirt.
        assert_eq!(chroma_key_alpha(&spec, 90, 140, 95), 0);
    }

    #[test]
    fn chroma_key_alpha_ramps_by_angle_and_saturation() {
        let spec = default_green_spec();
        // Alpha never decreases as hue rotates away from the key direction:
        // blend green toward red through yellow.
        let mut previous = 0;
        for step in 0..=10 {
            let t = f64::from(step) / 10.0;
            let r = (255.0 * t).round() as u8;
            let g = (255.0 * (1.0 - t) + 100.0 * t).round() as u8;
            let alpha = chroma_key_alpha(&spec, r, g, 0);
            assert!(
                alpha >= previous,
                "hue ramp not monotonic at step {step}: {alpha} < {previous}"
            );
            previous = alpha;
        }
        assert_eq!(previous, 255);
        // The saturation floor ramps: a key-direction color fades to opaque
        // as it desaturates toward grey.
        // (100,135,100): saturation ~18.7 → partially eligible → mid alpha.
        let partial = chroma_key_alpha(&spec, 100, 135, 100);
        assert!(
            partial > 0 && partial < 255,
            "low-saturation screen tone should partially key, got {partial}"
        );
        // (110,130,110): saturation ~10.7, below the floor → fully opaque.
        assert_eq!(chroma_key_alpha(&spec, 110, 130, 110), 255);
    }

    #[test]
    fn chroma_key_alpha_zero_band_is_a_hard_cut_and_grey_key_never_keys() {
        let spec = ChromaKeySpec {
            band_deg: 0.0,
            ..default_green_spec()
        };
        assert_eq!(chroma_key_alpha(&spec, 0, 255, 0), 0);
        assert_eq!(chroma_key_alpha(&spec, 128, 128, 128), 255);
        assert_eq!(chroma_key_alpha(&spec, 255, 0, 0), 255);
        // A grey key color has no chroma direction — nothing may key.
        let grey_key = ChromaKeySpec {
            key_rgb: [128, 128, 128],
            ..default_green_spec()
        };
        assert_eq!(chroma_key_alpha(&grey_key, 0, 255, 0), 255);
        assert!(grey_key.key_direction().is_none());
    }

    #[test]
    fn chroma_key_despill_clamps_only_the_dominant_key_channel() {
        let green = ChromaKeySpec {
            key_rgb: [0, 255, 0],
            max_angle_deg: 24.0,
            band_deg: 4.8,
            spill: 1.0,
            edges: ChromaKeyEdges::NONE,
        };
        assert_eq!(chroma_key_despill(&green, 100, 200, 80), (100, 100, 80));
        let half = ChromaKeySpec {
            spill: 0.5,
            ..green
        };
        assert_eq!(chroma_key_despill(&half, 100, 200, 80), (100, 150, 80));
        // Neutral and non-dominant pixels never move.
        assert_eq!(chroma_key_despill(&green, 128, 128, 128), (128, 128, 128));
        assert_eq!(chroma_key_despill(&green, 200, 150, 90), (200, 150, 90));
        let blue = ChromaKeySpec {
            key_rgb: [0, 0, 255],
            ..green
        };
        assert!(blue.spill_is_blue());
        assert_eq!(chroma_key_despill(&blue, 90, 100, 220), (90, 100, 100));
        let off = ChromaKeySpec {
            spill: 0.0,
            ..green
        };
        assert_eq!(chroma_key_despill(&off, 100, 200, 80), (100, 200, 80));
    }

    #[test]
    fn shape_and_radius_policy_table_clamps_once() {
        let cases = [
            (CameraShape::Rectangle, 18, SceneMask::None),
            (CameraShape::Circle, 18, SceneMask::Circle),
            (
                CameraShape::Rounded,
                18,
                SceneMask::Rounded { radius_pct: 18 },
            ),
            (
                CameraShape::Rounded,
                400,
                SceneMask::Rounded { radius_pct: 50 },
            ),
        ];
        for (shape, radius_pct, expected) in cases {
            let mut layout = layout();
            layout.layout_preset = LayoutPreset::ScreenCamera;
            layout.camera_shape = shape;
            layout.camera_corner_radius_pct = radius_pct;
            assert_eq!(camera_mask(&layout), expected);
        }
    }

    #[test]
    fn shape_and_radius_policy_applies_in_freeform_too() {
        // Same clamp-once policy, but entered from a non-inset preset via
        // Freeform instead of ScreenCamera.
        let mut layout = layout();
        layout.layout_preset = LayoutPreset::CameraOnly;
        layout.arrangement_mode = ArrangementMode::Freeform;
        layout.camera_shape = CameraShape::Circle;
        assert_eq!(camera_mask(&layout), SceneMask::Circle);

        layout.camera_shape = CameraShape::Rounded;
        layout.camera_corner_radius_pct = 400;
        assert_eq!(camera_mask(&layout), SceneMask::Rounded { radius_pct: 50 });
    }

    #[test]
    fn camera_geometry_scales_at_1080p_and_4k() {
        let mut layout = layout();
        layout.camera_corner = CameraCorner::BottomRight;
        layout.camera_size = CameraSize::Medium;
        layout.camera_shape = CameraShape::Rectangle;
        layout.camera_aspect = CameraAspect::Source;
        layout.camera_margin = 32;

        let cases = [
            (
                (1920, 1080),
                PixelRect {
                    x: 1332,
                    y: 727,
                    width: 540,
                    height: 305,
                },
            ),
            (
                (3840, 2160),
                PixelRect {
                    x: 2664,
                    y: 1455,
                    width: 1080,
                    height: 609,
                },
            ),
        ];
        for ((width, height), expected) in cases {
            let transform = preset_camera_transform(&layout, width, height);
            assert_eq!(
                scene_source_rect_pixels(&transform, width, height),
                Some(SignedPixelRect::from(expected))
            );
        }
    }

    /// The Scene stage shows this box while a camera is dragged into a corner
    /// of a preset scene (its drop target): pinned with the renderer's twin,
    /// `presetCameraCornerRect` in `components/scene/stage-corner.test.ts`.
    #[test]
    fn preset_camera_corner_boxes_match_the_stage_drop_target() {
        let cases = [
            (
                CameraSize::Medium,
                CameraShape::Rectangle,
                CameraAspect::Source,
                32,
                CameraCorner::BottomRight,
                (1920, 1080),
                (1332, 727, 540, 305),
            ),
            (
                CameraSize::Small,
                CameraShape::Circle,
                CameraAspect::Source,
                32,
                CameraCorner::TopLeft,
                (1080, 1920),
                (27, 27, 219, 219),
            ),
            (
                CameraSize::Large,
                CameraShape::Rounded,
                CameraAspect::Portrait,
                500,
                CameraCorner::TopRight,
                (1280, 720),
                (640, 160, 480, 640),
            ),
        ];
        for (size, shape, aspect, margin, corner, (width, height), (x, y, w, h)) in cases {
            let mut layout = layout();
            layout.camera_size = size;
            layout.camera_shape = shape;
            layout.camera_aspect = aspect;
            layout.camera_margin = margin;
            layout.camera_corner = corner;
            let transform = preset_camera_transform(&layout, width, height);
            let (width, height) = (f64::from(width), f64::from(height));
            assert_eq!(
                (transform.x, transform.y, transform.width, transform.height),
                (
                    f64::from(x) / width,
                    f64::from(y) / height,
                    f64::from(w) / width,
                    f64::from(h) / height
                )
            );
        }
    }

    #[test]
    fn custom_transform_and_zoom_crop_table_matches_1080p_and_4k() {
        let mut layout = layout();
        layout.camera_transform_mode = CameraTransformMode::Custom;
        layout.camera_transform = Some(CameraTransform {
            x: 0.9,
            y: -0.2,
            width: 0.1,
            height: 0.1,
        });
        layout.camera_zoom = 150;
        layout.camera_offset_x = 40;
        layout.camera_offset_y = -20;

        for (width, height) in [(1920, 1080), (3840, 2160)] {
            let transform = resolved_camera_transform(&layout, width, height);
            let rect = scene_source_rect_pixels(&transform, width, height).unwrap();
            assert_eq!(rect.right(), i64::from(width), "custom x clamps on-canvas");
            assert_eq!(rect.y, 0, "custom y clamps on-canvas");
            assert!((transform.crop_left - 0.233_333_333_333_333_34).abs() < 1e-9);
            assert!((transform.crop_right - 0.1).abs() < 1e-9);
            assert!((transform.crop_top - 0.133_333_333_333_333_33).abs() < 1e-9);
            assert!((transform.crop_bottom - 0.2).abs() < 1e-9);
        }
    }

    /// Plan 215 E1 (D2): a box that runs past the canvas edge keeps its true
    /// origin and size, so what hangs off is cut, never squashed. Before,
    /// `scene_source_rect_pixels` clamped the origin onto the canvas and
    /// shrank the size to what was left, which squeezed the whole picture
    /// into the visible part.
    #[test]
    fn transform_and_crop_table_cuts_at_canvas_edges_and_never_squashes() {
        let past_the_corner = SceneTransform {
            x: 0.75,
            y: 0.8,
            width: 0.5,
            height: 0.5,
            crop_left: -1.0,
            crop_top: 0.25,
            crop_right: 4.0,
            crop_bottom: 0.125,
        };
        let left_of_the_canvas = SceneTransform {
            x: -0.25,
            y: 0.0,
            width: 1.5,
            height: 1.0,
            ..past_the_corner.clone()
        };
        let four_hundred_percent = SceneTransform {
            x: -1.5,
            y: -1.5,
            width: 4.0,
            height: 4.0,
            ..past_the_corner.clone()
        };
        // (transform, canvas) -> the uncut box: signed origin, full size.
        let cases = [
            (&past_the_corner, (1920, 1080), (1440, 864, 960, 540)),
            (&past_the_corner, (3840, 2160), (2880, 1728, 1920, 1080)),
            (&left_of_the_canvas, (1920, 1080), (-480, 0, 2880, 1080)),
            (&left_of_the_canvas, (3840, 2160), (-960, 0, 5760, 2160)),
            (
                &four_hundred_percent,
                (1920, 1080),
                (-2880, -1620, 7680, 4320),
            ),
        ];
        for (transform, (width, height), (x, y, w, h)) in cases {
            let rect = scene_source_rect_pixels(transform, width, height).expect("a box");
            assert_eq!(
                (rect.x, rect.y, rect.width, rect.height),
                (x, y, w, h),
                "{transform:?} on {width}x{height}"
            );
        }
        assert_eq!(
            scene_crop_from_transform(&past_the_corner),
            SceneCrop {
                left: 0.0,
                top: 0.25,
                right: 0.95,
                bottom: 0.125,
            }
        );
    }

    #[test]
    fn signed_rect_intersects_the_canvas_and_reports_the_cut() {
        let rect = |x, y, width, height| SignedPixelRect {
            x,
            y,
            width,
            height,
        };
        let pixel = |x, y, width, height| PixelRect {
            x,
            y,
            width,
            height,
        };
        // Past the bottom-right corner: the origin stays, the size is cut.
        assert_eq!(
            rect(1440, 864, 960, 540).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(1440, 864, 480, 216),
                cut_left: 0,
                cut_top: 0,
            })
        );
        // Left of the canvas: the visible part starts at 0 and the source
        // window starts 480 box pixels in.
        assert_eq!(
            rect(-480, 0, 2880, 1080).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1920, 1080),
                cut_left: 480,
                cut_top: 0,
            })
        );
        // A 400% box centred on the canvas covers it; three quarters of it
        // hang off.
        assert_eq!(
            rect(-2880, -1620, 7680, 4320).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1920, 1080),
                cut_left: 2880,
                cut_top: 1620,
            })
        );
        // Nothing on the canvas: off every side, and an empty box.
        assert_eq!(rect(1920, 0, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(-100, 0, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, 1080, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, -100, 100, 100).intersect_canvas(1920, 1080), None);
        assert_eq!(rect(0, 0, 0, 100).intersect_canvas(1920, 1080), None);
        // One pixel on the canvas still counts.
        assert_eq!(
            rect(-99, -99, 100, 100).intersect_canvas(1920, 1080),
            Some(CanvasCut {
                visible: pixel(0, 0, 1, 1),
                cut_left: 99,
                cut_top: 99,
            })
        );
        assert_eq!(rect(-99, -99, 100, 100).whole_on_canvas(1920, 1080), None);
        assert_eq!(
            rect(0, 0, 1920, 1080).whole_on_canvas(1920, 1080),
            Some(pixel(0, 0, 1920, 1080))
        );
    }

    /// Plan 215 E2: a mask belongs to the whole box, so a circle on a box
    /// that hangs off the canvas is centred where the box is centred (off
    /// the canvas too), and the canvas edge cuts the circle. Squashing the
    /// box onto the canvas would have drawn a smaller circle in the corner.
    #[test]
    fn masks_keep_their_geometry_on_a_box_that_hangs_off_the_canvas() {
        let hanging = SignedPixelRect {
            x: -100,
            y: -100,
            width: 200,
            height: 200,
        };
        let circle = circle_geometry(hanging);
        assert_eq!(
            (circle.center_x, circle.center_y, circle.radius),
            (0.0, 0.0, 100.0)
        );
        let tester = SceneMaskTester::new(SceneMask::Circle, hanging);
        // Inside the quarter of the circle that is on the canvas...
        assert!(tester.allows(10, 10));
        assert!(tester.allows(70, 70));
        // ...and outside it, still on the canvas and still inside the box.
        assert!(!tester.allows(90, 90));
        assert!(!tester.allows(99, 50));
        // The same box as an on-canvas rect gives the same f64s.
        let on_canvas = PixelRect {
            x: 40,
            y: 60,
            width: 200,
            height: 200,
        };
        assert_eq!(
            circle_geometry(on_canvas),
            circle_geometry(SignedPixelRect::from(on_canvas))
        );
        assert_eq!(
            rounded_rect_geometry(on_canvas, 24),
            rounded_rect_geometry(SignedPixelRect::from(on_canvas), 24)
        );
        let corners = rounded_rect_geometry(hanging, 50);
        assert_eq!(
            (corners.center_x, corners.center_y, corners.radius),
            (0.0, 0.0, 100.0)
        );
    }

    #[test]
    fn side_by_side_table_tiles_1080p_and_4k() {
        let cases = [
            (1920, SideBySideSplit::Even, (960, 960)),
            (1920, SideBySideSplit::SixtyForty, (1152, 768)),
            (1920, SideBySideSplit::SeventyThirty, (1344, 576)),
            (3840, SideBySideSplit::Even, (1920, 1920)),
            (3840, SideBySideSplit::SixtyForty, (2304, 1536)),
            (3840, SideBySideSplit::SeventyThirty, (2688, 1152)),
        ];
        for (width, split, expected) in cases {
            assert_eq!(side_by_side_widths(split, width), expected);
        }
        let _ = SideBySideCameraSide::Right;
    }

    #[test]
    fn circle_and_rounded_masks_share_short_side_geometry() {
        let rect = PixelRect {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        };
        assert_eq!(circle_geometry(rect).radius, 50.0);
        let rounded = rounded_rect_geometry(rect, 20);
        assert_eq!(rounded.radius, 20.0);
        assert_eq!(rounded.inner_half_width, 80.0);
        assert_eq!(rounded.inner_half_height, 30.0);
        assert!(scene_mask_allows(SceneMask::Circle, rect, 100, 50));
        assert!(!scene_mask_allows(SceneMask::Circle, rect, 0, 50));
        assert!(!scene_mask_allows(
            SceneMask::Rounded { radius_pct: 20 },
            rect,
            0,
            0
        ));
        assert!(scene_mask_allows(
            SceneMask::Rounded { radius_pct: 20 },
            rect,
            100,
            0
        ));
    }

    /// The pre-plan-191 body of `scene_mask_allows`, verbatim: geometry
    /// rebuilt on every call. The frozen oracle for `SceneMaskTester`.
    fn scene_mask_allows_before_plan_191(
        mask: SceneMask,
        rect: PixelRect,
        x: usize,
        y: usize,
    ) -> bool {
        match mask {
            SceneMask::None => true,
            SceneMask::Circle => {
                let geometry = circle_geometry(rect);
                if geometry.radius <= 0.0 {
                    return false;
                }
                let dx = x as f64 + 0.5 - geometry.center_x;
                let dy = y as f64 + 0.5 - geometry.center_y;
                dx * dx + dy * dy <= geometry.radius * geometry.radius
            }
            SceneMask::Rounded { radius_pct } => {
                let geometry = rounded_rect_geometry(rect, radius_pct);
                if geometry.radius <= 0.0 {
                    return true;
                }
                let qx = ((x as f64 + 0.5 - geometry.center_x).abs() - geometry.inner_half_width)
                    .max(0.0);
                let qy = ((y as f64 + 0.5 - geometry.center_y).abs() - geometry.inner_half_height)
                    .max(0.0);
                qx * qx + qy * qy <= geometry.radius * geometry.radius
            }
        }
    }

    #[test]
    fn scene_mask_tester_matches_the_per_pixel_rule_at_every_pixel_around_the_rect() {
        let pixel_rect = |x, y, width, height| PixelRect {
            x,
            y,
            width,
            height,
        };
        let rects = [
            pixel_rect(0, 0, 1, 1),
            pixel_rect(3, 2, 1, 1),
            pixel_rect(0, 0, 2, 2),
            pixel_rect(5, 7, 3, 3),
            pixel_rect(4, 9, 2, 5),
            pixel_rect(10, 4, 17, 9),
            pixel_rect(2, 3, 9, 31),
            pixel_rect(6, 6, 64, 64),
            pixel_rect(0, 0, 200, 100),
            pixel_rect(37, 21, 101, 57),
            // An odd camera bubble at a 1080p canvas offset.
            pixel_rect(1617, 853, 261, 147),
            // Degenerate rects: zero radius on both mask kinds.
            pixel_rect(4, 4, 0, 5),
            pixel_rect(4, 4, 6, 0),
        ];
        let masks = [
            SceneMask::None,
            SceneMask::Circle,
            SceneMask::Rounded { radius_pct: 0 },
            SceneMask::Rounded { radius_pct: 1 },
            SceneMask::Rounded { radius_pct: 12 },
            SceneMask::Rounded { radius_pct: 20 },
            SceneMask::Rounded { radius_pct: 33 },
            SceneMask::Rounded { radius_pct: 50 },
            // Clamped to 50.
            SceneMask::Rounded { radius_pct: 80 },
        ];
        let (mut allowed, mut rejected) = (0_usize, 0_usize);
        for rect in rects {
            for mask in masks {
                let tester = SceneMaskTester::new(mask, rect);
                // The rect's bounding box plus a 2-pixel margin on every side
                // (clamped at the canvas origin).
                let xs =
                    (rect.x as usize).saturating_sub(2)..rect.x as usize + rect.width as usize + 2;
                let ys =
                    (rect.y as usize).saturating_sub(2)..rect.y as usize + rect.height as usize + 2;
                for y in ys {
                    for x in xs.clone() {
                        let expected = scene_mask_allows_before_plan_191(mask, rect, x, y);
                        assert_eq!(
                            tester.allows(x, y),
                            expected,
                            "{mask:?} on {rect:?} at ({x}, {y})"
                        );
                        assert_eq!(
                            scene_mask_allows(mask, rect, x, y),
                            expected,
                            "scene_mask_allows: {mask:?} on {rect:?} at ({x}, {y})"
                        );
                        if expected {
                            allowed += 1;
                        } else {
                            rejected += 1;
                        }
                    }
                }
            }
        }
        // Both outcomes were exercised, not only one side of the edge.
        assert!(
            allowed > 0 && rejected > 0,
            "{allowed} allowed, {rejected} rejected"
        );
    }
}

/// Plan 213 G1: the one cropped-screen fixture every render path draws (CPU,
/// Metal, the FFmpeg legacy graph and the aux leg), so a crop that one path
/// ignores shows up as a wrong colour at a known point.
#[cfg(test)]
pub(crate) mod screen_crop_fixture {
    use crate::protocol::SceneTransform;

    pub const SOURCE_WIDTH: u32 = 64;
    pub const SOURCE_HEIGHT: u32 = 36;

    pub const RED: [u8; 3] = [255, 0, 0];
    pub const GREEN: [u8; 3] = [0, 255, 0];
    pub const BLUE: [u8; 3] = [0, 0, 255];
    pub const WHITE: [u8; 3] = [255, 255, 255];
    pub const MAGENTA: [u8; 3] = [255, 0, 255];
    pub const CYAN: [u8; 3] = [0, 255, 255];
    pub const BLACK: [u8; 3] = [0, 0, 0];

    /// The screen picture as RGB: four 16 px columns (red, green, blue,
    /// white) between a magenta band on top and a cyan band at the bottom,
    /// 9 rows each.
    pub fn source_rgb(x: u32, y: u32) -> [u8; 3] {
        if y < 9 {
            MAGENTA
        } else if y >= SOURCE_HEIGHT - 9 {
            CYAN
        } else {
            [RED, GREEN, BLUE, WHITE][(x / 16) as usize]
        }
    }

    pub fn source_bgra() -> Vec<u8> {
        (0..SOURCE_HEIGHT)
            .flat_map(|y| (0..SOURCE_WIDTH).map(move |x| (x, y)))
            .flat_map(|(x, y)| {
                let [r, g, b] = source_rgb(x, y);
                [b, g, r, 255]
            })
            .collect()
    }

    /// A box in the middle half of the canvas with a quarter cropped off
    /// every side. What is left is the green and blue columns, 32×18: the
    /// box's own 16:9, so Fit fills the box exactly.
    pub fn transform() -> SceneTransform {
        SceneTransform {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            crop_left: 0.25,
            crop_top: 0.25,
            crop_right: 0.25,
            crop_bottom: 0.25,
        }
    }

    /// Canvas points (fractions, so any canvas size) and the colour each
    /// shows. Without the crop the four points next to the box's edges would
    /// show red, magenta, cyan and white instead.
    pub fn expected_samples() -> [((f64, f64), [u8; 3]); 7] {
        [
            ((0.30, 0.50), GREEN),
            ((0.45, 0.30), GREEN),
            ((0.45, 0.70), GREEN),
            ((0.55, 0.50), BLUE),
            ((0.70, 0.50), BLUE),
            ((0.10, 0.10), BLACK),
            ((0.90, 0.90), BLACK),
        ]
    }

    /// The sample's pixel on a `width`×`height` canvas.
    pub fn sample_pixel(point: (f64, f64), width: u32, height: u32) -> (usize, usize) {
        (
            (point.0 * f64::from(width)).floor() as usize,
            (point.1 * f64::from(height)).floor() as usize,
        )
    }
}

/// Plan 215 E2 (D2): the one bigger-than-canvas fixture every render path
/// draws (CPU, Metal, the FFmpeg legacy graph, the aux leg and the D3D11
/// planner): the crop fixture's screen picture, uncropped, in a 150% box
/// with a quarter of it past every canvas edge. Cut, each visible stripe is
/// three times its source width and the outer stripes are half off the
/// canvas; squashed onto the canvas, the whole picture would show at twice
/// its width, so the two differ at the points below.
#[cfg(test)]
pub(crate) mod screen_beyond_canvas_fixture {
    use super::screen_crop_fixture::{BLUE, CYAN, GREEN, MAGENTA, RED, WHITE};
    use crate::protocol::SceneTransform;

    /// A 16:9 box (so Fit fills it exactly on a 16:9 canvas) at 150% of the
    /// canvas, centred: 25% hangs off every edge.
    pub fn transform() -> SceneTransform {
        SceneTransform {
            x: -0.25,
            y: -0.25,
            width: 1.5,
            height: 1.5,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        }
    }

    /// Canvas points (fractions, so any 16:9 canvas) and the colour each
    /// shows when the box is cut at the edge. With the box squashed onto the
    /// canvas instead, the first four points would show red, white, magenta
    /// and cyan. Every point sits mid-stripe: x 0.5 lands on the green/blue
    /// column edge (source x 32), where the bilinear paths (Metal, the aux
    /// leg, FFmpeg) rightly blend, so the vertical probes use x 0.6875, the
    /// middle of the blue column (source x 40).
    pub fn expected_samples() -> [((f64, f64), [u8; 3]); 8] {
        [
            ((0.20, 0.50), GREEN),
            ((0.80, 0.50), BLUE),
            ((0.6875, 0.18), BLUE),
            ((0.6875, 0.82), BLUE),
            ((0.05, 0.50), RED),
            ((0.95, 0.50), WHITE),
            ((0.50, 0.05), MAGENTA),
            ((0.50, 0.95), CYAN),
        ]
    }
}
