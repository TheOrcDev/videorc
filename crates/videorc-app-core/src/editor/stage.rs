//! Plan 220 S3.3b: the Scene stage's pure maths, ported from the renderer's
//! `components/scene/stage-transform.ts`, `stage-gesture.ts`,
//! `stage-corner.ts`, `stage-nudge.ts`, `stage-undo-control.ts`,
//! `stage-viewport.ts`, the pure half of `overlay-stage.ts` and the shared
//! `scene-picture-geometry.ts` / `native-preview-proof-geometry.ts`.
//!
//! Every rect is in canvas fractions (0..1 of the output), as the scene's
//! transforms are. The stage draws and edits the PICTURE a source shows
//! (plan 216 B3: its frame on the background's stage margin, and on Fit the
//! picture's own box inside it) and commits the FRAME that picture maps back
//! to. A gesture never writes scene state: it yields a ghost and, once
//! released, one commit through the backend (`scene.source.transform.update`
//! with `snap: none`); [`StageEdits`] holds the released rect on screen until
//! the committed scene shows it.
//!
//! Two things have no renderer twin, because the DOM did them: [`stage_hit`]
//! (what a press lands on, in the SVG's z-order and hit areas) and
//! [`DraftChannel`] (the editor draft's latest-wins wire as a state machine
//! the app drives with the clock, `lib/editor-draft-channel.ts`).

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use videorc_protocol::{SceneSourceKind, SceneTransform};

/// JavaScript's `Math.round` (half up, also below zero).
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn round4(value: f64) -> f64 {
    js_round(value * 10_000.0) / 10_000.0
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

// --- stage-transform.ts ---

/// A box in canvas fractions.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StageRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl StageRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// A scene transform's box.
    pub fn of(transform: &SceneTransform) -> Self {
        Self::new(transform.x, transform.y, transform.width, transform.height)
    }

    /// The four fields as JSON (`{x, y, width, height}`).
    pub fn json(&self) -> Value {
        json!({ "x": self.x, "y": self.y, "width": self.width, "height": self.height })
    }
}

/// The eight resize handles, by compass position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HandleId {
    Nw,
    N,
    Ne,
    E,
    Se,
    S,
    Sw,
    W,
}

impl HandleId {
    /// `STAGE_HANDLE_IDS`, in the renderer's order.
    pub const ALL: [HandleId; 8] = [
        HandleId::Nw,
        HandleId::N,
        HandleId::Ne,
        HandleId::E,
        HandleId::Se,
        HandleId::S,
        HandleId::Sw,
        HandleId::W,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HandleId::Nw => "nw",
            HandleId::N => "n",
            HandleId::Ne => "ne",
            HandleId::E => "e",
            HandleId::Se => "se",
            HandleId::S => "s",
            HandleId::Sw => "sw",
            HandleId::W => "w",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|handle| handle.as_str() == text)
    }

    fn west(self) -> bool {
        matches!(self, HandleId::Nw | HandleId::W | HandleId::Sw)
    }

    fn east(self) -> bool {
        matches!(self, HandleId::Ne | HandleId::E | HandleId::Se)
    }

    fn north(self) -> bool {
        matches!(self, HandleId::Nw | HandleId::N | HandleId::Ne)
    }

    fn south(self) -> bool {
        matches!(self, HandleId::Sw | HandleId::S | HandleId::Se)
    }

    /// `handleCursor`: the resize cursor's name.
    pub fn cursor(self) -> &'static str {
        match self {
            HandleId::Nw | HandleId::Se => "nwse-resize",
            HandleId::Ne | HandleId::Sw => "nesw-resize",
            HandleId::N | HandleId::S => "ns-resize",
            HandleId::E | HandleId::W => "ew-resize",
        }
    }
}

/// The legacy stateless snap's reach (the backend's `SNAP_THRESHOLD`).
pub const STAGE_SNAP_THRESHOLD: f64 = 0.015;
/// The smallest share of the canvas a resize may leave per axis.
pub const MIN_SOURCE_FRACTION: f64 = 0.05;
/// Plan 215 E3 (D2): up to 400% of the canvas, placed from three canvases
/// left or above to four right or below.
pub const MAX_SOURCE_FRACTION: f64 = 4.0;
pub const MIN_SOURCE_POSITION: f64 = -3.0;
pub const MAX_SOURCE_POSITION: f64 = 4.0;
/// The least of the picture a crop leaves per axis.
pub const MIN_CROP_KEPT: f64 = 0.05;

/// `clampSourcePosition`: anywhere, as long as 5% of the canvas stays
/// covered and the protocol's position bounds hold.
pub fn clamp_source_position(position: f64, size: f64) -> f64 {
    let kept = size.clamp(0.0, MIN_SOURCE_FRACTION);
    let low = MIN_SOURCE_POSITION.max(kept - size);
    let high = MAX_SOURCE_POSITION.min(1.0 - kept);
    clamp(position, low, low.max(high))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

impl Axis {
    pub fn as_str(self) -> &'static str {
        match self {
            Axis::X => "x",
            Axis::Y => "y",
        }
    }
}

/// A snap guide across the canvas.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapGuide {
    pub axis: Axis,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SnapTargets {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ghost {
    pub rect: StageRect,
    pub guides: Vec<SnapGuide>,
}

fn push_unique(list: &mut Vec<f64>, value: f64) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// `stageSnapTargets`: the canvas's edges and centre lines, and every other
/// box's edges and centres.
pub fn stage_snap_targets(others: &[StageRect]) -> SnapTargets {
    let mut x = vec![0.0, 0.5, 1.0];
    let mut y = vec![0.0, 0.5, 1.0];
    for rect in others {
        push_unique(&mut x, rect.x);
        push_unique(&mut x, rect.x + rect.width / 2.0);
        push_unique(&mut x, rect.x + rect.width);
        push_unique(&mut y, rect.y);
        push_unique(&mut y, rect.y + rect.height / 2.0);
        push_unique(&mut y, rect.y + rect.height);
    }
    SnapTargets { x, y }
}

/// `MoveInput`.
#[derive(Debug, Clone)]
pub struct MoveInput<'a> {
    pub start: StageRect,
    pub dx: f64,
    pub dy: f64,
    pub constrain_axis: bool,
    pub disable_snap: bool,
    pub targets: &'a SnapTargets,
}

/// `moveGhost`: 5% of the canvas stays covered, then the legacy magnet.
pub fn move_ghost(input: MoveInput<'_>) -> Ghost {
    let mut dx = input.dx;
    let mut dy = input.dy;
    if input.constrain_axis {
        if dx.abs() >= dy.abs() {
            dy = 0.0;
        } else {
            dx = 0.0;
        }
    }
    let mut x = clamp_source_position(input.start.x + dx, input.start.width);
    let mut y = clamp_source_position(input.start.y + dy, input.start.height);
    let mut guides = Vec::new();
    if !input.disable_snap {
        if let Some((position, target)) = snap_axis(x, input.start.width, &input.targets.x) {
            x = clamp_source_position(position, input.start.width);
            guides.push(SnapGuide {
                axis: Axis::X,
                position: target,
            });
        }
        if let Some((position, target)) = snap_axis(y, input.start.height, &input.targets.y) {
            y = clamp_source_position(position, input.start.height);
            guides.push(SnapGuide {
                axis: Axis::Y,
                position: target,
            });
        }
    }
    Ghost {
        rect: StageRect {
            x,
            y,
            ..input.start
        },
        guides,
    }
}

/// `ResizeInput`.
#[derive(Debug, Clone, Copy)]
pub struct ResizeInput {
    pub start: StageRect,
    pub handle: HandleId,
    pub dx: f64,
    pub dy: f64,
    pub lock_aspect: bool,
    /// The painted canvas in points (the projection is in screen space).
    pub canvas_width: Option<f64>,
    pub canvas_height: Option<f64>,
    pub min_fraction: Option<f64>,
}

/// `resizeGhost`: the named edges follow the pointer, the opposite edge (or
/// centre line) anchors; no snapping.
pub fn resize_ghost(input: ResizeInput) -> Ghost {
    let min = input.min_fraction.unwrap_or(MIN_SOURCE_FRACTION);
    let start = input.start;
    let moves_left = input.handle.west();
    let moves_right = input.handle.east();
    let moves_top = input.handle.north();
    let moves_bottom = input.handle.south();
    let is_corner = (moves_left || moves_right) && (moves_top || moves_bottom);
    let left = start.x;
    let top = start.y;
    let right = start.right();
    let bottom = start.bottom();

    if input.lock_aspect {
        let width_delta = if moves_left {
            -input.dx
        } else if moves_right {
            input.dx
        } else {
            0.0
        };
        let height_delta = if moves_top {
            -input.dy
        } else if moves_bottom {
            input.dy
        } else {
            0.0
        };
        let scale_from_width = if start.width > 0.0 {
            (start.width + width_delta) / start.width
        } else {
            1.0
        };
        let scale_from_height = if start.height > 0.0 {
            (start.height + height_delta) / start.height
        } else {
            1.0
        };
        let mut scale = if is_corner {
            let vx = start.width * input.canvas_width.unwrap_or(1.0);
            let vy = start.height * input.canvas_height.unwrap_or(1.0);
            let length_squared = vx * vx + vy * vy;
            if length_squared > 0.0 {
                (scale_from_width * vx * vx + scale_from_height * vy * vy) / length_squared
            } else {
                1.0
            }
        } else if moves_left || moves_right {
            scale_from_width
        } else {
            scale_from_height
        };
        let anchor_x = if moves_left {
            right
        } else if moves_right {
            left
        } else {
            (left + right) / 2.0
        };
        let anchor_y = if moves_top {
            bottom
        } else if moves_bottom {
            top
        } else {
            (top + bottom) / 2.0
        };
        let available_width = MAX_SOURCE_FRACTION.min(if moves_left {
            anchor_x - MIN_SOURCE_POSITION
        } else if moves_right {
            MAX_SOURCE_FRACTION
        } else {
            available_centered(anchor_x)
        });
        let available_height = MAX_SOURCE_FRACTION.min(if moves_top {
            anchor_y - MIN_SOURCE_POSITION
        } else if moves_bottom {
            MAX_SOURCE_FRACTION
        } else {
            available_centered(anchor_y)
        });
        let ratio = |available: f64, size: f64| if size > 0.0 { available / size } else { 1.0 };
        let max_scale =
            ratio(available_width, start.width).min(ratio(available_height, start.height));
        let min_scale = ratio(min, start.width).max(ratio(min, start.height));
        scale = scale.max(min_scale).min(max_scale.max(min_scale));
        let width = start.width * scale;
        let height = start.height * scale;
        let x = if moves_left {
            anchor_x - width
        } else if moves_right {
            anchor_x
        } else {
            anchor_x - width / 2.0
        };
        let y = if moves_top {
            anchor_y - height
        } else if moves_bottom {
            anchor_y
        } else {
            anchor_y - height / 2.0
        };
        return Ghost {
            rect: clamp_rect(StageRect::new(x, y, width, height)),
            guides: Vec::new(),
        };
    }

    let new_left = if moves_left {
        clamp(
            left + input.dx,
            MIN_SOURCE_POSITION.max(right - MAX_SOURCE_FRACTION),
            (right - min).min(1.0 - MIN_SOURCE_FRACTION),
        )
    } else {
        left
    };
    let new_right = if moves_right {
        clamp(
            right + input.dx,
            (left + min).max(MIN_SOURCE_FRACTION),
            left + MAX_SOURCE_FRACTION,
        )
    } else {
        right
    };
    let new_top = if moves_top {
        clamp(
            top + input.dy,
            MIN_SOURCE_POSITION.max(bottom - MAX_SOURCE_FRACTION),
            (bottom - min).min(1.0 - MIN_SOURCE_FRACTION),
        )
    } else {
        top
    };
    let new_bottom = if moves_bottom {
        clamp(
            bottom + input.dy,
            (top + min).max(MIN_SOURCE_FRACTION),
            top + MAX_SOURCE_FRACTION,
        )
    } else {
        bottom
    };
    Ghost {
        rect: clamp_rect(StageRect::new(
            new_left,
            new_top,
            new_right - new_left,
            new_bottom - new_top,
        )),
        guides: Vec::new(),
    }
}

/// A screen's crop, as shares of its own picture.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StageCrop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl StageCrop {
    /// The crop as the wire's fields.
    pub fn json(&self) -> Value {
        json!({
            "cropLeft": self.left,
            "cropTop": self.top,
            "cropRight": self.right,
            "cropBottom": self.bottom,
        })
    }
}

/// `stageCropOf`.
pub fn stage_crop_of(transform: &SceneTransform) -> StageCrop {
    StageCrop {
        left: transform.crop_left,
        top: transform.crop_top,
        right: transform.crop_right,
        bottom: transform.crop_bottom,
    }
}

/// `CropInput`.
#[derive(Debug, Clone, Copy)]
pub struct CropInput {
    pub start: StageRect,
    pub crop: StageCrop,
    pub handle: HandleId,
    pub dx: f64,
    pub dy: f64,
    pub min_fraction: Option<f64>,
}

/// `cropGhost` (plan 213 G2): ⌥ on an edge cuts the picture where the edge
/// moves, so what stays on screen neither moves nor scales.
pub fn crop_ghost(input: CropInput) -> (Ghost, StageCrop) {
    let min = input.min_fraction.unwrap_or(MIN_SOURCE_FRACTION);
    let start = input.start;
    let mut crop = input.crop;
    let StageRect {
        mut x,
        mut y,
        mut width,
        mut height,
    } = start;
    let kept_x = 1.0 - crop.left - crop.right;
    let kept_y = 1.0 - crop.top - crop.bottom;
    let per_x = if start.width > 0.0 {
        kept_x / start.width
    } else {
        0.0
    };
    let per_y = if start.height > 0.0 {
        kept_y / start.height
    } else {
        0.0
    };
    let travel =
        |delta: f64, outward: f64, inward: f64| clamp(delta, -outward, (-outward).max(inward));
    if per_x > 0.0 && input.handle.west() {
        let moved = travel(
            input.dx,
            (crop.left / per_x).min(x - MIN_SOURCE_POSITION),
            ((kept_x - MIN_CROP_KEPT) / per_x).min(width - min),
        );
        x += moved;
        width -= moved;
        crop.left += moved * per_x;
    } else if per_x > 0.0 && input.handle.east() {
        let moved = -travel(
            -input.dx,
            (crop.right / per_x).min(MAX_SOURCE_POSITION - (x + width)),
            ((kept_x - MIN_CROP_KEPT) / per_x).min(width - min),
        );
        width += moved;
        crop.right -= moved * per_x;
    }
    if per_y > 0.0 && input.handle.north() {
        let moved = travel(
            input.dy,
            (crop.top / per_y).min(y - MIN_SOURCE_POSITION),
            ((kept_y - MIN_CROP_KEPT) / per_y).min(height - min),
        );
        y += moved;
        height -= moved;
        crop.top += moved * per_y;
    } else if per_y > 0.0 && input.handle.south() {
        let moved = -travel(
            -input.dy,
            (crop.bottom / per_y).min(MAX_SOURCE_POSITION - (y + height)),
            ((kept_y - MIN_CROP_KEPT) / per_y).min(height - min),
        );
        height += moved;
        crop.bottom -= moved * per_y;
    }
    let side = |value: f64| clamp(value, 0.0, 0.95);
    (
        Ghost {
            rect: StageRect::new(x, y, width, height),
            guides: Vec::new(),
        },
        StageCrop {
            left: side(crop.left),
            top: side(crop.top),
            right: side(crop.right),
            bottom: side(crop.bottom),
        },
    )
}

/// `roundCropForCommit`.
pub fn round_crop_for_commit(crop: StageCrop) -> StageCrop {
    StageCrop {
        left: round4(crop.left),
        top: round4(crop.top),
        right: round4(crop.right),
        bottom: round4(crop.bottom),
    }
}

/// `roundRectForCommit`: four decimals (0.01% of the canvas).
pub fn round_rect_for_commit(rect: StageRect) -> StageRect {
    StageRect::new(
        round4(rect.x),
        round4(rect.y),
        round4(rect.width),
        round4(rect.height),
    )
}

/// `stageHandlePoints`: each handle's anchor on the box.
pub fn stage_handle_points(rect: StageRect) -> [(HandleId, f64, f64); 8] {
    let cx = rect.x + rect.width / 2.0;
    let cy = rect.y + rect.height / 2.0;
    let right = rect.right();
    let bottom = rect.bottom();
    [
        (HandleId::Nw, rect.x, rect.y),
        (HandleId::N, cx, rect.y),
        (HandleId::Ne, right, rect.y),
        (HandleId::E, right, cy),
        (HandleId::Se, right, bottom),
        (HandleId::S, cx, bottom),
        (HandleId::Sw, rect.x, bottom),
        (HandleId::W, rect.x, cy),
    ]
}

fn snap_axis(position: f64, size: f64, targets: &[f64]) -> Option<(f64, f64)> {
    let candidates: [(f64, f64); 3] = [
        (position, 0.0),
        (position + size / 2.0, size / 2.0),
        (position + size, size),
    ];
    let mut best: Option<(f64, f64, f64)> = None;
    for &target in targets {
        for (edge, offset) in candidates {
            let distance = (edge - target).abs();
            if distance <= STAGE_SNAP_THRESHOLD && best.is_none_or(|(_, _, d)| distance < d) {
                best = Some((target - offset, target, distance));
            }
        }
    }
    best.map(|(position, target, _)| (position, target))
}

fn available_centered(center: f64) -> f64 {
    ((center - MIN_SOURCE_POSITION) * 2.0).max(0.0)
}

fn clamp_rect(rect: StageRect) -> StageRect {
    let width = clamp(rect.width, 0.0, MAX_SOURCE_FRACTION);
    let height = clamp(rect.height, 0.0, MAX_SOURCE_FRACTION);
    StageRect::new(
        clamp_source_position(rect.x, width),
        clamp_source_position(rect.y, height),
        width,
        height,
    )
}

/// The camera's mask on the stage (`stageSourceShape`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SourceShape {
    Circle {
        cx: f64,
        cy: f64,
        r: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rx: f64,
    },
}

/// `stageSourceShape`: the compositor's mask in canvas units (`shape` is
/// `circle`, `rounded` or anything else for a rectangle).
pub fn stage_source_shape(
    rect: StageRect,
    canvas_width: f64,
    canvas_height: f64,
    shape: &str,
    corner_radius_pct: f64,
) -> SourceShape {
    let x = rect.x * canvas_width;
    let y = rect.y * canvas_height;
    let width = rect.width * canvas_width;
    let height = rect.height * canvas_height;
    if shape == "circle" {
        return SourceShape::Circle {
            cx: x + width / 2.0,
            cy: y + height / 2.0,
            r: width.min(height) / 2.0,
        };
    }
    SourceShape::Rect {
        x,
        y,
        width,
        height,
        rx: if shape == "rounded" {
            width.min(height) * clamp(corner_radius_pct, 0.0, 50.0) / 100.0
        } else {
            0.0
        },
    }
}

// --- stage-gesture.ts ---

/// A magnet catches the box this close (points)...
const SNAP_ACQUIRE_PX: f64 = 5.0;
/// ...and lets go once the pointer pulls this far.
const SNAP_RELEASE_PX: f64 = 9.0;

#[derive(Debug, Clone, Copy)]
struct Magnet {
    target: f64,
    edge: f64,
}

/// Per-axis magnet ownership (`SnapAxis`).
#[derive(Debug, Clone)]
struct SnapAxis {
    magnet: Option<Magnet>,
    offset: f64,
    released_at: Option<f64>,
    enabled: bool,
    last: f64,
}

impl SnapAxis {
    fn new(position: f64, enabled: bool) -> Self {
        Self {
            magnet: None,
            offset: 0.0,
            released_at: None,
            enabled,
            last: position,
        }
    }

    fn update(
        &mut self,
        raw: f64,
        size: f64,
        pixels: f64,
        targets: &[f64],
        enabled: bool,
    ) -> (f64, Option<f64>) {
        if enabled != self.enabled {
            self.offset = self.last - raw;
            self.released_at = self.magnet.map(|_| self.last);
            self.magnet = None;
            self.enabled = enabled;
        }
        let mut position = raw + self.offset;
        if enabled && let Some(magnet) = self.magnet {
            let fixed = magnet.target - magnet.edge * size;
            if (position - fixed).abs() * pixels <= SNAP_RELEASE_PX {
                self.last = fixed;
                return (fixed, Some(magnet.target));
            }
            self.offset = self.last - raw;
            position = self.last;
            self.released_at = Some(self.last);
            self.magnet = None;
            return (position, None);
        }
        if enabled {
            if let Some(released) = self.released_at
                && (position - released).abs() * pixels > SNAP_RELEASE_PX + SNAP_ACQUIRE_PX
            {
                self.released_at = None;
            }
            let released_at = self.released_at;
            let mut best: Option<(Magnet, f64)> = None;
            for &target in targets {
                for edge in [0.0, 0.5, 1.0] {
                    let snapped = target - edge * size;
                    if released_at.is_some_and(|released| {
                        (snapped - released).abs() * pixels <= SNAP_RELEASE_PX
                    }) {
                        continue;
                    }
                    let distance = (position - snapped).abs() * pixels;
                    if distance <= SNAP_ACQUIRE_PX && best.is_none_or(|(_, d)| distance < d) {
                        best = Some((Magnet { target, edge }, distance));
                    }
                }
            }
            if let Some((magnet, _)) = best {
                self.magnet = Some(magnet);
                position = magnet.target - magnet.edge * size;
            }
        }
        self.last = position;
        (position, self.magnet.map(|magnet| magnet.target))
    }
}

/// What a gesture does: move the box, or pull one of its handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GestureKind {
    Move,
    Handle(HandleId),
}

impl GestureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GestureKind::Move => "move",
            GestureKind::Handle(handle) => handle.as_str(),
        }
    }
}

/// The keys held during a sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
}

/// A point in canvas fractions.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StagePoint {
    pub x: f64,
    pub y: f64,
}

/// The canvas's painted size in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelSize {
    pub width: f64,
    pub height: f64,
}

/// What a gesture is made with (`new StageGesture(...)`).
#[derive(Debug, Clone)]
pub struct GestureStart {
    pub source_id: String,
    pub kind: GestureKind,
    pub start: StageRect,
    pub point: StagePoint,
    pub pixels: PixelSize,
    pub targets: SnapTargets,
    pub snap: bool,
    /// The inspector's aspect lock (Shift inverts it).
    pub locked: bool,
    /// The aspect is law (a shaped camera, a box that is its picture).
    pub forced: bool,
    /// ⌥ was down on an edge of a croppable source: the gesture crops.
    pub crop: Option<StageCrop>,
}

/// One pointer ownership interval (`StageGesture`); never scene state.
#[derive(Debug, Clone)]
pub struct StageGesture {
    pub source_id: String,
    pub kind: GestureKind,
    pub pixels: PixelSize,
    pub rect: StageRect,
    /// An ⌥-drag crop's crop so far.
    pub crop: Option<StageCrop>,
    origin: StagePoint,
    start: StageRect,
    crop_start: Option<StageCrop>,
    shift: bool,
    axis: Option<Axis>,
    snap_x: SnapAxis,
    snap_y: SnapAxis,
    targets: SnapTargets,
    snap: bool,
    locked: bool,
    forced: bool,
}

impl StageGesture {
    pub fn new(start: GestureStart) -> Self {
        let crop = match start.kind {
            GestureKind::Move => None,
            GestureKind::Handle(_) => start.crop,
        };
        Self {
            source_id: start.source_id,
            kind: start.kind,
            pixels: start.pixels,
            rect: start.start,
            crop,
            origin: start.point,
            start: start.start,
            crop_start: crop,
            shift: false,
            axis: None,
            snap_x: SnapAxis::new(start.start.x, start.snap),
            snap_y: SnapAxis::new(start.start.y, start.snap),
            targets: start.targets,
            snap: start.snap,
            locked: start.locked,
            forced: start.forced,
        }
    }

    pub fn sample(&mut self, point: StagePoint, modifiers: Modifiers) -> Ghost {
        if modifiers.shift != self.shift {
            self.start = self.rect;
            self.crop_start = self.crop;
            self.origin = point;
            self.axis = None;
            self.snap_x = SnapAxis::new(self.rect.x, self.snap && !modifiers.alt);
            self.snap_y = SnapAxis::new(self.rect.y, self.snap && !modifiers.alt);
            self.shift = modifiers.shift;
        }
        let mut dx = point.x - self.origin.x;
        let mut dy = point.y - self.origin.y;
        let result = match self.kind {
            GestureKind::Move => {
                if self.shift {
                    if self.axis.is_none()
                        && (dx * self.pixels.width).hypot(dy * self.pixels.height) >= 3.0
                    {
                        self.axis = Some(
                            if (dx * self.pixels.width).abs() >= (dy * self.pixels.height).abs() {
                                Axis::X
                            } else {
                                Axis::Y
                            },
                        );
                    }
                    if self.axis != Some(Axis::X) {
                        dx = 0.0;
                    }
                    if self.axis != Some(Axis::Y) {
                        dy = 0.0;
                    }
                }
                let raw = move_ghost(MoveInput {
                    start: self.start,
                    dx,
                    dy,
                    constrain_axis: false,
                    disable_snap: true,
                    targets: &self.targets,
                })
                .rect;
                let enabled = self.snap && !modifiers.alt;
                let (x, x_target) = self.snap_x.update(
                    raw.x,
                    raw.width,
                    self.pixels.width,
                    &self.targets.x,
                    enabled,
                );
                let (y, y_target) = self.snap_y.update(
                    raw.y,
                    raw.height,
                    self.pixels.height,
                    &self.targets.y,
                    enabled,
                );
                let mut result = move_ghost(MoveInput {
                    start: raw,
                    dx: x - raw.x,
                    dy: y - raw.y,
                    constrain_axis: false,
                    disable_snap: true,
                    targets: &self.targets,
                });
                if let Some(target) = x_target
                    && result.rect.x == x
                {
                    result.guides.push(SnapGuide {
                        axis: Axis::X,
                        position: target,
                    });
                }
                if let Some(target) = y_target
                    && result.rect.y == y
                {
                    result.guides.push(SnapGuide {
                        axis: Axis::Y,
                        position: target,
                    });
                }
                result
            }
            GestureKind::Handle(handle) => match self.crop_start {
                Some(crop) => {
                    let (ghost, cropped) = crop_ghost(CropInput {
                        start: self.start,
                        crop,
                        handle,
                        dx,
                        dy,
                        min_fraction: None,
                    });
                    self.crop = Some(cropped);
                    ghost
                }
                None => resize_ghost(ResizeInput {
                    start: self.start,
                    handle,
                    dx,
                    dy,
                    lock_aspect: self.forced
                        || if self.shift {
                            !self.locked
                        } else {
                            self.locked
                        },
                    canvas_width: Some(self.pixels.width),
                    canvas_height: Some(self.pixels.height),
                    min_fraction: None,
                }),
            },
        };
        self.rect = result.rect;
        result
    }
}

/// `sameStageRect`.
pub fn same_stage_rect(a: StageRect, b: StageRect) -> bool {
    (a.x - b.x).abs() < 0.000_001
        && (a.y - b.y).abs() < 0.000_001
        && (a.width - b.width).abs() < 0.000_001
        && (a.height - b.height).abs() < 0.000_001
}

/// `visibleStageHandles`: edge handles go before the corners; a tiny box
/// has one unambiguous target.
pub fn visible_stage_handles(width: f64, height: f64) -> &'static [HandleId] {
    if width < 24.0 || height < 24.0 {
        &[HandleId::Se]
    } else if width < 48.0 || height < 48.0 {
        &[HandleId::Nw, HandleId::Ne, HandleId::Se, HandleId::Sw]
    } else {
        &HandleId::ALL
    }
}

/// `stageHandleOffset`: a tiny box keeps a body target apart from its grip.
pub fn stage_handle_offset(width: f64, height: f64) -> f64 {
    if width < 24.0 || height < 24.0 {
        12.0
    } else {
        0.0
    }
}

/// A released gesture shown until its commit lands (`StageDraft`).
#[derive(Debug, Clone, PartialEq)]
pub struct StageDraft {
    pub source_id: String,
    pub rect: StageRect,
    pub crop: Option<StageCrop>,
    pub generation: u64,
}

/// One released gesture's commit, for the app to send and settle.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitTicket {
    pub source_id: String,
    pub rect: StageRect,
    pub crop: Option<StageCrop>,
    pub generation: u64,
    epoch: u64,
    scene_id: Option<String>,
}

impl CommitTicket {
    /// The patch `scene.source.transform.update` carries.
    pub fn patch(&self) -> Value {
        let mut patch = self.rect.json();
        if let (Some(crop), Value::Object(map)) = (self.crop, &mut patch)
            && let Value::Object(fields) = crop.json()
        {
            map.extend(fields);
        }
        patch
    }
}

/// What the backend's commit said, as far as the stage reads it: whether it
/// applied, and the committed scene's id and each source's box.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitOutcome {
    pub applied: bool,
    pub scene_id: String,
    pub sources: Vec<(String, StageRect)>,
}

/// How a settled commit ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    /// The scene took it: the draft stays until the scene shows it.
    Acknowledged,
    /// Refused or lost: the draft is gone and the gesture is cancelled.
    Failed,
    /// A newer scene or selection replaced it: nothing to do.
    Stale,
}

/// `StageEdits`: serialises released gestures and keeps each one on screen
/// until the committed scene catches up. The app sends one ticket at a time
/// (the renderer's promise tail) and settles it with the backend's answer.
#[derive(Debug, Clone, Default)]
pub struct StageEdits {
    pub draft: Option<StageDraft>,
    generation: u64,
    epoch: u64,
    acknowledged: Option<(u64, CommitOutcome)>,
    canonical: Option<CommitOutcome>,
}

impl StageEdits {
    /// The scene changed (an echo, another window's edit): a draft its
    /// committed box shows is done. Answers whether the draft went.
    pub fn observe(&mut self, scene: Option<CommitOutcome>) -> bool {
        self.canonical = scene;
        let done = match (&self.acknowledged, &self.draft, &self.canonical) {
            (Some((generation, ack)), Some(draft), Some(scene)) => {
                *generation == draft.generation
                    && scene.scene_id == ack.scene_id
                    && scene.sources.iter().any(|(id, rect)| {
                        *id == draft.source_id && same_stage_rect(*rect, draft.rect)
                    })
            }
            _ => false,
        };
        if done {
            self.draft = None;
            self.acknowledged = None;
        }
        done
    }

    /// The scene was replaced, editing turned off, the selection moved: the
    /// draft and every queued commit are dropped.
    pub fn invalidate(&mut self) {
        self.epoch += 1;
        self.draft = None;
        self.acknowledged = None;
    }

    /// A release: the rounded rect becomes the draft and its commit.
    pub fn submit(
        &mut self,
        source_id: &str,
        rect: StageRect,
        crop: Option<StageCrop>,
    ) -> CommitTicket {
        self.generation += 1;
        let draft = StageDraft {
            source_id: source_id.to_string(),
            rect: round_rect_for_commit(rect),
            crop: crop.map(round_crop_for_commit),
            generation: self.generation,
        };
        self.draft = Some(draft.clone());
        CommitTicket {
            source_id: draft.source_id,
            rect: draft.rect,
            crop: draft.crop,
            generation: draft.generation,
            epoch: self.epoch,
            scene_id: self.canonical.as_ref().map(|scene| scene.scene_id.clone()),
        }
    }

    /// Whether a ticket is still worth sending (no newer scene replaced it).
    pub fn current(&self, ticket: &CommitTicket) -> bool {
        ticket.epoch == self.epoch
    }

    /// The backend's answer to a ticket (`None`: refused, timed out, gone).
    pub fn settle(&mut self, ticket: &CommitTicket, outcome: Option<CommitOutcome>) -> Settled {
        if ticket.epoch != self.epoch {
            return Settled::Stale;
        }
        let Some(outcome) = outcome.filter(|outcome| {
            outcome.applied
                && ticket
                    .scene_id
                    .as_ref()
                    .is_none_or(|id| *id == outcome.scene_id)
                && outcome
                    .sources
                    .iter()
                    .any(|(id, _)| *id == ticket.source_id)
        }) else {
            self.invalidate();
            return Settled::Failed;
        };
        if let Some(draft) = self.draft.as_mut()
            && draft.generation == ticket.generation
            && let Some((_, rect)) = outcome
                .sources
                .iter()
                .find(|(id, _)| *id == ticket.source_id)
        {
            draft.rect = *rect;
        }
        self.acknowledged = Some((ticket.generation, outcome));
        let canonical = self.canonical.clone();
        self.observe(canonical);
        Settled::Acknowledged
    }
}

// --- stage-corner.ts ---

/// A preset camera corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl CameraCorner {
    pub fn as_str(self) -> &'static str {
        match self {
            CameraCorner::TopLeft => "top-left",
            CameraCorner::TopRight => "top-right",
            CameraCorner::BottomLeft => "bottom-left",
            CameraCorner::BottomRight => "bottom-right",
        }
    }

    fn left(self) -> bool {
        matches!(self, CameraCorner::TopLeft | CameraCorner::BottomLeft)
    }

    fn top(self) -> bool {
        matches!(self, CameraCorner::TopLeft | CameraCorner::TopRight)
    }
}

/// How close to a corner (canvas units, both axes) a move ends in it.
const CORNER_ZONE: f64 = 0.06;

/// `snapCornerOf`: a move that ends in a canvas corner.
pub fn snap_corner_of(rect: StageRect) -> Option<CameraCorner> {
    let left = rect.x <= CORNER_ZONE;
    let right = rect.right() >= 1.0 - CORNER_ZONE;
    let top = rect.y <= CORNER_ZONE;
    let bottom = rect.bottom() >= 1.0 - CORNER_ZONE;
    if !(left || right) || !(top || bottom) {
        return None;
    }
    Some(match (top, left) {
        (true, true) => CameraCorner::TopLeft,
        (true, false) => CameraCorner::TopRight,
        (false, true) => CameraCorner::BottomLeft,
        (false, false) => CameraCorner::BottomRight,
    })
}

const CAMERA_REFERENCE_WIDTH: f64 = 1280.0;
const CAMERA_REFERENCE_HEIGHT: f64 = 720.0;
const CAMERA_MARGIN_MAX: f64 = 160.0;

/// The preset's camera (`PresetCameraLayout`), as the layout names it.
#[derive(Debug, Clone, PartialEq)]
pub struct PresetCameraLayout {
    /// `small`, `medium` or `large`.
    pub size: String,
    /// `circle`, `rounded` or `rectangle`.
    pub shape: String,
    /// `source`, `square` or `portrait`.
    pub aspect: String,
    pub margin: f64,
}

impl PresetCameraLayout {
    /// From the capture config's layout (the renderer's defaults for what
    /// it leaves out).
    pub fn of(layout: &Value) -> Self {
        let text = |key: &str, fallback: &str| {
            layout
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_string()
        };
        Self {
            size: text("cameraSize", "medium"),
            shape: text("cameraShape", "rounded"),
            aspect: text("cameraAspect", "source"),
            margin: layout
                .get("cameraMargin")
                .and_then(Value::as_f64)
                .unwrap_or(32.0),
        }
    }
}

/// `presetCameraCornerRect`: the backend's preset camera box at `corner`
/// (`scene_geometry::preset_camera_transform`), whole pixels and all.
pub fn preset_camera_corner_rect(
    layout: &PresetCameraLayout,
    corner: CameraCorner,
    output_width: f64,
    output_height: f64,
) -> StageRect {
    let width = js_round(output_width).max(1.0);
    let height = js_round(output_height).max(1.0);
    let scale = (width / CAMERA_REFERENCE_WIDTH).min(height / CAMERA_REFERENCE_HEIGHT);
    let scaled = |value: f64| js_round(value * scale).max(1.0);
    let box_width: f64 = match layout.size.as_str() {
        "small" => 260.0,
        "large" => 480.0,
        _ => 360.0,
    };
    let box_height = if layout.shape == "circle" || layout.aspect == "square" {
        box_width
    } else if layout.aspect == "portrait" {
        (box_width * 4.0 / 3.0).ceil()
    } else {
        ((box_width * 9.0 + 8.0) / 16.0).floor()
    };
    let camera_width = scaled(box_width);
    let camera_height = scaled(box_height);
    let margin = scaled(layout.margin.floor().clamp(0.0, CAMERA_MARGIN_MAX));
    let x = if corner.left() {
        margin
    } else {
        (width - camera_width - margin).max(0.0)
    };
    let y = if corner.top() {
        margin
    } else {
        (height - camera_height - margin).max(0.0)
    };
    StageRect::new(
        x / width,
        y / height,
        camera_width / width,
        camera_height / height,
    )
}

// --- stage-nudge.ts ---

/// One arrow's nudge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageNudge {
    pub direction_x: i8,
    pub direction_y: i8,
    pub large: bool,
}

/// The keys the stage reads, by the DOM's names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyChord {
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub ctrl: bool,
}

/// `stageNudgeForKey`: an arrow, Shift for the large step; any other key or
/// chord is not a nudge.
pub fn stage_nudge_for_key(key: &str, chord: KeyChord) -> Option<StageNudge> {
    if chord.alt || chord.meta || chord.ctrl {
        return None;
    }
    let (direction_x, direction_y) = match key {
        "ArrowUp" => (0, -1),
        "ArrowDown" => (0, 1),
        "ArrowLeft" => (-1, 0),
        "ArrowRight" => (1, 0),
        _ => return None,
    };
    Some(StageNudge {
        direction_x,
        direction_y,
        large: chord.shift,
    })
}

// --- stage-undo-control.ts ---

/// What the stage is doing (`StagePhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StagePhase {
    #[default]
    Idle,
    Dragging,
    Pending,
}

impl StagePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            StagePhase::Idle => "idle",
            StagePhase::Dragging => "dragging",
            StagePhase::Pending => "pending",
        }
    }
}

/// `stageUndoControl`: Undo stays shown while there is a change to take
/// back (the footer never reflows at a press); only its enabled state
/// follows the gesture, the commit, the precise edit and the switch.
pub fn stage_undo_control(
    has_undo: bool,
    phase: StagePhase,
    scene_switch_pending: bool,
    precise_edit_pending: bool,
) -> (bool, bool) {
    let shown = has_undo;
    let enabled =
        shown && phase == StagePhase::Idle && !scene_switch_pending && !precise_edit_pending;
    (shown, enabled)
}

// --- stage-viewport.ts ---

/// The canvas's screen matrix frozen at the press (`StageMapping`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StageMapping {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
    pub width: f64,
    pub height: f64,
}

impl StageMapping {
    /// An unrotated canvas `width`×`height` points at (`x`, `y`), in a
    /// viewBox one unit per point: what the Slint canvas is.
    pub fn of_rect(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: x,
            f: y,
            width,
            height,
        }
    }
}

/// `stagePoint`: a window point as canvas fractions; `None` for a matrix
/// that can't be inverted.
pub fn stage_point(mapping: StageMapping, client_x: f64, client_y: f64) -> Option<StagePoint> {
    let StageMapping {
        a,
        b,
        c,
        d,
        e,
        f,
        width,
        height,
    } = mapping;
    let determinant = a * d - b * c;
    if ![a, b, c, d, e, f, width, height, client_x, client_y]
        .iter()
        .all(|value| value.is_finite())
        || determinant.abs() < 1e-10
        || width <= 0.0
        || height <= 0.0
    {
        return None;
    }
    let x = client_x - e;
    let y = client_y - f;
    Some(StagePoint {
        x: (d * x - c * y) / determinant / width,
        y: (a * y - b * x) / determinant / height,
    })
}

/// `stagePixelSize`.
pub fn stage_pixel_size(mapping: StageMapping) -> PixelSize {
    PixelSize {
        width: mapping.a.hypot(mapping.b) * mapping.width,
        height: mapping.c.hypot(mapping.d) * mapping.height,
    }
}

// --- scene-picture-geometry.ts and native-preview-proof-geometry.ts ---

/// How the compositor fits a source into its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureFit {
    Contain,
    Cover,
}

/// `sceneSourceUsesBackgroundStage` (plan 235, D9 a): a screen, a window
/// and the test pattern always sit on the background's stage; the camera
/// only when the scene says so ([`scene_camera_on_stage`]).
pub fn uses_background_stage(kind: &SceneSourceKind, camera_on_stage: bool) -> bool {
    match kind {
        SceneSourceKind::Camera => camera_on_stage,
        _ => true,
    }
}

/// `sceneCameraUsesBackgroundStage` (#1353, plan 235 D9 a): the scene is
/// camera-only (every source a camera, hidden ones too: hiding a screen
/// must not move the camera), and the camera is not keyed. A keyed camera
/// stays full frame over the background, a camera over or beside a screen
/// keeps its place, and a Freeform scene is left alone.
pub fn scene_camera_uses_background_stage(
    source_kinds: &[SceneSourceKind],
    camera_keyed: bool,
    freeform: bool,
) -> bool {
    if freeform || camera_keyed {
        return false;
    }
    source_kinds.contains(&SceneSourceKind::Camera)
        && source_kinds
            .iter()
            .all(|kind| *kind == SceneSourceKind::Camera)
}

/// `sceneCameraOnStage`: the rule for a scene's sources under its layout.
pub fn scene_camera_on_stage(source_kinds: &[SceneSourceKind], layout: &Value) -> bool {
    scene_camera_uses_background_stage(
        source_kinds,
        layout.get("cameraChromaKeyEnabled") == Some(&Value::Bool(true)),
        layout.get("arrangementMode").and_then(Value::as_str) == Some("freeform"),
    )
}

/// `previewSurfaceLayerUsesBackgroundStage`'s layer kinds beyond the
/// scene's own sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceLayer<'a> {
    Source(&'a SceneSourceKind),
    /// The takeover image stands in for a screen.
    ScreenImage,
    Background,
    Banner,
    Buddy,
}

/// `previewSurfaceLayerUsesBackgroundStage`: a scene source asks
/// [`uses_background_stage`]; the takeover image stands in for a screen;
/// the background, banners and the Buddy are placed against the canvas.
pub fn preview_surface_layer_uses_background_stage(
    layer: SurfaceLayer<'_>,
    camera_on_stage: bool,
) -> bool {
    match layer {
        SurfaceLayer::ScreenImage => true,
        SurfaceLayer::Background | SurfaceLayer::Banner | SurfaceLayer::Buddy => false,
        SurfaceLayer::Source(kind) => uses_background_stage(kind, camera_on_stage),
    }
}

/// `sceneStageRect`: a frame on the background's stage margin. No margin,
/// or a source that is not on the stage, leaves the frame alone.
pub fn scene_stage_rect(
    frame: StageRect,
    kind: &SceneSourceKind,
    stage_margin: f64,
    camera_on_stage: bool,
) -> StageRect {
    if stage_margin <= 0.0 || !uses_background_stage(kind, camera_on_stage) {
        return frame;
    }
    let scale = 1.0 - stage_margin * 2.0;
    StageRect::new(
        stage_margin + frame.x * scale,
        stage_margin + frame.y * scale,
        frame.width * scale,
        frame.height * scale,
    )
}

/// `sceneFrameRect`: a box on the stage back to the frame it shows.
pub fn scene_frame_rect(
    rect: StageRect,
    kind: &SceneSourceKind,
    stage_margin: f64,
    camera_on_stage: bool,
) -> StageRect {
    if stage_margin <= 0.0 || !uses_background_stage(kind, camera_on_stage) {
        return rect;
    }
    let scale = 1.0 - stage_margin * 2.0;
    StageRect::new(
        (rect.x - stage_margin) / scale,
        (rect.y - stage_margin) / scale,
        rect.width / scale,
        rect.height / scale,
    )
}

fn finite_or_zero(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

/// A rect in whole canvas pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `sceneRectPixels`.
pub fn scene_rect_pixels(rect: StageRect, canvas: PixelSize) -> PixelRect {
    let position = |value: f64, span: f64| {
        js_round(
            clamp(
                finite_or_zero(value),
                MIN_SOURCE_POSITION,
                MAX_SOURCE_POSITION,
            ) * span,
        )
    };
    let size = |value: f64, span: f64| {
        js_round(clamp(finite_or_zero(value), 0.0, MAX_SOURCE_FRACTION) * span).max(1.0)
    };
    PixelRect {
        x: position(rect.x, canvas.width),
        y: position(rect.y, canvas.height),
        width: size(rect.width, canvas.width),
        height: size(rect.height, canvas.height),
    }
}

/// `containRectPixels`.
pub fn contain_rect_pixels(source_width: f64, source_height: f64, rect: PixelRect) -> PixelRect {
    if source_width <= 0.0 || source_height <= 0.0 || rect.width <= 0.0 || rect.height <= 0.0 {
        return rect;
    }
    let source_aspect = source_width / source_height;
    let rect_aspect = rect.width / rect.height;
    let (width, height) = if source_aspect > rect_aspect {
        let width = rect.width;
        (
            width,
            rect.height.min(js_round(width / source_aspect).max(1.0)),
        )
    } else {
        let height = rect.height;
        (
            rect.width.min(js_round(height * source_aspect).max(1.0)),
            height,
        )
    };
    PixelRect {
        x: rect.x + ((rect.width - width) / 2.0).floor(),
        y: rect.y + ((rect.height - height) / 2.0).floor(),
        width,
        height,
    }
}

fn kept_fraction(first: f64, second: f64) -> f64 {
    let side = |value: f64| clamp(finite_or_zero(value), 0.0, 0.95);
    (1.0 - side(first) - side(second)).max(0.001)
}

/// `ScenePictureInput`.
#[derive(Debug, Clone, Copy)]
pub struct PictureInput<'a> {
    pub frame: StageRect,
    pub kind: &'a SceneSourceKind,
    pub fit: PictureFit,
    pub source: Option<PixelSize>,
    pub crop: StageCrop,
    pub stage_margin: f64,
    /// Whether the scene's camera sits on the stage ([`scene_camera_on_stage`]).
    pub camera_on_stage: bool,
    pub canvas: PixelSize,
}

/// `scenePictureRect`: where the compositor draws the source's picture.
pub fn scene_picture_rect(input: PictureInput<'_>) -> StageRect {
    let rect = scene_rect_pixels(
        scene_stage_rect(
            input.frame,
            input.kind,
            input.stage_margin,
            input.camera_on_stage,
        ),
        input.canvas,
    );
    let pixels = match input.source {
        Some(source)
            if input.fit == PictureFit::Contain
                && *input.kind != SceneSourceKind::TestPattern
                && source.width > 0.0
                && source.height > 0.0 =>
        {
            contain_rect_pixels(
                source.width * kept_fraction(input.crop.left, input.crop.right),
                source.height * kept_fraction(input.crop.top, input.crop.bottom),
                rect,
            )
        }
        _ => rect,
    };
    let width = input.canvas.width.max(1.0);
    let height = input.canvas.height.max(1.0);
    StageRect::new(
        pixels.x / width,
        pixels.y / height,
        pixels.width / width,
        pixels.height / height,
    )
}

/// `screenBoxIsPicture`: a Freeform screen on Fit with a known size.
pub fn screen_box_is_picture(
    kind: &SceneSourceKind,
    fit: PictureFit,
    source: Option<PixelSize>,
) -> bool {
    matches!(kind, SceneSourceKind::Screen | SceneSourceKind::Window)
        && fit == PictureFit::Contain
        && source.is_some_and(|size| size.width > 0.0 && size.height > 0.0)
}

/// `previewProofBackgroundStageMargin`: the background's share around the
/// screen (half its visibility, at most 20%).
pub fn background_stage_margin(background: Option<&Value>) -> f64 {
    let Some(background) = background.filter(|value| value.is_object()) else {
        return 0.0;
    };
    let visibility = background
        .get("visibilityPercent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    (visibility / 200.0).clamp(0.0, 0.2)
}

const VERTICAL_FILL_PRESETS: [&str; 6] = [
    "vertical-camera-top",
    "vertical-camera-bottom",
    "vertical-split",
    "vertical-screen-camera",
    "vertical-screen-only",
    "vertical-camera-only",
];
const VERTICAL_FILLED_CAMERA_PRESETS: [&str; 4] = [
    "vertical-camera-top",
    "vertical-camera-bottom",
    "vertical-split",
    "vertical-camera-only",
];

/// `previewProofLayerFit` on the capture config's layout.
pub fn layer_fit(kind: &SceneSourceKind, layout: &Value) -> PictureFit {
    let text = |key: &str| layout.get(key).and_then(Value::as_str).unwrap_or_default();
    let preset = text("layoutPreset");
    if *kind == SceneSourceKind::Camera {
        if VERTICAL_FILLED_CAMERA_PRESETS.contains(&preset) {
            return PictureFit::Cover;
        }
        let zoom = layout
            .get("cameraZoom")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        return if text("cameraFit") == "fit" && zoom <= 100.0 {
            PictureFit::Contain
        } else {
            PictureFit::Cover
        };
    }
    let vertical = VERTICAL_FILL_PRESETS.contains(&preset);
    if vertical && text("verticalScreenFraming") == "fit" {
        return PictureFit::Contain;
    }
    if preset == "side-by-side" || vertical || text("horizontalScreenFraming") == "fill" {
        PictureFit::Cover
    } else {
        PictureFit::Contain
    }
}

/// `effectiveCameraMaskShape`: only the inset scenes and Freeform mask the
/// camera.
pub fn effective_camera_mask_shape(layout: &Value) -> String {
    let text = |key: &str| layout.get(key).and_then(Value::as_str).unwrap_or_default();
    let inset = matches!(
        text("layoutPreset"),
        "screen-camera" | "vertical-screen-camera"
    );
    if inset || text("arrangementMode") == "freeform" {
        match text("cameraShape") {
            "" => "rounded".to_string(),
            shape => shape.to_string(),
        }
    } else {
        "rectangle".to_string()
    }
}

// --- overlay-stage.ts (the pure helpers) ---

/// `OVERLAY_ITEMS`, in the backend's order.
pub const OVERLAY_ITEMS: [&str; 4] = ["highlight", "captions", "buddy", "chat"];
const OVERLAY_STAGE_ID_PREFIX: &str = "overlay:";
const BANNER_STAGE_ID_PREFIX: &str = "banner:";

/// `OVERLAY_ITEM_LABELS` (the words live in [`super::stage_copy`]).
pub fn overlay_item_label(item: &str) -> &'static str {
    super::stage_copy::overlay_item_label(item)
}

/// `overlayStageId`.
pub fn overlay_stage_id(item: &str) -> String {
    format!("{OVERLAY_STAGE_ID_PREFIX}{item}")
}

/// `overlayItemFromStageId`.
pub fn overlay_item_from_stage_id(id: &str) -> Option<&'static str> {
    let item = id.strip_prefix(OVERLAY_STAGE_ID_PREFIX)?;
    OVERLAY_ITEMS
        .into_iter()
        .find(|candidate| *candidate == item)
}

/// `bannerStageId`.
pub fn banner_stage_id(id: &str) -> String {
    format!("{BANNER_STAGE_ID_PREFIX}{id}")
}

/// `bannerIdFromStageId`.
pub fn banner_id_from_stage_id(id: &str) -> Option<&str> {
    id.strip_prefix(BANNER_STAGE_ID_PREFIX)
        .filter(|rest| !rest.is_empty())
}

/// What the chip says after an item's name (`StageItemBadge`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageItemBadge {
    Hidden,
    Off,
    StreamOnly,
    RecordingOnly,
}

impl StageItemBadge {
    /// `STAGE_ITEM_BADGE_LABELS`: the chip's word, sentence case (the
    /// words live in [`super::stage_copy`]).
    pub fn label(self) -> &'static str {
        use super::stage_copy::{BADGE_HIDDEN, BADGE_OFF, BADGE_RECORDING_ONLY, BADGE_STREAM_ONLY};
        match self {
            StageItemBadge::Hidden => BADGE_HIDDEN,
            StageItemBadge::Off => BADGE_OFF,
            StageItemBadge::StreamOnly => BADGE_STREAM_ONLY,
            StageItemBadge::RecordingOnly => BADGE_RECORDING_ONLY,
        }
    }

    /// The schematic's word (`entry.badge`): the label, lower case.
    pub fn word(self) -> String {
        self.label().to_lowercase()
    }
}

/// `overlayItemOutputBadge`: which output alone shows an item, if only one.
pub fn output_badge(show_on_stream: bool, show_in_recording: bool) -> Option<StageItemBadge> {
    match (show_on_stream, show_in_recording) {
        (true, false) => Some(StageItemBadge::StreamOnly),
        (false, true) => Some(StageItemBadge::RecordingOnly),
        _ => None,
    }
}

/// `buddyPetBox`: the square the Buddy's pet fills inside its rect.
pub fn buddy_pet_box(rect: StageRect, canvas_aspect: f64) -> StageRect {
    let aspect = if canvas_aspect.is_finite() && canvas_aspect > 0.0 {
        canvas_aspect
    } else {
        16.0 / 9.0
    };
    let width = rect.width.min(1.0).min(1.0 / aspect);
    let height = width * aspect;
    let x = (rect.x + rect.width / 2.0 - width / 2.0)
        .max(0.0)
        .min(1.0 - width);
    let y = (if rect.y + rect.height / 2.0 >= 0.5 {
        rect.bottom() - height
    } else {
        rect.y
    })
    .max(0.0)
    .min(1.0 - height);
    StageRect::new(x, y, width, height)
}

/// A banner this much of the canvas is a frame around the picture.
const BANNER_FRAME_COVERAGE: f64 = 0.9;

/// `bannerFillsCanvas`.
pub fn banner_fills_canvas(rect: StageRect) -> bool {
    rect.width * rect.height >= BANNER_FRAME_COVERAGE
}

/// The smallest overlay box the backend accepts (`clampOverlayRect`'s floor).
pub const MIN_OVERLAY_SIZE: f64 = 0.02;

/// S3.3c: an overlay item's or a banner's rect key for a canvas
/// (`OverlayOrientation`: `vertical` on a canvas taller than wide).
pub fn overlay_orientation_key(vertical: bool) -> &'static str {
    if vertical { "vertical" } else { "horizontal" }
}

/// `clampOverlayRect`: inside the canvas and no smaller than the backend
/// takes, so a gesture is never refused.
pub fn clamp_overlay_rect(rect: StageRect) -> StageRect {
    let finite = |value: f64, fallback: f64| if value.is_finite() { value } else { fallback };
    let round6 = |value: f64| js_round(value * 1_000_000.0) / 1_000_000.0;
    let width = clamp(finite(rect.width, MIN_OVERLAY_SIZE), MIN_OVERLAY_SIZE, 1.0);
    let height = clamp(finite(rect.height, MIN_OVERLAY_SIZE), MIN_OVERLAY_SIZE, 1.0);
    StageRect::new(
        round6(clamp(finite(rect.x, 0.0), 0.0, 1.0 - width)),
        round6(clamp(finite(rect.y, 0.0), 0.0, 1.0 - height)),
        round6(width),
        round6(height),
    )
}

/// `CENTER_GRAVITY_BAND`: a banner within this of the centre keeps it.
const CENTER_GRAVITY_BAND: f64 = 0.02;

/// `bannerFitRect`: the banner's image rect inside its place, in canvas
/// units (a resize then keeps the image's aspect). `canvas_aspect` is the
/// canvas's width / height; `image` its pixels.
pub fn banner_fit_rect(
    image: (f64, f64),
    place: StageRect,
    canvas_aspect: f64,
    vertical: bool,
) -> StageRect {
    let aspect = if canvas_aspect.is_finite() && canvas_aspect > 0.0 {
        canvas_aspect
    } else if vertical {
        9.0 / 16.0
    } else {
        16.0 / 9.0
    };
    let image_aspect = image.0.max(1.0) / image.1.max(1.0);
    let mut width = place.width;
    let mut height = place.height;
    if image_aspect * place.height <= place.width * aspect {
        width = image_aspect * place.height / aspect;
    } else {
        height = place.width * aspect / image_aspect;
    }
    let center = place.x + place.width / 2.0;
    let x = if center < 0.5 - CENTER_GRAVITY_BAND {
        place.x
    } else if center > 0.5 + CENTER_GRAVITY_BAND {
        place.right() - width
    } else {
        place.x + (place.width - width) / 2.0
    };
    let y = if place.y + place.height / 2.0 >= 0.5 {
        place.bottom() - height
    } else {
        place.y
    };
    clamp_overlay_rect(StageRect::new(x, y, width, height))
}

// --- what a press lands on (the SVG's z-order and hit areas) ---

/// The invisible outline that drags a selected item (points).
pub const ITEM_GRAB_STROKE: f64 = 10.0;
/// The label chip's hit width (points), at most the item's own.
pub const ITEM_CHIP_HIT_WIDTH: f64 = 120.0;
/// The label chip's height and padding (points).
pub const CHIP_HEIGHT: f64 = 16.0;
pub const CHIP_PADDING: f64 = 4.0;
/// A handle's hit square (points).
pub const HANDLE_HIT: f64 = 24.0;
/// The handle gutter around the canvas (points).
pub const HANDLE_GUTTER: f64 = 28.0;

/// One thing on the stage a press may land on, in canvas fractions.
#[derive(Debug, Clone, PartialEq)]
pub struct HitTarget {
    pub id: String,
    pub rect: StageRect,
    /// An overlay item or a banner (drawn after the sources).
    pub item: bool,
    /// The whole rect takes the pointer (a source, a banner that doesn't
    /// fill the canvas, a selected item), not only the label chip.
    pub body: bool,
    /// A picture drawn inside the rect that takes the pointer where it is
    /// (the Buddy's pet on the schematic).
    pub picture: Option<StageRect>,
}

/// What a press landed on.
#[derive(Debug, Clone, PartialEq)]
pub enum StageHit {
    /// A handle of the selection.
    Handle(HandleId),
    /// A source or an item, by id.
    Target(String),
}

/// The selection's handles, where they take the pointer.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionHit {
    pub rect: StageRect,
    pub handles: Vec<HandleId>,
    /// Points the grips sit off their anchors (a tiny box).
    pub offset: f64,
}

/// What a press at `point` (points from the canvas's top-left) lands on:
/// the selection's handles first, then the targets from the top of the
/// stack down (`targets` in draw order). A selected item's outline grabs
/// within `ITEM_GRAB_STROKE / 2` of its edge.
pub fn stage_hit(
    point: (f64, f64),
    canvas: PixelSize,
    selection: Option<&SelectionHit>,
    selected_id: Option<&str>,
    targets: &[HitTarget],
) -> Option<StageHit> {
    let (px, py) = point;
    let inside = |x: f64, y: f64, w: f64, h: f64| px >= x && px <= x + w && py >= y && py <= y + h;
    if let Some(selection) = selection {
        for (handle, ax, ay) in stage_handle_points(selection.rect) {
            if !selection.handles.contains(&handle) {
                continue;
            }
            let cx = ax * canvas.width + selection.offset;
            let cy = ay * canvas.height + selection.offset;
            if inside(
                cx - HANDLE_HIT / 2.0,
                cy - HANDLE_HIT / 2.0,
                HANDLE_HIT,
                HANDLE_HIT,
            ) {
                return Some(StageHit::Handle(handle));
            }
        }
    }
    for target in targets.iter().rev() {
        let x = target.rect.x * canvas.width;
        let y = target.rect.y * canvas.height;
        let w = target.rect.width * canvas.width;
        let h = target.rect.height * canvas.height;
        let selected = selected_id == Some(target.id.as_str());
        let hit = if target.item {
            let chip = inside(
                x,
                y,
                w.min(ITEM_CHIP_HIT_WIDTH),
                h.min(CHIP_HEIGHT + 2.0 * CHIP_PADDING),
            );
            let body = (selected || target.body) && inside(x, y, w, h);
            let half = ITEM_GRAB_STROKE / 2.0;
            let outline = selected
                && inside(x - half, y - half, w + 2.0 * half, h + 2.0 * half)
                && !inside(x + half, y + half, w - 2.0 * half, h - 2.0 * half);
            let picture = target.picture.is_some_and(|picture| {
                inside(
                    picture.x * canvas.width,
                    picture.y * canvas.height,
                    picture.width * canvas.width,
                    picture.height * canvas.height,
                )
            });
            chip || body || outline || picture
        } else {
            inside(x, y, w, h)
        };
        if hit {
            return Some(StageHit::Target(target.id.clone()));
        }
    }
    None
}

// --- the editor draft's wire (`lib/editor-draft-channel.ts`) ---

/// How often a live draft is sent again (the backend drops one after 2 s).
pub const EDITOR_DRAFT_HEARTBEAT: Duration = Duration::from_millis(500);

/// What the channel wants on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftWanted {
    /// Nothing: a draft on the wire is cleared.
    None,
    /// A gesture's latest frame (`scene.editor.draft.set`), sent at once
    /// and again on the heartbeat.
    Gesture(Value),
    /// A released gesture's last frame: sent once, never repeated (the
    /// commit's revision ends it, or the backend's TTL).
    Released(Value),
    /// A chrome-only hold of the selection: sent when it changes and on the
    /// heartbeat.
    Hold(Value),
}

/// What the app should send now.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftSend {
    Set(Value),
    Clear,
}

/// The draft's wire, latest wins, one request in flight
/// (`createEditorDraftChannel`). The app sets what it wants, asks
/// [`DraftChannel::next`] what to send whenever the wire is free (or the
/// heartbeat is due), and reports each answer.
#[derive(Debug, Clone)]
pub struct DraftChannel {
    wanted: DraftWanted,
    /// The owner (a gesture or a hold) the backend refused (a session runs):
    /// nothing more is sent for it.
    refused: bool,
    in_flight: bool,
    /// What the last finished send put on the wire, and when.
    sent: Option<(DraftWanted, Instant)>,
    /// A draft may be on the wire (a set went out since the last clear).
    wire_dirty: bool,
    pub enabled: bool,
}

impl Default for DraftChannel {
    fn default() -> Self {
        Self {
            wanted: DraftWanted::None,
            refused: false,
            in_flight: false,
            sent: None,
            wire_dirty: false,
            enabled: true,
        }
    }
}

impl DraftChannel {
    /// A new owner or a new frame. A new gesture or hold forgets an earlier
    /// refusal; a frame of the same refused owner stays refused.
    pub fn want(&mut self, wanted: DraftWanted) {
        let same_owner = matches!(
            (&self.wanted, &wanted),
            (DraftWanted::Gesture(_), DraftWanted::Gesture(_))
                | (DraftWanted::Gesture(_), DraftWanted::Released(_))
        ) && self.wanted_source() == source_of(&wanted);
        if !same_owner {
            self.refused = false;
        }
        self.wanted = wanted;
    }

    fn wanted_source(&self) -> Option<&str> {
        source_of(&self.wanted)
    }

    pub fn wanted(&self) -> &DraftWanted {
        &self.wanted
    }

    /// What to send now, if anything (and marks it in flight).
    pub fn next(&mut self, now: Instant) -> Option<DraftSend> {
        if self.in_flight {
            return None;
        }
        let send = if !self.enabled {
            self.wire_dirty.then_some(DraftSend::Clear)
        } else {
            match &self.wanted {
                DraftWanted::None => self.wire_dirty.then_some(DraftSend::Clear),
                _ if self.refused => None,
                DraftWanted::Released(params) => match &self.sent {
                    Some((DraftWanted::Released(sent), _)) if sent == params => None,
                    _ => Some(DraftSend::Set(params.clone())),
                },
                DraftWanted::Gesture(params) | DraftWanted::Hold(params) => match &self.sent {
                    Some((sent, at))
                        if *sent == self.wanted
                            && now.duration_since(*at) < EDITOR_DRAFT_HEARTBEAT =>
                    {
                        None
                    }
                    _ => Some(DraftSend::Set(params.clone())),
                },
            }
        };
        if send.is_some() {
            self.in_flight = true;
        }
        send
    }

    /// When the heartbeat wants the next send, if one is due later.
    pub fn next_due(&self) -> Option<Instant> {
        if self.refused || !self.enabled {
            return None;
        }
        match (&self.wanted, &self.sent) {
            (DraftWanted::Gesture(_) | DraftWanted::Hold(_), Some((sent, at)))
                if *sent == self.wanted =>
            {
                Some(*at + EDITOR_DRAFT_HEARTBEAT)
            }
            _ => None,
        }
    }

    /// The answer to what [`DraftChannel::next`] sent: `Ok` for a set or a
    /// clear that went through, `Err(true)` for the backend's refusal (a
    /// session runs), `Err(false)` for any other failure.
    pub fn finished(&mut self, sent: &DraftSend, result: Result<(), bool>, now: Instant) {
        self.in_flight = false;
        match sent {
            DraftSend::Clear => {
                if result.is_ok() {
                    self.wire_dirty = false;
                }
                self.sent = None;
            }
            DraftSend::Set(params) => {
                self.wire_dirty = true;
                match result {
                    Err(true) => self.refused = true,
                    _ => {
                        let owner = match &self.wanted {
                            DraftWanted::Gesture(_) => DraftWanted::Gesture(params.clone()),
                            DraftWanted::Released(_) => DraftWanted::Released(params.clone()),
                            DraftWanted::Hold(_) => DraftWanted::Hold(params.clone()),
                            DraftWanted::None => DraftWanted::None,
                        };
                        self.sent = Some((owner, now));
                    }
                }
            }
        }
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight
    }

    pub fn refused(&self) -> bool {
        self.refused
    }
}

fn source_of(wanted: &DraftWanted) -> Option<&str> {
    match wanted {
        DraftWanted::None => None,
        DraftWanted::Gesture(params)
        | DraftWanted::Released(params)
        | DraftWanted::Hold(params) => params.get("sourceId").and_then(Value::as_str),
    }
}

/// The chrome a draft carries on the texture route: none the compositor can
/// draw. Slint draws the frame, the handles and the guides over the picture
/// itself (plan 220 D1), so the draft's chrome is an empty frame off the
/// canvas (every quad clips away) and no handles or guides; the backend
/// still moves the picture (`transform`) and, for the Buddy, draws its pet.
pub fn hidden_chrome() -> Value {
    json!({
        "selected": { "x": -1.0, "y": -1.0, "width": 0.0, "height": 0.0 },
        "handles": false,
        "guides": [],
        "scale": 1.0,
    })
}

/// One gesture frame's draft (`draftOf`): the frame the ghost maps back to,
/// an ⌥-crop's crop, and the hidden chrome.
pub fn draft_params(source_id: &str, transform: StageRect, crop: Option<StageCrop>) -> Value {
    let mut params = json!({
        "sourceId": source_id,
        "transform": transform.json(),
        "chrome": hidden_chrome(),
    });
    if let Some(crop) = crop {
        params["crop"] = crop.json();
    }
    params
}

/// A chrome-only hold of the selection (no transform).
pub fn hold_params(source_id: &str) -> Value {
    json!({ "sourceId": source_id, "chrome": hidden_chrome() })
}

#[cfg(test)]
#[path = "stage_tests.rs"]
mod tests;
