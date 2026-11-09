//! Talk shows (plan 224): the room behind a cloud show, with browser guests.
//!
//! A talk show is a cloud show of `kind: "talk"`. The web creates the LiveKit
//! room with the show and mints the host's token; the runner joins the room
//! hidden, composes the stage from the room's tracks and sends it everywhere.
//! This desktop never feeds a talk show: the host's camera, microphone and
//! screen are published by the renderer with `livekit-client` (D6), the
//! backend lends the camera for the room's life and takes it back after
//! (`CloudCameraHook`), and Go Live hands the destinations to the runner with
//! no local leg (D17, C-G6). Record is the cloud recording (D10).
//!
//! Rules that shape this module:
//! - The host token is a secret. It reaches the renderer through one RPC,
//!   `cloud.room.token.refresh` (renderer role only), and never a log, the
//!   `cloud.state` event or a settings row. `Debug` on every type that holds
//!   one redacts it.
//! - Nobody enters the room without Let in while the door is closed, and
//!   nobody reaches the stage without `stage.set` from this desktop (D4). The
//!   web decides let-in; the runner shows what `stage.set` names.
//! - Where the built web (`videorc-web` `be159d28`) or the runner's wire
//!   notes differ from plan 224, they win: the create's `room` block is
//!   `{ url, hostToken, name }`, `GET …/room` is `{ room, invite }`, the
//!   guests list carries a `cursor`, `stage.set` takes `hostShape`,
//!   `overlay.set`'s rect is normalized, and End livestream is the runner's
//!   `legs.end` (D17): every platform leg ends, the room stays, and "on air"
//!   is read from the runner's legs, never from its `phase`.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cloud_show::{
    ACK_TIMEOUT, ActiveShow, CloudApiError, CloudShowContext, CloudShowRuntime, CloudStatus,
    CloudWebApi, ControlConnector, CreateShowRequest, HandoverDestination, HelloFailure,
    ShowOutputSpec, client_info, connect_and_hello, install_control_loop, lock, new_intent_id,
    send_intent,
};

/// `cloud.room.requests`: one event per new "wants to join" (plan 224).
pub const CLOUD_ROOM_REQUESTS_EVENT: &str = "cloud.room.requests";
/// The return the runner publishes back into the room (R-G5): 720p.
pub const RETURN_WIDTH: u32 = 1280;
pub const RETURN_HEIGHT: u32 = 720;
/// The guests long-poll (W-G2) answers within 25 s; a fake that answers at
/// once must not spin, so every round rests this long before the next.
const GUESTS_POLL_REST: Duration = Duration::from_millis(1000);
/// After a failed guests poll: rest longer, then try again.
const GUESTS_POLL_BACKOFF: Duration = Duration::from_secs(5);
/// The most people a `stage.set` may name (the runner's `MAX_ON_STAGE`).
pub const MAX_ON_STAGE: usize = 8;

// --- Wire: desktop -> web ---------------------------------------------------

/// `room` on `POST /api/cloud/shows` with `kind: "talk"` (the web's
/// `parseTalkRoomOptions`): the return's size, the show's title and the
/// platform names for the consent line (D13).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateShowRoom {
    pub return_width: u32,
    pub return_height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
}

/// The create answer's `room` block: where the renderer joins and with what.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowRoomAnswer {
    pub url: String,
    pub host_token: String,
    #[serde(default)]
    pub name: String,
}

impl std::fmt::Debug for ShowRoomAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShowRoomAnswer")
            .field("url", &self.url)
            .field("host_token", &"••••")
            .field("name", &self.name)
            .finish()
    }
}

/// An invite link (D5). Not a secret: anyone with it may only ask to join.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowInvite {
    pub slug: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// The room's limits as the web opened it (plan 185; D15 picks the numbers).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TalkLimits {
    #[serde(default)]
    pub guests_on_stage: u32,
    #[serde(default)]
    pub room_size: u32,
    #[serde(default)]
    pub recording_retention_days: u32,
}

/// `POST /api/cloud/shows/:id/room/token` → a fresh 10-minute host token.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomTokenAnswer {
    pub host_token: String,
    pub url: String,
}

impl std::fmt::Debug for RoomTokenAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomTokenAnswer")
            .field("host_token", &"••••")
            .field("url", &self.url)
            .finish()
    }
}

/// `GET` and `PATCH /api/cloud/shows/:id/room`: the room's settings and (on
/// `GET`) its current invite, so a relaunched desktop finds the link (C-G8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettingsAnswer {
    pub room: RoomSettingsRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<ShowInvite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettingsRecord {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub open_door: bool,
    #[serde(default)]
    pub limits: TalkLimits,
}

/// `PATCH /api/cloud/shows/:id/room`'s body; every field optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoomPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_door: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
}

/// `GET /api/cloud/shows/:id/guests?since=` (the web's `HostGuestsView`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuestsAnswer {
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub declined_count: u32,
    #[serde(default)]
    pub guests: Vec<CloudRoomGuest>,
    #[serde(default)]
    pub requests: Vec<CloudRoomRequest>,
}

/// The host's two answers to "wants to join" (D4).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GuestDecision {
    LetIn,
    Decline,
}

/// What the host may do to a guest in the room (D14).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GuestAction {
    Mute,
    Unmute,
    Remove,
    Ban,
    Rename,
    AllowScreenShare,
    DisallowScreenShare,
}

/// `POST /api/cloud/shows/:id/guests/:guestId`'s body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuestActionBody {
    pub action: GuestAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Its answer: `ok`, and after a ban the invite that replaced the old one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuestActionAnswer {
    #[serde(default)]
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<ShowInvite>,
}

// --- Wire: the runner's state (talk-show blocks) ----------------------------

/// `state.room` (plan 224 Wire shape plus the runner's extra fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRoomState {
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub participants: Vec<RunnerParticipant>,
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub host_away: bool,
    #[serde(default)]
    pub return_enabled: bool,
    #[serde(default)]
    pub stage_set: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunnerParticipant {
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub on_stage: bool,
    #[serde(default)]
    pub video: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub screen: bool,
    #[serde(default)]
    pub quality: String,
    #[serde(default)]
    pub since_ms: u64,
    #[serde(default)]
    pub away: bool,
}

/// `state.recording` (D10 plus the runner's `problem`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRecordingState {
    #[serde(default)]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default)]
    pub seconds: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub orientations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

// --- Status: the renderer's secret-free view -------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudRoomPhase {
    #[default]
    Closed,
    Opening,
    Open,
    Closing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudStageLayout {
    #[default]
    Solo,
    SideBySide,
    ScreenPeople,
    Spotlight,
}

impl CloudStageLayout {
    fn as_str(self) -> &'static str {
        match self {
            Self::Solo => "solo",
            Self::SideBySide => "side-by-side",
            Self::ScreenPeople => "screen-people",
            Self::Spotlight => "spotlight",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "solo" => Some(Self::Solo),
            "side-by-side" => Some(Self::SideBySide),
            "screen-people" => Some(Self::ScreenPeople),
            "spotlight" => Some(Self::Spotlight),
            _ => None,
        }
    }
}

/// The host's camera shape from Sources (D8), applied to the host's tile.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudHostShape {
    Rounded,
    Circle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudRoomQuality {
    Excellent,
    #[default]
    Good,
    Poor,
    Lost,
}

impl CloudRoomQuality {
    fn parse(value: &str) -> Self {
        match value {
            "excellent" => Self::Excellent,
            "poor" => Self::Poor,
            "lost" => Self::Lost,
            _ => Self::Good,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudRoomRole {
    Host,
    #[default]
    Guest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudGuestDevice {
    Phone,
    #[default]
    Computer,
}

/// The renderer's own room connection, as it reports it
/// (`cloud.room.client.report`): the Studio's copy and the watchdog read it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CloudRoomClientState {
    #[default]
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// Someone who asked to join and waits for Let in or Decline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRoomRequest {
    pub request_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub asked_at: String,
    #[serde(default)]
    pub device: CloudGuestDevice,
}

/// A guest the host let in, as the web lists them (names live here; the
/// runner's participants carry the room's live facts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRoomGuest {
    pub guest_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub joined_at: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub screen_share_allowed: bool,
}

/// One person in the room as the runner sees them (`state.room.participants`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRoomParticipant {
    pub identity: String,
    #[serde(default)]
    pub name: String,
    pub role: CloudRoomRole,
    pub on_stage: bool,
    pub video: bool,
    pub audio: bool,
    pub muted: bool,
    pub screen: bool,
    pub quality: CloudRoomQuality,
    pub since_ms: u64,
    pub away: bool,
}

impl CloudRoomParticipant {
    fn from_runner(participant: &RunnerParticipant) -> Self {
        Self {
            identity: participant.identity.clone(),
            name: participant.name.clone(),
            role: if participant.role == "host" {
                CloudRoomRole::Host
            } else {
                CloudRoomRole::Guest
            },
            on_stage: participant.on_stage,
            video: participant.video,
            audio: participant.audio,
            muted: participant.muted,
            screen: participant.screen,
            quality: CloudRoomQuality::parse(&participant.quality),
            since_ms: participant.since_ms,
            away: participant.away,
        }
    }
}

/// The stage this desktop last set (`cloud.stage.set`, the runner's
/// `stage.set`): the whole stage in one frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudStage {
    #[serde(default)]
    pub layout: CloudStageLayout,
    #[serde(default)]
    pub on_stage: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spotlight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_shape: Option<CloudHostShape>,
}

impl CloudStage {
    /// The runner's `validate_stage`, applied before anything is sent.
    pub fn validate(&self) -> Result<()> {
        if self.on_stage.len() > MAX_ON_STAGE {
            bail!("A stage holds at most {MAX_ON_STAGE} people.");
        }
        let bad = |identity: &String| {
            identity.is_empty() || identity.len() > 128 || identity.chars().any(char::is_control)
        };
        if self.on_stage.iter().any(bad)
            || self.spotlight.as_ref().is_some_and(bad)
            || self.screen.as_ref().is_some_and(bad)
        {
            bail!("The stage names an identity that is empty or too long.");
        }
        Ok(())
    }

    pub(crate) fn frame(&self, id: &str) -> Value {
        let mut frame = json!({
            "t": "intent",
            "id": id,
            "kind": "stage.set",
            "layout": self.layout.as_str(),
            "onStage": self.on_stage,
        });
        if let Some(spotlight) = &self.spotlight {
            frame["spotlight"] = json!(spotlight);
        }
        if let Some(screen) = &self.screen {
            frame["screen"] = json!(screen);
        }
        if let Some(shape) = self.host_shape {
            frame["hostShape"] = json!(match shape {
                CloudHostShape::Rounded => "rounded",
                CloudHostShape::Circle => "circle",
            });
        }
        frame
    }
}

/// `CloudStatus.room`: everything the Guests tab, the Show stage and the
/// backstage strip draw. Secret-free by construction: no token, no key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRoomStatus {
    pub phase: CloudRoomPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_expires_at: Option<String>,
    pub door_open: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<CloudRoomRequest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guests: Vec<CloudRoomGuest>,
    pub declined_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<CloudRoomParticipant>,
    pub stage: CloudStage,
    pub host_away: bool,
    /// The runner is in the LiveKit room.
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<TalkLimits>,
    pub client: CloudRoomClientState,
    pub return_enabled: bool,
    pub stage_set: bool,
    /// On air: the runner holds platform legs for this room (`state.legs`
    /// non-empty, never its `phase`, which stays `live` after `legs.end`).
    pub live: bool,
    /// When this desktop handed the destinations over (the on-air clock for
    /// this Go Live; the runner's `liveSeconds` is not reset by `legs.end`).
    /// Absent after a resume, when the runner's clock is all there is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `CloudStatus.recording` (D10): the cloud recording of the program.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecordingStatus {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub seconds: u64,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orientations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

impl CloudRecordingStatus {
    pub fn from_runner(recording: &RunnerRecordingState) -> Self {
        Self {
            active: recording.active,
            since: recording.since.clone(),
            seconds: recording.seconds,
            bytes: recording.bytes,
            orientations: recording.orientations.clone(),
            problem: recording.problem.clone(),
        }
    }
}

// --- RPC params and the one token-carrying answer ---------------------------

/// `cloud.room.open`: the show's outputs (as a Go Live would create them),
/// a title and the platform names for the consent line.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomOpenParams {
    #[serde(default)]
    pub outputs: Vec<crate::cloud_show::CloudTestOutput>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDoorParams {
    pub open: bool,
}

/// `cloud.show.goLive` (C-G6): the destinations as the Go Live dialog
/// settled them; the backend resolves the keys and hands them over.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkGoLiveParams {
    pub streaming: crate::streaming::StreamingSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDecideParams {
    pub request_id: String,
    pub decision: GuestDecision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestActParams {
    pub guest_id: String,
    pub action: GuestAction,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomClientReportParams {
    pub state: CloudRoomClientState,
    #[serde(default)]
    pub detail: Option<String>,
}

/// `cloud.overlay.set`: a PNG into a runner slot (D9). The backend builds
/// these itself for cards and takeovers (C-G7); the RPC exists for the
/// smokes and for Be right back.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudOverlaySlot {
    Card,
    Takeover,
    Hold,
}

impl CloudOverlaySlot {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Card => "card",
            Self::Takeover => "takeover",
            Self::Hold => "hold",
        }
    }
}

/// `h` or `v`, as the runner spells an overlay's orientation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CloudOverlayOrientation {
    #[serde(rename = "h")]
    H,
    #[serde(rename = "v")]
    V,
}

impl CloudOverlayOrientation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::H => "h",
            Self::V => "v",
        }
    }
}

/// A normalized rect (0 to 1 of the output), the runner's `OverlayRect`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CloudOverlayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl CloudOverlayRect {
    pub const FULL: Self = Self {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };

    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.w, self.h]
            .iter()
            .all(|value| value.is_finite())
            && self.w > 0.0
            && self.h > 0.0
            && self.x >= 0.0
            && self.y >= 0.0
            && self.x + self.w <= 1.0 + 1e-4
            && self.y + self.h <= 1.0 + 1e-4
    }
}

/// The one answer that carries a token (`cloud.room.token.refresh`).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomTokenRefreshAnswer {
    pub host_token: String,
    pub url: String,
    /// `host:<showId>`: what the guest page trusts the stage topic from.
    pub identity: String,
    pub show_id: String,
}

impl std::fmt::Debug for RoomTokenRefreshAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomTokenRefreshAnswer")
            .field("host_token", &"••••")
            .field("url", &self.url)
            .field("identity", &self.identity)
            .field("show_id", &self.show_id)
            .finish()
    }
}

/// The host's LiveKit identity for a show (the web's `hostIdentity`).
pub fn host_identity(show_id: &str) -> String {
    format!("host:{show_id}")
}

/// The people the runner flags on stage, the host first and always (D8:
/// the runner composes only who the stage names, so a stage without the
/// host would take their camera and mic out of the program). The runner
/// itself is never a person on stage.
pub(crate) fn runner_on_stage(host: &str, participants: &[RunnerParticipant]) -> Vec<String> {
    let mut on_stage = vec![host.to_string()];
    for participant in participants {
        if participant.on_stage
            && participant.identity != host
            && !participant.identity.starts_with("runner:")
            && !participant.identity.is_empty()
            && !on_stage.contains(&participant.identity)
            && on_stage.len() < MAX_ON_STAGE
        {
            on_stage.push(participant.identity.clone());
        }
    }
    on_stage
}

/// What End livestream reads when the runner refused `legs.end` or never
/// answered: the problem itself, and what to do. The legs are still up.
pub fn legs_end_failure(problem: &str) -> String {
    let problem = problem.trim().trim_end_matches('.');
    if problem.is_empty() {
        "Couldn't end the livestream. Try again, or close the room.".to_string()
    } else {
        format!("Couldn't end the livestream: {problem}. Try again, or close the room.")
    }
}

// --- The camera hand-over (D6) -----------------------------------------------

/// What the backend does with its camera at the room's edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraHandover {
    /// The room opens: stop the preview camera with reason `talk-show` and
    /// refuse `preview.camera.start` until it comes back. Refused while a
    /// separate-source take records the camera (the ISO-take trap).
    Lend,
    /// The room closed: the preview camera may run again.
    Return,
}

pub type CloudCameraHook = Arc<
    dyn Fn(CameraHandover) -> Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// `cloud.room.requests`: one per new request, for the Studio's alert.
pub type CloudRequestHook = Arc<dyn Fn(CloudRoomRequest) + Send + Sync>;

// --- The runtime's talk-show state --------------------------------------------

/// What this desktop holds about its open room. Lives beside `show` in the
/// runtime; cleared with it. The token is the one secret here.
#[derive(Clone)]
pub(crate) struct TalkShowState {
    pub phase: CloudRoomPhase,
    pub room_url: String,
    pub host_token: String,
    pub invite: Option<ShowInvite>,
    pub door_open: bool,
    pub title: Option<String>,
    pub platforms: Vec<String>,
    pub limits: Option<TalkLimits>,
    pub requests: Vec<CloudRoomRequest>,
    pub guests: Vec<CloudRoomGuest>,
    pub declined_count: u32,
    pub stage: CloudStage,
    pub client: CloudRoomClientState,
    pub message: Option<String>,
    pub live: bool,
    /// When this desktop last handed destinations over (`CloudRoomStatus::live_since`).
    pub live_since: Option<String>,
    /// A `stage.set` of this desktop's own reached the runner: from then on
    /// the status shows this desktop's stage, not the runner's layout.
    pub stage_sent: bool,
    /// The guests long-poll's cursor and the generation its task checks.
    pub poll_cursor: Option<String>,
    pub poll_generation: u64,
    pub seen_requests: HashSet<String>,
}

impl std::fmt::Debug for TalkShowState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TalkShowState")
            .field("phase", &self.phase)
            .field("room_url", &self.room_url)
            .field("host_token", &"••••")
            .field("invite", &self.invite)
            .field("door_open", &self.door_open)
            .field("stage", &self.stage)
            .field("client", &self.client)
            .field("live", &self.live)
            .finish()
    }
}

impl TalkShowState {
    /// A room that just opened or was resumed. The stage starts as the
    /// runner's own default, the host alone on Solo (plan 224 D8): a Bring
    /// on edits this stage, so the first `stage.set` always names the host
    /// and the host's camera and mic never leave the program.
    fn new(
        room: ShowRoomAnswer,
        settings: RoomSettingsRecord,
        invite: Option<ShowInvite>,
        show_id: &str,
    ) -> Self {
        Self {
            phase: CloudRoomPhase::Open,
            room_url: room.url,
            host_token: room.host_token,
            invite,
            door_open: settings.open_door,
            title: (!settings.title.is_empty()).then_some(settings.title),
            platforms: settings.platforms,
            limits: Some(settings.limits),
            requests: Vec::new(),
            guests: Vec::new(),
            declined_count: 0,
            stage: CloudStage {
                layout: CloudStageLayout::Solo,
                on_stage: vec![host_identity(show_id)],
                spotlight: None,
                screen: None,
                host_shape: None,
            },
            client: CloudRoomClientState::Idle,
            message: None,
            live: false,
            live_since: None,
            stage_sent: false,
            poll_cursor: None,
            poll_generation: 0,
            seen_requests: HashSet::new(),
        }
    }

    pub(crate) fn status(&self, runner_room: Option<&RunnerRoomState>) -> CloudRoomStatus {
        CloudRoomStatus {
            phase: self.phase,
            invite_url: self.invite.as_ref().map(|invite| invite.url.clone()),
            invite_expires_at: self
                .invite
                .as_ref()
                .and_then(|invite| invite.expires_at.clone()),
            door_open: self.door_open,
            title: self.title.clone(),
            platforms: self.platforms.clone(),
            requests: self.requests.clone(),
            guests: self.guests.clone(),
            declined_count: self.declined_count,
            participants: runner_room
                .map(|room| {
                    room.participants
                        .iter()
                        .map(CloudRoomParticipant::from_runner)
                        .collect()
                })
                .unwrap_or_default(),
            stage: self.stage.clone(),
            host_away: runner_room.is_some_and(|room| room.host_away),
            connected: runner_room.is_some_and(|room| room.connected),
            limits: self.limits,
            client: self.client,
            return_enabled: runner_room.is_some_and(|room| room.return_enabled),
            stage_set: runner_room.is_some_and(|room| room.stage_set),
            live: self.live,
            live_since: self.live_since.clone(),
            message: self.message.clone(),
        }
    }
}

impl CloudShowRuntime {
    /// A room this desktop holds (opening, open or closing).
    pub fn talk_show_open(&self) -> bool {
        self.talk.as_ref().is_some_and(|talk| {
            matches!(
                talk.phase,
                CloudRoomPhase::Opening | CloudRoomPhase::Open | CloudRoomPhase::Closing
            )
        })
    }

    /// Plan 224 C-G7: the show id while the room is open and on air (its
    /// destinations were handed over): cards and takeovers go to the runner.
    pub fn talk_show_live_show_id(&self) -> Option<String> {
        let talk = self.talk.as_ref()?;
        if talk.phase != CloudRoomPhase::Open || !talk.live {
            return None;
        }
        self.show.as_ref().map(|show| show.record.id.clone())
    }

    /// The runner's stage as the status shows it, once a `stage.set` landed
    /// (the agent's re-handed one after a resume): until this desktop sends
    /// a stage of its own, the runner's layout and the people it flags on
    /// stage are the ones shown, so the first Bring on after a resume edits
    /// the stage the program has (H2), with the host always first.
    pub(crate) fn talk_layout_from_runner(&mut self) {
        let Some(room) = self.runner.as_ref().and_then(|runner| runner.room.as_ref()) else {
            return;
        };
        if !room.stage_set {
            return;
        }
        let Some(show_id) = self.show.as_ref().map(|show| show.record.id.clone()) else {
            return;
        };
        let Some(talk) = self.talk.as_mut() else {
            return;
        };
        if talk.stage_sent {
            return;
        }
        if let Some(layout) = CloudStageLayout::parse(&room.layout) {
            talk.stage.layout = layout;
        }
        talk.stage.on_stage = runner_on_stage(&host_identity(&show_id), &room.participants);
    }

    /// On air comes from the runner (D17, the wire notes on `legs.end`): a
    /// talk show is on air while the runner holds platform legs, whatever
    /// its `phase` says. The clock (`live_since`) is this desktop's own
    /// hand-over: Go Live sets it, `legs.end` clears it, and a resume leaves
    /// it absent so the runner's `liveSeconds` is the clock.
    pub(crate) fn talk_live_from_runner(&mut self) {
        let Some(runner) = self.runner.as_ref() else {
            return;
        };
        let on_air = !runner.legs.is_empty();
        if let Some(talk) = self.talk.as_mut() {
            talk.live = on_air;
        }
    }
}

/// `cloud.room.open` refused before anything reaches the web.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomOpenRefusal {
    SignedOut,
    NotEntitled,
    ShowLive,
    SessionActive,
    CameraBusy(String),
}

impl RoomOpenRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SignedOut => "cloud-signed-out",
            Self::NotEntitled => "cloud-not-entitled",
            Self::ShowLive => "cloud-show-live",
            Self::SessionActive => "cloud-room-session-active",
            Self::CameraBusy(_) => "cloud-room-camera-busy",
        }
    }
}

impl std::fmt::Display for RoomOpenRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => write!(f, "Sign in to Videorc to open a room."),
            Self::NotEntitled => write!(f, "Talk shows with guests come with Videorc Max."),
            Self::ShowLive => write!(
                f,
                "A show is already live through Videorc Cloud. End it first."
            ),
            Self::SessionActive => {
                write!(
                    f,
                    "Stop the recording or the livestream, then open the room."
                )
            }
            Self::CameraBusy(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for RoomOpenRefusal {}

impl<W: CloudWebApi, C: ControlConnector> CloudShowContext<W, C> {
    /// "Open the room" (D17): create the talk show, join its control socket,
    /// lend the camera, start the guests long-poll. The renderer joins the
    /// LiveKit room when the status says `open` (C-G4).
    pub async fn open_room(
        &self,
        bearer: Option<String>,
        params: RoomOpenParams,
        session_active: bool,
    ) -> Result<CloudStatus> {
        let Some(bearer) = bearer else {
            return Err(RoomOpenRefusal::SignedOut.into());
        };
        {
            let runtime = lock(&self.slot);
            if !runtime.entitlement.talk_shows() {
                return Err(RoomOpenRefusal::NotEntitled.into());
            }
            if runtime.show.is_some() || runtime.talk.is_some() {
                return Err(RoomOpenRefusal::ShowLive.into());
            }
            if session_active {
                return Err(RoomOpenRefusal::SessionActive.into());
            }
        }
        self.cancel_test().await;
        // The camera first: a refusal (a take records it) costs nothing on
        // the web, and a room without the host's camera is no show.
        if let Err(message) = (self.hooks.camera)(CameraHandover::Lend).await {
            return Err(RoomOpenRefusal::CameraBusy(message).into());
        }
        let outputs: Vec<ShowOutputSpec> =
            crate::recording::cloud_test_output_specs(&params.outputs);
        let hold_max_seconds = lock(&self.slot).settings.hold_max_seconds;
        let platforms = params.platforms.clone().unwrap_or_default();
        let request = CreateShowRequest {
            kind: "talk".to_string(),
            outputs,
            hold_max_seconds,
            client: client_info(),
            preferred_region: None,
            room: Some(CreateShowRoom {
                return_width: RETURN_WIDTH,
                return_height: RETURN_HEIGHT,
                title: params
                    .title
                    .clone()
                    .filter(|title| !title.trim().is_empty()),
                platforms: platforms.clone(),
            }),
        };
        let created = match self.web.create_show(&bearer, &request).await {
            Ok(created) => created,
            Err(error) => {
                let _ = (self.hooks.camera)(CameraHandover::Return).await;
                return Err(anyhow::Error::new(error));
            }
        };
        let show_id = created.show.id.clone();
        let (Some(room), Some(invite)) = (created.room.clone(), created.invite.clone()) else {
            let _ = self.web.end_show(&bearer, &show_id).await;
            let _ = (self.hooks.camera)(CameraHandover::Return).await;
            bail!("Videorc Cloud created the show without a room.");
        };
        if let Some(problem) =
            crate::cloud_show::control_url_problem(&created.control.url, cfg!(debug_assertions))
        {
            let _ = self.web.end_show(&bearer, &show_id).await;
            let _ = (self.hooks.camera)(CameraHandover::Return).await;
            bail!("{problem}");
        }
        let (transport, welcome) =
            match connect_and_hello(self.connector.as_ref(), &created.control).await {
                Ok(connected) => connected,
                Err(failure) => {
                    let _ = self.web.end_show(&bearer, &show_id).await;
                    let _ = (self.hooks.camera)(CameraHandover::Return).await;
                    let message = match failure {
                        HelloFailure::BadToken => "the node refused the show token".to_string(),
                        HelloFailure::NoSuchShow => "the node does not know the show".to_string(),
                        HelloFailure::Transport(message) => message,
                    };
                    bail!("Videorc Cloud could not be reached for the room: {message}");
                }
            };
        if let Some(allowance) = created.allowance.clone() {
            lock(&self.slot).replace_allowance(Some(allowance));
        }
        let generation = {
            let mut runtime = lock(&self.slot);
            runtime.failed = None;
            runtime.fallback = None;
            runtime.show = Some(ActiveShow {
                record: created.show.clone(),
                control: created.control.clone(),
                ingest: Some(created.ingest.clone()),
                session_id: None,
                destinations: Vec::new(),
                handed_over: false,
                hold_image_png_base64: None,
                resuming: false,
            });
            runtime.end_reason = None;
            runtime.message = None;
            runtime.restart = None;
            let mut talk = TalkShowState::new(
                room,
                RoomSettingsRecord {
                    title: params.title.unwrap_or_default(),
                    platforms,
                    open_door: false,
                    limits: created.limits.unwrap_or_default(),
                },
                Some(invite),
                &show_id,
            );
            talk.poll_generation = runtime.generation + 1;
            let generation = talk.poll_generation;
            runtime.talk = Some(talk);
            generation
        };
        install_control_loop(
            self,
            bearer.clone(),
            created.control.clone(),
            show_id.clone(),
            transport,
            welcome,
        );
        self.spawn_guests_poll(bearer, show_id, generation);
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// "Close the room" (D17): end the show (its legs, its recording, the
    /// room), stop the guests poll, take the camera back.
    pub async fn close_room(&self, bearer: Option<String>) -> Result<CloudStatus> {
        let held = {
            let mut runtime = lock(&self.slot);
            match runtime.talk.as_mut() {
                Some(talk) => {
                    talk.phase = CloudRoomPhase::Closing;
                    true
                }
                None => false,
            }
        };
        if !held {
            return Ok(lock(&self.slot).status());
        }
        self.hooks.emit_from(&self.slot);
        let status = self.end_current_show(bearer).await;
        self.forget_talk_show().await;
        status
    }

    /// The talk-show state goes with the show: on Close, on the runner's end
    /// and on the web saying the show is gone. The camera comes back once.
    pub(crate) async fn forget_talk_show(&self) {
        let held = lock(&self.slot).talk.take().is_some();
        if held {
            if let Err(message) = (self.hooks.camera)(CameraHandover::Return).await {
                tracing::warn!("The talk show could not return the camera: {message}");
            }
            self.hooks.emit_from(&self.slot);
        }
    }

    /// A fresh host token for a reconnect or a resume (C-G4, C-G8). The one
    /// answer with a token in it; never logged.
    pub async fn room_token(&self, bearer: Option<String>) -> Result<RoomTokenRefreshAnswer> {
        let Some(bearer) = bearer else {
            bail!("Sign in to Videorc to join the room.");
        };
        let show_id = self.open_room_show_id()?;
        let answer = self
            .web
            .room_token(&bearer, &show_id)
            .await
            .map_err(anyhow::Error::new)?;
        if let Some(talk) = lock(&self.slot).talk.as_mut() {
            talk.host_token = answer.host_token.clone();
            talk.room_url = answer.url.clone();
        }
        Ok(RoomTokenRefreshAnswer {
            host_token: answer.host_token,
            url: answer.url,
            identity: host_identity(&show_id),
            show_id,
        })
    }

    /// "New link" (D5): the old slug dies on its next request.
    pub async fn rotate_invite(&self, bearer: Option<String>) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = self.open_room_show_id()?;
        let invite = self
            .web
            .rotate_invite(&bearer, &show_id)
            .await
            .map_err(anyhow::Error::new)?;
        if let Some(talk) = lock(&self.slot).talk.as_mut() {
            talk.invite = Some(invite);
            // The old link's waiting requests expire with it (the web).
            talk.requests.clear();
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// "Let anyone with the link in backstage" (D4), off by default.
    pub async fn set_door(&self, bearer: Option<String>, open: bool) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = self.open_room_show_id()?;
        let answer = self
            .web
            .patch_room(
                &bearer,
                &show_id,
                &RoomPatch {
                    open_door: Some(open),
                    ..RoomPatch::default()
                },
            )
            .await
            .map_err(anyhow::Error::new)?;
        if let Some(talk) = lock(&self.slot).talk.as_mut() {
            talk.door_open = answer.room.open_door;
            talk.limits = Some(answer.room.limits);
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// The platform names for the consent line (D13), sent when Go Live
    /// knows them; best effort, the room is open either way.
    pub async fn set_room_platforms(&self, bearer: &str, platforms: Vec<String>) {
        let Ok(show_id) = self.open_room_show_id() else {
            return;
        };
        match self
            .web
            .patch_room(
                bearer,
                &show_id,
                &RoomPatch {
                    platforms: Some(platforms.clone()),
                    ..RoomPatch::default()
                },
            )
            .await
        {
            Ok(_) => {
                if let Some(talk) = lock(&self.slot).talk.as_mut() {
                    talk.platforms = platforms;
                }
            }
            Err(error) => {
                tracing::info!("The room's platform names did not reach videorc.com: {error}");
            }
        }
    }

    /// Let in or Decline (D4).
    pub async fn decide_guest(
        &self,
        bearer: Option<String>,
        params: GuestDecideParams,
    ) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = self.open_room_show_id()?;
        self.web
            .decide_request(&bearer, &show_id, &params.request_id, params.decision)
            .await
            .map_err(anyhow::Error::new)?;
        if let Some(talk) = lock(&self.slot).talk.as_mut() {
            talk.requests
                .retain(|request| request.request_id != params.request_id);
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// Mute, Remove, Ban, Rename, the screen share (D14). A ban replaces
    /// the invite; a remove takes the guest off the stage too.
    pub async fn act_on_guest(
        &self,
        bearer: Option<String>,
        params: GuestActParams,
    ) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = self.open_room_show_id()?;
        if params.action == GuestAction::Rename
            && params
                .name
                .as_deref()
                .is_none_or(|name| name.trim().is_empty())
        {
            bail!("A rename needs a name.");
        }
        let answer = self
            .web
            .guest_action(
                &bearer,
                &show_id,
                &params.guest_id,
                &GuestActionBody {
                    action: params.action,
                    name: params.name.clone(),
                },
            )
            .await
            .map_err(anyhow::Error::new)?;
        let stage_changed = {
            let mut runtime = lock(&self.slot);
            let Some(talk) = runtime.talk.as_mut() else {
                bail!("The room is closed.");
            };
            if let Some(invite) = answer.invite {
                talk.invite = Some(invite);
            }
            let mut stage_changed = false;
            match params.action {
                GuestAction::Remove | GuestAction::Ban => {
                    talk.guests
                        .retain(|guest| guest.guest_id != params.guest_id);
                    let before = talk.stage.on_stage.len();
                    talk.stage
                        .on_stage
                        .retain(|identity| identity != &params.guest_id);
                    if talk.stage.spotlight.as_deref() == Some(params.guest_id.as_str()) {
                        talk.stage.spotlight = None;
                    }
                    if talk.stage.screen.as_deref() == Some(params.guest_id.as_str()) {
                        talk.stage.screen = None;
                    }
                    stage_changed = talk.stage.on_stage.len() != before;
                }
                GuestAction::Mute | GuestAction::Unmute => {
                    if let Some(guest) = talk
                        .guests
                        .iter_mut()
                        .find(|guest| guest.guest_id == params.guest_id)
                    {
                        guest.muted = params.action == GuestAction::Mute;
                    }
                }
                GuestAction::Rename => {
                    if let (Some(guest), Some(name)) = (
                        talk.guests
                            .iter_mut()
                            .find(|guest| guest.guest_id == params.guest_id),
                        params.name.as_ref(),
                    ) {
                        guest.name = name.trim().to_string();
                    }
                }
                GuestAction::AllowScreenShare | GuestAction::DisallowScreenShare => {
                    if let Some(guest) = talk
                        .guests
                        .iter_mut()
                        .find(|guest| guest.guest_id == params.guest_id)
                    {
                        guest.screen_share_allowed = params.action == GuestAction::AllowScreenShare;
                    }
                }
            }
            stage_changed
        };
        if stage_changed {
            // The runner must stop composing a removed guest at once.
            let stage = lock(&self.slot)
                .talk
                .as_ref()
                .map(|talk| talk.stage.clone())
                .unwrap_or_default();
            match self.send_stage(&stage).await {
                Ok(()) => {
                    if let Some(talk) = lock(&self.slot).talk.as_mut() {
                        talk.stage_sent = true;
                    }
                }
                Err(problem) => {
                    tracing::warn!("The stage after a remove did not reach the runner: {problem}");
                }
            }
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// `cloud.stage.set`: the whole stage in one frame; the runner diffs.
    pub async fn set_stage(&self, stage: CloudStage) -> Result<CloudStatus> {
        stage.validate()?;
        self.open_room_show_id()?;
        self.send_stage(&stage).await.map_err(|problem| {
            anyhow::anyhow!("Videorc Cloud did not take the stage: {problem}")
        })?;
        if let Some(talk) = lock(&self.slot).talk.as_mut() {
            talk.stage = stage;
            talk.stage_sent = true;
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    async fn send_stage(&self, stage: &CloudStage) -> std::result::Result<(), String> {
        let tx = self.control_tx()?;
        let id = new_intent_id();
        send_intent(&tx, stage.frame(&id), id, ACK_TIMEOUT)
            .await
            .map(|_| ())
    }

    /// Record in a talk show (D10): the cloud recording.
    pub async fn recording_start(&self) -> Result<CloudStatus> {
        self.simple_intent(
            "recording.start",
            "Videorc Cloud did not start the recording",
        )
        .await
    }

    pub async fn recording_stop(&self) -> Result<CloudStatus> {
        self.simple_intent("recording.stop", "Videorc Cloud did not stop the recording")
            .await
    }

    /// `return.set`: the Program monitor's feed on or off.
    pub async fn set_return(&self, enabled: bool) -> Result<CloudStatus> {
        self.open_room_show_id()?;
        let tx = self.control_tx().map_err(anyhow::Error::msg)?;
        let id = new_intent_id();
        let frame = json!({ "t": "intent", "id": id, "kind": "return.set", "enabled": enabled });
        send_intent(&tx, frame, id, ACK_TIMEOUT)
            .await
            .map_err(|problem| {
                anyhow::anyhow!("Videorc Cloud did not set the return: {problem}")
            })?;
        Ok(lock(&self.slot).status())
    }

    /// Go Live in a talk show (C-G6): the prepared destinations go to the
    /// runner over the socket this desktop already holds; no local leg.
    pub async fn talk_go_live(
        &self,
        bearer: Option<String>,
        destinations: Vec<HandoverDestination>,
        platforms: Vec<String>,
    ) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = self.open_room_show_id()?;
        if destinations.is_empty() {
            bail!("Videorc Cloud needs at least one destination to hand over.");
        }
        let tx = self.control_tx().map_err(anyhow::Error::msg)?;
        {
            let mut runtime = lock(&self.slot);
            if let Some(show) = runtime
                .show
                .as_mut()
                .filter(|show| show.record.id == show_id)
            {
                show.destinations = destinations.clone();
            }
        }
        let id = new_intent_id();
        // A Go Live hand-over replaces the runner's legs (plan 222 review
        // M3): the list is every platform the host chose for this show.
        let frame = crate::cloud_show::destinations_set_frame(&id, &destinations, true);
        send_intent(&tx, frame, id, ACK_TIMEOUT)
            .await
            .map_err(|problem| {
                anyhow::anyhow!("Videorc Cloud did not take the destinations: {problem}")
            })?;
        {
            let mut runtime = lock(&self.slot);
            if let Some(show) = runtime
                .show
                .as_mut()
                .filter(|show| show.record.id == show_id)
            {
                show.handed_over = true;
            }
            if let Some(talk) = runtime.talk.as_mut() {
                talk.live = true;
                talk.live_since = Some(crate::cloud_show::now_rfc3339());
                talk.message = None;
            }
        }
        self.hooks.emit_from(&self.slot);
        self.set_room_platforms(&bearer, platforms).await;
        Ok(lock(&self.slot).status())
    }

    /// End livestream in a talk show (D17, the wire notes on `legs.end`):
    /// every platform leg ends cleanly, the room, the people, the stage and a
    /// running cloud recording stay, and the runner's next state lists no
    /// legs. A later Go Live hands fresh destinations over. A refusal or a
    /// silent runner is reported with its reason; nothing else changes.
    pub async fn legs_end(&self) -> Result<CloudStatus> {
        self.open_room_show_id()?;
        let tx = self.control_tx().map_err(anyhow::Error::msg)?;
        let id = new_intent_id();
        let frame = json!({ "t": "intent", "id": id, "kind": "legs.end" });
        match send_intent(&tx, frame, id, ACK_TIMEOUT).await {
            Ok(_) => {
                let mut runtime = lock(&self.slot);
                if let Some(show) = runtime.show.as_mut() {
                    show.destinations.clear();
                    show.handed_over = false;
                }
                if let Some(talk) = runtime.talk.as_mut() {
                    talk.live = false;
                    talk.live_since = None;
                    talk.message = None;
                }
            }
            Err(problem) => {
                let message = legs_end_failure(&problem);
                if let Some(talk) = lock(&self.slot).talk.as_mut() {
                    talk.message = Some(message.clone());
                }
                self.hooks.emit_from(&self.slot);
                bail!("{message}");
            }
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// `overlay.set` (D9): a PNG into a slot, per orientation, with a TTL.
    pub async fn set_overlay(
        &self,
        slot: CloudOverlaySlot,
        orientation: CloudOverlayOrientation,
        png_base64: &str,
        rect: CloudOverlayRect,
        ttl_seconds: Option<u64>,
    ) -> std::result::Result<(), String> {
        if !rect.is_valid() {
            return Err("the overlay rect is not inside the canvas".to_string());
        }
        let tx = self.control_tx()?;
        let id = new_intent_id();
        let mut frame = json!({
            "t": "intent",
            "id": id,
            "kind": "overlay.set",
            "slot": slot.as_str(),
            "orientation": orientation.as_str(),
            "pngBase64": png_base64,
            "rect": { "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h },
        });
        if let Some(ttl) = ttl_seconds {
            frame["ttlSeconds"] = json!(ttl);
        }
        send_intent(&tx, frame, id, ACK_TIMEOUT).await.map(|_| ())
    }

    pub async fn clear_overlay(
        &self,
        slot: CloudOverlaySlot,
        orientation: CloudOverlayOrientation,
    ) -> std::result::Result<(), String> {
        let tx = self.control_tx()?;
        let id = new_intent_id();
        let frame = json!({
            "t": "intent",
            "id": id,
            "kind": "overlay.clear",
            "slot": slot.as_str(),
            "orientation": orientation.as_str(),
        });
        send_intent(&tx, frame, id, ACK_TIMEOUT).await.map(|_| ())
    }

    /// The renderer's own room connection, for the status (and the watchdog).
    pub fn report_client(&self, params: RoomClientReportParams) -> CloudStatus {
        {
            let mut runtime = lock(&self.slot);
            if let Some(talk) = runtime.talk.as_mut() {
                talk.client = params.state;
                talk.message = params.detail.filter(|detail| !detail.trim().is_empty());
            }
        }
        self.hooks.emit_from(&self.slot);
        lock(&self.slot).status()
    }

    /// Resume after a relaunch (C-G8): the web still lists the talk show, the
    /// launch check held it (`hold_current_show`), and the host clicks
    /// Resume. The room's settings and invite come from `GET …/room`; the
    /// renderer joins with a fresh token through `cloud.room.token.refresh`;
    /// no `destinations.set` goes out (plan 184 C5b). The runner's
    /// `stageSet: false` after a crash is answered by `resend_stage`.
    pub async fn resume_room(&self, bearer: Option<String>) -> Result<CloudStatus> {
        let bearer = bearer_or_bail(bearer)?;
        let show_id = {
            let runtime = lock(&self.slot);
            let Some(show) = runtime.show.as_ref() else {
                bail!("There's no Videorc Cloud show to resume.");
            };
            if show.record.kind != "talk" {
                bail!("The show on Videorc Cloud is not a talk show.");
            }
            if runtime.talk.is_some() {
                return Ok(runtime.status());
            }
            show.record.id.clone()
        };
        if let Err(message) = (self.hooks.camera)(CameraHandover::Lend).await {
            return Err(RoomOpenRefusal::CameraBusy(message).into());
        }
        let settings = match self.web.get_room(&bearer, &show_id).await {
            Ok(settings) => settings,
            Err(error) => {
                let _ = (self.hooks.camera)(CameraHandover::Return).await;
                return Err(anyhow::Error::new(error));
            }
        };
        let token = match self.web.room_token(&bearer, &show_id).await {
            Ok(token) => token,
            Err(error) => {
                let _ = (self.hooks.camera)(CameraHandover::Return).await;
                return Err(anyhow::Error::new(error));
            }
        };
        let generation = {
            let mut runtime = lock(&self.slot);
            let mut talk = TalkShowState::new(
                ShowRoomAnswer {
                    url: token.url,
                    host_token: token.host_token,
                    name: show_id.clone(),
                },
                settings.room,
                settings.invite,
                &show_id,
            );
            // The runner keeps the legs it holds (C5b): the show is on air
            // while it lists them; its clock is the only one left.
            talk.live = runtime
                .runner
                .as_ref()
                .is_some_and(|runner| !runner.legs.is_empty());
            talk.poll_generation = runtime.generation + 1;
            let generation = talk.poll_generation;
            runtime.talk = Some(talk);
            // The stage the program has (H2): the host and whoever the
            // runner still flags on stage, never the host alone over guests.
            runtime.talk_layout_from_runner();
            runtime.failed = None;
            if let Some(show) = runtime.show.as_mut() {
                show.resuming = false;
            }
            generation
        };
        self.spawn_guests_poll(bearer, show_id, generation);
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    async fn simple_intent(&self, kind: &str, failure: &str) -> Result<CloudStatus> {
        self.open_room_show_id()?;
        let tx = self.control_tx().map_err(anyhow::Error::msg)?;
        let id = new_intent_id();
        let frame = json!({ "t": "intent", "id": id, "kind": kind });
        send_intent(&tx, frame, id, ACK_TIMEOUT)
            .await
            .map_err(|problem| anyhow::anyhow!("{failure}: {problem}"))?;
        Ok(lock(&self.slot).status())
    }

    fn control_tx(
        &self,
    ) -> std::result::Result<
        tokio::sync::mpsc::UnboundedSender<crate::cloud_show::ControlRequest>,
        String,
    > {
        lock(&self.slot)
            .control_tx
            .clone()
            .ok_or_else(|| "Videorc Cloud is not connected right now".to_string())
    }

    fn open_room_show_id(&self) -> Result<String> {
        let runtime = lock(&self.slot);
        if !runtime.talk_show_open() {
            bail!("The room is closed.");
        }
        runtime
            .show
            .as_ref()
            .map(|show| show.record.id.clone())
            .ok_or_else(|| anyhow::anyhow!("The room is closed."))
    }

    /// The guests long-poll (W-G2's `GET …/guests?since=`): requests, guests
    /// and the hidden count, while the room is this generation's.
    fn spawn_guests_poll(&self, bearer: String, show_id: String, generation: u64) {
        let context = self.clone();
        tokio::spawn(async move {
            let mut since: Option<String> = None;
            loop {
                let current = {
                    let runtime = lock(&context.slot);
                    runtime
                        .talk
                        .as_ref()
                        .is_some_and(|talk| talk.poll_generation == generation)
                };
                if !current {
                    return;
                }
                match context
                    .web
                    .list_guests(&bearer, &show_id, since.as_deref())
                    .await
                {
                    Ok(answer) => {
                        since = (!answer.cursor.is_empty()).then(|| answer.cursor.clone());
                        let new_requests = {
                            let mut runtime = lock(&context.slot);
                            let Some(talk) = runtime
                                .talk
                                .as_mut()
                                .filter(|talk| talk.poll_generation == generation)
                            else {
                                return;
                            };
                            let new_requests: Vec<CloudRoomRequest> = answer
                                .requests
                                .iter()
                                .filter(|request| {
                                    talk.seen_requests.insert(request.request_id.clone())
                                })
                                .cloned()
                                .collect();
                            talk.requests = answer.requests;
                            talk.guests = answer.guests;
                            talk.declined_count = answer.declined_count;
                            talk.poll_cursor = since.clone();
                            new_requests
                        };
                        for request in new_requests {
                            (context.hooks.request)(request);
                        }
                        context.hooks.emit_from(&context.slot);
                        tokio::time::sleep(GUESTS_POLL_REST).await;
                    }
                    Err(error) => {
                        match error {
                            // The show is over on the web: the control loop
                            // or Close the room settles the rest.
                            CloudApiError::Unauthorized => {
                                tracing::info!("The guests poll stopped: signed out.");
                                return;
                            }
                            other => {
                                tracing::debug!("The guests poll failed: {other}");
                            }
                        }
                        tokio::time::sleep(GUESTS_POLL_BACKOFF).await;
                    }
                }
            }
        });
    }
}

fn bearer_or_bail(bearer: Option<String>) -> Result<String> {
    bearer.ok_or_else(|| anyhow::anyhow!("Sign in to Videorc to use the room."))
}

/// A talk show's end on the web, as a Go Live fallback reason sees it: the
/// two reasons plan 224 adds to the closed list.
pub fn talk_show_create_refusal(error: &CloudApiError) -> Option<&'static str> {
    match error {
        CloudApiError::GuestHoursUsedUp { .. } => Some("cloud-guest-hours-used-up"),
        CloudApiError::RoomsUnavailable => Some("cloud-rooms-unavailable"),
        _ => None,
    }
}
