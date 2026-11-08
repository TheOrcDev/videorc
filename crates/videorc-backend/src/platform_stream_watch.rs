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

/// Plan 223 A4: the stream's own health, read from the same
/// `liveStreams.list part=status` body (0 extra quota): `healthStatus.status`
/// and its `configurationIssues[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YouTubeHealthAnswer {
    Fine,
    /// An `error` issue, or `healthStatus.status == bad`: reported at once.
    Problem {
        kind: crate::watchdog::PlatformHealthKind,
        critical: bool,
        description: Option<String>,
    },
    /// `warning` issues only: reported after two polls in a row.
    Warning {
        description: Option<String>,
    },
    /// No health in the body: changes nothing.
    Unknown,
}

pub fn youtube_health_answer(body: &Value) -> YouTubeHealthAnswer {
    use crate::watchdog::PlatformHealthKind;
    let Some(health) = body
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("status"))
        .and_then(|status| status.get("healthStatus"))
    else {
        return YouTubeHealthAnswer::Unknown;
    };
    let status = health.get("status").and_then(Value::as_str);
    let issues: Vec<&Value> = health
        .get("configurationIssues")
        .and_then(Value::as_array)
        .map(|issues| issues.iter().collect())
        .unwrap_or_default();
    let description = |issue: &Value| {
        issue
            .get("description")
            .or_else(|| issue.get("reason"))
            .and_then(Value::as_str)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    };
    fn severity(issue: &Value) -> Option<&str> {
        issue.get("severity").and_then(Value::as_str)
    }
    if let Some(issue) = issues.iter().find(|issue| severity(issue) == Some("error")) {
        let kind = match issue.get("type").and_then(Value::as_str) {
            Some("noAudioStream") => PlatformHealthKind::NoAudio,
            Some("noVideoStream") => PlatformHealthKind::NoVideo,
            _ => PlatformHealthKind::Problem,
        };
        return YouTubeHealthAnswer::Problem {
            critical: kind != PlatformHealthKind::Problem,
            kind,
            description: description(issue),
        };
    }
    if status == Some("bad") {
        return YouTubeHealthAnswer::Problem {
            kind: PlatformHealthKind::Problem,
            critical: false,
            description: issues.first().and_then(|issue| description(issue)),
        };
    }
    if let Some(issue) = issues
        .iter()
        .find(|issue| severity(issue) == Some("warning"))
    {
        return YouTubeHealthAnswer::Warning {
            description: description(issue),
        };
    }
    match status {
        Some("good" | "ok" | "noData" | "bad") => YouTubeHealthAnswer::Fine,
        _ => YouTubeHealthAnswer::Unknown,
    }
}

/// Debounces the health answers for the watchdog: a problem at once, a
/// warning after [`NOT_RECEIVING_ANSWERS_BEFORE_WARNING`] polls in a row.
/// `Some(None)` withdraws the signal, `None` changes nothing.
#[derive(Debug, Default)]
pub struct YouTubeHealthDebounce {
    warning_streak: u32,
}

/// YouTube Studio's live dashboard for a broadcast.
pub fn youtube_dashboard_url(broadcast_id: &str) -> String {
    format!("https://studio.youtube.com/video/{broadcast_id}/livestreaming")
}

impl YouTubeHealthDebounce {
    pub fn observe(
        &mut self,
        answer: YouTubeHealthAnswer,
        target_id: &str,
        broadcast_id: &str,
    ) -> Option<Option<crate::watchdog::PlatformHealthSignal>> {
        use crate::watchdog::{PlatformHealthKind, PlatformHealthSignal};
        let signal = |kind, critical, description| PlatformHealthSignal {
            target_id: target_id.to_string(),
            label: "YouTube".to_string(),
            platform: "youtube".to_string(),
            kind,
            critical,
            description,
            dashboard_url: Some(youtube_dashboard_url(broadcast_id)),
        };
        match answer {
            YouTubeHealthAnswer::Unknown => None,
            YouTubeHealthAnswer::Fine => {
                self.warning_streak = 0;
                Some(None)
            }
            YouTubeHealthAnswer::Problem {
                kind,
                critical,
                description,
            } => {
                self.warning_streak = 0;
                Some(Some(signal(kind, critical, description)))
            }
            YouTubeHealthAnswer::Warning { description } => {
                self.warning_streak = self.warning_streak.saturating_add(1);
                if self.warning_streak >= NOT_RECEIVING_ANSWERS_BEFORE_WARNING {
                    Some(Some(signal(
                        PlatformHealthKind::Problem,
                        false,
                        description,
                    )))
                } else {
                    None
                }
            }
        }
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
            "YouTube revoked this broadcast. Stop and go live again to start a new one".to_string(),
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
            token
                .renew_after_refusal(state, client)
                .await
                .ok()?
                .to_string()
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
    let mut health = YouTubeHealthDebounce::default();
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
                        apply(
                            &state,
                            &session_id,
                            config.target_id.as_deref(),
                            observation,
                        )
                        .await;
                    }
                }
            }
            if let Some(stream_id) = stream_id.as_deref() {
                let url = format!("{root}/liveStreams?part=status&id={stream_id}");
                let (answer, health_answer) = match youtube_read(
                    &state,
                    &client,
                    &mut token,
                    crate::youtube_quota::YouTubeEndpoint::LiveStreamsList,
                    &url,
                )
                .await
                {
                    Some(body) => (youtube_stream_answer(&body), youtube_health_answer(&body)),
                    None => (PlatformAnswer::Unknown, YouTubeHealthAnswer::Unknown),
                };
                // Plan 223 A4: the same body, read for the watchdog.
                if let Some(signal) = health.observe(
                    health_answer,
                    config.target_id.as_deref().unwrap_or("youtube"),
                    &config.broadcast_id,
                ) {
                    crate::watchdog::observe_platform_health(
                        &state,
                        &session_id,
                        config.target_id.as_deref().unwrap_or("youtube"),
                        signal,
                    );
                }
                if let Some(observation) = liveness.observe(answer) {
                    apply(
                        &state,
                        &session_id,
                        config.target_id.as_deref(),
                        observation,
                    )
                    .await;
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
        assert_eq!(
            youtube_broadcast_answer(&json!({})),
            (None, PlatformAnswer::Unknown)
        );
    }

    #[test]
    fn not_receiving_needs_a_prior_receiving_and_two_answers_in_a_row() {
        let not_receiving = || PlatformAnswer::NotReceiving("no data".to_string());
        let mut liveness = PlatformLiveness::default();
        assert_eq!(liveness.observe(not_receiving()), None, "not live yet");
        assert_eq!(
            liveness.observe(not_receiving()),
            None,
            "still not live yet"
        );
        assert_eq!(
            liveness.observe(PlatformAnswer::Receiving),
            Some(PlatformStreamObservation::Receiving)
        );
        assert_eq!(
            liveness.observe(not_receiving()),
            None,
            "one answer can be a cache"
        );
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
        assert_eq!(
            liveness.observe(not_receiving()),
            None,
            "a new streak starts over"
        );
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
    fn youtube_health_reads_issues_from_the_same_status_body() {
        use crate::watchdog::PlatformHealthKind;
        let bad_no_audio = json!({"items":[{"status":{
            "streamStatus":"active",
            "healthStatus":{"status":"bad","configurationIssues":[
                {"type":"noAudioStream","severity":"error","reason":"No audio",
                 "description":"The stream has no audio."}]}}}]});
        assert_eq!(
            youtube_health_answer(&bad_no_audio),
            YouTubeHealthAnswer::Problem {
                kind: PlatformHealthKind::NoAudio,
                critical: true,
                description: Some("The stream has no audio.".to_string())
            }
        );
        assert_eq!(
            youtube_stream_answer(&bad_no_audio),
            PlatformAnswer::Receiving,
            "the liveness answer is unchanged by the health read"
        );
        let bad_only = json!({"items":[{"status":{"streamStatus":"active",
            "healthStatus":{"status":"bad"}}}]});
        assert_eq!(
            youtube_health_answer(&bad_only),
            YouTubeHealthAnswer::Problem {
                kind: PlatformHealthKind::Problem,
                critical: false,
                description: None
            }
        );
        let warning = json!({"items":[{"status":{"streamStatus":"active",
            "healthStatus":{"status":"ok","configurationIssues":[
                {"type":"bitrateLow","severity":"warning","reason":"Video output low"}]}}}]});
        assert_eq!(
            youtube_health_answer(&warning),
            YouTubeHealthAnswer::Warning {
                description: Some("Video output low".to_string())
            }
        );
        let good = json!({"items":[{"status":{"streamStatus":"active",
            "healthStatus":{"status":"good"}}}]});
        assert_eq!(youtube_health_answer(&good), YouTubeHealthAnswer::Fine);
        assert_eq!(
            youtube_health_answer(&json!({"items":[]})),
            YouTubeHealthAnswer::Unknown
        );

        // One warning poll says nothing; two in a row say it.
        let mut debounce = YouTubeHealthDebounce::default();
        let warning_answer = || YouTubeHealthAnswer::Warning {
            description: Some("Video output low".to_string()),
        };
        assert_eq!(debounce.observe(warning_answer(), "youtube", "b1"), None);
        let second = debounce
            .observe(warning_answer(), "youtube", "b1")
            .unwrap()
            .unwrap();
        assert_eq!(second.kind, PlatformHealthKind::Problem);
        assert!(!second.critical);
        assert_eq!(
            second.dashboard_url.as_deref(),
            Some("https://studio.youtube.com/video/b1/livestreaming")
        );
        assert_eq!(
            debounce.observe(YouTubeHealthAnswer::Unknown, "youtube", "b1"),
            None
        );
        assert_eq!(
            debounce.observe(YouTubeHealthAnswer::Fine, "youtube", "b1"),
            Some(None),
            "good withdraws it"
        );
        assert_eq!(
            debounce.observe(warning_answer(), "youtube", "b1"),
            None,
            "the streak restarts"
        );
        // A problem is reported at once, critical when viewers get no audio.
        let problem = debounce
            .observe(youtube_health_answer(&bad_no_audio), "youtube", "b1")
            .unwrap()
            .unwrap();
        assert!(problem.critical);
        assert_eq!(problem.kind, PlatformHealthKind::NoAudio);
    }

    #[tokio::test]
    async fn the_breaker_keeps_the_watch_from_reading_at_all() {
        let state = crate::agent_mcp::test_support::test_state();
        assert!(youtube_reads_allowed(&state));
        crate::youtube_quota::record_quota_exhausted(&state, "stream status");
        assert!(
            !youtube_reads_allowed(&state),
            "the plan 094 breaker gates the health read with the watch"
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
