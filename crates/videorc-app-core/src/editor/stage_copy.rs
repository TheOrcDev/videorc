//! Plan 220 S3.3b: the canvas editor's words (`scene-stage.tsx`,
//! `layout-tab.tsx`'s Canvas section, `overlay-layout.ts`'s item labels and
//! `overlay-stage.ts`'s badges), in one place the string diff reads.

/// `canvasDescription` without a saved scene on.
pub const DRAG_INTO_PLACE: &str = "Drag sources and overlays into place.";

/// `canvasDescription` while a saved scene is on (plan 210 D3).
pub fn saves_to(name: &str) -> String {
    format!("Changes save to “{name}” as you make them.")
}

/// S3.3x.2: the footer's line while the stage shows the vertical stream's
/// overlays (`layout-tab.tsx`'s `liveHint` for `verticalView`).
pub const VERTICAL_VIEW_HINT: &str = "Vertical stream: overlay placement only.";

/// The footer's Shift word, with and without the arrows' nudge.
pub const SHIFT_WORDS: &str = "constrain / aspect";
pub const SHIFT_WORDS_NUDGE: &str = "constrain / aspect / bigger nudge";
/// The footer's ⌥ word: no snap, the crop edge, or both.
pub const ALT_NO_SNAP: &str = "no snap";
pub const ALT_BOTH: &str = "no snap / crop edge";
pub const ALT_CROP: &str = "crop edge";

/// `OVERLAY_ITEM_LABELS`.
pub fn overlay_item_label(item: &str) -> &'static str {
    match item {
        "highlight" => "Highlight",
        "captions" => "Captions",
        // #1372 (plan 239): the Buddy is the avatar on the canvas.
        "buddy" => "Avatar",
        "chat" => "Chat",
        _ => "",
    }
}

/// `STAGE_ITEM_BADGE_LABELS`: the chip's word after an item's name.
pub const BADGE_HIDDEN: &str = "Hidden";
pub const BADGE_OFF: &str = "Off";
pub const BADGE_STREAM_ONLY: &str = "Stream only";
pub const BADGE_RECORDING_ONLY: &str = "Recording only";

/// A chip's name (`aria-label`): "Select Camera", "Select Avatar, Off".
pub fn select_name(label: &str, badge: &str) -> String {
    if badge.is_empty() {
        format!("Select {label}")
    } else {
        format!("Select {label}, {badge}")
    }
}

/// `StageLayoutOnlyNote`'s action: open or raise the Preview, or float a
/// Preview docked in the Studio panel (hidden while the Scene page shows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutOnlyAction {
    Open,
    PopOut,
}

/// `StageLayoutOnlyNote`: the line under a canvas that is a layout diagram
/// only (issue #1274), and the one action that puts the picture on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutOnlyNote {
    pub text: &'static str,
    pub action_label: &'static str,
    pub action: LayoutOnlyAction,
}

/// `stageLayoutOnlyNote` (#1301): where the picture is when the canvas can't
/// show it. A visible camera drawn as a grey box must never read as a broken
/// camera, so the canvas always says where to look.
pub fn stage_layout_only_note(preview_open: bool, preview_docked: bool) -> LayoutOnlyNote {
    if preview_open && preview_docked {
        return LayoutOnlyNote {
            text: "Layout only. The Preview is stuck to the Studio panel.",
            action_label: "Pop out Preview",
            action: LayoutOnlyAction::PopOut,
        };
    }
    LayoutOnlyNote {
        text: "Layout only. The picture is in the Preview.",
        action_label: if preview_open {
            "Show Preview"
        } else {
            "Open Preview"
        },
        action: LayoutOnlyAction::Open,
    }
}

/// `liveCanvasSupported` (plan 058; Linux since #1690, plan 257 S3): the
/// docked preview glues into the stage's canvas on macOS and Linux, which
/// dock the same in-window proof view.
pub fn live_canvas_supported(native_preview_surface: bool, platform: Option<&str>) -> bool {
    native_preview_surface && matches!(platform, Some("darwin" | "linux"))
}

/// The layout-only note the Scene page shows: none with a live canvas, and
/// none in the vertical view (it has its own line).
pub fn layout_only_note(
    live_canvas: bool,
    vertical_view: bool,
    preview_open: bool,
    preview_docked: bool,
) -> Option<LayoutOnlyNote> {
    (!live_canvas && !vertical_view).then(|| stage_layout_only_note(preview_open, preview_docked))
}
