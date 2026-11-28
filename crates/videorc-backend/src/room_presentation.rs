//! The backend room's presentation as it last published it
//! (`cloud.room.presentation`), merged per part, for `cloud.room.presentation.get`.
//!
//! Each room task (graphics, avatar, scene, the host's media) publishes its
//! own part of `cloud.room.presentation` when it changes. The Studio follows
//! the events; a smoke that arrives later (the cloud-parity cases on the GPUI
//! app, where the room lives here and no renderer holds a
//! `roomControls.snapshot`) reads the latest of every part at once. A new show
//! starts a new snapshot, and leaving the room forgets it.

use std::sync::Mutex;

use crate::cloud_talk::{CLOUD_ROOM_PRESENTATION_EVENT, CloudRoomPresentationEvent};
use crate::state::AppState;

static LATEST: Mutex<Option<CloudRoomPresentationEvent>> = Mutex::new(None);

/// `next` laid over `current`: each part `next` carries replaces that part;
/// the parts it leaves out stay. Another show's event starts over. Pure.
pub(crate) fn merge(
    current: Option<CloudRoomPresentationEvent>,
    next: &CloudRoomPresentationEvent,
) -> CloudRoomPresentationEvent {
    let mut merged = match current {
        Some(current) if current.show_id == next.show_id => current,
        _ => CloudRoomPresentationEvent {
            show_id: next.show_id.clone(),
            graphics: None,
            avatar: None,
            scene: None,
            media: None,
        },
    };
    if next.graphics.is_some() {
        merged.graphics = next.graphics.clone();
    }
    if next.avatar.is_some() {
        merged.avatar = next.avatar.clone();
    }
    if next.scene.is_some() {
        merged.scene = next.scene.clone();
    }
    if next.media.is_some() {
        merged.media = next.media.clone();
    }
    merged
}

/// Publishes one part of the room's presentation, and remembers it.
#[cfg_attr(not(backend_room), allow(dead_code))]
pub(crate) fn publish(state: &AppState, event: CloudRoomPresentationEvent) {
    {
        let mut latest = LATEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *latest = Some(merge(latest.take(), &event));
    }
    state.emit_event(CLOUD_ROOM_PRESENTATION_EVENT, event);
}

/// The latest of every part, or `None` before the room published any.
pub(crate) fn latest() -> Option<CloudRoomPresentationEvent> {
    LATEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// The room was left: nothing it published still stands.
#[cfg_attr(not(backend_room), allow(dead_code))]
pub(crate) fn forget() {
    *LATEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_talk::RoomMediaStatus;

    fn event(show: &str) -> CloudRoomPresentationEvent {
        CloudRoomPresentationEvent {
            show_id: show.to_string(),
            graphics: None,
            avatar: None,
            scene: None,
            media: None,
        }
    }

    fn media(camera: bool) -> RoomMediaStatus {
        RoomMediaStatus {
            camera,
            ..RoomMediaStatus::default()
        }
    }

    #[test]
    fn each_part_replaces_its_own_and_leaves_the_others() {
        let first = merge(
            None,
            &CloudRoomPresentationEvent {
                media: Some(media(true)),
                ..event("show-1")
            },
        );
        assert_eq!(first.media, Some(media(true)));
        // A later event with only the scene's part keeps the media.
        let scene = merge(None, &event("show-1")).scene;
        let second = merge(Some(first.clone()), &event("show-1"));
        assert_eq!(second.media, Some(media(true)));
        assert_eq!(second.scene, scene);
        // The media's own next part replaces it.
        let third = merge(
            Some(second),
            &CloudRoomPresentationEvent {
                media: Some(media(false)),
                ..event("show-1")
            },
        );
        assert_eq!(third.media, Some(media(false)));
    }

    #[test]
    fn another_show_starts_a_new_snapshot() {
        let first = merge(
            None,
            &CloudRoomPresentationEvent {
                media: Some(media(true)),
                ..event("show-1")
            },
        );
        let next = merge(Some(first), &event("show-2"));
        assert_eq!(next.show_id, "show-2");
        assert_eq!(next.media, None);
    }
}
