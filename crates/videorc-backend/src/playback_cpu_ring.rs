//! Plan 260 (L5): the Library player's frames on Windows and Linux, through
//! the CPU ring the live preview uses (route (d), `preview_cpu_ring.rs`,
//! #1930). macOS hands each playback frame over as an IOSurface lease; the
//! other platforms have none, so the playback gets a ring of its own: a
//! second [`PreviewCpuRingService`] whose writer reads the decoder's frame
//! store instead of the compositor's.
//!
//! - **The seam with the decoder (L2's playback family).** The decoder
//!   publishes its frames into a [`CompositorFrameStore`] (I420 or BGRA, as
//!   the compositor does) and installs that store here at `playback.open`
//!   ([`PlaybackFrames::install`]), clears it at `playback.close`, and calls
//!   [`notify_frame`] after each publish. The writer converts and publishes,
//!   latest wins, exactly as for the preview.
//! - **No pixel demand.** The decoder makes every frame it publishes, so the
//!   ring holds nothing on the compositor.
//! - **Socket-owned.** `playback.cpu.open` and `playback.cpu.close` run in
//!   the admin socket's loop like `preview.cpu.*`: the socket that opened
//!   the ring owns it, and its going away closes it. `playback.cpu.status`
//!   is a plain observation.

use std::sync::Mutex as StdMutex;

use videorc_protocol::PreviewCpuRingStatus;
use videorc_protocol::playback::{PLAYBACK_CPU_CLOSE_METHOD, PLAYBACK_CPU_OPEN_METHOD};

use crate::backend_authority::BackendRole;
use crate::compositor::CompositorFrameStore;
use crate::preview_cpu_ring::{PreviewCpuRingOwner, StorePicker};
use crate::protocol::{ClientCommand, ServerResponse};
use crate::state::AppState;

/// The decoder's frame store while a playback is open (on `AppState`).
#[derive(Default)]
pub struct PlaybackFrames {
    store: StdMutex<Option<CompositorFrameStore>>,
}

impl std::fmt::Debug for PlaybackFrames {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlaybackFrames")
            .field("installed", &self.current().is_some())
            .finish()
    }
}

impl PlaybackFrames {
    /// The decoder's store at `playback.open`, `None` at `playback.close`.
    /// The ring's writer switches to a new store at its next tick.
    #[allow(dead_code)] // L2's decoder calls it (playback.open, each frame, playback.close).
    pub fn install(&self, store: Option<CompositorFrameStore>) {
        *self
            .store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = store;
    }

    fn current(&self) -> Option<CompositorFrameStore> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// The decoder published a frame: wake the ring's writer (never blocks).
#[allow(dead_code)] // L2's decoder calls it (playback.open, each frame, playback.close).
pub fn notify_frame(state: &AppState) {
    state.playback_cpu_ring.notify_frame();
}

/// `playback.cpu.open` from the socket loop: the writer reads whatever store
/// the decoder has installed, tick by tick.
pub fn open(
    state: &AppState,
    owner: u64,
) -> Result<(PreviewCpuRingStatus, PreviewCpuRingOwner), String> {
    let frames = state.playback_frames.clone();
    let picker: StorePicker = Box::new(move || frames.current());
    state.playback_cpu_ring.open_without_demand(owner, picker)
}

/// `playback.cpu.open` and `playback.cpu.close` on the socket's own task:
/// `None` for every other message. Main-process (admin) credential only:
/// the answer names shared memory another process maps.
pub(crate) fn handle_playback_cpu_ring_control(
    state: &AppState,
    role: BackendRole,
    owner_tag: u64,
    owner: &mut Option<PreviewCpuRingOwner>,
    text: &str,
) -> Option<ServerResponse> {
    if !text.contains("playback.cpu.") {
        return None;
    }
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    let method = command.method.as_str();
    if method != PLAYBACK_CPU_OPEN_METHOD && method != PLAYBACK_CPU_CLOSE_METHOD {
        return None;
    }
    if role != BackendRole::Admin {
        return Some(ServerResponse::error(
            command.id,
            "forbidden",
            "The playback ring requires the main-process credential.",
        ));
    }
    Some(if method == PLAYBACK_CPU_OPEN_METHOD {
        if owner.is_some() {
            // This socket holds the ring already: answer its status.
            return Some(ServerResponse::ok(
                command.id,
                state.playback_cpu_ring.status(),
            ));
        }
        match open(state, owner_tag) {
            Ok((status, guard)) => {
                *owner = Some(guard);
                ServerResponse::ok(command.id, status)
            }
            Err(message) => ServerResponse::error(command.id, "playback-ring-unavailable", message),
        }
    } else {
        let closed = owner.take().is_some();
        ServerResponse::ok(command.id, closed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_installed_until_the_decoder_says_so() {
        let frames = PlaybackFrames::default();
        assert!(frames.current().is_none());
        frames.install(None);
        assert!(frames.current().is_none());
    }
}
