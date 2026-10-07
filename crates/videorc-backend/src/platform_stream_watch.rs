//! Plan 161 (S4): the platforms' own word on whether they receive the stream.
//!
//! FFmpeg reports a leg it cannot reach (`recording::StreamLegMonitor`). It
//! cannot report a leg the platform accepts and then ignores, or a broadcast
//! the platform ended. While live, this watch asks YouTube about the bound
//! ingest stream (`liveStreams.list part=status`, one quota unit a minute)
//! and, every few minutes, about the broadcast's lifecycle; Twitch's answer
//! comes from the viewer poll that already runs (`viewer_stats`).
//!
//! A platform can only demote a destination FFmpeg believes is live, and only
//! clears what it raised (`recording::observe_platform_stream`).

use std::time::Duration;

use serde_json::Value;
use tokio::time::sleep;

use crate::recording::PlatformStreamObservation;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

/// How often the YouTube ingest status is read while live.
pub const YOUTUBE_INGEST_POLL_INTERVAL: Duration = Duration::from_secs(60);
/// The broadcast (lifecycle and bound stream id) is read on the first poll and
/// then every this many polls.
pub const YOUTUBE_BROADCAST_POLL_EVERY: u32 = 5;
/// Consecutive "not receiving" answers before a destination is flagged. One
/// answer can be a platform's cache; two in a row at a minute apart is not.
pub const NOT_RECEIVING_ANSWERS_BEFORE_WARNING: u32 = 2;
/// Go Live waits for YouTube's ingest to turn active before it starts the
/// broadcast; the first watch poll waits at least this long after start.
const YOUTUBE_FIRST_POLL_DELAY: Duration = Duration::from_secs(45);

/// One poll's verdict, before debouncing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformAnswer {
    Receiving,
    NotReceiving(String),
    /// The platform ended the broadcast; reconnecting cannot bring it back.
    Ended(String),
    /// No answer (network, quota, an unexpected body): changes nothing.
    Unknown,
}

/// Debounces one destination's answers into observations.
///
/// "Not receiving" is reported only after the platform has said "receiving"
/// at least once this session (Twitch lists a new stream a minute or two
/// late) and only after [`NOT_RECEIVING_ANSWERS_BEFORE_WARNING`] answers in a
/// row. Once reported it is repeated on every later answer, so a leg FFmpeg
/// reconnected that the platform still ignores is flagged again.
#[derive(Debug, Default)]
pub struct PlatformLiveness {
    seen_receiving: bool,
    not_receiving_streak: u32,
}

impl PlatformLiveness {
    pub fn observe(&mut self, answer: PlatformAnswer) -> Option<PlatformStreamObservation> {
        match answer {
            PlatformAnswer::Receiving => {
                self.seen_receiving = true;
                self.not_receiving_streak = 0;
                Some(PlatformStreamObservation::Receiving)
            }
            PlatformAnswer::NotReceiving(detail) => {
                self.not_receiving_streak = self.not_receiving_streak.saturating_add(1);
                (self.seen_receiving
                    && self.not_receiving_streak >= NOT_RECEIVING_ANSWERS_BEFORE_WARNING)
                    .then_some(PlatformStreamObservation::NotReceiving { detail })
            }
            PlatformAnswer::Ended(detail) => Some(PlatformStreamObservation::Ended { detail }),
            PlatformAnswer::Unknown => None,
        }
    }
}

/// `liveStreams.list part=status` for the bound stream. `streamStatus` says
/// whether YouTube receives data; `healthStatus.status` of `noData` says the
/// same from the health side.
pub fn youtube_stream_answer(body: &Value) -> PlatformAnswer {
    let Some(item) = body
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return PlatformAnswer::Unknown;
    };
    let status = item.get("status");
    let stream_status = status
        .and_then(|status| status.get("streamStatus"))
        .and_then(Value::as_str);
    let health = status
        .and_then(|status| status.get("healthStatus"))
        .and_then(|health| health.get("status"))
        .and_then(Value::as_str);
    match (stream_status, health) {
        (Some("active"), Some("noData")) => {
            PlatformAnswer::NotReceiving("YouTube reports no data".to_string())
        }
        (_, Some("revoked")) => {
            PlatformAnswer::NotReceiving("YouTube revoked this stream".to_string())
        }
        (Some("active"), _) => PlatformAnswer::Receiving,
        (Some("error"), _) => {
            PlatformAnswer::NotReceiving("YouTube reports a stream error".to_string())
        }
        (Some(other @ ("inactive" | "ready" | "created")), _) => {
            PlatformAnswer::NotReceiving(format!("YouTube's stream status is {other}"))
        }
        _ => PlatformAnswer::Unknown,
    }
}

/// `liveBroadcasts.list part=status,contentDetails`: the bound stream id and
/// whether YouTube already ended the broadcast (`complete`, `revoked`).
pub fn youtube_broadcast_answer(body: &Value) -> (Option<String>, PlatformAnswer) {
    let Some(item) = body
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return (None, PlatformAnswer::Unknown);
    };
    let bound_stream_id = item
        .get("contentDetails")
        .and_then(|details| details.get("boundStreamId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let lifecycle = item
        .get("status")
        .and_then(|status| status.get("lifeCycleStatus"))
        .and_then(Value::as_str);
    let answer = match lifecycle {
        Some("complete") => PlatformAnswer::Ended(
            "YouTube ended this broadcast. Stop and go live again to start a new one".to_string(),
        ),
        Some("revoked") => PlatformAnswer::Ended(
            "YouTube revoked this broadcast. Stop and go live again to start a new one"
                .to_string(),
        ),
        _ => PlatformAnswer::Unknown,
    };
    (bound_stream_id, answer)
}

/// What the YouTube watch needs; built from the session's chat config.
#[derive(Debug, Clone)]
pub struct YouTubeIngestWatchConfig {
    pub access_token: String,
    pub broadcast_id: String,
    pub target_id: Option<String>,
    pub api_base_url: Option<String>,
    pub token_source: crate::session_token::SessionTokenSource,
}

fn youtube_api_root(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/youtube/v3") {
        base.to_string()
    } else {
        format!("{base}/youtube/v3")
    }
}

/// One quota-accounted YouTube read: renews a refused token once, and a quota
/// 403 sets the shared breaker. Any failure is "no answer".
async fn youtube_read(
    state: &AppState,
    client: &reqwest::Client,
    token: &mut crate::session_token::SessionToken,
    endpoint: crate::youtube_quota::YouTubeEndpoint,
    url: &str,
) -> Option<Value> {
    for attempt in 0..2 {
        let access_token = if attempt == 0 {
            token.ensure_fresh(state, client).await.to_string()
        } else {
            token.renew_after_refusal(state, client).await.ok()?.to_string()
        };
        let response = crate::youtube_quota::send_attempt(
            state,
            endpoint,
            crate::youtube_quota::BudgetCall::Viewers,
            client,
            client.get(url).bearer_auth(access_token),
        )
        .await
        .ok()?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            continue;
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            let body = response.text().await.unwrap_or_default();
            let (reason, domain) = crate::youtube_quota::error_reason_and_domain_from_text(&body);
            if matches!(
                crate::youtube_quota::classify_youtube_api_error(
                    403,
                    reason.as_deref(),
                    domain.as_deref()
                ),
                crate::youtube_quota::YouTubeApiErrorClass::QuotaExhausted
            ) {
                crate::youtube_quota::record_quota_exhausted(state, "stream status");
            }
            return None;
        }
        if !status.is_success() {
            return None;
        }
        return response.json().await.ok();
    }
    None
}

fn youtube_reads_allowed(state: &AppState) -> bool {
    crate::youtube_quota::paused_until(state).is_none()
        && crate::youtube_quota::budget_refuses(state, crate::youtube_quota::BudgetCall::Viewers)
            .is_none()
}

/// Session-scoped YouTube ingest watch; aborted with the live-chat tasks on
/// stop, like the viewer sampler.
pub async fn run_youtube_ingest_watch(
    state: AppState,
    session_id: String,
    config: YouTubeIngestWatchConfig,
) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    sleep(YOUTUBE_FIRST_POLL_DELAY).await;
    let root = youtube_api_root(&crate::youtube_quota::youtube_api_base_url(
        config.api_base_url.as_deref(),
    ));
    let mut token =
        crate::session_token::SessionToken::new(config.access_token.clone(), config.token_source);
    let mut liveness = PlatformLiveness::default();
    let mut stream_id: Option<String> = None;
    let mut poll: u32 = 0;
    loop {
        if youtube_reads_allowed(&state) {
            if stream_id.is_none() || poll.is_multiple_of(YOUTUBE_BROADCAST_POLL_EVERY) {
                let url = format!(
                    "{root}/liveBroadcasts?part=status,contentDetails&id={}",
                    config.broadcast_id
                );
                if let Some(body) = youtube_read(
                    &state,
                    &client,
                    &mut token,
                    crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsList,
                    &url,
                )
                .await
                {
                    let (bound, answer) = youtube_broadcast_answer(&body);
                    if bound.is_some() {
                        stream_id = bound;
                    }
                    if let Some(observation) = liveness.observe(answer) {
                        apply(&state, &session_id, config.target_id.as_deref(), observation)
                            .await;
                    }
                }
            }
            if let Some(stream_id) = stream_id.as_deref() {
                let url = format!("{root}/liveStreams?part=status&id={stream_id}");
                let answer = match youtube_read(
                    &state,
                    &client,
                    &mut token,
                    crate::youtube_quota::YouTubeEndpoint::LiveStreamsList,
                    &url,
                )
                .await
                {
                    Some(body) => youtube_stream_answer(&body),
                    None => PlatformAnswer::Unknown,
                };
                if let Some(observation) = liveness.observe(answer) {
                    apply(&state, &session_id, config.target_id.as_deref(), observation).await;
                }
            }
            poll = poll.wrapping_add(1);
        }
        sleep(YOUTUBE_INGEST_POLL_INTERVAL).await;
    }
}

async fn apply(
    state: &AppState,
    session_id: &str,
    target_id: Option<&str>,
    observation: PlatformStreamObservation,
) {
    crate::recording::observe_platform_stream(
        state,
        session_id,
        StreamPlatform::Youtube,
        target_id,
        observation,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn youtube_stream_status_reads_as_an_answer() {
        assert_eq!(
            youtube_stream_answer(&json!({"items":[{"status":{
                "streamStatus":"active","healthStatus":{"status":"good"}}}]})),
            PlatformAnswer::Receiving
        );
        assert_eq!(
            youtube_stream_answer(&json!({"items":[{"status":{
                "streamStatus":"active","healthStatus":{"status":"bad"}}}]})),
            PlatformAnswer::Receiving,
            "a bad picture is still a received one"
        );
        assert_eq!(
            youtube_stream_answer(&json!({"items":[{"status":{
                "streamStatus":"active","healthStatus":{"status":"noData"}}}]})),
            PlatformAnswer::NotReceiving("YouTube reports no data".to_string())
        );
        assert_eq!(
            youtube_stream_answer(&json!({"items":[{"status":{"streamStatus":"inactive"}}]})),
            PlatformAnswer::NotReceiving("YouTube's stream status is inactive".to_string())
        );
        assert_eq!(
            youtube_stream_answer(&json!({"items":[]})),
            PlatformAnswer::Unknown
        );
        assert_eq!(
            youtube_stream_answer(&json!({"items":[{"status":{"streamStatus":"weird"}}]})),
            PlatformAnswer::Unknown
        );
    }

    #[test]
    fn youtube_broadcast_gives_its_stream_and_says_when_it_ended() {
        let (bound, answer) = youtube_broadcast_answer(&json!({"items":[{
            "status":{"lifeCycleStatus":"live"},
            "contentDetails":{"boundStreamId":"stream-1"}}]}));
        assert_eq!(bound.as_deref(), Some("stream-1"));
        assert_eq!(answer, PlatformAnswer::Unknown);

        let (_, answer) = youtube_broadcast_answer(&json!({"items":[{
            "status":{"lifeCycleStatus":"complete"},
            "contentDetails":{"boundStreamId":"stream-1"}}]}));
        assert!(matches!(answer, PlatformAnswer::Ended(_)));
        assert_eq!(youtube_broadcast_answer(&json!({})), (None, PlatformAnswer::Unknown));
    }

    #[test]
    fn not_receiving_needs_a_prior_receiving_and_two_answers_in_a_row() {
        let not_receiving = || PlatformAnswer::NotReceiving("no data".to_string());
        let mut liveness = PlatformLiveness::default();
        assert_eq!(liveness.observe(not_receiving()), None, "not live yet");
        assert_eq!(liveness.observe(not_receiving()), None, "still not live yet");
        assert_eq!(
            liveness.observe(PlatformAnswer::Receiving),
            Some(PlatformStreamObservation::Receiving)
        );
        assert_eq!(liveness.observe(not_receiving()), None, "one answer can be a cache");
        assert_eq!(liveness.observe(PlatformAnswer::Unknown), None);
        assert_eq!(
            liveness.observe(not_receiving()),
            Some(PlatformStreamObservation::NotReceiving {
                detail: "no data".to_string()
            }),
            "an unknown answer neither breaks nor extends the streak"
        );
        assert_eq!(
            liveness.observe(not_receiving()),
            Some(PlatformStreamObservation::NotReceiving {
                detail: "no data".to_string()
            }),
            "repeated while it lasts"
        );
        assert_eq!(
            liveness.observe(PlatformAnswer::Receiving),
            Some(PlatformStreamObservation::Receiving)
        );
        assert_eq!(liveness.observe(not_receiving()), None, "a new streak starts over");
    }

    #[test]
    fn an_ended_broadcast_is_reported_at_once() {
        let mut liveness = PlatformLiveness::default();
        assert_eq!(
            liveness.observe(PlatformAnswer::Ended("ended".to_string())),
            Some(PlatformStreamObservation::Ended {
                detail: "ended".to_string()
            })
        );
    }

    #[test]
    fn the_youtube_root_accepts_an_origin_or_a_versioned_root() {
        assert_eq!(
            youtube_api_root("https://www.googleapis.com/"),
            "https://www.googleapis.com/youtube/v3"
        );
        assert_eq!(
            youtube_api_root("http://127.0.0.1:9/youtube/v3"),
            "http://127.0.0.1:9/youtube/v3"
        );
    }
}
