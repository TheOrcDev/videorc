//! Plan 260 S1.8b: the avatar and scene content the Studio builds and hands
//! the backend's room (`cloud.room.avatar.set`, `cloud.room.scene.commit`),
//! held here for their publishers while the backend holds the host seat.
//! The builders move to `videorc-app-core` in Phase 2/3 (the plan's S1.8
//! cut); the backend owns the delivery.

use std::sync::Mutex as StdMutex;

use tokio::sync::Notify;

use crate::cloud_talk::{CloudRoomAvatarSetParams, CloudRoomSceneCommitParams};

static AVATAR: StdMutex<Option<CloudRoomAvatarSetParams>> = StdMutex::new(None);
static SCENE: StdMutex<Option<CloudRoomSceneCommitParams>> = StdMutex::new(None);
/// Wakes the publishers on a change.
pub(crate) static CHANGED: Notify = Notify::const_new();

fn lock<T>(slot: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn set_avatar(params: CloudRoomAvatarSetParams) {
    *lock(&AVATAR) = Some(params);
    CHANGED.notify_waiters();
}

pub(crate) fn commit_scene(params: CloudRoomSceneCommitParams) {
    *lock(&SCENE) = Some(params);
    CHANGED.notify_waiters();
}

pub(crate) fn avatar() -> Option<CloudRoomAvatarSetParams> {
    lock(&AVATAR).clone()
}

pub(crate) fn scene() -> Option<CloudRoomSceneCommitParams> {
    lock(&SCENE).clone()
}

/// A hold ended: nothing the Studio sent before carries over.
pub(crate) fn clear() {
    *lock(&AVATAR) = None;
    *lock(&SCENE) = None;
}
