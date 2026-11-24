//! S1.6d: `CloudStatus.room` and `CloudStatus.recording` as the Guests page,
//! the Show stage and the Studio's Session row read them. The backend's types
//! live in `videorc-backend/src/cloud_talk.rs`, not the protocol, so this is
//! a lenient read-only mirror (as S1.6c's `livestream::cloud_status` is for
//! the rest of `CloudStatus`): every field defaults, and an enum value this
//! reader doesn't know lands on the value the backend itself falls back to.

use serde::Deserialize;

/// `CloudRoomPhase`. Anything else reads as closed, as the page does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomPhase {
    Opening,
    Open,
    Closing,
    #[default]
    #[serde(other)]
    Closed,
}

/// `CloudStageLayout`: the four layouts on the wire. Two screens is
/// `ScreenPeople` with two `screens` (plan 251), see [`DrawnStageLayout`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StageLayout {
    SideBySide,
    ScreenPeople,
    Spotlight,
    #[default]
    #[serde(other)]
    Solo,
}

impl StageLayout {
    /// Every wire layout, in the order the layout cards show them.
    pub const ALL: [StageLayout; 4] = [
        StageLayout::Solo,
        StageLayout::SideBySide,
        StageLayout::ScreenPeople,
        StageLayout::Spotlight,
    ];

    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Solo => "solo",
            Self::SideBySide => "side-by-side",
            Self::ScreenPeople => "screen-people",
            Self::Spotlight => "spotlight",
        }
    }
}

/// `DrawnStageLayout`: what the program draws after its fallbacks.
/// `TwoScreens` is never sent (plan 251).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DrawnStageLayout {
    Solo,
    SideBySide,
    ScreenPeople,
    Spotlight,
    TwoScreens,
}

impl From<StageLayout> for DrawnStageLayout {
    fn from(layout: StageLayout) -> Self {
        match layout {
            StageLayout::Solo => Self::Solo,
            StageLayout::SideBySide => Self::SideBySide,
            StageLayout::ScreenPeople => Self::ScreenPeople,
            StageLayout::Spotlight => Self::Spotlight,
        }
    }
}

impl DrawnStageLayout {
    /// The spelling the fixtures and the page use (`two-screens` included).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Solo => "solo",
            Self::SideBySide => "side-by-side",
            Self::ScreenPeople => "screen-people",
            Self::Spotlight => "spotlight",
            Self::TwoScreens => "two-screens",
        }
    }
}

/// `CloudRoomQuality`; the backend reads an unknown value as good.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomQuality {
    Excellent,
    Poor,
    Lost,
    #[default]
    #[serde(other)]
    Good,
}

/// `CloudRoomRole`; anyone not the host is a guest.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomRole {
    Host,
    #[default]
    #[serde(other)]
    Guest,
}

/// `CloudGuestDevice`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuestDevice {
    Phone,
    #[default]
    #[serde(other)]
    Computer,
}

/// `CloudRoomClientState`: the host's own room connection as it reported it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomClientState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    #[default]
    #[serde(other)]
    Idle,
}

/// `CloudHostShape`: the host's camera shape from Sources (D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostShape {
    Rounded,
    Circle,
}

/// `CloudRoomRequest`: someone waiting for Let in or Decline.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomRequest {
    pub request_id: String,
    pub name: String,
    pub asked_at: String,
    pub device: GuestDevice,
}

/// `CloudRoomGuest`: a guest the host let in, as the web lists them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomGuest {
    pub guest_id: String,
    pub name: String,
    pub joined_at: String,
    /// The host's hold on the guest's mic (D14).
    pub muted: bool,
    pub screen_share_allowed: bool,
}

/// `CloudRoomParticipant`: one person as the runner sees them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomParticipant {
    pub identity: String,
    pub name: String,
    pub role: RoomRole,
    pub on_stage: bool,
    pub video: bool,
    pub audio: bool,
    pub muted: bool,
    pub screen: bool,
    pub quality: RoomQuality,
    pub since_ms: u64,
    pub away: bool,
}

/// `CloudStage`: the whole stage this desktop last set. `screens` is empty
/// (absent on the wire) or names exactly two (plan 251).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stage {
    pub layout: StageLayout,
    pub on_stage: Vec<String>,
    pub spotlight: Option<String>,
    pub screen: Option<String>,
    pub screens: Vec<String>,
    pub host_shape: Option<HostShape>,
}

/// `CloudRoomShown` (review M2): what the program draws of the stage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomShown {
    pub on_stage: Vec<String>,
    pub screen: Option<String>,
    pub screens: Vec<String>,
    pub layout: Option<String>,
    pub stage_key: Option<String>,
    pub at: Option<String>,
}

/// `TalkLimits` (D15): the open room's seats.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TalkLimits {
    pub guests_on_stage: u32,
    pub room_size: u32,
    pub recording_retention_days: u32,
}

/// `CloudRoomStatus`: everything the Guests page, the Show stage and the
/// backstage strip draw. Secret-free on the backend's side.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoomStatus {
    pub phase: RoomPhase,
    pub invite_url: Option<String>,
    pub invite_expires_at: Option<String>,
    pub door_open: bool,
    pub title: Option<String>,
    pub platforms: Vec<String>,
    pub requests: Vec<RoomRequest>,
    pub guests: Vec<RoomGuest>,
    pub declined_count: u32,
    pub participants: Vec<RoomParticipant>,
    pub stage: Stage,
    pub host_away: bool,
    /// The runner is in the LiveKit room.
    pub connected: bool,
    pub limits: Option<TalkLimits>,
    pub client: RoomClientState,
    pub return_enabled: bool,
    pub stage_set: bool,
    pub shown: Option<RoomShown>,
    /// On air: the runner holds platform legs for this room.
    pub live: bool,
    pub live_since: Option<String>,
    pub message: Option<String>,
}

/// `CloudRecordingStatus` (D10): the cloud recording of the program.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordingStatus {
    pub active: bool,
    pub since: Option<String>,
    pub seconds: u64,
    pub bytes: u64,
    pub orientations: Vec<String>,
    pub problem: Option<String>,
}

impl RoomStatus {
    /// `CloudStatus.room` as S1.6c's mirror keeps it (a JSON value). A value
    /// that isn't an object reads as no room, never an error.
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        value
            .is_object()
            .then(|| serde_json::from_value(value.clone()).ok())
            .flatten()
    }
}

impl RecordingStatus {
    /// `CloudStatus.recording` from S1.6c's mirror.
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        value
            .is_object()
            .then(|| serde_json::from_value(value.clone()).ok())
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_room_as_the_backend_sends_it_reads_whole() {
        let room = RoomStatus::from_value(&json!({
            "phase": "open",
            "inviteUrl": "https://videorc.com/g/abc",
            "doorOpen": true,
            "platforms": ["youtube", "twitch"],
            "requests": [{ "requestId": "r1", "name": "Ada", "askedAt": "t", "device": "phone" }],
            "guests": [{ "guestId": "g_1", "name": "Bo", "joinedAt": "t", "muted": true, "screenShareAllowed": true }],
            "declinedCount": 2,
            "participants": [{
                "identity": "g_1", "name": "Bo", "role": "guest", "onStage": true, "video": true,
                "audio": true, "muted": false, "screen": false, "quality": "poor", "sinceMs": 5, "away": false
            }],
            "stage": { "layout": "screen-people", "onStage": ["host:sh_1", "g_1"], "screen": "g_1", "hostShape": "circle" },
            "hostAway": false,
            "connected": true,
            "limits": { "guestsOnStage": 5, "roomSize": 10, "recordingRetentionDays": 30 },
            "client": "connected",
            "returnEnabled": true,
            "stageSet": true,
            "shown": { "onStage": ["g_1"], "screen": "g_1" },
            "live": true
        }))
        .unwrap();
        assert_eq!(room.phase, RoomPhase::Open);
        assert_eq!(room.requests[0].device, GuestDevice::Phone);
        assert!(room.guests[0].muted && room.guests[0].screen_share_allowed);
        assert_eq!(room.participants[0].quality, RoomQuality::Poor);
        assert_eq!(room.stage.layout, StageLayout::ScreenPeople);
        assert_eq!(room.stage.host_shape, Some(HostShape::Circle));
        assert!(room.stage.screens.is_empty());
        assert_eq!(room.limits.unwrap().room_size, 10);
        assert_eq!(room.client, RoomClientState::Connected);
        assert_eq!(room.shown.unwrap().on_stage, vec!["g_1".to_string()]);
    }

    #[test]
    fn unknown_values_land_where_the_backend_lands_them() {
        let room = RoomStatus::from_value(&json!({
            "phase": "paused",
            "client": "sleeping",
            "stage": { "layout": "mosaic" },
            "participants": [{ "identity": "x", "role": "runner", "quality": "superb" }],
            "requests": [{ "requestId": "r", "device": "tablet" }]
        }))
        .unwrap();
        assert_eq!(room.phase, RoomPhase::Closed);
        assert_eq!(room.client, RoomClientState::Idle);
        assert_eq!(room.stage.layout, StageLayout::Solo);
        assert_eq!(room.participants[0].role, RoomRole::Guest);
        assert_eq!(room.participants[0].quality, RoomQuality::Good);
        assert_eq!(room.requests[0].device, GuestDevice::Computer);
    }

    #[test]
    fn no_room_is_none_never_an_error() {
        assert_eq!(RoomStatus::from_value(&serde_json::Value::Null), None);
        assert_eq!(RoomStatus::from_value(&json!("open")), None);
        assert_eq!(RecordingStatus::from_value(&json!(null)), None);
        let recording =
            RecordingStatus::from_value(&json!({ "active": true, "seconds": 12 })).unwrap();
        assert!(recording.active);
        assert_eq!(recording.seconds, 12);
    }
}
