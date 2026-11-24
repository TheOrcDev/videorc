//! Main's capture state (plan 260 S2.6a): the backend's `recording.status`
//! as the core's [`MainCaptureState`], one watch the guards read. The
//! display sleep guard holds while a session writes or sends something; a
//! permission grant's backend restart waits while capture is active or
//! unknown. A lost connection is unknown.

use tokio::sync::{broadcast, watch};
use videorc_app_core::BackendEvent;
use videorc_app_core::desktop::capture_state::MainCaptureState;

/// Follows the backend's events on the core's runtime. Unknown until the
/// first status arrives.
pub fn follow(
    runtime: &tokio::runtime::Handle,
    mut events: broadcast::Receiver<BackendEvent>,
) -> watch::Receiver<MainCaptureState> {
    let (state_tx, state) = watch::channel(MainCaptureState::Unknown);
    runtime.spawn(async move {
        loop {
            let next = match events.recv().await {
                Ok(BackendEvent::RecordingStatus(status)) => MainCaptureState::from_status(&status),
                Ok(BackendEvent::ConnectionClosed { .. }) => MainCaptureState::Unknown,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            state_tx.send_if_modified(|state| {
                let changed = *state != next;
                *state = next;
                changed
            });
        }
    });
    state
}
