//! Plan 249 S12/S14: a native saved or preset scene as cloud presentation.
//!
//! Port of Electron `apps/desktop/src/shared/cloud-scene.ts` plus the room
//! adapter helpers in `cloud-scene-native.ts` / `cloud-scene-adapter.ts`.
//! Pinned to `protocol-fixtures/cloud-parity-scenes.json`. Pure: no DOM, no
//! backend connection, no GPUI.
//!
//! Parity cases live in `parity_tests.rs` and run via `tests/cloud_scene.rs`
//! (`cargo test -p videorc-app-core --test cloud_scene`).

pub mod adapter;
pub mod native;
pub mod parse;
pub mod plan;
pub mod receiver;
pub mod types;

pub use adapter::{
    ROOM_SCENE_CANVAS_H, ROOM_SCENE_CANVAS_V, ROOM_SCENES_OFF, RoomSceneCommitState, USE_SCENES,
    orientation_from_layout_preset, room_scene_canvas, room_scene_message, room_scene_transition,
    room_sources_ready, stage_layout_clears_scene,
};
pub use native::{
    CloudSceneNeeds, CloudSceneSkip, CloudSceneSkipReason, CloudSceneTranslation,
    cloud_scene_from_native,
};
pub use parse::{
    default_scene_guests, is_background_hash, is_background_mime, is_live_background_id,
    parse_background_capability, parse_cloud_scene, parse_cloud_scene_extension,
    parse_scene_background, parse_scene_capability, parse_scene_guests, parse_scene_snapshot,
    scene_content_key, scene_content_key_parts, scene_key, scene_rect, scene_region,
};
pub use plan::{
    plan_scene_tiles, plan_scene_tiles_parts, scene_ease, scene_enter_from, scene_guest_cells,
    scene_motion, scene_picture, scene_pixels, scene_progress, scene_within,
};
pub use receiver::SceneReceiver;
pub use types::*;
