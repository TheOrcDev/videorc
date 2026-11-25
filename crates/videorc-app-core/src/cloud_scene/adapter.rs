//! Room scene adapter helpers (`cloud-scene-adapter.ts`).
//!
//! Pure pieces only: canvas sizes, commit copy, stage-layout clear, and
//! orientation from a layout preset. The async `applySceneToRoom` I/O loop
//! (resolve → share screen → wait for tracks → commit) stays in the app
//! shell; it calls these helpers and [`super::native::cloud_scene_from_native`].

use super::types::{SCENE_MOTION_MS, SceneCanvas, SceneOrientation, SceneTransitionKind};

/// A scene command while scenes are off in this room (per room, off by default).
pub const ROOM_SCENES_OFF: &str =
    "Scenes are off in this room. The room layouts stay on the program.";
/// Its toast action: turn scenes on for this room and run the command again.
pub const USE_SCENES: &str = "Use scenes";

/// Landscape room program canvas (`ROOM_SCENE_CANVAS.h`).
pub const ROOM_SCENE_CANVAS_H: SceneCanvas = SceneCanvas {
    width: 1920.0,
    height: 1080.0,
};
/// Portrait room program canvas (`ROOM_SCENE_CANVAS.v`).
pub const ROOM_SCENE_CANVAS_V: SceneCanvas = SceneCanvas {
    width: 1080.0,
    height: 1920.0,
};

/// `ROOM_SCENE_CANVAS` for an orientation.
pub fn room_scene_canvas(orientation: SceneOrientation) -> SceneCanvas {
    match orientation {
        SceneOrientation::H => ROOM_SCENE_CANVAS_H,
        SceneOrientation::V => ROOM_SCENE_CANVAS_V,
    }
}

/// `layoutPresetOrientation` → cloud scene orientation.
pub fn orientation_from_layout_preset(layout_preset: &str) -> SceneOrientation {
    if layout_preset.starts_with("vertical") {
        SceneOrientation::V
    } else {
        SceneOrientation::H
    }
}

/// Commit outcome the room publisher reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomSceneCommitState {
    Applied,
    Preview,
    Waiting,
    Superseded,
    Failed,
}

/// `roomSceneMessage`.
pub fn room_scene_message(state: RoomSceneCommitState, reason: Option<&str>) -> Option<String> {
    match state {
        RoomSceneCommitState::Applied | RoomSceneCommitState::Superseded => None,
        RoomSceneCommitState::Preview => {
            Some("Scene set. It shows once the stream or recording starts.".to_string())
        }
        RoomSceneCommitState::Waiting => Some(
            reason
                .unwrap_or("The program hasn't drawn the scene yet.")
                .to_string(),
        ),
        RoomSceneCommitState::Failed => Some(
            reason
                .unwrap_or("The scene couldn't be sent to the room.")
                .to_string(),
        ),
    }
}

/// Transition to send with a room scene commit.
pub fn room_scene_transition(animate: bool) -> (SceneTransitionKind, i64) {
    if animate {
        (SceneTransitionKind::Motion, SCENE_MOTION_MS)
    } else {
        (SceneTransitionKind::Cut, 0)
    }
}

/// A Show stage layout replaces the scene: the room's own layouts return.
pub fn stage_layout_clears_scene(previous_layout: Option<&str>, next_layout: &str) -> bool {
    previous_layout.is_some_and(|previous| previous != next_layout)
}

/// Whether the room's camera/screen tracks satisfy a translated scene.
pub fn room_sources_ready(
    needs_camera: bool,
    needs_screen: bool,
    camera_published: bool,
    camera_off: bool,
    screen_published: bool,
    stage_has_screen: bool,
) -> Result<(), &'static str> {
    let camera_ready = !needs_camera || camera_published || camera_off;
    let screen_ready = !needs_screen || screen_published || stage_has_screen;
    if camera_ready && screen_ready {
        return Ok(());
    }
    if !screen_ready {
        Err("This scene shows a screen. Share your screen in the room first.")
    } else {
        Err("This scene shows your camera. Turn the room camera on first.")
    }
}
