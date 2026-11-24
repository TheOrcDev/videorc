//! S1.6c: `CloudStatus` as the solo-cloud surfaces read it (the `cloud.state`
//! event and the `cloud.status` answer). The backend's type lives in
//! `videorc-backend/src/cloud_show.rs`, not the protocol, so this is a
//! lenient read-only mirror: every field defaults, the enums stay strings,
//! and the room, recording, program, output health and controller stay
//! `Value` until the talk-show slice (S1.6d) reads them.

use serde::Deserialize;
use serde_json::Value;
use videorc_protocol::AiCapabilitiesCloud;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudStatus {
    /// `off`, `connecting`, `live`, `hold`, `resuming`, `ending` or `failed`.
    pub phase: String,
    /// The account's `cloud` block says on.
    pub entitled: bool,
    /// `premium` or `max`: the account's plan, whether or not its cloud is
    /// on right now.
    pub plan: Option<String>,
    pub settings: CloudSettings,
    pub allowance: Option<AiCapabilitiesCloud>,
    pub show: Option<CloudShow>,
    pub session_id: Option<String>,
    pub connected: bool,
    pub hold: Option<CloudHold>,
    pub on_air: Option<CloudOnAirDevice>,
    /// `hand-off` or `taken-over`.
    pub stopped_by: Option<String>,
    pub live_seconds: Option<u64>,
    pub fallback: Option<CloudFallback>,
    pub end_reason: Option<String>,
    pub message: Option<String>,
    pub direct_fallback_available: bool,
    pub test: Option<CloudTestStatus>,
    pub restart: Option<CloudRestart>,
    pub allowance_past: Option<CloudAllowancePast>,
    pub announce: Option<bool>,
    pub room: Option<Value>,
    pub recording: Option<Value>,
    /// The span the show is live on the platforms (`CloudLiveInterval`).
    pub live_interval: Option<CloudLiveInterval>,
    /// The runner's platform legs, keyed by target id.
    pub legs: Vec<CloudLeg>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudLiveInterval {
    pub id: String,
    pub end_requested_at: Option<String>,
}

/// One leg as `waitForCloudProviderOutput` reads it (`StreamTargetRuntime`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudLeg {
    pub target_id: String,
    /// `idle`, `connecting`, `live`, `warning`, `failed` or `stopped`.
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudSettings {
    pub enabled: bool,
    pub hold_max_seconds: u32,
    pub hold_max_choices: Vec<u32>,
    pub hold_image_screen_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudShow {
    pub id: String,
    /// `livekit` for a managed show (videorc.com runs it), else the node.
    pub node_id: String,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
    /// Live on the runner with no local feed: Resume or End.
    pub resumable: bool,
    /// `solo`, `talk` or `test`.
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudHold {
    pub active: bool,
    pub since: Option<String>,
    pub reason: Option<String>,
    pub remaining_seconds: Option<u64>,
}

/// `CloudOnAir`: the device on air for the show (plan 243).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudOnAirDevice {
    pub name: Option<String>,
    /// `computer`, `phone`, `browser` or `unknown`.
    pub kind: String,
    /// `feed`, `camera`, `host` or `unknown`.
    pub source: String,
    pub waiting: bool,
    pub this_device: bool,
    pub since: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudFallback {
    /// `CloudFallbackReason`, kebab-case (`cloud-full`, …).
    pub reason: String,
    pub at: String,
    pub session_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudTestStatus {
    /// `creating`, `connecting`, `pushing`, `ending` or `done`.
    pub phase: String,
    pub started_at: String,
    pub result: Option<CloudTestResult>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudTestResult {
    pub ok: bool,
    /// `CloudTestReason`, kebab-case (`too-slow`, …).
    pub reason: Option<String>,
    pub message: Option<String>,
    pub time_to_live_ms: Option<u64>,
    pub uploads: Vec<CloudTestUpload>,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudTestUpload {
    pub orientation: String,
    pub target_kbps: u32,
    pub measured_kbps: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudRestart {
    pub at: String,
    pub destinations_resent: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudAllowancePast {
    pub seconds: u64,
}

impl CloudStatus {
    /// A `cloud.state` or `cloud.status` payload; `None` when it isn't an
    /// object at all.
    pub fn from_value(value: &Value) -> Option<Self> {
        value
            .is_object()
            .then(|| serde_json::from_value(value.clone()).ok())
            .flatten()
    }

    /// The show is live from another device, not waiting for one.
    pub fn live_elsewhere(&self) -> bool {
        self.on_air
            .as_ref()
            .is_some_and(|on_air| !on_air.this_device && !on_air.waiting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_backend_status_reads_and_unknown_fields_are_ignored() {
        let status = CloudStatus::from_value(&json!({
            "phase": "hold",
            "entitled": true,
            "plan": "premium",
            "settings": {"enabled": true, "holdMaxSeconds": 1800, "holdMaxChoices": [300, 1800, 3600]},
            "allowance": {"enabled": true, "secondsPerMonth": 360000, "secondsUsed": 3600, "overageSeconds": 0, "resetAt": "2035-02-01T00:00:00Z"},
            "show": {"id": "s1", "nodeId": "livekit", "resumable": true, "kind": "solo"},
            "connected": true,
            "hold": {"active": true, "remainingSeconds": 1700},
            "onAir": {"kind": "phone", "source": "camera", "waiting": false, "thisDevice": false, "since": "2035-01-01T00:00:00Z", "name": "iPhone"},
            "directFallbackAvailable": false,
            "legs": [{"targetId": "t1"}],
            "program": {"fps": 30},
            "outputHealth": [],
            "futureField": 1
        }))
        .unwrap();
        assert_eq!(status.phase, "hold");
        assert_eq!(status.settings.hold_max_choices, [300, 1800, 3600]);
        assert_eq!(status.allowance.as_ref().unwrap().seconds_used, 3600);
        assert_eq!(status.show.as_ref().unwrap().node_id, "livekit");
        assert_eq!(status.hold.as_ref().unwrap().remaining_seconds, Some(1700));
        assert!(status.live_elsewhere());
        assert_eq!(CloudStatus::from_value(&json!(null)), None);
        assert_eq!(
            CloudStatus::from_value(&json!({"phase": 3})),
            None,
            "a field of the wrong type refuses the whole status"
        );
    }
}
