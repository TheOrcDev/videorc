//! Output observations, never a replacement for the native recording owner.
//! Only this allowlisted projection may cross the agent boundary. In particular
//! CloudStatus contains room invite URLs and must not be serialized wholesale.
use crate::cloud_show::CloudStatus;
use crate::cloud_talk::CloudRoomPhase;
use crate::protocol::{RecordingState, RecordingStatus};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSessionFacts<'a> {
    pub owner: &'static str,
    pub activity: &'static str,
    pub freshness: &'static str,
    pub room_open: bool,
    pub recording: bool,
    pub live: bool,
    pub show_id: Option<&'a str>,
    pub native_session_id: Option<&'a str>,
    // These identities must come from the owner protocol, never a polling edge.
    pub publisher_epoch: Option<&'a str>,
    pub live_interval_id: Option<&'a str>,
    pub recording_take_id: Option<&'a str>,
    pub clock: OutputClock<'a>,
    pub microphone_muted: Option<bool>,
    pub camera_off: Option<bool>,
    pub destinations: Option<Vec<OutputDestination<'a>>>,
    pub effective_profiles: Option<&'a str>,
    pub terminal_reason: Option<&'a str>,
    pub capabilities: OutputCapabilities,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputClock<'a> {
    pub origin: &'static str,
    pub live_since: Option<&'a str>,
    pub recording_since: Option<&'a str>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputCapabilities {
    pub independent_stops: bool,
    pub microphone: bool,
    pub camera: bool,
}

#[derive(Debug, Serialize)]
pub struct OutputDestination<'a> {
    pub id: &'a str,
    pub platform: &'static str,
    pub label: &'a str,
    pub state: crate::streaming::StreamTargetState,
}

pub fn project<'a>(native: &'a RecordingStatus, cloud: &'a CloudStatus) -> OutputSessionFacts<'a> {
    let room = cloud
        .room
        .as_ref()
        .filter(|r| r.phase != CloudRoomPhase::Closed);
    let cloud_owner = room.is_some();
    let recording = if cloud_owner {
        cloud.recording.as_ref().is_some_and(|r| r.active)
    } else {
        !native.replay_only && matches!(native.state, RecordingState::Recording)
    };
    let live = if cloud_owner {
        room.is_some_and(|r| r.live)
    } else {
        !native.replay_only
            && (matches!(native.state, RecordingState::Streaming)
                || (matches!(native.state, RecordingState::Recording)
                    && native.stream_url.is_some()))
    };
    OutputSessionFacts {
        owner: if cloud_owner { "cloud-room" } else { "native" },
        activity: if !cloud_owner
            && !native.replay_only
            && matches!(
                native.state,
                RecordingState::Starting | RecordingState::Stopping | RecordingState::Failed
            ) {
            match native.state {
                RecordingState::Starting => "starting",
                RecordingState::Stopping => "stopping",
                _ => "failed",
            }
        } else {
            match (recording, live, room.is_some()) {
                (true, true, _) => "recording-and-live",
                (_, true, _) => "live",
                (true, _, _) => "recording",
                (_, _, true) => "room",
                _ => "idle",
            }
        },
        freshness: if !cloud_owner || cloud.connected {
            "fresh"
        } else {
            "stale"
        },
        room_open: room.is_some(),
        recording,
        live,
        show_id: if cloud_owner {
            cloud.show.as_ref().map(|s| s.id.as_str())
        } else {
            None
        },
        native_session_id: if cloud_owner {
            None
        } else {
            native.session_id.as_deref()
        },
        publisher_epoch: None,
        live_interval_id: cloud
            .live_interval
            .as_ref()
            .map(|interval| interval.id.as_str()),
        recording_take_id: None,
        clock: OutputClock {
            origin: if cloud_owner {
                "cloud-owner"
            } else {
                "native-session"
            },
            live_since: if cloud_owner {
                room.and_then(|r| r.live_since.as_deref())
            } else if live {
                native.started_at.as_deref()
            } else {
                None
            },
            recording_since: if cloud_owner {
                cloud.recording.as_ref().and_then(|r| r.since.as_deref())
            } else if recording {
                native.started_at.as_deref()
            } else {
                None
            },
        },
        // Renderer track confirmation is projected separately from agent.surface.
        microphone_muted: None,
        camera_off: None,
        destinations: if cloud_owner {
            Some(
                cloud
                    .legs
                    .iter()
                    .map(|t| OutputDestination {
                        id: &t.target_id,
                        platform: crate::streaming::stream_platform_id(t.platform),
                        label: &t.label,
                        state: t.state,
                    })
                    .collect(),
            )
        } else {
            None
        },
        effective_profiles: None,
        terminal_reason: if cloud_owner {
            cloud.end_reason.as_deref().filter(|reason| {
                matches!(
                    *reason,
                    "host-ended"
                        | "ended-by-host"
                        | "show-gone"
                        | "node-unreachable"
                        | "hold-limit"
                        | "media-lost"
                        | "handover-failed"
                        | "max-show"
                )
            })
        } else if matches!(native.state, RecordingState::Failed) {
            Some("native-session-failed")
        } else {
            None
        },
        capabilities: OutputCapabilities {
            independent_stops: cloud_owner,
            microphone: false,
            camera: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cloud_outputs_do_not_fabricate_native_capture_or_leak_invites() {
        let native: RecordingStatus = serde_json::from_value(json!({"state": "idle"})).unwrap();
        let mut cloud = crate::cloud_show::CloudShowRuntime::default().status();
        cloud.show = Some(
            serde_json::from_value(json!({
                "id": "show-1", "nodeId": "managed", "resumable": false, "kind": "talk"
            }))
            .unwrap(),
        );
        cloud.room = Some(
            serde_json::from_value(json!({
                "phase": "open", "inviteUrl": "https://secret.invalid/invite", "doorOpen": false,
                "declinedCount": 0, "stage": {"layout": "solo", "onStage": []}, "hostAway": false,
                "connected": true, "client": "connected", "returnEnabled": false, "stageSet": true,
                "live": false
            }))
            .unwrap(),
        );
        for (recording, live, activity) in [
            (false, false, "room"),
            (true, false, "recording"),
            (false, true, "live"),
            (true, true, "recording-and-live"),
        ] {
            cloud.room.as_mut().unwrap().live = live;
            cloud.recording = Some(
                serde_json::from_value(json!({"active": recording, "seconds": 0, "bytes": 0}))
                    .unwrap(),
            );
            let facts = project(&native, &cloud);
            assert_eq!(facts.activity, activity);
            assert_eq!(facts.native_session_id, None);
            assert_eq!(facts.publisher_epoch, None);
            assert_eq!(facts.microphone_muted, None);
            assert_eq!(facts.freshness, "stale");
            assert!(
                !serde_json::to_string(&facts)
                    .unwrap()
                    .contains("secret.invalid")
            );
        }
        assert!(matches!(native.state, RecordingState::Idle));
    }

    #[test]
    fn native_replay_is_idle_and_record_plus_stream_remains_both() {
        let cloud = crate::cloud_show::CloudShowRuntime::default().status();
        let mut native: RecordingStatus = serde_json::from_value(json!({
            "state": "recording", "sessionId": "native", "streamUrl": "secret-url", "replayOnly": true
        })).unwrap();
        assert_eq!(project(&native, &cloud).activity, "idle");
        native.replay_only = false;
        let facts = project(&native, &cloud);
        assert_eq!(facts.activity, "recording-and-live");
        assert!(
            !serde_json::to_string(&facts)
                .unwrap()
                .contains("secret-url")
        );
    }
}
