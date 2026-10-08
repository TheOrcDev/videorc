//! HTTP client for the Videorc web API (videorc.com) — the desktop account auth
//! bridge.
//!
//! Base URL: release/packaged builds are pinned to `https://www.videorc.com` so a
//! stray environment variable can never redirect the user's Bearer token at
//! another host. Dev/debug builds default to a local `videorc-web` at
//! `http://localhost:3000` and may override via `VIDEORC_API_BASE_URL`, so local
//! sign-in testing works out of the box.

use anyhow::{Context, Result, bail};
use reqwest::multipart;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;

pub(crate) const CAPTION_CHUNK_UPLOAD_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10);
pub(crate) const AI_CAPABILITIES_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(8);
const DESKTOP_AUTH_EXCHANGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Co-host ticks are synchronous and small, but the server fans one tick out
/// across a model ladder: a slow-but-alive gateway needs headroom beyond the
/// 8 s cadence floor, while a hung tick must still become a retryable failure,
/// never a stalled engine. The scheduler never overlaps ticks, so a 12 s tick
/// simply delays the next one.
pub(crate) const COHOST_TICK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const COHOST_TICK_PATH: &str = "/api/ai/cohost/tick";
/// The spotlight lane (plan 060 S3) is a fast lane: one evaluation-model call
/// every few seconds while the streamer talks. A slow answer is worth nothing
/// (the transcript has moved on), so the client gives up early and the engine
/// reads the timeout as "no signal", never as a co-host error.
pub(crate) const COHOST_SPOTLIGHT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const COHOST_SPOTLIGHT_PATH: &str = "/api/ai/cohost/spotlight";
/// The server rejects a larger body (checked on content-length bytes) as
/// `invalid-request`; the engine trims candidates until the JSON fits.
pub(crate) const COHOST_SPOTLIGHT_MAX_BODY_BYTES: usize = 32 * 1024;
/// The Golem command parser (plan 140 S8) answers a wake-word utterance the
/// local grammar could not read. The server's own budget is 2 s; past 2.5 s
/// the streamer has moved on, so the engine says "didn't catch that".
pub(crate) const COHOST_COMMAND_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(2_500);
const COHOST_COMMAND_PATH: &str = "/api/ai/cohost/command";
/// Plan 164 S-A6: the route's own `maxDuration` is 90 s, so the client
/// waits 95 (S-A5). A generated PNG over 8 MB is refused unread.
pub(crate) const COHOST_AVATAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(95);
const COHOST_AVATAR_PATH: &str = "/api/ai/cohost/avatar";
pub(crate) const COHOST_AVATAR_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024 + 64 * 1024;
/// The route's limits (contract part E).
pub(crate) const COHOST_COMMAND_MAX_BODY_BYTES: usize = 16 * 1024;
pub(crate) const COHOST_COMMAND_MAX_CANDIDATES: usize = 20;
const COHOST_COMMAND_UTTERANCE_MAX_CHARS: usize = 300;
const COHOST_COMMAND_AUTHOR_MAX_CHARS: usize = 120;
const COHOST_COMMAND_TEXT_MAX_CHARS: usize = 500;
const COHOST_COMMAND_ID_MAX_CHARS: usize = 200;
const WINDOWS_PILOT_UPDATE_TOKEN_PATH: &str = "/api/desktop/updates/windows-pilot-token";
/// Bounded well inside the provider-mutation RPC envelope: an update check must
/// never wait on a slow web edge for long.
pub(crate) const WINDOWS_PILOT_UPDATE_TOKEN_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10);

/// A short-lived token that reads only the Windows pilot update feed. The web
/// mints it for a signed-in account while Windows is in pilot; the account
/// session itself never leaves the backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPilotUpdateToken {
    pub token: String,
    pub expires_at: String,
}

/// The web answers "no pilot for this caller" (signed out, pilot closed, or an
/// older web without the endpoint) with these; they are an ordinary `None`, not
/// an update failure.
fn windows_pilot_update_token_refused(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 409)
}

fn valid_windows_pilot_update_token(token: &str) -> bool {
    token.starts_with("wpu1.")
        && token.len() <= 512
        && token.bytes().all(|byte| byte.is_ascii_graphic())
}

use crate::cohost::{
    CohostAlertKind, CohostErrorDetail, CohostFlagAction, CohostFlagKind, CohostFlagSeverity,
    CohostFlagTarget, CohostHighlightType, CohostMood, CohostPriority, CohostPromiseTriggerKind,
    CohostReason, CohostTone,
};
use crate::streaming::StreamPlatform;

use crate::protocol::{AiCapabilities, AiQuotaStatus};

// WWW is load-bearing: the apex 307-redirects every path to www.videorc.com,
// and reqwest strips Authorization on cross-host redirects — Bearer calls to
// the apex would arrive unauthenticated.
const PRODUCTION_API_BASE_URL: &str = "https://www.videorc.com";
const DEV_API_BASE_URL: &str = "http://localhost:3000";
const API_BASE_URL_ENV: &str = "VIDEORC_API_BASE_URL";

/// The effective Videorc web API base URL for this build.
pub fn api_base_url() -> String {
    resolve_api_base_url(
        cfg!(debug_assertions),
        std::env::var(API_BASE_URL_ENV).ok().as_deref(),
    )
}

fn resolve_api_base_url(dev_build: bool, env_override: Option<&str>) -> String {
    if !dev_build {
        // Packaged builds are pinned — never honor the override in production.
        return PRODUCTION_API_BASE_URL.to_string();
    }
    match env_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(url) => url.trim_end_matches('/').to_string(),
        // Dev defaults to a local videorc-web so sign-in testing is zero-config.
        None => DEV_API_BASE_URL.to_string(),
    }
}

/// The account identity + durable session token obtained by exchanging an
/// encrypted, PKCE-bound desktop authorization code.
pub struct VerifiedSession {
    pub session_token: String,
    pub name: Option<String>,
    pub email: String,
    /// Better Auth `user.image` — the account avatar (Google photo or the
    /// web-uploaded one). Absent for accounts without an avatar.
    pub image: Option<String>,
}

/// The outcome of validating the stored Bearer token via `/api/auth/get-session`.
pub struct SessionRefresh {
    pub status: SessionStatus,
    /// A rotated session token from the `set-auth-token` header, if the server
    /// refreshed it on this request.
    pub rotated_token: Option<String>,
}

pub enum SessionStatus {
    Active {
        name: Option<String>,
        email: String,
        image: Option<String>,
    },
    Unauthorized,
}

// --- Live Co-host tick wire types (contract v3, additive over v2 over v1; field names are load-bearing) ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickRequest {
    pub client_version: String,
    pub session_client_id: String,
    pub tick_seq: u64,
    pub prompt_version: u32,
    pub consent_to_process_chat: bool,
    pub tone: CohostTone,
    pub notes: String,
    /// v2 and later: the streamer's normalised chat rules. `None` in the v1
    /// fallback, where the key does not appear at all, so a v1 body stays
    /// byte-identical to what a v1 desktop sends (the server strips unknown
    /// keys now, but the older bodies are kept exact on purpose).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    pub stream_title: Option<String>,
    pub open_questions: Vec<CohostTickOpenQuestion>,
    pub messages: Vec<CohostTickMessage>,
    pub dropped_messages: u64,
    /// v3 (plan 068 D7): transcript finals since the previous tick, newest
    /// 1500 chars. Absent on v1/v2 and when nothing was said. `messages` may
    /// be empty when this is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
    /// v3: the rolling stream summary the server returned last time (≤ 600
    /// chars); the server is stateless, the desktop echoes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// v3: the open promises (≤ 20, text ≤ 160; the server rejects more as
    /// `invalid-request`, so the desktop caps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_promises: Option<Vec<CohostTickOpenPromise>>,
    /// v4 (plan 164 S-D3): the user's creature. Absent below v4, so a v3 body
    /// stays byte-identical to what a v3 desktop sends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<CohostTickPersona>,
    /// v4: `banter` asks for one short line on dead air (S-D4); absent means
    /// a normal tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<CohostTickIntent>,
}

/// v4: the persona the prompt speaks as (plan 164).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickPersona {
    pub name: String,
    pub personality: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostTickIntent {
    Tick,
    Banter,
}

/// v4: the mood a reply is said in (plan 164 D18); unknown values read as
/// neutral.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostTickMood {
    #[default]
    Neutral,
    Amused,
    Thinking,
    #[serde(other)]
    Unknown,
}

/// v4: the one banter line (≤ 120 chars) a `banter` request returns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickBanter {
    pub text: String,
    #[serde(default)]
    pub mood: Option<CohostTickMood>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickOpenPromise {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickOpenQuestion {
    pub id: String,
    pub text: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickMessage {
    pub id: String,
    pub platform: StreamPlatform,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    pub text: String,
    pub at: String,
    /// v3: the author's first message in the channel. Absent on v1/v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_message: Option<bool>,
}

/// Every v2 field is optional and absent means its default, so a v1 body
/// parses unchanged. Unknown extra fields are ignored; unknown enum strings
/// land on each enum's `Unknown` catch-all; and one item the desktop cannot
/// read (`flags`, `highlights`, `alerts`) is dropped on its own — none of these
/// may fail the whole tick as `MalformedResponse`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickResponse {
    #[serde(default)]
    pub prompt_version: u32,
    #[serde(default)]
    pub questions: Vec<CohostTickQuestion>,
    #[serde(default)]
    pub resolved: Vec<String>,
    /// v2: the server did not regenerate the open set this tick. `questions`
    /// is `[]` and must be ignored; only `resolved` ids leave.
    #[serde(default)]
    pub keep_questions: bool,
    #[serde(default, deserialize_with = "lenient_items")]
    pub flags: Vec<CohostTickFlag>,
    #[serde(default)]
    pub mood: Option<CohostMood>,
    #[serde(default)]
    pub usage: Option<CohostTickUsage>,
    /// v2: comments worth showing on stream, best first, already safety-gated.
    #[serde(default, deserialize_with = "lenient_items")]
    pub highlights: Vec<CohostTickHighlight>,
    /// v2: viewers telling the streamer something is broken.
    #[serde(default, deserialize_with = "lenient_items")]
    pub alerts: Vec<CohostTickAlert>,
    #[serde(default)]
    pub mood_scores: Option<CohostTickMoodScores>,
    /// v3 (plan 068 D7): the rolling stream summary (echoed back next tick).
    #[serde(default)]
    pub summary: Option<String>,
    /// v3: what the streamer is talking about (≤ 60 chars).
    #[serde(default)]
    pub topic: Option<String>,
    /// v3: the FULL open promise set, like `questions`: `id` echoed for a
    /// promise the desktop sent, absent for a new one. `None` when the server
    /// did not speak v3 (the desktop keeps its set).
    #[serde(default, deserialize_with = "lenient_items_opt")]
    pub promises: Option<Vec<CohostTickPromise>>,
    /// v3: promise ids the transcript shows were kept.
    #[serde(default)]
    pub fulfilled_promise_ids: Vec<String>,
    /// v3: a recap for viewers who asked what they missed (≤ 140 chars).
    #[serde(default)]
    pub recap: Option<String>,
    /// v4 (plan 164 S-D4): the banter line, only on an `intent: banter`
    /// request. An unreadable one is dropped, never the whole tick.
    #[serde(default, deserialize_with = "lenient_item")]
    pub banter: Option<CohostTickBanter>,
}

/// One optional item the desktop drops when it does not fit, like
/// `lenient_items` for arrays.
fn lenient_item<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// `lenient_items` for an array the desktop must tell apart from an absent
/// key: `None` when absent or `null`, otherwise the readable items.
fn lenient_items_opt<'de, D, T>(deserializer: D) -> std::result::Result<Option<Vec<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let items = Option::<Vec<serde_json::Value>>::deserialize(deserializer)?;
    Ok(items.map(|items| {
        items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect()
    }))
}

/// Item-wise tolerant array: an entry that does not fit the desktop's shape is
/// skipped instead of failing the body. `null` reads as empty.
fn lenient_items<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let items = Option::<Vec<serde_json::Value>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickQuestion {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub message_ids: Vec<String>,
    #[serde(default)]
    pub askers: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<StreamPlatform>,
    #[serde(default)]
    pub priority: CohostPriority,
    #[serde(default)]
    pub suggested_reply: String,
    #[serde(default)]
    pub from_notes: bool,
    /// v3: the question is about what the streamer is talking about.
    #[serde(default)]
    pub on_topic: bool,
    /// v4 (plan 164 S-D3): the viewer named the Golem or used `@<name>`.
    #[serde(default)]
    pub addressed: bool,
    /// v4: the mood the drafted reply is said in.
    #[serde(default)]
    pub mood: Option<CohostTickMood>,
}

/// v3 promise as the server returns it. An unknown trigger kind lands on
/// `Unknown` and the engine reads it as `none`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickPromise {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    #[serde(default)]
    pub trigger: CohostTickPromiseTrigger,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickPromiseTrigger {
    #[serde(default)]
    pub kind: CohostPromiseTriggerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickFlag {
    pub message_id: String,
    pub kind: CohostFlagKind,
    pub severity: CohostFlagSeverity,
    #[serde(default)]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CohostFlagTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<CohostFlagAction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_kinds: Vec<CohostFlagKind>,
    /// Index into the REQUEST's `rules` when `kind` is `rule`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickHighlight {
    pub message_id: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default, rename = "type")]
    pub highlight_type: CohostHighlightType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickAlert {
    pub message_id: String,
    pub kind: CohostAlertKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickMoodScores {
    #[serde(default)]
    pub hype: f64,
    #[serde(default)]
    pub tension: f64,
    #[serde(default)]
    pub confusion: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub model: String,
}

// --- Live Co-host spotlight wire types (plan 060 S2/S3; field names are load-bearing) ---

/// `POST /api/ai/cohost/spotlight`: the last seconds of the streamer's live
/// captions plus the chat messages they might be talking about. `seq` is the
/// lane's own counter (echoed back), independent of the tick's `tickSeq`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlightRequest {
    pub client_version: String,
    pub session_client_id: String,
    pub consent_to_process_chat: bool,
    pub transcript: String,
    pub seq: u64,
    pub candidates: Vec<CohostSpotlightCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlightCandidate {
    pub id: String,
    pub text: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    pub at: String,
    /// Present when the candidate is the first message of an open question:
    /// the server then also judges whether the transcript answers it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_text: Option<String>,
}

/// Raw probabilities in request order; a candidate the server could not judge
/// is simply absent. Thresholds are desktop-owned. Item-wise tolerant like the
/// tick response: one unreadable match never fails the call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlightResponse {
    #[serde(default)]
    pub seq: u64,
    #[serde(default, deserialize_with = "lenient_items")]
    pub matches: Vec<CohostSpotlightMatch>,
    #[serde(default)]
    pub usage: Option<CohostTickUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlightMatch {
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    /// Is the streamer talking about this message right now (0..1).
    #[serde(default)]
    pub about: f64,
    /// Does the transcript answer the candidate's question (0..1); only for a
    /// candidate that carried a `questionId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered: Option<f64>,
}

// --- Golem avatar wire types (plan 164 S-A5, S-A6) ---

/// `POST /api/ai/cohost/avatar`: one state image. `baseImage` is the idle
/// PNG/WebP as base64 for the other states, so the character stays
/// consistent (D21); absent for idle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarRequest {
    pub prompt: String,
    pub style: crate::cohost_avatar::CohostAvatarStyle,
    pub state: crate::cohost::CohostAvatarState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_image: Option<String>,
}

/// The route's answer: a PNG, returned even when the model gave no alpha.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAvatarResponse {
    pub png_base64: String,
    #[serde(default)]
    pub opaque: bool,
}

// --- Golem command parser wire types (plan 140 S8, contract part E) ---

/// `POST /api/ai/cohost/command`: what the streamer said after "Golem" that
/// the local grammar could not read, plus the chat comments it may mean.
/// Build it with `CohostCommandRequest::shaped`, which enforces the route's
/// limits; the client refuses anything else without sending.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandRequest {
    pub client_version: String,
    pub session_client_id: String,
    pub consent_to_process_chat: bool,
    pub seq: u64,
    pub utterance: String,
    /// The comment the streamer is talking about (or the one on stream), so
    /// "this one" can resolve. Always one of `candidates` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_message_id: Option<String>,
    pub candidates: Vec<CohostCommandCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandCandidate {
    pub id: String,
    pub author: String,
    pub text: String,
    pub at: String,
}

impl CohostCommandRequest {
    /// The request the route accepts, or `None` when nothing worth sending
    /// is left. The utterance is trimmed and capped at 300 UTF-16 units.
    /// Candidates keep their order (newest first): one with an empty or
    /// overlong id, a repeated id, empty text or an unreadable time is
    /// dropped; author (120) and text (500) are trimmed and capped, an empty
    /// author reads "Viewer". At most 20 are kept, the focus always among
    /// them (it replaces the last one when it fell outside), and the oldest
    /// non-focus ones go until the body fits 16 KB. A focus that names no
    /// kept candidate is dropped.
    pub fn shaped(
        client_version: &str,
        session_client_id: &str,
        seq: u64,
        utterance: &str,
        focus_message_id: Option<&str>,
        candidates: Vec<CohostCommandCandidate>,
    ) -> Option<Self> {
        let utterance =
            crate::cohost::truncate_utf16(utterance.trim(), COHOST_COMMAND_UTTERANCE_MAX_CHARS)
                .trim()
                .to_string();
        if utterance.is_empty() {
            return None;
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut shaped: Vec<CohostCommandCandidate> = candidates
            .into_iter()
            .filter_map(shape_cohost_command_candidate)
            .filter(|candidate| seen.insert(candidate.id.clone()))
            .collect();
        let focus = focus_message_id
            .map(str::trim)
            .filter(|focus| shaped.iter().any(|candidate| candidate.id == *focus))
            .map(str::to_string);
        if shaped.len() > COHOST_COMMAND_MAX_CANDIDATES {
            let focus_index = focus.as_deref().and_then(|focus| {
                shaped
                    .iter()
                    .position(|candidate| candidate.id == focus)
                    .filter(|index| *index >= COHOST_COMMAND_MAX_CANDIDATES)
            });
            let focus_candidate = focus_index.map(|index| shaped.remove(index));
            shaped.truncate(COHOST_COMMAND_MAX_CANDIDATES);
            if let Some(focus_candidate) = focus_candidate {
                shaped.pop();
                shaped.push(focus_candidate);
            }
        }
        if shaped.is_empty() {
            return None;
        }
        let mut request = Self {
            client_version: client_version.to_string(),
            session_client_id: session_client_id.to_string(),
            consent_to_process_chat: true,
            seq,
            utterance,
            focus_message_id: focus,
            candidates: shaped,
        };
        while request.body_bytes() > COHOST_COMMAND_MAX_BODY_BYTES {
            let drop_index = request
                .candidates
                .iter()
                .rposition(|candidate| {
                    request.focus_message_id.as_deref() != Some(candidate.id.as_str())
                })
                .filter(|_| request.candidates.len() > 1);
            request.candidates.remove(drop_index?);
        }
        Some(request)
    }

    fn body_bytes(&self) -> usize {
        serde_json::to_vec(self)
            .map(|body| body.len())
            .unwrap_or(usize::MAX)
    }

    /// The route's own limits, checked again by the client before it sends.
    pub fn validate(&self) -> std::result::Result<(), String> {
        let units = |value: &str| value.encode_utf16().count();
        if !self.consent_to_process_chat {
            return Err("consent to process chat is required".to_string());
        }
        let utterance = self.utterance.trim();
        if utterance.is_empty() || units(utterance) > COHOST_COMMAND_UTTERANCE_MAX_CHARS {
            return Err("the utterance must be 1 to 300 characters".to_string());
        }
        if self.candidates.is_empty() || self.candidates.len() > COHOST_COMMAND_MAX_CANDIDATES {
            return Err("there must be 1 to 20 candidates".to_string());
        }
        let mut ids = std::collections::HashSet::new();
        for candidate in &self.candidates {
            if shape_cohost_command_candidate(candidate.clone()).as_ref() != Some(candidate) {
                return Err(format!("candidate {} is out of shape", candidate.id));
            }
            if !ids.insert(candidate.id.as_str()) {
                return Err(format!("candidate {} is repeated", candidate.id));
            }
        }
        if let Some(focus) = self.focus_message_id.as_deref()
            && !ids.contains(focus)
        {
            return Err("the focus must be one of the candidates".to_string());
        }
        if self.body_bytes() > COHOST_COMMAND_MAX_BODY_BYTES {
            return Err("the body is larger than 16 KB".to_string());
        }
        Ok(())
    }
}

/// One candidate as the route accepts it, or `None` when it cannot be.
fn shape_cohost_command_candidate(
    candidate: CohostCommandCandidate,
) -> Option<CohostCommandCandidate> {
    let id = candidate.id.trim();
    if id.is_empty() || id.encode_utf16().count() > COHOST_COMMAND_ID_MAX_CHARS {
        return None;
    }
    let text = crate::cohost::truncate_utf16(candidate.text.trim(), COHOST_COMMAND_TEXT_MAX_CHARS)
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    let at = candidate.at.trim();
    if at.is_empty() || at.len() > 64 || chrono::DateTime::parse_from_rfc3339(at).is_err() {
        return None;
    }
    let author =
        crate::cohost::truncate_utf16(candidate.author.trim(), COHOST_COMMAND_AUTHOR_MAX_CHARS)
            .trim()
            .to_string();
    Some(CohostCommandCandidate {
        id: id.to_string(),
        author: if author.is_empty() {
            "Viewer".to_string()
        } else {
            author
        },
        text,
        at: at.to_string(),
    })
}

/// Raw probabilities; the desktop owns the thresholds (`cohost.rs`). Read
/// open: `usage` and any newer key are ignored, a missing `intent` reads as
/// an empty choice (nothing to do), and an unreadable target is skipped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandResponse {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub intent: CohostCommandIntent,
    #[serde(default, deserialize_with = "lenient_items")]
    pub targets: Vec<CohostCommandTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandIntent {
    /// `highlight`, `remove`, `clear` or `none`; an open string so a newer
    /// choice reads as "nothing to do" instead of failing the body.
    #[serde(default)]
    pub choice: String,
    #[serde(default)]
    pub probabilities: CohostCommandProbabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandProbabilities {
    #[serde(default)]
    pub highlight: f64,
    #[serde(default)]
    pub remove: f64,
    #[serde(default)]
    pub clear: f64,
    #[serde(default)]
    pub none: f64,
}

impl CohostCommandProbabilities {
    /// The probability of `choice`; 0 for a choice this build does not know.
    pub fn of(&self, choice: &str) -> f64 {
        match choice {
            "highlight" => self.highlight,
            "remove" => self.remove,
            "clear" => self.clear,
            "none" => self.none,
            _ => 0.0,
        }
    }
}

/// "Is the streamer pointing at this comment?" for one candidate. A
/// candidate the server could not judge is absent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandTarget {
    pub message_id: String,
    #[serde(default)]
    pub probability: f64,
}

/// Every failed tick outcome: the classification the engine acts on
/// (`kind` → status/backoff, `reason()` → renderer reason) plus the server's
/// own diagnosis (`detail`) that rides `cohost.state` so "AI returned an
/// error" is never the whole story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostApiError {
    pub kind: CohostApiErrorKind,
    pub detail: CohostErrorDetail,
}

/// Classified from the error envelope code first and the HTTP status second.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CohostApiErrorKind {
    /// 401: the stored bearer no longer works (session expired/rotated).
    Unauthorized,
    /// 403 `premium-required` (and any other 403: ops blocklist).
    PremiumRequired,
    /// 400 `consent-required`.
    ConsentRequired,
    /// 400 `prompt-version-unsupported`: this build is behind the server.
    PromptVersionUnsupported,
    /// 400 `invalid-request`: a desktop-side request bug (zod rejection).
    InvalidRequest,
    /// 429 `quota-exhausted` (+ Retry-After seconds when the server sent one).
    QuotaExhausted {
        retry_after: Option<std::time::Duration>,
    },
    /// 503 `ai-gateway-not-configured` | `cohost-disabled`.
    ServerUnconfigured,
    /// 502 `ai-gateway-error` and any other server failure.
    GatewayError,
    /// Transport failure (`network`) or the tick timeout (`timeout`).
    Network,
    /// 200 with a body that does not match the contract.
    MalformedResponse,
}

/// Detail codes the desktop assigns itself when no server envelope exists.
pub const COHOST_DETAIL_CODE_NETWORK: &str = "network";
pub const COHOST_DETAIL_CODE_TIMEOUT: &str = "timeout";
pub const COHOST_DETAIL_CODE_MALFORMED_RESPONSE: &str = "malformed-response";

impl CohostApiError {
    pub fn reason(&self) -> CohostReason {
        match self.kind {
            CohostApiErrorKind::Unauthorized => CohostReason::SessionExpired,
            CohostApiErrorKind::PremiumRequired => CohostReason::PremiumRequired,
            CohostApiErrorKind::ConsentRequired => CohostReason::ConsentRequired,
            CohostApiErrorKind::PromptVersionUnsupported
            | CohostApiErrorKind::ServerUnconfigured => CohostReason::ServerUnconfigured,
            CohostApiErrorKind::QuotaExhausted { .. } => CohostReason::QuotaExhausted,
            CohostApiErrorKind::InvalidRequest
            | CohostApiErrorKind::GatewayError
            | CohostApiErrorKind::MalformedResponse => CohostReason::GatewayError,
            CohostApiErrorKind::Network => CohostReason::Network,
        }
    }

    pub fn message(&self) -> &str {
        &self.detail.message
    }

    /// A transport failure before any HTTP status existed.
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::Network,
            detail: CohostErrorDetail::new(COHOST_DETAIL_CODE_NETWORK, message, None),
        }
    }

    /// The request outlived `COHOST_TICK_TIMEOUT`.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::Network,
            detail: CohostErrorDetail::new(COHOST_DETAIL_CODE_TIMEOUT, message, None),
        }
    }

    /// A success status whose body does not match the tick contract.
    pub fn malformed_response(status: u16, message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::MalformedResponse,
            detail: CohostErrorDetail::new(
                COHOST_DETAIL_CODE_MALFORMED_RESPONSE,
                message,
                Some(status),
            ),
        }
    }

    pub(crate) fn from_transport(error: reqwest::Error) -> Self {
        Self::from_transport_within(error, COHOST_TICK_TIMEOUT)
    }

    fn from_transport_within(error: reqwest::Error, timeout: std::time::Duration) -> Self {
        if error.is_timeout() {
            Self::timeout(format!(
                "Golem did not answer within {} s.",
                timeout.as_secs()
            ))
        } else {
            Self::network(format!("Could not reach Golem: {error}"))
        }
    }
}

/// `Retry-After` as delay-seconds. HTTP-date forms are not parsed; the engine
/// falls back to its default quota pause.
pub(crate) fn parse_retry_after_seconds(value: Option<&str>) -> Option<std::time::Duration> {
    value
        .map(str::trim)
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_secs)
}

pub(crate) fn classify_cohost_failure(
    status: u16,
    code: &str,
    message: String,
    retry_after: Option<&str>,
) -> CohostApiError {
    let kind = match code {
        "unauthorized" => CohostApiErrorKind::Unauthorized,
        "premium-required" => CohostApiErrorKind::PremiumRequired,
        "consent-required" => CohostApiErrorKind::ConsentRequired,
        "prompt-version-unsupported" => CohostApiErrorKind::PromptVersionUnsupported,
        "invalid-request" => CohostApiErrorKind::InvalidRequest,
        "quota-exhausted" => CohostApiErrorKind::QuotaExhausted {
            retry_after: parse_retry_after_seconds(retry_after),
        },
        "ai-gateway-not-configured" | "cohost-disabled" => CohostApiErrorKind::ServerUnconfigured,
        _ => match status {
            401 => CohostApiErrorKind::Unauthorized,
            403 => CohostApiErrorKind::PremiumRequired,
            400 => CohostApiErrorKind::InvalidRequest,
            429 => CohostApiErrorKind::QuotaExhausted {
                retry_after: parse_retry_after_seconds(retry_after),
            },
            503 => CohostApiErrorKind::ServerUnconfigured,
            _ => CohostApiErrorKind::GatewayError,
        },
    };
    CohostApiError {
        kind,
        detail: CohostErrorDetail::new(code, message, Some(status)),
    }
}

/// A thin client over the Videorc web API.
#[derive(Clone)]
pub struct VideorcApiClient {
    base_url: String,
    http: reqwest::Client,
}

impl VideorcApiClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            base_url: api_base_url(),
            http: reqwest::Client::builder()
                .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .context("Could not build the Videorc API HTTP client.")?,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    async fn get_bearer_json<T: DeserializeOwned>(
        &self,
        path: &str,
        bearer_token: &str,
    ) -> Result<T> {
        let response = self
            .http
            .get(self.endpoint(path))
            .bearer_auth(bearer_token)
            .send()
            .await
            .with_context(|| format!("Could not reach Videorc API path {path}."))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }

        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc API request failed ({status}): {message}");
        }

        response
            .json()
            .await
            .with_context(|| format!("Could not read Videorc API response for {path}."))
    }

    /// Exchange an encrypted, state + PKCE-bound desktop authorization code for
    /// a durable Better Auth session token and account identity.
    pub async fn verify_desktop_authorization(
        &self,
        code: &str,
        state: &str,
        verifier: &str,
    ) -> Result<VerifiedSession> {
        let response = self
            .http
            .post(self.endpoint("/api/desktop/session/verify"))
            .timeout(DESKTOP_AUTH_EXCHANGE_TIMEOUT)
            .json(&serde_json::json!({
                "code": code,
                "state": state,
                "verifier": verifier,
            }))
            .send()
            .await
            .context("Could not reach the Videorc sign-in service.")?;

        if !response.status().is_success() {
            bail!(
                "Desktop authorization exchange failed ({}).",
                response.status()
            );
        }

        let body: VerifyResponse = response
            .json()
            .await
            .context("Could not read the sign-in response.")?;

        Ok(VerifiedSession {
            session_token: body.session.token,
            name: body.user.name,
            email: body.user.email,
            image: body.user.image,
        })
    }

    /// Validate the stored Bearer token and fetch the current account identity.
    /// A rotated token is captured from the `set-auth-token` response header (the
    /// bearer plugin emits it when the session token is refreshed) so callers can
    /// persist it and avoid a future 401.
    pub async fn get_session(&self, bearer_token: &str) -> Result<SessionRefresh> {
        let response = self
            .http
            .get(self.endpoint("/api/auth/get-session"))
            .bearer_auth(bearer_token)
            .send()
            .await
            .context("Could not reach the Videorc session service.")?;

        let rotated_token = response
            .headers()
            .get("set-auth-token")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(SessionRefresh {
                status: SessionStatus::Unauthorized,
                rotated_token,
            });
        }
        if !response.status().is_success() {
            bail!("Session check failed ({}).", response.status());
        }

        // get-session returns the session object, or null once the token is dead.
        let body: Option<GetSessionResponse> = response
            .json()
            .await
            .context("Could not read the session response.")?;

        let status = match body {
            Some(session) => SessionStatus::Active {
                name: session.user.name,
                email: session.user.email,
                image: session.user.image,
            },
            None => SessionStatus::Unauthorized,
        };
        Ok(SessionRefresh {
            status,
            rotated_token,
        })
    }

    /// Fetch safe client-facing AI capability metadata for the signed-in user.
    pub async fn get_ai_capabilities(&self, bearer_token: &str) -> Result<AiCapabilities> {
        let path = "/api/ai/capabilities";
        let response = self
            .http
            .get(self.endpoint(path))
            .bearer_auth(bearer_token)
            .timeout(AI_CAPABILITIES_REQUEST_TIMEOUT)
            .send()
            .await
            .with_context(|| format!("Could not reach Videorc API path {path}."))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }
        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc API request failed ({status}): {message}");
        }
        response
            .json()
            .await
            .with_context(|| format!("Could not read Videorc API response for {path}."))
    }

    /// One synchronous Live Co-host tick. Every failure class is mapped to a
    /// `CohostApiError` so the engine can pause/back off with an honest reason.
    pub async fn post_cohost_tick(
        &self,
        bearer_token: &str,
        request: &CohostTickRequest,
    ) -> std::result::Result<CohostTickResponse, CohostApiError> {
        let response = self
            .http
            .post(self.endpoint(COHOST_TICK_PATH))
            .bearer_auth(bearer_token)
            .json(request)
            .timeout(COHOST_TICK_TIMEOUT)
            .send()
            .await
            .map_err(CohostApiError::from_transport)?;

        let status = response.status();
        if status.is_success() {
            return response.json().await.map_err(|error| {
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read Golem's response: {error}"),
                )
            });
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_cohost_failure(
            status.as_u16(),
            &code,
            message,
            retry_after.as_deref(),
        ))
    }

    /// One spotlight call (plan 060 S3). Same failure mapping as the tick so
    /// the engine's breaker can read the envelope code and the HTTP status;
    /// the lane itself decides what each class means (never a paused engine).
    pub async fn post_cohost_spotlight(
        &self,
        bearer_token: &str,
        request: &CohostSpotlightRequest,
    ) -> std::result::Result<CohostSpotlightResponse, CohostApiError> {
        let response = self
            .http
            .post(self.endpoint(COHOST_SPOTLIGHT_PATH))
            .bearer_auth(bearer_token)
            .json(request)
            .timeout(COHOST_SPOTLIGHT_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                CohostApiError::from_transport_within(error, COHOST_SPOTLIGHT_TIMEOUT)
            })?;

        let status = response.status();
        if status.is_success() {
            return response.json().await.map_err(|error| {
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read Golem's spotlight response: {error}"),
                )
            });
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_cohost_failure(
            status.as_u16(),
            &code,
            message,
            retry_after.as_deref(),
        ))
    }

    /// One Golem command parse (plan 140 S8). Same auth, client version and
    /// failure mapping as the spotlight; a request out of the route's shape
    /// is refused here, before anything is sent.
    pub async fn post_cohost_command(
        &self,
        bearer_token: &str,
        request: &CohostCommandRequest,
    ) -> std::result::Result<CohostCommandResponse, CohostApiError> {
        self.post_cohost_command_within(bearer_token, request, COHOST_COMMAND_TIMEOUT)
            .await
    }

    async fn post_cohost_command_within(
        &self,
        bearer_token: &str,
        request: &CohostCommandRequest,
        timeout: std::time::Duration,
    ) -> std::result::Result<CohostCommandResponse, CohostApiError> {
        if let Err(problem) = request.validate() {
            return Err(CohostApiError {
                kind: CohostApiErrorKind::InvalidRequest,
                detail: CohostErrorDetail::new(
                    "invalid-request",
                    format!("Golem did not send the command: {problem}."),
                    None,
                ),
            });
        }
        let response = self
            .http
            .post(self.endpoint(COHOST_COMMAND_PATH))
            .bearer_auth(bearer_token)
            .json(request)
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| CohostApiError::from_transport_within(error, timeout))?;

        let status = response.status();
        if status.is_success() {
            return response.json().await.map_err(|error| {
                if error.is_timeout() {
                    return CohostApiError::from_transport_within(error, timeout);
                }
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read Golem's command response: {error}"),
                )
            });
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_cohost_failure(
            status.as_u16(),
            &code,
            message,
            retry_after.as_deref(),
        ))
    }

    /// One avatar generation (plan 164 S-A6): the tick's failure mapping, a
    /// 95 s timeout and an 8 MB cap on the body read before it is parsed.
    pub async fn post_cohost_avatar(
        &self,
        bearer_token: &str,
        request: &CohostAvatarRequest,
    ) -> std::result::Result<CohostAvatarResponse, CohostApiError> {
        let response = self
            .http
            .post(self.endpoint(COHOST_AVATAR_PATH))
            .bearer_auth(bearer_token)
            .json(request)
            .timeout(COHOST_AVATAR_TIMEOUT)
            .send()
            .await
            .map_err(|error| CohostApiError::from_transport_within(error, COHOST_AVATAR_TIMEOUT))?;

        let status = response.status();
        if status.is_success() {
            if response
                .content_length()
                .is_some_and(|length| length > COHOST_AVATAR_MAX_RESPONSE_BYTES as u64)
            {
                return Err(CohostApiError::malformed_response(
                    status.as_u16(),
                    "The generated image is over 8 MB.",
                ));
            }
            let body = response.bytes().await.map_err(|error| {
                if error.is_timeout() {
                    return CohostApiError::from_transport_within(error, COHOST_AVATAR_TIMEOUT);
                }
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read the generated image: {error}"),
                )
            })?;
            if body.len() > COHOST_AVATAR_MAX_RESPONSE_BYTES {
                return Err(CohostApiError::malformed_response(
                    status.as_u16(),
                    "The generated image is over 8 MB.",
                ));
            }
            return serde_json::from_slice(&body).map_err(|error| {
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read the avatar response: {error}"),
                )
            });
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_cohost_failure(
            status.as_u16(),
            &code,
            message,
            retry_after.as_deref(),
        ))
    }

    /// Fetch safe client-facing AI quota metadata for the signed-in user.
    pub async fn get_ai_quota(&self, bearer_token: &str) -> Result<AiQuotaStatus> {
        self.get_bearer_json("/api/ai/quota", bearer_token).await
    }

    /// Transcribe one live-caption chunk (16kHz mono WAV, ~3s). Errors are
    /// split into terminal (premium required, quota exhausted, signed out,
    /// captions disabled — stop the session) and transient (retry/skip).
    pub async fn transcribe_caption_chunk(
        &self,
        bearer_token: &str,
        session_client_id: &str,
        wav: Vec<u8>,
        language: Option<&str>,
        purpose: CaptionChunkPurpose,
    ) -> std::result::Result<CaptionChunkResponse, CaptionChunkFailure> {
        let file_part = multipart::Part::bytes(wav)
            .file_name("videorc-caption-chunk.wav")
            .mime_str("audio/wav")
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not build the caption upload: {error}"),
            })?;
        let mut form = multipart::Form::new()
            .text("sessionClientId", session_client_id.to_string())
            .text("purpose", purpose.as_str())
            .part("audio", file_part);
        if let Some(language) = language {
            form = form.text("language", language.to_string());
        }

        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/chunks"))
            .bearer_auth(bearer_token)
            .multipart(form)
            // A hung upload must become a retryable failure, not a stalled
            // caption loop (R0) — chunks are ~3s of audio, 10s is generous.
            .timeout(CAPTION_CHUNK_UPLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not reach the caption service: {error}"),
            })?;

        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .map_err(|error| CaptionChunkFailure::Transient {
                    code: None,
                    message: format!("Could not read the caption response: {error}"),
                });
        }

        let (code, message) = read_error_code_and_message(response).await;
        let failure = classify_caption_failure(status.as_u16(), code, message);
        Err(failure)
    }

    /// Mint a short-lived gateway realtime client secret for streaming
    /// captions. `Terminal` failures end the caption session (auth/premium/
    /// quota); `Transient` ones mean "fall back to chunked transcription".
    pub async fn mint_caption_realtime_token(
        &self,
        bearer_token: &str,
        session_client_id: &str,
    ) -> std::result::Result<CaptionRealtimeToken, CaptionChunkFailure> {
        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/realtime-token"))
            .bearer_auth(bearer_token)
            .json(&serde_json::json!({ "sessionClientId": session_client_id }))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not reach the caption service: {error}"),
            })?;

        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .map_err(|error| CaptionChunkFailure::Transient {
                    code: None,
                    message: format!("Could not read the streaming token: {error}"),
                });
        }
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_caption_failure(status.as_u16(), code, message))
    }

    /// Exchange the stored account session for a Windows pilot update token.
    /// `Ok(None)` when the web declines (signed out or pilot closed).
    pub async fn mint_windows_pilot_update_token(
        &self,
        bearer_token: &str,
    ) -> Result<Option<WindowsPilotUpdateToken>> {
        let response = self
            .http
            .post(self.endpoint(WINDOWS_PILOT_UPDATE_TOKEN_PATH))
            .bearer_auth(bearer_token)
            .timeout(WINDOWS_PILOT_UPDATE_TOKEN_TIMEOUT)
            .send()
            .await
            .context("Could not reach the Videorc update service.")?;
        let status = response.status();
        if windows_pilot_update_token_refused(status.as_u16()) {
            return Ok(None);
        }
        if !status.is_success() {
            bail!("Windows pilot update token request failed ({status}).");
        }
        let token: WindowsPilotUpdateToken = response
            .json()
            .await
            .context("Could not read the Windows pilot update token.")?;
        if !valid_windows_pilot_update_token(&token.token) {
            bail!("The Windows pilot update token was malformed.");
        }
        Ok(Some(token))
    }

    /// Report streamed caption seconds against the monthly allowance.
    /// Best-effort — accounting failures never interrupt captions.
    pub async fn report_caption_usage(
        &self,
        bearer_token: &str,
        session_client_id: &str,
        seconds: u64,
    ) -> Result<()> {
        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/usage"))
            .bearer_auth(bearer_token)
            .json(&serde_json::json!({
                "sessionClientId": session_client_id,
                "seconds": seconds,
            }))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .context("Could not reach the caption usage service.")?;
        if !response.status().is_success() {
            bail!("Caption usage report failed ({}).", response.status());
        }
        Ok(())
    }

    // --- Clean cut (plan 119; docs/clean-cut-contract.md) --------------------

    /// One verbatim, word-timed transcript chunk (contract part A). The WAV
    /// is canonical PCM s16le mono 16 kHz, at most 120 s and 4 000 000 bytes.
    /// Every failure keeps the server's `error.code`, so the job can tell a
    /// used-up allowance from a network blip.
    pub async fn transcribe_transcript_chunk(
        &self,
        bearer_token: &str,
        request: TranscriptChunkRequest,
    ) -> std::result::Result<TranscriptChunkResponse, AiApiFailure> {
        let file_part = multipart::Part::bytes(request.wav)
            .file_name(format!("clean-cut-chunk-{}.wav", request.chunk_index))
            .mime_str("audio/wav")
            .map_err(|error| AiApiFailure::Transport {
                message: format!("Could not build the transcript chunk upload: {error}"),
            })?;
        let mut form = multipart::Form::new()
            .text("sessionClientId", request.session_client_id)
            .text("chunkIndex", request.chunk_index.to_string())
            .text("chunkStartMs", request.chunk_start_ms.to_string())
            .part("audio", file_part);
        if let Some(language) = request.language {
            form = form.text("language", language);
        }

        let response = self
            .http
            .post(self.endpoint(TRANSCRIPT_CHUNKS_PATH))
            .bearer_auth(bearer_token)
            .multipart(form)
            .timeout(TRANSCRIPT_CHUNK_UPLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| AiApiFailure::Transport {
                message: format!("Could not reach the transcription service: {error}"),
            })?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<TranscriptChunkResponse>()
                .await
                .map_err(|error| AiApiFailure::Transport {
                    message: format!("Could not read the transcript chunk response: {error}"),
                });
        }
        let (code, message) = read_error_code_and_message(response).await;
        Err(AiApiFailure::Http {
            status: status.as_u16(),
            code,
            message,
        })
    }

    /// `POST /api/ai/jobs` keeping the error envelope's code. The publish
    /// path's `create_ai_job` flattens the code into a message and stays as
    /// it is.
    pub async fn create_ai_job_checked(
        &self,
        bearer_token: &str,
        body: &serde_json::Value,
    ) -> std::result::Result<AiJobPollSnapshot, AiApiFailure> {
        let response = self
            .http
            .post(self.endpoint("/api/ai/jobs"))
            .bearer_auth(bearer_token)
            .json(body)
            .timeout(AI_JOB_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| AiApiFailure::Transport {
                message: format!("Could not reach the Videorc AI job service: {error}"),
            })?;
        read_ai_job_poll_response(response).await
    }

    /// `GET /api/ai/jobs/{id}` as a lenient snapshot: only the fields the
    /// Clean cut poller reads, every one of them defaulted.
    pub async fn get_ai_job_checked(
        &self,
        bearer_token: &str,
        job_id: &str,
    ) -> std::result::Result<AiJobPollSnapshot, AiApiFailure> {
        let response = self
            .http
            .get(self.endpoint(&format!("/api/ai/jobs/{job_id}")))
            .bearer_auth(bearer_token)
            .timeout(AI_JOB_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| AiApiFailure::Transport {
                message: format!("Could not reach the Videorc AI job service: {error}"),
            })?;
        read_ai_job_poll_response(response).await
    }
}

const TRANSCRIPT_CHUNKS_PATH: &str = "/api/ai/transcripts/chunks";
// A 120 s chunk is under 4 MB; a provider call sits behind the upload.
const TRANSCRIPT_CHUNK_UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
const AI_JOB_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn read_ai_job_poll_response(
    response: reqwest::Response,
) -> std::result::Result<AiJobPollSnapshot, AiApiFailure> {
    let status = response.status();
    if status.is_success() {
        let envelope: AiJobPollEnvelope =
            response
                .json()
                .await
                .map_err(|error| AiApiFailure::Transport {
                    message: format!("Could not read the Videorc AI job response: {error}"),
                })?;
        return Ok(envelope.job);
    }
    let (code, message) = read_error_code_and_message(response).await;
    Err(AiApiFailure::Http {
        status: status.as_u16(),
        code,
        message,
    })
}

/// A failed `/api/ai/*` call with the envelope's code kept whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiApiFailure {
    /// The server answered with `{ error: { code, message } }` (or a body that
    /// was not the envelope: then `code` is `unknown`).
    Http {
        status: u16,
        code: String,
        message: String,
    },
    /// No usable answer: network, timeout, or an unreadable body.
    Transport { message: String },
}

impl AiApiFailure {
    /// Worth another attempt after a pause: the network, a timeout or a
    /// server-side failure. Quota, auth, consent and validation answers are
    /// final until something changes.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Transport { .. } => true,
            Self::Http { status, .. } => *status >= 500 || *status == 408,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Http { message, .. } | Self::Transport { message } => message.as_str(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TranscriptChunkRequest {
    pub session_client_id: String,
    pub chunk_index: u32,
    pub chunk_start_ms: u64,
    pub language: Option<String>,
    pub wav: Vec<u8>,
}

/// One word of a transcript chunk, timed relative to the chunk start. Times
/// are read as numbers (the contract says integers; a provider rounding slip
/// must not fail a whole chunk).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptChunkWord {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filler: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptChunkResponse {
    #[serde(default)]
    pub chunk_index: u32,
    #[serde(default)]
    pub chunk_seconds: f64,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub words: Vec<TranscriptChunkWord>,
    #[serde(default)]
    pub remaining_seconds: Option<u64>,
    #[serde(default)]
    pub monthly_seconds_limit: Option<u64>,
}

/// The owner job snapshot as the Clean cut poller reads it (contract part C).
/// Publish-pack fields are ignored; nothing here is required.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobPollSnapshot {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub workflow_kind: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub artifacts: Option<AiJobPollArtifacts>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobPollArtifacts {
    /// `artifacts.cleanCut`: present only once the job is completed.
    #[serde(default)]
    pub clean_cut: Option<serde_json::Value>,
    /// `artifacts.cleanCutProgress`: present while the job runs.
    #[serde(default)]
    pub clean_cut_progress: Option<AiJobCleanCutProgress>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiJobCleanCutProgress {
    #[serde(default)]
    pub windows: AiJobCleanCutWindows,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiJobCleanCutWindows {
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub completed: u32,
}

#[derive(Deserialize)]
struct AiJobPollEnvelope {
    job: AiJobPollSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionChunkResponse {
    pub text: String,
    pub chunk_seconds: u64,
    pub remaining_seconds: u64,
    #[allow(dead_code)]
    pub monthly_seconds_limit: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub latency_ms: Option<u64>,
    #[allow(dead_code)]
    pub model: String,
    /// Word timing within this chunk (empty on older web deploys).
    #[serde(default)]
    pub segments: Vec<crate::captions::CaptionSegment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionRealtimeToken {
    pub token: String,
    pub url: String,
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub model: String,
    #[serde(default)]
    pub remaining_seconds: Option<u64>,
}

/// Which allowance one transcription chunk is metered against (plan 068 D5).
/// `Captions` wins while captions present: one upload, one charge. `Listen`
/// is Golem's own bucket and an old chunk route ignores the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionChunkPurpose {
    Captions,
    Listen,
}

impl CaptionChunkPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Captions => "captions",
            Self::Listen => "listen",
        }
    }
}

/// Terminal codes that end only Golem's listen intent (plan 068 D5): the
/// listen allowance is separate from captions, so a presenting caption
/// session keeps going when one of these arrives.
pub fn is_listen_block_code(code: &str) -> bool {
    matches!(code, "listen-monthly-quota-exhausted" | "listen-disabled")
}

/// Terminal codes a caption-metered request (a `captions` chunk, the realtime
/// token) gets for captions alone: the caption allowance, or the captions
/// switch. The web answers `ai-disabled` for its global AI switch as well; a
/// listen chunk that follows tells the two apart. Premium, sign-in, the
/// account blocklist and server configuration apply to listening too.
pub fn is_caption_scoped_code(code: &str) -> bool {
    matches!(code, "captions-monthly-quota-exhausted" | "ai-disabled")
}

#[derive(Debug, Clone)]
pub enum CaptionChunkFailure {
    /// Stop the caption session and surface the reason (premium required,
    /// quota exhausted, signed out, captions disabled).
    Terminal { code: String, message: String },
    /// Skip this chunk; the session keeps going (network blip, 5xx).
    Transient {
        code: Option<String>,
        message: String,
    },
}

fn classify_caption_failure(status: u16, code: String, message: String) -> CaptionChunkFailure {
    let terminal = matches!(
        code.as_str(),
        "cloud-ai-premium-required"
            | "captions-monthly-quota-exhausted"
            | "listen-monthly-quota-exhausted"
            | "listen-disabled"
            | "ai-user-disabled"
            | "ai-disabled"
            | "ai-transcription-not-configured"
            | "captions-config-missing"
            | "unauthorized"
    ) || status == 401
        || status == 403
        || status == 429;
    if terminal {
        CaptionChunkFailure::Terminal { code, message }
    } else {
        CaptionChunkFailure::Transient {
            code: Some(code),
            message: format!("caption chunk failed ({status}): {message}"),
        }
    }
}

pub(crate) async fn read_error_code_and_message(response: reqwest::Response) -> (String, String) {
    let text = response.text().await.unwrap_or_default();
    parse_error_envelope(&text)
}

/// `{ error: { code, message } }` → `(code, message)` with honest fallbacks:
/// `unknown` / `request failed` when the body is not the envelope (HTML from
/// a proxy, an empty body, a different JSON shape) or a part is blank.
pub(crate) fn parse_error_envelope(text: &str) -> (String, String) {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<String>,
        message: Option<String>,
    }

    let body = serde_json::from_str::<ErrorEnvelope>(text)
        .ok()
        .and_then(|envelope| envelope.error);
    (
        body.as_ref()
            .and_then(|error| error.code.as_deref())
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string()),
        body.and_then(|error| error.message)
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "request failed".to_string()),
    )
}

async fn read_safe_error_message(response: reqwest::Response) -> String {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        message: Option<String>,
    }

    match response.text().await {
        Ok(text) => serde_json::from_str::<ErrorEnvelope>(&text)
            .ok()
            .and_then(|envelope| envelope.error.and_then(|error| error.message))
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "request failed".to_string()),
        Err(_) => "request failed".to_string(),
    }
}

#[derive(Deserialize)]
struct VerifyResponse {
    session: VerifySession,
    user: VerifyUser,
}

#[derive(Deserialize)]
struct VerifySession {
    token: String,
}

#[derive(Deserialize)]
struct VerifyUser {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
    email: String,
}

#[derive(Deserialize)]
struct GetSessionResponse {
    user: VerifyUser,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_pin_the_production_base_url() {
        assert_eq!(
            resolve_api_base_url(false, Some("http://localhost:3000")),
            PRODUCTION_API_BASE_URL
        );
        assert_eq!(resolve_api_base_url(false, None), PRODUCTION_API_BASE_URL);
    }

    #[test]
    fn dev_builds_default_to_localhost_and_honor_the_env_override() {
        assert_eq!(
            resolve_api_base_url(true, Some("http://localhost:3000/")),
            "http://localhost:3000"
        );
        assert_eq!(resolve_api_base_url(true, Some("   ")), DEV_API_BASE_URL);
        assert_eq!(resolve_api_base_url(true, None), DEV_API_BASE_URL);
    }

    #[test]
    fn entitlement_capability_request_finishes_before_the_rpc_deadline() {
        assert!(!AI_CAPABILITIES_REQUEST_TIMEOUT.is_zero());
        // Headroom over the 8 s cadence floor (a model ladder can take longer),
        // but well under the updater/RPC deadlines; see cohost.rs for the
        // min-gap interaction test.
        assert_eq!(COHOST_TICK_TIMEOUT.as_secs(), 12);
        assert!(AI_CAPABILITIES_REQUEST_TIMEOUT < std::time::Duration::from_secs(10));
    }

    #[test]
    fn windows_pilot_update_token_refusals_and_shape() {
        for status in [401, 403, 404, 409] {
            assert!(windows_pilot_update_token_refused(status), "{status}");
        }
        for status in [200, 400, 429, 500, 502] {
            assert!(!windows_pilot_update_token_refused(status), "{status}");
        }
        assert!(valid_windows_pilot_update_token(
            "wpu1.1790000000.abcdefghijklmnopqrstuvwx.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
        ));
        for invalid in [
            "",
            "Bearer wpu1.1.a.b",
            "wpu2.1.a.b",
            "wpu1.1.a b.c",
            "wpu1.1.a\nb.c",
            &format!("wpu1.{}", "x".repeat(600)),
        ] {
            assert!(!valid_windows_pilot_update_token(invalid), "{invalid:?}");
        }
        let token: WindowsPilotUpdateToken = serde_json::from_str(
            r#"{"token":"wpu1.1.a.b","expiresAt":"2026-09-23T13:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(token.expires_at, "2026-09-23T13:00:00.000Z");
        assert_eq!(
            serde_json::to_value(&token).unwrap(),
            serde_json::json!({"token":"wpu1.1.a.b","expiresAt":"2026-09-23T13:00:00.000Z"})
        );
        assert!(WINDOWS_PILOT_UPDATE_TOKEN_TIMEOUT < std::time::Duration::from_secs(30));
    }

    #[test]
    fn endpoint_joins_paths_without_double_slashes() {
        let client = VideorcApiClient {
            base_url: "https://videorc.com".to_string(),
            http: reqwest::Client::new(),
        };
        assert_eq!(
            client.endpoint("/api/auth/one-time-token/verify"),
            "https://videorc.com/api/auth/one-time-token/verify"
        );
        assert_eq!(
            client.endpoint("api/ai/capabilities"),
            "https://videorc.com/api/ai/capabilities"
        );
    }

    #[test]
    fn verify_response_parses_the_session_token_and_user_identity() {
        let json = r#"{"session":{"token":"sess_abc","expiresAt":"2026-07-01T00:00:00Z"},"user":{"id":"u1","name":"Orc Dev","email":"orc@videorc.com"}}"#;
        let parsed: VerifyResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.session.token, "sess_abc");
        assert_eq!(parsed.user.email, "orc@videorc.com");
        assert_eq!(parsed.user.name.as_deref(), Some("Orc Dev"));
    }

    #[test]
    fn ai_capabilities_response_parses_safe_metadata() {
        let json = r#"{
            "entitlement":{"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},
            "features":{"cloudAiEnabled":true,"gatewayConfigured":true,"modelTestingEnabled":true,"multipartAudioJobsEnabled":true,"objectBackedJobsEnabled":false,"transcriptJobsEnabled":true,"uploadTicketsEnabled":false},
            "generatedAt":"2026-06-15T12:30:00.000Z",
            "limits":{"dailyJobs":25,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"maxOutputTokens":1900,"maxTranscriptCharacters":90000,"monthlyJobs":600},
            "models":{"allowedTextModelCount":2,"allowedTextModelsConfigured":true,"defaultTextModel":"openai/gpt-5.5","fallbackTextModels":["google/gemini"]},
            "objectStorage":{"deleteConfigured":false,"downloadConfigured":false,"provider":null,"providerError":null,"proofConfigured":false,"proofTtlMs":null,"uploadConfigured":false},
            "readiness":{"access":{"cloudAiEntitled":true,"globallyDisabled":false},"gateway":{"configError":null,"configured":true},"objectStorage":{"deleteConfigError":null,"downloadConfigError":null,"proofConfigError":null,"providerError":null,"uploadConfigError":null},"transcription":{"configError":null,"configured":true}},
            "transcription":{"configured":true,"configError":null,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"requestTimeoutMs":65000},
            "workflow":{"inputModes":[{"enabled":true,"kind":"transcript"},{"enabled":true,"kind":"multipart-audio"}],"kind":"post-recording-publish-pack","outputs":["summary"]}
        }"#;
        let parsed: AiCapabilities = serde_json::from_str(json).unwrap();
        assert!(parsed.features.cloud_ai_enabled);
        assert_eq!(parsed.workflow.input_modes[1].kind, "multipart-audio");
        assert_eq!(parsed.limits.max_audio_megabytes, Some(12.5));
        assert!(
            parsed.captions.is_none(),
            "older web deployments remain compatible during rollout"
        );
    }

    #[test]
    fn ai_capabilities_cohost_block_is_optional_and_parses_the_avatar_cap() {
        let without: AiCapabilities = serde_json::from_str(
            r#"{"entitlement":{"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},"features":{"cloudAiEnabled":true,"gatewayConfigured":true,"modelTestingEnabled":true,"multipartAudioJobsEnabled":true,"objectBackedJobsEnabled":false,"transcriptJobsEnabled":true,"uploadTicketsEnabled":false},"generatedAt":"2026-06-15T12:30:00.000Z","limits":{"dailyJobs":25,"maxAudioBytes":null,"maxAudioMegabytes":null,"maxOutputTokens":null,"maxTranscriptCharacters":90000,"monthlyJobs":600},"models":{"allowedTextModelCount":2,"allowedTextModelsConfigured":true,"defaultTextModel":null,"fallbackTextModels":[]},"objectStorage":{"deleteConfigured":false,"downloadConfigured":false,"provider":null,"providerError":null,"proofConfigured":false,"proofTtlMs":null,"uploadConfigured":false},"readiness":{"access":{"cloudAiEntitled":true,"globallyDisabled":false},"gateway":{"configError":null,"configured":true},"objectStorage":{"deleteConfigError":null,"downloadConfigError":null,"proofConfigError":null,"providerError":null,"uploadConfigError":null},"transcription":{"configError":null,"configured":true}},"transcription":{"configured":true,"configError":null,"maxAudioBytes":null,"maxAudioMegabytes":null,"requestTimeoutMs":65000},"workflow":{"inputModes":[],"kind":"post-recording-publish-pack","outputs":[]}}"#,
        )
        .unwrap();
        assert!(
            without.cohost.is_none(),
            "older web deployments omit the block"
        );
        // Omitted on the way out too, never null (the renderer contract).
        assert!(
            serde_json::to_value(&without)
                .unwrap()
                .get("cohost")
                .is_none()
        );
        let mut value = serde_json::to_value(&without).unwrap();
        value["cohost"] = serde_json::json!({
            "tick": 4,
            "avatar": { "enabled": true, "remainingToday": 23, "dailyLimit": 24 }
        });
        let with: AiCapabilities = serde_json::from_value(value).unwrap();
        let cohost = with.cohost.unwrap();
        assert_eq!(cohost.tick, Some(4));
        let avatar = cohost.avatar.unwrap();
        assert!(avatar.enabled);
        assert_eq!((avatar.remaining_today, avatar.daily_limit), (23, 24));
    }

    #[test]
    fn ai_capabilities_captions_readiness_survives_proxy_round_trip() {
        let input = serde_json::json!({
            "captions": {
                "available": true,
                "chunked": {
                    "available": true,
                    "configured": true,
                    "model": "xai/grok-stt"
                },
                "monthlySecondsLimit": 180000,
                "preferredTransport": "realtime",
                "realtime": {
                    "available": true,
                    "configured": true,
                    "disabled": false,
                    "model": "xai/grok-voice-think-fast-1.0"
                },
                "remainingSeconds": 179940,
                "reasonCode": "ready-realtime"
            },
            "entitlement": {
                "checkedAt": "2026-07-11T12:00:00.000Z",
                "cloudAi": true,
                "expiresAt": "2026-07-11T12:05:00.000Z",
                "isPremium": true,
                "subscriptionStatus": "active",
                "tier": "premium"
            },
            "features": {
                "cloudAiEnabled": true,
                "gatewayConfigured": true,
                "modelTestingEnabled": true,
                "multipartAudioJobsEnabled": true,
                "objectBackedJobsEnabled": false,
                "transcriptJobsEnabled": true,
                "uploadTicketsEnabled": false
            },
            "generatedAt": "2026-07-11T12:00:00.000Z",
            "limits": {
                "dailyJobs": 25,
                "maxAudioBytes": 13107200,
                "maxAudioMegabytes": 12.5,
                "maxOutputTokens": 1900,
                "maxTranscriptCharacters": 90000,
                "monthlyJobs": 600
            },
            "models": {
                "allowedTextModelCount": 2,
                "allowedTextModelsConfigured": true,
                "defaultTextModel": "openai/gpt-5.5",
                "fallbackTextModels": ["google/gemini"]
            },
            "objectStorage": {
                "deleteConfigured": false,
                "downloadConfigured": false,
                "provider": null,
                "providerError": null,
                "proofConfigured": false,
                "proofTtlMs": null,
                "uploadConfigured": false
            },
            "readiness": {
                "access": { "cloudAiEntitled": true, "globallyDisabled": false },
                "gateway": { "configError": null, "configured": true },
                "objectStorage": {
                    "deleteConfigError": null,
                    "downloadConfigError": null,
                    "proofConfigError": null,
                    "providerError": null,
                    "uploadConfigError": null
                },
                "transcription": { "configError": null, "configured": true }
            },
            "transcription": {
                "configured": true,
                "configError": null,
                "maxAudioBytes": 13107200,
                "maxAudioMegabytes": 12.5,
                "requestTimeoutMs": 65000
            },
            "workflow": {
                "inputModes": [{ "enabled": true, "kind": "multipart-audio" }],
                "kind": "post-recording-publish-pack",
                "outputs": ["summary"]
            }
        });

        let parsed: AiCapabilities = serde_json::from_value(input.clone()).unwrap();
        let proxied = serde_json::to_value(parsed).unwrap();

        assert_eq!(
            proxied["captions"], input["captions"],
            "the Rust proxy must preserve the complete readiness contract"
        );
    }

    #[test]
    fn ai_quota_response_parses_blocked_access() {
        let json = r#"{
            "access":{"allowed":false,"code":"ai-daily-quota-exhausted","message":"Daily AI quota exhausted.","status":429},
            "entitlement":{"cancelAtPeriodEnd":false,"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"currentPeriodEnd":"2026-07-15T00:00:00.000Z","expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},
            "generatedAt":"2026-06-15T23:30:00.000Z",
            "monthly":{"limit":50,"remaining":38,"resetAt":"2026-07-01T00:00:00.000Z","used":12},
            "today":{"limit":2,"remaining":0,"resetAt":"2026-06-16T00:00:00.000Z","used":2}
        }"#;
        let parsed: AiQuotaStatus = serde_json::from_str(json).unwrap();
        assert!(!parsed.access.allowed);
        assert_eq!(
            parsed.access.code.as_deref(),
            Some("ai-daily-quota-exhausted")
        );
        assert_eq!(parsed.today.remaining, 0);
    }

    #[test]
    fn missing_chunk_transcription_config_is_terminal_not_an_infinite_retry() {
        let failure = classify_caption_failure(
            503,
            "ai-transcription-not-configured".to_string(),
            "Live captions are not configured.".to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Terminal { code, .. }
                if code == "ai-transcription-not-configured"
        ));
    }

    #[test]
    fn realtime_unavailable_remains_eligible_for_chunk_fallback() {
        let failure = classify_caption_failure(
            503,
            "captions-realtime-unavailable".to_string(),
            "Streaming captions are unavailable.".to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Transient { code: Some(code), .. }
                if code == "captions-realtime-unavailable"
        ));
    }

    #[test]
    fn realtime_kill_switch_remains_eligible_for_chunk_fallback() {
        let failure = classify_caption_failure(
            503,
            "captions-realtime-disabled".to_string(),
            "Streaming captions are temporarily disabled; chunked captions remain available."
                .to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Transient { code: Some(code), .. }
                if code == "captions-realtime-disabled"
        ));
    }

    #[test]
    fn listen_allowance_failures_are_terminal_and_listen_scoped() {
        for (status, code) in [
            (429, "listen-monthly-quota-exhausted"),
            (503, "listen-disabled"),
        ] {
            let failure = classify_caption_failure(status, code.to_string(), "no".to_string());
            assert!(
                matches!(&failure, CaptionChunkFailure::Terminal { code: got, .. } if got == code),
                "{code} must end the listen intent instead of retrying forever"
            );
            assert!(is_listen_block_code(code));
        }
        assert!(!is_listen_block_code("captions-monthly-quota-exhausted"));
        assert!(!is_listen_block_code("cloud-ai-premium-required"));
        assert_eq!(CaptionChunkPurpose::Captions.as_str(), "captions");
        assert_eq!(CaptionChunkPurpose::Listen.as_str(), "listen");
    }

    #[test]
    fn cohost_failures_classify_by_envelope_code_then_status() {
        use CohostApiErrorKind as Kind;
        let cases: Vec<(u16, &str, Option<&str>, Kind, CohostReason)> = vec![
            (
                401,
                "unauthorized",
                None,
                Kind::Unauthorized,
                CohostReason::SessionExpired,
            ),
            (
                403,
                "premium-required",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
            (
                400,
                "consent-required",
                None,
                Kind::ConsentRequired,
                CohostReason::ConsentRequired,
            ),
            (
                400,
                "prompt-version-unsupported",
                None,
                Kind::PromptVersionUnsupported,
                CohostReason::ServerUnconfigured,
            ),
            (
                400,
                "invalid-request",
                None,
                Kind::InvalidRequest,
                CohostReason::GatewayError,
            ),
            (
                429,
                "quota-exhausted",
                Some("120"),
                Kind::QuotaExhausted {
                    retry_after: Some(std::time::Duration::from_secs(120)),
                },
                CohostReason::QuotaExhausted,
            ),
            (
                429,
                "unknown",
                Some("Wed, 21 Oct 2026 07:28:00 GMT"),
                Kind::QuotaExhausted { retry_after: None },
                CohostReason::QuotaExhausted,
            ),
            (
                503,
                "ai-gateway-not-configured",
                None,
                Kind::ServerUnconfigured,
                CohostReason::ServerUnconfigured,
            ),
            (
                503,
                "cohost-disabled",
                None,
                Kind::ServerUnconfigured,
                CohostReason::ServerUnconfigured,
            ),
            (
                502,
                "ai-gateway-error",
                None,
                Kind::GatewayError,
                CohostReason::GatewayError,
            ),
            (
                500,
                "unknown",
                None,
                Kind::GatewayError,
                CohostReason::GatewayError,
            ),
            // Ops blocklist: any unknown 403 code is the premium-required class.
            (
                403,
                "ai-user-disabled",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
            // Status-only fallbacks when the envelope carries no known code.
            (
                401,
                "unknown",
                None,
                Kind::Unauthorized,
                CohostReason::SessionExpired,
            ),
            (
                403,
                "unknown",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
        ];
        for (status, code, retry_after, kind, reason) in cases {
            let actual = classify_cohost_failure(status, code, "m".to_string(), retry_after);
            assert_eq!(actual.kind, kind, "{status} {code}");
            assert_eq!(actual.reason(), reason, "{status} {code}");
            // The server's own words survive classification verbatim: the
            // raw envelope code (even when the class came from the status),
            // the message, and the HTTP status.
            assert_eq!(
                actual.detail,
                CohostErrorDetail {
                    code: code.to_string(),
                    message: "m".to_string(),
                    status: Some(status),
                },
                "{status} {code}"
            );
            assert_eq!(actual.message(), "m");
        }
        assert_eq!(
            parse_retry_after_seconds(Some(" 42 ")),
            Some(std::time::Duration::from_secs(42))
        );
        assert_eq!(parse_retry_after_seconds(Some("soon")), None);
        assert_eq!(parse_retry_after_seconds(None), None);
    }

    #[test]
    fn cohost_error_envelope_parse_keeps_code_and_message_with_honest_fallbacks() {
        // The 2026-08-23 incident shape: web mis-parsed the gateway reply and
        // answered 502 with this envelope; the desktop must carry both parts.
        assert_eq!(
            parse_error_envelope(
                r#"{"error":{"code":"ai-gateway-error","message":"The Golem tick failed on every configured model."}}"#
            ),
            (
                "ai-gateway-error".to_string(),
                "The Golem tick failed on every configured model.".to_string()
            )
        );
        assert_eq!(
            parse_error_envelope(
                r#"{"error":{"code":"quota-exhausted","message":"  Try later. "}}"#
            ),
            ("quota-exhausted".to_string(), "Try later.".to_string())
        );
        // Missing or blank parts fall back one at a time.
        assert_eq!(
            parse_error_envelope(r#"{"error":{"code":"ai-gateway-error"}}"#),
            ("ai-gateway-error".to_string(), "request failed".to_string())
        );
        assert_eq!(
            parse_error_envelope(r#"{"error":{"code":"  ","message":"Upstream exploded."}}"#),
            ("unknown".to_string(), "Upstream exploded.".to_string())
        );
        assert_eq!(
            parse_error_envelope(r#"{"error":{"message":""}}"#),
            ("unknown".to_string(), "request failed".to_string())
        );
        // Not the envelope at all: a proxy HTML page, an empty body, other JSON.
        for body in ["<html>502 Bad Gateway</html>", "", r#"{"ok":false}"#, "[]"] {
            assert_eq!(
                parse_error_envelope(body),
                ("unknown".to_string(), "request failed".to_string()),
                "{body:?}"
            );
        }
    }

    #[test]
    fn cohost_desktop_side_failures_carry_their_own_detail_codes() {
        let network = CohostApiError::network("Could not reach Golem: dns");
        assert_eq!(network.kind, CohostApiErrorKind::Network);
        assert_eq!(network.reason(), CohostReason::Network);
        assert_eq!(network.detail.code, COHOST_DETAIL_CODE_NETWORK);
        assert_eq!(network.detail.status, None);

        let timeout = CohostApiError::timeout("Golem did not answer within 12 s.");
        assert_eq!(timeout.kind, CohostApiErrorKind::Network);
        assert_eq!(timeout.reason(), CohostReason::Network);
        assert_eq!(timeout.detail.code, COHOST_DETAIL_CODE_TIMEOUT);
        assert_eq!(timeout.detail.status, None);
        assert_eq!(timeout.message(), "Golem did not answer within 12 s.");

        let malformed =
            CohostApiError::malformed_response(200, "Could not read Golem's response: EOF");
        assert_eq!(malformed.kind, CohostApiErrorKind::MalformedResponse);
        assert_eq!(malformed.reason(), CohostReason::GatewayError);
        assert_eq!(malformed.detail.code, COHOST_DETAIL_CODE_MALFORMED_RESPONSE);
        assert_eq!(malformed.detail.status, Some(200));
    }

    #[test]
    fn cohost_spotlight_wire_shapes_match_the_route_and_tolerate_bad_items() {
        // Request: camelCase keys, optional candidate extras absent (never
        // null) so the zod schema on the server accepts the body verbatim.
        let request = CohostSpotlightRequest {
            client_version: "videorc-desktop/0.9.108".to_string(),
            session_client_id: "session-1".to_string(),
            consent_to_process_chat: true,
            transcript: "so about the keyboard".to_string(),
            seq: 3,
            candidates: vec![
                CohostSpotlightCandidate {
                    id: "m-1".to_string(),
                    text: "what keyboard is that".to_string(),
                    author: "Viewer".to_string(),
                    roles: Some(vec!["mod".to_string()]),
                    at: "2026-08-22T10:00:00Z".to_string(),
                    question_id: Some("q-1".to_string()),
                    question_text: Some("What keyboard is that?".to_string()),
                },
                CohostSpotlightCandidate {
                    id: "m-2".to_string(),
                    text: "lol".to_string(),
                    author: "Other".to_string(),
                    roles: None,
                    at: "2026-08-22T10:00:01Z".to_string(),
                    question_id: None,
                    question_text: None,
                },
            ],
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "clientVersion": "videorc-desktop/0.9.108",
                "sessionClientId": "session-1",
                "consentToProcessChat": true,
                "transcript": "so about the keyboard",
                "seq": 3,
                "candidates": [
                    {
                        "id": "m-1",
                        "text": "what keyboard is that",
                        "author": "Viewer",
                        "roles": ["mod"],
                        "at": "2026-08-22T10:00:00Z",
                        "questionId": "q-1",
                        "questionText": "What keyboard is that?"
                    },
                    {
                        "id": "m-2",
                        "text": "lol",
                        "author": "Other",
                        "at": "2026-08-22T10:00:01Z"
                    }
                ]
            })
        );
        let round_trip: CohostSpotlightRequest = serde_json::from_value(json).unwrap();
        assert_eq!(round_trip, request);

        // Response: raw probabilities, `answered`/`questionId` optional, an
        // unreadable item skipped, unknown keys ignored, `matches` missing
        // reads as empty.
        let response: CohostSpotlightResponse = serde_json::from_value(serde_json::json!({
            "seq": 3,
            "matches": [
                { "messageId": "m-1", "questionId": "q-1", "about": 0.9, "answered": 0.85 },
                { "messageId": "m-2", "about": 0.1, "extra": true },
                { "about": 0.5 },
                null
            ],
            "usage": { "inputTokens": 120, "outputTokens": 4, "model": "jev" },
            "future": 1
        }))
        .unwrap();
        assert_eq!(response.seq, 3);
        assert_eq!(response.matches.len(), 2);
        assert_eq!(response.matches[0].question_id.as_deref(), Some("q-1"));
        assert_eq!(response.matches[0].answered, Some(0.85));
        assert_eq!(response.matches[1].answered, None);
        assert_eq!(
            response.usage.as_ref().map(|usage| usage.model.as_str()),
            Some("jev")
        );
        let empty: CohostSpotlightResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty, CohostSpotlightResponse::default());
        assert_eq!(COHOST_SPOTLIGHT_TIMEOUT, std::time::Duration::from_secs(3));
        assert_eq!(COHOST_SPOTLIGHT_PATH, "/api/ai/cohost/spotlight");
        assert_eq!(COHOST_SPOTLIGHT_MAX_BODY_BYTES, 32 * 1024);
        // The route's own codes classify by status when the code is new to
        // the tick's table: the lane reads the code itself for its breaker.
        let disabled = classify_cohost_failure(503, "spotlight-disabled", "off".to_string(), None);
        assert_eq!(disabled.kind, CohostApiErrorKind::ServerUnconfigured);
        assert_eq!(disabled.detail.code, "spotlight-disabled");
        let timeout = classify_cohost_failure(504, "judge-timeout", "slow".to_string(), None);
        assert_eq!(timeout.kind, CohostApiErrorKind::GatewayError);
        assert_eq!(timeout.detail.status, Some(504));
    }

    #[test]
    fn cohost_tick_response_tolerates_missing_optional_fields() {
        let response: CohostTickResponse = serde_json::from_str(
            r#"{"promptVersion":1,"questions":[{"id":"q_1","text":"What keyboard?"}],"mood":"calm"}"#,
        )
        .unwrap();
        assert_eq!(response.questions.len(), 1);
        assert_eq!(response.questions[0].priority, CohostPriority::Normal);
        assert!(response.questions[0].message_ids.is_empty());
        assert_eq!(response.mood, Some(CohostMood::Calm));
        assert!(response.resolved.is_empty());
        assert!(response.flags.is_empty());
        assert!(response.usage.is_none());
    }

    // --- Golem command parser (plan 140 S8) ---

    fn command_candidate(id: &str, author: &str, text: &str) -> CohostCommandCandidate {
        CohostCommandCandidate {
            id: id.to_string(),
            author: author.to_string(),
            text: text.to_string(),
            at: "2026-10-04T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn cohost_command_requests_are_shaped_to_the_route_limits() {
        let long_author = "a".repeat(130);
        let long_text = format!("  {}  ", "t".repeat(600));
        let mut candidates = vec![
            command_candidate(" m-1 ", &long_author, &long_text),
            command_candidate("m-2", "   ", "hello"),
            command_candidate("m-3", "ada", "   "),
            CohostCommandCandidate {
                at: "yesterday".to_string(),
                ..command_candidate("m-4", "ada", "hi")
            },
            command_candidate(&"x".repeat(201), "ada", "hi"),
            command_candidate("m-1", "dupe", "again"),
        ];
        for index in 5..30 {
            candidates.push(command_candidate(
                &format!("m-{index}"),
                "viewer",
                "comment",
            ));
        }
        let request = CohostCommandRequest::shaped(
            "videorc-desktop/0.9.130",
            "session-1",
            12,
            &format!("  orcle {}", "u".repeat(400)),
            Some("m-29"),
            candidates,
        )
        .expect("a request");
        assert_eq!(request.utterance.encode_utf16().count(), 300);
        assert!(request.utterance.starts_with("orcle "));
        assert!(request.consent_to_process_chat);
        assert_eq!(request.seq, 12);
        assert_eq!(request.candidates.len(), 20);
        assert_eq!(request.candidates[0].id, "m-1");
        assert_eq!(request.candidates[0].author.len(), 120);
        assert_eq!(request.candidates[0].text, "t".repeat(500));
        assert_eq!(request.candidates[1].author, "Viewer");
        // Empty text, an unreadable time, an overlong id and a repeat are gone.
        assert!(
            request
                .candidates
                .iter()
                .all(|candidate| !["m-3", "m-4"].contains(&candidate.id.as_str())
                    && candidate.id.len() <= 200)
        );
        assert_eq!(
            request
                .candidates
                .iter()
                .filter(|candidate| candidate.id == "m-1")
                .count(),
            1
        );
        // The focus fell outside the newest 20: it takes the last place.
        assert_eq!(request.focus_message_id.as_deref(), Some("m-29"));
        assert_eq!(request.candidates[19].id, "m-29");
        assert_eq!(request.candidates[18].id, "m-21");
        assert_eq!(request.validate(), Ok(()));

        // Wire shape: camelCase, no focus key when there is none.
        let plain = CohostCommandRequest::shaped(
            "videorc-desktop/0.9.130",
            "session-1",
            3,
            "orcle show that",
            Some("not-a-candidate"),
            vec![command_candidate("m-1", "ada", "hi")],
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({
                "clientVersion": "videorc-desktop/0.9.130",
                "sessionClientId": "session-1",
                "consentToProcessChat": true,
                "seq": 3,
                "utterance": "orcle show that",
                "candidates": [
                    { "id": "m-1", "author": "ada", "text": "hi", "at": "2026-10-04T12:00:00Z" }
                ]
            })
        );

        // Nothing worth sending.
        assert_eq!(
            CohostCommandRequest::shaped(
                "v",
                "s",
                1,
                "   ",
                None,
                vec![command_candidate("m-1", "ada", "hi")]
            ),
            None
        );
        assert_eq!(
            CohostCommandRequest::shaped(
                "v",
                "s",
                1,
                "orcle",
                None,
                vec![command_candidate("m-1", "ada", " ")]
            ),
            None
        );

        // Wide text: the oldest non-focus candidates go until the body fits.
        let wide = "€".repeat(500);
        let mut many: Vec<CohostCommandCandidate> = (0..20)
            .map(|index| command_candidate(&format!("w-{index}"), "viewer", &wide))
            .collect();
        many[19].id = "focus".to_string();
        let fitted = CohostCommandRequest::shaped("v", "s", 1, "orcle", Some("focus"), many)
            .expect("a request");
        assert!(serde_json::to_vec(&fitted).unwrap().len() <= COHOST_COMMAND_MAX_BODY_BYTES);
        assert!(fitted.candidates.len() < 20);
        assert_eq!(fitted.candidates[0].id, "w-0");
        assert_eq!(fitted.candidates.last().unwrap().id, "focus");
        assert_eq!(fitted.validate(), Ok(()));

        // The client's own check refuses anything out of shape.
        let mut broken = plain.clone();
        broken.candidates[0].text = "t".repeat(501);
        assert!(broken.validate().is_err());
        let mut broken = plain.clone();
        broken.focus_message_id = Some("elsewhere".to_string());
        assert!(broken.validate().is_err());
        let mut broken = plain;
        broken
            .candidates
            .push(command_candidate("m-1", "ada", "again"));
        assert!(broken.validate().is_err());
        assert_eq!(
            COHOST_COMMAND_TIMEOUT,
            std::time::Duration::from_millis(2_500)
        );
        assert_eq!(COHOST_COMMAND_PATH, "/api/ai/cohost/command");
    }

    #[test]
    fn cohost_command_responses_read_open() {
        let response: CohostCommandResponse = serde_json::from_value(serde_json::json!({
            "seq": 12,
            "intent": {
                "choice": "highlight",
                "probabilities": { "highlight": 0.91, "remove": 0.02, "clear": 0.01, "none": 0.06 },
                "rationale": "newer field"
            },
            "targets": [
                { "messageId": "m1", "probability": 0.88, "extra": true },
                { "probability": 0.5 },
                null,
                { "messageId": "m2", "probability": 0.1 }
            ],
            "usage": { "inputTokens": 310, "model": "jev", "outputTokens": 6, "cost": 0.001 },
            "future": { "anything": 1 }
        }))
        .unwrap();
        assert_eq!(response.seq, 12);
        assert_eq!(response.intent.choice, "highlight");
        assert_eq!(response.intent.probabilities.of("highlight"), 0.91);
        assert_eq!(response.intent.probabilities.of("none"), 0.06);
        assert_eq!(response.intent.probabilities.of("dance"), 0.0);
        assert_eq!(
            response.targets,
            vec![
                CohostCommandTarget {
                    message_id: "m1".to_string(),
                    probability: 0.88
                },
                CohostCommandTarget {
                    message_id: "m2".to_string(),
                    probability: 0.1
                },
            ]
        );
        // A newer choice and missing keys never fail the body.
        let odd: CohostCommandResponse = serde_json::from_value(serde_json::json!({
            "seq": 1,
            "intent": { "choice": "mute" }
        }))
        .unwrap();
        assert_eq!(odd.intent.choice, "mute");
        assert!(odd.targets.is_empty());
        let empty: CohostCommandResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty, CohostCommandResponse::default());
    }

    async fn spawn_command_server(
        status: axum::http::StatusCode,
        headers: Vec<(&'static str, &'static str)>,
        body: serde_json::Value,
        delay: std::time::Duration,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(Option<String>, serde_json::Value)>>>,
    ) -> VideorcApiClient {
        use axum::response::IntoResponse;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            COHOST_COMMAND_PATH,
            axum::routing::post(
                move |request_headers: axum::http::HeaderMap,
                      axum::Json(request): axum::Json<serde_json::Value>| {
                    let headers = headers.clone();
                    let body = body.clone();
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push((
                            request_headers
                                .get(axum::http::header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .map(str::to_string),
                            request,
                        ));
                        tokio::time::sleep(delay).await;
                        let mut response = (status, axum::Json(body)).into_response();
                        for (name, value) in headers {
                            response
                                .headers_mut()
                                .insert(name, axum::http::HeaderValue::from_static(value));
                        }
                        response
                    }
                },
            ),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        VideorcApiClient {
            base_url: format!("http://{address}"),
            http: reqwest::Client::new(),
        }
    }

    fn command_request() -> CohostCommandRequest {
        CohostCommandRequest::shaped(
            "videorc-desktop/0.9.130",
            "session-1",
            12,
            "orcle show what coders x asked",
            Some("m1"),
            vec![command_candidate(
                "m1",
                "coders_x",
                "how do lifetimes work?",
            )],
        )
        .unwrap()
    }

    #[tokio::test]
    async fn cohost_command_client_sends_bearer_json_and_reads_the_answer() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let client = spawn_command_server(
            axum::http::StatusCode::OK,
            Vec::new(),
            serde_json::json!({
                "seq": 12,
                "intent": { "choice": "highlight", "probabilities": { "highlight": 0.9, "remove": 0.0, "clear": 0.0, "none": 0.1 } },
                "targets": [{ "messageId": "m1", "probability": 0.8 }],
                "usage": { "inputTokens": 1, "model": "jev", "outputTokens": 1 }
            }),
            std::time::Duration::ZERO,
            seen.clone(),
        )
        .await;
        let request = command_request();
        let response = client
            .post_cohost_command("token-1", &request)
            .await
            .unwrap();
        assert_eq!(response.seq, 12);
        assert_eq!(response.targets[0].message_id, "m1");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0.as_deref(), Some("Bearer token-1"));
        assert_eq!(seen[0].1, serde_json::to_value(&request).unwrap());
        assert_eq!(seen[0].1["focusMessageId"], "m1");
    }

    #[tokio::test]
    async fn cohost_command_client_maps_429_timeouts_and_refuses_bad_requests_unsent() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let quota = spawn_command_server(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            vec![("retry-after", "120")],
            serde_json::json!({ "error": { "code": "quota-exhausted", "message": "Daily limit reached." } }),
            std::time::Duration::ZERO,
            seen.clone(),
        )
        .await;
        let error = quota
            .post_cohost_command("token", &command_request())
            .await
            .unwrap_err();
        assert_eq!(
            error.kind,
            CohostApiErrorKind::QuotaExhausted {
                retry_after: Some(std::time::Duration::from_secs(120))
            }
        );
        assert_eq!(error.detail.status, Some(429));

        let disabled = spawn_command_server(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Vec::new(),
            serde_json::json!({ "error": { "code": "command-disabled", "message": "Off." } }),
            std::time::Duration::ZERO,
            seen.clone(),
        )
        .await;
        let error = disabled
            .post_cohost_command("token", &command_request())
            .await
            .unwrap_err();
        assert_eq!(error.kind, CohostApiErrorKind::ServerUnconfigured);
        assert_eq!(error.detail.code, "command-disabled");

        let slow = spawn_command_server(
            axum::http::StatusCode::OK,
            Vec::new(),
            serde_json::json!({}),
            std::time::Duration::from_secs(5),
            seen.clone(),
        )
        .await;
        let error = slow
            .post_cohost_command_within(
                "token",
                &command_request(),
                std::time::Duration::from_millis(200),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, CohostApiErrorKind::Network);
        assert_eq!(error.detail.code, COHOST_DETAIL_CODE_TIMEOUT);

        let before = seen.lock().unwrap().len();
        let mut bad = command_request();
        bad.utterance = String::new();
        let error = quota.post_cohost_command("token", &bad).await.unwrap_err();
        assert_eq!(error.kind, CohostApiErrorKind::InvalidRequest);
        assert_eq!(seen.lock().unwrap().len(), before, "nothing was sent");
    }
}
