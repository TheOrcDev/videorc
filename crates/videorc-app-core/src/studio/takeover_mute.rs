//! What a takeover on air does to the host's microphone: Electron's
//! `commitActiveScreen` (`hooks/use-studio.tsx`) and
//! `screenTakeoverMicrophoneTransition` (`lib/screen-takeover-microphone.ts`),
//! on the Studio. The read side ("Muted for takeover", the stored record) is
//! [`super::takeover_microphone`]; this is the side that mutes.
//!
//! A takeover going on air mutes the microphone and records that the
//! takeover owns that mute (`videorc.screenTakeoverMuteOwnership.v1`, with
//! whether the microphone was muted before). When it ends, the takeover
//! gives back only the mute it took: a microphone that was live before comes
//! back, one that was muted stays muted, and a manual unmute made while the
//! takeover was on air is never undone. The record survives a reconnect, so
//! a takeover that is still on air never takes a second mute.
//!
//! The takeover on air is the backend's: the `screens.active` read after
//! each bootstrap and every `screens.active.changed`. The backend retires the
//! previous run's takeover at launch, so the first read after a relaunch
//! says none and releases a mute the last run left behind (main 0c0e16273:
//! "a takeover never survives a relaunch, and its mute is always released").
//! A record without a takeover on air is always released.
//!
//! While the talk-show room is open the program page silences speech (D3):
//! the takeover never touches the microphone, and any record is dropped.
//!
//! Order matters across a quit (`commitActiveScreen`): taking a mute writes
//! the record first, then the mute; releasing one writes the restored mute
//! first, then removes the record. A stored mute never goes without the
//! record that lets a later launch release it.

use std::sync::Arc;

use serde_json::json;

use super::settings::SettingWrite;
use super::settings::keys::SCREEN_TAKEOVER_MUTE_OWNERSHIP;
use super::takeover_microphone::{TakeoverMuteOwnership, stored_mute_ownership};
use super::{MicrophoneMode, Studio, StudioBackend};

/// `screens.active.changed`: the takeover on air, or `null`.
pub const ACTIVE_CHANGED_EVENT: &str = "screens.active.changed";

/// `ScreenTakeoverMicrophoneTransition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub microphone_muted: bool,
    pub ownership: Option<TakeoverMuteOwnership>,
}

/// `screenTakeoverMicrophoneTransition`: the takeover owns only the mute it
/// introduced.
pub fn transition(
    active: bool,
    microphone_muted: bool,
    ownership: Option<TakeoverMuteOwnership>,
) -> Transition {
    if active {
        return match ownership {
            // Still the same takeover (a reconnect, a reload): no new mute.
            Some(owned) => Transition {
                microphone_muted,
                ownership: Some(owned),
            },
            None => Transition {
                microphone_muted: true,
                ownership: Some(TakeoverMuteOwnership {
                    prior_microphone_muted: microphone_muted,
                }),
            },
        };
    }
    match ownership {
        None => Transition {
            microphone_muted,
            ownership: None,
        },
        // Ended: a microphone that was live comes back; one that was muted
        // before stays as it is now.
        Some(owned) => Transition {
            microphone_muted: if owned.prior_microphone_muted {
                microphone_muted
            } else {
                false
            },
            ownership: None,
        },
    }
}

/// What the driver has to do next.
#[derive(Debug, Default)]
pub(super) struct TakeoverPending {
    /// The takeover on air as the backend last said (`Some(true)` on air).
    active: Option<bool>,
    /// Read `screens.active` (after a bootstrap).
    read: bool,
}

impl<B: StudioBackend> Studio<B> {
    fn takeover_pending_lock(&self) -> std::sync::MutexGuard<'_, TakeoverPending> {
        self.takeover_pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `screens.active.changed`: the backend's truth wins over a read in
    /// flight.
    pub(super) fn takeover_changed(&self, on_air: bool) {
        {
            let mut pending = self.takeover_pending_lock();
            pending.active = Some(on_air);
            pending.read = false;
        }
        self.takeover_kick.notify_one();
    }

    /// After a bootstrap: read the takeover on air (a relaunch reads none,
    /// and a stored mute is released).
    pub(super) fn read_takeover_after_bootstrap(&self) {
        self.takeover_pending_lock().read = true;
        self.takeover_kick.notify_one();
    }

    /// Runs the takeover's mute beside the events (a session that applies
    /// the mute never holds them up). [`Self::drive`] runs it.
    pub(super) async fn drive_takeover_mute(self: &Arc<Self>) {
        loop {
            self.takeover_kick.notified().await;
            self.drain_takeover_mute().await;
        }
    }

    /// Commits what waits, newest first. A test without a driver calls it.
    #[doc(hidden)]
    pub async fn drain_takeover_mute(&self) {
        loop {
            let (active, read) = {
                let mut pending = self.takeover_pending_lock();
                (pending.active.take(), std::mem::take(&mut pending.read))
            };
            match (active, read) {
                (Some(on_air), _) => self.commit_takeover(on_air).await,
                (None, true) => {
                    // A read that fails stays unknown and commits nothing;
                    // `screens.active.changed` says the truth later.
                    if let Ok(screen) = self.backend.screens_active().await {
                        let newer = self.takeover_pending_lock().active.is_some();
                        if !newer {
                            self.commit_takeover(screen.is_some()).await;
                        }
                    }
                }
                (None, false) => return,
            }
        }
    }

    /// `commitActiveScreen`: the mute a takeover on air takes, or gives back.
    #[doc(hidden)]
    pub async fn commit_takeover(&self, on_air: bool) {
        let _guard = self.takeover_commit.lock().await;
        self.commit_takeover_locked(on_air).await;
    }

    /// Commits a takeover state transition immediately after a direct
    /// `screens.activate` / `screens.clear` action, matching Electron's
    /// synchronous `commitActiveScreen` inside `activateScreen` /
    /// `clearActiveScreen`. Serialized with [`Self::commit_takeover`] so a
    /// delayed `screens.active.changed` event never overwrites a subsequent
    /// manual mute.
    pub(super) async fn commit_takeover_from_action(&self, on_air: bool) {
        let _guard = self.takeover_commit.lock().await;
        {
            let mut pending = self.takeover_pending_lock();
            if pending.active == Some(on_air) {
                pending.active = None;
            }
            pending.read = false;
        }
        self.commit_takeover_locked(on_air).await;
    }

    async fn commit_takeover_locked(&self, on_air: bool) {
        let snapshot = self.snapshot();
        let ownership = stored_mute_ownership(&self.lock().settings);
        let room_open = self
            .cloud_now()
            .status
            .as_ref()
            .is_some_and(super::cloud::room_open);
        if room_open {
            // D3: the program page owns takeover silence while the room is
            // open; the takeover never writes the microphone.
            if ownership.is_some() {
                let _ = self
                    .write_settings(vec![SettingWrite::delete(SCREEN_TAKEOVER_MUTE_OWNERSHIP)])
                    .await;
            }
            return;
        }
        let muted = snapshot.settings.capture.audio.microphone_muted;
        let next = transition(on_air, muted, ownership);
        // Taking a mute: the record first, so a quit between the two never
        // strands a mute without it.
        if let Some(owned) = next.ownership
            && ownership != Some(owned)
        {
            let _ = self
                .write_settings(vec![SettingWrite::json(
                    SCREEN_TAKEOVER_MUTE_OWNERSHIP,
                    &json!({ "priorMicrophoneMuted": owned.prior_microphone_muted }),
                )])
                .await;
        }
        if next.microphone_muted != muted {
            let mode = if next.microphone_muted {
                MicrophoneMode::Mute
            } else {
                MicrophoneMode::Unmute
            };
            if !self.set_microphone_muted(mode).await {
                self.config.logger.warn(format!(
                    "Studio: the takeover's microphone {} did not land.",
                    if next.microphone_muted {
                        "mute"
                    } else {
                        "release"
                    }
                ));
            }
        }
        // Releasing a mute: the restored microphone first, then the record.
        if next.ownership.is_none() && ownership.is_some() {
            let _ = self
                .write_settings(vec![SettingWrite::delete(SCREEN_TAKEOVER_MUTE_OWNERSHIP)])
                .await;
        }
    }
}

#[cfg(test)]
#[path = "takeover_mute_tests.rs"]
mod tests;
