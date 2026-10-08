//! Live concurrent-viewer sampling (plan rider V1, vault "2026-07-07 -
//! Videorc OBS Import Plan"). While a stream session runs, poll each connected
//! platform's public count on its own bounded cadence, emit the latest as a
//! `stream.viewers` event, and PERSIST every sample with the session (the
//! point is owning the data — a later cut moves it onto the video / a
//! post-stream graph). Terminology honesty: these are concurrent VIEWERS, not
//! subscribers — UI copy says "watching".
//!
//! Failure discipline: sampling can never degrade the stream or chat. A
//! failed poll is a missing datum (skip the tick), with its own backoff.
//! YouTube polls cost quota (plan 096): they run every 120 s, skip entirely
//! while the shared quota breaker is set, back off on a 403, and a
//! `quotaExceeded` answer sets the breaker for every other YouTube caller.
//!
//! One total per session (plan 055, B1): the YouTube + Twitch sampler and the
//! X sampler both feed [`ViewerAggregator`], so every emitted sample sums all
//! platforms with a fresh count instead of one sampler's partial total.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;

use crate::protocol::HealthLevel;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

/// Common cadence for Twitch, Kick and X. YouTube uses its independent
/// service-flags interval (120 seconds by default).
pub const VIEWER_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);
pub const VIEWER_SAMPLE_LOG_CODE: &str = "stream-viewers";
/// A platform's count leaves the total once it is this old, regardless of
/// that provider's polling cadence. Matches the renderer's stale-chip
/// threshold (`lib/viewer-count-view.ts`).
pub const VIEWER_FRESHNESS: Duration = Duration::from_secs(150);
/// `sessions.viewers.list` returns at most this many samples, the latest:
/// twenty-four hours at the 60-second cadence.
pub const VIEWER_HISTORY_LIMIT: usize = 1_440;
/// After a YouTube 403 that is not quota, skip this many polls, doubling per
/// repeat up to [`YOUTUBE_MAX_SKIPPED_POLLS`]. Wall time depends on the current
/// YouTube cadence (20 minutes of skipped deadlines at the 120-second default).
pub const YOUTUBE_MAX_SKIPPED_POLLS: u32 = 10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeViewerConfig {
    pub access_token: String,
    pub broadcast_id: String,
    /// API origin or versioned `/youtube/v3` root; accepts the chat connector
    /// origin when the coordinator shares its local provider override.
    #[serde(default)]
    pub api_base_url: Option<String>,
    /// Renews `access_token` mid-stream (plan 055, B2); never from params.
    #[serde(skip)]
    pub token_source: crate::session_token::SessionTokenSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchViewerConfig {
    pub access_token: String,
    pub client_id: String,
    pub broadcaster_user_id: String,
    #[serde(default)]
    pub api_base_url: Option<String>,
    /// The destination whose ingest this channel answers for (plan 161).
    #[serde(default)]
    pub target_id: Option<String>,
    /// Renews `access_token` mid-stream (plan 055, B2); never from params.
    #[serde(skip)]
    pub token_source: crate::session_token::SessionTokenSource,
}

/// Kick reads the connected user's own channel (`GET /public/v1/channels`
/// with no params), so only the user token is needed (plan 063, S6).
#[derive(Debug, Clone)]
pub struct KickViewerConfig {
    pub access_token: String,
    pub api_base_url: Option<String>,
    /// Renews `access_token` mid-stream; never from params.
    pub token_source: crate::session_token::SessionTokenSource,
}

/// One count poll: a refused token is told apart from a missing count so
/// the sampler can renew it (plan 055, B2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CountFetch {
    Count(Option<u64>),
    /// A good answer that the channel is not live (Twitch: empty `data`).
    /// No count, but a fact the platform watch uses (plan 161).
    Offline,
    Refused,
    /// A 403 that is not the shared quota: permissions. Back off this platform.
    Forbidden,
}

/// How many polls YouTube sits out after `forbidden_streak` 403s in a row.
pub fn youtube_polls_to_skip(forbidden_streak: u32) -> u32 {
    if forbidden_streak == 0 {
        return 0;
    }
    2u32.saturating_pow(forbidden_streak)
        .min(YOUTUBE_MAX_SKIPPED_POLLS)
}

/// YouTube's own backoff: skipped polls after permissions refusals.
#[derive(Debug, Default)]
struct YouTubeViewerBackoff {
    forbidden_streak: u32,
    skip_polls: u32,
}

fn count_fetch_for_status(status: reqwest::StatusCode) -> Option<CountFetch> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Some(CountFetch::Refused);
    }
    (!status.is_success()).then_some(CountFetch::Count(None))
}

/// Polls once, renewing a refused token and polling again. A token that
/// cannot be renewed is a missing count, as any other failure.
async fn poll_with_renewal<F, Fut>(
    state: &AppState,
    client: &reqwest::Client,
    token: &mut crate::session_token::SessionToken,
    fetch: F,
) -> Option<u64>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = CountFetch>,
{
    poll_with_renewal_outcome(state, client, token, fetch)
        .await
        .count()
}

impl CountFetch {
    fn count(self) -> Option<u64> {
        match self {
            Self::Count(count) => count,
            Self::Offline | Self::Refused | Self::Forbidden => None,
        }
    }
}

async fn poll_with_renewal_outcome<F, Fut>(
    state: &AppState,
    client: &reqwest::Client,
    token: &mut crate::session_token::SessionToken,
    fetch: F,
) -> CountFetch
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = CountFetch>,
{
    let access_token = token.ensure_fresh(state, client).await.to_string();
    match fetch(access_token).await {
        CountFetch::Refused => {
            let Ok(renewed) = token.renew_after_refusal(state, client).await else {
                return CountFetch::Refused;
            };
            match fetch(renewed.to_string()).await {
                CountFetch::Refused => CountFetch::Refused,
                other => other,
            }
        }
        other => other,
    }
}

/// One YouTube viewer poll behind the shared quota breaker (plan 094): no
/// request while paused or while backing off a 403; a quota refusal sets the
/// breaker; the call is counted.
async fn poll_youtube_count(
    state: &AppState,
    client: &reqwest::Client,
    config: &YouTubeViewerConfig,
    token: &mut crate::session_token::SessionToken,
    backoff: &mut YouTubeViewerBackoff,
) -> Option<u64> {
    if crate::youtube_quota::paused_until(state).is_some() {
        return None;
    }
    // Plan 094 (S6): the daily budget slows viewers at 80% and stops them at 95%.
    if crate::youtube_quota::budget_refuses(state, crate::youtube_quota::BudgetCall::Viewers)
        .is_some()
    {
        return None;
    }
    if backoff.skip_polls > 0 {
        backoff.skip_polls -= 1;
        return None;
    }
    let outcome = poll_with_renewal_outcome(state, client, token, |access_token| async move {
        fetch_youtube_count(state, client, config, &access_token).await
    })
    .await;
    match outcome {
        CountFetch::Forbidden => {
            backoff.forbidden_streak = backoff.forbidden_streak.saturating_add(1);
            backoff.skip_polls = youtube_polls_to_skip(backoff.forbidden_streak);
            None
        }
        CountFetch::Count(Some(count)) => {
            backoff.forbidden_streak = 0;
            Some(count)
        }
        CountFetch::Count(None) | CountFetch::Offline | CountFetch::Refused => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XViewerConfig {
    pub broadcast_id: String,
    #[serde(default)]
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPlatformCount {
    pub platform: StreamPlatform,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSample {
    pub session_id: String,
    pub platforms: Vec<ViewerPlatformCount>,
    pub total: u64,
    pub at: String,
}

/// YouTube `videos.list part=liveStreamingDetails` → `concurrentViewers`
/// (the API returns it as a STRING, absent once the stream ends).
pub fn parse_youtube_concurrent_viewers(body: &Value) -> Option<u64> {
    body.get("items")?
        .as_array()?
        .first()?
        .get("liveStreamingDetails")?
        .get("concurrentViewers")?
        .as_str()?
        .parse()
        .ok()
}

/// Twitch Helix `Get Streams` → `data[0].viewer_count` (empty data = offline).
pub fn parse_twitch_viewer_count(body: &Value) -> Option<u64> {
    body.get("data")?
        .as_array()?
        .first()?
        .get("viewer_count")?
        .as_u64()
}

/// Kick `GET /public/v1/channels` → `data[0].stream.viewer_count`. Unknown
/// (`None`) until Kick marks the channel live: Kick keeps the last count on an
/// offline stream, and it takes a while to flip `is_live` after the video
/// arrives, so a "0" there would read as nobody watching (plan 066).
pub fn parse_kick_viewer_count(body: &Value) -> Option<u64> {
    let stream = body.get("data")?.as_array()?.first()?.get("stream")?;
    if !stream
        .get("is_live")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    stream.get("viewer_count")?.as_u64()
}

pub fn merge_viewer_sample(
    session_id: &str,
    counts: Vec<(StreamPlatform, Option<u64>)>,
    at: String,
) -> Option<ViewerSample> {
    let platforms: Vec<ViewerPlatformCount> = counts
        .into_iter()
        .filter_map(|(platform, count)| count.map(|count| ViewerPlatformCount { platform, count }))
        .collect();
    if platforms.is_empty() {
        return None;
    }
    let total = platforms.iter().map(|entry| entry.count).sum();
    Some(ViewerSample {
        session_id: session_id.to_string(),
        platforms,
        total,
        at,
    })
}

/// The latest count per platform for the current session. Samplers record
/// what they polled; the sample they emit covers every fresh platform.
#[derive(Debug, Default)]
pub struct ViewerAggregator {
    session_id: Option<String>,
    latest: Vec<(StreamPlatform, u64, chrono::DateTime<chrono::Utc>)>,
}

impl ViewerAggregator {
    /// The fresh total right now (every platform polled within
    /// `VIEWER_FRESHNESS`), `None` when no sampler has reported. Golem's
    /// promise triggers read it (plan 068 D8).
    pub fn current_total(&self, now: chrono::DateTime<chrono::Utc>) -> Option<u64> {
        let freshness =
            chrono::Duration::from_std(VIEWER_FRESHNESS).unwrap_or(chrono::Duration::seconds(75));
        let fresh: Vec<u64> = self
            .latest
            .iter()
            .filter(|(_, _, at)| now.signed_duration_since(*at) <= freshness)
            .map(|(_, count, _)| *count)
            .collect();
        if fresh.is_empty() {
            return None;
        }
        Some(
            fresh
                .iter()
                .fold(0u64, |total, count| total.saturating_add(*count)),
        )
    }

    /// Records one sampler's poll. Returns `None` when that poll reported no
    /// platform: the sampler has nothing new to say, and a total built only
    /// from other samplers' older counts would repeat their own emission.
    pub fn record(
        &mut self,
        session_id: &str,
        counts: Vec<(StreamPlatform, Option<u64>)>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Option<ViewerSample> {
        if self.session_id.as_deref() != Some(session_id) {
            self.session_id = Some(session_id.to_string());
            self.latest.clear();
        }
        let mut reported = false;
        for (platform, count) in counts {
            let Some(count) = count else {
                continue;
            };
            reported = true;
            match self.latest.iter_mut().find(|entry| entry.0 == platform) {
                Some(entry) => {
                    entry.1 = count;
                    entry.2 = now;
                }
                None => self.latest.push((platform, count, now)),
            }
        }
        let freshness =
            chrono::Duration::from_std(VIEWER_FRESHNESS).unwrap_or(chrono::Duration::seconds(75));
        self.latest
            .retain(|(_, _, at)| now.signed_duration_since(*at) <= freshness);
        if !reported {
            return None;
        }
        let mut latest = self.latest.clone();
        latest.sort_by_key(|(platform, _, _)| *platform as u8);
        merge_viewer_sample(
            session_id,
            latest
                .into_iter()
                .map(|(platform, count, _)| (platform, Some(count)))
                .collect(),
            now.to_rfc3339(),
        )
    }
}

/// `sessions.viewers.list` params.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewersListParams {
    pub session_id: String,
}

/// `sessions.viewers.list` result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewersPage {
    pub samples: Vec<ViewerSample>,
}

/// A session's saved samples, oldest first, capped at [`VIEWER_HISTORY_LIMIT`].
/// Rows that no longer parse are skipped rather than failing the history.
pub fn session_viewer_history(
    database: &crate::storage::Database,
    session_id: &str,
) -> anyhow::Result<Vec<ViewerSample>> {
    Ok(database
        .list_session_log_messages(session_id, VIEWER_SAMPLE_LOG_CODE, VIEWER_HISTORY_LIMIT)?
        .iter()
        .filter_map(|message| serde_json::from_str::<ViewerSample>(message).ok())
        .collect())
}

fn youtube_viewer_api_root(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/youtube/v3") {
        base.to_string()
    } else {
        format!("{base}/youtube/v3")
    }
}

async fn fetch_youtube_count(
    state: &AppState,
    client: &reqwest::Client,
    config: &YouTubeViewerConfig,
    access_token: &str,
) -> CountFetch {
    let base = youtube_viewer_api_root(&crate::youtube_quota::youtube_api_base_url(
        config.api_base_url.as_deref(),
    ));
    let url = format!(
        "{}/videos?part=liveStreamingDetails&id={}",
        base.trim_end_matches('/'),
        config.broadcast_id
    );
    let Ok(response) = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::VideosList,
        crate::youtube_quota::BudgetCall::Viewers,
        client,
        client.get(url).bearer_auth(access_token),
    )
    .await
    else {
        return CountFetch::Count(None);
    };
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        // Quota pauses every YouTube caller; any other 403 is this sampler's
        // own problem (permissions), so only it backs off.
        let body = response.text().await.unwrap_or_default();
        let (reason, domain) = crate::youtube_quota::error_reason_and_domain_from_text(&body);
        return match crate::youtube_quota::classify_youtube_api_error(
            403,
            reason.as_deref(),
            domain.as_deref(),
        ) {
            crate::youtube_quota::YouTubeApiErrorClass::QuotaExhausted => {
                crate::youtube_quota::record_quota_exhausted(state, "viewer count");
                CountFetch::Count(None)
            }
            crate::youtube_quota::YouTubeApiErrorClass::RateLimited => CountFetch::Count(None),
            _ => CountFetch::Forbidden,
        };
    }
    if let Some(outcome) = count_fetch_for_status(response.status()) {
        return outcome;
    }
    let body: Option<Value> = response.json().await.ok();
    CountFetch::Count(body.as_ref().and_then(parse_youtube_concurrent_viewers))
}

async fn fetch_twitch_count(
    client: &reqwest::Client,
    config: &TwitchViewerConfig,
    access_token: &str,
) -> CountFetch {
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or("https://api.twitch.tv/helix");
    let url = format!(
        "{}/streams?user_id={}",
        base.trim_end_matches('/'),
        config.broadcaster_user_id
    );
    let Ok(response) = client
        .get(url)
        .bearer_auth(access_token)
        .header("Client-Id", &config.client_id)
        .send()
        .await
    else {
        return CountFetch::Count(None);
    };
    if let Some(outcome) = count_fetch_for_status(response.status()) {
        return outcome;
    }
    let body: Option<Value> = response.json().await.ok();
    if body.as_ref().is_some_and(twitch_reports_offline) {
        return CountFetch::Offline;
    }
    CountFetch::Count(body.as_ref().and_then(parse_twitch_viewer_count))
}

/// Twitch Helix `Get Streams` with an empty `data` list: the channel is not
/// live. A malformed body is not that answer.
pub fn twitch_reports_offline(body: &Value) -> bool {
    body.get("data")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

/// The platform-watch answer for one Twitch poll (plan 161).
fn twitch_platform_answer(
    outcome: Option<CountFetch>,
) -> crate::platform_stream_watch::PlatformAnswer {
    match outcome {
        Some(CountFetch::Count(Some(_))) => crate::platform_stream_watch::PlatformAnswer::Receiving,
        Some(CountFetch::Offline) => crate::platform_stream_watch::PlatformAnswer::NotReceiving(
            "Twitch shows the channel offline".to_string(),
        ),
        _ => crate::platform_stream_watch::PlatformAnswer::Unknown,
    }
}

async fn fetch_kick_count(
    client: &reqwest::Client,
    config: &KickViewerConfig,
    access_token: &str,
) -> CountFetch {
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or("https://api.kick.com");
    let url = format!("{}/public/v1/channels", base.trim_end_matches('/'));
    let Ok(response) = client.get(url).bearer_auth(access_token).send().await else {
        return CountFetch::Count(None);
    };
    if let Some(outcome) = count_fetch_for_status(response.status()) {
        return outcome;
    }
    let body: Option<Value> = response.json().await.ok();
    CountFetch::Count(body.as_ref().and_then(parse_kick_viewer_count))
}

/// Session log code for an X viewer poll that produced no count (plan 054).
pub const X_VIEWER_LOG_CODE: &str = "stream-viewers-x";

/// Why X polls came back without a count, logged once per distinct reason per
/// session: an HTTP status and an envelope mismatch used to look identical
/// (no log, no sample) through 19 real broadcasts.
#[derive(Debug, Default)]
pub struct XViewerDiagnostics {
    logged: std::collections::HashSet<String>,
}

impl XViewerDiagnostics {
    /// The reason to log for this outcome, only the first time it is seen.
    pub fn first_report(&mut self, outcome: &crate::x_live::XViewerCountOutcome) -> Option<String> {
        let reason = outcome.log_reason()?;
        self.logged.insert(reason.clone()).then_some(reason)
    }
}

async fn fetch_x_count(
    state: &AppState,
    session_id: &str,
    client: &reqwest::Client,
    config: &XViewerConfig,
    diagnostics: &mut XViewerDiagnostics,
) -> Option<u64> {
    // Credentials are resolved per poll so a rotated token is picked up
    // without restarting the sampler.
    let Some(credentials) = crate::x_live::x_livestream_credentials().ok().flatten() else {
        if diagnostics.logged.insert("missing-credentials".to_string()) {
            let _ = state.database.add_session_log(
                session_id,
                HealthLevel::Warn,
                X_VIEWER_LOG_CODE,
                "X viewers need the \"Authorize X Live\" token, which is missing.",
                None,
            );
        }
        return None;
    };
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or(crate::x_live::DEFAULT_API_BASE_URL);
    let outcome = crate::x_live::fetch_broadcast_viewer_count(
        client,
        &credentials,
        base,
        &config.broadcast_id,
    )
    .await;
    if let Some(reason) = diagnostics.first_report(&outcome) {
        let _ = state.database.add_session_log(
            session_id,
            HealthLevel::Warn,
            X_VIEWER_LOG_CODE,
            &reason,
            None,
        );
    }
    outcome.count()
}

/// Session-scoped sampler task; aborted with the live-chat connectors on stop.
pub async fn run_viewer_sampler(
    state: AppState,
    session_id: String,
    youtube: Option<YouTubeViewerConfig>,
    twitch: Option<TwitchViewerConfig>,
    x: Option<XViewerConfig>,
    kick: Option<KickViewerConfig>,
) {
    if youtube.is_none() && twitch.is_none() && x.is_none() && kick.is_none() {
        return;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("viewer HTTP client");
    let jitter_ms = (session_id.bytes().map(u64::from).sum::<u64>() % 5000) + 500;
    sleep(Duration::from_millis(jitter_ms)).await;

    // These futures are owned by this sampler, not detached tasks. Dropping
    // the sampler cancels every pending provider request and timer together.
    let youtube_work = async {
        let Some(config) = youtube else { return };
        let mut token = crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        );
        let mut backoff = YouTubeViewerBackoff::default();
        let mut deadline = ProviderDeadline::new();
        loop {
            deadline.wait(&state, true).await;
            let count = tokio::time::timeout(
                Duration::from_secs(25),
                poll_youtube_count(&state, &client, &config, &mut token, &mut backoff),
            )
            .await
            .ok()
            .flatten();
            record_provider_sample(&state, &session_id, StreamPlatform::Youtube, count);
        }
    };
    let twitch_work = async {
        let Some(config) = twitch else { return };
        let mut token = crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        );
        let mut deadline = ProviderDeadline::new();
        let mut liveness = crate::platform_stream_watch::PlatformLiveness::default();
        loop {
            deadline.wait(&state, false).await;
            let client = &client;
            let config = &config;
            let outcome = tokio::time::timeout(
                Duration::from_secs(25),
                poll_with_renewal_outcome(&state, client, &mut token, |access_token| async move {
                    fetch_twitch_count(client, config, &access_token).await
                }),
            )
            .await
            .ok();
            let count = outcome.and_then(CountFetch::count);
            record_provider_sample(&state, &session_id, StreamPlatform::Twitch, count);
            // Plan 161: Twitch's own word on whether it receives the stream.
            if let Some(observation) = liveness.observe(twitch_platform_answer(outcome)) {
                crate::recording::observe_platform_stream(
                    &state,
                    &session_id,
                    StreamPlatform::Twitch,
                    config.target_id.as_deref(),
                    observation,
                )
                .await;
            }
        }
    };
    let kick_work = async {
        let Some(config) = kick else { return };
        let mut token = crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        );
        let mut deadline = ProviderDeadline::new();
        loop {
            deadline.wait(&state, false).await;
            let client = &client;
            let config = &config;
            let count = tokio::time::timeout(
                Duration::from_secs(25),
                poll_with_renewal(&state, client, &mut token, |access_token| async move {
                    fetch_kick_count(client, config, &access_token).await
                }),
            )
            .await
            .ok()
            .flatten();
            record_provider_sample(&state, &session_id, StreamPlatform::Kick, count);
        }
    };
    let x_work = async {
        let Some(config) = x else { return };
        let mut diagnostics = XViewerDiagnostics::default();
        let mut deadline = ProviderDeadline::new();
        loop {
            deadline.wait(&state, false).await;
            let count = tokio::time::timeout(
                Duration::from_secs(25),
                fetch_x_count(&state, &session_id, &client, &config, &mut diagnostics),
            )
            .await
            .ok()
            .flatten();
            record_provider_sample(&state, &session_id, StreamPlatform::X, count);
        }
    };
    tokio::join!(youtube_work, twitch_work, kick_work, x_work);
}

fn record_provider_sample(
    state: &AppState,
    session_id: &str,
    platform: StreamPlatform,
    count: Option<u64>,
) {
    let sample = state
        .viewer_aggregator
        .lock()
        .ok()
        .and_then(|mut aggregator| {
            aggregator.record(session_id, vec![(platform, count)], chrono::Utc::now())
        });
    if let Some(sample) = sample {
        if let Ok(json) = serde_json::to_string(&sample) {
            let _ = state.database.add_session_log(
                session_id,
                HealthLevel::Info,
                VIEWER_SAMPLE_LOG_CODE,
                &json,
                None,
            );
        }
        state.emit_event("stream.viewers", sample);
    }
}

/// A provider owns its own monotonic deadline. No modulo coupling to another
/// provider, no overlapping work, and changed flags never cause catch-up bursts.
struct ProviderDeadline {
    last_start: Option<tokio::time::Instant>,
}
impl ProviderDeadline {
    fn new() -> Self {
        Self { last_start: None }
    }
    async fn wait(&mut self, state: &AppState, youtube: bool) {
        if let Some(last) = self.last_start {
            let mut flags = crate::youtube_quota::subscribe_service_flags(state);
            let mut interval = provider_interval(state, youtube);
            let mut next = last + interval;
            if next < tokio::time::Instant::now() {
                next = tokio::time::Instant::now() + interval;
            }
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(next) => break,
                    change = flags.changed(), if youtube => {
                        if change.is_err() { break; }
                        let updated = provider_interval(state, youtube);
                        if updated != interval {
                            interval = updated;
                            next = last + interval;
                            if next <= tokio::time::Instant::now() { next = tokio::time::Instant::now() + interval; }
                        }
                    }
                }
            }
        }
        self.last_start = Some(tokio::time::Instant::now());
    }
}

fn provider_interval(state: &AppState, youtube: bool) -> Duration {
    if !youtube {
        return VIEWER_SAMPLE_INTERVAL;
    }
    let interval = crate::youtube_quota::viewer_sample_interval(state);
    if crate::youtube_quota::budget_status(state).step
        >= crate::youtube_quota::BudgetStep::ShedExtras
    {
        interval.max(Duration::from_secs(120))
    } else {
        interval
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn twitch_empty_data_is_an_offline_answer_not_a_missing_count() {
        assert!(twitch_reports_offline(&json!({"data": []})));
        assert!(!twitch_reports_offline(
            &json!({"data": [{"viewer_count": 0}]})
        ));
        assert!(!twitch_reports_offline(&json!({"error": "nope"})));
        use crate::platform_stream_watch::PlatformAnswer;
        assert_eq!(
            twitch_platform_answer(Some(CountFetch::Count(Some(0)))),
            PlatformAnswer::Receiving,
            "live with nobody watching is still live"
        );
        assert!(matches!(
            twitch_platform_answer(Some(CountFetch::Offline)),
            PlatformAnswer::NotReceiving(_)
        ));
        assert_eq!(
            twitch_platform_answer(Some(CountFetch::Count(None))),
            PlatformAnswer::Unknown
        );
        assert_eq!(twitch_platform_answer(None), PlatformAnswer::Unknown);
        assert_eq!(CountFetch::Offline.count(), None);
    }
    fn test_state() -> AppState {
        AppState::new(
            "test".into(),
            1234,
            tokio::sync::broadcast::channel(64).0,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test]
    async fn held_youtube_http_does_not_delay_twitch_and_stop_owns_every_reader() {
        use axum::{
            Router,
            body::{Body, Bytes},
            response::IntoResponse,
            routing::get,
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        struct Held(Arc<AtomicUsize>, tokio::sync::mpsc::UnboundedSender<()>);
        impl Drop for Held {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
                let _ = self.1.send(());
            }
        }
        let active = Arc::new(AtomicUsize::new(0));
        let opens = Arc::new(AtomicUsize::new(0));
        let (opened, mut openings) = tokio::sync::mpsc::unbounded_channel();
        let (closed, mut closures) = tokio::sync::mpsc::unbounded_channel();
        let (twitch_called, mut twitch_calls) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new()
            .route(
                "/youtube/v3/videos",
                get({
                    let active = active.clone();
                    let opens = opens.clone();
                    move || {
                        let active = active.clone();
                        let opens = opens.clone();
                        let opened = opened.clone();
                        let closed = closed.clone();
                        async move {
                            assert_eq!(
                                active.fetch_add(1, Ordering::SeqCst),
                                0,
                                "YouTube requests must not overlap"
                            );
                            opens.fetch_add(1, Ordering::SeqCst);
                            let held = Held(active, closed);
                            let _ = opened.send(());
                            Body::from_stream(futures_util::stream::poll_fn(move |_| {
                                let _keep_alive = &held;
                                std::task::Poll::<Option<Result<Bytes, std::io::Error>>>::Pending
                            }))
                            .into_response()
                        }
                    }
                }),
            )
            .route(
                "/streams",
                get(move || {
                    let called = twitch_called.clone();
                    async move {
                        let _ = called.send(());
                        axum::Json(json!({"data":[{"viewer_count":42}]}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let state = test_state();
        let mut events = state.events.subscribe();
        let mut flags = crate::service_flags::YouTubeServiceFlags::default();
        flags.viewer_sample_ms = 110_000;
        crate::youtube_quota::apply_service_flags(&state, flags);
        let sampler = tokio::spawn(run_viewer_sampler(
            state.clone(),
            "a".into(),
            Some(YouTubeViewerConfig {
                access_token: "test".into(),
                broadcast_id: "test".into(),
                api_base_url: Some(base.clone()),
                token_source: crate::session_token::SessionTokenSource::Fixed,
            }),
            Some(TwitchViewerConfig {
                access_token: "test".into(),
                client_id: "test".into(),
                broadcaster_user_id: "test".into(),
                api_base_url: Some(base),
                target_id: None,
                token_source: crate::session_token::SessionTokenSource::Fixed,
            }),
            None,
            None,
        ));
        async fn next_sample(
            events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
        ) {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.event == "stream.viewers" {
                        assert_eq!(event.payload["total"], 42);
                        break;
                    }
                }
            })
            .await
            .expect("Twitch observation must not wait for YouTube");
        }
        next_sample(&mut events).await;
        assert_eq!(active.load(Ordering::SeqCst), 1);
        openings.recv().await.unwrap();
        twitch_calls.recv().await.unwrap();
        async fn advance(seconds: u64) {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(seconds)).await;
            tokio::time::resume();
        }
        advance(61).await;
        next_sample(&mut events).await;
        tokio::time::timeout(Duration::from_secs(2), closures.recv())
            .await
            .unwrap()
            .unwrap();
        advance(50).await;
        tokio::time::timeout(Duration::from_secs(2), openings.recv())
            .await
            .unwrap()
            .unwrap();
        advance(10).await;
        next_sample(&mut events).await;
        assert_eq!(
            active.load(Ordering::SeqCst),
            1,
            "YouTube remains pending at Twitch's next deadline"
        );
        assert_eq!(opens.load(Ordering::SeqCst), 2);
        sampler.abort();
        assert!(sampler.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), closures.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            active.load(Ordering::SeqCst),
            0,
            "owner cancellation closes held response"
        );
        advance(300).await;
        tokio::task::yield_now().await;
        assert_eq!(
            opens.load(Ordering::SeqCst),
            2,
            "stopped reader cannot reopen"
        );
        server.abort();
    }

    #[test]
    fn youtube_viewer_root_accepts_origin_or_versioned_root() {
        for base in [
            "https://www.googleapis.com",
            "https://www.googleapis.com/",
            "https://www.googleapis.com/youtube/v3",
            "https://www.googleapis.com/youtube/v3/",
        ] {
            assert_eq!(
                youtube_viewer_api_root(base),
                "https://www.googleapis.com/youtube/v3"
            );
        }
        for base in [
            "http://127.0.0.1:4567",
            "http://127.0.0.1:4567/",
            "http://127.0.0.1:4567/youtube/v3",
            "http://127.0.0.1:4567/youtube/v3/",
        ] {
            assert_eq!(
                youtube_viewer_api_root(base),
                "http://127.0.0.1:4567/youtube/v3"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn independent_deadlines_count_two_hour_windows_without_catchup() {
        let state = test_state();
        let count = |youtube| {
            let state = state.clone();
            async move {
                let start = tokio::time::Instant::now();
                let mut deadline = ProviderDeadline::new();
                let mut calls = 0;
                loop {
                    deadline.wait(&state, youtube).await;
                    if tokio::time::Instant::now() - start >= Duration::from_secs(7200) {
                        break;
                    }
                    calls += 1;
                }
                calls
            }
        };
        let (youtube, other) = tokio::join!(count(true), count(false));
        assert_eq!(youtube, 60);
        assert_eq!(other, 120);
    }

    #[tokio::test(start_paused = true)]
    async fn changed_youtube_deadline_does_not_change_other_provider_or_double_shed_cadence() {
        let state = test_state();
        let mut flags = crate::service_flags::YouTubeServiceFlags::default();
        flags.viewer_sample_ms = 30_000;
        crate::youtube_quota::apply_service_flags(&state, flags.clone());
        assert_eq!(provider_interval(&state, true), Duration::from_secs(30));
        assert_eq!(provider_interval(&state, false), Duration::from_secs(60));
        let mut deadline = ProviderDeadline::new();
        deadline.wait(&state, true).await;
        let waiter_state = state.clone();
        let waiter = tokio::spawn(async move {
            deadline.wait(&waiter_state, true).await;
            tokio::time::Instant::now()
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(10)).await;
        flags.viewer_sample_ms = 120_000;
        crate::youtube_quota::apply_service_flags(&state, flags);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(30)).await;
        assert!(!waiter.is_finished());
        for _ in 0..40 {
            crate::youtube_quota::record_call(
                &state,
                crate::youtube_quota::YouTubeEndpoint::LiveChatMessagesInsert,
            );
        }
        assert_eq!(provider_interval(&state, true), Duration::from_secs(120));
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn parses_youtube_concurrent_viewers_string() {
        let body = json!({
            "items": [{ "liveStreamingDetails": { "concurrentViewers": "1234" } }]
        });
        assert_eq!(parse_youtube_concurrent_viewers(&body), Some(1234));
        // Ended stream: the field disappears.
        let ended = json!({ "items": [{ "liveStreamingDetails": {} }] });
        assert_eq!(parse_youtube_concurrent_viewers(&ended), None);
        assert_eq!(
            parse_youtube_concurrent_viewers(&json!({ "items": [] })),
            None
        );
    }

    #[test]
    fn parses_twitch_viewer_count() {
        let body = json!({ "data": [{ "viewer_count": 87 }] });
        assert_eq!(parse_twitch_viewer_count(&body), Some(87));
        // Offline channel: empty data.
        assert_eq!(parse_twitch_viewer_count(&json!({ "data": [] })), None);
    }

    #[test]
    fn parses_kick_viewer_count() {
        let live = json!({ "data": [{ "stream": { "is_live": true, "viewer_count": 42 } }] });
        assert_eq!(parse_kick_viewer_count(&live), Some(42));
        let offline = json!({ "data": [{ "stream": { "is_live": false, "viewer_count": 9 } }] });
        assert_eq!(parse_kick_viewer_count(&offline), None);
        assert_eq!(parse_kick_viewer_count(&json!({ "data": [] })), None);
        let no_count = json!({ "data": [{ "stream": { "is_live": true } }] });
        assert_eq!(parse_kick_viewer_count(&no_count), None);
    }

    #[tokio::test]
    async fn fetch_kick_count_reads_the_self_channel_and_flags_refusals() {
        use axum::{Json, Router, http::HeaderMap, http::StatusCode, routing::get};
        async fn channels(headers: HeaderMap) -> (StatusCode, Json<Value>) {
            match headers.get("authorization").and_then(|v| v.to_str().ok()) {
                Some("Bearer good") => (
                    StatusCode::OK,
                    Json(
                        json!({ "data": [{ "stream": { "is_live": true, "viewer_count": 17 } }] }),
                    ),
                ),
                _ => (StatusCode::UNAUTHORIZED, Json(json!({}))),
            }
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/public/v1/channels", get(channels));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let config = KickViewerConfig {
            access_token: "good".to_string(),
            api_base_url: Some(format!("http://{addr}")),
            token_source: Default::default(),
        };
        let client = reqwest::Client::new();
        assert_eq!(
            fetch_kick_count(&client, &config, "good").await,
            CountFetch::Count(Some(17))
        );
        assert_eq!(
            fetch_kick_count(&client, &config, "stale").await,
            CountFetch::Refused
        );
    }

    fn at(seconds: i64) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-09-24T10:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
            + chrono::Duration::seconds(seconds)
    }

    fn totals(sample: &ViewerSample) -> (u64, Vec<(StreamPlatform, u64)>) {
        (
            sample.total,
            sample
                .platforms
                .iter()
                .map(|entry| (entry.platform, entry.count))
                .collect(),
        )
    }

    #[test]
    fn both_samplers_feed_one_total_and_never_a_partial_one() {
        let mut aggregator = ViewerAggregator::default();
        // The YouTube + Twitch sampler and the X sampler interleave, as they
        // do when `liveChat.start` and `liveChat.x.start` both run.
        let first = aggregator
            .record(
                "s",
                vec![
                    (StreamPlatform::Youtube, Some(100)),
                    (StreamPlatform::Twitch, Some(50)),
                ],
                at(0),
            )
            .unwrap();
        assert_eq!(first.total, 150);
        let with_x = aggregator
            .record("s", vec![(StreamPlatform::X, Some(30))], at(5))
            .unwrap();
        assert_eq!(
            totals(&with_x),
            (
                180,
                vec![
                    (StreamPlatform::Youtube, 100),
                    (StreamPlatform::Twitch, 50),
                    (StreamPlatform::X, 30)
                ]
            )
        );
        for tick in 1..6 {
            let main = aggregator
                .record(
                    "s",
                    vec![
                        (StreamPlatform::Youtube, Some(100 + tick)),
                        (StreamPlatform::Twitch, Some(50)),
                    ],
                    at(tick as i64 * 30),
                )
                .unwrap();
            assert_eq!(main.total, 100 + tick + 50 + 30, "tick {tick}");
            let x = aggregator
                .record(
                    "s",
                    vec![(StreamPlatform::X, Some(30))],
                    at(tick as i64 * 30 + 5),
                )
                .unwrap();
            assert_eq!(x.total, main.total, "tick {tick}");
        }
    }

    #[test]
    fn a_silent_platform_leaves_the_total_after_the_freshness_window() {
        let mut aggregator = ViewerAggregator::default();
        aggregator.record("s", vec![(StreamPlatform::X, Some(30))], at(0));
        let kept = aggregator
            .record("s", vec![(StreamPlatform::Twitch, Some(50))], at(150))
            .unwrap();
        assert_eq!(kept.total, 80, "a 150-second-old count is still fresh");
        let dropped = aggregator
            .record("s", vec![(StreamPlatform::Twitch, Some(50))], at(151))
            .unwrap();
        assert_eq!(totals(&dropped), (50, vec![(StreamPlatform::Twitch, 50)]));
        // A failed poll keeps the last count rather than zeroing it...
        let failed = aggregator
            .record(
                "s",
                vec![
                    (StreamPlatform::Twitch, None),
                    (StreamPlatform::X, Some(10)),
                ],
                at(170),
            )
            .unwrap();
        assert_eq!(failed.total, 60);
        // ...and a poll that reported nothing emits nothing.
        assert!(
            aggregator
                .record("s", vec![(StreamPlatform::Twitch, None)], at(175))
                .is_none()
        );
    }

    #[test]
    fn a_new_session_starts_from_nothing() {
        let mut aggregator = ViewerAggregator::default();
        aggregator.record("old", vec![(StreamPlatform::Youtube, Some(900))], at(0));
        let sample = aggregator
            .record("new", vec![(StreamPlatform::X, Some(3))], at(1))
            .unwrap();
        assert_eq!(sample.session_id, "new");
        assert_eq!(totals(&sample), (3, vec![(StreamPlatform::X, 3)]));
    }

    #[test]
    fn an_x_poll_without_a_count_is_reported_once_per_reason() {
        use crate::x_live::XViewerCountOutcome;
        let mut diagnostics = XViewerDiagnostics::default();
        let refused = XViewerCountOutcome::Http { status: 401 };
        assert_eq!(
            diagnostics.first_report(&refused).as_deref(),
            Some("X broadcast lookup failed with HTTP 401.")
        );
        assert_eq!(diagnostics.first_report(&refused), None);
        let envelope = XViewerCountOutcome::NoField {
            keys: vec!["state".to_string()],
        };
        assert!(diagnostics.first_report(&envelope).is_some());
        assert_eq!(
            diagnostics.first_report(&XViewerCountOutcome::Count(9)),
            None
        );
    }

    #[test]
    fn merges_only_platforms_that_reported() {
        let sample = merge_viewer_sample(
            "session-1",
            vec![
                (StreamPlatform::Youtube, Some(1200)),
                (StreamPlatform::Twitch, None),
            ],
            "2026-07-07T00:00:00Z".to_string(),
        )
        .expect("sample");
        assert_eq!(sample.total, 1200);
        assert_eq!(sample.platforms.len(), 1);

        // No platform reported → no sample at all (never a fake zero).
        assert!(
            merge_viewer_sample(
                "session-1",
                vec![(StreamPlatform::Youtube, None)],
                "t".to_string()
            )
            .is_none()
        );
    }

    fn quota_test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[derive(Clone)]
    struct CountingVideos {
        hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        status: axum::http::StatusCode,
        body: Value,
    }

    async fn counting_videos(
        axum::extract::State(mock): axum::extract::State<CountingVideos>,
    ) -> (axum::http::StatusCode, axum::Json<Value>) {
        mock.hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (mock.status, axum::Json(mock.body.clone()))
    }

    async fn spawn_videos(
        status: axum::http::StatusCode,
        body: Value,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let app = axum::Router::new()
            .route("/youtube/v3/videos", axum::routing::get(counting_videos))
            .with_state(CountingVideos {
                hits: hits.clone(),
                status,
                body,
            });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), hits)
    }

    #[tokio::test]
    async fn renewed_youtube_viewer_request_counts_both_http_attempts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new().route(
            "/youtube/v3/videos",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                if headers["authorization"] == "Bearer fresh" {
                    (
                        axum::http::StatusCode::OK,
                        axum::Json(
                            json!({"items":[{"liveStreamingDetails":{"concurrentViewers":"9"}}]}),
                        ),
                    )
                } else {
                    (
                        axum::http::StatusCode::UNAUTHORIZED,
                        axum::Json(json!({"error":{}})),
                    )
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let state = quota_test_state();
        let config = YouTubeViewerConfig {
            access_token: "expired".into(),
            broadcast_id: "broadcast".into(),
            api_base_url: Some(base),
            token_source: crate::session_token::SessionTokenSource::scripted(vec![Ok("fresh")]),
        };
        let mut token = crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        );
        let result = poll_youtube_count(
            &state,
            &reqwest::Client::new(),
            &config,
            &mut token,
            &mut YouTubeViewerBackoff::default(),
        )
        .await;
        assert_eq!(result, Some(9));
        assert_eq!(crate::youtube_quota::usage_snapshot(&state).total_calls, 2);
        server.abort();
    }

    #[tokio::test]
    async fn youtube_polls_stop_while_the_quota_breaker_is_set_and_a_quota_403_sets_it() {
        let state = quota_test_state();
        let (base, hits) = spawn_videos(
            axum::http::StatusCode::FORBIDDEN,
            json!({ "error": { "errors": [{ "reason": "quotaExceeded", "domain": "youtube.quota" }] } }),
        )
        .await;
        let config = YouTubeViewerConfig {
            access_token: "token".to_string(),
            broadcast_id: "bcast".to_string(),
            api_base_url: Some(base),
            token_source: Default::default(),
        };
        let client = reqwest::Client::new();
        let mut token = crate::session_token::SessionToken::new("token", Default::default());
        let mut backoff = YouTubeViewerBackoff::default();

        // The quota 403 is a missing count that pauses every YouTube caller.
        assert_eq!(
            poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await,
            None
        );
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(crate::youtube_quota::paused_until(&state).is_some());
        assert_eq!(
            backoff.forbidden_streak, 0,
            "quota is not a permissions refusal"
        );

        // While paused: zero requests.
        for _ in 0..3 {
            assert_eq!(
                poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await,
                None
            );
        }
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(crate::youtube_quota::usage_snapshot(&state).total_calls, 1);
    }

    #[tokio::test]
    async fn a_permissions_403_backs_youtube_off_without_touching_the_breaker() {
        let state = quota_test_state();
        let (base, hits) = spawn_videos(
            axum::http::StatusCode::FORBIDDEN,
            json!({ "error": { "errors": [{ "reason": "forbidden", "domain": "global" }] } }),
        )
        .await;
        let config = YouTubeViewerConfig {
            access_token: "token".to_string(),
            broadcast_id: "bcast".to_string(),
            api_base_url: Some(base),
            token_source: Default::default(),
        };
        let client = reqwest::Client::new();
        let mut token = crate::session_token::SessionToken::new("token", Default::default());
        let mut backoff = YouTubeViewerBackoff::default();
        assert_eq!(
            poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await,
            None
        );
        assert_eq!(crate::youtube_quota::paused_until(&state), None);
        assert_eq!(backoff.skip_polls, 2);
        // Two polls sit out, then it tries again and backs off longer.
        poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await;
        poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        poll_youtube_count(&state, &client, &config, &mut token, &mut backoff).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(backoff.skip_polls, 4);
        assert_eq!(youtube_polls_to_skip(0), 0);
        assert_eq!(youtube_polls_to_skip(3), 8);
        assert_eq!(youtube_polls_to_skip(9), YOUTUBE_MAX_SKIPPED_POLLS);
    }
}
