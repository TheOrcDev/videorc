//! Plan 220 S3.3c: the Scene page's inspector as data. A port of
//! `components/tabs/layout-tab.tsx`'s Layout section, inspector and their
//! helpers (`placementControls`, `scenePositionLockReason`,
//! `CameraInspector`, `OverlayItemSection`, `sourceIsFullCanvas`), with
//! `components/scene/source-transform-fields.tsx` and
//! `transform-fields-math.ts`, `screen-size-field.tsx`,
//! `screen-zoom-field.tsx` and `screen-zoom.ts`, `camera-look-controls.tsx`
//! (`lib/camera-look.ts`), `camera-reset-button.tsx`, `banner-inspector.tsx`
//! (`lib/banner-place.ts`, `lib/banner-size.ts`, `lib/banner-timing.ts`,
//! `lib/banners.ts`' order and limit), `hide-screen-section.tsx`
//! (`lib/privacy-settings.ts`' list), `lib/scene-edits.ts` and
//! `lib/overlay-layout.ts`' snaps.
//!
//! Every word the page shows that depends on the scene is here; the fixed
//! words of a control's frame are in `ui/pages/scene-inspector.slint`.
//! Nothing here knows the UI framework.

use serde_json::{Map, Value, json};
use videorc_protocol::overlay_layout::OverlayRect;
use videorc_protocol::{Banner, SceneSource, SceneSourceKind};

use super::stage::{
    MAX_SOURCE_FRACTION, MAX_SOURCE_POSITION, MIN_CROP_KEPT, MIN_SOURCE_FRACTION,
    MIN_SOURCE_POSITION, PixelSize, StageCrop, StageRect, clamp_overlay_rect,
    clamp_source_position, round_rect_for_commit, scene_frame_rect, scene_stage_rect,
};
use crate::studio::families::{BUILT_IN_PASSWORD_MANAGERS, PrivacySettings};

/// The inspector's words (`layout-tab.tsx` and the components it holds).
pub mod copy {
    // ── Layout ──
    pub const LAYOUT_DESCRIPTION: &str = "Pick how the screen and camera are arranged.";
    pub const ORIENTATION_LOCK_REASON: &str =
        "The canvas is fixed while you're recording or live. Stop to switch orientation.";
    pub const FREEFORM: &str = "Freeform";
    pub const LIVE_SWITCH_HINT: &str =
        "Switching applies live. Recording and streaming keep running.";
    pub const NO_SCREEN_HINT: &str =
        "Choose a screen or window in Sources to use the screen layouts.";
    pub const NO_CAMERA_HINT_VERTICAL: &str =
        "Choose a camera in Sources to use the camera layouts.";
    pub const NO_CAMERA_HINT: &str =
        "Choose a camera in Sources to use Camera only and Side by side.";
    /// `ScreenFramingControl`'s landscape lines (plan 213 G3).
    pub const FRAMING_FIT_HORIZONTAL: &str =
        "Shows your whole screen. A screen of another shape gets bars.";
    pub const FRAMING_FILL_HORIZONTAL: &str =
        "Fills the frame and crops the edges of your screen that don't fit.";
    /// `ScreenFramingControl`'s 9:16 lines.
    pub const FRAMING_FIT_VERTICAL: &str = "Shows your whole screen. The camera takes the rest.";
    pub const FRAMING_FILL_VERTICAL: &str = "Fills the area and crops the sides of your screen.";

    // ── Banners and Images (#1323, #1594) ──
    pub const HTML_OVERLAY_LOADING_LINE: &str = "Loading the page…";
    pub const HTML_OVERLAY_STOPPED: &str = "This banner stopped.";
    pub const HTML_BANNER_SOFT: &str = "An HTML banner is drawn at up to 1920 × 1080 px and scaled up from there: it will look soft at this size.";
    pub const HTML_BANNER_SHARP: &str = "An HTML banner is drawn at this size, so it stays sharp.";
    pub const OPEN_IMAGES: &str = "Open Images";
    pub const MANAGE_IN_IMAGES: &str = "Manage in Images";
    pub const SCREEN_SIZE_HINT: &str = "How much of the canvas your screen fills. The background shows around it. This is the background's Visibility in Images.";

    // ── Reset camera settings (`camera-reset-button.tsx`, #1673) ──
    pub const CAMERA_RESET_LABEL: &str = "Reset camera settings";
    pub const CAMERA_RESET_TITLE: &str = "Reset camera settings?";
    pub const CAMERA_RESET_DESCRIPTION: &str = "Placement, frame and lens go back to their defaults, on a running stream or recording too. The layout, your sources and the background stay.";

    // ── The inspector ──
    pub const INSPECTOR_TITLE: &str = "Inspector";
    pub const INSPECTOR_EMPTY: &str =
        "Click a source, an overlay or a banner on the stage to edit it.";
    pub const FULL_CANVAS_BACKGROUND: &str = "Fills the canvas inside the background in this layout. Use Freeform to move, resize or crop it.";
    pub const FULL_CANVAS: &str =
        "Fills the whole canvas in this layout. Use Freeform to move, resize or crop it.";
    /// `SCENE_VISIBILITY_LOCK_REASON` (`lib/scene-edits.ts`).
    pub const VISIBILITY_LOCK_REASON: &str = "Visibility is locked while you're recording or live.";
    pub const PLACEMENT_HINT: &str =
        "Click the source on the stage to edit it: drag it, or nudge it with the arrows.";
    pub const LIVE_PLACEMENT_HINT: &str = "Changes apply to your stream when you let go.";
    pub const POSITION_LOCK_REASON: &str =
        "Position and size are locked while you're recording or live.";
    pub const POSITION_UNAVAILABLE_REASON: &str =
        "Moving and resizing isn't available on this recording. Stop and record again.";
    pub const SCREEN_SIZE_LOCK_REASON: &str =
        "Screen size is locked while you're recording or live.";
    pub const SCREEN_PICTURE_ASPECT_REASON: &str = "The picture sets the shape. Crop to change it.";
    pub const CAMERA_FREEFORM_PLACEMENT: &str =
        "Drag and resize the camera on the stage, or set exact numbers below.";
    pub const CAMERA_ONLY_PLACEMENT: &str = "Camera only fills the frame as a rectangle. Corner, size and shape don't apply; frame yourself under Lens.";
    pub const VERTICAL_CAMERA_ONLY_PLACEMENT: &str = "The camera fills the whole 9:16 canvas and crops to fit. Corner, size and shape don't apply; frame yourself under Lens.";
    pub const VERTICAL_STACK_PLACEMENT: &str = "The stacked vertical scenes give the camera and the screen fixed bands of the 9:16 canvas. Corner, size and shape don't apply; frame yourself under Lens.";
    pub const LENS_VERTICAL_CAMERA_ONLY: &str =
        "The camera always fills the 9:16 canvas and crops. Use zoom and pan to frame yourself.";
    pub const LENS_VERTICAL_STACK: &str =
        "The camera band always fills and crops. Use zoom and pan to frame yourself.";
    /// `CameraLookControls`' reasons.
    pub const LOOK_RECONNECTING: &str = "Videorc is reconnecting.";
    pub const LOOK_NO_CAMERA: &str = "Choose a camera in Sources.";

    // ── Position and size (`source-transform-fields.tsx`) ──
    pub const CAMERA_SHAPE_SETS_ASPECT: &str = "The camera shape sets the aspect.";
    pub const LAYOUT_SETS_SIZE: &str = "This layout sets the size.";
    pub const ASPECT_LOCKED_TIP: &str = "Aspect locked. Size edits keep the shape.";
    pub const ASPECT_FREE_TIP: &str = "Aspect free. Width and height move alone.";
    pub const UNLOCK_ASPECT: &str = "Unlock aspect ratio";
    pub const LOCK_ASPECT: &str = "Lock aspect ratio";

    // ── Screen size and Zoom ──
    pub const SCREEN_ZOOM_HINT: &str =
        "Zooming softens text. Crop to show part of the screen sharply.";

    // ── Overlay items ──
    pub const HIGHLIGHT_DESCRIPTION: &str =
        "The highlighted message card. Drag it on the stage or snap it to a corner.";
    pub const CAPTIONS_DESCRIPTION: &str = "The caption bar. Drag its edges to set its width. Turning captions on, style and text size live in Captions.";
    /// The captions item's row (#1593): it opens Captions.
    pub const LIVE_CAPTIONS: &str = "Live captions";
    pub const BUDDY_DESCRIPTION: &str =
        "Your avatar and its speech bubble. Drag it on the stage or snap it to a corner.";
    pub const CHAT_DESCRIPTION: &str = "The last five chat messages, with each viewer's name. Drag the box on the stage or snap it to a corner.";
    pub const BUDDY_OFF_LINE: &str = "Off. Viewers don't see your avatar.";
    pub const CHAT_OFF_LINE: &str = "Off. Viewers don't see chat.";
    pub const SNAP_TO: &str = "Snap to";
    pub const SNAP_VERTICAL: &str = "Snap on the vertical stream";
    /// `OFFLINE_LOCK_REASON` (`lib/lock-reason.ts`): `overlayEditsBlockedReason`.
    pub const OFFLINE_LOCK_REASON: &str =
        "Videorc is reconnecting. These controls come back in a moment.";

    // ── Banners ──
    pub const BANNER_SHOWING_LINE: &str = "Showing";
    pub const BANNER_HIDDEN_LINE: &str = "Hidden. Viewers don't see it.";
    pub const BANNER_OFF_LINE: &str = "Off. Viewers don't see it.";
    pub const BANNER_SHOWN_LIMIT_REASON: &str = "Four banners are showing. Hide one first.";
    pub const BANNER_IN_FRONT_REASON: &str = "This banner is already in front.";
    pub const BANNER_AT_BACK_REASON: &str = "This banner is already at the back.";
    pub const BANNER_REPEAT_DESCRIPTION: &str = "Repeats only while you're recording or live.";
    pub const PLACE: &str = "Place";
    pub const PLACE_VERTICAL: &str = "Place on the vertical stream";
    pub const OFF: &str = "Off";

    // ── Hide screen ──
    pub const LAST_APP_REASON: &str =
        "One app stays on the list. To stop hiding for password managers, turn the switch off.";
    pub const NOT_SET: &str = "Not set";
    pub const FINDING_APPS: &str = "Finding your open apps…";
    pub const APPS_GRANT_MISSING: &str = "Videorc needs Screen Recording to list your open apps.";
    pub const EVERY_APP_LISTED: &str =
        "Every open app is on the list. Open the app first, then add it.";
    pub const NO_APP_MATCHES: &str = "No open app matches.";
}

// ── Small numbers ──────────────────────────────────────────────────────

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn round4(value: f64) -> f64 {
    js_round(value * 10_000.0) / 10_000.0
}

fn round6(value: f64) -> f64 {
    js_round(value * 1_000_000.0) / 1_000_000.0
}

fn text<'a>(layout: &'a Value, key: &str) -> &'a str {
    layout.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn number(layout: &Value, key: &str, fallback: f64) -> f64 {
    layout
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

// ── Locks and the camera's controls ────────────────────────────────────

/// `scenePositionLockReason`: why a source's box can't move now (plan 215
/// D1), or `None` while it can.
pub fn scene_position_lock_reason(
    session_active: bool,
    accepts_live_scene_edits: Option<bool>,
) -> Option<&'static str> {
    if !session_active || accepts_live_scene_edits == Some(true) {
        return None;
    }
    Some(if accepts_live_scene_edits == Some(false) {
        copy::POSITION_UNAVAILABLE_REASON
    } else {
        copy::POSITION_LOCK_REASON
    })
}

/// `placementControls`: the Placement section's arrows and its one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementControls {
    pub nudge_disabled: bool,
    pub description: &'static str,
    pub lock_reason: Option<&'static str>,
}

pub fn placement_controls(
    scene_edit_mode: bool,
    session_active: bool,
    accepts_live_scene_edits: Option<bool>,
    stage_dragging: bool,
) -> PlacementControls {
    let lock_reason = scene_position_lock_reason(session_active, accepts_live_scene_edits);
    PlacementControls {
        nudge_disabled: !scene_edit_mode || lock_reason.is_some() || stage_dragging,
        description: lock_reason.unwrap_or(if session_active {
            copy::LIVE_PLACEMENT_HINT
        } else {
            copy::PLACEMENT_HINT
        }),
        lock_reason,
    }
}

/// `sceneCameraControls`: which camera controls a layout offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CameraControls {
    pub inset: bool,
    pub freeform: bool,
    pub corner: bool,
    pub bubble: bool,
}

pub fn scene_camera_controls(layout: &Value) -> CameraControls {
    let preset = text(layout, "layoutPreset");
    let inset = preset == "screen-camera" || preset == "vertical-screen-camera";
    let freeform = text(layout, "arrangementMode") == "freeform";
    CameraControls {
        inset,
        freeform,
        corner: inset && !freeform,
        bubble: inset || freeform,
    }
}

/// `cameraShapePatch`: Rounded means a rounded square by default.
pub fn camera_shape_patch(shape: &str) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert("cameraShape".into(), json!(shape));
    if shape == "rounded" {
        patch.insert("cameraAspect".into(), json!("square"));
    }
    patch
}

/// `CAMERA_SETTINGS_DEFAULTS`: placement, frame and lens. Never the layout
/// preset or the sources, and never the camera's background (plan 258 S5,
/// #1673): the green or blue screen moved into it, kept per camera, and a
/// reset that turned a blur off would show the room.
pub fn camera_settings_defaults() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "cameraTransformMode": "preset",
        "cameraTransform": null,
        "cameraCorner": "bottom-right",
        "cameraSize": "medium",
        "cameraShape": "rectangle",
        "cameraCornerRadiusPct": 12,
        "cameraAspect": "source",
        "cameraMargin": 32,
        "cameraFit": "fill",
        "cameraMirror": false,
        "cameraZoom": 100,
        "cameraOffsetX": 0,
        "cameraOffsetY": 0,
    }) else {
        unreachable!("an object literal")
    };
    map
}

/// `sourceIsFullCanvas`.
pub fn source_is_full_canvas(source: &SceneSource) -> bool {
    source.transform.width >= 1.0 && source.transform.height >= 1.0
}

/// `sourceCroppable` (`lib/freeform-memory.ts`): a screen or a window.
pub fn source_croppable(kind: &SceneSourceKind) -> bool {
    matches!(kind, SceneSourceKind::Screen | SceneSourceKind::Window)
}

// ── Position and size (`transform-fields-math.ts`) ─────────────────────

/// The four fields' labels (`TRANSFORM_FIELD_LABELS`).
pub const TRANSFORM_FIELDS: [(&str, &str); 4] =
    [("x", "X"), ("y", "Y"), ("width", "W"), ("height", "H")];
/// The crop's four sides (`CROP_FIELD_LABELS`).
pub const CROP_FIELDS: [(&str, &str); 4] = [
    ("cropLeft", "Left"),
    ("cropTop", "Top"),
    ("cropRight", "Right"),
    ("cropBottom", "Bottom"),
];

/// `formatPercentValue`: a fraction as a percent with at most one decimal.
pub fn format_percent_value(normalized: f64) -> String {
    let percent = js_round(normalized * 1000.0) / 10.0;
    if percent.fract() == 0.0 {
        format!("{}", percent as i64)
    } else {
        format!("{percent:.1}")
    }
}

/// `parsePercentValue`: a typed percent as a fraction, or `None`.
pub fn parse_percent_value(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let cleaned = trimmed
        .strip_suffix('%')
        .unwrap_or(trimmed)
        .replacen(',', ".", 1);
    if cleaned.is_empty() {
        return None;
    }
    let parsed: f64 = cleaned.trim().parse().ok()?;
    parsed.is_finite().then_some(parsed / 100.0)
}

/// A box's field by its name.
pub fn rect_field(rect: StageRect, field: &str) -> f64 {
    match field {
        "x" => rect.x,
        "y" => rect.y,
        "width" => rect.width,
        _ => rect.height,
    }
}

/// `clampTransformField`.
pub fn clamp_transform_field(field: &str, normalized: f64) -> f64 {
    if field == "x" || field == "y" {
        normalized.clamp(MIN_SOURCE_POSITION, MAX_SOURCE_POSITION)
    } else {
        normalized.clamp(MIN_SOURCE_FRACTION, MAX_SOURCE_FRACTION)
    }
}

/// A patch of the box's fields (`TransformPatch`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TransformPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

impl TransformPatch {
    pub fn json(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
        ] {
            if let Some(value) = value {
                map.insert(key.into(), json!(value));
            }
        }
        Value::Object(map)
    }

    fn get(&self, field: &str) -> Option<f64> {
        match field {
            "x" => self.x,
            "y" => self.y,
            "width" => self.width,
            _ => self.height,
        }
    }

    fn set(&mut self, field: &str, value: f64) {
        match field {
            "x" => self.x = Some(value),
            "y" => self.y = Some(value),
            "width" => self.width = Some(value),
            _ => self.height = Some(value),
        }
    }

    fn of_rect(rect: StageRect) -> Self {
        Self {
            x: Some(rect.x),
            y: Some(rect.y),
            width: Some(rect.width),
            height: Some(rect.height),
        }
    }
}

fn on_canvas_position(
    committed: StageRect,
    width: Option<f64>,
    height: Option<f64>,
) -> TransformPatch {
    let mut patch = TransformPatch::default();
    if let Some(width) = width {
        let x = clamp_source_position(committed.x, width);
        if x != committed.x {
            patch.x = Some(round4(x));
        }
    }
    if let Some(height) = height {
        let y = clamp_source_position(committed.y, height);
        if y != committed.y {
            patch.y = Some(round4(y));
        }
    }
    patch
}

/// `transformFieldPatch`: one field's edit. With the aspect locked a size
/// edit scales both axes (the limiting axis wins); a box that would leave
/// less than 5% of the canvas covered slides back onto it.
pub fn transform_field_patch(
    field: &str,
    value: f64,
    committed: StageRect,
    aspect_locked: bool,
) -> TransformPatch {
    let clamped = clamp_transform_field(field, value);
    if field == "x" {
        return TransformPatch {
            x: Some(round4(clamp_source_position(clamped, committed.width))),
            ..TransformPatch::default()
        };
    }
    if field == "y" {
        return TransformPatch {
            y: Some(round4(clamp_source_position(clamped, committed.height))),
            ..TransformPatch::default()
        };
    }
    if !aspect_locked || committed.width <= 0.0 || committed.height <= 0.0 {
        let (width, height) = if field == "width" {
            (Some(clamped), None)
        } else {
            (None, Some(clamped))
        };
        let mut patch = on_canvas_position(committed, width, height);
        patch.set(field, clamped);
        return patch;
    }
    let mut scale = if field == "width" {
        clamped / committed.width
    } else {
        clamped / committed.height
    };
    let min_scale =
        (MIN_SOURCE_FRACTION / committed.width).max(MIN_SOURCE_FRACTION / committed.height);
    let max_scale =
        (MAX_SOURCE_FRACTION / committed.width).min(MAX_SOURCE_FRACTION / committed.height);
    scale = scale.max(min_scale).min(max_scale.max(min_scale));
    let width = round4(committed.width * scale);
    let height = round4(committed.height * scale);
    let mut patch = on_canvas_position(committed, Some(width), Some(height));
    patch.width = Some(width);
    patch.height = Some(height);
    patch
}

/// A crop side's value.
pub fn crop_field(crop: StageCrop, field: &str) -> f64 {
    match field {
        "cropLeft" => crop.left,
        "cropTop" => crop.top,
        "cropRight" => crop.right,
        _ => crop.bottom,
    }
}

fn opposite_crop_side(field: &str) -> &'static str {
    match field {
        "cropLeft" => "cropRight",
        "cropRight" => "cropLeft",
        "cropTop" => "cropBottom",
        _ => "cropTop",
    }
}

/// `cropFieldPatch`: one side, at most what leaves 5% beside the opposite
/// side's crop.
pub fn crop_field_patch(field: &str, value: f64, committed: StageCrop) -> (String, f64) {
    let most = (1.0 - MIN_CROP_KEPT - crop_field(committed, opposite_crop_side(field))).max(0.0);
    (field.to_string(), round4(value.max(0.0).min(most)))
}

/// `pictureEditToFrame`: a field edit on the picture as the frame patch.
/// No margin, or a source that is not on the stage (a camera, unless the
/// scene stages it: plan 235), leaves the patch as it is.
pub fn picture_edit_to_frame(
    patch: TransformPatch,
    kind: &SceneSourceKind,
    stage_margin: f64,
    camera_on_stage: bool,
) -> TransformPatch {
    let frame = scene_frame_rect(
        StageRect::new(
            patch.x.unwrap_or(0.0),
            patch.y.unwrap_or(0.0),
            patch.width.unwrap_or(0.0),
            patch.height.unwrap_or(0.0),
        ),
        kind,
        stage_margin,
        camera_on_stage,
    );
    let mut result = TransformPatch::default();
    for (key, _) in TRANSFORM_FIELDS {
        if patch.get(key).is_some() {
            result.set(key, round4(rect_field(frame, key)));
        }
    }
    result
}

/// `pictureEditFramePatch`: while the box is the frame only the edited
/// fields go; once the picture differs, the whole picture goes with them.
pub fn picture_edit_frame_patch(
    patch: TransformPatch,
    picture: StageRect,
    frame: StageRect,
    kind: &SceneSourceKind,
    stage_margin: f64,
    canvas: PixelSize,
    camera_on_stage: bool,
) -> TransformPatch {
    let staged = scene_stage_rect(frame, kind, stage_margin, camera_on_stage);
    let box_is_frame = TRANSFORM_FIELDS.iter().all(|(key, _)| {
        let along = if *key == "x" || *key == "width" {
            canvas.width
        } else {
            canvas.height
        };
        (rect_field(picture, key) - rect_field(staged, key)).abs() * along <= 1.0
    });
    let whole = if box_is_frame {
        patch
    } else {
        let mut merged = TransformPatch::of_rect(picture);
        for (key, _) in TRANSFORM_FIELDS {
            if let Some(value) = patch.get(key) {
                merged.set(key, value);
            }
        }
        merged
    };
    picture_edit_to_frame(whole, kind, stage_margin, camera_on_stage)
}

/// `cropEditOnPicture`: a typed crop while the box is the picture keeps the
/// uncropped picture in place; the box shrinks to what is kept.
pub fn crop_edit_on_picture(
    next: StageCrop,
    picture: StageRect,
    committed: StageCrop,
) -> StageRect {
    let kept_x = (1.0 - committed.left - committed.right).max(MIN_CROP_KEPT);
    let kept_y = (1.0 - committed.top - committed.bottom).max(MIN_CROP_KEPT);
    let full_width = picture.width / kept_x;
    let full_height = picture.height / kept_y;
    let full_x = picture.x - committed.left * full_width;
    let full_y = picture.y - committed.top * full_height;
    let next_kept_x = (1.0 - next.left - next.right).max(MIN_CROP_KEPT);
    let next_kept_y = (1.0 - next.top - next.bottom).max(MIN_CROP_KEPT);
    StageRect::new(
        round4(full_x + next.left * full_width),
        round4(full_y + next.top * full_height),
        round4(full_width * next_kept_x),
        round4(full_height * next_kept_y),
    )
}

/// The crop with one side set.
pub fn with_crop_field(crop: StageCrop, field: &str, value: f64) -> StageCrop {
    let mut next = crop;
    match field {
        "cropLeft" => next.left = value,
        "cropTop" => next.top = value,
        "cropRight" => next.right = value,
        _ => next.bottom = value,
    }
    next
}

/// `pixelReadout`.
pub fn pixel_readout(rect: StageRect, output_width: f64, output_height: f64) -> String {
    let width = js_round(rect.width * output_width.max(0.0));
    let height = js_round(rect.height * output_height.max(0.0));
    format!(
        "{} × {} px on {} × {}",
        width as i64, height as i64, output_width as i64, output_height as i64
    )
}

// ── Screen size and Zoom ───────────────────────────────────────────────

pub const SCREEN_SIZE_MIN: f64 = 60.0;
pub const SCREEN_SIZE_MAX: f64 = 100.0;
pub const SCREEN_SIZE_DEFAULT: f64 = 80.0;

/// `screenSizeOf`: the screen's share of the canvas for a Visibility.
pub fn screen_size_of(visibility_percent: f64) -> f64 {
    SCREEN_SIZE_MAX - visibility_percent.clamp(0.0, 40.0)
}

/// `visibilityForScreenSize`.
pub fn visibility_for_screen_size(screen_size: f64) -> f64 {
    SCREEN_SIZE_MAX - screen_size.clamp(SCREEN_SIZE_MIN, SCREEN_SIZE_MAX)
}

pub const SCREEN_ZOOM_MIN: f64 = 100.0;
pub const SCREEN_ZOOM_MAX: f64 = MAX_SOURCE_FRACTION * 100.0;

/// `screenZoomOf`.
pub fn screen_zoom_of(rect: StageRect) -> f64 {
    js_round(rect.width.max(rect.height) * 100.0).clamp(SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX)
}

/// `screenZoomPatch`: both axes scaled around the centre.
pub fn screen_zoom_patch(committed: StageRect, zoom_percent: f64) -> StageRect {
    let zoom = zoom_percent.clamp(SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX) / 100.0;
    let longer = committed.width.max(committed.height);
    let scale = if longer > 0.0 { zoom / longer } else { 1.0 };
    let width = committed.width * scale;
    let height = committed.height * scale;
    let center_x = committed.x + committed.width / 2.0;
    let center_y = committed.y + committed.height / 2.0;
    round_rect_for_commit(StageRect::new(
        clamp_source_position(center_x - width / 2.0, width),
        clamp_source_position(center_y - height / 2.0, height),
        width,
        height,
    ))
}

// ── Camera look (`lib/camera-look.ts`, `camera-look-controls.tsx`) ─────

/// A camera's look as the sliders show it (-100 to 100 each).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LookSliders {
    pub brightness: i32,
    pub contrast: i32,
    pub saturation: i32,
}

/// The sliders for a stored look (`NEUTRAL_CAMERA_LOOK` when none).
pub fn look_sliders(look: Option<&Value>) -> LookSliders {
    let read = |key: &str, fallback: f64| {
        look.and_then(|look| look.get(key))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(fallback)
    };
    LookSliders {
        brightness: js_round(read("brightness", 0.0) * 400.0) as i32,
        contrast: js_round((read("contrast", 1.0) - 1.0) * 200.0) as i32,
        saturation: js_round((read("saturation", 1.0) - 1.0) * 100.0) as i32,
    }
}

/// The look the sliders stand for (`{brightness, contrast, saturation}`).
pub fn look_of_sliders(sliders: LookSliders) -> Value {
    json!({
        "brightness": f64::from(sliders.brightness) / 400.0,
        "contrast": 1.0 + f64::from(sliders.contrast) / 200.0,
        "saturation": 1.0 + f64::from(sliders.saturation) / 100.0,
    })
}

/// `normalizeCameraLook`: clamped, `None` when neutral.
pub fn normalize_camera_look(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let clamp = |key: &str, fallback: f64, min: f64, max: f64| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map_or(fallback, |value| value.clamp(min, max))
    };
    let brightness = clamp("brightness", 0.0, -0.25, 0.25);
    let contrast = clamp("contrast", 1.0, 0.5, 1.5);
    let saturation = clamp("saturation", 1.0, 0.0, 2.0);
    if brightness == 0.0 && contrast == 1.0 && saturation == 1.0 {
        return None;
    }
    Some(json!({ "brightness": brightness, "contrast": contrast, "saturation": saturation }))
}

// ── Overlay items (`lib/overlay-layout.ts`) ────────────────────────────

const LANDSCAPE_SIDE_MARGIN: f64 = 0.04 * 9.0 / 16.0;
const LANDSCAPE_EDGE_MARGIN: f64 = 0.04;
const PORTRAIT_SIDE_MARGIN: f64 = 0.04 * 16.0 / 9.0;
const PORTRAIT_TOP_MARGIN: f64 = 0.08;
const PORTRAIT_BOTTOM_MARGIN: f64 = 0.22;

/// `OVERLAY_SNAPS` with `OVERLAY_SNAP_LABELS`.
pub const OVERLAY_SNAPS: [(&str, &str); 5] = [
    ("top-left", "Top left"),
    ("top-right", "Top right"),
    ("bottom-left", "Bottom left"),
    ("bottom-right", "Bottom right"),
    ("bottom-center", "Bottom center"),
];

/// `overlayDefaultSize`.
pub fn overlay_default_size(item: &str, vertical: bool) -> (f64, f64) {
    match (item, vertical) {
        ("highlight", true) => (0.78, 0.2),
        ("highlight", false) => (0.6, 0.26),
        ("captions", true) => (0.76, 0.14),
        ("captions", false) => (0.92, 0.16),
        ("buddy", true) => (0.32, 0.32 * 9.0 / 16.0),
        ("buddy", false) => (0.18, 0.18 * 16.0 / 9.0),
        (_, true) => (0.8, 0.3),
        (_, false) => (0.3, 0.44),
    }
}

/// `overlayPlaceOrigin`: an item's top-left corner at a place, inside the
/// overlay margins.
pub fn overlay_place_origin(place: &str, vertical: bool, w: f64, h: f64) -> (f64, f64) {
    let side = if vertical {
        PORTRAIT_SIDE_MARGIN
    } else {
        LANDSCAPE_SIDE_MARGIN
    };
    let top = if vertical {
        PORTRAIT_TOP_MARGIN
    } else {
        LANDSCAPE_EDGE_MARGIN
    };
    let bottom = if vertical {
        PORTRAIT_BOTTOM_MARGIN
    } else {
        LANDSCAPE_EDGE_MARGIN
    };
    let x = if place.ends_with("-left") {
        side
    } else if place.ends_with("-right") {
        1.0 - side - w
    } else {
        (1.0 - w) / 2.0
    };
    let y = if place.starts_with("top-") {
        top
    } else if place.starts_with("bottom-") {
        1.0 - bottom - h
    } else {
        top + (1.0 - top - bottom - h) / 2.0
    };
    (x, y)
}

/// `overlaySnapRect`: the item's default size at the snap.
pub fn overlay_snap_rect(item: &str, vertical: bool, snap: &str) -> OverlayRect {
    let (w, h) = overlay_default_size(item, vertical);
    let (x, y) = overlay_place_origin(snap, vertical, w, h);
    OverlayRect::new(round6(x.max(0.0)), round6(y.max(0.0)), round6(w), round6(h))
}

/// The layout with one item's rect for one orientation (`withOverlayRect`).
pub fn with_overlay_rect(layout: &Value, item: &str, vertical: bool, rect: OverlayRect) -> Value {
    let mut next = layout.clone();
    let key = super::stage::overlay_orientation_key(vertical);
    next[item][key] = json!({ "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h });
    next
}

/// `withOverlaySwitches`.
pub fn with_overlay_switches(layout: &Value, item: &str, key: &str, on: bool) -> Value {
    let mut next = layout.clone();
    next[item][key] = json!(on);
    next
}

/// `OVERLAY_ITEM_DESCRIPTIONS`.
pub fn overlay_item_description(item: &str) -> &'static str {
    match item {
        "highlight" => copy::HIGHLIGHT_DESCRIPTION,
        "captions" => copy::CAPTIONS_DESCRIPTION,
        "buddy" => copy::BUDDY_DESCRIPTION,
        _ => copy::CHAT_DESCRIPTION,
    }
}

/// `OVERLAY_ITEM_OFF_LINES` while both switches are off.
pub fn overlay_item_off_line(item: &str) -> Option<&'static str> {
    match item {
        "buddy" => Some(copy::BUDDY_OFF_LINE),
        "chat" => Some(copy::CHAT_OFF_LINE),
        _ => None,
    }
}

// ── Banners (`lib/banner-place.ts`, `banner-size.ts`, `banner-timing.ts`) ─

/// `BANNER_SNAPS` with `BANNER_SNAP_LABELS`.
pub const BANNER_SNAPS: [(&str, &str); 7] = [
    ("top-left", "Top left"),
    ("top-center", "Top center"),
    ("top-right", "Top right"),
    ("bottom-left", "Bottom left"),
    ("bottom-center", "Bottom center"),
    ("bottom-right", "Bottom right"),
    ("full-frame", "Full frame"),
];

/// The backend's limit on banners showing at once (`BANNER_MAX_SHOWN`).
pub const BANNER_MAX_SHOWN: usize = 4;
/// "Hide after" and "Show every" (0 is Off).
pub const BANNER_HIDE_AFTER_CHOICES: [u32; 5] = [0, 10, 30, 60, 300];
pub const BANNER_REPEAT_CHOICES: [u32; 5] = [0, 5, 10, 15, 30];
pub const BANNER_SHARP_FRACTION: f64 = 0.9;
const CENTER_GRAVITY_BAND: f64 = 0.02;

/// `bannerStateLine`: the selected banner's first row.
pub fn banner_state_line(banner: &Banner) -> (&'static str, &'static str) {
    if !banner.shown {
        return ("hidden", copy::BANNER_HIDDEN_LINE);
    }
    if !banner.show_on_stream && !banner.show_in_recording {
        return ("off", copy::BANNER_OFF_LINE);
    }
    ("shown", copy::BANNER_SHOWING_LINE)
}

/// `bannerSecondsLabel`.
pub fn banner_seconds_label(seconds: u32) -> String {
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = seconds / 60;
    let rest = seconds % 60;
    if rest == 0 {
        format!("{minutes} min")
    } else {
        format!("{minutes} min {rest} s")
    }
}

/// `bannerMinutesLabel`.
pub fn banner_minutes_label(minutes: u32) -> String {
    format!("{minutes} min")
}

/// `bannerTimingChoices`: the standard ones, plus a stored value outside.
pub fn banner_timing_choices(standard: &[u32], current: u32) -> Vec<u32> {
    let mut choices = standard.to_vec();
    if !choices.contains(&current) {
        choices.push(current);
        choices.sort_unstable();
    }
    choices
}

/// `bannerTimingSummary`.
pub fn banner_timing_summary(hide_after: u32, repeat: u32) -> Option<String> {
    match (hide_after > 0, repeat > 0) {
        (true, true) => Some(format!(
            "Shows for {} every {}",
            banner_seconds_label(hide_after),
            banner_minutes_label(repeat)
        )),
        (false, true) => Some(format!("Every {}", banner_minutes_label(repeat))),
        (true, false) => Some(format!("Hides after {}", banner_seconds_label(hide_after))),
        (false, false) => None,
    }
}

/// `overlayRectHorizontalGravity`: -1 left, 0 centre, 1 right.
fn horizontal_gravity(rect: &OverlayRect) -> i8 {
    let center = rect.x + rect.w / 2.0;
    if center < 0.5 - CENTER_GRAVITY_BAND {
        -1
    } else if center > 0.5 + CENTER_GRAVITY_BAND {
        1
    } else {
        0
    }
}

fn bottom_gravity(rect: &OverlayRect) -> bool {
    rect.y + rect.h / 2.0 >= 0.5
}

/// `overlayRectPixels`.
fn overlay_rect_pixels(rect: &OverlayRect, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let clamp = |value: f64, max: f64| js_round(value * max).clamp(0.0, max);
    let left = clamp(rect.x, width);
    let right = left.max(clamp(rect.x + rect.w, width));
    let top = clamp(rect.y, height);
    let bottom = top.max(clamp(rect.y + rect.h, height));
    (left, top, right, bottom)
}

/// `bannerDrawRect`'s size: the image contained in its rect, in pixels.
pub fn banner_draw_size(
    image_width: f64,
    image_height: f64,
    canvas_width: f64,
    canvas_height: f64,
    rect: &OverlayRect,
) -> (f64, f64) {
    let canvas_w = canvas_width.floor().max(1.0);
    let canvas_h = canvas_height.floor().max(1.0);
    let image_w = image_width.floor().max(1.0);
    let image_h = image_height.floor().max(1.0);
    let (left, top, right, bottom) = overlay_rect_pixels(rect, canvas_w, canvas_h);
    let rw = (right - left).max(1.0);
    let rh = (bottom - top).max(1.0);
    if image_w * rh <= image_h * rw {
        (rw.min(js_round(image_w * rh / image_h).max(1.0)), rh)
    } else {
        (rw, rh.min(js_round(image_h * rw / image_w).max(1.0)))
    }
}

/// `bannerFitRect`: the image's own rect inside its place.
pub fn banner_fit_overlay(
    banner: &Banner,
    rect: &OverlayRect,
    canvas_aspect: f64,
    vertical: bool,
) -> OverlayRect {
    let aspect = if canvas_aspect.is_finite() && canvas_aspect > 0.0 {
        canvas_aspect
    } else if vertical {
        9.0 / 16.0
    } else {
        16.0 / 9.0
    };
    let image_aspect = f64::from(banner.width.max(1)) / f64::from(banner.height.max(1));
    let mut w = rect.w;
    let mut h = rect.h;
    if image_aspect * rect.h <= rect.w * aspect {
        w = image_aspect * rect.h / aspect;
    } else {
        h = rect.w * aspect / image_aspect;
    }
    let x = match horizontal_gravity(rect) {
        -1 => rect.x,
        0 => rect.x + (rect.w - w) / 2.0,
        _ => rect.x + rect.w - w,
    };
    let y = if bottom_gravity(rect) {
        rect.y + rect.h - h
    } else {
        rect.y
    };
    let clamped = clamp_overlay_rect(StageRect::new(x, y, w, h));
    OverlayRect::new(clamped.x, clamped.y, clamped.width, clamped.height)
}

/// `bannerSnapRect`: a banner keeps its size and only moves; Full frame
/// fills the canvas.
pub fn banner_snap_rect(
    banner: &Banner,
    vertical: bool,
    canvas_aspect: f64,
    snap: &str,
) -> OverlayRect {
    if snap == "full-frame" {
        return OverlayRect::new(0.0, 0.0, 1.0, 1.0);
    }
    let rect = if vertical {
        &banner.vertical
    } else {
        &banner.horizontal
    };
    let fit = banner_fit_overlay(banner, rect, canvas_aspect, vertical);
    let (x, y) = overlay_place_origin(snap, vertical, fit.w, fit.h);
    let clamped = clamp_overlay_rect(StageRect::new(x, y, fit.w, fit.h));
    OverlayRect::new(clamped.x, clamped.y, clamped.width, clamped.height)
}

/// `HTML_OVERLAY_MAX_FRAME_PIXELS`: the most an HTML banner is drawn at.
pub const HTML_OVERLAY_MAX_FRAME_PIXELS: f64 = 1920.0 * 1080.0;

/// `htmlOverlayStatusLine`'s answer: the line, and whether the streamer has
/// to act on it (`warn`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlOverlayLine {
    pub state: videorc_protocol::HtmlOverlayState,
    pub line: String,
    pub warn: bool,
}

/// `htmlOverlayStatusLine` (plan 232, #1323): what the banner inspector says
/// about an HTML banner's page, or nothing while there is nothing to say (it
/// is hidden, or live with nothing blocked). A page that asked for the
/// network keeps running without it (D5), so that line is quiet.
pub fn html_overlay_status_line(
    banner: &Banner,
    status: Option<&videorc_protocol::HtmlOverlayStatus>,
) -> Option<HtmlOverlayLine> {
    use videorc_protocol::HtmlOverlayState;
    if banner.kind != videorc_protocol::BannerKind::Html || !banner.shown {
        return None;
    }
    let status = status?;
    match status.state {
        HtmlOverlayState::Loading => Some(HtmlOverlayLine {
            state: status.state,
            line: copy::HTML_OVERLAY_LOADING_LINE.to_string(),
            warn: false,
        }),
        HtmlOverlayState::Failed | HtmlOverlayState::Unavailable => Some(HtmlOverlayLine {
            state: status.state,
            line: status
                .detail
                .clone()
                .unwrap_or_else(|| copy::HTML_OVERLAY_STOPPED.to_string()),
            warn: true,
        }),
        _ => {
            let blocked = status.blocked_requests.unwrap_or(0);
            (blocked > 0).then(|| HtmlOverlayLine {
                state: status.state,
                line: format!(
                    "The network is off for HTML banners: {} blocked. Put fonts, images and scripts in the banner's folder.",
                    if blocked == 1 {
                        "1 request was".to_string()
                    } else {
                        format!("{blocked} requests were")
                    }
                ),
                warn: false,
            })
        }
    }
}

/// `bannerSizeAdvice`'s two lines and its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerSizeAdvice {
    pub size_line: String,
    pub verdict_line: String,
    pub sharp: bool,
}

fn resolution(width: f64, height: f64) -> String {
    format!("{} × {}", js_round(width) as i64, js_round(height) as i64)
}

/// `bannerSizeAdvice`: where the banner is drawn largest and whether the
/// image is that big.
pub fn banner_size_advice(
    banner: &Banner,
    output: (f64, f64),
    vertical_stream: Option<(f64, f64)>,
) -> BannerSizeAdvice {
    let mut canvases = vec![("recording", output)];
    if let Some(stream) = vertical_stream {
        canvases.push(("vertical stream", stream));
    }
    let mut chosen = canvases[0];
    let mut drawn = (0.0, 0.0);
    for candidate in &canvases {
        let (width, height) = candidate.1;
        let rect = if height > width {
            &banner.vertical
        } else {
            &banner.horizontal
        };
        let size = banner_draw_size(
            f64::from(banner.width),
            f64::from(banner.height),
            width,
            height,
            rect,
        );
        if size.0 > drawn.0 || (size.0 == drawn.0 && size.1 > drawn.1) {
            chosen = *candidate;
            drawn = size;
        }
    }
    let even = |value: f64| {
        if value % 2.0 == 0.0 {
            value
        } else {
            value + 1.0
        }
    };
    let needed = (even(drawn.0), even(drawn.1));
    let size_line = format!(
        "Size on your {} {}: {} px",
        resolution(chosen.1.0, chosen.1.1),
        chosen.0,
        resolution(needed.0, needed.1)
    );
    if banner.kind == videorc_protocol::BannerKind::Html {
        // Plan 232 D7 (#1323): a page is drawn at the pixels it lands on, up
        // to a 1080p frame's worth; past that it is scaled up from there.
        let capped = needed.0 * needed.1 > HTML_OVERLAY_MAX_FRAME_PIXELS;
        return BannerSizeAdvice {
            size_line,
            verdict_line: if capped {
                copy::HTML_BANNER_SOFT.to_string()
            } else {
                copy::HTML_BANNER_SHARP.to_string()
            },
            sharp: !capped,
        };
    }
    let sharp = f64::from(banner.width) >= BANNER_SHARP_FRACTION * needed.0;
    let image = resolution(f64::from(banner.width), f64::from(banner.height));
    let needed_words = resolution(needed.0, needed.1);
    BannerSizeAdvice {
        size_line,
        verdict_line: if sharp {
            format!("Your image is {image} px: sharp at this size.")
        } else {
            format!(
                "Your image is {image} px: it will look soft at this size. Use one at least {needed_words} px."
            )
        },
        sharp,
    }
}

/// `bannerOrderAfterMove`: the ids with one moved, or `None` when nothing
/// moves.
pub fn banner_order_after_move(banners: &[Banner], id: &str, target: usize) -> Option<Vec<String>> {
    let mut ids: Vec<String> = banners.iter().map(|banner| banner.id.clone()).collect();
    let from = ids.iter().position(|candidate| candidate == id)?;
    let to = target.min(ids.len().saturating_sub(1));
    if from == to {
        return None;
    }
    let moved = ids.remove(from);
    ids.insert(to, moved);
    Some(ids)
}

// ── Password managers (`lib/privacy-settings.ts`) ──────────────────────

/// One row of the password-manager list (`PasswordManagerEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordManagerEntry {
    /// Its first bundle id (a built-in app's) or the added one's.
    pub id: String,
    pub name: String,
    pub bundle_ids: Vec<String>,
    pub built_in: bool,
}

fn entries_of(settings: &PrivacySettings) -> Vec<PasswordManagerEntry> {
    let removed: Vec<String> = settings
        .removed_password_manager_bundle_ids
        .iter()
        .map(|id| id.to_lowercase())
        .collect();
    let built_in = BUILT_IN_PASSWORD_MANAGERS
        .iter()
        .filter(|(_, ids)| !ids.iter().all(|id| removed.contains(&id.to_lowercase())))
        .map(|(name, ids)| PasswordManagerEntry {
            id: ids[0].to_string(),
            name: (*name).to_string(),
            bundle_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            built_in: true,
        });
    let added = settings
        .added_password_managers
        .iter()
        .map(|app| PasswordManagerEntry {
            id: app.bundle_id.clone(),
            name: app.name.clone(),
            bundle_ids: vec![app.bundle_id.clone()],
            built_in: false,
        });
    built_in.chain(added).collect()
}

/// `passwordManagerEntries`: never empty.
pub fn password_manager_entries(settings: &PrivacySettings) -> Vec<PasswordManagerEntry> {
    let entries = entries_of(settings);
    if entries.is_empty() {
        entries_of(&PrivacySettings::default())
    } else {
        entries
    }
}

/// `builtInPasswordManagersRemoved`.
pub fn built_in_password_managers_removed(settings: &PrivacySettings) -> bool {
    entries_of(settings)
        .iter()
        .filter(|entry| entry.built_in)
        .count()
        < BUILT_IN_PASSWORD_MANAGERS.len()
}

/// `canRemovePasswordManager`: never the last one.
pub fn can_remove_password_manager(settings: &PrivacySettings) -> bool {
    entries_of(settings).len() > 1
}

/// `removePasswordManager`: an added app is forgotten, a built-in one is
/// remembered as removed; the last row stays.
pub fn remove_password_manager(settings: &PrivacySettings, id: &str) -> PrivacySettings {
    if !can_remove_password_manager(settings) {
        return settings.clone();
    }
    let key = id.to_lowercase();
    if let Some((_, ids)) = BUILT_IN_PASSWORD_MANAGERS
        .iter()
        .find(|(_, ids)| ids.iter().any(|candidate| candidate.to_lowercase() == key))
    {
        let removed: Vec<String> = settings
            .removed_password_manager_bundle_ids
            .iter()
            .map(|id| id.to_lowercase())
            .collect();
        let mut next = settings.clone();
        for bundle_id in ids.iter() {
            if !removed.contains(&bundle_id.to_lowercase()) {
                next.removed_password_manager_bundle_ids
                    .push((*bundle_id).to_string());
            }
        }
        return next;
    }
    let mut next = settings.clone();
    next.added_password_managers
        .retain(|app| app.bundle_id.to_lowercase() != key);
    next
}

/// `restoreBuiltInPasswordManagers`.
pub fn restore_built_in_password_managers(settings: &PrivacySettings) -> PrivacySettings {
    let mut next = settings.clone();
    next.removed_password_manager_bundle_ids.clear();
    next
}

// ── The views ──────────────────────────────────────────────────────────

/// One layout of the Layout section's segmented control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetOptionView {
    pub id: &'static str,
    /// The layout's name; it stays while its switch runs (#1312).
    pub label: String,
    pub disabled: bool,
    /// A switch is putting this layout on: the row shows the pending mark
    /// beside its name (`SceneSwitchPending`).
    pub pending: bool,
    /// D19: it draws a screen and the scene on stream shows none, so it
    /// opens Change screen… instead of applying.
    pub asks_for_screen: bool,
}

/// `LAYOUT_PRESET_LABELS` (`lib/layout-labels.ts`): one name per layout
/// everywhere. A vertical layout reads like its horizontal twin, because a
/// list shows one orientation at a time.
pub fn layout_preset_label(preset: &str) -> &'static str {
    match preset {
        "screen-camera" | "vertical-screen-camera" => "Screen + camera",
        "screen-only" | "vertical-screen-only" => "Screen only",
        "camera-only" | "vertical-camera-only" => "Camera only",
        "side-by-side" => "Side by side",
        "vertical-camera-top" => "Camera top",
        "vertical-camera-bottom" => "Camera bottom",
        "vertical-split" => "Split",
        _ => "",
    }
}

/// The Layout section (`LayoutTab`'s first `PanelSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutSectionView {
    pub vertical: bool,
    /// Why the orientation can't change (a session runs).
    pub orientation_lock: Option<&'static str>,
    pub presets: Vec<PresetOptionView>,
    /// The checked preset; `None` in Freeform.
    pub preset_index: Option<usize>,
    /// A pointer gesture on the stage takes the presets out of play.
    pub presets_enabled: bool,
    pub freeform: bool,
    pub freeform_enabled: bool,
    pub freeform_label: &'static str,
    /// A switch is putting Freeform on: the pending mark beside its name.
    pub freeform_pending: bool,
    /// The line under the presets; `true` with the door to Sources.
    pub hint: Option<(&'static str, bool)>,
    /// `ScreenFramingControl`: Fit, its line, the vertical studio's.
    pub framing: Option<(bool, &'static str, bool)>,
    pub animate: bool,
}

/// What the Layout section reads.
pub struct LayoutInput<'a> {
    pub layout: &'a Value,
    pub sources: &'a Value,
    pub session_active: bool,
    pub stage_busy: bool,
    pub has_scene: bool,
    /// The preset a switch is putting on (`layoutSwitchPending`), and
    /// whether that is Freeform.
    pub pending: Option<(&'a str, bool)>,
    pub animate: bool,
    /// D19: a scene is on stream and it shows no screen (`sceneOnStream`'s
    /// `shows` is `none`).
    pub on_stream_shows_no_screen: bool,
}

fn non_empty(sources: &Value, key: &str) -> bool {
    sources
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
}

/// `hasSelectedCameraSource`.
pub fn has_camera(sources: &Value) -> bool {
    non_empty(sources, "cameraId")
}

/// `hasSelectedScreenSource`.
pub fn has_screen(sources: &Value) -> bool {
    non_empty(sources, "screenId")
        || non_empty(sources, "windowId")
        || sources.get("testPattern") == Some(&Value::Bool(true))
}

fn needs_camera(preset: &str) -> bool {
    matches!(
        preset,
        "screen-camera"
            | "camera-only"
            | "side-by-side"
            | "vertical-camera-top"
            | "vertical-camera-bottom"
            | "vertical-split"
            | "vertical-screen-camera"
            | "vertical-camera-only"
    )
}

fn needs_screen(preset: &str) -> bool {
    matches!(
        preset,
        "screen-camera"
            | "screen-only"
            | "side-by-side"
            | "vertical-camera-top"
            | "vertical-camera-bottom"
            | "vertical-split"
            | "vertical-screen-camera"
            | "vertical-screen-only"
    )
}

/// The landscape scenes whose screen fits or fills by the user's choice.
fn landscape_screen_framed(preset: &str) -> bool {
    preset == "screen-camera" || preset == "screen-only"
}

pub fn layout_section_view(input: &LayoutInput<'_>) -> LayoutSectionView {
    let preset = text(input.layout, "layoutPreset");
    let vertical = preset.starts_with("vertical-");
    let freeform = text(input.layout, "arrangementMode") == "freeform";
    let camera = has_camera(input.sources);
    let screen = has_screen(input.sources);
    let all: &[&'static str] = if vertical {
        &crate::studio::capture_config::VERTICAL_LAYOUT_PRESETS
    } else {
        &crate::studio::capture_config::HORIZONTAL_LAYOUT_PRESETS
    };
    let presets: Vec<PresetOptionView> = all
        .iter()
        .map(|&id| {
            let asks_for_screen = input.on_stream_shows_no_screen && needs_screen(id);
            PresetOptionView {
                id,
                label: layout_preset_label(id).to_string(),
                // A scene that shows no screen asks for one (D19) instead.
                disabled: (needs_camera(id) && !camera)
                    || (needs_screen(id) && !screen && !asks_for_screen),
                pending: input
                    .pending
                    .is_some_and(|(pending, is_freeform)| !is_freeform && pending == id),
                asks_for_screen,
            }
        })
        .collect();
    let preset_index = (!freeform)
        .then(|| presets.iter().position(|option| option.id == preset))
        .flatten();
    let hint = if input.session_active {
        Some((copy::LIVE_SWITCH_HINT, false))
    } else if !screen {
        Some((copy::NO_SCREEN_HINT, true))
    } else if !camera {
        Some((
            if vertical {
                copy::NO_CAMERA_HINT_VERTICAL
            } else {
                copy::NO_CAMERA_HINT
            },
            true,
        ))
    } else {
        None
    };
    let framing = if vertical {
        let fit = text(input.layout, "verticalScreenFraming") == "fit";
        Some((
            fit,
            if fit {
                copy::FRAMING_FIT_VERTICAL
            } else {
                copy::FRAMING_FILL_VERTICAL
            },
            true,
        ))
    } else if screen && landscape_screen_framed(preset) {
        let fit = text(input.layout, "horizontalScreenFraming") != "fill";
        Some((
            fit,
            if fit {
                copy::FRAMING_FIT_HORIZONTAL
            } else {
                copy::FRAMING_FILL_HORIZONTAL
            },
            false,
        ))
    } else {
        None
    };
    LayoutSectionView {
        vertical,
        orientation_lock: input
            .session_active
            .then_some(copy::ORIENTATION_LOCK_REASON),
        presets,
        preset_index,
        presets_enabled: !input.stage_busy,
        freeform,
        freeform_enabled: input.has_scene && !input.stage_busy,
        freeform_label: copy::FREEFORM,
        freeform_pending: input.pending.is_some_and(|(_, is_freeform)| is_freeform),
        hint,
        framing,
        animate: input.animate,
    }
}

/// The aspect lock and the box's fields (`SourceTransformFields`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformFieldsView {
    pub values: [String; 4],
    pub enabled: bool,
    pub aspect_locked: bool,
    /// The lock can be pressed.
    pub lock_enabled: bool,
    /// What the lock says on hover: why it can't move, or what it does.
    pub lock_tip: String,
    /// The forced aspect's reason, under the fields.
    pub forced_line: Option<&'static str>,
    pub pixel_line: String,
    /// Why the fields are off, under them.
    pub disabled_line: Option<&'static str>,
}

/// A source's crop fields (`SourceCropFields`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CropFieldsView {
    pub values: [String; 4],
    pub enabled: bool,
    pub cropped: bool,
}

/// The camera's placement rows (`CameraInspector`'s `placement`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CameraPlacementView {
    /// Side by side's split (50/50, 60/40, 70/30) and side (left, right).
    pub split: Option<usize>,
    pub side: Option<usize>,
    /// The corner; `Some(None)` while the camera has its own box.
    pub corner: Option<Option<usize>>,
    pub size: Option<usize>,
    pub shape: Option<usize>,
    pub radius: Option<i32>,
    /// The aspect and whether it crops (the line under it).
    pub aspect: Option<(usize, bool)>,
    pub margin: Option<i32>,
}

/// The camera's Lens, look and Green screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraLensView {
    pub description: Option<&'static str>,
    /// Fill crop (0) or Fit frame (1); `None` where the camera always fills.
    pub fit: Option<usize>,
    pub mirror: bool,
    pub zoom: i32,
    pub pan_x: i32,
    pub pan_y: i32,
    pub look: LookSliders,
    pub look_reason: Option<&'static str>,
    pub look_reset_enabled: bool,
}

/// The selection's Placement section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementView {
    pub description: Option<String>,
    /// A source's Reset (shown with its state); the camera has none.
    pub reset: Option<bool>,
    pub camera: Option<CameraPlacementView>,
    pub fields: Option<TransformFieldsView>,
    /// A Freeform screen's Zoom (100 to 400) and its lock.
    pub zoom: Option<(i32, bool)>,
    pub crop: Option<CropFieldsView>,
    /// The arrows (shown with their state); the camera has none.
    pub nudge: Option<bool>,
}

/// The overlay item's section (`OverlayItemSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayView {
    pub item: &'static str,
    pub off_line: Option<&'static str>,
    pub description: &'static str,
    pub show_on_stream: bool,
    pub show_in_recording: bool,
    /// #1593: the captions item has no switches of its own; its Live
    /// captions row says this and opens Captions.
    pub captions_summary: Option<&'static str>,
    pub blocked: Option<&'static str>,
    pub snap_label: &'static str,
}

/// One timer choice of a banner's Select.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingChoice {
    pub value: u32,
    pub label: String,
}

/// The selected banner's section (`BannerInspector`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerView {
    pub id: String,
    pub name: String,
    pub state: &'static str,
    pub state_line: &'static str,
    pub shown: bool,
    pub show_enabled: bool,
    pub show_reason: Option<&'static str>,
    pub blocked: Option<&'static str>,
    pub place_label: &'static str,
    pub advice: BannerSizeAdvice,
    pub opacity: i32,
    pub on_stream: bool,
    pub in_recording: bool,
    pub in_front: bool,
    pub at_back: bool,
    pub timing_summary: Option<String>,
    pub hide_after: Vec<TimingChoice>,
    pub hide_after_index: usize,
    pub repeat: Vec<TimingChoice>,
    pub repeat_index: usize,
}

/// Which inspector shows (`layout-tab.tsx`'s chain of sections).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectorKind {
    Empty,
    Camera,
    FullCanvas,
    Source,
    Overlay,
    Banner,
}

/// The selection's own section and what follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectorView {
    pub kind: InspectorKind,
    pub source_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    /// Visible in scene: on, enabled, why not.
    pub visibility: Option<(bool, bool, Option<&'static str>)>,
    /// Screen size (60 to 100) and why it can't change.
    pub screen_size: Option<(i32, Option<&'static str>)>,
    pub placement: Option<PlacementView>,
    pub lens: Option<CameraLensView>,
    pub overlay: Option<OverlayView>,
    pub banner: Option<BannerView>,
}

/// The stage's one selection, as the inspector reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectorSelection {
    None,
    Source(String),
    Overlay(&'static str),
    Banner(String),
}

/// What the inspector reads.
pub struct InspectorInput<'a> {
    pub layout: &'a Value,
    pub sources: &'a Value,
    pub video: (f64, f64),
    pub vertical_stream: Option<(f64, f64)>,
    /// S3.3x.2: the Canvas shows the vertical stream's overlays ("Overlays
    /// on" Vertical, `verticalView`): the snaps and places are that stream's.
    pub vertical_view: bool,
    pub scene_sources: &'a [SceneSource],
    pub has_background: bool,
    pub selection: InspectorSelection,
    /// The selected source's picture as the stage shows it.
    pub picture: Option<StageRect>,
    /// A Freeform screen's box is its picture (plan 216 D2).
    pub box_is_picture: bool,
    pub aspect_locked: bool,
    pub scene_edit_mode: bool,
    pub session_active: bool,
    pub accepts_live_scene_edits: Option<bool>,
    pub stage_dragging: bool,
    pub connected: bool,
    pub visibility_percent: Option<f64>,
    pub overlay_layout: Option<&'a Value>,
    /// #1593: the capture config's Captions settings (`enabled`,
    /// `burnTarget`), which alone say where captions show.
    pub captions: Option<&'a Value>,
    pub banners: &'a [Banner],
}

/// `captionsOutputSwitches` (`lib/captions-output.ts`, #1593): where
/// captions go, from the Captions settings alone. Nowhere while Live
/// captions is off, the stream always while it is on, and the recording too
/// for "Live stream and recording".
pub fn captions_output_switches(captions: Option<&Value>) -> (bool, bool) {
    let enabled = captions.and_then(|captions| captions.get("enabled")) == Some(&Value::Bool(true));
    let both = captions
        .and_then(|captions| captions.get("burnTarget"))
        .and_then(Value::as_str)
        == Some("both");
    (enabled, enabled && both)
}

/// `overlayLayoutForDisplay`: the layout the stage and the inspector show,
/// with the captions item's switches read from the Captions settings. For
/// display only; writes go through the saved layout.
pub fn overlay_layout_for_display(layout: &Value, captions: Option<&Value>) -> Value {
    let (on_stream, in_recording) = captions_output_switches(captions);
    let item = &layout["captions"];
    if item.get("showOnStream") == Some(&Value::Bool(on_stream))
        && item.get("showInRecording") == Some(&Value::Bool(in_recording))
    {
        return layout.clone();
    }
    let mut next = layout.clone();
    if let Some(Value::Object(item)) = next.get_mut("captions") {
        item.insert("showOnStream".into(), Value::Bool(on_stream));
        item.insert("showInRecording".into(), Value::Bool(in_recording));
    }
    next
}

/// `captionsOutputsSummary`: the captions item's Live captions row.
pub fn captions_outputs_summary(on_stream: bool, in_recording: bool) -> &'static str {
    match (on_stream, in_recording) {
        (false, _) => "Off",
        (true, true) => "On, live stream and recording",
        (true, false) => "On, live stream only",
    }
}

fn segment(options: &[&str], value: &str) -> Option<usize> {
    options.iter().position(|option| *option == value)
}

fn transform_fields(
    picture: StageRect,
    enabled: bool,
    lock_reason: Option<&'static str>,
    forced: Option<&'static str>,
    aspect_locked_choice: bool,
    video: (f64, f64),
) -> TransformFieldsView {
    let aspect_locked = forced.is_some() || aspect_locked_choice;
    let blocked = if !enabled { lock_reason } else { forced };
    TransformFieldsView {
        values: TRANSFORM_FIELDS.map(|(key, _)| format_percent_value(rect_field(picture, key))),
        enabled,
        aspect_locked,
        lock_enabled: enabled && forced.is_none(),
        lock_tip: blocked.map_or_else(
            || {
                if aspect_locked {
                    copy::ASPECT_LOCKED_TIP
                } else {
                    copy::ASPECT_FREE_TIP
                }
                .to_string()
            },
            str::to_string,
        ),
        forced_line: forced,
        pixel_line: pixel_readout(picture, video.0, video.1),
        disabled_line: (!enabled).then_some(lock_reason).flatten(),
    }
}

fn overlay_view(input: &InspectorInput<'_>, item: &'static str) -> Option<InspectorView> {
    let shown = overlay_layout_for_display(input.overlay_layout?, input.captions);
    let layout = shown.get(item)?;
    let on_stream = layout.get("showOnStream").and_then(Value::as_bool) == Some(true);
    let in_recording = layout.get("showInRecording").and_then(Value::as_bool) == Some(true);
    let off_line = (!on_stream && !in_recording)
        .then(|| overlay_item_off_line(item))
        .flatten();
    let vertical = input.vertical_view || input.video.1 > input.video.0;
    Some(InspectorView {
        kind: InspectorKind::Overlay,
        source_id: None,
        title: super::stage::overlay_item_label(item).to_string(),
        description: off_line.map(str::to_string),
        visibility: None,
        screen_size: None,
        placement: None,
        lens: None,
        overlay: Some(OverlayView {
            item,
            off_line,
            description: overlay_item_description(item),
            show_on_stream: on_stream,
            show_in_recording: in_recording,
            captions_summary: (item == "captions")
                .then(|| captions_outputs_summary(on_stream, in_recording)),
            blocked: (!input.connected).then_some(copy::OFFLINE_LOCK_REASON),
            snap_label: if vertical {
                copy::SNAP_VERTICAL
            } else {
                copy::SNAP_TO
            },
        }),
        banner: None,
    })
}

fn banner_view(input: &InspectorInput<'_>, id: &str) -> Option<InspectorView> {
    let banners = input.banners;
    let index = banners.iter().position(|banner| banner.id == id)?;
    let banner = &banners[index];
    let blocked = (!input.connected).then_some(copy::OFFLINE_LOCK_REASON);
    let shown_count = banners.iter().filter(|banner| banner.shown).count();
    let limit = (shown_count >= BANNER_MAX_SHOWN).then_some(copy::BANNER_SHOWN_LIMIT_REASON);
    let show_reason = if blocked.is_some() || banner.shown {
        None
    } else {
        limit
    };
    let (state, state_line) = banner_state_line(banner);
    let hide_after = banner.hide_after_sec.unwrap_or(0);
    let repeat = banner.repeat_every_min.unwrap_or(0);
    let hide_choices: Vec<TimingChoice> =
        banner_timing_choices(&BANNER_HIDE_AFTER_CHOICES, hide_after)
            .into_iter()
            .map(|value| TimingChoice {
                value,
                label: if value == 0 {
                    copy::OFF.to_string()
                } else {
                    banner_seconds_label(value)
                },
            })
            .collect();
    let repeat_choices: Vec<TimingChoice> = banner_timing_choices(&BANNER_REPEAT_CHOICES, repeat)
        .into_iter()
        .map(|value| TimingChoice {
            value,
            label: if value == 0 {
                copy::OFF.to_string()
            } else {
                banner_minutes_label(value)
            },
        })
        .collect();
    Some(InspectorView {
        kind: InspectorKind::Banner,
        source_id: None,
        title: banner.name.clone(),
        description: Some(state_line.to_string()),
        visibility: None,
        screen_size: None,
        placement: None,
        lens: None,
        overlay: None,
        banner: Some(BannerView {
            id: banner.id.clone(),
            name: banner.name.clone(),
            state,
            state_line,
            shown: banner.shown,
            show_enabled: blocked.is_none() && show_reason.is_none(),
            show_reason,
            blocked,
            place_label: if input.vertical_view {
                copy::PLACE_VERTICAL
            } else {
                copy::PLACE
            },
            advice: banner_size_advice(banner, input.video, input.vertical_stream),
            opacity: js_round(banner.opacity * 100.0) as i32,
            on_stream: banner.show_on_stream,
            in_recording: banner.show_in_recording,
            in_front: index + 1 == banners.len(),
            at_back: index == 0,
            timing_summary: banner_timing_summary(hide_after, repeat),
            hide_after_index: hide_choices
                .iter()
                .position(|choice| choice.value == hide_after)
                .unwrap_or(0),
            hide_after: hide_choices,
            repeat_index: repeat_choices
                .iter()
                .position(|choice| choice.value == repeat)
                .unwrap_or(0),
            repeat: repeat_choices,
        }),
    })
}

fn empty_view() -> InspectorView {
    InspectorView {
        kind: InspectorKind::Empty,
        source_id: None,
        title: copy::INSPECTOR_TITLE.to_string(),
        description: Some(copy::INSPECTOR_EMPTY.to_string()),
        visibility: None,
        screen_size: None,
        placement: None,
        lens: None,
        overlay: None,
        banner: None,
    }
}

/// The inspector for the stage's selection.
pub fn inspector_view(input: &InspectorInput<'_>) -> InspectorView {
    let source_id = match &input.selection {
        InspectorSelection::Banner(id) => {
            return banner_view(input, id).unwrap_or_else(empty_view);
        }
        InspectorSelection::Overlay(item) => {
            return overlay_view(input, item).unwrap_or_else(empty_view);
        }
        InspectorSelection::None => return empty_view(),
        InspectorSelection::Source(id) => id,
    };
    let Some(source) = input
        .scene_sources
        .iter()
        .find(|source| &source.id == source_id)
    else {
        return empty_view();
    };
    let layout = input.layout;
    let placement = placement_controls(
        input.scene_edit_mode,
        input.session_active,
        input.accepts_live_scene_edits,
        input.stage_dragging,
    );
    let position_locked = placement.lock_reason.is_some();
    let visibility = Some((
        source.visible,
        !(input.session_active || input.stage_dragging),
        input.session_active.then_some(copy::VISIBILITY_LOCK_REASON),
    ));
    let screen_size = (input.has_background)
        .then(|| {
            input.visibility_percent.map(|percent| {
                (
                    screen_size_of(percent) as i32,
                    input
                        .session_active
                        .then_some(copy::SCREEN_SIZE_LOCK_REASON),
                )
            })
        })
        .flatten();
    let picture = input
        .picture
        .unwrap_or_else(|| StageRect::of(&source.transform));
    let controls = scene_camera_controls(layout);
    let fields_enabled = !position_locked && !input.stage_dragging;

    if source.kind == SceneSourceKind::Camera {
        let preset = text(layout, "layoutPreset");
        let camera_only = preset == "camera-only";
        let vertical_camera_only = preset == "vertical-camera-only";
        let side_by_side = preset == "side-by-side";
        let vertical_stack = matches!(
            preset,
            "vertical-camera-top" | "vertical-camera-bottom" | "vertical-split"
        );
        let live_box =
            input.session_active && !position_locked && (controls.freeform || controls.bubble);
        let description = if live_box {
            Some(copy::LIVE_PLACEMENT_HINT)
        } else if controls.freeform {
            Some(
                placement
                    .lock_reason
                    .unwrap_or(copy::CAMERA_FREEFORM_PLACEMENT),
            )
        } else if camera_only {
            Some(copy::CAMERA_ONLY_PLACEMENT)
        } else if vertical_camera_only {
            Some(copy::VERTICAL_CAMERA_ONLY_PLACEMENT)
        } else if vertical_stack {
            Some(copy::VERTICAL_STACK_PLACEMENT)
        } else {
            None
        };
        let shape = text(layout, "cameraShape");
        let aspect = text(layout, "cameraAspect");
        let mut rows = CameraPlacementView::default();
        let mut fields = None;
        if side_by_side && !controls.freeform {
            rows.split = segment(
                &["50-50", "60-40", "70-30"],
                text(layout, "sideBySideSplit"),
            )
            .or(Some(0));
            rows.side =
                segment(&["left", "right"], text(layout, "sideBySideCameraSide")).or(Some(0));
        }
        if controls.corner {
            rows.corner = Some(if text(layout, "cameraTransformMode") == "custom" {
                None
            } else {
                segment(
                    &["top-left", "top-right", "bottom-left", "bottom-right"],
                    text(layout, "cameraCorner"),
                )
            });
        }
        if controls.bubble {
            if !controls.freeform {
                rows.size = segment(&["small", "medium", "large"], text(layout, "cameraSize"));
            }
            rows.shape = segment(&["rectangle", "rounded", "circle"], shape).or(Some(0));
            if shape == "rounded" {
                rows.radius = Some(number(layout, "cameraCornerRadiusPct", 12.0) as i32);
            }
            if shape != "circle" {
                rows.aspect = Some((
                    segment(&["source", "square", "portrait"], aspect).unwrap_or(0),
                    !aspect.is_empty() && aspect != "source",
                ));
            }
            if !controls.freeform {
                rows.margin = Some(number(layout, "cameraMargin", 32.0) as i32);
            }
            let forced = (shape == "circle" || (!aspect.is_empty() && aspect != "source"))
                .then_some(copy::CAMERA_SHAPE_SETS_ASPECT);
            fields = Some(transform_fields(
                picture,
                fields_enabled,
                placement.lock_reason,
                forced,
                input.aspect_locked,
                input.video,
            ));
        }
        let look = layout.get("cameraLook").filter(|look| look.is_object());
        let look_reason = if !input.connected {
            Some(copy::LOOK_RECONNECTING)
        } else if !has_camera(input.sources) {
            Some(copy::LOOK_NO_CAMERA)
        } else {
            None
        };
        let lens = CameraLensView {
            description: if vertical_camera_only {
                Some(copy::LENS_VERTICAL_CAMERA_ONLY)
            } else if vertical_stack {
                Some(copy::LENS_VERTICAL_STACK)
            } else {
                None
            },
            fit: (!(vertical_stack || vertical_camera_only))
                .then(|| usize::from(text(layout, "cameraFit") == "fit")),
            mirror: layout.get("cameraMirror").and_then(Value::as_bool) == Some(true),
            zoom: number(layout, "cameraZoom", 100.0) as i32,
            pan_x: number(layout, "cameraOffsetX", 0.0) as i32,
            pan_y: number(layout, "cameraOffsetY", 0.0) as i32,
            look: look_sliders(look),
            look_reason,
            look_reset_enabled: look.is_some() && look_reason.is_none(),
        };
        return InspectorView {
            kind: InspectorKind::Camera,
            source_id: Some(source.id.clone()),
            title: source.name.clone(),
            description: None,
            visibility,
            screen_size: None,
            placement: Some(PlacementView {
                description: description.map(str::to_string),
                reset: None,
                camera: Some(rows),
                fields,
                zoom: None,
                crop: None,
                nudge: None,
            }),
            lens: Some(lens),
            overlay: None,
            banner: None,
        };
    }

    if source_is_full_canvas(source) && !controls.freeform {
        return InspectorView {
            kind: InspectorKind::FullCanvas,
            source_id: Some(source.id.clone()),
            title: source.name.clone(),
            description: Some(
                if input.has_background {
                    copy::FULL_CANVAS_BACKGROUND
                } else {
                    copy::FULL_CANVAS
                }
                .to_string(),
            ),
            visibility,
            screen_size,
            placement: None,
            lens: None,
            overlay: None,
            banner: None,
        };
    }

    let croppable = controls.freeform && source_croppable(&source.kind);
    let crop = super::stage::stage_crop_of(&source.transform);
    InspectorView {
        kind: InspectorKind::Source,
        source_id: Some(source.id.clone()),
        title: source.name.clone(),
        description: None,
        visibility,
        screen_size,
        placement: Some(PlacementView {
            description: Some(placement.description.to_string()),
            reset: Some(!position_locked && !input.stage_dragging),
            camera: None,
            fields: Some(transform_fields(
                picture,
                fields_enabled,
                placement.lock_reason,
                input
                    .box_is_picture
                    .then_some(copy::SCREEN_PICTURE_ASPECT_REASON),
                input.aspect_locked,
                input.video,
            )),
            zoom: croppable.then(|| (screen_zoom_of(picture) as i32, fields_enabled)),
            crop: croppable.then(|| CropFieldsView {
                values: CROP_FIELDS.map(|(key, _)| format_percent_value(crop_field(crop, key))),
                enabled: fields_enabled,
                cropped: CROP_FIELDS
                    .iter()
                    .any(|(key, _)| crop_field(crop, key) > 0.0),
            }),
            nudge: Some(!placement.nudge_disabled),
        }),
        lens: None,
        overlay: None,
        banner: None,
    }
}

/// One row of the Banners section (`SceneBannersSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerRowView {
    pub id: String,
    pub name: String,
    /// S3.8b: the row's thumbnail (`BannerThumbnail`), a managed file.
    pub thumbnail_file: String,
    pub shown: bool,
    pub selected: bool,
    pub timing: Option<String>,
    /// Why a hidden banner can't show now.
    pub show_reason: Option<&'static str>,
}

/// The Banners section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannersSectionView {
    pub rows: Vec<BannerRowView>,
    pub loaded: bool,
    pub offline: bool,
    pub offline_alert: bool,
}

pub fn banners_section_view(
    banners: &[Banner],
    loaded: bool,
    connected: bool,
    selected: Option<&str>,
    inspector_says_offline: bool,
) -> BannersSectionView {
    let shown = banners.iter().filter(|banner| banner.shown).count();
    let limit = (shown >= BANNER_MAX_SHOWN).then_some(copy::BANNER_SHOWN_LIMIT_REASON);
    BannersSectionView {
        rows: banners
            .iter()
            .map(|banner| BannerRowView {
                id: banner.id.clone(),
                name: banner.name.clone(),
                thumbnail_file: banner.thumbnail_file.clone(),
                shown: banner.shown,
                selected: selected == Some(banner.id.as_str()),
                timing: banner_timing_summary(
                    banner.hide_after_sec.unwrap_or(0),
                    banner.repeat_every_min.unwrap_or(0),
                ),
                show_reason: (!banner.shown).then_some(limit).flatten(),
            })
            .collect(),
        loaded,
        offline: !connected,
        offline_alert: !inspector_says_offline,
    }
}

/// The Hide screen section (`HideScreenSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HideScreenView {
    pub accelerator: Option<String>,
    /// The Shortcut row's hint (`hideScreenShortcutHint`, #1529).
    pub shortcut_hint: &'static str,
    /// The password-manager hide and its list (macOS only, D12).
    pub mac: bool,
    pub hide_for_password_managers: bool,
    pub entries: Vec<PasswordManagerEntry>,
    pub removable: bool,
    pub restore_shown: bool,
}

/// `hideScreenShortcutHint` (#1529): under Wayland no global key is
/// registered at all (`globalShortcutsUnavailable`), so the hint says the
/// key won't work here instead of promising it works from any app.
pub fn hide_screen_shortcut_hint(global_shortcuts_unavailable: bool) -> &'static str {
    if global_shortcuts_unavailable {
        "Change it in Settings → Shortcuts. This Wayland session can't hear keys while Videorc is in the background, so it won't work here."
    } else {
        "Change it in Settings → Shortcuts. It works from any app."
    }
}

pub fn hide_screen_view(
    accelerator: Option<String>,
    mac: bool,
    privacy: &PrivacySettings,
    global_shortcuts_unavailable: bool,
) -> HideScreenView {
    HideScreenView {
        accelerator,
        shortcut_hint: hide_screen_shortcut_hint(global_shortcuts_unavailable),
        mac,
        hide_for_password_managers: privacy.hide_for_password_managers,
        entries: password_manager_entries(privacy),
        removable: can_remove_password_manager(privacy),
        restore_shown: built_in_password_managers_removed(privacy),
    }
}

#[cfg(test)]
#[path = "inspector_tests.rs"]
mod tests;
