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

use videorc_protocol::{RecordingState, RecordingStatus};

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
    /// `captureStateAfterStatusPayload`: a buffer-only session (plan 181)
    /// writes nothing permanent, so main reads it as idle. (`from_snapshot`,
    /// the Studio's view, comes with the Studio area, S1.6a.)
    pub fn from_status(status: &RecordingStatus) -> Self {
        if status.replay_only {
            return MainCaptureState::Idle;
        }
        match status.state {
            RecordingState::Idle => MainCaptureState::Idle,
            RecordingState::Starting => MainCaptureState::Starting,
            RecordingState::Recording => MainCaptureState::Recording,
            RecordingState::Streaming => MainCaptureState::Streaming,
            RecordingState::Stopping => MainCaptureState::Stopping,
            RecordingState::Failed => MainCaptureState::Failed,
        }
    }

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

/// Plan 249 S26 (`shared/cloud-room-activity.ts`): this computer's cloud
/// room on air or recording. A room has no local session, so
/// `recording.status` alone calls the app idle while the room is live; the
/// guards read the room as live activity too ([`guard_capture_state`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudRoomActivity {
    /// The room is open and on air, and this computer is the one on air.
    Live,
    /// The same room, not on air, with the cloud recording running.
    Recording,
}

impl CloudRoomActivity {
    /// `cloudRoomActivityFromCloudStatus`: a `cloud.state` payload (or the
    /// `cloud.status` answer), read field by field. `None` for anything that
    /// is not this computer's open room on air or recording.
    pub fn from_cloud_status(payload: &serde_json::Value) -> Option<Self> {
        let status = payload.as_object()?;
        let room = status.get("room").and_then(serde_json::Value::as_object);
        if room
            .and_then(|room| room.get("phase"))
            .and_then(|phase| phase.as_str())
            != Some("open")
        {
            return None;
        }
        // `stoppedBy !== undefined`: present at all, even null, means stopped.
        if status.contains_key("stoppedBy") {
            return None;
        }
        if let Some(on_air) = status.get("onAir") {
            let this_device = on_air.get("thisDevice") == Some(&serde_json::Value::Bool(true));
            let waiting = on_air.get("waiting") == Some(&serde_json::Value::Bool(true));
            if !this_device || waiting {
                return None;
            }
        }
        let room = room?;
        if room.get("live") == Some(&serde_json::Value::Bool(true)) {
            return Some(CloudRoomActivity::Live);
        }
        let recording = status
            .get("recording")
            .and_then(|recording| recording.get("active"));
        if recording == Some(&serde_json::Value::Bool(true)) {
            return Some(CloudRoomActivity::Recording);
        }
        None
    }
}

/// `guardCaptureState` (`main/live-activity.ts`): the capture state every
/// lifecycle guard reads. The local session's, or the room's activity in its
/// words when the local session is idle (or failed). Unknown stays unknown
/// (the guards already fail closed on it), and an active local session is
/// never downgraded.
pub fn guard_capture_state(
    capture: MainCaptureState,
    room: Option<CloudRoomActivity>,
) -> MainCaptureState {
    let Some(room) = room else {
        return capture;
    };
    if capture == MainCaptureState::Unknown || capture.is_active() {
        return capture;
    }
    match room {
        CloudRoomActivity::Live => MainCaptureState::Streaming,
        CloudRoomActivity::Recording => MainCaptureState::Recording,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_live_room_guards_an_idle_local_session() {
        use MainCaptureState::*;
        let live = Some(CloudRoomActivity::Live);
        let recording = Some(CloudRoomActivity::Recording);
        assert_eq!(guard_capture_state(Idle, live), Streaming);
        assert_eq!(guard_capture_state(Failed, live), Streaming);
        assert_eq!(guard_capture_state(Idle, recording), Recording);
        assert_eq!(guard_capture_state(Idle, None), Idle);
        // Unknown stays unknown; an active session is never downgraded.
        assert_eq!(guard_capture_state(Unknown, live), Unknown);
        assert_eq!(guard_capture_state(Recording, live), Recording);
        assert_eq!(guard_capture_state(Stopping, recording), Stopping);
        assert!(guard_capture_state(Idle, live).blocks_interruption(true));
    }

    #[test]
    fn cloud_status_reads_as_electron_reads_it() {
        let read = |value| CloudRoomActivity::from_cloud_status(&value);
        assert_eq!(
            read(json!({"room": {"phase": "open", "live": true}})),
            Some(CloudRoomActivity::Live)
        );
        assert_eq!(
            read(json!({"room": {"phase": "open", "live": false}, "recording": {"active": true}})),
            Some(CloudRoomActivity::Recording)
        );
        assert_eq!(
            read(json!({"room": {"phase": "open", "live": true}, "onAir": {"thisDevice": true}})),
            Some(CloudRoomActivity::Live)
        );
        // Another computer on air, a hand-off wait, a stop, a closed room.
        for value in [
            json!({"room": {"phase": "open", "live": true}, "onAir": {"thisDevice": false}}),
            json!({"room": {"phase": "open", "live": true}, "onAir": {"thisDevice": true, "waiting": true}}),
            json!({"room": {"phase": "open", "live": true}, "onAir": null}),
            json!({"room": {"phase": "open", "live": true}, "stoppedBy": "takeover"}),
            json!({"room": {"phase": "open", "live": true}, "stoppedBy": null}),
            json!({"room": {"phase": "closed", "live": true}}),
            json!({"room": null}),
            json!({"room": {"phase": "open"}}),
            json!("open"),
        ] {
            assert_eq!(read(value.clone()), None, "{value}");
        }
    }

    fn status(state: RecordingState, replay_only: bool) -> RecordingStatus {
        let mut status: RecordingStatus = serde_json::from_value(serde_json::json!({
            "state": "idle",
            "replayOnly": replay_only,
        }))
        .unwrap();
        status.state = state;
        status
    }

    #[test]
    fn a_clips_buffer_reads_as_idle_and_the_rest_by_name() {
        assert_eq!(
            MainCaptureState::from_status(&status(RecordingState::Recording, true)),
            MainCaptureState::Idle
        );
        for (state, expected) in [
            (RecordingState::Idle, MainCaptureState::Idle),
            (RecordingState::Starting, MainCaptureState::Starting),
            (RecordingState::Recording, MainCaptureState::Recording),
            (RecordingState::Streaming, MainCaptureState::Streaming),
            (RecordingState::Stopping, MainCaptureState::Stopping),
            (RecordingState::Failed, MainCaptureState::Failed),
        ] {
            assert_eq!(
                MainCaptureState::from_status(&status(state, false)),
                expected
            );
        }
    }

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
