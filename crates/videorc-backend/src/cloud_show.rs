//! Videorc Cloud (plan 184, Phase 1): a solo show that lives on our servers.
//!
//! The Studio composes as today; only the output changes. In cloud mode the
//! session's platform legs are swapped for one RTMPS feed per orientation to
//! the show's runner (the C3 seam in `recording.rs`), and the real
//! destinations are handed to the runner over the control socket. The runner
//! holds the platforms, so a dead computer shows viewers the hold image
//! instead of a dropped broadcast.
//!
//! Rules that shape this module:
//! - Keys never reach the renderer, a log or a settings file (D15). The only
//!   frame that carries them is `destinations.set`, built here and sent on the
//!   socket; `Debug` on every secret-bearing type redacts.
//! - Direct legs reopen only after the web confirms the show is gone (C2). A
//!   desktop that merely lost its own socket must never push the keys the
//!   runner still pushes: two pushes to one key make the platform drop both.
//! - Every YouTube API call stays on this computer (D13): the desktop still
//!   prepares broadcasts and moves them to `complete`; the runner only pushes
//!   video into YouTube's ingest.
//! - Resume never redoes platform setup (C5b). The Resume notice starts a
//!   session bound to the show through `cloud.show.resume`: the feeds come
//!   from the show's ingest, no `destinations.set` is sent, and the runner
//!   keeps the legs it holds, the live YouTube broadcast and its key among
//!   them. Only Go Live hands destinations over.
//! - Go Live never grows a switch (D11): the setting lives on the Livestream
//!   page, on by default when entitled, and a Go Live that cannot use the
//!   cloud streams directly and says why once (`fallback`).
//!
//! The wire shape is plan 184's "Wire shape (Phase 1)". The RPC surface
//! follows `remote_control.rs`: `cloud.status` (every role; remote roles get
//! nothing else), `cloud.settings.set`, `cloud.allowance.refresh`,
//! `cloud.show.resume` and `cloud.show.end` (renderer and admin), and the
//! `cloud.state` event, a whole `CloudStatus` on every change.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::protocol::{AiCapabilitiesCloud, EntitlementPlan};
use crate::streaming::{
    StreamOutputOrientation, StreamPlatform, StreamTargetRuntime, StreamTargetState,
};

pub const CLOUD_SETTINGS_KEY: &str = "cloud.settings";
pub const CLOUD_STATE_EVENT: &str = "cloud.state";
/// The label of the swapped target and of the physical cloud leg (C3).
pub const CLOUD_TARGET_LABEL: &str = "Videorc Cloud";
/// D12: a hold lasts 30 minutes by default; the Livestream page offers four.
pub const DEFAULT_HOLD_MAX_SECONDS: u32 = 1800;
pub const HOLD_MAX_CHOICES: [u32; 4] = [300, 900, 1800, 3600];
/// D18: a show starts only with at least 5 minutes of the month left.
pub const MIN_SECONDS_LEFT_TO_START: u64 = 300;
/// The desktop pings every 5 s; three missed pings mark it gone (wire shape).
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// A runner the create just spawned opens its socket only after its engine
/// starts, and the node agent waits up to 15 s for it behind the hello, so
/// the first `welcome` can take that long (the runner's wire notes).
const WELCOME_TIMEOUT: Duration = Duration::from_secs(20);
const ACK_TIMEOUT: Duration = Duration::from_secs(5);
const END_ACK_TIMEOUT: Duration = Duration::from_secs(3);
/// Reconnect backoff after the socket drops: the runner keeps the show, so
/// patience costs nothing; the cap keeps a flapping network from hammering.
const RECONNECT_BACKOFF_SECONDS: [u64; 5] = [1, 2, 4, 8, 15];
/// The hold image sent to the runner, PNG, at most this many bytes.
const HOLD_IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const CLOSE_CODE_BAD_TOKEN: u16 = 4401;
/// What a waiting intent hears when the socket drops under it.
const SOCKET_DROPPED: &str = "the control socket dropped";
const CLOSE_CODE_NO_SUCH_SHOW: u16 = 4404;

// --- Settings (C6's model; the UI is a later pass) -------------------------

fn default_hold_max_seconds() -> u32 {
    DEFAULT_HOLD_MAX_SECONDS
}

/// The Livestream page's "Videorc Cloud" section, persisted in the backend
/// settings table. Carries no key material by construction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    /// The switch. `None` is the default: on when entitled (D11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default = "default_hold_max_seconds")]
    pub hold_max_seconds: u32,
    /// The takeover screen shown while the feed is gone (D12). `None`: the
    /// runner draws its default card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_image_screen_id: Option<String>,
}

impl Default for CloudSettings {
    fn default() -> Self {
        Self {
            enabled: None,
            hold_max_seconds: DEFAULT_HOLD_MAX_SECONDS,
            hold_image_screen_id: None,
        }
    }
}

impl CloudSettings {
    /// A stored value outside the offered choices (an old build, a hand edit)
    /// reads as the default rather than as a surprise hold length.
    pub fn normalized(mut self) -> Self {
        if !HOLD_MAX_CHOICES.contains(&self.hold_max_seconds) {
            self.hold_max_seconds = DEFAULT_HOLD_MAX_SECONDS;
        }
        self
    }

    /// The switch as the user left it; the default is on.
    pub fn switch_on(&self) -> bool {
        self.enabled.unwrap_or(true)
    }

    pub fn apply(&mut self, patch: &CloudSettingsPatch) -> Result<()> {
        if let Some(hold) = patch.hold_max_seconds
            && !HOLD_MAX_CHOICES.contains(&hold)
        {
            bail!(
                "The hold limit must be one of {} seconds.",
                HOLD_MAX_CHOICES
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        if let Some(enabled) = patch.enabled {
            self.enabled = Some(enabled);
        }
        if let Some(hold) = patch.hold_max_seconds {
            self.hold_max_seconds = hold;
        }
        if let Some(screen) = &patch.hold_image_screen_id {
            self.hold_image_screen_id = screen
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
        Ok(())
    }
}

/// `cloud.settings.set` params. `holdImageScreenId: null` clears the image.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_max_seconds: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub hold_image_screen_id: Option<Option<String>>,
}

fn deserialize_double_option<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// The settings as the renderer reads them: the switch resolved, the choices
/// beside the value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettingsView {
    pub enabled: bool,
    pub hold_max_seconds: u32,
    pub hold_max_choices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_image_screen_id: Option<String>,
}

// --- Entitlement (plan 185: the `cloud` block beside the plan) -------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudEntitlement {
    pub plan: Option<EntitlementPlan>,
    pub cloud: Option<AiCapabilitiesCloud>,
}

impl CloudEntitlement {
    pub fn entitled(&self) -> bool {
        self.cloud.as_ref().is_some_and(|cloud| cloud.enabled)
    }

    fn seconds_remaining(&self) -> u64 {
        self.cloud
            .as_ref()
            .map(AiCapabilitiesCloud::seconds_remaining)
            .unwrap_or(0)
    }
}

// --- Status (the `cloud.state` event and `cloud.status`) -------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudPhase {
    Off,
    Connecting,
    Live,
    Hold,
    Resuming,
    Ending,
    Failed,
}

/// Why a Go Live streamed directly (D11): the ONE reason the renderer toasts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudFallbackReason {
    CloudDisabled,
    CloudFull,
    CloudHoursUsedUp,
    CloudNodeUnreachable,
    NotEntitled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudFallback {
    pub reason: CloudFallbackReason,
    pub at: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudShowSummary {
    pub id: String,
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Live on the runner with no local feed: Resume or End (C5).
    pub resumable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudHoldStatus {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudFeedStatus {
    pub orientation: String,
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kbps: Option<u64>,
}

/// The runner restarted mid-show and lost its destinations (plan 184 "When
/// things break": "Videorc Cloud restarted your show"). The restarted runner
/// resumes the show in hold and waits for `destinations.set` again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRestart {
    pub at: String,
    /// This computer sent the destinations again. False when it holds no
    /// keys to send (the show was resumed after a relaunch) or the runner
    /// refused them: the platforms stay dark until a new Go Live.
    pub destinations_resent: bool,
}

/// The whole cloud state, sent on every change as `cloud.state` and answered
/// by `cloud.status`. Secret-free by construction: no url, token or key type
/// is reachable from it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub phase: CloudPhase,
    /// The account's `cloud` block says on.
    pub entitled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<EntitlementPlan>,
    pub settings: CloudSettingsView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowance: Option<AiCapabilitiesCloud>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<CloudShowSummary>,
    /// The local session feeding the show, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The control socket is up.
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<CloudHoldStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<CloudFeedStatus>,
    /// The runner's platform legs in the desktop's own leg model (C2): one
    /// per handed-over destination, keyed by the desktop's target id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legs: Vec<StreamTargetRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_seconds: Option<u64>,
    /// The last Go Live that streamed directly, and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<CloudFallback>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The web confirmed the show is gone while this computer was feeding it
    /// (C2): direct legs may reopen. Until then they never may.
    pub direct_fallback_available: bool,
    /// C6b: the Test cloud that runs, or the last one that ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<CloudTestStatus>,
    /// The runner restarted during this show (the last time it did).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<CloudRestart>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudTestPhase {
    Creating,
    Connecting,
    Pushing,
    Ending,
    Done,
}

/// Why a test failed, in the renderer's vocabulary (`cloud-view.ts` words
/// each one). The web's and the runner's strings never reach the renderer
/// unmapped; `message` carries the detail for the console.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloudTestReason {
    /// The web or the node could not be reached, or the node refused the hello.
    CantReach,
    /// The rollout switch is off.
    Off,
    Full,
    NotEntitled,
    NoHours,
    /// The hour's tests are used up; `reset_at` says when one frees.
    Limit,
    /// A show is already live through the cloud.
    ShowLive,
    /// FFmpeg refused the node's certificate (C1c).
    Certificate,
    /// The push ran but the runner never saw the feed.
    NoFeed,
    /// The feed arrived below its target bitrate.
    TooSlow,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestUpload {
    pub orientation: String,
    /// The stream quality's video bitrate, the number the streamer chose.
    pub target_kbps: u32,
    /// What the node received, video and audio together: the median of the
    /// runner's feed readings during the push. Absent when nothing arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured_kbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<CloudTestReason>,
    /// The detail for the console and the support bundle, never copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// From the Test click to the runner reporting live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_to_live_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uploads: Vec<CloudTestUpload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
}

/// `CloudStatus.test`: the test that runs or the last one that ran.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestStatus {
    pub phase: CloudTestPhase,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<CloudTestResult>,
}

// --- Wire: desktop -> web ------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowOutputSpec {
    pub orientation: StreamOutputOrientation,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateShowRequest {
    pub kind: String,
    pub outputs: Vec<ShowOutputSpec>,
    pub hold_max_seconds: u32,
    pub client: ClientInfo,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub app: String,
    pub version: String,
}

/// `client` in `POST /api/cloud/shows` and in `hello`. The version is the
/// app's release (Electron's `VIDEORC_APP_VERSION`), never the backend crate's
/// 0.9.0: the web and the node read it.
pub fn client_info() -> ClientInfo {
    client_info_with_version(crate::performance_check::desktop_app_version())
}

fn client_info_with_version(version: String) -> ClientInfo {
    ClientInfo {
        app: "desktop".to_string(),
        version,
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowRecord {
    pub id: String,
    #[serde(default)]
    pub status: String,
    /// `solo`, `talk` or `test` (C6b).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

impl ShowRecord {
    /// A Test cloud's show (C6b): never resumable, and never worth keeping
    /// open for a show or another test.
    pub fn is_test(&self) -> bool {
        self.kind == "test"
    }
}

/// One ingest pair: `{serverUrl}/{streamKey}` is the desktop's cloud target
/// (C3). The key is our node's, scoped to one show, and still a secret.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowIngest {
    pub orientation: StreamOutputOrientation,
    pub server_url: String,
    pub stream_key: String,
}

impl std::fmt::Debug for ShowIngest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShowIngest")
            .field("orientation", &self.orientation)
            .field("server_url", &self.server_url)
            .field("stream_key", &"••••")
            .finish()
    }
}

/// The control socket address and the show token (`vcs1.…`).
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowControl {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for ShowControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShowControl")
            .field("url", &self.url)
            .field("token", &"••••")
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShowResponse {
    pub show: ShowRecord,
    pub ingest: Vec<ShowIngest>,
    pub control: ShowControl,
    #[serde(default)]
    pub allowance: Option<AiCapabilitiesCloud>,
}

/// `GET /api/cloud/shows/current`. The web never stores ingest keys, so
/// `ingest` is normally absent and resume asks the node instead
/// (`ingest.get`, Wire shape); it is still read when present.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentShowResponse {
    #[serde(default)]
    pub show: Option<ShowRecord>,
    #[serde(default)]
    pub control: Option<ShowControl>,
    #[serde(default)]
    pub ingest: Option<Vec<ShowIngest>>,
}

/// The web's `{ error: { code, message } }` envelope, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudApiError {
    Unauthorized,
    NotEntitled,
    /// 409: a show is already live; the body carries it. Boxed, so every
    /// `Result` that carries this error stays small.
    ShowLive(Option<Box<ShowRecord>>),
    HoursUsedUp {
        reset_at: Option<String>,
    },
    /// 429 on a test show (C6b): the hour's tests are used up.
    TestLimit {
        reset_at: Option<String>,
    },
    Disabled,
    Full,
    NodeUnreachable,
    Transport(String),
    Other {
        status: u16,
        code: String,
        message: String,
    },
}

impl std::fmt::Display for CloudApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "Sign in to use Videorc Cloud."),
            Self::NotEntitled => write!(f, "Videorc Cloud comes with Videorc Premium."),
            Self::ShowLive(_) => write!(f, "A show is already live through Videorc Cloud."),
            Self::HoursUsedUp { .. } => write!(f, "This month's cloud hours are used up."),
            Self::TestLimit { .. } => write!(f, "This hour's Videorc Cloud tests are used up."),
            Self::Disabled => write!(f, "Videorc Cloud is switched off right now."),
            Self::Full => write!(f, "Videorc Cloud is full right now."),
            Self::NodeUnreachable => write!(f, "Videorc Cloud could not be reached."),
            Self::Transport(message) => write!(f, "Videorc Cloud could not be reached: {message}"),
            Self::Other {
                status,
                code,
                message,
            } => write!(
                f,
                "Videorc Cloud request failed ({status} {code}): {message}"
            ),
        }
    }
}

impl std::error::Error for CloudApiError {}

impl CloudApiError {
    /// D11: the reasons a Go Live streams directly instead. Anything else is
    /// an error the user must see as such (sign in; a show already live).
    pub fn fallback_reason(&self) -> Option<CloudFallbackReason> {
        match self {
            Self::NotEntitled => Some(CloudFallbackReason::NotEntitled),
            Self::HoursUsedUp { .. } => Some(CloudFallbackReason::CloudHoursUsedUp),
            Self::Disabled => Some(CloudFallbackReason::CloudDisabled),
            Self::Full => Some(CloudFallbackReason::CloudFull),
            Self::NodeUnreachable | Self::Transport(_) => {
                Some(CloudFallbackReason::CloudNodeUnreachable)
            }
            Self::Other { status, .. } if *status >= 500 => {
                Some(CloudFallbackReason::CloudNodeUnreachable)
            }
            Self::Unauthorized
            | Self::ShowLive(_)
            | Self::TestLimit { .. }
            | Self::Other { .. } => None,
        }
    }
}

/// Status plus `error.code` into one error (the wire shape's error list).
pub fn classify_cloud_failure(
    status: u16,
    code: &str,
    message: String,
    live_show: Option<ShowRecord>,
    reset_at: Option<String>,
) -> CloudApiError {
    match (status, code) {
        (401, _) => CloudApiError::Unauthorized,
        (403, "cloud-not-entitled") => CloudApiError::NotEntitled,
        (409, "cloud-show-live") => CloudApiError::ShowLive(live_show.map(Box::new)),
        (429, "cloud-hours-used-up") => CloudApiError::HoursUsedUp { reset_at },
        (429, "cloud-test-limit") => CloudApiError::TestLimit { reset_at },
        (503, "cloud-disabled") => CloudApiError::Disabled,
        (503, "cloud-full") => CloudApiError::Full,
        (503, "cloud-node-unreachable") => CloudApiError::NodeUnreachable,
        _ => CloudApiError::Other {
            status,
            code: code.to_string(),
            message,
        },
    }
}

/// The web API as the show needs it. Implemented by `VideorcApiClient` and by
/// the tests' fake. Static dispatch keeps the futures `Send` without a trait
/// object.
pub trait CloudWebApi: Send + Sync + 'static {
    fn create_show(
        &self,
        bearer: &str,
        request: &CreateShowRequest,
    ) -> impl Future<Output = std::result::Result<CreateShowResponse, CloudApiError>> + Send;
    fn current_show(
        &self,
        bearer: &str,
    ) -> impl Future<Output = std::result::Result<CurrentShowResponse, CloudApiError>> + Send;
    fn end_show(
        &self,
        bearer: &str,
        show_id: &str,
    ) -> impl Future<Output = std::result::Result<(), CloudApiError>> + Send;
    fn allowance(
        &self,
        bearer: &str,
    ) -> impl Future<Output = std::result::Result<AiCapabilitiesCloud, CloudApiError>> + Send;
}

// --- Wire: the control socket -------------------------------------------------

/// A frame from the runner, or the socket's end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlFrameIn {
    Text(String),
    Closed { code: Option<u16> },
}

pub trait ControlTransport: Send + 'static {
    fn send(&mut self, frame: Value) -> impl Future<Output = Result<()>> + Send;
    /// `None` when the socket is gone without a close frame.
    fn recv(&mut self) -> impl Future<Output = Option<ControlFrameIn>> + Send;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

pub trait ControlConnector: Send + Sync + 'static {
    type Transport: ControlTransport;
    fn connect(&self, url: &str) -> impl Future<Output = Result<Self::Transport>> + Send;
}

/// The control socket carries the show token and every platform key in
/// `destinations.set`, so a release build speaks to a node over TLS only
/// (`wss://`). A dev build also takes `ws://`, for the local agent the smokes
/// run. `None` when the url may be used.
pub fn control_url_problem(url: &str, dev_build: bool) -> Option<String> {
    let scheme = reqwest::Url::parse(url)
        .map(|parsed| parsed.scheme().to_string())
        .unwrap_or_default();
    match scheme.as_str() {
        "wss" => None,
        "ws" if dev_build => {
            tracing::warn!("The Videorc Cloud control socket is not encrypted (dev build).");
            None
        }
        _ => Some(
            "Videorc Cloud gave a control address without TLS, so this computer won't send it your stream keys."
                .to_string(),
        ),
    }
}

/// The feed, before any key is handed over: a release build sends video
/// only over RTMPS to a node it can check by name (C1c). FFmpeg's OpenSSL
/// backend binds the name only for a DNS host, so an IP literal is refused
/// too. A dev build allows both for a local MediaMTX, and says so.
pub fn ingest_url_problem(server_url: &str, dev_build: bool) -> Option<String> {
    let Ok(parsed) = reqwest::Url::parse(server_url) else {
        return Some("Videorc Cloud gave an ingest address this computer can't read.".to_string());
    };
    let by_ip = parsed.host_str().is_some_and(|host| {
        host.trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok()
    });
    if parsed.scheme() != "rtmps" {
        if !dev_build {
            return Some(
                "Videorc Cloud gave an ingest address without TLS, so this computer won't send video to it."
                    .to_string(),
            );
        }
        tracing::warn!("The cloud feed is not encrypted (dev build).");
    }
    if by_ip {
        if !dev_build {
            return Some(
                "Videorc Cloud gave an ingest address by IP, whose certificate this computer can't check by name."
                    .to_string(),
            );
        }
        tracing::warn!(
            "The cloud feed's host is an IP address: FFmpeg checks its certificate chain but not its name (dev build)."
        );
    }
    None
}

/// `tokio-tungstenite` over TLS, the production transport.
pub struct WsConnector;

pub struct WsTransport {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl ControlConnector for WsConnector {
    type Transport = WsTransport;

    async fn connect(&self, url: &str) -> Result<WsTransport> {
        if let Some(problem) = control_url_problem(url, cfg!(debug_assertions)) {
            bail!(problem);
        }
        let (ws, _) = tokio::time::timeout(
            CONTROL_CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(url),
        )
        .await
        .context("Videorc Cloud control socket connect timed out.")?
        .context("Videorc Cloud control socket connect failed.")?;
        Ok(WsTransport { ws })
    }
}

impl ControlTransport for WsTransport {
    async fn send(&mut self, frame: Value) -> Result<()> {
        use tokio_tungstenite::tungstenite::Message;
        self.ws
            .send(Message::Text(frame.to_string().into()))
            .await
            .context("Videorc Cloud control socket send failed.")
    }

    async fn recv(&mut self) -> Option<ControlFrameIn> {
        use tokio_tungstenite::tungstenite::Message;
        loop {
            match self.ws.next().await {
                None | Some(Err(_)) => return None,
                Some(Ok(Message::Text(text))) => {
                    return Some(ControlFrameIn::Text(text.to_string()));
                }
                Some(Ok(Message::Close(frame))) => {
                    return Some(ControlFrameIn::Closed {
                        code: frame.map(|frame| u16::from(frame.code)),
                    });
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = self.ws.send(Message::Pong(payload)).await;
                }
                Some(Ok(_)) => continue,
            }
        }
    }

    async fn close(&mut self) {
        use tokio_tungstenite::tungstenite::Message;
        let _ = self.ws.send(Message::Close(None)).await;
    }
}

/// `state` from the runner (wire shape, Runner -> client). Open strings for
/// the phases and states: a runner one release ahead must never break the
/// desktop's parse.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerState {
    #[serde(default)]
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<CloudHoldStatus>,
    #[serde(default)]
    pub live_seconds: u64,
    #[serde(default)]
    pub feeds: Vec<CloudFeedStatus>,
    #[serde(default)]
    pub legs: Vec<RunnerLeg>,
    /// This runner process holds a destination list (from a client or from
    /// the agent). `None` from a runner older than the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destinations_set: Option<bool>,
    /// How many times the agent restarted this show's runner after a crash;
    /// it only grows. `None` from a runner older than the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restarts: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerLeg {
    pub id: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub orientation: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum RunnerFrame {
    Welcome {
        #[serde(default)]
        state: RunnerState,
    },
    State {
        #[serde(default)]
        state: RunnerState,
    },
    Ack {
        id: String,
        #[serde(default)]
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        /// Wire shape: only `ingest.get` acks carry a result.
        #[serde(default)]
        result: Option<Value>,
    },
    Pong,
    #[serde(other)]
    Unknown,
}

/// A runner leg in the desktop's leg model (C2). The runner's `id` is the
/// desktop's target id, so the row maps straight back onto the destination.
pub fn runner_leg_to_runtime(leg: &RunnerLeg) -> StreamTargetRuntime {
    StreamTargetRuntime {
        target_id: leg.id.clone(),
        platform: parse_platform(&leg.platform),
        label: leg.label.clone(),
        state: match leg.state.as_str() {
            "connecting" => StreamTargetState::Connecting,
            "live" => StreamTargetState::Live,
            "reconnecting" => StreamTargetState::Reconnecting,
            "failed" => StreamTargetState::Failed,
            "ended" => StreamTargetState::Stopped,
            _ => StreamTargetState::Warning,
        },
        message: leg.error.clone(),
        redacted_url: None,
    }
}

fn parse_platform(id: &str) -> StreamPlatform {
    serde_json::from_value::<StreamPlatform>(Value::String(id.to_string()))
        .unwrap_or(StreamPlatform::Custom)
}

/// One destination for `destinations.set`: `url` carries the key, so this
/// value lives in memory only and `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct HandoverDestination {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub orientation: String,
    pub url: String,
}

impl std::fmt::Debug for HandoverDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HandoverDestination")
            .field("id", &self.id)
            .field("platform", &self.platform)
            .field("label", &self.label)
            .field("orientation", &self.orientation)
            .field("url", &"••••")
            .finish()
    }
}

fn destinations_set_frame(id: &str, destinations: &[HandoverDestination]) -> Value {
    json!({
        "t": "intent",
        "id": id,
        "kind": "destinations.set",
        "destinations": destinations
            .iter()
            .map(|destination| json!({
                "id": destination.id,
                "platform": destination.platform,
                "label": destination.label,
                "orientation": destination.orientation,
                "url": destination.url,
            }))
            .collect::<Vec<_>>(),
    })
}

fn hello_frame(token: &str) -> Value {
    json!({ "t": "hello", "token": token, "client": client_info() })
}

fn intent_frame(id: &str, kind: &str) -> Value {
    json!({ "t": "intent", "id": id, "kind": kind })
}

fn new_intent_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// --- Runtime (the slot) -----------------------------------------------------

/// An intent's ack: `Ok` carries the runner's optional `result` (only
/// `ingest.get` has one today), `Err` the refusal or transport problem.
type AckResult = std::result::Result<Option<Value>, String>;
type AckSender = oneshot::Sender<AckResult>;

/// A request from the show's owner to the socket task.
struct ControlRequest {
    frame: Value,
    ack: Option<(String, AckSender)>,
}

#[derive(Debug, Clone)]
struct ActiveShow {
    record: ShowRecord,
    control: ShowControl,
    /// Present after a create, or when `GET current` handed it back.
    ingest: Option<Vec<ShowIngest>>,
    /// The local session feeding the show; `None` is a resumable show.
    session_id: Option<String>,
    destinations: Vec<HandoverDestination>,
    /// The runner acked `destinations` for this show: from then on a state
    /// without legs means it restarted and lost them.
    handed_over: bool,
    /// Set by a resume until the runner reports live again.
    resuming: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FailedShow {
    end_reason: String,
    message: String,
    /// The web confirmed the show gone while a session fed it (C2).
    direct_fallback: bool,
}

#[derive(Default)]
pub struct CloudShowRuntime {
    pub settings: CloudSettings,
    pub entitlement: CloudEntitlement,
    connected: bool,
    ending: bool,
    show: Option<ActiveShow>,
    runner: Option<RunnerState>,
    failed: Option<FailedShow>,
    fallback: Option<CloudFallback>,
    end_reason: Option<String>,
    message: Option<String>,
    /// Bumped with every new show or socket owner so a stale task stops.
    generation: u64,
    control_tx: Option<mpsc::UnboundedSender<ControlRequest>>,
    /// C6b: the test that runs or the last one that ran, and the running
    /// test task's cancel switch (`Some` only while it runs).
    test: Option<CloudTestStatus>,
    test_run: Option<watch::Sender<bool>>,
    restart: Option<CloudRestart>,
}

pub type CloudShowSlot = Arc<StdMutex<CloudShowRuntime>>;

pub fn new_cloud_show_slot(settings: CloudSettings) -> CloudShowSlot {
    Arc::new(StdMutex::new(CloudShowRuntime {
        settings: settings.normalized(),
        ..CloudShowRuntime::default()
    }))
}

/// The persisted settings, or the defaults when nothing was saved or the
/// saved row does not parse (an older build): never a startup failure.
pub fn load_settings(database: &crate::storage::Database) -> CloudSettings {
    match database.load_setting::<CloudSettings>(CLOUD_SETTINGS_KEY) {
        Ok(Some(settings)) => settings.normalized(),
        Ok(None) => CloudSettings::default(),
        Err(error) => {
            tracing::warn!("Could not load the Videorc Cloud settings: {error:#}");
            CloudSettings::default()
        }
    }
}

fn lock(slot: &CloudShowSlot) -> std::sync::MutexGuard<'_, CloudShowRuntime> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CloudShowRuntime {
    pub fn phase(&self) -> CloudPhase {
        if self.failed.is_some() {
            return CloudPhase::Failed;
        }
        if self.ending {
            return CloudPhase::Ending;
        }
        let Some(show) = &self.show else {
            return CloudPhase::Off;
        };
        if !self.connected {
            return CloudPhase::Connecting;
        }
        match self.runner.as_ref().map(|runner| runner.phase.as_str()) {
            Some("live") => CloudPhase::Live,
            Some("hold") if show.resuming => CloudPhase::Resuming,
            Some("hold") => CloudPhase::Hold,
            Some("ending") => CloudPhase::Ending,
            _ if show.resuming => CloudPhase::Resuming,
            _ => CloudPhase::Connecting,
        }
    }

    /// At launch, ask the web for a live show (C5) when the account could
    /// own one: entitled now, or on a paid plan whose cloud block says off.
    /// The rollback switch turns the block off (lane 3 R1), but a show that
    /// was live when it flipped keeps running, and only `current` tells a
    /// relaunched desktop which one to resume or end.
    pub fn may_own_a_show(&self) -> bool {
        self.entitlement.entitled() || self.entitlement.plan.is_some()
    }

    /// The switch is on and the account is entitled.
    #[cfg(test)]
    pub fn cloud_mode_on(&self) -> bool {
        self.settings.switch_on() && self.entitlement.entitled()
    }

    pub fn status(&self) -> CloudStatus {
        let runner = self.runner.as_ref();
        CloudStatus {
            phase: self.phase(),
            entitled: self.entitlement.entitled(),
            plan: self.entitlement.plan,
            settings: CloudSettingsView {
                enabled: self.settings.switch_on(),
                hold_max_seconds: self.settings.hold_max_seconds,
                hold_max_choices: HOLD_MAX_CHOICES.to_vec(),
                hold_image_screen_id: self.settings.hold_image_screen_id.clone(),
            },
            allowance: self.entitlement.cloud.clone(),
            show: self.show.as_ref().map(|show| CloudShowSummary {
                id: show.record.id.clone(),
                node_id: show.record.node_id.clone(),
                created_at: show.record.created_at.clone(),
                expires_at: show.record.expires_at.clone(),
                resumable: show.session_id.is_none(),
            }),
            session_id: self.show.as_ref().and_then(|show| show.session_id.clone()),
            connected: self.connected,
            hold: runner.and_then(|runner| runner.hold.clone()),
            feeds: runner
                .map(|runner| runner.feeds.clone())
                .unwrap_or_default(),
            legs: runner
                .map(|runner| runner.legs.iter().map(runner_leg_to_runtime).collect())
                .unwrap_or_default(),
            live_seconds: runner.map(|runner| runner.live_seconds),
            fallback: self.fallback.clone(),
            end_reason: self
                .failed
                .as_ref()
                .map(|failed| failed.end_reason.clone())
                .or_else(|| self.end_reason.clone()),
            message: self
                .failed
                .as_ref()
                .map(|failed| failed.message.clone())
                .or_else(|| self.message.clone()),
            direct_fallback_available: self
                .failed
                .as_ref()
                .is_some_and(|failed| failed.direct_fallback),
            test: self.test.clone(),
            restart: self.restart.clone(),
        }
    }

    /// A test is running (C6b): its task owns a show on the web.
    pub fn test_running(&self) -> bool {
        self.test_run.is_some()
    }

    /// Tells a running test to stop, without waiting (C6b): a recording or a
    /// livestream starting needs the upload and the encoder, so the test
    /// yields. Its task kills its FFmpeg and ends its show on its own, and
    /// its result is dropped. True when a test was running.
    pub fn signal_test_cancel(&self) -> bool {
        match self.test_run.as_ref() {
            Some(cancel) => {
                let _ = cancel.send(true);
                true
            }
            None => false,
        }
    }

    /// The local session feeding the show, when there is one.
    pub fn feeding_session(&self) -> Option<String> {
        self.show.as_ref().and_then(|show| show.session_id.clone())
    }

    /// A show that is live on the runner with no local feed (C5).
    pub fn resumable_show_id(&self) -> Option<String> {
        self.show
            .as_ref()
            .filter(|show| show.session_id.is_none())
            .map(|show| show.record.id.clone())
    }

    /// A session start that bound this show and then failed before it ran
    /// (FFmpeg, capture, an unrelated refusal) leaves the show without a
    /// feed: make it resumable again rather than bound to a dead session.
    /// True when anything changed.
    pub fn release_unfed_session(&mut self, active_session_id: Option<&str>) -> bool {
        let Some(show) = self.show.as_mut() else {
            return false;
        };
        match show.session_id.as_deref() {
            Some(bound) if Some(bound) != active_session_id => {
                show.session_id = None;
                show.resuming = false;
                true
            }
            _ => false,
        }
    }

    fn bump_generation(&mut self) -> u64 {
        self.generation += 1;
        self.control_tx = None;
        self.connected = false;
        self.generation
    }

    fn clear_show(&mut self, end_reason: Option<String>) {
        self.show = None;
        self.runner = None;
        self.restart = None;
        self.ending = false;
        self.end_reason = end_reason;
        self.bump_generation();
    }
}

/// Hands a session id and the runner's legs to the session's leg model.
pub type CloudLegsHook = Arc<dyn Fn(&str, Vec<StreamTargetRuntime>) + Send + Sync>;

/// How the socket task reaches the app without owning `AppState`: emit the
/// whole state, and hand the runner's legs to the session's leg model.
#[derive(Clone)]
pub struct CloudHooks {
    pub emit: Arc<dyn Fn(CloudStatus) + Send + Sync>,
    pub legs: CloudLegsHook,
}

impl CloudHooks {
    fn emit_from(&self, slot: &CloudShowSlot) {
        let status = lock(slot).status();
        (self.emit)(status);
    }
}

// --- Go Live decision (D11, D18) ---------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoLiveDecision {
    /// Stream directly as today, silently: the user switched the cloud off,
    /// or the account has no cloud right now (Basic, signed out, the rollout
    /// switch off, outside the cohort). Nothing was expected, so nothing is
    /// explained: a Basic user's Go Live never mentions the cloud.
    DirectByChoice,
    /// Stream directly and say why once: the account expected the cloud.
    DirectWithReason(CloudFallbackReason),
    /// Create a show, or resume the one that is live.
    Cloud,
}

pub fn decide_go_live(runtime: &CloudShowRuntime, signed_in: bool) -> GoLiveDecision {
    if !runtime.settings.switch_on() || !signed_in || !runtime.entitlement.entitled() {
        return GoLiveDecision::DirectByChoice;
    }
    if runtime.entitlement.seconds_remaining() < MIN_SECONDS_LEFT_TO_START {
        return GoLiveDecision::DirectWithReason(CloudFallbackReason::CloudHoursUsedUp);
    }
    GoLiveDecision::Cloud
}

// --- The session seam (C3 calls these) ---------------------------------------

/// What `recording.rs` needs to swap the targets: the show and its ingest.
#[derive(Debug, Clone)]
pub struct SessionHandover {
    pub show_id: String,
    pub ingest: Vec<ShowIngest>,
}

/// Everything a session start needs from the cloud, with the web and the
/// socket behind traits so the state machine runs against fakes.
pub struct CloudShowContext<W: CloudWebApi, C: ControlConnector> {
    pub slot: CloudShowSlot,
    pub hooks: CloudHooks,
    pub web: Arc<W>,
    pub connector: Arc<C>,
}

impl<W: CloudWebApi, C: ControlConnector> Clone for CloudShowContext<W, C> {
    fn clone(&self) -> Self {
        Self {
            slot: self.slot.clone(),
            hooks: self.hooks.clone(),
            web: self.web.clone(),
            connector: self.connector.clone(),
        }
    }
}

enum HelloFailure {
    BadToken,
    NoSuchShow,
    Transport(String),
}

async fn connect_and_hello<C: ControlConnector>(
    connector: &C,
    control: &ShowControl,
) -> std::result::Result<(C::Transport, RunnerState), HelloFailure> {
    let mut transport = connector
        .connect(&control.url)
        .await
        .map_err(|error| HelloFailure::Transport(format!("{error:#}")))?;
    transport
        .send(hello_frame(&control.token))
        .await
        .map_err(|error| HelloFailure::Transport(format!("{error:#}")))?;
    let first = tokio::time::timeout(WELCOME_TIMEOUT, transport.recv()).await;
    match first {
        Ok(Some(ControlFrameIn::Text(text))) => match serde_json::from_str::<RunnerFrame>(&text) {
            Ok(RunnerFrame::Welcome { state }) => Ok((transport, state)),
            Ok(_) => Err(HelloFailure::Transport(
                "the node answered hello with something other than welcome".to_string(),
            )),
            Err(error) => Err(HelloFailure::Transport(format!(
                "the node's welcome did not parse: {error}"
            ))),
        },
        Ok(Some(ControlFrameIn::Closed {
            code: Some(CLOSE_CODE_BAD_TOKEN),
        })) => Err(HelloFailure::BadToken),
        Ok(Some(ControlFrameIn::Closed {
            code: Some(CLOSE_CODE_NO_SUCH_SHOW),
        })) => Err(HelloFailure::NoSuchShow),
        Ok(Some(ControlFrameIn::Closed { code })) => Err(HelloFailure::Transport(format!(
            "the node closed the control socket ({})",
            code.map(|code| code.to_string())
                .unwrap_or_else(|| "no code".to_string())
        ))),
        Ok(None) => Err(HelloFailure::Transport(
            "the control socket closed before welcome".to_string(),
        )),
        Err(_) => Err(HelloFailure::Transport(
            "the node did not answer hello in time".to_string(),
        )),
    }
}

/// Install a connected socket as the show's control channel and run its loop
/// on its own task. Returns the request sender.
fn install_control_loop<W: CloudWebApi, C: ControlConnector>(
    context: &CloudShowContext<W, C>,
    bearer: String,
    control: ShowControl,
    show_id: String,
    transport: C::Transport,
    welcome: RunnerState,
) -> mpsc::UnboundedSender<ControlRequest> {
    let (tx, rx) = mpsc::unbounded_channel();
    let generation = {
        let mut runtime = lock(&context.slot);
        let generation = runtime.bump_generation();
        runtime.control_tx = Some(tx.clone());
        runtime.connected = true;
        runtime.runner = Some(welcome);
        generation
    };
    let task = ControlLoop {
        context: context.clone(),
        bearer,
        control,
        show_id,
        generation,
        restart_seen_on_socket: false,
        resend: None,
    };
    tokio::spawn(task.run(transport, rx));
    tx
}

struct ControlLoop<W: CloudWebApi, C: ControlConnector> {
    context: CloudShowContext<W, C>,
    bearer: String,
    control: ShowControl,
    show_id: String,
    generation: u64,
    /// A runner restart was already handled on this socket: re-send once.
    restart_seen_on_socket: bool,
    /// Destinations to send again on the current socket (a runner restart).
    resend: Option<Vec<HandoverDestination>>,
}

/// A runner that restarted mid-show (plan 184 "When things break"). The
/// agent restarts a crashed runner and hands it the destinations it last
/// relayed, but they live in memory only: after an agent restart too, the
/// runner has none. The runner says so (`destinationsSet`, `restarts`); an
/// older runner only shows it as a state without legs. Pure, so the decision
/// is a test.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RunnerRestart {
    /// The runner has no destinations: send these again; the legs reconnect.
    Resend(Vec<HandoverDestination>),
    /// The node gave the runner its destinations back by itself.
    Recovered,
    /// The runner has none and this computer holds no keys for the show (it
    /// was resumed after a relaunch, C5b): dark until a new Go Live, unless
    /// the node still gives them back.
    CannotResend,
}

fn detect_runner_restart(
    show: &ActiveShow,
    previous: Option<&RunnerState>,
    state: &RunnerState,
) -> Option<RunnerRestart> {
    if state.phase == "ended" {
        return None;
    }
    let previous_legs = previous.map(|runner| runner.legs.as_slice()).unwrap_or(&[]);
    let lost = match state.destinations_set {
        Some(set) => !set,
        None => state.legs.is_empty(),
    };
    let restarted = match (previous.and_then(|runner| runner.restarts), state.restarts) {
        (Some(before), Some(now)) => now > before,
        _ => false,
    } || (state.destinations_set.is_none()
        && state.legs.is_empty()
        && !previous_legs.is_empty());
    if lost && show.handed_over && !show.destinations.is_empty() {
        return Some(RunnerRestart::Resend(show.destinations.clone()));
    }
    if !restarted {
        return None;
    }
    Some(if lost {
        RunnerRestart::CannotResend
    } else {
        RunnerRestart::Recovered
    })
}

/// The rows the session shows after a restart; `None` keeps the runner's own.
fn restart_leg_rows(
    restart: &RunnerRestart,
    previous_legs: &[RunnerLeg],
) -> Option<Vec<StreamTargetRuntime>> {
    Some(match restart {
        RunnerRestart::Resend(destinations) => destinations
            .iter()
            .map(|destination| StreamTargetRuntime {
                target_id: destination.id.clone(),
                platform: parse_platform(&destination.platform),
                label: destination.label.clone(),
                state: StreamTargetState::Reconnecting,
                message: Some("Videorc Cloud restarted your show.".to_string()),
                redacted_url: None,
            })
            .collect(),
        RunnerRestart::CannotResend => previous_legs
            .iter()
            .map(|leg| StreamTargetRuntime {
                state: StreamTargetState::Failed,
                message: Some(
                    "Videorc Cloud restarted your show. Stop, then go live again to reconnect."
                        .to_string(),
                ),
                ..runner_leg_to_runtime(leg)
            })
            .collect(),
        RunnerRestart::Recovered => return None,
    })
}

enum LoopExit {
    /// A newer owner took the show over.
    Superseded,
    /// The show is over, with the runner's or the web's reason.
    Ended(Option<String>),
    /// The web confirmed the show gone while the socket was down.
    Gone,
}

impl<W: CloudWebApi, C: ControlConnector> ControlLoop<W, C> {
    fn current(&self) -> bool {
        lock(&self.context.slot).generation == self.generation
    }

    async fn run(
        mut self,
        mut transport: C::Transport,
        mut rx: mpsc::UnboundedReceiver<ControlRequest>,
    ) {
        let mut pending: HashMap<String, AckSender> = HashMap::new();
        let exit = loop {
            match self.run_socket(&mut transport, &mut rx, &mut pending).await {
                Ok(exit) => break exit,
                Err(()) => {
                    // The socket dropped. Fail every waiting intent, show
                    // Connecting, then reconnect with backoff; the runner
                    // keeps the show, and only the web may say it is gone.
                    for (_, waiter) in pending.drain() {
                        let _ = waiter.send(Err(SOCKET_DROPPED.to_string()));
                    }
                    if !self.current() {
                        break LoopExit::Superseded;
                    }
                    {
                        let mut runtime = lock(&self.context.slot);
                        runtime.connected = false;
                    }
                    self.context.hooks.emit_from(&self.context.slot);
                    match self.reconnect().await {
                        Ok(reconnected) => transport = reconnected,
                        Err(exit) => break exit,
                    }
                }
            }
        };
        let _ = transport.close().await;
        match exit {
            LoopExit::Superseded => {}
            LoopExit::Ended(reason) => {
                if self.current() {
                    lock(&self.context.slot).clear_show(reason);
                    self.context.hooks.emit_from(&self.context.slot);
                }
            }
            LoopExit::Gone => {
                if self.current() {
                    self.mark_gone("show-gone", "Videorc Cloud no longer has this show.");
                }
            }
        }
    }

    /// Read frames and relay requests until the socket drops (`Err`) or the
    /// show ends (`Ok`).
    async fn run_socket(
        &mut self,
        transport: &mut C::Transport,
        rx: &mut mpsc::UnboundedReceiver<ControlRequest>,
        pending: &mut HashMap<String, AckSender>,
    ) -> std::result::Result<LoopExit, ()> {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await;
        loop {
            if !self.current() {
                return Ok(LoopExit::Superseded);
            }
            if let Some(destinations) = self.resend.take() {
                self.send_destinations_again(transport, pending, &destinations)
                    .await?;
            }
            tokio::select! {
                frame = transport.recv() => {
                    match frame {
                        None | Some(ControlFrameIn::Closed { .. }) => return Err(()),
                        Some(ControlFrameIn::Text(text)) => {
                            if let Some(exit) = self.handle_frame(&text, pending) {
                                return Ok(exit);
                            }
                        }
                    }
                }
                request = rx.recv() => {
                    let Some(request) = request else {
                        return Ok(LoopExit::Superseded);
                    };
                    if let Some((id, waiter)) = request.ack {
                        pending.insert(id, waiter);
                    }
                    if transport.send(request.frame).await.is_err() {
                        return Err(());
                    }
                }
                _ = ping.tick() => {
                    if transport.send(json!({ "t": "ping" })).await.is_err() {
                        return Err(());
                    }
                }
            }
        }
    }

    fn handle_frame(
        &mut self,
        text: &str,
        pending: &mut HashMap<String, AckSender>,
    ) -> Option<LoopExit> {
        let frame = match serde_json::from_str::<RunnerFrame>(text) {
            Ok(frame) => frame,
            Err(error) => {
                tracing::debug!("Videorc Cloud control frame did not parse: {error}");
                return None;
            }
        };
        match frame {
            RunnerFrame::State { state } | RunnerFrame::Welcome { state } => {
                if state.phase == "ended" {
                    return Some(LoopExit::Ended(state.end_reason.clone()));
                }
                self.absorb_state(state);
                None
            }
            RunnerFrame::Ack {
                id,
                ok,
                error,
                result,
            } => {
                if let Some(waiter) = pending.remove(&id) {
                    let _ = waiter.send(if ok {
                        Ok(result)
                    } else {
                        Err(error.unwrap_or_else(|| "the runner refused the intent".to_string()))
                    });
                }
                None
            }
            RunnerFrame::Pong | RunnerFrame::Unknown => None,
        }
    }

    /// A runner state into the slot and the session's legs. A runner that
    /// lists no legs after the hand-over restarted and lost its destinations
    /// (plan 184 "When things break"): once per socket, the rows go to
    /// Reconnecting and the destinations go again, or, with no keys on this
    /// computer, the rows say so.
    fn absorb_state(&mut self, state: RunnerState) {
        let (session, legs) = {
            let mut runtime = lock(&self.context.slot);
            if state.phase == "live"
                && let Some(show) = runtime.show.as_mut()
            {
                show.resuming = false;
            }
            let previous = runtime.runner.take();
            let previous_legs = previous
                .as_ref()
                .map(|runner| runner.legs.clone())
                .unwrap_or_default();
            let restart = if self.restart_seen_on_socket {
                None
            } else {
                runtime
                    .show
                    .as_ref()
                    .and_then(|show| detect_runner_restart(show, previous.as_ref(), &state))
            };
            let session = runtime.feeding_session();
            let mut legs: Vec<StreamTargetRuntime> =
                state.legs.iter().map(runner_leg_to_runtime).collect();
            // Legs back after a restart: the platforms are reconnecting.
            if !state.legs.is_empty()
                && let Some(open) = runtime.restart.as_mut()
            {
                open.destinations_resent = true;
            }
            if let Some(restart) = restart {
                self.restart_seen_on_socket = true;
                if let Some(rows) = restart_leg_rows(&restart, &previous_legs) {
                    legs = rows;
                }
                let destinations_resent = !matches!(restart, RunnerRestart::CannotResend);
                tracing::warn!(
                    show = %self.show_id,
                    destinations_resent,
                    "Videorc Cloud restarted the show"
                );
                // One restart until the legs come back: a socket that drops
                // before the ack sends again, under the same notice.
                let at = match &runtime.restart {
                    Some(open) if previous_legs.is_empty() => open.at.clone(),
                    _ => now_rfc3339(),
                };
                runtime.restart = Some(CloudRestart {
                    at,
                    destinations_resent,
                });
                if let RunnerRestart::Resend(destinations) = restart {
                    self.resend = Some(destinations);
                }
            }
            runtime.runner = Some(state);
            runtime.connected = true;
            (session, legs)
        };
        if let Some(session_id) = session
            && !legs.is_empty()
        {
            (self.context.hooks.legs)(&session_id, legs);
        }
        self.context.hooks.emit_from(&self.context.slot);
    }

    /// `destinations.set` again after a runner restart. The ack is awaited
    /// off the loop: a refusal or silence marks the restart unrecovered; a
    /// socket that drops first sends them again after the reconnect.
    async fn send_destinations_again(
        &self,
        transport: &mut C::Transport,
        pending: &mut HashMap<String, AckSender>,
        destinations: &[HandoverDestination],
    ) -> std::result::Result<(), ()> {
        let id = new_intent_id();
        let (ack_tx, ack_rx) = oneshot::channel();
        pending.insert(id.clone(), ack_tx);
        transport
            .send(destinations_set_frame(&id, destinations))
            .await
            .map_err(|_| ())?;
        let slot = self.context.slot.clone();
        let hooks = self.context.hooks.clone();
        let generation = self.generation;
        tokio::spawn(async move {
            let problem = match tokio::time::timeout(ACK_TIMEOUT, ack_rx).await {
                Ok(Ok(Ok(_))) | Ok(Err(_)) => return,
                Ok(Ok(Err(problem))) if problem == SOCKET_DROPPED => return,
                Ok(Ok(Err(problem))) => problem,
                Err(_) => "the runner did not acknowledge in time".to_string(),
            };
            tracing::warn!("Videorc Cloud did not take the destinations again: {problem}");
            {
                let mut runtime = lock(&slot);
                if runtime.generation != generation {
                    return;
                }
                if let Some(restart) = runtime.restart.as_mut() {
                    restart.destinations_resent = false;
                }
            }
            hooks.emit_from(&slot);
        });
        Ok(())
    }

    /// Reconnect with backoff. From the second failure on, ask the web
    /// whether the show still exists: gone means the runner no longer holds
    /// the platforms, and only then may the desktop treat the show as lost.
    async fn reconnect(&mut self) -> std::result::Result<C::Transport, LoopExit> {
        let mut attempt = 0usize;
        loop {
            let wait = RECONNECT_BACKOFF_SECONDS[attempt.min(RECONNECT_BACKOFF_SECONDS.len() - 1)];
            tokio::time::sleep(Duration::from_secs(wait)).await;
            if !self.current() {
                return Err(LoopExit::Superseded);
            }
            match connect_and_hello(self.context.connector.as_ref(), &self.control).await {
                Ok((transport, welcome)) => {
                    self.restart_seen_on_socket = false;
                    self.resend = None;
                    self.absorb_state(welcome);
                    return Ok(transport);
                }
                Err(HelloFailure::NoSuchShow) => {
                    if self.confirm_show_gone().await == Some(true) {
                        return Err(LoopExit::Gone);
                    }
                }
                Err(HelloFailure::BadToken) => {
                    // The token expired or rotated: the web mints a fresh one
                    // with the current show, or says the show is gone. An
                    // unreachable web changes nothing: keep trying.
                    if let Ok(current) = self.context.web.current_show(&self.bearer).await {
                        match (current.show, current.control) {
                            (Some(show), Some(control)) if show.id == self.show_id => {
                                self.control = control;
                            }
                            (Some(_), _) | (None, _) => return Err(LoopExit::Gone),
                        }
                    }
                }
                Err(HelloFailure::Transport(message)) => {
                    tracing::info!("Videorc Cloud control socket reconnect failed: {message}");
                    if attempt >= 1 && self.confirm_show_gone().await == Some(true) {
                        return Err(LoopExit::Gone);
                    }
                }
            }
            attempt += 1;
        }
    }

    /// `Some(true)` when the web says the show is over or another show is
    /// current; `None` when the web could not be reached (unknown: keep the
    /// show, never go direct).
    async fn confirm_show_gone(&self) -> Option<bool> {
        match self.context.web.current_show(&self.bearer).await {
            Ok(current) => Some(
                current
                    .show
                    .map(|show| show.id != self.show_id || show.status == "ended")
                    .unwrap_or(true),
            ),
            Err(_) => None,
        }
    }

    fn mark_gone(&self, end_reason: &str, message: &str) {
        {
            let mut runtime = lock(&self.context.slot);
            let fed_by_session = runtime.feeding_session().is_some();
            runtime.show = None;
            runtime.runner = None;
            runtime.restart = None;
            runtime.ending = false;
            runtime.failed = Some(FailedShow {
                end_reason: end_reason.to_string(),
                message: message.to_string(),
                direct_fallback: fed_by_session,
            });
            runtime.bump_generation();
        }
        self.context.hooks.emit_from(&self.context.slot);
    }
}

async fn send_intent(
    tx: &mpsc::UnboundedSender<ControlRequest>,
    frame: Value,
    id: String,
    timeout: Duration,
) -> AckResult {
    let (ack_tx, ack_rx) = oneshot::channel();
    tx.send(ControlRequest {
        frame,
        ack: Some((id, ack_tx)),
    })
    .map_err(|_| "the control socket is gone".to_string())?;
    match tokio::time::timeout(timeout, ack_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the control socket dropped before the ack".to_string()),
        Err(_) => Err("the runner did not acknowledge in time".to_string()),
    }
}

/// `hold.image.set`, best effort: the runner draws its default card without
/// one, so a refusal is a warning, never a failed start.
async fn send_hold_image(
    tx: &mpsc::UnboundedSender<ControlRequest>,
    hold_image_png_base64: Option<String>,
) {
    let Some(png) = hold_image_png_base64 else {
        return;
    };
    let id = new_intent_id();
    let frame = json!({ "t": "intent", "id": id, "kind": "hold.image.set", "pngBase64": png });
    if let Err(problem) = send_intent(tx, frame, id, ACK_TIMEOUT).await {
        tracing::warn!("Videorc Cloud did not take the hold image: {problem}");
    }
}

/// Wire shape: `ingest.get` on a connected, authenticated socket answers with
/// the show's ingest in the ack's `result` (`{ "ingest": [...] }`). Frames
/// that arrive first are state; the newest one replaces `latest`.
async fn fetch_ingest_over<T: ControlTransport>(
    transport: &mut T,
    latest: &mut RunnerState,
) -> std::result::Result<Vec<ShowIngest>, String> {
    let id = new_intent_id();
    transport
        .send(intent_frame(&id, "ingest.get"))
        .await
        .map_err(|error| format!("{error:#}"))?;
    let deadline = tokio::time::Instant::now() + ACK_TIMEOUT;
    loop {
        let frame = tokio::time::timeout_at(deadline, transport.recv())
            .await
            .map_err(|_| "the runner did not answer ingest.get in time".to_string())?;
        match frame {
            None | Some(ControlFrameIn::Closed { .. }) => {
                return Err("the control socket closed before the ingest arrived".to_string());
            }
            Some(ControlFrameIn::Text(text)) => match serde_json::from_str::<RunnerFrame>(&text) {
                Ok(RunnerFrame::Ack {
                    id: ack_id,
                    ok,
                    error,
                    result,
                }) if ack_id == id => {
                    if !ok {
                        return Err(
                            error.unwrap_or_else(|| "the runner refused ingest.get".to_string())
                        );
                    }
                    return result
                        .and_then(|result| result.get("ingest").cloned())
                        .and_then(|value| serde_json::from_value::<Vec<ShowIngest>>(value).ok())
                        .filter(|ingest| !ingest.is_empty())
                        .ok_or_else(|| "the runner's ingest.get answer had no ingest".to_string());
                }
                Ok(RunnerFrame::State { state } | RunnerFrame::Welcome { state }) => {
                    *latest = state;
                }
                Ok(_) | Err(_) => {}
            },
        }
    }
}

/// The outcome of asking the cloud to carry a session.
#[derive(Debug)]
pub enum PrepareOutcome {
    /// Stream directly, exactly as today.
    Direct,
    /// Swap the targets for the show's ingest.
    Cloud(SessionHandover),
}

/// A resume either feeds the show again or finds it over: the web no longer
/// lists it, or its node no longer has it. Go Live then starts a new show.
enum ResumeOutcome {
    Resumed(PrepareOutcome),
    ShowGone(String),
}

impl<W: CloudWebApi, C: ControlConnector> CloudShowContext<W, C> {
    fn record_fallback(
        &self,
        session_id: &str,
        reason: CloudFallbackReason,
        message: Option<String>,
    ) {
        {
            let mut runtime = lock(&self.slot);
            runtime.fallback = Some(CloudFallback {
                reason,
                at: now_rfc3339(),
                session_id: session_id.to_string(),
                message,
            });
        }
        self.hooks.emit_from(&self.slot);
    }

    /// Hydrate the account's `cloud` block and plan (from the capabilities
    /// refresh). Emits when anything the renderer shows changed.
    pub fn hydrate_entitlement(
        &self,
        plan: Option<EntitlementPlan>,
        cloud: Option<AiCapabilitiesCloud>,
    ) {
        let changed = {
            let mut runtime = lock(&self.slot);
            let next = CloudEntitlement { plan, cloud };
            let changed = runtime.entitlement != next;
            runtime.entitlement = next;
            changed
        };
        if changed {
            self.hooks.emit_from(&self.slot);
        }
    }

    /// Go Live (C4). `bearer` is the signed-in account's session token, or
    /// `None` when signed out. `destinations` are the resolved targets, keys
    /// plain, for the hand-over; they go to the runner and nowhere else.
    pub async fn prepare_session(
        &self,
        session_id: &str,
        bearer: Option<String>,
        outputs: Vec<ShowOutputSpec>,
        destinations: Vec<HandoverDestination>,
        hold_image_png_base64: Option<String>,
    ) -> Result<PrepareOutcome> {
        let (decision, hold_max_seconds, resumable) = {
            let mut runtime = lock(&self.slot);
            runtime.failed = None;
            runtime.fallback = None;
            let decision = decide_go_live(&runtime, bearer.is_some());
            let resumable = runtime
                .show
                .as_ref()
                .filter(|show| show.session_id.is_none())
                .map(|show| show.record.id.clone());
            (decision, runtime.settings.hold_max_seconds, resumable)
        };
        let bearer = match decision {
            GoLiveDecision::DirectByChoice => return Ok(PrepareOutcome::Direct),
            GoLiveDecision::DirectWithReason(reason) => {
                self.record_fallback(session_id, reason, None);
                return Ok(PrepareOutcome::Direct);
            }
            GoLiveDecision::Cloud => bearer.expect("a Cloud decision needs a bearer"),
        };
        if destinations.is_empty() {
            bail!("Videorc Cloud needs at least one destination to hand over.");
        }
        // A Test cloud mid-run holds the account's one open show (C6b): the
        // show wins, so the test ends first.
        self.cancel_test().await;

        // A show that is live without a feed is what Go Live resumes (C5),
        // with the destinations it just prepared: Go Live is a new broadcast
        // by choice. One that ended while this computer was away starts a new
        // show. The Resume notice takes `resume_session` instead (C5b).
        if let Some(show_id) = resumable {
            match self
                .resume_into_session(
                    session_id,
                    &bearer,
                    &show_id,
                    Some(destinations.clone()),
                    hold_image_png_base64.clone(),
                )
                .await?
            {
                ResumeOutcome::Resumed(outcome) => return Ok(outcome),
                ResumeOutcome::ShowGone(_) => {}
            }
        }

        let request = CreateShowRequest {
            kind: "solo".to_string(),
            outputs,
            hold_max_seconds,
            client: client_info(),
        };
        let created = match self.web.create_show(&bearer, &request).await {
            Ok(created) => created,
            // A Test cloud still open on the web (C6b): one a crashed desktop
            // left, or one whose end did not reach the web. The web never
            // offers a test for resume, so the show closes it and starts
            // anew, once.
            Err(CloudApiError::ShowLive(Some(live))) if live.is_test() => {
                let _ = self.web.end_show(&bearer, &live.id).await;
                match self.web.create_show(&bearer, &request).await {
                    Ok(created) => created,
                    Err(error) => return self.create_failed(session_id, error),
                }
            }
            Err(CloudApiError::ShowLive(live)) => {
                match self
                    .adopt_live_show(
                        session_id,
                        &bearer,
                        live.map(|live| *live),
                        destinations.clone(),
                        hold_image_png_base64.clone(),
                    )
                    .await?
                {
                    ResumeOutcome::Resumed(outcome) => return Ok(outcome),
                    // The web still lists a show its node already ended (the
                    // node's next heartbeat would close it): close it here
                    // and start a new show, once.
                    ResumeOutcome::ShowGone(stale) => {
                        let _ = self.web.end_show(&bearer, &stale).await;
                        match self.web.create_show(&bearer, &request).await {
                            Ok(created) => created,
                            Err(error) => return self.create_failed(session_id, error),
                        }
                    }
                }
            }
            Err(error) => return self.create_failed(session_id, error),
        };
        if let Some(allowance) = created.allowance.clone() {
            let mut runtime = lock(&self.slot);
            runtime.entitlement.cloud = Some(allowance);
        }
        let show_id = created.show.id.clone();
        let ingest = created.ingest.clone();
        if ingest.is_empty() {
            let _ = self.web.end_show(&bearer, &show_id).await;
            bail!("Videorc Cloud created a show without an ingest address.");
        }
        // Nothing crosses to a node this computer can't feed securely: no
        // key has left yet, so direct is safe (D11).
        if let Some(problem) = ingest
            .iter()
            .find_map(|entry| ingest_url_problem(&entry.server_url, cfg!(debug_assertions)))
        {
            let _ = self.web.end_show(&bearer, &show_id).await;
            self.record_fallback(
                session_id,
                CloudFallbackReason::CloudNodeUnreachable,
                Some(problem),
            );
            return Ok(PrepareOutcome::Direct);
        }

        // Nothing is handed over until the node says welcome. A node that
        // cannot be reached has no keys, so direct is safe here (D11).
        let (transport, welcome) =
            match connect_and_hello(self.connector.as_ref(), &created.control).await {
                Ok(connected) => connected,
                Err(failure) => {
                    let _ = self.web.end_show(&bearer, &show_id).await;
                    let message = match failure {
                        HelloFailure::BadToken => "the node refused the show token".to_string(),
                        HelloFailure::NoSuchShow => "the node does not know the show".to_string(),
                        HelloFailure::Transport(message) => message,
                    };
                    self.record_fallback(
                        session_id,
                        CloudFallbackReason::CloudNodeUnreachable,
                        Some(message),
                    );
                    return Ok(PrepareOutcome::Direct);
                }
            };
        {
            let mut runtime = lock(&self.slot);
            runtime.show = Some(ActiveShow {
                record: created.show.clone(),
                control: created.control.clone(),
                ingest: Some(ingest.clone()),
                session_id: Some(session_id.to_string()),
                destinations: destinations.clone(),
                handed_over: false,
                resuming: false,
            });
            runtime.end_reason = None;
            runtime.message = None;
            runtime.restart = None;
        }
        let tx = install_control_loop(
            self,
            bearer.clone(),
            created.control.clone(),
            show_id.clone(),
            transport,
            welcome,
        );
        self.hooks.emit_from(&self.slot);
        self.hand_over(&tx, &bearer, &show_id, &destinations, hold_image_png_base64)
            .await?;
        Ok(PrepareOutcome::Cloud(SessionHandover { show_id, ingest }))
    }

    /// A create the web refused: stream directly with the reason when it has
    /// one (D11), or fail the start.
    fn create_failed(&self, session_id: &str, error: CloudApiError) -> Result<PrepareOutcome> {
        match error.fallback_reason() {
            Some(reason) => {
                self.record_fallback(session_id, reason, Some(error.to_string()));
                Ok(PrepareOutcome::Direct)
            }
            None => Err(anyhow::Error::new(error)),
        }
    }

    /// The web knows a live show this computer forgot (a crash before launch
    /// detection ran): adopt it and resume it.
    async fn adopt_live_show(
        &self,
        session_id: &str,
        bearer: &str,
        live: Option<ShowRecord>,
        destinations: Vec<HandoverDestination>,
        hold_image_png_base64: Option<String>,
    ) -> Result<ResumeOutcome> {
        match self.web.current_show(bearer).await {
            Ok(CurrentShowResponse {
                show: Some(show),
                control: Some(control),
                ingest,
            }) if live.as_ref().is_none_or(|live| live.id == show.id) => {
                let show_id = show.id.clone();
                {
                    let mut runtime = lock(&self.slot);
                    runtime.show = Some(ActiveShow {
                        record: show,
                        control,
                        ingest,
                        session_id: None,
                        destinations: Vec::new(),
                        handed_over: false,
                        resuming: false,
                    });
                    runtime.bump_generation();
                }
                self.resume_into_session(
                    session_id,
                    bearer,
                    &show_id,
                    Some(destinations),
                    hold_image_png_base64,
                )
                .await
            }
            _ => bail!(
                "You're still live through Videorc Cloud, but the show could not be picked up. End it from videorc.com/live or try again."
            ),
        }
    }

    /// The Resume notice (C5b): feed the show that is live again, with the
    /// legs the runner already holds. Nothing is prepared on a platform and
    /// no `destinations.set` is sent, so a YouTube broadcast keeps its key and
    /// its VOD stays one piece. The hold image goes only if the user picked
    /// one. A show that is gone is an error here, never a new show: Go Live
    /// is the one that starts one.
    pub async fn resume_session(
        &self,
        session_id: &str,
        bearer: Option<String>,
        hold_image_png_base64: Option<String>,
    ) -> Result<SessionHandover> {
        let Some(bearer) = bearer else {
            bail!("Sign in to Videorc to resume the stream.");
        };
        let show_id = {
            let mut runtime = lock(&self.slot);
            runtime.failed = None;
            runtime.fallback = None;
            runtime.resumable_show_id()
        };
        let Some(show_id) = show_id else {
            bail!("There's no Videorc Cloud show to resume.");
        };
        self.cancel_test().await;
        match self
            .resume_into_session(session_id, &bearer, &show_id, None, hold_image_png_base64)
            .await?
        {
            ResumeOutcome::Resumed(PrepareOutcome::Cloud(handover)) => Ok(handover),
            ResumeOutcome::Resumed(PrepareOutcome::Direct) => {
                bail!("Videorc Cloud did not take the resume.")
            }
            ResumeOutcome::ShowGone(_) => {
                bail!("The stream already ended on Videorc Cloud. Go live to start a new one.")
            }
        }
    }

    /// Send the destinations (and the hold image) and wait for the ack. A
    /// refused or silent hand-over ends the show and, once the web confirms
    /// it gone, lets the session stream directly; an unconfirmed end fails
    /// the start instead, because the runner may still hold the keys (C2).
    async fn hand_over(
        &self,
        tx: &mpsc::UnboundedSender<ControlRequest>,
        bearer: &str,
        show_id: &str,
        destinations: &[HandoverDestination],
        hold_image_png_base64: Option<String>,
    ) -> Result<()> {
        let id = new_intent_id();
        let frame = destinations_set_frame(&id, destinations);
        if let Err(problem) = send_intent(tx, frame, id, ACK_TIMEOUT).await {
            let end_id = new_intent_id();
            let _ = send_intent(
                tx,
                intent_frame(&end_id, "show.end"),
                end_id,
                END_ACK_TIMEOUT,
            )
            .await;
            let _ = self.web.end_show(bearer, show_id).await;
            let gone = match self.web.current_show(bearer).await {
                Ok(current) => current
                    .show
                    .map(|show| show.id != show_id || show.status == "ended")
                    .unwrap_or(true),
                Err(_) => false,
            };
            lock(&self.slot).clear_show(Some("handover-failed".to_string()));
            if !gone {
                self.hooks.emit_from(&self.slot);
                bail!(
                    "Videorc Cloud did not take the destinations ({problem}) and the show could not be confirmed ended. Try again in a moment."
                );
            }
            bail!("Videorc Cloud did not take the destinations: {problem}.");
        }
        if let Some(show) = lock(&self.slot)
            .show
            .as_mut()
            .filter(|show| show.record.id == show_id)
        {
            show.handed_over = true;
        }
        send_hold_image(tx, hold_image_png_base64).await;
        Ok(())
    }

    /// Feed the show again. `destinations` is `Some` for a Go Live, which
    /// hands its freshly prepared destinations over, and `None` for the
    /// Resume notice (C5b), which keeps the runner's legs as they are.
    async fn resume_into_session(
        &self,
        session_id: &str,
        bearer: &str,
        show_id: &str,
        destinations: Option<Vec<HandoverDestination>>,
        hold_image_png_base64: Option<String>,
    ) -> Result<ResumeOutcome> {
        // A fresh token and, when the web hands it back, the ingest.
        let current = self.web.current_show(bearer).await;
        let (record, control, ingest) = {
            let mut runtime = lock(&self.slot);
            let Some(show) = runtime
                .show
                .as_mut()
                .filter(|show| show.record.id == show_id)
            else {
                bail!("There is no Videorc Cloud show to resume.");
            };
            if let Ok(current) = &current {
                match &current.show {
                    Some(fresh) if fresh.id == show_id => {
                        show.record = fresh.clone();
                        if let Some(control) = &current.control {
                            show.control = control.clone();
                        }
                        if let Some(ingest) = &current.ingest {
                            show.ingest = Some(ingest.clone());
                        }
                    }
                    _ => {
                        runtime.clear_show(Some("show-gone".to_string()));
                        drop(runtime);
                        self.hooks.emit_from(&self.slot);
                        return Ok(ResumeOutcome::ShowGone(show_id.to_string()));
                    }
                }
            }
            (
                show.record.clone(),
                show.control.clone(),
                show.ingest.clone(),
            )
        };
        let (mut transport, mut welcome) =
            match connect_and_hello(self.connector.as_ref(), &control).await {
                Ok(connected) => connected,
                Err(HelloFailure::NoSuchShow) => {
                    lock(&self.slot).clear_show(Some("show-gone".to_string()));
                    self.hooks.emit_from(&self.slot);
                    return Ok(ResumeOutcome::ShowGone(show_id.to_string()));
                }
                Err(HelloFailure::BadToken) => {
                    bail!("Videorc Cloud refused the show token; try again.")
                }
                Err(HelloFailure::Transport(message)) => {
                    bail!("Videorc Cloud could not be reached to resume the show: {message}")
                }
            };
        // The web never stores ingest keys and this computer never persists
        // them, so after a relaunch the node hands the ingest back to the
        // show's owner over the authenticated socket (Wire shape: ingest.get).
        let ingest = match ingest.filter(|ingest| !ingest.is_empty()) {
            Some(ingest) => ingest,
            None => match fetch_ingest_over(&mut transport, &mut welcome).await {
                Ok(ingest) => ingest,
                Err(problem) => {
                    transport.close().await;
                    bail!(
                        "Videorc Cloud could not hand back the show's ingest address ({problem}), so this computer cannot resume it. End the show and go live again."
                    );
                }
            },
        };
        {
            let mut runtime = lock(&self.slot);
            if let Some(show) = runtime.show.as_mut() {
                show.session_id = Some(session_id.to_string());
                if let Some(destinations) = &destinations {
                    show.destinations = destinations.clone();
                }
                show.resuming = true;
                show.record = record;
                show.ingest = Some(ingest.clone());
            }
            runtime.end_reason = None;
            runtime.message = None;
            runtime.restart = None;
        }
        let tx = install_control_loop(
            self,
            bearer.to_string(),
            control,
            show_id.to_string(),
            transport,
            welcome,
        );
        self.hooks.emit_from(&self.slot);
        match destinations {
            Some(destinations) => {
                self.hand_over(&tx, bearer, show_id, &destinations, hold_image_png_base64)
                    .await?;
            }
            // No destinations.set: the runner keeps every leg (and key) it
            // holds, so the platforms never see a restart.
            None => send_hold_image(&tx, hold_image_png_base64).await,
        }
        Ok(ResumeOutcome::Resumed(PrepareOutcome::Cloud(
            SessionHandover {
                show_id: show_id.to_string(),
                ingest,
            },
        )))
    }

    /// The desktop's Stop (C4): end the show this session fed. The YouTube
    /// `complete` transition stays with the renderer, as today.
    pub async fn on_session_stopped(&self, session_id: &str, bearer: Option<String>) {
        let feeding = {
            let runtime = lock(&self.slot);
            runtime.feeding_session().as_deref() == Some(session_id)
        };
        if feeding {
            let _ = self.end_current_show(bearer).await;
            return;
        }
        // A failed cloud leg of this session (show gone) is settled by the stop.
        let cleared = lock(&self.slot).failed.take().is_some();
        if cleared {
            self.hooks.emit_from(&self.slot);
        }
    }

    /// End the current show: `show.end` on the socket, `POST …/end` on the
    /// web, both best effort, then Off.
    pub async fn end_current_show(&self, bearer: Option<String>) -> Result<CloudStatus> {
        let (show_id, tx) = {
            let mut runtime = lock(&self.slot);
            runtime.failed = None;
            let Some(show_id) = runtime.show.as_ref().map(|show| show.record.id.clone()) else {
                return Ok(runtime.status());
            };
            runtime.ending = true;
            (show_id, runtime.control_tx.clone())
        };
        self.hooks.emit_from(&self.slot);
        if let Some(tx) = tx {
            let id = new_intent_id();
            let _ = send_intent(&tx, intent_frame(&id, "show.end"), id, END_ACK_TIMEOUT).await;
        }
        if let Some(bearer) = bearer
            && let Err(error) = self.web.end_show(&bearer, &show_id).await
        {
            tracing::info!("Videorc Cloud end request failed (the runner's end stands): {error}");
        }
        let status = {
            let mut runtime = lock(&self.slot);
            runtime.clear_show(Some("ended-by-host".to_string()));
            runtime.status()
        };
        self.hooks.emit_from(&self.slot);
        Ok(status)
    }

    /// C5: at launch, ask the web for a live show and keep it as resumable.
    /// Connects the control socket so the hold timer shows on the banner.
    pub async fn detect_current_show(&self, bearer: &str) -> Result<CloudStatus> {
        let current = self
            .web
            .current_show(bearer)
            .await
            .map_err(anyhow::Error::new)?;
        let Some(show) = current.show.filter(|show| show.status != "ended") else {
            return Ok(lock(&self.slot).status());
        };
        let Some(control) = current.control else {
            bail!("Videorc Cloud reported a live show without a control token.");
        };
        {
            let mut runtime = lock(&self.slot);
            if runtime
                .show
                .as_ref()
                .is_some_and(|active| active.session_id.is_some())
            {
                // A session is feeding a show right now; never replace it.
                return Ok(runtime.status());
            }
            runtime.failed = None;
            runtime.show = Some(ActiveShow {
                record: show.clone(),
                control: control.clone(),
                ingest: current.ingest,
                session_id: None,
                destinations: Vec::new(),
                handed_over: false,
                resuming: false,
            });
            runtime.bump_generation();
        }
        self.hooks.emit_from(&self.slot);
        match connect_and_hello(self.connector.as_ref(), &control).await {
            Ok((transport, welcome)) => {
                install_control_loop(
                    self,
                    bearer.to_string(),
                    control,
                    show.id,
                    transport,
                    welcome,
                );
            }
            Err(HelloFailure::NoSuchShow) => {
                lock(&self.slot).clear_show(Some("show-gone".to_string()));
            }
            Err(_) => {
                // Stay resumable and unconnected; Resume will connect again.
            }
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }

    /// `GET /api/cloud/allowance` for the Livestream page.
    pub async fn refresh_allowance(&self, bearer: &str) -> Result<CloudStatus> {
        let allowance = self
            .web
            .allowance(bearer)
            .await
            .map_err(anyhow::Error::new)?;
        {
            let mut runtime = lock(&self.slot);
            runtime.entitlement.cloud = Some(allowance);
        }
        self.hooks.emit_from(&self.slot);
        Ok(lock(&self.slot).status())
    }
}

// --- App glue (the production context) -------------------------------------

/// The hold image as the runner takes it: PNG, base64. The takeover screen is
/// re-encoded when it is not already a PNG.
pub fn hold_image_png_base64(screen_path: &str) -> Result<String> {
    use base64::Engine as _;
    let bytes = std::fs::read(screen_path)
        .with_context(|| format!("Could not read the hold image at {screen_path}"))?;
    let png = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        bytes
    } else {
        let decoded = image::load_from_memory(&bytes).context("The hold image did not decode.")?;
        let mut out = std::io::Cursor::new(Vec::new());
        decoded
            .write_to(&mut out, image::ImageFormat::Png)
            .context("The hold image could not be re-encoded as PNG.")?;
        out.into_inner()
    };
    if png.len() > HOLD_IMAGE_MAX_BYTES {
        bail!(
            "The hold image is {} bytes; the runner takes at most {HOLD_IMAGE_MAX_BYTES}.",
            png.len()
        );
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

// --- Test cloud (C6b) ---------------------------------------------------------
//
// "Test Videorc Cloud" on the Livestream page: a 10-second private test
// against a runner with no platforms, so a streamer learns before the show
// whether the cloud works from this connection and whether the upload keeps
// up with the stream quality. The web's `kind: "test"` show is capped at 30 s
// on the node, costs no cloud hours and is never offered for resume. The test
// never touches the Studio's session or the slot's show: it has its own
// socket, its own FFmpeg children (behind `CloudTestPusher`) and reports
// through `CloudStatus.test`. A Go Live or a Resume ends a running test first,
// because the web allows one open show per account; any other start stops it
// without waiting (`signal_test_cancel`), because the session needs the upload.

/// How long the test pushes video.
pub const TEST_PUSH_SECONDS: u64 = 10;
/// Past this the push phase is abandoned: a stalled push or a silent runner.
const TEST_DEADLINE: Duration = Duration::from_secs(45);
/// A feed that carried less than this share of its target is too slow.
pub const TEST_UPLOAD_OK_RATIO: f64 = 0.85;
/// A cancel waits this long for the test task to end its show and exit.
const TEST_CANCEL_WAIT: Duration = Duration::from_secs(10);

/// `cloud.selftest.run`: the outputs from the user's stream settings (the shape a
/// show would be created with) and the FFmpeg the smokes may point at.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestParams {
    pub outputs: Vec<CloudTestOutput>,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestOutput {
    pub orientation: StreamOutputOrientation,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
}

/// What one output's push came to when its FFmpeg exited.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TestPushOutcome {
    /// FFmpeg ran the whole push and exited 0.
    pub ok: bool,
    /// FFmpeg refused the node's certificate (C1c): the test's hardest "no".
    pub certificate_failed: bool,
    /// The last FFmpeg lines, with the key redacted, for the log.
    pub detail: Option<String>,
}

pub type TestPushFuture = Pin<Box<dyn Future<Output = Result<TestPushOutcome>> + Send>>;

/// Pushes synthetic video and audio at one output's shape to its ingest for
/// `seconds`, checking the node's certificate like a show's feed (C1c).
/// `recording.rs` implements it with the app's FFmpeg; the tests use a fake.
/// A push stops when `cancel` turns true and never outlives its future:
/// whatever it spawns, it kills through the child handle it holds, never a
/// process scan.
pub trait CloudTestPusher: Send + Sync {
    fn push(
        &self,
        ingest: ShowIngest,
        output: ShowOutputSpec,
        seconds: u64,
        cancel: watch::Receiver<bool>,
    ) -> TestPushFuture;
}

/// Why `cloud.selftest.run` did not start: an RPC error code and its line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudTestRefusal {
    SignedOut,
    NotEntitled,
    ShowLive,
    Running,
    NoOutputs,
}

impl CloudTestRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SignedOut => "cloud-signed-out",
            Self::NotEntitled => "cloud-not-entitled",
            Self::ShowLive => "cloud-test-show-live",
            Self::Running => "cloud-test-running",
            Self::NoOutputs => "cloud-test-no-outputs",
        }
    }
}

impl std::fmt::Display for CloudTestRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => write!(f, "Sign in to use Videorc Cloud."),
            Self::NotEntitled => write!(f, "Videorc Cloud comes with Videorc Premium."),
            Self::ShowLive => write!(f, "A show is live through Videorc Cloud. End it first."),
            Self::Running => write!(f, "A Videorc Cloud test is already running."),
            Self::NoOutputs => write!(
                f,
                "The test needs the stream quality of at least one output."
            ),
        }
    }
}

impl std::error::Error for CloudTestRefusal {}

/// Resolves once the test is canceled, or once its task is gone (the sender
/// dropped). Returns nothing, so no borrow of the channel outlives an await:
/// a `wait_for` guard inside `select!` would make the pushers' futures
/// `!Send`.
pub async fn wait_canceled(cancel: &mut watch::Receiver<bool>) {
    loop {
        let canceled = *cancel.borrow();
        if canceled {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

fn orientation_id(orientation: StreamOutputOrientation) -> String {
    match orientation {
        StreamOutputOrientation::Horizontal => "horizontal".to_string(),
        StreamOutputOrientation::Vertical => "vertical".to_string(),
    }
}

/// The web refused the test show: its reason in the renderer's vocabulary.
fn test_result_from_api_error(
    error: CloudApiError,
    uploads: Vec<CloudTestUpload>,
) -> CloudTestResult {
    let (reason, reset_at) = match &error {
        CloudApiError::NotEntitled => (CloudTestReason::NotEntitled, None),
        CloudApiError::ShowLive(_) => (CloudTestReason::ShowLive, None),
        CloudApiError::HoursUsedUp { reset_at } => (CloudTestReason::NoHours, reset_at.clone()),
        CloudApiError::TestLimit { reset_at } => (CloudTestReason::Limit, reset_at.clone()),
        CloudApiError::Disabled => (CloudTestReason::Off, None),
        CloudApiError::Full => (CloudTestReason::Full, None),
        CloudApiError::NodeUnreachable | CloudApiError::Transport(_) => {
            (CloudTestReason::CantReach, None)
        }
        CloudApiError::Other { status, .. } if *status >= 500 => (CloudTestReason::CantReach, None),
        CloudApiError::Unauthorized | CloudApiError::Other { .. } => {
            (CloudTestReason::Failed, None)
        }
    };
    CloudTestResult {
        ok: false,
        reason: Some(reason),
        message: Some(error.to_string()),
        time_to_live_ms: None,
        uploads,
        reset_at,
    }
}

/// The middle reading: the first poll after connecting covers a partial
/// window and a stalled link gives a low tail, so neither the max nor the
/// mean says what the link held.
fn median_kbps(samples: &[u32]) -> Option<u32> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

/// What the feed had to carry: the video at its bitrate and the audio.
fn test_upload_target_total_kbps(output: &ShowOutputSpec) -> u32 {
    output.video_kbps.saturating_add(output.audio_kbps)
}

/// The verdict on what the runner saw, pure so every rule is a test: the
/// certificate first (nothing else is trusted after it), then a push that
/// never ran (no FFmpeg, an ingest this computer can't stream to: this
/// computer's fault, not the network's), then a feed that never arrived, then
/// a show the runner ended, then a slow upload, then any push that did not
/// run clean.
fn test_verdict(input: TestVerdictInput<'_>) -> CloudTestResult {
    let uploads: Vec<CloudTestUpload> = input
        .outputs
        .iter()
        .map(|output| CloudTestUpload {
            orientation: orientation_id(output.orientation),
            target_kbps: output.video_kbps,
            measured_kbps: input
                .samples
                .get(&orientation_id(output.orientation))
                .and_then(|samples| median_kbps(samples)),
        })
        .collect();
    let detail = input
        .outcomes
        .iter()
        .filter_map(|outcome| match outcome {
            Ok(outcome) => outcome.detail.clone(),
            Err(error) => Some(format!("{error:#}")),
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let detail = (!detail.is_empty()).then_some(detail);
    let mut result = CloudTestResult {
        ok: false,
        reason: None,
        message: detail.clone(),
        time_to_live_ms: input.time_to_live_ms,
        uploads: uploads.clone(),
        reset_at: None,
    };
    if input.outcomes.iter().any(|outcome| {
        outcome
            .as_ref()
            .is_ok_and(|outcome| outcome.certificate_failed)
    }) {
        result.reason = Some(CloudTestReason::Certificate);
        return result;
    }
    if input.outcomes.iter().any(Result::is_err) {
        result.reason = Some(CloudTestReason::Failed);
        return result;
    }
    if input.time_to_live_ms.is_none() {
        result.reason = Some(CloudTestReason::NoFeed);
        return result;
    }
    if let Some(end_reason) = input.ended_by_runner {
        result.reason = Some(CloudTestReason::Failed);
        result.message = Some(format!("the runner ended the test show: {end_reason}"));
        return result;
    }
    // A feed the runner saw live but never measured (its readings come from
    // the node's own ingest) is unmeasured, never slow: the renderer says so
    // rather than blame the upload.
    let slow = input.outputs.iter().zip(&uploads).any(|(output, upload)| {
        let floor =
            (f64::from(test_upload_target_total_kbps(output)) * TEST_UPLOAD_OK_RATIO) as u32;
        upload
            .measured_kbps
            .is_some_and(|measured| measured < floor)
    });
    if slow {
        result.reason = Some(CloudTestReason::TooSlow);
        return result;
    }
    let clean = !input.timed_out
        && input
            .outcomes
            .iter()
            .all(|outcome| outcome.as_ref().is_ok_and(|outcome| outcome.ok));
    if !clean {
        result.reason = Some(CloudTestReason::Failed);
        if input.timed_out {
            result.message = Some("the test did not finish in time".to_string());
        }
        return result;
    }
    result.ok = true;
    result.message = None;
    result
}

struct TestVerdictInput<'a> {
    outputs: &'a [ShowOutputSpec],
    /// The runner's feed readings during the push, by orientation.
    samples: &'a HashMap<String, Vec<u32>>,
    outcomes: &'a [Result<TestPushOutcome>],
    time_to_live_ms: Option<u64>,
    ended_by_runner: Option<String>,
    timed_out: bool,
}

impl<W: CloudWebApi, C: ControlConnector> CloudShowContext<W, C> {
    /// Start the test and answer at once; the task reports through
    /// `cloud.state` (`CloudStatus.test`). The caller refuses while a session
    /// runs; this refuses while a show is live or resumable or a test runs.
    pub fn start_test(
        &self,
        bearer: Option<String>,
        outputs: Vec<ShowOutputSpec>,
        pusher: Arc<dyn CloudTestPusher>,
    ) -> std::result::Result<CloudStatus, CloudTestRefusal> {
        let Some(bearer) = bearer else {
            return Err(CloudTestRefusal::SignedOut);
        };
        if outputs.is_empty() {
            return Err(CloudTestRefusal::NoOutputs);
        }
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (started_at, hold_max_seconds) = {
            let mut runtime = lock(&self.slot);
            if !runtime.entitlement.entitled() {
                return Err(CloudTestRefusal::NotEntitled);
            }
            if runtime.show.is_some() {
                return Err(CloudTestRefusal::ShowLive);
            }
            if runtime.test_run.is_some() {
                return Err(CloudTestRefusal::Running);
            }
            let started_at = now_rfc3339();
            runtime.test = Some(CloudTestStatus {
                phase: CloudTestPhase::Creating,
                started_at: started_at.clone(),
                result: None,
            });
            runtime.test_run = Some(cancel_tx);
            (started_at, runtime.settings.hold_max_seconds)
        };
        let run = CloudTestRun {
            context: self.clone(),
            bearer,
            outputs,
            hold_max_seconds,
            pusher,
            cancel: cancel_rx,
            started_at,
            started: tokio::time::Instant::now(),
        };
        tokio::spawn(run.run());
        let status = lock(&self.slot).status();
        self.hooks.emit_from(&self.slot);
        Ok(status)
    }

    /// Ends a running test and waits for its task to leave: a Go Live or a
    /// Resume needs the account's one open show for itself. The result of a
    /// canceled test is dropped, not shown.
    pub async fn cancel_test(&self) {
        if !lock(&self.slot).signal_test_cancel() {
            return;
        }
        let deadline = tokio::time::Instant::now() + TEST_CANCEL_WAIT;
        while lock(&self.slot).test_running() {
            if tokio::time::Instant::now() >= deadline {
                tracing::warn!("The Videorc Cloud test did not stop in time; starting anyway.");
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// One test, on its own task: create the show, connect, push, read the
/// runner's state frames, end the show, judge.
struct CloudTestRun<W: CloudWebApi, C: ControlConnector> {
    context: CloudShowContext<W, C>,
    bearer: String,
    outputs: Vec<ShowOutputSpec>,
    hold_max_seconds: u32,
    pusher: Arc<dyn CloudTestPusher>,
    cancel: watch::Receiver<bool>,
    started_at: String,
    started: tokio::time::Instant,
}

impl<W: CloudWebApi, C: ControlConnector> CloudTestRun<W, C> {
    fn set_phase(&self, phase: CloudTestPhase) {
        {
            let mut runtime = lock(&self.context.slot);
            if let Some(test) = runtime.test.as_mut() {
                test.phase = phase;
            }
        }
        self.context.hooks.emit_from(&self.context.slot);
    }

    fn uploads(&self) -> Vec<CloudTestUpload> {
        self.outputs
            .iter()
            .map(|output| CloudTestUpload {
                orientation: orientation_id(output.orientation),
                target_kbps: output.video_kbps,
                measured_kbps: None,
            })
            .collect()
    }

    fn failed(&self, reason: CloudTestReason, message: String) -> CloudTestResult {
        CloudTestResult {
            ok: false,
            reason: Some(reason),
            message: Some(message),
            time_to_live_ms: None,
            uploads: self.uploads(),
            reset_at: None,
        }
    }

    async fn run(mut self) {
        let result = self.run_inner().await;
        if let Some(result) = &result {
            match &result.reason {
                None => tracing::info!(
                    "Videorc Cloud test passed: live in {:?} ms, uploads {:?}",
                    result.time_to_live_ms,
                    result.uploads
                ),
                Some(reason) => tracing::info!(
                    "Videorc Cloud test failed ({reason:?}): {}",
                    result.message.as_deref().unwrap_or("no detail")
                ),
            }
        }
        {
            let mut runtime = lock(&self.context.slot);
            runtime.test_run = None;
            // A canceled test shows nothing: Go Live took its place.
            runtime.test = result.map(|result| CloudTestStatus {
                phase: CloudTestPhase::Done,
                started_at: self.started_at.clone(),
                result: Some(result),
            });
        }
        self.context.hooks.emit_from(&self.context.slot);
    }

    /// The test show, or `None` when the test was canceled. A test still open
    /// on the web (a crashed desktop's) would read as a live show nobody can
    /// see, so it is ended and the create tried once more.
    async fn create(
        &self,
        request: &CreateShowRequest,
    ) -> Option<std::result::Result<CreateShowResponse, CloudApiError>> {
        let mut cancel = self.cancel.clone();
        let first = tokio::select! {
            created = self.context.web.create_show(&self.bearer, request) => created,
            _ = wait_canceled(&mut cancel) => return None,
        };
        match first {
            Err(CloudApiError::ShowLive(Some(live))) if live.is_test() => {
                let _ = self.context.web.end_show(&self.bearer, &live.id).await;
                tokio::select! {
                    created = self.context.web.create_show(&self.bearer, request) => Some(created),
                    _ = wait_canceled(&mut cancel) => None,
                }
            }
            other => Some(other),
        }
    }

    /// `None` when the test was canceled.
    async fn run_inner(&mut self) -> Option<CloudTestResult> {
        // 1. The show: `kind: "test"`, the same outputs a show would carry.
        let request = CreateShowRequest {
            kind: "test".to_string(),
            outputs: self.outputs.clone(),
            hold_max_seconds: self.hold_max_seconds,
            client: client_info(),
        };
        let created = match self.create(&request).await? {
            Ok(created) => created,
            Err(error) => return Some(test_result_from_api_error(error, self.uploads())),
        };
        if let Some(allowance) = created.allowance.clone() {
            lock(&self.context.slot).entitlement.cloud = Some(allowance);
        }
        let show_id = created.show.id.clone();
        // From here the show ends whatever happens below.
        let outcome = self.run_show(&created).await;
        self.set_phase(CloudTestPhase::Ending);
        if let Err(error) = self.context.web.end_show(&self.bearer, &show_id).await {
            tracing::info!(
                "Videorc Cloud test end request failed (the node's cap stands): {error}"
            );
        }
        outcome
    }

    async fn run_show(&mut self, created: &CreateShowResponse) -> Option<CloudTestResult> {
        // 2. The socket, so the runner's own view of the feed is the measure.
        self.set_phase(CloudTestPhase::Connecting);
        let mut cancel = self.cancel.clone();
        let connected = tokio::select! {
            connected = connect_and_hello(self.context.connector.as_ref(), &created.control) => connected,
            _ = wait_canceled(&mut cancel) => return None,
        };
        let (mut transport, welcome) = match connected {
            Ok(connected) => connected,
            Err(failure) => {
                let message = match failure {
                    HelloFailure::BadToken => "the node refused the show token".to_string(),
                    HelloFailure::NoSuchShow => "the node does not know the show".to_string(),
                    HelloFailure::Transport(message) => message,
                };
                return Some(self.failed(CloudTestReason::CantReach, message));
            }
        };

        // 3. The push: one FFmpeg per output, to the ingest of its orientation.
        self.set_phase(CloudTestPhase::Pushing);
        let mut pushes = tokio::task::JoinSet::new();
        for output in &self.outputs {
            let Some(ingest) = created
                .ingest
                .iter()
                .find(|entry| entry.orientation == output.orientation)
            else {
                let _ = transport.close().await;
                return Some(self.failed(
                    CloudTestReason::Failed,
                    format!(
                        "the show has no {} ingest",
                        orientation_id(output.orientation)
                    ),
                ));
            };
            pushes.spawn(self.pusher.push(
                ingest.clone(),
                output.clone(),
                TEST_PUSH_SECONDS,
                self.cancel.clone(),
            ));
        }
        let mut samples: HashMap<String, Vec<u32>> = HashMap::new();
        let mut live_at: Option<tokio::time::Instant> = None;
        let mut observe = |state: &RunnerState| {
            for feed in &state.feeds {
                if feed.connected
                    && let Some(kbps) = feed.kbps
                    && kbps > 0
                {
                    samples
                        .entry(feed.orientation.clone())
                        .or_default()
                        .push(u32::try_from(kbps).unwrap_or(u32::MAX));
                }
            }
            if state.phase == "live" && live_at.is_none() {
                live_at = Some(tokio::time::Instant::now());
            }
        };
        observe(&welcome);
        let mut outcomes: Vec<Result<TestPushOutcome>> = Vec::new();
        let mut ended_by_runner = None;
        let mut canceled = false;
        let mut timed_out = false;
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.tick().await;
        let deadline = tokio::time::sleep(TEST_DEADLINE);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                joined = pushes.join_next() => match joined {
                    Some(joined) => {
                        outcomes.push(joined.unwrap_or_else(|error| Err(anyhow::anyhow!("{error}"))));
                        if pushes.is_empty() {
                            break;
                        }
                    }
                    None => break,
                },
                frame = transport.recv() => match frame {
                    None | Some(ControlFrameIn::Closed { .. }) => {
                        ended_by_runner.get_or_insert_with(|| "the control socket closed".to_string());
                        break;
                    }
                    Some(ControlFrameIn::Text(text)) => {
                        if let Ok(RunnerFrame::State { state } | RunnerFrame::Welcome { state }) =
                            serde_json::from_str::<RunnerFrame>(&text)
                        {
                            observe(&state);
                            if state.phase == "ended" {
                                ended_by_runner = Some(
                                    state.end_reason.clone().unwrap_or_else(|| "ended".to_string()),
                                );
                                break;
                            }
                        }
                    }
                },
                _ = ping.tick() => {
                    let _ = transport.send(json!({ "t": "ping" })).await;
                }
                _ = wait_canceled(&mut cancel) => {
                    canceled = true;
                    break;
                }
                _ = &mut deadline => {
                    timed_out = true;
                    break;
                }
            }
        }
        // Whichever branch broke the loop, a cancel is a cancel: a pusher that
        // saw it first may have ended the loop as the last push.
        let canceled = canceled || *cancel.borrow();
        if canceled {
            // The pushers watch the same cancel: a moment to kill their FFmpeg
            // by its PID and report, before whatever is left is dropped.
            let grace = tokio::time::sleep(Duration::from_secs(5));
            tokio::pin!(grace);
            loop {
                tokio::select! {
                    joined = pushes.join_next() => match joined {
                        Some(joined) => outcomes
                            .push(joined.unwrap_or_else(|error| Err(anyhow::anyhow!("{error}")))),
                        None => break,
                    },
                    _ = &mut grace => break,
                }
            }
        }
        // Whatever is still pushing dies with its future (kill_on_drop).
        pushes.shutdown().await;

        // 4. The show ends on the socket; the web's end follows in the caller.
        let id = new_intent_id();
        if transport.send(intent_frame(&id, "show.end")).await.is_ok() {
            let _ = await_ack(&mut transport, &id, END_ACK_TIMEOUT).await;
        }
        transport.close().await;
        if canceled {
            return None;
        }

        // 5. The verdict.
        Some(test_verdict(TestVerdictInput {
            outputs: &self.outputs,
            samples: &samples,
            outcomes: &outcomes,
            time_to_live_ms: live_at.map(|at| {
                u64::try_from(at.duration_since(self.started).as_millis()).unwrap_or(u64::MAX)
            }),
            ended_by_runner,
            timed_out,
        }))
    }
}

/// Reads frames until the ack for `id` or the timeout; other frames are
/// state and are dropped (the test is over).
async fn await_ack<T: ControlTransport>(
    transport: &mut T,
    id: &str,
    timeout: Duration,
) -> std::result::Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let frame = tokio::time::timeout_at(deadline, transport.recv())
            .await
            .map_err(|_| "the runner did not acknowledge in time".to_string())?;
        match frame {
            None | Some(ControlFrameIn::Closed { .. }) => {
                return Err("the control socket closed".to_string());
            }
            Some(ControlFrameIn::Text(text)) => {
                if let Ok(RunnerFrame::Ack {
                    id: ack_id,
                    ok,
                    error,
                    ..
                }) = serde_json::from_str::<RunnerFrame>(&text)
                    && ack_id == id
                {
                    return if ok {
                        Ok(())
                    } else {
                        Err(error.unwrap_or_else(|| "refused".to_string()))
                    };
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const YOUTUBE_KEY: &str = "ytkey-SECRET-0f3a9b";
    const TWITCH_KEY: &str = "live_12345_SECRETtwitch";
    /// The C1b stream key: the feed's path, the ingest key in its query.
    const INGEST_KEY: &str = "sh_abc-h?key=ingestSECRET";
    /// The show's SRT passphrase (C1b): 32 base62, in every `srt` block.
    const SRT_PASSPHRASE: &str = "srtSECRETpassphrase0123456789abc";
    const TOKEN: &str = "vcs1.eyJ2IjoxfQ.sigSECRET";

    fn destinations() -> Vec<HandoverDestination> {
        vec![
            HandoverDestination {
                id: "youtube-main".to_string(),
                platform: "youtube".to_string(),
                label: "YouTube".to_string(),
                orientation: "horizontal".to_string(),
                url: format!("rtmps://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}"),
            },
            HandoverDestination {
                id: "twitch-main".to_string(),
                platform: "twitch".to_string(),
                label: "Twitch".to_string(),
                orientation: "horizontal".to_string(),
                url: format!("rtmp://live.twitch.tv/app/{TWITCH_KEY}"),
            },
        ]
    }

    fn created() -> CreateShowResponse {
        CreateShowResponse {
            show: ShowRecord {
                id: "sh_abc".to_string(),
                status: "ready".to_string(),
                kind: "solo".to_string(),
                node_id: "eu-hel-1".to_string(),
                created_at: Some("2026-10-16T10:00:00Z".to_string()),
                expires_at: Some("2026-10-16T22:30:00Z".to_string()),
            },
            ingest: vec![ShowIngest {
                orientation: StreamOutputOrientation::Horizontal,
                server_url: "rtmps://eu-hel-1.live.videorc.com:1936/live".to_string(),
                stream_key: INGEST_KEY.to_string(),
            }],
            control: ShowControl {
                url: "wss://eu-hel-1.live.videorc.com:9443/v1/shows/sh_abc/control".to_string(),
                token: TOKEN.to_string(),
            },
            allowance: Some(AiCapabilitiesCloud {
                enabled: true,
                seconds_per_month: 36_000,
                seconds_used: 1_200,
                ..AiCapabilitiesCloud::default()
            }),
        }
    }

    /// C1b (Wire shape, 2026-10-20): the web hands the node's pairs over as
    /// they are, so a create answer carries an `srt` block per pair and the
    /// ingest key in the stream key's query. A desktop that feeds RTMPS reads
    /// that answer, keeps the stream key whole for `{serverUrl}/{streamKey}`,
    /// and its Debug shows neither the key nor the passphrase.
    #[test]
    fn a_c1b_create_answer_parses_and_its_debug_shows_no_secret() {
        let answer: CreateShowResponse = serde_json::from_value(json!({
            "show": {
                "id": "sh_abc", "status": "ready", "kind": "solo", "nodeId": "eu-hel-1",
                "createdAt": "2026-10-20T10:00:00Z", "expiresAt": "2026-10-20T22:30:00Z"
            },
            "ingest": [{
                "orientation": "horizontal",
                "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live",
                "streamKey": INGEST_KEY,
                "srt": {
                    "url": "srt://eu-hel-1.live.videorc.com:8890",
                    "streamId": "publish:live/sh_abc-h",
                    "passphrase": SRT_PASSPHRASE,
                    "latencyMs": 1000
                }
            }],
            "control": {
                "url": "wss://eu-hel-1.live.videorc.com:9443/v1/shows/sh_abc/control",
                "token": TOKEN
            },
            "allowance": { "enabled": true, "secondsPerMonth": 36000, "secondsUsed": 1200 }
        }))
        .expect("a C1b create answer parses");
        assert_eq!(answer.ingest.len(), 1);
        assert_eq!(answer.ingest[0].stream_key, INGEST_KEY);
        let printed = format!("{answer:?}");
        for secret in ["ingestSECRET", SRT_PASSPHRASE, TOKEN] {
            assert!(!printed.contains(secret), "{printed}");
        }
    }

    /// The web as the tests script it.
    #[derive(Default)]
    struct FakeWeb {
        create: StdMutex<Option<std::result::Result<CreateShowResponse, CloudApiError>>>,
        /// Answers for the next creates, before `create` (which repeats).
        create_queue: StdMutex<VecDeque<std::result::Result<CreateShowResponse, CloudApiError>>>,
        current: StdMutex<VecDeque<std::result::Result<CurrentShowResponse, CloudApiError>>>,
        create_calls: AtomicUsize,
        /// The `kind` of every create, in order (C6b sends `test`).
        create_kinds: StdMutex<Vec<String>>,
        end_calls: StdMutex<Vec<String>>,
        current_calls: AtomicUsize,
    }

    impl CloudWebApi for FakeWeb {
        async fn create_show(
            &self,
            _bearer: &str,
            request: &CreateShowRequest,
        ) -> std::result::Result<CreateShowResponse, CloudApiError> {
            self.create_calls.fetch_add(1, Ordering::SeqCst);
            self.create_kinds.lock().unwrap().push(request.kind.clone());
            if let Some(answer) = self.create_queue.lock().unwrap().pop_front() {
                return answer;
            }
            self.create
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(Err(CloudApiError::NodeUnreachable))
        }

        async fn current_show(
            &self,
            _bearer: &str,
        ) -> std::result::Result<CurrentShowResponse, CloudApiError> {
            self.current_calls.fetch_add(1, Ordering::SeqCst);
            self.current
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(CloudApiError::NodeUnreachable))
        }

        async fn end_show(
            &self,
            _bearer: &str,
            show_id: &str,
        ) -> std::result::Result<(), CloudApiError> {
            self.end_calls.lock().unwrap().push(show_id.to_string());
            Ok(())
        }

        async fn allowance(
            &self,
            _bearer: &str,
        ) -> std::result::Result<AiCapabilitiesCloud, CloudApiError> {
            Ok(AiCapabilitiesCloud {
                enabled: true,
                seconds_per_month: 36_000,
                seconds_used: 600,
                ..AiCapabilitiesCloud::default()
            })
        }
    }

    /// The node's end of one faked socket.
    struct FakeServer {
        from_client: mpsc::UnboundedReceiver<Value>,
        to_client: mpsc::UnboundedSender<ControlFrameIn>,
    }

    impl FakeServer {
        async fn next_frame(&mut self) -> Value {
            tokio::time::timeout(Duration::from_secs(30), self.from_client.recv())
                .await
                .expect("a frame from the desktop")
                .expect("the desktop socket is open")
        }

        fn send(&self, frame: Value) {
            self.to_client
                .send(ControlFrameIn::Text(frame.to_string()))
                .unwrap();
        }

        fn drop_socket(self) {
            drop(self.to_client);
        }
    }

    struct FakeTransport {
        to_server: mpsc::UnboundedSender<Value>,
        from_server: mpsc::UnboundedReceiver<ControlFrameIn>,
        sent: Arc<StdMutex<Vec<Value>>>,
    }

    impl ControlTransport for FakeTransport {
        async fn send(&mut self, frame: Value) -> Result<()> {
            self.sent.lock().unwrap().push(frame.clone());
            self.to_server
                .send(frame)
                .map_err(|_| anyhow::anyhow!("socket closed"))
        }

        async fn recv(&mut self) -> Option<ControlFrameIn> {
            self.from_server.recv().await
        }

        async fn close(&mut self) {}
    }

    #[derive(Default)]
    struct FakeConnector {
        servers: Arc<StdMutex<VecDeque<FakeServer>>>,
        /// Every frame any transport ever sent: the leak audit reads it.
        sent: Arc<StdMutex<Vec<Value>>>,
        connects: AtomicUsize,
        refuse_next: StdMutex<VecDeque<Option<u16>>>,
    }

    impl ControlConnector for FakeConnector {
        type Transport = FakeTransport;

        async fn connect(&self, _url: &str) -> Result<FakeTransport> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            let (to_server, from_client) = mpsc::unbounded_channel();
            let (to_client, from_server) = mpsc::unbounded_channel();
            if let Some(refusal) = self.refuse_next.lock().unwrap().pop_front() {
                match refusal {
                    Some(code) => {
                        to_client
                            .send(ControlFrameIn::Closed { code: Some(code) })
                            .unwrap();
                    }
                    None => bail!("connection refused"),
                }
            }
            self.servers.lock().unwrap().push_back(FakeServer {
                from_client,
                to_client,
            });
            Ok(FakeTransport {
                to_server,
                from_server,
                sent: self.sent.clone(),
            })
        }
    }

    impl FakeConnector {
        async fn accept(&self) -> FakeServer {
            for _ in 0..10_000 {
                if let Some(server) = self.servers.lock().unwrap().pop_front() {
                    return server;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            panic!("the desktop never connected");
        }
    }

    struct Harness {
        context: CloudShowContext<FakeWeb, FakeConnector>,
        emitted: Arc<StdMutex<Vec<CloudStatus>>>,
        legs: Arc<StdMutex<Vec<(String, Vec<StreamTargetRuntime>)>>>,
    }

    fn harness(entitled: bool) -> Harness {
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let legs = Arc::new(StdMutex::new(Vec::new()));
        let hooks = CloudHooks {
            emit: {
                let emitted = emitted.clone();
                Arc::new(move |status| emitted.lock().unwrap().push(status))
            },
            legs: {
                let legs = legs.clone();
                Arc::new(move |session: &str, runtime| {
                    legs.lock().unwrap().push((session.to_string(), runtime))
                })
            },
        };
        let slot = new_cloud_show_slot(CloudSettings::default());
        if entitled {
            lock(&slot).entitlement = CloudEntitlement {
                plan: Some(EntitlementPlan::Max),
                cloud: Some(AiCapabilitiesCloud {
                    enabled: true,
                    seconds_per_month: 360_000,
                    seconds_used: 1000,
                    ..AiCapabilitiesCloud::default()
                }),
            };
        }
        Harness {
            context: CloudShowContext {
                slot,
                hooks,
                web: Arc::new(FakeWeb::default()),
                connector: Arc::new(FakeConnector::default()),
            },
            emitted,
            legs,
        }
    }

    fn welcome(phase: &str) -> Value {
        json!({ "t": "welcome", "state": { "phase": phase, "liveSeconds": 0, "feeds": [], "legs": [] } })
    }

    fn ack(id: &Value) -> Value {
        json!({ "t": "ack", "id": id, "ok": true })
    }

    /// The runner's legs for `destinations()`, both live.
    fn live_legs() -> Value {
        json!([
            { "id": "youtube-main", "platform": "youtube", "label": "YouTube", "orientation": "horizontal", "state": "live" },
            { "id": "twitch-main", "platform": "twitch", "label": "Twitch", "orientation": "horizontal", "state": "live" }
        ])
    }

    /// A reconnect to the same runner: it still holds its legs.
    fn welcome_with_legs(phase: &str) -> Value {
        json!({ "t": "welcome", "state": { "phase": phase, "liveSeconds": 0, "feeds": [], "legs": live_legs() } })
    }

    /// Go Live through the cloud up to the runner live with both legs, and
    /// the node's end of the socket.
    async fn live_show(harness: &Harness) -> FakeServer {
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-1",
                    Some("bearer".to_string()),
                    vec![ShowOutputSpec {
                        orientation: StreamOutputOrientation::Horizontal,
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        video_kbps: 6000,
                        audio_kbps: 160,
                    }],
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        assert_eq!(server.next_frame().await["t"], "hello");
        server.send(welcome("starting"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        server.send(ack(&set["id"]));
        assert!(matches!(
            prepare.await.unwrap().unwrap(),
            PrepareOutcome::Cloud(_)
        ));
        server.send(json!({ "t": "state", "state": {
            "phase": "live", "liveSeconds": 3, "feeds": [], "legs": live_legs()
        }}));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;
        server
    }

    /// Polls in 1 ms steps of paused time, so backoff timers run as needed.
    async fn wait_until(mut done: impl FnMut() -> bool) {
        for _ in 0..30_000 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the condition never held in 30 s of paused time");
    }

    async fn wait_for_phase(slot: &CloudShowSlot, phase: CloudPhase) {
        for _ in 0..10_000 {
            if lock(slot).phase() == phase {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("phase never became {phase:?}, is {:?}", lock(slot).phase());
    }

    #[test]
    fn settings_default_to_on_with_a_30_minute_hold_and_validate_the_choices() {
        let settings = CloudSettings::default();
        assert_eq!(settings.enabled, None);
        assert!(settings.switch_on());
        assert_eq!(settings.hold_max_seconds, 1800);
        assert_eq!(HOLD_MAX_CHOICES, [300, 900, 1800, 3600]);
        // A stored value outside the choices reads as the default.
        let odd = CloudSettings {
            hold_max_seconds: 1234,
            ..CloudSettings::default()
        }
        .normalized();
        assert_eq!(odd.hold_max_seconds, 1800);
        let mut settings = CloudSettings::default();
        assert!(
            settings
                .apply(&CloudSettingsPatch {
                    hold_max_seconds: Some(1000),
                    ..CloudSettingsPatch::default()
                })
                .is_err()
        );
        settings
            .apply(&CloudSettingsPatch {
                enabled: Some(false),
                hold_max_seconds: Some(900),
                hold_image_screen_id: Some(Some(" screen-1 ".to_string())),
            })
            .unwrap();
        assert_eq!(settings.enabled, Some(false));
        assert!(!settings.switch_on());
        assert_eq!(settings.hold_max_seconds, 900);
        assert_eq!(settings.hold_image_screen_id.as_deref(), Some("screen-1"));
        // `null` clears the image; an absent key leaves it.
        let patch: CloudSettingsPatch =
            serde_json::from_str(r#"{"holdImageScreenId":null}"#).unwrap();
        assert_eq!(patch.hold_image_screen_id, Some(None));
        settings.apply(&patch).unwrap();
        assert_eq!(settings.hold_image_screen_id, None);
        let patch: CloudSettingsPatch = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(patch.hold_image_screen_id, None);
        // Persisted JSON never carries a null (the serde-null trap).
        let value = serde_json::to_value(&CloudSettings::default()).unwrap();
        assert_eq!(value, json!({ "holdMaxSeconds": 1800 }));
    }

    fn high_risk_fixture(pointer: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("the shared protocol fixture is valid JSON");
        fixture
            .pointer(pointer)
            .unwrap_or_else(|| panic!("the shared protocol fixture is missing {pointer}"))
            .clone()
    }

    // The `cloud.state` event and every `cloud.*` answer: the TypeScript
    // strict schema validates the same JSON (protocol-contract-fixtures.test.ts),
    // so a renamed field or a `null` where the schema says absent fails here
    // first (the serde-null trap).
    #[test]
    fn shared_high_risk_contract_fixture_matches_the_cloud_status() {
        for pointer in [
            "/cloud/statusHold",
            "/cloud/statusOff",
            "/cloud/statusFallback",
            "/cloud/statusTest",
        ] {
            let wire = high_risk_fixture(pointer);
            let status: CloudStatus = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(status).unwrap(), wire, "{pointer}");
        }
        let patch: CloudSettingsPatch =
            serde_json::from_value(high_risk_fixture("/cloud/settingsPatch")).unwrap();
        assert_eq!(patch.enabled, Some(false));
        assert_eq!(patch.hold_max_seconds, Some(900));
        assert_eq!(patch.hold_image_screen_id, Some(None));
        // What the runtime emits for an untouched slot is the statusOff shape.
        assert_eq!(
            serde_json::to_value(CloudShowRuntime::default().status()).unwrap(),
            high_risk_fixture("/cloud/statusOff")
        );
        // C6b: the renderer's `cloud.selftest.run` params parse into the outputs
        // the show is created with (the audio rate is the feed's, added later).
        let params: CloudTestParams =
            serde_json::from_value(high_risk_fixture("/cloud/testRunParams")).unwrap();
        assert_eq!(params.outputs.len(), 1);
        assert_eq!(params.outputs[0].video_kbps, 6000);
        assert_eq!(params.ffmpeg_path, None);
    }

    #[test]
    fn go_live_decision_follows_the_switch_the_entitlement_and_the_hours() {
        let mut runtime = CloudShowRuntime::default();
        // Default on, but no cloud block (Basic, an older web): direct and
        // silent, because nobody expected the cloud.
        assert_eq!(
            decide_go_live(&runtime, true),
            GoLiveDecision::DirectByChoice
        );
        // A Premium account during the rollout: the block says not enabled.
        runtime.entitlement.cloud = Some(AiCapabilitiesCloud {
            enabled: false,
            seconds_per_month: 36_000,
            ..AiCapabilitiesCloud::default()
        });
        assert_eq!(
            decide_go_live(&runtime, true),
            GoLiveDecision::DirectByChoice
        );
        runtime.entitlement.cloud = Some(AiCapabilitiesCloud {
            enabled: true,
            seconds_per_month: 36_000,
            seconds_used: 35_800,
            ..AiCapabilitiesCloud::default()
        });
        // 200 s left is under the 5-minute floor (D18).
        assert_eq!(
            decide_go_live(&runtime, true),
            GoLiveDecision::DirectWithReason(CloudFallbackReason::CloudHoursUsedUp)
        );
        runtime.entitlement.cloud.as_mut().unwrap().seconds_used = 35_700;
        assert_eq!(decide_go_live(&runtime, true), GoLiveDecision::Cloud);
        // Signed out: nothing vouches for the account, and nothing is said.
        assert_eq!(
            decide_go_live(&runtime, false),
            GoLiveDecision::DirectByChoice
        );
        // The user's switch wins silently.
        runtime.settings.enabled = Some(false);
        assert_eq!(
            decide_go_live(&runtime, true),
            GoLiveDecision::DirectByChoice
        );
        assert!(!runtime.cloud_mode_on());
    }

    #[test]
    fn a_relaunch_looks_for_a_live_show_whenever_the_account_could_own_one() {
        let mut runtime = CloudShowRuntime::default();
        // Basic, or signed out: no request at all.
        assert!(!runtime.may_own_a_show());
        // The rollback switch off: the block says not enabled, the plan stays.
        runtime.entitlement = CloudEntitlement {
            plan: Some(EntitlementPlan::Max),
            cloud: Some(AiCapabilitiesCloud {
                enabled: false,
                ..AiCapabilitiesCloud::default()
            }),
        };
        assert!(runtime.may_own_a_show());
        runtime.entitlement.cloud.as_mut().unwrap().enabled = true;
        assert!(runtime.may_own_a_show());
    }

    #[test]
    fn web_failures_map_onto_the_one_toast_reason() {
        let classify =
            |status, code| classify_cloud_failure(status, code, "m".to_string(), None, None);
        assert_eq!(classify(401, "x"), CloudApiError::Unauthorized);
        assert_eq!(
            classify(403, "cloud-not-entitled"),
            CloudApiError::NotEntitled
        );
        assert_eq!(
            classify(409, "cloud-show-live"),
            CloudApiError::ShowLive(None)
        );
        assert_eq!(
            classify(429, "cloud-hours-used-up"),
            CloudApiError::HoursUsedUp { reset_at: None }
        );
        assert_eq!(classify(503, "cloud-disabled"), CloudApiError::Disabled);
        assert_eq!(classify(503, "cloud-full"), CloudApiError::Full);
        assert_eq!(
            classify(503, "cloud-node-unreachable"),
            CloudApiError::NodeUnreachable
        );
        assert_eq!(
            classify(403, "cloud-not-entitled").fallback_reason(),
            Some(CloudFallbackReason::NotEntitled)
        );
        assert_eq!(
            classify(429, "cloud-hours-used-up").fallback_reason(),
            Some(CloudFallbackReason::CloudHoursUsedUp)
        );
        assert_eq!(
            classify(503, "cloud-disabled").fallback_reason(),
            Some(CloudFallbackReason::CloudDisabled)
        );
        assert_eq!(
            classify(503, "cloud-full").fallback_reason(),
            Some(CloudFallbackReason::CloudFull)
        );
        assert_eq!(
            classify(503, "cloud-node-unreachable").fallback_reason(),
            Some(CloudFallbackReason::CloudNodeUnreachable)
        );
        assert_eq!(
            classify(502, "bad-gateway").fallback_reason(),
            Some(CloudFallbackReason::CloudNodeUnreachable)
        );
        // Sign in and "a show is live" are errors to show, never a fallback.
        assert_eq!(classify(401, "x").fallback_reason(), None);
        assert_eq!(classify(409, "cloud-show-live").fallback_reason(), None);
        assert_eq!(classify(400, "bad-request").fallback_reason(), None);
        for reason in [
            CloudFallbackReason::CloudDisabled,
            CloudFallbackReason::CloudFull,
            CloudFallbackReason::CloudHoursUsedUp,
            CloudFallbackReason::CloudNodeUnreachable,
            CloudFallbackReason::NotEntitled,
        ] {
            let wire = serde_json::to_value(reason).unwrap();
            assert!(
                matches!(
                    wire.as_str(),
                    Some(
                        "cloud-disabled"
                            | "cloud-full"
                            | "cloud-hours-used-up"
                            | "cloud-node-unreachable"
                            | "not-entitled"
                    )
                ),
                "{wire}"
            );
        }
    }

    #[test]
    fn runner_legs_map_into_the_leg_model_and_unknown_values_stay_safe() {
        let leg: RunnerLeg = serde_json::from_value(json!({
            "id": "youtube-main", "platform": "youtube", "label": "YouTube",
            "orientation": "horizontal", "state": "reconnecting", "since": "2026-10-16T10:00:00Z",
            "error": "EOF from ingest"
        }))
        .unwrap();
        let runtime = runner_leg_to_runtime(&leg);
        assert_eq!(runtime.target_id, "youtube-main");
        assert_eq!(runtime.platform, StreamPlatform::Youtube);
        assert_eq!(runtime.state, StreamTargetState::Reconnecting);
        assert_eq!(runtime.message.as_deref(), Some("EOF from ingest"));
        assert_eq!(runtime.redacted_url, None);
        for (wire, expected) in [
            ("connecting", StreamTargetState::Connecting),
            ("live", StreamTargetState::Live),
            ("failed", StreamTargetState::Failed),
            ("ended", StreamTargetState::Stopped),
            ("something-new", StreamTargetState::Warning),
        ] {
            let leg = RunnerLeg {
                state: wire.to_string(),
                ..RunnerLeg::default()
            };
            assert_eq!(runner_leg_to_runtime(&leg).state, expected, "{wire}");
        }
        let unknown_platform = RunnerLeg {
            platform: "mastodon-live".to_string(),
            ..RunnerLeg::default()
        };
        assert_eq!(
            runner_leg_to_runtime(&unknown_platform).platform,
            StreamPlatform::Custom
        );
        // A runner one release ahead: unknown frames and phases never break.
        let frame: RunnerFrame = serde_json::from_str(r#"{"t":"metrics","cpu":0.4}"#).unwrap();
        assert!(matches!(frame, RunnerFrame::Unknown));
        let state: RunnerState =
            serde_json::from_str(r#"{"phase":"warming","newField":1}"#).unwrap();
        assert_eq!(state.phase, "warming");
    }

    // Lane 5 S5: the control socket carries the token and every key, so a
    // release build refuses a node without TLS. Dev builds keep `ws://` for
    // the local agent the smokes run.
    #[test]
    fn a_release_build_speaks_to_a_node_over_tls_only() {
        let wss = "wss://eu-hel-1.live.videorc.com:9443/v1/shows/sh_abc/control";
        assert_eq!(control_url_problem(wss, false), None);
        assert_eq!(control_url_problem(wss, true), None);
        for refused in [
            "ws://eu-hel-1.live.videorc.com:9443/v1/shows/sh_abc/control",
            "ws://127.0.0.1:9443/v1/shows/sh_abc/control",
            "https://eu-hel-1.live.videorc.com/v1/shows/sh_abc/control",
            "not a url",
        ] {
            assert!(control_url_problem(refused, false).is_some(), "{refused}");
        }
        assert_eq!(
            control_url_problem("ws://127.0.0.1:9443/v1/shows/sh_abc/control", true),
            None
        );
        assert!(control_url_problem("http://127.0.0.1:9443/x", true).is_some());
        assert!(
            !control_url_problem("ws://x/y", false)
                .unwrap()
                .contains("ws://")
        );
    }

    // The ingest is checked before the socket opens: a node this computer
    // can't feed securely never receives a key, so direct is safe.
    #[tokio::test(start_paused = true)]
    async fn an_ingest_this_computer_cannot_feed_streams_directly_before_any_key_leaves() {
        let harness = harness(true);
        let mut bad = created();
        bad.ingest[0].server_url = "not a url".to_string();
        *harness.context.web.create.lock().unwrap() = Some(Ok(bad));
        let outcome = harness
            .context
            .prepare_session(
                "session-1",
                Some("bearer".to_string()),
                Vec::new(),
                destinations(),
                None,
            )
            .await
            .unwrap();
        assert!(matches!(outcome, PrepareOutcome::Direct));
        assert_eq!(harness.context.connector.connects.load(Ordering::SeqCst), 0);
        assert!(harness.context.connector.sent.lock().unwrap().is_empty());
        assert_eq!(
            *harness.context.web.end_calls.lock().unwrap(),
            vec!["sh_abc".to_string()]
        );
        let status = lock(&harness.context.slot).status();
        assert_eq!(
            status.fallback.map(|fallback| fallback.reason),
            Some(CloudFallbackReason::CloudNodeUnreachable)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_goes_live_through_the_cloud_holds_reconnects_and_ends() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-1",
                    Some("bearer".to_string()),
                    vec![ShowOutputSpec {
                        orientation: StreamOutputOrientation::Horizontal,
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        video_kbps: 6000,
                        audio_kbps: 160,
                    }],
                    destinations(),
                    Some("iVBORw0KGgo=".to_string()),
                )
                .await
        });

        // 1. hello carries the show token; welcome puts the show in Connecting.
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        assert_eq!(hello["token"], TOKEN);
        assert_eq!(hello["client"]["app"], "desktop");
        server.send(welcome("starting"));

        // 2. The hand-over: destinations.set with the plain urls, then the
        //    hold image; the start returns only after the ack.
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        assert_eq!(set["destinations"][0]["id"], "youtube-main");
        assert_eq!(set["destinations"][0]["platform"], "youtube");
        assert_eq!(
            set["destinations"][0]["url"],
            format!("rtmps://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}")
        );
        assert_eq!(set["destinations"][1]["id"], "twitch-main");
        server.send(ack(&set["id"]));
        let hold_image = server.next_frame().await;
        assert_eq!(hold_image["kind"], "hold.image.set");
        assert_eq!(hold_image["pngBase64"], "iVBORw0KGgo=");
        server.send(ack(&hold_image["id"]));
        let outcome = prepare.await.unwrap().unwrap();
        let PrepareOutcome::Cloud(handover) = outcome else {
            panic!("expected a cloud hand-over");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(handover.ingest[0].stream_key, INGEST_KEY);
        assert_eq!(
            handover.ingest[0].server_url,
            "rtmps://eu-hel-1.live.videorc.com:1936/live"
        );
        assert_eq!(harness.context.web.create_calls.load(Ordering::SeqCst), 1);
        {
            let status = lock(&harness.context.slot).status();
            assert_eq!(status.phase, CloudPhase::Connecting);
            assert_eq!(status.session_id.as_deref(), Some("session-1"));
            assert_eq!(status.show.as_ref().unwrap().id, "sh_abc");
            assert!(!status.show.as_ref().unwrap().resumable);
            assert!(status.connected);
            // The create answer's allowance replaced the cached one.
            assert_eq!(status.allowance.as_ref().unwrap().seconds_used, 1_200);
        }

        // 3. The runner goes live: Live, and the legs reach the session's model.
        server.send(json!({ "t": "state", "state": {
            "phase": "live", "liveSeconds": 3,
            "feeds": [{ "orientation": "horizontal", "connected": true, "kbps": 5900 }],
            "legs": [
                { "id": "youtube-main", "platform": "youtube", "label": "YouTube", "orientation": "horizontal", "state": "live" },
                { "id": "twitch-main", "platform": "twitch", "label": "Twitch", "orientation": "horizontal", "state": "connecting" }
            ]
        }}));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;
        {
            let legs = harness.legs.lock().unwrap();
            let (session, runtime) = legs.last().expect("legs reached the session");
            assert_eq!(session, "session-1");
            assert_eq!(runtime[0].target_id, "youtube-main");
            assert_eq!(runtime[0].state, StreamTargetState::Live);
            assert_eq!(runtime[1].state, StreamTargetState::Connecting);
        }
        let status = lock(&harness.context.slot).status();
        assert_eq!(status.feeds[0].kbps, Some(5900));
        assert_eq!(status.live_seconds, Some(3));

        // 4. The desktop pings every 5 s.
        tokio::time::advance(Duration::from_millis(5_100)).await;
        let ping = server.next_frame().await;
        assert_eq!(ping["t"], "ping");
        server.send(json!({ "t": "pong" }));

        // 5. The feed drops: the runner holds, its legs stay up. The desktop
        //    shows Hold.
        server.send(json!({ "t": "state", "state": {
            "phase": "hold", "liveSeconds": 40,
            "hold": { "active": true, "since": "2026-10-16T10:01:00Z", "reason": "feed-lost", "remainingSeconds": 1790 },
            "feeds": [{ "orientation": "horizontal", "connected": false }], "legs": live_legs()
        }}));
        wait_for_phase(&harness.context.slot, CloudPhase::Hold).await;
        let status = lock(&harness.context.slot).status();
        assert_eq!(status.hold.as_ref().unwrap().remaining_seconds, Some(1790));
        assert_eq!(
            status.hold.as_ref().unwrap().reason.as_deref(),
            Some("feed-lost")
        );

        // 6. The socket drops: Connecting, never Failed, and no direct legs.
        //    The reconnect says hello again and the show carries on.
        server.drop_socket();
        wait_for_phase(&harness.context.slot, CloudPhase::Connecting).await;
        assert!(
            !lock(&harness.context.slot)
                .status()
                .direct_fallback_available
        );
        tokio::time::advance(Duration::from_millis(1_100)).await;
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome_with_legs("live"));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;
        assert_eq!(harness.context.connector.connects.load(Ordering::SeqCst), 2);
        // The same runner: nothing is handed over again.
        assert_eq!(lock(&harness.context.slot).status().restart, None);
        // The web was never asked: one dropped socket is not a lost show.
        assert_eq!(harness.context.web.current_calls.load(Ordering::SeqCst), 0);

        // 7. Stop: show.end on the socket, POST end on the web, then Off.
        let context = harness.context.clone();
        let stop = tokio::spawn(async move {
            context
                .on_session_stopped("session-1", Some("bearer".to_string()))
                .await
        });
        let end = server.next_frame().await;
        assert_eq!(end["kind"], "show.end");
        server.send(ack(&end["id"]));
        stop.await.unwrap();
        let status = lock(&harness.context.slot).status();
        assert_eq!(status.phase, CloudPhase::Off);
        assert_eq!(status.show, None);
        assert_eq!(status.end_reason.as_deref(), Some("ended-by-host"));
        assert_eq!(
            *harness.context.web.end_calls.lock().unwrap(),
            vec!["sh_abc".to_string()]
        );
        let phases: Vec<CloudPhase> = harness
            .emitted
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.phase)
            .collect();
        assert!(phases.contains(&CloudPhase::Connecting));
        assert!(phases.contains(&CloudPhase::Live));
        assert!(phases.contains(&CloudPhase::Hold));
        assert!(phases.contains(&CloudPhase::Ending));
        assert_eq!(phases.last(), Some(&CloudPhase::Off));
    }

    // Plan 184 "When things break": the runner crashes, the agent restarts it,
    // and it resumes in hold without destinations (they live in memory only).
    // The desktop sends them again on the new socket, the rows show
    // Reconnecting, and the host reads "Videorc Cloud restarted your show".
    #[tokio::test(start_paused = true)]
    async fn a_restarted_runner_gets_the_destinations_again_and_the_host_is_told() {
        let harness = harness(true);
        let server = live_show(&harness).await;
        server.drop_socket();
        wait_for_phase(&harness.context.slot, CloudPhase::Connecting).await;
        tokio::time::advance(Duration::from_millis(1_100)).await;

        // The restarted runner: hold, no legs.
        let mut server = harness.context.connector.accept().await;
        assert_eq!(server.next_frame().await["t"], "hello");
        server.send(json!({ "t": "welcome", "state": {
            "phase": "hold", "liveSeconds": 38,
            "hold": { "active": true, "reason": "feed-lost" }, "feeds": [], "legs": []
        }}));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        assert_eq!(set["destinations"][0]["id"], "youtube-main");
        assert_eq!(
            set["destinations"][0]["url"],
            format!("rtmps://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}")
        );
        assert_eq!(set["destinations"][1]["id"], "twitch-main");
        server.send(ack(&set["id"]));
        {
            let status = lock(&harness.context.slot).status();
            let restart = status.restart.expect("the restart is reported");
            assert!(restart.destinations_resent);
            // The show carries on: never Failed, never direct.
            assert_eq!(status.phase, CloudPhase::Hold);
            assert!(!status.direct_fallback_available);
            // The old rows no longer read live.
            let legs = harness.legs.lock().unwrap();
            let (session, rows) = legs.last().unwrap();
            assert_eq!(session, "session-1");
            assert_eq!(rows.len(), 2);
            assert!(
                rows.iter()
                    .all(|row| row.state == StreamTargetState::Reconnecting)
            );
            assert_eq!(rows[0].target_id, "youtube-main");
            assert_eq!(rows[0].platform, StreamPlatform::Youtube);
        }
        // Once per socket: another empty state sends nothing more.
        server.send(json!({ "t": "state", "state": {
            "phase": "hold", "liveSeconds": 39, "feeds": [], "legs": []
        }}));
        tokio::time::advance(Duration::from_millis(5_100)).await;
        assert_eq!(server.next_frame().await["t"], "ping");

        // The legs come back: their own states reach the session again.
        server.send(json!({ "t": "state", "state": {
            "phase": "live", "liveSeconds": 42, "feeds": [], "legs": live_legs()
        }}));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;
        let rows = harness.legs.lock().unwrap().last().unwrap().1.clone();
        assert!(rows.iter().all(|row| row.state == StreamTargetState::Live));
        assert_eq!(harness.context.web.create_calls.load(Ordering::SeqCst), 1);
        // The restart frame went to the node only, never to the renderer.
        let emitted = serde_json::to_string(&*harness.emitted.lock().unwrap()).unwrap();
        assert!(!emitted.contains(YOUTUBE_KEY) && !emitted.contains(TWITCH_KEY));
    }

    // C-C3: the agent hands a restarted runner its destinations itself; the
    // desktop only tells the host, and sends nothing.
    #[tokio::test(start_paused = true)]
    async fn a_runner_the_node_restarted_with_its_destinations_is_only_reported() {
        let harness = harness(true);
        let server = live_show(&harness).await;
        server.send(json!({ "t": "state", "state": {
            "phase": "live", "liveSeconds": 4, "feeds": [], "legs": live_legs(),
            "destinationsSet": true, "restarts": 0
        }}));
        wait_until(|| {
            lock(&harness.context.slot)
                .runner
                .as_ref()
                .is_some_and(|runner| runner.restarts == Some(0))
        })
        .await;
        server.drop_socket();
        tokio::time::advance(Duration::from_millis(1_100)).await;
        let mut server = harness.context.connector.accept().await;
        assert_eq!(server.next_frame().await["t"], "hello");
        server.send(json!({ "t": "welcome", "state": {
            "phase": "hold", "liveSeconds": 30, "feeds": [], "legs": live_legs(),
            "destinationsSet": true, "restarts": 1
        }}));
        wait_until(|| lock(&harness.context.slot).status().restart.is_some()).await;
        assert!(
            lock(&harness.context.slot)
                .status()
                .restart
                .unwrap()
                .destinations_resent
        );
        tokio::time::advance(Duration::from_millis(5_100)).await;
        assert_eq!(server.next_frame().await["t"], "ping");
    }

    #[tokio::test(start_paused = true)]
    async fn a_restarted_runner_that_refuses_the_destinations_is_reported_unrecovered() {
        let harness = harness(true);
        let server = live_show(&harness).await;
        server.drop_socket();
        tokio::time::advance(Duration::from_millis(1_100)).await;
        let mut server = harness.context.connector.accept().await;
        assert_eq!(server.next_frame().await["t"], "hello");
        server.send(welcome("hold"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        let first_at = lock(&harness.context.slot).status().restart.unwrap().at;
        // The socket drops before the ack: the next socket sends them again,
        // under the same restart.
        server.drop_socket();
        tokio::time::advance(Duration::from_millis(1_100)).await;
        let mut server = harness.context.connector.accept().await;
        assert_eq!(server.next_frame().await["t"], "hello");
        server.send(welcome("hold"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        let restart = lock(&harness.context.slot).status().restart.unwrap();
        assert_eq!(restart.at, first_at);
        assert!(restart.destinations_resent);
        server.send(json!({ "t": "ack", "id": set["id"], "ok": false, "error": "bad url" }));
        wait_until(|| {
            lock(&harness.context.slot)
                .status()
                .restart
                .is_some_and(|restart| !restart.destinations_resent)
        })
        .await;
        // Still the show, still not a fallback: only the web may say it's gone.
        assert_ne!(lock(&harness.context.slot).phase(), CloudPhase::Failed);
    }

    #[test]
    fn a_restart_is_a_runner_that_lost_its_destinations_or_says_it_restarted() {
        let show = |handed_over: bool, destinations: Vec<HandoverDestination>| ActiveShow {
            record: created().show,
            control: created().control,
            ingest: None,
            session_id: Some("session-1".to_string()),
            destinations,
            handed_over,
            resuming: false,
        };
        let state = |value: Value| -> RunnerState { serde_json::from_value(value).unwrap() };
        let had = state(json!({ "phase": "live", "legs": live_legs() }));
        let handed = show(true, destinations());
        // Before the hand-over's ack the runner has no legs yet: not a restart.
        assert_eq!(
            detect_runner_restart(
                &show(false, destinations()),
                None,
                &state(json!({ "phase": "hold", "legs": [] }))
            ),
            None
        );
        // Legs listed, or the show ended: nothing to do.
        assert_eq!(detect_runner_restart(&handed, Some(&had), &had), None);
        assert_eq!(
            detect_runner_restart(
                &handed,
                Some(&had),
                &state(json!({ "phase": "ended", "legs": [] }))
            ),
            None
        );
        // An older runner: legs gone after the hand-over means send them again.
        assert_eq!(
            detect_runner_restart(
                &handed,
                None,
                &state(json!({ "phase": "hold", "legs": [] }))
            ),
            Some(RunnerRestart::Resend(destinations()))
        );
        // The runner says it has none (C-C3), whatever its legs list.
        assert_eq!(
            detect_runner_restart(
                &handed,
                Some(&had),
                &state(
                    json!({ "phase": "hold", "legs": [], "destinationsSet": false, "restarts": 1 })
                )
            ),
            Some(RunnerRestart::Resend(destinations()))
        );
        // The node gave them back itself: say it restarted, send nothing.
        let before = state(
            json!({ "phase": "live", "legs": live_legs(), "destinationsSet": true, "restarts": 0 }),
        );
        let after = state(
            json!({ "phase": "hold", "legs": live_legs(), "destinationsSet": true, "restarts": 1 }),
        );
        assert_eq!(
            detect_runner_restart(&handed, Some(&before), &after),
            Some(RunnerRestart::Recovered)
        );
        assert_eq!(detect_runner_restart(&handed, Some(&after), &after), None);
        // A first welcome that already counts a restart (it happened while
        // this computer was away) is not news.
        assert_eq!(detect_runner_restart(&handed, None, &after), None);
        // A show resumed after a relaunch holds no keys (C5b): it can only
        // say so, on the rows the runner had.
        let resumed = show(false, Vec::new());
        assert_eq!(
            detect_runner_restart(
                &resumed,
                Some(&had),
                &state(json!({ "phase": "hold", "legs": [] }))
            ),
            Some(RunnerRestart::CannotResend)
        );
        assert_eq!(
            detect_runner_restart(
                &resumed,
                Some(&before),
                &state(
                    json!({ "phase": "hold", "legs": [], "destinationsSet": false, "restarts": 1 })
                )
            ),
            Some(RunnerRestart::CannotResend)
        );
        assert_eq!(
            detect_runner_restart(
                &resumed,
                None,
                &state(json!({ "phase": "hold", "legs": [] }))
            ),
            None
        );
        let rows = restart_leg_rows(&RunnerRestart::CannotResend, &had.legs).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|row| row.state == StreamTargetState::Failed)
        );
        assert!(
            rows[0]
                .message
                .as_deref()
                .unwrap()
                .contains("go live again")
        );
        assert_eq!(restart_leg_rows(&RunnerRestart::Recovered, &had.legs), None);
    }

    #[tokio::test(start_paused = true)]
    async fn direct_legs_may_reopen_only_after_the_web_confirms_the_show_gone() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-2",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("live"));
        let set = server.next_frame().await;
        server.send(ack(&set["id"]));
        assert!(matches!(
            prepare.await.unwrap().unwrap(),
            PrepareOutcome::Cloud(_)
        ));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;

        // The node is gone: every reconnect is refused. The first failure
        // asks nobody; from the second on the web is asked, and while the
        // web is unreachable the show stays (Connecting), never Failed.
        server.drop_socket();
        harness
            .context
            .connector
            .refuse_next
            .lock()
            .unwrap()
            .extend([None, None, None]);
        wait_for_phase(&harness.context.slot, CloudPhase::Connecting).await;
        // Attempt 0 (after 1 s) asks nobody; attempt 1 (2 s later) asks the
        // web. Waiting on the call itself keeps this free of timer races.
        wait_until(|| harness.context.web.current_calls.load(Ordering::SeqCst) >= 1).await;
        assert_eq!(lock(&harness.context.slot).phase(), CloudPhase::Connecting);
        assert!(
            !lock(&harness.context.slot)
                .status()
                .direct_fallback_available
        );

        // The web answers: no current show. Now, and only now, Failed with
        // the direct fallback offered.
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse::default()));
        wait_for_phase(&harness.context.slot, CloudPhase::Failed).await;
        let status = lock(&harness.context.slot).status();
        assert!(status.direct_fallback_available);
        assert_eq!(status.end_reason.as_deref(), Some("show-gone"));
        assert_eq!(status.show, None);
        assert!(status.message.is_some());

        // The stop settles the failure: Off, nothing to end on the web.
        harness
            .context
            .on_session_stopped("session-2", Some("bearer".to_string()))
            .await;
        assert_eq!(lock(&harness.context.slot).phase(), CloudPhase::Off);
        assert!(harness.context.web.end_calls.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreachable_node_ends_the_show_and_streams_directly_with_one_reason() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        harness
            .context
            .connector
            .refuse_next
            .lock()
            .unwrap()
            .push_back(None);
        let outcome = harness
            .context
            .prepare_session(
                "session-3",
                Some("bearer".to_string()),
                Vec::new(),
                destinations(),
                None,
            )
            .await
            .unwrap();
        assert!(matches!(outcome, PrepareOutcome::Direct));
        let status = lock(&harness.context.slot).status();
        assert_eq!(status.phase, CloudPhase::Off);
        let fallback = status.fallback.expect("one reason");
        assert_eq!(fallback.reason, CloudFallbackReason::CloudNodeUnreachable);
        assert_eq!(fallback.session_id, "session-3");
        // The created show is ended on the web so no runner waits for a feed.
        assert_eq!(
            *harness.context.web.end_calls.lock().unwrap(),
            vec!["sh_abc".to_string()]
        );

        // The web's own refusals: cloud-full is direct with its reason; a
        // sign-in problem is an error, never a silent direct.
        *harness.context.web.create.lock().unwrap() = Some(Err(CloudApiError::Full));
        let outcome = harness
            .context
            .prepare_session(
                "session-4",
                Some("bearer".to_string()),
                Vec::new(),
                destinations(),
                None,
            )
            .await
            .unwrap();
        assert!(matches!(outcome, PrepareOutcome::Direct));
        assert_eq!(
            lock(&harness.context.slot)
                .status()
                .fallback
                .unwrap()
                .reason,
            CloudFallbackReason::CloudFull
        );
        *harness.context.web.create.lock().unwrap() = Some(Err(CloudApiError::Unauthorized));
        assert!(
            harness
                .context
                .prepare_session(
                    "session-5",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None
                )
                .await
                .is_err()
        );
        // The user's switch off: direct, and no reason to toast.
        lock(&harness.context.slot).settings.enabled = Some(false);
        let outcome = harness
            .context
            .prepare_session(
                "session-6",
                Some("bearer".to_string()),
                Vec::new(),
                destinations(),
                None,
            )
            .await
            .unwrap();
        assert!(matches!(outcome, PrepareOutcome::Direct));
        assert_eq!(lock(&harness.context.slot).status().fallback, None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_live_show_found_at_launch_is_resumable_and_resume_feeds_it_again() {
        let harness = harness(true);
        let created = created();
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse {
                show: Some(ShowRecord {
                    status: "live".to_string(),
                    ..created.show.clone()
                }),
                control: Some(created.control.clone()),
                ingest: Some(created.ingest.clone()),
            }));
        let context = harness.context.clone();
        let detect = tokio::spawn(async move { context.detect_current_show("bearer").await });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(json!({ "t": "welcome", "state": {
            "phase": "hold", "hold": { "active": true, "reason": "feed-lost", "remainingSeconds": 1500 }
        }}));
        let status = detect.await.unwrap().unwrap();
        assert_eq!(status.phase, CloudPhase::Hold);
        assert_eq!(status.session_id, None);
        assert!(
            status.show.as_ref().unwrap().resumable,
            "the banner's Resume"
        );
        assert_eq!(status.hold.as_ref().unwrap().remaining_seconds, Some(1500));

        // Resume: Go Live creates nothing; it reconnects to the same show,
        // hands the destinations over again, and is Resuming until live.
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse {
                show: Some(ShowRecord {
                    status: "live".to_string(),
                    ..created.show.clone()
                }),
                control: Some(created.control.clone()),
                ingest: None,
            }));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-7",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome("hold"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = prepare.await.unwrap().unwrap() else {
            panic!("resume is a cloud hand-over");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(
            handover.ingest[0].stream_key, INGEST_KEY,
            "the ingest kept from launch"
        );
        assert_eq!(harness.context.web.create_calls.load(Ordering::SeqCst), 0);
        wait_for_phase(&harness.context.slot, CloudPhase::Resuming).await;
        assert!(!lock(&harness.context.slot).status().show.unwrap().resumable);
        // The runner lists the legs it was just handed.
        server.send(json!({ "t": "state", "state": { "phase": "live", "liveSeconds": 900, "legs": live_legs() } }));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;

        // End from the banner's End stream (no session): Off.
        let context = harness.context.clone();
        let end =
            tokio::spawn(async move { context.end_current_show(Some("bearer".to_string())).await });
        let frame = server.next_frame().await;
        assert_eq!(frame["kind"], "show.end");
        server.send(ack(&frame["id"]));
        assert_eq!(end.await.unwrap().unwrap().phase, CloudPhase::Off);
    }

    #[tokio::test(start_paused = true)]
    async fn a_go_live_that_meets_a_show_its_node_already_ended_closes_it_and_starts_anew() {
        let harness = harness(true);
        let created = created();
        let stale = ShowRecord {
            id: "sh_old".to_string(),
            status: "live".to_string(),
            ..created.show.clone()
        };
        let stale_control = ShowControl {
            url: "wss://eu-hel-1.live.videorc.com:9443/v1/shows/sh_old/control".to_string(),
            token: TOKEN.to_string(),
        };
        let web = &harness.context.web;
        web.create_queue
            .lock()
            .unwrap()
            .push_back(Err(CloudApiError::ShowLive(Some(Box::new(stale.clone())))));
        *web.create.lock().unwrap() = Some(Ok(created.clone()));
        for _ in 0..2 {
            web.current
                .lock()
                .unwrap()
                .push_back(Ok(CurrentShowResponse {
                    show: Some(stale.clone()),
                    control: Some(stale_control.clone()),
                    ingest: None,
                }));
        }
        // The web still lists the show; its node already ended it.
        harness
            .context
            .connector
            .refuse_next
            .lock()
            .unwrap()
            .push_back(Some(CLOSE_CODE_NO_SUCH_SHOW));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-9",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let _refused = harness.context.connector.accept().await;
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome("starting"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = prepare.await.unwrap().unwrap() else {
            panic!("Go Live goes through a new show");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(*web.end_calls.lock().unwrap(), vec!["sh_old".to_string()]);
        assert_eq!(
            web.create_calls.load(Ordering::SeqCst),
            2,
            "one retry, no more"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_resumable_show_that_ended_while_away_makes_go_live_start_a_new_one() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        // By the click, the web no longer lists the show.
        harness.context.web.current.lock().unwrap().clear();
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse {
                show: None,
                control: None,
                ingest: None,
            }));
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-10",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        let set = server.next_frame().await;
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = prepare.await.unwrap().unwrap() else {
            panic!("Go Live goes through a new show");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(harness.context.web.create_calls.load(Ordering::SeqCst), 1);
    }

    /// A relaunched desktop whose web hands back no ingest (the web never
    /// stores ingest keys) and whose launch check could not connect.
    async fn relaunched_with_a_resumable_show(harness: &Harness) {
        let created = created();
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse {
                show: Some(created.show.clone()),
                control: Some(created.control.clone()),
                ingest: None,
            }));
        harness
            .context
            .connector
            .refuse_next
            .lock()
            .unwrap()
            .push_back(None);
        let status = harness.context.detect_current_show("bearer").await.unwrap();
        assert!(status.show.unwrap().resumable);
        assert!(!status.connected);
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse {
                show: Some(created.show.clone()),
                control: Some(created.control.clone()),
                ingest: None,
            }));
    }

    #[tokio::test(start_paused = true)]
    async fn a_relaunched_desktop_resumes_with_the_ingest_the_node_hands_back() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        let context = harness.context.clone();
        let resume = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-8",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome("hold"));
        let ask = server.next_frame().await;
        assert_eq!(ask["kind"], "ingest.get");
        server.send(json!({
            "t": "ack",
            "id": ask["id"],
            "ok": true,
            "result": { "ingest": [{
                "orientation": "horizontal",
                "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live",
                "streamKey": INGEST_KEY,
            }] },
        }));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = resume.await.unwrap().unwrap() else {
            panic!("the resume streams through the cloud");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(handover.ingest.len(), 1);
        assert_eq!(handover.ingest[0].stream_key, INGEST_KEY);
        assert_eq!(lock(&harness.context.slot).phase(), CloudPhase::Resuming);
    }

    #[tokio::test(start_paused = true)]
    async fn a_node_that_cannot_hand_back_the_ingest_fails_the_resume() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        let context = harness.context.clone();
        let resume = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-9",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("hold"));
        let ask = server.next_frame().await;
        assert_eq!(ask["kind"], "ingest.get");
        server.send(
            json!({ "t": "ack", "id": ask["id"], "ok": false, "error": "no ingest for you" }),
        );
        let error = resume.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("ingest"), "{error}");
        // Nothing was handed over: the destinations never left this computer.
        assert!(
            harness
                .context
                .connector
                .sent
                .lock()
                .unwrap()
                .iter()
                .all(|frame| frame["kind"] != "destinations.set")
        );
    }

    // C5b: the Resume notice feeds the show again with the legs the runner
    // holds. No destinations.set (a YouTube broadcast keeps its key), the
    // ingest comes back from the node, and the hold image goes only when the
    // user picked one.
    #[tokio::test(start_paused = true)]
    async fn the_resume_notice_keeps_the_runners_legs_and_sends_no_destinations() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        let context = harness.context.clone();
        let resume = tokio::spawn(async move {
            context
                .resume_session(
                    "session-12",
                    Some("bearer".to_string()),
                    Some("cG5n".to_string()),
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome("hold"));
        let ask = server.next_frame().await;
        assert_eq!(ask["kind"], "ingest.get");
        server.send(json!({
            "t": "ack",
            "id": ask["id"],
            "ok": true,
            // As the C1b node answers: an `srt` block per pair, which this
            // desktop (RTMPS only) reads past.
            "result": { "ingest": [
                { "orientation": "horizontal", "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live", "streamKey": INGEST_KEY,
                  "srt": { "url": "srt://eu-hel-1.live.videorc.com:8890", "streamId": "publish:live/sh_abc-h", "passphrase": SRT_PASSPHRASE, "latencyMs": 1000 } },
                { "orientation": "vertical", "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live", "streamKey": "sh_abc-v?key=ingestSECRET",
                  "srt": { "url": "srt://eu-hel-1.live.videorc.com:8890", "streamId": "publish:live/sh_abc-v", "passphrase": SRT_PASSPHRASE, "latencyMs": 1000 } },
            ] },
        }));
        // The picked hold image, and nothing about destinations.
        let hold = server.next_frame().await;
        assert_eq!(hold["kind"], "hold.image.set");
        assert_eq!(hold["pngBase64"], "cG5n");
        server.send(ack(&hold["id"]));
        let handover = resume.await.unwrap().unwrap();
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(
            handover
                .ingest
                .iter()
                .map(|entry| entry.orientation)
                .collect::<Vec<_>>(),
            vec![
                StreamOutputOrientation::Horizontal,
                StreamOutputOrientation::Vertical
            ],
            "every orientation the show has"
        );
        // The RTMPS pairs, whole: the ingest key stays in the stream key's query.
        assert_eq!(handover.ingest[0].stream_key, INGEST_KEY);
        assert_eq!(handover.ingest[1].stream_key, "sh_abc-v?key=ingestSECRET");
        assert_eq!(harness.context.web.create_calls.load(Ordering::SeqCst), 0);
        assert!(
            harness
                .context
                .connector
                .sent
                .lock()
                .unwrap()
                .iter()
                .all(|frame| frame["kind"] != "destinations.set"),
            "a resume never hands destinations over"
        );
        let status = lock(&harness.context.slot).status();
        assert_eq!(status.phase, CloudPhase::Resuming);
        assert_eq!(status.session_id.as_deref(), Some("session-12"));
        assert!(!status.show.unwrap().resumable);
        server.send(json!({ "t": "state", "state": { "phase": "live", "liveSeconds": 900 } }));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_without_a_hold_image_asks_only_for_the_ingest() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        let context = harness.context.clone();
        let resume = tokio::spawn(async move {
            context
                .resume_session("session-13", Some("bearer".to_string()), None)
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("hold"));
        let ask = server.next_frame().await;
        assert_eq!(ask["kind"], "ingest.get");
        server.send(json!({
            "t": "ack",
            "id": ask["id"],
            "ok": true,
            "result": { "ingest": [{
                "orientation": "horizontal",
                "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live",
                "streamKey": INGEST_KEY,
            }] },
        }));
        let handover = resume.await.unwrap().unwrap();
        assert_eq!(handover.ingest[0].stream_key, INGEST_KEY);
        let kinds: Vec<String> = harness
            .context
            .connector
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["t"] == "intent")
            .map(|frame| frame["kind"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(kinds, vec!["ingest.get".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_of_a_show_that_ended_says_so_and_starts_nothing() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        // By the click, the web no longer lists the show.
        harness.context.web.current.lock().unwrap().clear();
        harness
            .context
            .web
            .current
            .lock()
            .unwrap()
            .push_back(Ok(CurrentShowResponse::default()));
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let error = harness
            .context
            .resume_session("session-14", Some("bearer".to_string()), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already ended"), "{error}");
        assert_eq!(
            harness.context.web.create_calls.load(Ordering::SeqCst),
            0,
            "Resume never creates a show"
        );
        assert_eq!(lock(&harness.context.slot).phase(), CloudPhase::Off);
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_needs_a_signed_in_account_and_a_show_to_resume() {
        let harness = harness(true);
        let signed_out = harness
            .context
            .resume_session("session-15", None, None)
            .await
            .unwrap_err();
        assert!(signed_out.to_string().contains("Sign in"), "{signed_out}");
        let nothing = harness
            .context
            .resume_session("session-15", Some("bearer".to_string()), None)
            .await
            .unwrap_err();
        assert!(
            nothing.to_string().contains("no Videorc Cloud show"),
            "{nothing}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_start_that_fails_after_binding_the_show_makes_it_resumable_again() {
        let harness = harness(true);
        relaunched_with_a_resumable_show(&harness).await;
        let context = harness.context.clone();
        let resume = tokio::spawn(async move {
            context
                .resume_session("session-16", Some("bearer".to_string()), None)
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("hold"));
        let ask = server.next_frame().await;
        server.send(json!({
            "t": "ack",
            "id": ask["id"],
            "ok": true,
            "result": { "ingest": [{
                "orientation": "horizontal",
                "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live",
                "streamKey": INGEST_KEY,
            }] },
        }));
        resume.await.unwrap().unwrap();
        assert!(lock(&harness.context.slot).resumable_show_id().is_none());
        // The session feeding it is still the bound one: nothing changes.
        assert!(!lock(&harness.context.slot).release_unfed_session(Some("session-16")));
        // The start died before FFmpeg ran: the show is live on the runner
        // with no feed, so the Resume notice must come back.
        assert!(lock(&harness.context.slot).release_unfed_session(None));
        let status = lock(&harness.context.slot).status();
        assert!(status.show.unwrap().resumable);
        assert_eq!(status.session_id, None);
        assert_eq!(status.phase, CloudPhase::Hold);
    }

    #[test]
    fn client_info_carries_the_apps_version_not_the_crates() {
        let info = client_info_with_version("0.9.143".to_string());
        assert_eq!(info.app, "desktop");
        assert_eq!(info.version, "0.9.143");
        let wire = serde_json::to_value(&CreateShowRequest {
            kind: "solo".to_string(),
            outputs: Vec::new(),
            hold_max_seconds: 1800,
            client: info,
        })
        .unwrap();
        assert_eq!(wire["client"]["version"], "0.9.143");
        // `hello` carries the same client block.
        let hello = hello_frame("vcs1.x.y");
        assert_eq!(hello["client"]["app"], "desktop");
        assert!(
            hello["client"]["version"]
                .as_str()
                .is_some_and(|v| !v.is_empty())
        );
        // The real one reads what Electron set, or falls back to the crate.
        assert_eq!(
            client_info().version,
            crate::performance_check::desktop_app_version()
        );
    }

    // The `smoke:streaming-secrets` rule for the cloud (D15): the platform
    // keys and the show's own key and token reach the socket's hand-over
    // frame and nothing else. Not the renderer (`cloud.state`, `cloud.status`),
    // not a log (`Debug`), not a settings record.
    #[tokio::test(start_paused = true)]
    async fn no_plain_key_reaches_the_renderer_the_logs_or_the_settings() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-9",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        let set = server.next_frame().await;
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = prepare.await.unwrap().unwrap() else {
            panic!("cloud");
        };
        server.send(json!({ "t": "state", "state": { "phase": "live", "legs": [
            { "id": "youtube-main", "platform": "youtube", "label": "YouTube", "orientation": "horizontal", "state": "live" }
        ]}}));
        wait_for_phase(&harness.context.slot, CloudPhase::Live).await;

        let secrets = [YOUTUBE_KEY, TWITCH_KEY, INGEST_KEY, TOKEN];
        let leaks = |text: &str| -> Vec<&str> {
            secrets
                .iter()
                .copied()
                .filter(|secret| text.contains(secret))
                .collect()
        };
        // The renderer: every emitted cloud.state and the cloud.status answer.
        for status in harness.emitted.lock().unwrap().iter() {
            let json = serde_json::to_string(status).unwrap();
            assert!(
                leaks(&json).is_empty(),
                "cloud.state leaked {:?}",
                leaks(&json)
            );
        }
        let status_json = serde_json::to_string(&lock(&harness.context.slot).status()).unwrap();
        assert!(leaks(&status_json).is_empty());
        // The legs handed to the session's leg model.
        for (_, legs) in harness.legs.lock().unwrap().iter() {
            let json = serde_json::to_string(legs).unwrap();
            assert!(leaks(&json).is_empty());
        }
        // The logs: Debug of everything that holds a secret redacts it.
        let debug = format!(
            "{:?} {:?} {:?} {:?}",
            destinations(),
            handover,
            created().control,
            lock(&harness.context.slot).show.as_ref().unwrap()
        );
        assert!(leaks(&debug).is_empty(), "Debug leaked {:?}", leaks(&debug));
        // The settings record cannot carry a key: it has no field for one.
        let settings_json = serde_json::to_string(&lock(&harness.context.slot).settings).unwrap();
        assert!(leaks(&settings_json).is_empty());
        // The socket: the platform keys ride ONLY destinations.set, and the
        // show token ONLY hello.
        let sent = harness.context.connector.sent.lock().unwrap().clone();
        for frame in &sent {
            let text = frame.to_string();
            let found = leaks(&text);
            match frame["t"].as_str() {
                Some("hello") => assert_eq!(found, vec![TOKEN], "{text}"),
                Some("intent") if frame["kind"] == "destinations.set" => {
                    assert_eq!(found, vec![YOUTUBE_KEY, TWITCH_KEY], "{text}");
                }
                _ => assert!(found.is_empty(), "{text} leaked {found:?}"),
            }
        }
        assert!(sent.iter().any(|frame| frame["kind"] == "destinations.set"));
    }

    // --- Test cloud (C6b) -------------------------------------------------------

    /// A pusher that reports a scripted outcome after `seconds` of paused
    /// time, or holds until canceled.
    struct FakePusher {
        outcome: StdMutex<TestPushOutcome>,
        pushes: StdMutex<Vec<(String, u32)>>,
        cancels: Arc<AtomicUsize>,
        hold: bool,
    }

    impl FakePusher {
        fn clean() -> Arc<Self> {
            Arc::new(Self {
                outcome: StdMutex::new(TestPushOutcome {
                    ok: true,
                    certificate_failed: false,
                    detail: None,
                }),
                pushes: StdMutex::new(Vec::new()),
                cancels: Arc::new(AtomicUsize::new(0)),
                hold: false,
            })
        }

        fn holding() -> Arc<Self> {
            let mut pusher = Arc::try_unwrap(Self::clean()).ok().unwrap();
            pusher.hold = true;
            Arc::new(pusher)
        }

        fn with_outcome(outcome: TestPushOutcome) -> Arc<Self> {
            let pusher = Self::clean();
            *pusher.outcome.lock().unwrap() = outcome;
            pusher
        }
    }

    impl CloudTestPusher for FakePusher {
        fn push(
            &self,
            _ingest: ShowIngest,
            output: ShowOutputSpec,
            seconds: u64,
            mut cancel: watch::Receiver<bool>,
        ) -> TestPushFuture {
            self.pushes
                .lock()
                .unwrap()
                .push((orientation_id(output.orientation), output.video_kbps));
            let outcome = self.outcome.lock().unwrap().clone();
            let hold = self.hold;
            let cancels = self.cancels.clone();
            Box::pin(async move {
                let wait = async {
                    if hold {
                        std::future::pending::<()>().await;
                    } else {
                        tokio::time::sleep(Duration::from_secs(seconds)).await;
                    }
                };
                tokio::select! {
                    _ = wait => Ok(outcome),
                    _ = wait_canceled(&mut cancel) => {
                        cancels.fetch_add(1, Ordering::SeqCst);
                        Ok(TestPushOutcome { ok: false, certificate_failed: false, detail: Some("canceled".to_string()) })
                    }
                }
            })
        }
    }

    fn test_outputs() -> Vec<ShowOutputSpec> {
        vec![ShowOutputSpec {
            orientation: StreamOutputOrientation::Horizontal,
            width: 1920,
            height: 1080,
            fps: 60,
            video_kbps: 6000,
            audio_kbps: 160,
        }]
    }

    fn feed_state(phase: &str, kbps: u64) -> Value {
        json!({ "t": "state", "state": {
            "phase": phase,
            "liveSeconds": 1,
            "feeds": [{ "orientation": "horizontal", "connected": kbps > 0, "kbps": kbps }],
            "legs": []
        }})
    }

    /// Reads the desktop's frames until `show.end`, skipping pings, and acks it.
    async fn ack_show_end(server: &mut FakeServer) {
        loop {
            let frame = server.next_frame().await;
            if frame["kind"] == "show.end" {
                server.send(ack(&frame["id"]));
                return;
            }
            assert_eq!(frame["t"], "ping", "unexpected frame {frame}");
        }
    }

    fn test_status(slot: &CloudShowSlot) -> CloudTestStatus {
        lock(slot).status().test.expect("a test block")
    }

    #[tokio::test(start_paused = true)]
    async fn a_test_creates_a_test_show_pushes_ten_seconds_and_judges_the_upload() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let pusher = FakePusher::clean();
        let status = harness
            .context
            .start_test(Some("bearer".to_string()), test_outputs(), pusher.clone())
            .unwrap();
        assert_eq!(
            status.test.as_ref().unwrap().phase,
            CloudTestPhase::Creating
        );
        assert!(lock(&harness.context.slot).test_running());
        // The slot's show is untouched: the Studio sees Off throughout.
        assert_eq!(status.phase, CloudPhase::Off);

        let mut server = harness.context.connector.accept().await;
        let hello = server.next_frame().await;
        assert_eq!(hello["t"], "hello");
        server.send(welcome("starting"));
        wait_until(|| test_status(&harness.context.slot).phase == CloudTestPhase::Pushing).await;
        assert_eq!(
            pusher.pushes.lock().unwrap().as_slice(),
            &[("horizontal".to_string(), 6000)]
        );
        // The runner's view of the feed: a partial first poll, then steady.
        server.send(feed_state("live", 2000));
        server.send(feed_state("live", 6100));
        server.send(feed_state("live", 6150));
        server.send(feed_state("live", 6100));
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&harness.context.slot).test_running()).await;

        let test = test_status(&harness.context.slot);
        assert_eq!(test.phase, CloudTestPhase::Done);
        let result = test.result.unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.reason, None);
        assert!(result.time_to_live_ms.is_some());
        assert_eq!(result.uploads.len(), 1);
        assert_eq!(result.uploads[0].target_kbps, 6000);
        assert_eq!(result.uploads[0].measured_kbps, Some(6100));
        // The web saw a test create and its end; the runner saw show.end.
        assert_eq!(
            harness.context.web.create_kinds.lock().unwrap().as_slice(),
            &["test".to_string()]
        );
        assert_eq!(
            harness.context.web.end_calls.lock().unwrap().as_slice(),
            &["sh_abc".to_string()]
        );
        let sent = harness.context.connector.sent.lock().unwrap().clone();
        assert!(sent.iter().any(|frame| frame["kind"] == "show.end"));
        assert!(
            !sent.iter().any(|frame| frame["kind"] == "destinations.set"),
            "a test never hands destinations over"
        );
        // The Studio's show slot never changed hands.
        assert_eq!(lock(&harness.context.slot).phase(), CloudPhase::Off);
        assert!(lock(&harness.context.slot).show.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_upload_fails_the_test_with_what_it_reached() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        harness
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        server.send(feed_state("live", 2100));
        server.send(feed_state("live", 2050));
        server.send(feed_state("live", 2100));
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&harness.context.slot).test_running()).await;
        let result = test_status(&harness.context.slot).result.unwrap();
        assert!(!result.ok);
        assert_eq!(result.reason, Some(CloudTestReason::TooSlow));
        assert_eq!(result.uploads[0].measured_kbps, Some(2100));
        assert!(result.time_to_live_ms.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_certificate_and_a_feed_that_never_arrives_are_named() {
        // The certificate first: FFmpeg refused the node, nothing else counts.
        let refused = harness(true);
        *refused.context.web.create.lock().unwrap() = Some(Ok(created()));
        refused
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::with_outcome(TestPushOutcome {
                    ok: false,
                    certificate_failed: true,
                    detail: Some("[tls] certificate verify failed".to_string()),
                }),
            )
            .unwrap();
        let mut server = refused.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&refused.context.slot).test_running()).await;
        let result = test_status(&refused.context.slot).result.unwrap();
        assert_eq!(result.reason, Some(CloudTestReason::Certificate));
        assert!(
            result
                .message
                .unwrap()
                .contains("certificate verify failed")
        );

        // A clean push the runner never saw: something blocks the stream.
        let quiet = harness(true);
        *quiet.context.web.create.lock().unwrap() = Some(Ok(created()));
        quiet
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        let mut server = quiet.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&quiet.context.slot).test_running()).await;
        let result = test_status(&quiet.context.slot).result.unwrap();
        assert_eq!(result.reason, Some(CloudTestReason::NoFeed));
        assert_eq!(result.time_to_live_ms, None);
        assert_eq!(result.uploads[0].measured_kbps, None);
        assert_eq!(quiet.context.web.end_calls.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_web_refusing_the_test_names_the_reason_and_nothing_connects() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Err(CloudApiError::TestLimit {
            reset_at: Some("2026-10-17T13:00:00.000Z".to_string()),
        }));
        harness
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        wait_until(|| !lock(&harness.context.slot).test_running()).await;
        let result = test_status(&harness.context.slot).result.unwrap();
        assert_eq!(result.reason, Some(CloudTestReason::Limit));
        assert_eq!(result.reset_at.as_deref(), Some("2026-10-17T13:00:00.000Z"));
        assert_eq!(result.uploads[0].target_kbps, 6000);
        assert_eq!(harness.context.connector.connects.load(Ordering::SeqCst), 0);
        assert!(harness.context.web.end_calls.lock().unwrap().is_empty());

        // The node unreachable at hello: can't reach, and the show is ended.
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        harness
            .context
            .connector
            .refuse_next
            .lock()
            .unwrap()
            .push_back(None);
        harness
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        wait_until(|| !lock(&harness.context.slot).test_running()).await;
        let result = test_status(&harness.context.slot).result.unwrap();
        assert_eq!(result.reason, Some(CloudTestReason::CantReach));
        assert_eq!(
            harness.context.web.end_calls.lock().unwrap().as_slice(),
            &["sh_abc".to_string()]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_test_refuses_while_signed_out_unentitled_a_show_is_held_or_a_test_runs() {
        let unentitled = harness(false);
        assert_eq!(
            unentitled
                .context
                .start_test(None, test_outputs(), FakePusher::clean())
                .unwrap_err(),
            CloudTestRefusal::SignedOut
        );
        assert_eq!(
            unentitled
                .context
                .start_test(
                    Some("bearer".to_string()),
                    test_outputs(),
                    FakePusher::clean()
                )
                .unwrap_err(),
            CloudTestRefusal::NotEntitled
        );

        let harness = harness(true);
        assert_eq!(
            harness
                .context
                .start_test(Some("bearer".to_string()), Vec::new(), FakePusher::clean())
                .unwrap_err(),
            CloudTestRefusal::NoOutputs
        );
        lock(&harness.context.slot).show = Some(ActiveShow {
            record: created().show,
            control: created().control,
            ingest: None,
            session_id: None,
            destinations: Vec::new(),
            handed_over: false,
            resuming: false,
        });
        assert_eq!(
            harness
                .context
                .start_test(
                    Some("bearer".to_string()),
                    test_outputs(),
                    FakePusher::clean()
                )
                .unwrap_err(),
            CloudTestRefusal::ShowLive
        );
        lock(&harness.context.slot).show = None;

        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        harness
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::holding(),
            )
            .unwrap();
        assert_eq!(
            harness
                .context
                .start_test(
                    Some("bearer".to_string()),
                    test_outputs(),
                    FakePusher::clean()
                )
                .unwrap_err(),
            CloudTestRefusal::Running
        );
        assert_eq!(CloudTestRefusal::Running.code(), "cloud-test-running");
        harness.context.cancel_test().await;
        assert!(!lock(&harness.context.slot).test_running());
    }

    #[tokio::test(start_paused = true)]
    async fn go_live_ends_a_running_test_first_and_drops_its_result() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let pusher = FakePusher::holding();
        harness
            .context
            .start_test(Some("bearer".to_string()), test_outputs(), pusher.clone())
            .unwrap();
        let mut test_server = harness.context.connector.accept().await;
        let _hello = test_server.next_frame().await;
        test_server.send(welcome("starting"));
        wait_until(|| test_status(&harness.context.slot).phase == CloudTestPhase::Pushing).await;

        let context = harness.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-live",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        // The test ends on the socket and the web before the show is created.
        ack_show_end(&mut test_server).await;
        wait_until(|| !lock(&harness.context.slot).test_running()).await;
        assert_eq!(pusher.cancels.load(Ordering::SeqCst), 1);
        assert_eq!(lock(&harness.context.slot).status().test, None);
        assert_eq!(
            harness.context.web.end_calls.lock().unwrap().as_slice(),
            &["sh_abc".to_string()]
        );

        let mut show_server = harness.context.connector.accept().await;
        let _hello = show_server.next_frame().await;
        show_server.send(welcome("starting"));
        let set = show_server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        show_server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(_) = prepare.await.unwrap().unwrap() else {
            panic!("the show should have started through the cloud");
        };
        assert_eq!(
            harness.context.web.create_kinds.lock().unwrap().as_slice(),
            &["test".to_string(), "solo".to_string()]
        );
    }

    #[test]
    fn the_test_verdict_orders_its_reasons() {
        let outputs = test_outputs();
        let clean: Vec<Result<TestPushOutcome>> = vec![Ok(TestPushOutcome {
            ok: true,
            certificate_failed: false,
            detail: None,
        })];
        let steady: HashMap<String, Vec<u32>> =
            HashMap::from([("horizontal".to_string(), vec![1000, 6100, 6200])]);
        let verdict = |samples: &HashMap<String, Vec<u32>>,
                       outcomes: &[Result<TestPushOutcome>],
                       live: Option<u64>,
                       ended: Option<&str>,
                       timed_out: bool| {
            test_verdict(TestVerdictInput {
                outputs: &outputs,
                samples,
                outcomes,
                time_to_live_ms: live,
                ended_by_runner: ended.map(str::to_string),
                timed_out,
            })
        };
        let ok = verdict(&steady, &clean, Some(2300), None, false);
        assert!(ok.ok);
        assert_eq!(ok.uploads[0].measured_kbps, Some(6100));
        assert_eq!(ok.time_to_live_ms, Some(2300));
        assert_eq!(ok.message, None);

        // 85% of video plus audio is the line: 5236 kbps here.
        let edge = HashMap::from([("horizontal".to_string(), vec![5236])]);
        assert!(verdict(&edge, &clean, Some(1), None, false).ok);
        let under = HashMap::from([("horizontal".to_string(), vec![5235])]);
        assert_eq!(
            verdict(&under, &clean, Some(1), None, false).reason,
            Some(CloudTestReason::TooSlow)
        );
        assert_eq!(
            verdict(&steady, &clean, None, None, false).reason,
            Some(CloudTestReason::NoFeed)
        );
        assert_eq!(
            verdict(&steady, &clean, Some(1), Some("no-feed"), false).reason,
            Some(CloudTestReason::Failed)
        );
        let timed = verdict(&steady, &clean, Some(1), None, true);
        assert_eq!(timed.reason, Some(CloudTestReason::Failed));
        assert_eq!(
            timed.message.as_deref(),
            Some("the test did not finish in time")
        );
        let certificate: Vec<Result<TestPushOutcome>> = vec![Ok(TestPushOutcome {
            ok: false,
            certificate_failed: true,
            detail: Some("certificate verify failed".to_string()),
        })];
        assert_eq!(
            verdict(&steady, &certificate, Some(1), Some("ended"), true).reason,
            Some(CloudTestReason::Certificate)
        );
        let crashed: Vec<Result<TestPushOutcome>> = vec![Err(anyhow::anyhow!("ffmpeg exited 1"))];
        let failed = verdict(&steady, &crashed, Some(1), None, false);
        assert_eq!(failed.reason, Some(CloudTestReason::Failed));
        assert!(failed.message.unwrap().contains("ffmpeg exited 1"));
        // A push that never ran (FFmpeg missing) is this computer's failure,
        // never a feed the network blocked.
        let never_ran: Vec<Result<TestPushOutcome>> = vec![Err(anyhow::anyhow!(
            "The Videorc Cloud test couldn't start FFmpeg."
        ))];
        assert_eq!(
            verdict(&HashMap::new(), &never_ran, None, None, false).reason,
            Some(CloudTestReason::Failed)
        );
        // Live and clean, but the node never measured the feed: unmeasured,
        // never an unmeasured "too slow".
        let unmeasured = verdict(&HashMap::new(), &clean, Some(1), None, false);
        assert!(unmeasured.ok, "{unmeasured:?}");
        assert_eq!(unmeasured.uploads[0].measured_kbps, None);
        assert_eq!(median_kbps(&[]), None);
        assert_eq!(median_kbps(&[3, 1, 2]), Some(2));
    }

    #[tokio::test(start_paused = true)]
    async fn a_test_show_left_open_on_the_web_is_ended_before_a_go_live_or_a_new_test() {
        // A crashed desktop's test still holds the account's one open show.
        let stale = ShowRecord {
            id: "sh_test".to_string(),
            status: "live".to_string(),
            kind: "test".to_string(),
            ..created().show
        };

        // Go Live: the web refuses with the test; it is ended, never adopted
        // as resumable, and the show is created once more.
        let go_live = harness(true);
        let web = &go_live.context.web;
        web.create_queue
            .lock()
            .unwrap()
            .push_back(Err(CloudApiError::ShowLive(Some(Box::new(stale.clone())))));
        *web.create.lock().unwrap() = Some(Ok(created()));
        let context = go_live.context.clone();
        let prepare = tokio::spawn(async move {
            context
                .prepare_session(
                    "session-1",
                    Some("bearer".to_string()),
                    Vec::new(),
                    destinations(),
                    None,
                )
                .await
        });
        let mut server = go_live.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        let set = server.next_frame().await;
        assert_eq!(set["kind"], "destinations.set");
        server.send(ack(&set["id"]));
        let PrepareOutcome::Cloud(handover) = prepare.await.unwrap().unwrap() else {
            panic!("Go Live goes through a new show");
        };
        assert_eq!(handover.show_id, "sh_abc");
        assert_eq!(*web.end_calls.lock().unwrap(), vec!["sh_test".to_string()]);
        assert_eq!(web.create_calls.load(Ordering::SeqCst), 2, "one retry");
        assert_eq!(web.current_calls.load(Ordering::SeqCst), 0, "never adopted");

        // A new test: the stale one is ended and the new one runs.
        let tester = harness(true);
        let web = &tester.context.web;
        web.create_queue
            .lock()
            .unwrap()
            .push_back(Err(CloudApiError::ShowLive(Some(Box::new(stale.clone())))));
        *web.create.lock().unwrap() = Some(Ok(created()));
        tester
            .context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        let mut server = tester.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        server.send(feed_state("live", 6100));
        server.send(feed_state("live", 6150));
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&tester.context.slot).test_running()).await;
        let result = test_status(&tester.context.slot).result.unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            *web.end_calls.lock().unwrap(),
            vec!["sh_test".to_string(), "sh_abc".to_string()]
        );
        assert_eq!(
            *web.create_kinds.lock().unwrap(),
            vec!["test".to_string(), "test".to_string()]
        );

        // A show that is not a test stays: the test names it and ends nothing.
        let busy = harness(true);
        *busy.context.web.create.lock().unwrap() =
            Some(Err(CloudApiError::ShowLive(Some(Box::new(ShowRecord {
                status: "live".to_string(),
                ..created().show
            })))));
        busy.context
            .start_test(
                Some("bearer".to_string()),
                test_outputs(),
                FakePusher::clean(),
            )
            .unwrap();
        wait_until(|| !lock(&busy.context.slot).test_running()).await;
        let result = test_status(&busy.context.slot).result.unwrap();
        assert_eq!(result.reason, Some(CloudTestReason::ShowLive));
        assert!(busy.context.web.end_calls.lock().unwrap().is_empty());
        assert_eq!(busy.context.web.create_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_start_stops_a_running_test_without_waiting_for_it() {
        let harness = harness(true);
        *harness.context.web.create.lock().unwrap() = Some(Ok(created()));
        let pusher = FakePusher::holding();
        harness
            .context
            .start_test(Some("bearer".to_string()), test_outputs(), pusher.clone())
            .unwrap();
        let mut server = harness.context.connector.accept().await;
        let _hello = server.next_frame().await;
        server.send(welcome("starting"));
        wait_until(|| test_status(&harness.context.slot).phase == CloudTestPhase::Pushing).await;

        // The signal answers at once; the task stops the push and ends the
        // test's show on its own, and its result is dropped.
        assert!(lock(&harness.context.slot).signal_test_cancel());
        assert!(lock(&harness.context.slot).test_running(), "nothing waited");
        ack_show_end(&mut server).await;
        wait_until(|| !lock(&harness.context.slot).test_running()).await;
        assert_eq!(pusher.cancels.load(Ordering::SeqCst), 1);
        assert_eq!(lock(&harness.context.slot).status().test, None);
        assert_eq!(
            *harness.context.web.end_calls.lock().unwrap(),
            vec!["sh_abc".to_string()]
        );
        assert!(!lock(&harness.context.slot).signal_test_cancel());
    }
}
