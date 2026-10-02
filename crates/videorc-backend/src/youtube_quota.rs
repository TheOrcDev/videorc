//! YouTube Data API quota breaker and usage counter (plan 094, S1).
//!
//! Every Videorc install shares one Google Cloud project quota. When any
//! YouTube call answers `quotaExceeded`, every other YouTube caller in this
//! process (chat reader, viewer sampler, audience, OAuth validate and connect,
//! prepare, thumbnails, transitions, send) must stop spending quota until the
//! daily reset at midnight Pacific, then resume on its own. This module owns:
//!
//! - one shared classifier for Google's error envelope (`QuotaExhausted` vs
//!   `RateLimited` vs auth vs permissions), used by every caller;
//! - the app-wide breaker `paused_until`, published as the `youtube.quota`
//!   event `{ pausedUntil }` so the renderer shows one paused state;
//! - the expiry probe: one `channels.list` (1 unit) at `pausedUntil` plus a
//!   random 0-120 s. Success clears the breaker; a second quota error re-arms
//!   it for 30 minutes, because Google's reset time is not exact;
//! - the `youtube_api_usage` counter: calls and estimated units per endpoint
//!   (Google's cost table), sends counted separately, with a per-Pacific-day
//!   total persisted in `app_settings` so S6 can budget across relaunches.
//!
//! Failure discipline: the breaker never blocks a running stream. Callers skip
//! their call and park; video and audio never depend on this module.

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use crate::protocol::HealthLevel;
use crate::state::AppState;

pub const YOUTUBE_QUOTA_EVENT: &str = "youtube.quota";
pub const YOUTUBE_API_USAGE_LOG_CODE: &str = "youtube-api-usage";
pub const YOUTUBE_API_USAGE_SETTING_KEY: &str = "youtubeApiUsageDaily";
/// How often a session logs its usage summary.
pub const USAGE_REPORT_INTERVAL: Duration = Duration::from_secs(600);
/// After the probe hits quota again the pause is this long, not a whole day.
const REARM_PAUSE: chrono::Duration = chrono::Duration::minutes(30);
/// A quota error this soon after a pause expired means Google's reset is late:
/// re-arm for [`REARM_PAUSE`] instead of a day.
const LATE_RESET_WINDOW: chrono::Duration = chrono::Duration::hours(2);
/// The probe fires between `paused_until` and `paused_until + this`.
const DEFAULT_PROBE_JITTER_MAX_MS: u64 = 120_000;
/// The breaker is honoured this long past `paused_until` while the probe has
/// not reported. Past it the breaker fails open (with a log line): a probe
/// task that never ran must not pause YouTube forever.
const PROBE_GRACE: chrono::Duration = chrono::Duration::minutes(10);
const YOUTUBE_API_BASE_URL: &str = "https://www.googleapis.com";
/// Dev-only: point every YouTube Data API client (prepare, bind, transitions,
/// chat read and send, viewers, subscribers, OAuth token and profile calls,
/// the quota probe) at one local fake, for `pnpm smoke:youtube-quota` (plan
/// 094, S4). Only a bare loopback origin is accepted, and packaged (release)
/// builds refuse it outright: a stray variable can never redirect a token.
pub const YOUTUBE_API_BASE_URL_ENV: &str = "VIDEORC_YOUTUBE_API_BASE_URL";

// --- API base URL ---------------------------------------------------------------

/// Pure: the override a build honours for `VIDEORC_YOUTUBE_API_BASE_URL`.
/// Release builds refuse any value; debug builds accept a bare
/// `http://127.0.0.1:<port>` origin and nothing else.
pub fn resolve_youtube_api_base_url_override(
    dev_build: bool,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !dev_build {
        return Err(format!(
            "{YOUTUBE_API_BASE_URL_ENV} is refused in packaged builds; YouTube calls go to {YOUTUBE_API_BASE_URL}."
        ));
    }
    let url = reqwest::Url::parse(value)
        .map_err(|error| format!("{YOUTUBE_API_BASE_URL_ENV} is not a URL: {error}"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{YOUTUBE_API_BASE_URL_ENV} must be a bare loopback origin such as http://127.0.0.1:4321."
        ));
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

/// The dev-only override in effect for this process, resolved once. Logs once
/// when the variable is set but not honoured.
pub fn youtube_api_base_url_override() -> Option<String> {
    static RESOLVED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let value = std::env::var(YOUTUBE_API_BASE_URL_ENV).ok();
            match resolve_youtube_api_base_url_override(cfg!(debug_assertions), value.as_deref()) {
                Ok(Some(base)) => {
                    tracing::warn!(
                        "[youtube-quota] dev override: every YouTube API call goes to {base}"
                    );
                    Some(base)
                }
                Ok(None) => None,
                Err(why) => {
                    tracing::warn!("[youtube-quota] {why}");
                    None
                }
            }
        })
        .clone()
}

/// The YouTube Data API origin a caller should use: its explicit override
/// (tests), else the dev-only env override, else Google.
pub fn youtube_api_base_url(explicit: Option<&str>) -> String {
    explicit
        .map(|base| base.trim_end_matches('/').to_string())
        .or_else(youtube_api_base_url_override)
        .unwrap_or_else(|| YOUTUBE_API_BASE_URL.to_string())
}

/// The provider message while chat is parked. The renderer appends "It
/// resumes at 09:00. Your stream keeps going." from `retryAt` (plan 094, S2).
pub const CHAT_PAUSED_MESSAGE: &str =
    "YouTube chat is paused: Videorc's daily YouTube API limit is used up.";
pub const SEND_PAUSED_MESSAGE: &str =
    "YouTube chat send is paused: Videorc's daily YouTube API limit is used up.";
pub const SUBSCRIBERS_PAUSED_MESSAGE: &str =
    "YouTube subscribers are paused: Videorc's daily YouTube API limit is used up.";
pub const API_PAUSED_MESSAGE: &str =
    "YouTube's API is paused: Videorc's daily YouTube API limit is used up.";

// --- Classifier -------------------------------------------------------------

/// What a failed YouTube Data API call means for the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YouTubeApiErrorClass {
    /// The project's daily quota is used up: stop every call until the reset.
    QuotaExhausted,
    /// Too fast: back off and keep going.
    RateLimited,
    /// The token was refused: renew or reconnect.
    AuthExpired,
    /// A permissions refusal (not quota, not rate).
    Forbidden,
    NotFound,
    BadRequest,
    Transient,
}

/// `reason` and `domain` of the first entry in Google's error envelope.
pub fn error_reason_and_domain(body: &Value) -> (Option<String>, Option<String>) {
    let first = body
        .get("error")
        .and_then(|error| error.get("errors"))
        .and_then(Value::as_array)
        .and_then(|errors| errors.first());
    let field = |name: &str| {
        first
            .and_then(|entry| entry.get(name))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    (field("reason"), field("domain"))
}

/// Parse an error body that may not be JSON (Google answers HTML too).
pub fn error_reason_and_domain_from_text(body: &str) -> (Option<String>, Option<String>) {
    serde_json::from_str::<Value>(body)
        .map(|value| error_reason_and_domain(&value))
        .unwrap_or((None, None))
}

fn is_quota_reason(reason: Option<&str>, domain: Option<&str>) -> bool {
    matches!(reason, Some("quotaExceeded") | Some("dailyLimitExceeded"))
        || domain == Some("youtube.quota")
}

/// The shared classifier. `quotaExceeded`, `dailyLimitExceeded` and anything in
/// the `youtube.quota` domain are quota; `rateLimitExceeded`,
/// `userRateLimitExceeded` and 429 stay rate limits (back off, keep going).
pub fn classify_youtube_api_error(
    status: u16,
    reason: Option<&str>,
    domain: Option<&str>,
) -> YouTubeApiErrorClass {
    if is_quota_reason(reason, domain) {
        return YouTubeApiErrorClass::QuotaExhausted;
    }
    match status {
        401 => YouTubeApiErrorClass::AuthExpired,
        403 => match reason {
            Some("rateLimitExceeded") | Some("userRateLimitExceeded") => {
                YouTubeApiErrorClass::RateLimited
            }
            Some("authError") | Some("unauthenticated") => YouTubeApiErrorClass::AuthExpired,
            _ => YouTubeApiErrorClass::Forbidden,
        },
        404 => YouTubeApiErrorClass::NotFound,
        429 => YouTubeApiErrorClass::RateLimited,
        400 => YouTubeApiErrorClass::BadRequest,
        _ => YouTubeApiErrorClass::Transient,
    }
}

/// Whether an error message (from a path that only kept the text) describes a
/// quota refusal. Defence in depth behind the typed classifier.
pub fn is_quota_exhausted_text(text: &str) -> bool {
    text.contains("quotaExceeded")
        || text.contains("dailyLimitExceeded")
        || text.contains("youtube.quota")
}

/// A typed YouTube Data API rejection. Its `Display` keeps the historical
/// `"{action} ({status}): {detail}"` shape, so callers that still match on the
/// text (`is_youtube_auth_error`, the prepare retry) keep working.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{action} ({status_text}): {detail}")]
pub struct YouTubeApiError {
    pub action: String,
    pub status: u16,
    status_text: String,
    pub reason: Option<String>,
    pub domain: Option<String>,
    /// Google's `reason: message`, bounded. Never shown to the user as is.
    pub detail: String,
}

impl YouTubeApiError {
    pub fn from_body(action: &str, status: reqwest::StatusCode, body: &str) -> Self {
        let (reason, domain) = error_reason_and_domain_from_text(body);
        let message = serde_json::from_str::<Value>(body).ok().and_then(|value| {
            value
                .pointer("/error/errors/0/message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
        let detail = match (&reason, message) {
            (Some(reason), Some(message)) => format!("{reason}: {message}"),
            (Some(reason), None) => reason.clone(),
            (None, Some(message)) => message,
            (None, None) => {
                let trimmed = body.trim();
                if trimmed.is_empty() {
                    "no error body".to_string()
                } else {
                    trimmed.chars().take(300).collect()
                }
            }
        };
        Self {
            action: action.to_string(),
            status: status.as_u16(),
            status_text: status.to_string(),
            reason,
            domain,
            detail,
        }
    }

    pub fn class(&self) -> YouTubeApiErrorClass {
        classify_youtube_api_error(self.status, self.reason.as_deref(), self.domain.as_deref())
    }
}

/// Whether an `anyhow` error from any YouTube path is a quota refusal: the
/// typed rejection first, then the text for paths that only kept a message.
pub fn is_quota_exhausted_error(error: &anyhow::Error) -> bool {
    if let Some(api) = error.downcast_ref::<YouTubeApiError>() {
        return api.class() == YouTubeApiErrorClass::QuotaExhausted;
    }
    if let Some(rejection) = error.downcast_ref::<crate::scheduled_youtube::YouTubeRejection>() {
        return is_quota_reason(Some(rejection.reason.as_str()), None);
    }
    if error.downcast_ref::<YouTubeQuotaPaused>().is_some() {
        return false;
    }
    is_quota_exhausted_text(&format!("{error:#}"))
}

/// Returned by callers that refuse a call while the breaker is set.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{API_PAUSED_MESSAGE}")]
pub struct YouTubeQuotaPaused {
    pub paused_until: DateTime<Utc>,
}

// --- Pacific-day maths --------------------------------------------------------

/// The next 00:00 America/Los_Angeles after `now`, DST-aware.
pub fn next_pacific_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let local = now.with_timezone(&chrono_tz::America::Los_Angeles);
    let tomorrow = local.date_naive().succ_opt().unwrap_or(local.date_naive());
    let midnight = tomorrow.and_hms_opt(0, 0, 0).expect("midnight exists");
    chrono_tz::America::Los_Angeles
        .from_local_datetime(&midnight)
        .earliest()
        .map(|local_midnight| local_midnight.with_timezone(&Utc))
        // Midnight never falls in a DST gap in Los Angeles, but never panic on
        // a calendar: fall back to PST (UTC-8).
        .unwrap_or_else(|| midnight.and_utc() + chrono::Duration::hours(8))
}

/// The Pacific calendar day of `now`, `YYYY-MM-DD`.
pub fn pacific_day(now: DateTime<Utc>) -> String {
    let local = now.with_timezone(&chrono_tz::America::Los_Angeles);
    format!(
        "{:04}-{:02}-{:02}",
        local.year(),
        local.month(),
        local.day()
    )
}

/// When a quota error at `now` pauses until. A quota error shortly after a
/// pause expired means the reset is late: re-arm briefly rather than a day.
pub fn pause_target(now: DateTime<Utc>, previous_expiry: Option<DateTime<Utc>>) -> DateTime<Utc> {
    match previous_expiry {
        Some(expiry) if now >= expiry && now - expiry < LATE_RESET_WINDOW => now + REARM_PAUSE,
        _ => next_pacific_midnight(now),
    }
}

// --- Usage counter ------------------------------------------------------------

/// Every Data API method Videorc calls, with Google's quota cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum YouTubeEndpoint {
    LiveChatMessagesList,
    LiveChatMessagesInsert,
    VideosList,
    ChannelsList,
    LiveBroadcastsList,
    LiveBroadcastsInsert,
    LiveBroadcastsBind,
    LiveBroadcastsTransition,
    LiveStreamsList,
    LiveStreamsInsert,
    ThumbnailsSet,
}

impl YouTubeEndpoint {
    pub fn name(self) -> &'static str {
        match self {
            Self::LiveChatMessagesList => "liveChatMessages.list",
            Self::LiveChatMessagesInsert => "liveChatMessages.insert",
            Self::VideosList => "videos.list",
            Self::ChannelsList => "channels.list",
            Self::LiveBroadcastsList => "liveBroadcasts.list",
            Self::LiveBroadcastsInsert => "liveBroadcasts.insert",
            Self::LiveBroadcastsBind => "liveBroadcasts.bind",
            Self::LiveBroadcastsTransition => "liveBroadcasts.transition",
            Self::LiveStreamsList => "liveStreams.list",
            Self::LiveStreamsInsert => "liveStreams.insert",
            Self::ThumbnailsSet => "thumbnails.set",
        }
    }

    /// Google's quota cost table (checked 2026-10-02). Reads cost 1, writes 50.
    pub fn units(self) -> u64 {
        match self {
            Self::LiveChatMessagesList
            | Self::VideosList
            | Self::ChannelsList
            | Self::LiveBroadcastsList
            | Self::LiveStreamsList => 1,
            Self::LiveChatMessagesInsert
            | Self::LiveBroadcastsInsert
            | Self::LiveBroadcastsBind
            | Self::LiveBroadcastsTransition
            | Self::LiveStreamsInsert
            | Self::ThumbnailsSet => 50,
        }
    }

    fn is_send(self) -> bool {
        self == Self::LiveChatMessagesInsert
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointUsage {
    pub calls: u64,
    pub units: u64,
}

impl EndpointUsage {
    fn add(&mut self, units: u64) {
        self.calls = self.calls.saturating_add(1);
        self.units = self.units.saturating_add(units);
    }
}

/// The persisted per-Pacific-day total (S6 budgets on it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeApiDailyUsage {
    pub day: String,
    pub calls: u64,
    pub units: u64,
}

/// In-memory counter since process start.
#[derive(Debug, Clone, Default)]
pub struct YouTubeApiUsage {
    pub endpoints: BTreeMap<&'static str, EndpointUsage>,
    pub sends: EndpointUsage,
    pub since: Option<DateTime<Utc>>,
    pub daily: YouTubeApiDailyUsage,
}

impl YouTubeApiUsage {
    /// Records one call at `now`. Returns true when the day rolled over (the
    /// daily total was reset before counting).
    pub fn record(&mut self, endpoint: YouTubeEndpoint, now: DateTime<Utc>) {
        self.since.get_or_insert(now);
        let units = endpoint.units();
        if endpoint.is_send() {
            self.sends.add(units);
        } else {
            self.endpoints
                .entry(endpoint.name())
                .or_default()
                .add(units);
        }
        let day = pacific_day(now);
        if self.daily.day != day {
            self.daily = YouTubeApiDailyUsage {
                day,
                calls: 0,
                units: 0,
            };
        }
        self.daily.calls = self.daily.calls.saturating_add(1);
        self.daily.units = self.daily.units.saturating_add(units);
    }

    pub fn total_calls(&self) -> u64 {
        self.endpoints
            .values()
            .fold(self.sends.calls, |total, usage| {
                total.saturating_add(usage.calls)
            })
    }

    pub fn total_units(&self) -> u64 {
        self.endpoints
            .values()
            .fold(self.sends.units, |total, usage| {
                total.saturating_add(usage.units)
            })
    }

    pub fn snapshot(&self) -> YouTubeApiUsageSnapshot {
        YouTubeApiUsageSnapshot {
            since: self.since.map(|since| since.to_rfc3339()),
            endpoints: self
                .endpoints
                .iter()
                .map(|(name, usage)| EndpointUsageRow {
                    endpoint: (*name).to_string(),
                    calls: usage.calls,
                    units: usage.units,
                })
                .collect(),
            sends: self.sends,
            total_calls: self.total_calls(),
            total_units: self.total_units(),
            day: self.daily.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointUsageRow {
    pub endpoint: String,
    pub calls: u64,
    pub units: u64,
}

/// The counter as logged every 10 minutes, at session end, and in the session
/// log (`youtube-api-usage`). Units are Google's published costs, so they are
/// estimates until the Cloud Console delta confirms them (plan 094, S5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeApiUsageSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub endpoints: Vec<EndpointUsageRow>,
    /// `liveChatMessages.insert`, kept apart: 50 units each, user-driven.
    pub sends: EndpointUsage,
    pub total_calls: u64,
    pub total_units: u64,
    pub day: YouTubeApiDailyUsage,
}

// --- Breaker state --------------------------------------------------------------

#[derive(Debug, Default)]
struct QuotaInner {
    /// When the last pause expired (the probe cleared it or it lapsed).
    last_expiry: Option<DateTime<Utc>>,
    /// A probe task is sleeping towards the current pause.
    probe_armed: bool,
    usage: YouTubeApiUsage,
    daily_loaded: bool,
    /// Test and S4 override for every probe request.
    api_base_url: Option<String>,
    probe_jitter_max_ms: Option<u64>,
    /// Test seam: probe with this token instead of the connected account's.
    probe_access_token: Option<String>,
}

/// The process-wide breaker and counter; one per [`AppState`].
#[derive(Debug)]
pub struct YouTubeQuota {
    paused: watch::Sender<Option<DateTime<Utc>>>,
    inner: StdMutex<QuotaInner>,
}

impl Default for YouTubeQuota {
    fn default() -> Self {
        Self {
            paused: watch::channel(None).0,
            inner: StdMutex::new(QuotaInner::default()),
        }
    }
}

pub type YouTubeQuotaSlot = std::sync::Arc<YouTubeQuota>;

pub fn new_youtube_quota_slot() -> YouTubeQuotaSlot {
    std::sync::Arc::default()
}

impl YouTubeQuota {
    fn lock(&self) -> std::sync::MutexGuard<'_, QuotaInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The `youtube.quota` event payload. `pausedUntil` is absent when YouTube
/// calls are allowed (never `null`: the renderer contract treats a missing
/// field as "not paused").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeQuotaStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_until: Option<String>,
}

/// While the breaker is set: when it lifts. `None` means YouTube calls may go
/// out. A pause whose probe never reported fails open after [`PROBE_GRACE`].
pub fn paused_until(state: &AppState) -> Option<DateTime<Utc>> {
    paused_until_at(state, Utc::now())
}

fn paused_until_at(state: &AppState, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let until = (*state.youtube_quota.paused.borrow())?;
    if now < until + PROBE_GRACE {
        return Some(until);
    }
    tracing::warn!(
        "[youtube-quota] pause lapsed at {} without a probe verdict; allowing YouTube calls again",
        until.to_rfc3339()
    );
    clear_pause(state, "the probe never reported");
    None
}

pub fn status(state: &AppState) -> YouTubeQuotaStatus {
    YouTubeQuotaStatus {
        paused_until: paused_until(state).map(|until| until.to_rfc3339()),
    }
}

/// Refuse a YouTube call while paused, with the typed error callers map to copy.
pub fn refuse_if_paused(state: &AppState) -> Result<(), YouTubeQuotaPaused> {
    match paused_until(state) {
        Some(paused_until) => Err(YouTubeQuotaPaused { paused_until }),
        None => Ok(()),
    }
}

/// Any YouTube caller that got `quotaExceeded` reports it here. Sets the
/// breaker (idempotent while already paused), publishes `youtube.quota` and
/// arms the expiry probe. Returns when the pause lifts.
pub fn record_quota_exhausted(state: &AppState, source: &str) -> DateTime<Utc> {
    record_quota_exhausted_at(state, source, Utc::now())
}

fn record_quota_exhausted_at(state: &AppState, source: &str, now: DateTime<Utc>) -> DateTime<Utc> {
    if let Some(until) = paused_until_at(state, now) {
        tracing::info!(
            "[youtube-quota] {source}: quota still exhausted; paused until {}",
            until.to_rfc3339()
        );
        return until;
    }
    let (until, arm_probe) = {
        let mut inner = state.youtube_quota.lock();
        let until = pause_target(now, inner.last_expiry);
        let arm_probe = !inner.probe_armed;
        inner.probe_armed = true;
        (until, arm_probe)
    };
    state.youtube_quota.paused.send_replace(Some(until));
    tracing::warn!(
        "[youtube-quota] {source}: YouTube's daily API quota is used up; pausing every YouTube call until {}",
        until.to_rfc3339()
    );
    state.emit_log(
        "warn",
        format!(
            "YouTube's daily API limit is used up ({source}). YouTube chat, viewers and subscribers are paused until {}; the stream is not affected.",
            until.to_rfc3339()
        ),
    );
    emit_status(state);
    if arm_probe {
        spawn_expiry_probe(state.clone());
    }
    until
}

fn emit_status(state: &AppState) {
    state.emit_event(YOUTUBE_QUOTA_EVENT, status(state));
}

fn clear_pause(state: &AppState, why: &str) {
    let was_paused = state.youtube_quota.paused.send_replace(None).is_some();
    {
        let mut inner = state.youtube_quota.lock();
        inner.last_expiry = Some(Utc::now());
    }
    if was_paused {
        tracing::info!("[youtube-quota] pause cleared: {why}");
        state.emit_log(
            "info",
            format!(
                "YouTube's API is available again ({why}). Chat, viewers and subscribers resume."
            ),
        );
        emit_status(state);
    }
}

/// Re-arm after the probe itself hit quota: Google's reset was late.
fn rearm_short(state: &AppState) -> DateTime<Utc> {
    let until = Utc::now() + REARM_PAUSE;
    state.youtube_quota.paused.send_replace(Some(until));
    tracing::warn!(
        "[youtube-quota] the reset probe hit quota again; paused until {}",
        until.to_rfc3339()
    );
    emit_status(state);
    until
}

/// Blocks until the breaker is clear. Callers park here instead of exiting, so
/// they resume where they were (chat keeps its page token) with no click.
pub async fn wait_until_resumed(state: &AppState) {
    let mut receiver = state.youtube_quota.paused.subscribe();
    loop {
        let until = *receiver.borrow_and_update();
        match until {
            None => return,
            Some(until) if Utc::now() >= until + PROBE_GRACE => {
                // Fail open, as `paused_until` does, rather than wait forever.
                clear_pause(state, "the probe never reported");
                return;
            }
            Some(until) => {
                let deadline = (until + PROBE_GRACE - Utc::now())
                    .to_std()
                    .unwrap_or(Duration::from_millis(50));
                let _ = tokio::time::timeout(deadline, receiver.changed()).await;
            }
        }
    }
}

/// Test and S4 hook: point the probe at a fake API, shrink its jitter, and
/// (tests only) hand it a token so no account store is needed. S4 wires
/// `VIDEORC_YOUTUBE_API_BASE_URL` through here.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn configure_probe(
    state: &AppState,
    api_base_url: Option<String>,
    jitter_max_ms: u64,
    access_token: Option<String>,
) {
    let mut inner = state.youtube_quota.lock();
    inner.api_base_url = api_base_url;
    inner.probe_jitter_max_ms = Some(jitter_max_ms);
    inner.probe_access_token = access_token;
}

/// Smoke hook (plan 094, S4; debug builds only, admitted through the explicit
/// smoke RPC switch): make the current pause expire now, with no probe jitter,
/// so the expiry probe fires at once against the fake API. Returns the pause
/// end it replaced, or `None` when YouTube was not paused.
#[cfg(debug_assertions)]
pub(crate) fn force_expiry_for_smoke(state: &AppState) -> Option<DateTime<Utc>> {
    let previous = (*state.youtube_quota.paused.borrow())?;
    let arm_probe = {
        let mut inner = state.youtube_quota.lock();
        inner.probe_jitter_max_ms = Some(0);
        let arm = !inner.probe_armed;
        inner.probe_armed = true;
        arm
    };
    state.youtube_quota.paused.send_replace(Some(Utc::now()));
    tracing::warn!(
        "[youtube-quota] smoke: pause forced to expire now (was {})",
        previous.to_rfc3339()
    );
    emit_status(state);
    if arm_probe {
        spawn_expiry_probe(state.clone());
    }
    Some(previous)
}

/// Test hook: lift the breaker as the probe would.
#[cfg(test)]
pub(crate) fn clear_for_tests(state: &AppState) {
    clear_pause(state, "test");
}

/// Test hook: set the breaker to lift at `until` without a quota error.
#[cfg(test)]
pub(crate) fn pause_until_for_tests(state: &AppState, until: DateTime<Utc>) {
    {
        let mut inner = state.youtube_quota.lock();
        inner.probe_armed = true;
    }
    state.youtube_quota.paused.send_replace(Some(until));
    emit_status(state);
    spawn_expiry_probe(state.clone());
}

/// Deterministic 0..max jitter from the clock's sub-second nanos (no RNG dependency).
fn probe_jitter_ms(max_ms: u64) -> u64 {
    if max_ms == 0 {
        return 0;
    }
    u64::from(Utc::now().timestamp_subsec_nanos()) % max_ms
}

fn spawn_expiry_probe(state: AppState) {
    tokio::spawn(async move {
        run_expiry_probe(state).await;
    });
}

/// Sleeps to `paused_until` plus jitter, then spends one unit to learn whether
/// the quota is back. Loops while re-armed; exits once the breaker is clear.
async fn run_expiry_probe(state: AppState) {
    let mut receiver = state.youtube_quota.paused.subscribe();
    loop {
        let Some(until) = *receiver.borrow_and_update() else {
            break;
        };
        let jitter_max = state
            .youtube_quota
            .lock()
            .probe_jitter_max_ms
            .unwrap_or(DEFAULT_PROBE_JITTER_MAX_MS);
        let fire_at = until + chrono::Duration::milliseconds(probe_jitter_ms(jitter_max) as i64);
        if let Ok(wait) = (fire_at - Utc::now()).to_std() {
            // A re-arm or a clear while sleeping re-plans the probe.
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                changed = receiver.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    continue;
                }
            }
        }
        if receiver.borrow_and_update().is_none() {
            break;
        }
        match probe_once(&state).await {
            ProbeVerdict::Available(why) => {
                clear_pause(&state, &why);
                break;
            }
            ProbeVerdict::StillExhausted => {
                rearm_short(&state);
            }
        }
    }
    state.youtube_quota.lock().probe_armed = false;
}

enum ProbeVerdict {
    Available(String),
    StillExhausted,
}

/// One `channels.list?part=id&mine=true` with the connected YouTube account.
/// No account, a network failure or a non-quota error all mean the quota is
/// not what is blocking YouTube: the breaker lifts and callers see the real
/// error themselves.
async fn probe_once(state: &AppState) -> ProbeVerdict {
    let client = reqwest::Client::new();
    let (base, scripted_token) = {
        let inner = state.youtube_quota.lock();
        (
            youtube_api_base_url(inner.api_base_url.as_deref()),
            inner.probe_access_token.clone(),
        )
    };
    let token = match scripted_token {
        Some(token) => token,
        None => match crate::session_platform_access_token(
            state,
            crate::streaming::StreamPlatform::Youtube,
            None,
            &client,
            None,
        )
        .await
        {
            Ok(token) => token,
            Err(error) => {
                return ProbeVerdict::Available(format!(
                    "no YouTube account to probe with: {error}"
                ));
            }
        },
    };
    let url = format!(
        "{}/youtube/v3/channels?part=id&mine=true",
        base.trim_end_matches('/')
    );
    record_call(state, YouTubeEndpoint::ChannelsList);
    let response = match client.get(url).bearer_auth(&token).send().await {
        Ok(response) => response,
        Err(error) => {
            return ProbeVerdict::Available(format!("probe could not reach YouTube: {error}"));
        }
    };
    let status = response.status();
    if status.is_success() {
        return ProbeVerdict::Available("the reset probe succeeded".to_string());
    }
    let body = response.text().await.unwrap_or_default();
    let error = YouTubeApiError::from_body("YouTube quota probe failed", status, &body);
    match error.class() {
        YouTubeApiErrorClass::QuotaExhausted => ProbeVerdict::StillExhausted,
        _ => ProbeVerdict::Available(format!("the reset probe got a non-quota answer: {error}")),
    }
}

/// Inspect any YouTube error: a quota refusal sets the breaker. Returns the
/// pause end when it did, so callers can word their result.
pub fn note_error(state: &AppState, source: &str, error: &anyhow::Error) -> Option<DateTime<Utc>> {
    is_quota_exhausted_error(error).then(|| record_quota_exhausted(state, source))
}

// --- Counter plumbing -------------------------------------------------------------

/// Count one Data API call (made or attempted: a rejected call still costs).
pub fn record_call(state: &AppState, endpoint: YouTubeEndpoint) {
    let now = Utc::now();
    let daily = {
        let mut inner = state.youtube_quota.lock();
        if !inner.daily_loaded {
            inner.daily_loaded = true;
            if let Ok(Some(saved)) = state
                .database
                .load_setting::<YouTubeApiDailyUsage>(YOUTUBE_API_USAGE_SETTING_KEY)
            {
                inner.usage.daily = saved;
            }
        }
        inner.usage.record(endpoint, now);
        inner.usage.daily.clone()
    };
    if let Err(error) = state
        .database
        .save_setting(YOUTUBE_API_USAGE_SETTING_KEY, &daily)
    {
        tracing::warn!("[youtube-quota] could not persist the daily usage total: {error}");
    }
}

pub fn usage_snapshot(state: &AppState) -> YouTubeApiUsageSnapshot {
    state.youtube_quota.lock().usage.snapshot()
}

/// The persisted Pacific-day total, for S6's budget (its only caller today
/// is the test).
#[cfg_attr(not(test), allow(dead_code))]
pub fn daily_usage(state: &AppState) -> YouTubeApiDailyUsage {
    let inner = state.youtube_quota.lock();
    if inner.daily_loaded {
        return inner.usage.daily.clone();
    }
    drop(inner);
    state
        .database
        .load_setting::<YouTubeApiDailyUsage>(YOUTUBE_API_USAGE_SETTING_KEY)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// One summary line in the backend log and the session log.
pub fn log_usage_summary(state: &AppState, session_id: &str, moment: &str) {
    let snapshot = usage_snapshot(state);
    if snapshot.total_calls == 0 {
        return;
    }
    tracing::info!(
        "[youtube-api-usage] {moment}: {} calls, ~{} units since start; {} sends (~{} units); Pacific day {}: ~{} units",
        snapshot.total_calls,
        snapshot.total_units,
        snapshot.sends.calls,
        snapshot.sends.units,
        snapshot.day.day,
        snapshot.day.units
    );
    if let Ok(json) = serde_json::to_string(&snapshot) {
        let _ = state.database.add_session_log(
            session_id,
            HealthLevel::Info,
            YOUTUBE_API_USAGE_LOG_CODE,
            &json,
            None,
        );
    }
}

/// Session task: a summary every [`USAGE_REPORT_INTERVAL`]. Aborted with the
/// chat connectors; the stop path logs the final line.
pub async fn run_usage_reporter(state: AppState, session_id: String) {
    loop {
        tokio::time::sleep(USAGE_REPORT_INTERVAL).await;
        log_usage_summary(&state, &session_id, "10-minute summary");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn classifier_tells_quota_from_rate_limits_and_permissions() {
        assert_eq!(
            classify_youtube_api_error(403, Some("quotaExceeded"), Some("youtube.quota")),
            YouTubeApiErrorClass::QuotaExhausted
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("somethingNew"), Some("youtube.quota")),
            YouTubeApiErrorClass::QuotaExhausted,
            "an unknown reason in the quota domain is still quota"
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("dailyLimitExceeded"), Some("usageLimits")),
            YouTubeApiErrorClass::QuotaExhausted
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("rateLimitExceeded"), Some("usageLimits")),
            YouTubeApiErrorClass::RateLimited
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("userRateLimitExceeded"), None),
            YouTubeApiErrorClass::RateLimited
        );
        assert_eq!(
            classify_youtube_api_error(429, None, None),
            YouTubeApiErrorClass::RateLimited
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("forbidden"), Some("global")),
            YouTubeApiErrorClass::Forbidden
        );
        assert_eq!(
            classify_youtube_api_error(403, Some("insufficientPermissions"), None),
            YouTubeApiErrorClass::Forbidden
        );
        assert_eq!(
            classify_youtube_api_error(401, None, None),
            YouTubeApiErrorClass::AuthExpired
        );
        assert_eq!(
            classify_youtube_api_error(503, None, None),
            YouTubeApiErrorClass::Transient
        );
    }

    #[test]
    fn the_api_base_url_override_is_loopback_only_and_refused_in_release_builds() {
        assert_eq!(
            resolve_youtube_api_base_url_override(true, Some("http://127.0.0.1:4321")),
            Ok(Some("http://127.0.0.1:4321".to_string()))
        );
        assert_eq!(
            resolve_youtube_api_base_url_override(true, Some(" http://127.0.0.1:4321/ ")),
            Ok(Some("http://127.0.0.1:4321".to_string()))
        );
        assert_eq!(resolve_youtube_api_base_url_override(true, None), Ok(None));
        assert_eq!(resolve_youtube_api_base_url_override(true, Some("  ")), Ok(None));
        for bad in [
            "https://127.0.0.1:4321",
            "http://localhost:4321",
            "http://127.0.0.1",
            "http://127.0.0.1:4321/youtube",
            "http://127.0.0.1:4321/?x=1",
            "http://user@127.0.0.1:4321",
            "https://www.googleapis.com",
            "not a url",
        ] {
            assert!(
                resolve_youtube_api_base_url_override(true, Some(bad)).is_err(),
                "{bad} must be refused"
            );
        }
        // Packaged builds never honour the variable, loopback or not.
        let refused = resolve_youtube_api_base_url_override(false, Some("http://127.0.0.1:4321"))
            .expect_err("release refuses the override");
        assert!(refused.contains("refused in packaged builds"), "{refused}");
        assert_eq!(resolve_youtube_api_base_url_override(false, None), Ok(None));
        // An explicit per-call base always wins; Google is the default.
        assert_eq!(
            youtube_api_base_url(Some("http://127.0.0.1:9/")),
            "http://127.0.0.1:9"
        );
        if std::env::var(YOUTUBE_API_BASE_URL_ENV).is_err() {
            assert_eq!(youtube_api_base_url(None), YOUTUBE_API_BASE_URL);
        }
    }

    #[test]
    fn the_owners_quota_body_parses_to_reason_and_domain() {
        let body = json!({
            "error": {
                "code": 403,
                "message": "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.",
                "errors": [{
                    "message": "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.",
                    "domain": "youtube.quota",
                    "reason": "quotaExceeded"
                }]
            }
        });
        assert_eq!(
            error_reason_and_domain(&body),
            (
                Some("quotaExceeded".to_string()),
                Some("youtube.quota".to_string())
            )
        );
        let error = YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            StatusCode::FORBIDDEN,
            &body.to_string(),
        );
        assert_eq!(error.class(), YouTubeApiErrorClass::QuotaExhausted);
        assert!(
            error
                .to_string()
                .starts_with("YouTube broadcast transition failed (403 Forbidden): quotaExceeded:")
        );
        assert!(is_quota_exhausted_error(&anyhow::Error::from(error)));
        assert_eq!(
            error_reason_and_domain_from_text("<html>Not JSON</html>"),
            (None, None)
        );
    }

    #[test]
    fn text_fallback_recognises_quota_in_old_style_messages() {
        let error = anyhow::anyhow!(
            "YouTube profile lookup failed with HTTP 403 Forbidden: quotaExceeded: quota exhausted"
        );
        assert!(is_quota_exhausted_error(&error));
        assert!(!is_quota_exhausted_error(&anyhow::anyhow!(
            "YouTube profile lookup failed with HTTP 403 Forbidden: insufficientPermissions"
        )));
        let rejection: anyhow::Error = crate::scheduled_youtube::YouTubeRejection {
            status: 403,
            reason: "quotaExceeded".to_string(),
        }
        .into();
        assert!(is_quota_exhausted_error(&rejection));
    }

    #[test]
    fn midnight_pacific_is_dst_aware() {
        // PDT (UTC-7): 2026-10-02 13:31 UTC is 06:31 PDT; next midnight is
        // 2026-10-03 00:00 PDT = 07:00 UTC.
        assert_eq!(
            next_pacific_midnight(utc("2026-10-02T13:31:11Z")),
            utc("2026-10-03T07:00:00Z")
        );
        // Spring forward: 2026-03-08 02:00 PST → 03:00 PDT. The evening before
        // is still PST (UTC-8); midnight on the 8th is 08:00 UTC, and the next
        // midnight after that is in PDT (07:00 UTC).
        assert_eq!(
            next_pacific_midnight(utc("2026-03-08T01:00:00Z")),
            utc("2026-03-08T08:00:00Z")
        );
        assert_eq!(
            next_pacific_midnight(utc("2026-03-08T12:00:00Z")),
            utc("2026-03-09T07:00:00Z")
        );
        // Fall back: 2026-11-01 02:00 PDT → 01:00 PST (09:00 UTC). Before the
        // change, midnight on the 1st is still PDT (07:00 UTC); after it the
        // next midnight is PST (08:00 UTC).
        assert_eq!(
            next_pacific_midnight(utc("2026-11-01T06:00:00Z")),
            utc("2026-11-01T07:00:00Z")
        );
        assert_eq!(
            next_pacific_midnight(utc("2026-11-01T10:00:00Z")),
            utc("2026-11-02T08:00:00Z")
        );
        // Just before midnight Pacific rolls to the very next midnight, not two away.
        assert_eq!(
            next_pacific_midnight(utc("2026-10-03T06:59:59Z")),
            utc("2026-10-03T07:00:00Z")
        );
        assert_eq!(pacific_day(utc("2026-10-03T06:59:59Z")), "2026-10-02");
        assert_eq!(pacific_day(utc("2026-10-03T07:00:00Z")), "2026-10-03");
    }

    #[test]
    fn a_quota_error_right_after_a_pause_expired_re_arms_for_thirty_minutes() {
        let now = utc("2026-10-03T07:01:00Z");
        assert_eq!(
            pause_target(now, Some(utc("2026-10-03T07:00:30Z"))),
            now + chrono::Duration::minutes(30)
        );
        // A quota error long after the last pause is a fresh day's exhaustion.
        assert_eq!(
            pause_target(now, Some(utc("2026-10-02T07:00:00Z"))),
            next_pacific_midnight(now)
        );
        assert_eq!(pause_target(now, None), next_pacific_midnight(now));
    }

    #[test]
    fn counter_totals_keep_sends_apart_and_roll_the_pacific_day() {
        let mut usage = YouTubeApiUsage::default();
        let day_one = utc("2026-10-02T13:00:00Z");
        for _ in 0..3 {
            usage.record(YouTubeEndpoint::LiveChatMessagesList, day_one);
        }
        usage.record(YouTubeEndpoint::LiveBroadcastsInsert, day_one);
        usage.record(YouTubeEndpoint::LiveChatMessagesInsert, day_one);
        usage.record(YouTubeEndpoint::LiveChatMessagesInsert, day_one);
        let snapshot = usage.snapshot();
        assert_eq!(snapshot.total_calls, 6);
        assert_eq!(snapshot.total_units, 3 + 50 + 100);
        assert_eq!(
            snapshot.sends,
            EndpointUsage {
                calls: 2,
                units: 100
            }
        );
        assert_eq!(
            snapshot
                .endpoints
                .iter()
                .map(|row| (row.endpoint.as_str(), row.calls, row.units))
                .collect::<Vec<_>>(),
            vec![
                ("liveBroadcasts.insert", 1, 50),
                ("liveChatMessages.list", 3, 3)
            ]
        );
        assert_eq!(snapshot.day.day, "2026-10-02");
        assert_eq!(snapshot.day.units, 153);
        // Past midnight Pacific the day total starts again; the lifetime
        // totals keep counting.
        usage.record(YouTubeEndpoint::VideosList, utc("2026-10-03T07:00:01Z"));
        let rolled = usage.snapshot();
        assert_eq!(rolled.day.day, "2026-10-03");
        assert_eq!(rolled.day.units, 1);
        assert_eq!(rolled.total_units, 154);
    }

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test]
    async fn recording_quota_pauses_until_midnight_pacific_and_publishes_the_event() {
        let state = test_state();
        let mut events = state.events.subscribe();
        assert_eq!(paused_until(&state), None);
        let until = record_quota_exhausted(&state, "test");
        assert_eq!(until, next_pacific_midnight(Utc::now()));
        assert_eq!(paused_until(&state), Some(until));
        assert!(refuse_if_paused(&state).is_err());
        let event = loop {
            let event = events.recv().await.unwrap();
            if event.event == YOUTUBE_QUOTA_EVENT {
                break event;
            }
        };
        assert_eq!(event.payload["pausedUntil"], json!(until.to_rfc3339()));
        // A second report while paused is idempotent.
        assert_eq!(record_quota_exhausted(&state, "again"), until);
        assert_eq!(status(&state).paused_until, Some(until.to_rfc3339()));
    }

    #[test]
    fn daily_total_persists_in_the_database() {
        let state = test_state();
        record_call(&state, YouTubeEndpoint::LiveChatMessagesList);
        record_call(&state, YouTubeEndpoint::LiveChatMessagesInsert);
        let saved: YouTubeApiDailyUsage = state
            .database
            .load_setting(YOUTUBE_API_USAGE_SETTING_KEY)
            .unwrap()
            .unwrap();
        assert_eq!(saved.calls, 2);
        assert_eq!(saved.units, 51);
        assert_eq!(saved.day, pacific_day(Utc::now()));
        assert_eq!(daily_usage(&state), saved);
    }

    #[derive(Clone)]
    struct ProbeMock {
        responses: Arc<Vec<(StatusCode, Value)>>,
        hits: Arc<AtomicUsize>,
    }

    async fn probe_channels(State(mock): State<ProbeMock>) -> impl IntoResponse {
        let index = mock.hits.fetch_add(1, Ordering::SeqCst);
        let (status, body) = mock
            .responses
            .get(index)
            .or_else(|| mock.responses.last())
            .cloned()
            .unwrap();
        (status, Json(body))
    }

    async fn spawn_probe_api(responses: Vec<(StatusCode, Value)>) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/youtube/v3/channels", get(probe_channels))
            .with_state(ProbeMock {
                responses: Arc::new(responses),
                hits: hits.clone(),
            });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), hits)
    }

    fn quota_body() -> Value {
        json!({ "error": { "errors": [{ "reason": "quotaExceeded", "domain": "youtube.quota" }] } })
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn the_expiry_probe_re_arms_thirty_minutes_on_a_second_quota_error_then_clears() {
        let state = test_state();
        let (base, hits) = spawn_probe_api(vec![
            (StatusCode::FORBIDDEN, quota_body()),
            (StatusCode::OK, json!({ "items": [{ "id": "UC-owner" }] })),
        ])
        .await;
        configure_probe(&state, Some(base), 0, Some("token-1".to_string()));

        // The pause lifts now: the probe fires at once and hits quota again.
        pause_until_for_tests(&state, Utc::now());
        wait_until(|| hits.load(Ordering::SeqCst) >= 1).await;
        let rearmed = wait_for_pause_change(&state, |until| {
            until.is_some_and(|until| until > Utc::now() + chrono::Duration::minutes(25))
        })
        .await;
        let rearmed_until = rearmed.expect("re-armed");
        assert!(rearmed_until <= Utc::now() + REARM_PAUSE + chrono::Duration::seconds(5));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "one unit spent so far");

        // Simulate the 30 minutes passing: move the pause to now again. The
        // probe loop is still armed and fires once more; this time YouTube
        // answers, so the breaker clears and resumes everyone.
        state.youtube_quota.paused.send_replace(Some(Utc::now()));
        wait_until(|| paused_until(&state).is_none()).await;
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert_eq!(usage_snapshot(&state).total_calls, 2);
        wait_until(|| !state.youtube_quota.lock().probe_armed).await;
    }

    async fn wait_for_pause_change(
        state: &AppState,
        done: impl Fn(Option<DateTime<Utc>>) -> bool,
    ) -> Option<DateTime<Utc>> {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let current = *state.youtube_quota.paused.borrow();
            if done(current) {
                return current;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out: {current:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn wait_until_resumed_returns_when_the_breaker_clears() {
        let state = test_state();
        state
            .youtube_quota
            .paused
            .send_replace(Some(Utc::now() + chrono::Duration::hours(1)));
        let waiter = {
            let state = state.clone();
            tokio::spawn(async move {
                wait_until_resumed(&state).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "still parked while paused");
        clear_pause(&state, "test");
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("resumed")
            .unwrap();
    }
}
