//! Plan 260 S1.8b: the avatar and scene content the Studio builds and hands
//! the backend's room (`cloud.room.avatar.set`, `cloud.room.scene.commit`),
//! held here for their publishers while the backend holds the host seat.
//! The builders move to `videorc-app-core` in Phase 2/3 (the plan's S1.8
//! cut); the backend owns the delivery.

use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Notify;

use crate::cloud_talk::{
    CloudRoomAvatarSetParams, CloudRoomSceneCommitParams, RoomPresentationStatus,
};

static AVATAR: StdMutex<Option<CloudRoomAvatarSetParams>> = StdMutex::new(None);
/// The committed scene and the generation the commit was given: the scene
/// entry's `revision` is that generation, so the Studio settles only on its
/// own commit.
static SCENE: StdMutex<Option<(u64, CloudRoomSceneCommitParams)>> = StdMutex::new(None);
static SCENE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// The scene entry the publisher last reported.
static SCENE_STATUS: StdMutex<Option<RoomPresentationStatus>> = StdMutex::new(None);
/// Wakes the publishers on a change.
pub(crate) static CHANGED: Notify = Notify::const_new();

fn lock<T>(slot: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn set_avatar(params: CloudRoomAvatarSetParams) {
    // Plan 260 S1.8 (L1): `build: true` asks the backend to build the
    // content itself (`room_avatar_build`); content the client built turns
    // that off.
    crate::room_avatar_build::set_build(params.build == Some(true) && params.content.is_none());
    *lock(&AVATAR) = Some(params);
    CHANGED.notify_waiters();
}

/// The content the backend built (`room_avatar_build`), under the client's
/// own guests switch; nothing once the client stopped asking for it.
pub(crate) fn set_built_avatar(content: serde_json::Value) {
    let mut avatar = lock(&AVATAR);
    let Some(held) = avatar.as_mut().filter(|held| held.build == Some(true)) else {
        return;
    };
    held.content = Some(content);
    drop(avatar);
    CHANGED.notify_waiters();
}

/// `cloud.room.scene.commit`: the commit's generation, assigned here, and the
/// scene entry already reported for it (an unchanged commit keeps its
/// generation and answers with its standing result).
pub(crate) fn commit_scene(
    params: CloudRoomSceneCommitParams,
) -> (u64, Option<RoomPresentationStatus>) {
    let mut scene = lock(&SCENE);
    if let Some((generation, current)) = scene.as_ref()
        && *current == params
    {
        let generation = *generation;
        let status = lock(&SCENE_STATUS)
            .clone()
            .filter(|status| status.revision == generation);
        return (generation, status);
    }
    let generation = SCENE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    *scene = Some((generation, params));
    drop(scene);
    CHANGED.notify_waiters();
    (generation, None)
}

/// The scene publisher reported this entry.
pub(crate) fn scene_reported(status: &RoomPresentationStatus) {
    *lock(&SCENE_STATUS) = Some(status.clone());
}

pub(crate) fn avatar() -> Option<CloudRoomAvatarSetParams> {
    lock(&AVATAR).clone()
}

pub(crate) fn scene() -> Option<(u64, CloudRoomSceneCommitParams)> {
    lock(&SCENE).clone()
}

/// A hold ended: nothing the Studio sent before carries over.
pub(crate) fn clear() {
    crate::room_avatar_build::set_build(false);
    *lock(&AVATAR) = None;
    *lock(&SCENE) = None;
    *lock(&SCENE_STATUS) = None;
}
