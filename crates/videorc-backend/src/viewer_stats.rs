//! Live concurrent-viewer sampling (plan rider V1, vault "2026-07-07 -
//! Videorc OBS Import Plan"). While a stream session runs, poll each connected
//! platform's public count on a jittered ~30s cadence, emit the latest as a
//! `stream.viewers` event, and PERSIST every sample with the session (the
//! point is owning the data — a later cut moves it onto the video / a
//! post-stream graph). Terminology honesty: these are concurrent VIEWERS, not
//! subscribers — UI copy says "watching".
//!
//! Failure discipline: sampling can never degrade the stream or chat. A
//! failed poll is a missing datum (skip the tick), with its own backoff.
//! YouTube polls cost quota (plan 094): they run every 60 s, skip entirely
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

/// Plan 094: 60 s, not 30. Each YouTube poll costs one unit of a quota every
/// Videorc user shares.
pub const VIEWER_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);
pub const VIEWER_SAMPLE_LOG_CODE: &str = "stream-viewers";
/// A platform's count leaves the total once it is this old: two missed polls
/// keep the last count, a third drops it rather than freezing it. Matches the
/// renderer's stale-chip threshold (`lib/viewer-count-view.ts`).
pub const VIEWER_FRESHNESS: Duration = Duration::from_secs(150);
/// `sessions.viewers.list` returns at most this many samples, the latest:
/// twenty-four hours at the 60-second cadence.
pub const VIEWER_HISTORY_LIMIT: usize = 1_440;
/// After a YouTube 403 that is not quota, skip this many polls, doubling per
/// repeat up to [`YOUTUBE_MAX_SKIPPED_POLLS`] (10 minutes at 60 s).
pub const YOUTUBE_MAX_SKIPPED_POLLS: u32 = 10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeViewerConfig {
    pub access_token: String,
    pub broadcast_id: String,
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
            Self::Refused | Self::Forbidden => None,
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
    if backoff.skip_polls > 0 {
        backoff.skip_polls -= 1;
        return None;
    }
    crate::youtube_quota::record_call(state, crate::youtube_quota::YouTubeEndpoint::VideosList);
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
        CountFetch::Count(None) | CountFetch::Refused => None,
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
    /// `VIEWER_FRESHNESS`), `None` when no sampler has reported. Orcle's
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

async fn fetch_youtube_count(
    state: &AppState,
    client: &reqwest::Client,
    config: &YouTubeViewerConfig,
    access_token: &str,
) -> CountFetch {
    let base = config.api_base_url.clone().unwrap_or_else(|| {
        format!(
            "{}/youtube/v3",
            crate::youtube_quota::youtube_api_base_url(None)
        )
    });
    let url = format!(
        "{}/videos?part=liveStreamingDetails&id={}",
        base.trim_end_matches('/'),
        config.broadcast_id
    );
    let Ok(response) = client.get(url).bearer_auth(access_token).send().await else {
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
    CountFetch::Count(body.as_ref().and_then(parse_twitch_viewer_count))
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
    let client = reqwest::Client::new();
    // Deterministic jitter from the session id keeps concurrent sessions from
    // aligning their polls without needing a RNG.
    let jitter_ms = (session_id.bytes().map(u64::from).sum::<u64>() % 5000) + 500;
    sleep(Duration::from_millis(jitter_ms)).await;

    let mut youtube_token = youtube.as_ref().map(|config| {
        crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        )
    });
    let mut youtube_backoff = YouTubeViewerBackoff::default();
    let mut x_diagnostics = XViewerDiagnostics::default();
    let mut twitch_token = twitch.as_ref().map(|config| {
        crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        )
    });
    let mut kick_token = kick.as_ref().map(|config| {
        crate::session_token::SessionToken::new(
            config.access_token.clone(),
            config.token_source.clone(),
        )
    });
    loop {
        let mut counts: Vec<(StreamPlatform, Option<u64>)> = Vec::new();
        let client_ref = &client;
        if let (Some(config), Some(token)) = (youtube.as_ref(), youtube_token.as_mut()) {
            let count =
                poll_youtube_count(&state, &client, config, token, &mut youtube_backoff).await;
            counts.push((StreamPlatform::Youtube, count));
        }
        if let (Some(config), Some(token)) = (twitch.as_ref(), twitch_token.as_mut()) {
            let count = poll_with_renewal(&state, &client, token, |access_token| async move {
                fetch_twitch_count(client_ref, config, &access_token).await
            })
            .await;
            counts.push((StreamPlatform::Twitch, count));
        }
        if let (Some(config), Some(token)) = (kick.as_ref(), kick_token.as_mut()) {
            let count = poll_with_renewal(&state, &client, token, |access_token| async move {
                fetch_kick_count(client_ref, config, &access_token).await
            })
            .await;
            counts.push((StreamPlatform::Kick, count));
        }
        if let Some(config) = x.as_ref() {
            let count =
                fetch_x_count(&state, &session_id, &client, config, &mut x_diagnostics).await;
            counts.push((StreamPlatform::X, count));
        }

        let sample = state
            .viewer_aggregator
            .lock()
            .ok()
            .and_then(|mut aggregator| aggregator.record(&session_id, counts, chrono::Utc::now()));
        if let Some(sample) = sample {
            // Persist FIRST (owning the data is the point), then emit.
            if let Ok(json) = serde_json::to_string(&sample) {
                let _ = state.database.add_session_log(
                    &session_id,
                    HealthLevel::Info,
                    VIEWER_SAMPLE_LOG_CODE,
                    &json,
                    None,
                );
            }
            state.emit_event("stream.viewers", sample);
        }

        sleep(VIEWER_SAMPLE_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            .route("/videos", axum::routing::get(counting_videos))
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
