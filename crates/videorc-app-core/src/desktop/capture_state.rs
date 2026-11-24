//! Main's capture state (plan 220 S2.6b): `shared/capture-state.ts`'s
//! `MainCaptureState`, the one value the sleep guard, the deferred
//! permission restart and Reopen Videorc read.
//!
//! Electron main samples it from its own event socket: a valid
//! `recording.status` names the state (a Clips buffer reads as idle), a lost
//! socket or a malformed status is `unknown`, which never counts as idle.
//! The Rust app's core already holds the status the backend reports
//! (`Studio`), so the state is read from its snapshot: a Studio that is not
//! connected, or has not finished its bootstrap reads on this connection, is
//! `unknown`.

/// `MainCaptureState`: the backend's six states, or `unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCaptureState {
    Unknown,
    Idle,
    Starting,
    Recording,
    Streaming,
    Stopping,
    Failed,
}

impl MainCaptureState {
    // `from_status` (a `RecordingStatus`) and `from_snapshot` (the
    // Studio's view) arrive with the typed client (S1.1) and the Studio area
    // (S1.6a); until then the shell is told the state directly.

    /// `isActiveRecordingState`: starting, recording, streaming or stopping.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            MainCaptureState::Starting
                | MainCaptureState::Recording
                | MainCaptureState::Streaming
                | MainCaptureState::Stopping
        )
    }

    /// Active, or not known to be idle.
    pub fn active_or_unknown(self) -> bool {
        self == MainCaptureState::Unknown || self.is_active()
    }

    /// `captureStateBlocksInterruption`: with a backend connected, an active
    /// or unknown state refuses a relaunch or an update.
    pub fn blocks_interruption(self, backend_connected: bool) -> bool {
        backend_connected && self.active_or_unknown()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MainCaptureState::Unknown => "unknown",
            MainCaptureState::Idle => "idle",
            MainCaptureState::Starting => "starting",
            MainCaptureState::Recording => "recording",
            MainCaptureState::Streaming => "streaming",
            MainCaptureState::Stopping => "stopping",
            MainCaptureState::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_states_by_name() {
        for (state, active) in [
            (MainCaptureState::Idle, false),
            (MainCaptureState::Starting, true),
            (MainCaptureState::Recording, true),
            (MainCaptureState::Streaming, true),
            (MainCaptureState::Stopping, true),
            (MainCaptureState::Failed, false),
            (MainCaptureState::Unknown, false),
        ] {
            assert_eq!(state.is_active(), active, "{}", state.as_str());
        }
    }

    #[test]
    fn unknown_blocks_an_interruption_only_with_a_backend() {
        assert!(MainCaptureState::Unknown.blocks_interruption(true));
        assert!(MainCaptureState::Recording.blocks_interruption(true));
        assert!(!MainCaptureState::Idle.blocks_interruption(true));
        assert!(!MainCaptureState::Failed.blocks_interruption(true));
        assert!(!MainCaptureState::Unknown.blocks_interruption(false));
        assert!(!MainCaptureState::Streaming.blocks_interruption(false));
    }
}
