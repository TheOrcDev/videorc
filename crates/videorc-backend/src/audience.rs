//! Follower and subscriber counts for the Stream Manager (plan 053, S3).
//!
//! While a stream session runs, one task per live platform reads the
//! channel's audience total every ~2 minutes: Twitch followers, X followers,
//! and YouTube subscribers (only where YouTube OAuth is enabled). The first
//! reading is the session baseline, so the window can say "+12 this stream".
//! Each reading updates [`AudienceHub`], which emits `stream.audience` with
//! every platform, the same one-total discipline as `viewer_stats` (B1).
//!
//! Failure discipline, as for viewers: a failed read is a missing datum.
//! Errors back off to 10 minutes and never touch chat or the stream. A count
//! is never invented: a platform that cannot report says why instead
//! (`capability`), and the UI hides the number.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;

use crate::protocol::HealthLevel;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

pub const AUDIENCE_POLL_INTERVAL: Duration = Duration::from_secs(120);
/// First retry after a failed read; doubles up to [`AUDIENCE_MAX_BACKOFF`].
pub const AUDIENCE_FIRST_BACKOFF: Duration = Duration::from_secs(240);
pub const AUDIENCE_MAX_BACKOFF: Duration = Duration::from_secs(600);
pub const AUDIENCE_LOG_CODE: &str = "stream-audience";

const TWITCH_API_BASE: &str = "https://api.twitch.tv/helix";
const YOUTUBE_API_BASE: &str = "https://www.googleapis.com/youtube/v3";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudienceMetric {
    Followers,
    Subscribers,
}

impl AudienceMetric {
    pub fn for_platform(platform: StreamPlatform) -> Self {
        if platform == StreamPlatform::Youtube {
            Self::Subscribers
        } else {
            Self::Followers
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudienceCapability {
    /// Registered, not read yet.
    Pending,
    Available,
    /// The channel hides its count (YouTube `hiddenSubscriberCount`).
    Hidden,
    /// The platform refused the token even after a refresh.
    NeedsReconnect,
    /// This build or account cannot read it; `message` says why.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAudience {
    pub platform: StreamPlatform,
    pub metric: AudienceMetric,
    pub capability: AudienceCapability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// The first reading this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<u64>,
    /// `total - baseline`; negative when people unfollowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<i64>,
    /// When `total` was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudienceSnapshot {
    pub session_id: String,
    pub platforms: Vec<PlatformAudience>,
    pub updated_at: String,
}

/// One read's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudienceReading {
    Count(u64),
    Hidden,
    NeedsReconnect(String),
    Unavailable(String),
    /// Transient: keep the last total and retry with backoff.
    Failed(String),
}

impl AudienceReading {
    /// How long until the next read of this platform.
    pub fn next_delay(&self, previous_backoff: Option<Duration>) -> Duration {
        match self {
            Self::Count(_) => AUDIENCE_POLL_INTERVAL,
            Self::Failed(_) => previous_backoff
                .map(|backoff| (backoff * 2).min(AUDIENCE_MAX_BACKOFF))
                .unwrap_or(AUDIENCE_FIRST_BACKOFF),
            // Retried slowly in case the user reconnects or unhides mid-stream.
            Self::Hidden | Self::NeedsReconnect(_) | Self::Unavailable(_) => AUDIENCE_MAX_BACKOFF,
        }
    }
}

/// The session's audience per platform.
#[derive(Debug, Default)]
pub struct AudienceHub {
    snapshot: Option<AudienceSnapshot>,
}

impl AudienceHub {
    /// Registers `platforms` for `session_id` as pending, discarding another
    /// session's state. Returns the snapshot to emit.
    pub fn begin(
        &mut self,
        session_id: &str,
        platforms: &[StreamPlatform],
        now: &str,
    ) -> AudienceSnapshot {
        let snapshot = match self.snapshot.as_mut() {
            Some(snapshot) if snapshot.session_id == session_id => snapshot,
            _ => self.snapshot.insert(AudienceSnapshot {
                session_id: session_id.to_string(),
                platforms: Vec::new(),
                updated_at: now.to_string(),
            }),
        };
        for platform in platforms {
            if snapshot
                .platforms
                .iter()
                .all(|entry| entry.platform != *platform)
            {
                snapshot.platforms.push(PlatformAudience {
                    platform: *platform,
                    metric: AudienceMetric::for_platform(*platform),
                    capability: AudienceCapability::Pending,
                    total: None,
                    baseline: None,
                    delta: None,
                    at: None,
                    message: None,
                });
            }
        }
        snapshot.platforms.sort_by_key(|entry| entry.platform as u8);
        snapshot.updated_at = now.to_string();
        snapshot.clone()
    }

    /// Applies one read. Returns the snapshot to emit when anything visible
    /// changed, or `None` for another session or an unchanged state.
    pub fn apply(
        &mut self,
        session_id: &str,
        platform: StreamPlatform,
        reading: &AudienceReading,
        now: &str,
    ) -> Option<AudienceSnapshot> {
        let snapshot = self
            .snapshot
            .as_mut()
            .filter(|snapshot| snapshot.session_id == session_id)?;
        let entry = snapshot
            .platforms
            .iter_mut()
            .find(|entry| entry.platform == platform)?;
        let before = entry.clone();
        match reading {
            AudienceReading::Count(total) => {
                let baseline = *entry.baseline.get_or_insert(*total);
                entry.capability = AudienceCapability::Available;
                entry.total = Some(*total);
                entry.delta = Some(signed_difference(*total, baseline));
                entry.at = Some(now.to_string());
                entry.message = None;
            }
            AudienceReading::Hidden => {
                entry.capability = AudienceCapability::Hidden;
                entry.total = None;
                entry.delta = None;
                entry.message = None;
            }
            AudienceReading::NeedsReconnect(message) => {
                entry.capability = AudienceCapability::NeedsReconnect;
                entry.total = None;
                entry.delta = None;
                entry.message = Some(message.clone());
            }
            AudienceReading::Unavailable(message) => {
                entry.capability = AudienceCapability::Unavailable;
                entry.total = None;
                entry.delta = None;
                entry.message = Some(message.clone());
            }
            // A transient failure keeps the last total; a first read that
            // fails stays pending rather than claiming a capability.
            AudienceReading::Failed(_) => {}
        }
        if *entry == before {
            return None;
        }
        snapshot.updated_at = now.to_string();
        Some(snapshot.clone())
    }

    pub fn snapshot(&self) -> Option<AudienceSnapshot> {
        self.snapshot.clone()
    }
}

fn signed_difference(total: u64, baseline: u64) -> i64 {
    let difference = i128::from(total) - i128::from(baseline);
    i64::try_from(difference).unwrap_or(if difference < 0 { i64::MIN } else { i64::MAX })
}

/// A platform to read for this session, resolved from its stored account on
/// every read so a refreshed token is always used. Built only by the backend
/// from the session's destinations, never from RPC params.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudienceSource {
    pub platform: StreamPlatform,
    /// `PlatformAccount.id` or the provider account id; `None` takes the
    /// first connected account of the platform.
    pub account_id: Option<String>,
}

/// Canned readings for smokes: no network, no credentials.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeAudienceConfig {
    pub platform: StreamPlatform,
    /// One total per read; the last one repeats.
    #[serde(default)]
    pub totals: Vec<u64>,
    /// Report this capability instead of totals.
    #[serde(default)]
    pub capability: Option<AudienceCapability>,
    #[serde(default = "default_fake_audience_interval_ms")]
    pub interval_ms: u64,
}

fn default_fake_audience_interval_ms() -> u64 {
    500
}

impl FakeAudienceConfig {
    fn reading(&self, read_index: usize) -> AudienceReading {
        match self.capability {
            Some(AudienceCapability::Hidden) => AudienceReading::Hidden,
            Some(AudienceCapability::NeedsReconnect) => {
                AudienceReading::NeedsReconnect(reconnect_message(self.platform).to_string())
            }
            Some(AudienceCapability::Unavailable) => {
                AudienceReading::Unavailable("Fake audience source is unavailable.".to_string())
            }
            Some(AudienceCapability::Pending) | Some(AudienceCapability::Available) | None => self
                .totals
                .get(read_index)
                .or_else(|| self.totals.last())
                .map(|total| AudienceReading::Count(*total))
                .unwrap_or_else(|| AudienceReading::Failed("No fake totals.".to_string())),
        }
    }
}

fn reconnect_message(platform: StreamPlatform) -> &'static str {
    match platform {
        StreamPlatform::Twitch => "Reconnect Twitch to show followers.",
        StreamPlatform::Youtube => "Reconnect YouTube to show subscribers.",
        StreamPlatform::X => "Reconnect X to show followers.",
        _ => "Reconnect this account to show its audience.",
    }
}

// --- Provider reads -------------------------------------------------------

/// Helix `Get Channel Followers` → `total`. Without `moderator:read:followers`
/// Twitch still returns the total, with an empty `data` list (S0 facts).
pub fn parse_twitch_follower_total(body: &Value) -> Option<u64> {
    body.get("total")?.as_u64()
}

/// `channels.list part=statistics` → `subscriberCount` (a string), or
/// `Hidden` when the channel hides it.
pub fn parse_youtube_subscribers(body: &Value) -> Option<AudienceReading> {
    let statistics = body.get("items")?.as_array()?.first()?.get("statistics")?;
    if statistics
        .get("hiddenSubscriberCount")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some(AudienceReading::Hidden);
    }
    let count = statistics.get("subscriberCount")?;
    count
        .as_u64()
        .or_else(|| count.as_str()?.parse().ok())
        .map(AudienceReading::Count)
}

/// `GET /2/users/me?user.fields=public_metrics` → `followers_count`.
pub fn parse_x_followers(body: &Value) -> Option<u64> {
    body.get("data")?
        .get("public_metrics")?
        .get("followers_count")?
        .as_u64()
}

/// Maps one HTTP response to a reading. 401 and 403 mean the token or its
/// grant was refused; anything else unsuccessful is transient.
async fn reading_from_response(
    platform: StreamPlatform,
    response: reqwest::Result<reqwest::Response>,
    parse: impl FnOnce(&Value) -> Option<AudienceReading>,
) -> AudienceReading {
    let response = match response {
        Ok(response) => response,
        Err(error) => return AudienceReading::Failed(format!("Request failed: {error}")),
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return AudienceReading::NeedsReconnect(reconnect_message(platform).to_string());
    }
    if !status.is_success() {
        return AudienceReading::Failed(format!("HTTP {status}"));
    }
    match response.json::<Value>().await {
        Ok(body) => parse(&body)
            .unwrap_or_else(|| AudienceReading::Failed("Unexpected response shape.".to_string())),
        Err(error) => AudienceReading::Failed(format!("Unreadable response: {error}")),
    }
}

pub async fn fetch_twitch_followers(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
    client_id: &str,
    broadcaster_id: &str,
) -> AudienceReading {
    let url = format!("{}/channels/followers", api_base.trim_end_matches('/'));
    let response = client
        .get(url)
        .query(&[("broadcaster_id", broadcaster_id), ("first", "1")])
        .bearer_auth(access_token)
        .header("Client-Id", client_id)
        .send()
        .await;
    reading_from_response(StreamPlatform::Twitch, response, |body| {
        parse_twitch_follower_total(body).map(AudienceReading::Count)
    })
    .await
}

pub async fn fetch_youtube_subscribers(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
) -> AudienceReading {
    let url = format!(
        "{}/channels?part=statistics&mine=true",
        api_base.trim_end_matches('/')
    );
    let response = client.get(url).bearer_auth(access_token).send().await;
    reading_from_response(StreamPlatform::Youtube, response, parse_youtube_subscribers).await
}

pub async fn fetch_x_followers_oauth2(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
) -> AudienceReading {
    let url = format!(
        "{}/2/users/me?user.fields=public_metrics",
        api_base.trim_end_matches('/')
    );
    let response = client.get(url).bearer_auth(access_token).send().await;
    reading_from_response(StreamPlatform::X, response, |body| {
        parse_x_followers(body).map(AudienceReading::Count)
    })
    .await
}

pub async fn fetch_x_followers_oauth1(
    client: &reqwest::Client,
    api_base: &str,
    credentials: &crate::x_live::XLivestreamCredentials,
) -> AudienceReading {
    let url = format!(
        "{}/2/users/me?user.fields=public_metrics",
        api_base.trim_end_matches('/')
    );
    let authorization = match crate::x_live::oauth1_authorization_header(
        "GET",
        &url,
        credentials,
        &crate::x_live::oauth_nonce(),
        crate::x_live::oauth_timestamp(),
    ) {
        Ok(authorization) => authorization,
        Err(error) => return AudienceReading::Failed(format!("Could not sign: {error}")),
    };
    let response = client
        .get(url)
        .header("Authorization", authorization)
        .send()
        .await;
    reading_from_response(StreamPlatform::X, response, |body| {
        parse_x_followers(body).map(AudienceReading::Count)
    })
    .await
}

// --- Reading a real account ------------------------------------------------

/// Reads one real source. A refused token is refreshed once and the read
/// retried before the platform is marked `needs-reconnect` (B2).
async fn read_source(
    state: &AppState,
    client: &reqwest::Client,
    source: &AudienceSource,
) -> AudienceReading {
    if let Some(message) = crate::oauth::provider_oauth_unavailable_message(source.platform) {
        return AudienceReading::Unavailable(message.to_string());
    }
    let account_id = source.account_id.as_deref();
    let credential = crate::platform_account_credential(state, source.platform, account_id).ok();
    let Some(credential) = credential else {
        if source.platform == StreamPlatform::X
            && let Ok(Some(credentials)) = crate::x_live::x_livestream_credentials()
        {
            // No X OAuth account, but "Authorize X Live" signed this stream.
            return fetch_x_followers_oauth1(
                client,
                crate::x_live::DEFAULT_API_BASE_URL,
                &credentials,
            )
            .await;
        }
        return AudienceReading::Unavailable(format!(
            "Connect {} to show its audience.",
            crate::streaming::stream_platform_label(source.platform)
        ));
    };
    let token = match crate::session_platform_access_token(
        state,
        source.platform,
        account_id,
        client,
        None,
    )
    .await
    {
        Ok(token) => token,
        Err(error) => return token_error_reading(source.platform, &error),
    };
    let reading = read_with_token(client, source.platform, &credential, &token).await;
    if !matches!(reading, AudienceReading::NeedsReconnect(_)) {
        return reading;
    }
    match crate::session_platform_access_token(
        state,
        source.platform,
        account_id,
        client,
        Some(&token),
    )
    .await
    {
        Ok(refreshed) => read_with_token(client, source.platform, &credential, &refreshed).await,
        Err(error) => token_error_reading(source.platform, &error),
    }
}

fn token_error_reading(platform: StreamPlatform, error: &anyhow::Error) -> AudienceReading {
    if crate::is_temporary_provider_validation_error(&error.to_string()) {
        AudienceReading::Failed(error.to_string())
    } else {
        AudienceReading::NeedsReconnect(reconnect_message(platform).to_string())
    }
}

async fn read_with_token(
    client: &reqwest::Client,
    platform: StreamPlatform,
    credential: &crate::storage::PlatformAccountCredentials,
    token: &str,
) -> AudienceReading {
    match platform {
        StreamPlatform::Twitch => {
            let client_id = match crate::oauth::provider_client_id(StreamPlatform::Twitch) {
                Ok(client_id) => client_id,
                Err(error) => return AudienceReading::Unavailable(error.to_string()),
            };
            fetch_twitch_followers(
                client,
                TWITCH_API_BASE,
                token,
                &client_id,
                &credential.account.account_id,
            )
            .await
        }
        StreamPlatform::Youtube => fetch_youtube_subscribers(client, YOUTUBE_API_BASE, token).await,
        StreamPlatform::X => {
            fetch_x_followers_oauth2(client, crate::x_live::DEFAULT_API_BASE_URL, token).await
        }
        _ => AudienceReading::Unavailable("This platform has no audience API.".to_string()),
    }
}

// --- Session lifecycle ------------------------------------------------------

fn publish(state: &AppState, snapshot: AudienceSnapshot, persist: bool) {
    if persist && let Ok(json) = serde_json::to_string(&snapshot) {
        let _ = state.database.add_session_log(
            &snapshot.session_id,
            HealthLevel::Info,
            AUDIENCE_LOG_CODE,
            &json,
            None,
        );
    }
    state.emit_event("stream.audience", snapshot);
}

fn apply_reading(
    state: &AppState,
    session_id: &str,
    platform: StreamPlatform,
    reading: &AudienceReading,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let snapshot = state
        .audience
        .lock()
        .ok()
        .and_then(|mut hub| hub.apply(session_id, platform, reading, &now));
    if let Some(snapshot) = snapshot {
        publish(state, snapshot, true);
    }
}

/// Registers the session's platforms and emits the pending snapshot. Returns
/// one task per source for the caller to attach to the session lifecycle.
pub fn start_audience(
    state: &AppState,
    session_id: &str,
    sources: Vec<AudienceSource>,
    fakes: Vec<FakeAudienceConfig>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let platforms: Vec<StreamPlatform> = sources
        .iter()
        .map(|source| source.platform)
        .chain(fakes.iter().map(|fake| fake.platform))
        .collect();
    if platforms.is_empty() {
        return Vec::new();
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Ok(mut hub) = state.audience.lock() {
        let snapshot = hub.begin(session_id, &platforms, &now);
        publish(state, snapshot, false);
    }
    let mut handles = Vec::new();
    for source in sources {
        handles.push(tokio::spawn(run_source(
            state.clone(),
            session_id.to_string(),
            source,
        )));
    }
    for fake in fakes {
        handles.push(tokio::spawn(run_fake(
            state.clone(),
            session_id.to_string(),
            fake,
        )));
    }
    handles
}

async fn run_source(state: AppState, session_id: String, source: AudienceSource) {
    let client = reqwest::Client::new();
    // Deterministic jitter per session and platform keeps concurrent reads
    // from aligning, without a RNG.
    let jitter_ms = (session_id.bytes().map(u64::from).sum::<u64>() + source.platform as u64 * 997)
        % 15_000
        + 1_000;
    sleep(Duration::from_millis(jitter_ms)).await;
    let mut backoff = None;
    loop {
        let reading = read_source(&state, &client, &source).await;
        apply_reading(&state, &session_id, source.platform, &reading);
        let delay = reading.next_delay(backoff);
        backoff = matches!(reading, AudienceReading::Failed(_)).then_some(delay);
        sleep(delay).await;
    }
}

async fn run_fake(state: AppState, session_id: String, fake: FakeAudienceConfig) {
    let interval = Duration::from_millis(fake.interval_ms.max(50));
    for read_index in 0.. {
        sleep(interval).await;
        let reading = fake.reading(read_index);
        apply_reading(&state, &session_id, fake.platform, &reading);
    }
}

/// `sessions.audience.get` params.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAudienceParams {
    pub session_id: String,
}

/// The last audience snapshot saved for a finished session, for History.
pub fn session_audience(
    database: &crate::storage::Database,
    session_id: &str,
) -> anyhow::Result<Option<AudienceSnapshot>> {
    Ok(database
        .list_session_log_messages(session_id, AUDIENCE_LOG_CODE, 1)?
        .last()
        .and_then(|message| serde_json::from_str(message).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    macro_rules! fixture {
        ($name:literal) => {
            serde_json::from_str::<Value>(include_str!(concat!(
                "../../../scripts/fixtures/stream-manager/",
                $name,
                ".json"
            )))
            .unwrap()
        };
    }

    #[derive(Clone)]
    struct Mock {
        responses: Arc<Vec<(StatusCode, Value)>>,
        hits: Arc<AtomicUsize>,
    }

    async fn respond(State(mock): State<Mock>) -> impl IntoResponse {
        let index = mock.hits.fetch_add(1, Ordering::SeqCst);
        let (status, body) = mock
            .responses
            .get(index)
            .or_else(|| mock.responses.last())
            .cloned()
            .unwrap();
        (status, axum::Json(body))
    }

    /// Serves `responses` in order on every provider path the poller uses.
    async fn spawn_provider(responses: Vec<(StatusCode, Value)>) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/channels/followers", get(respond))
            .route("/channels", get(respond))
            .route("/2/users/me", get(respond))
            .with_state(Mock {
                responses: Arc::new(responses),
                hits: hits.clone(),
            });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), hits)
    }

    #[tokio::test]
    async fn reads_each_platforms_total_from_the_provider_fixtures() {
        let client = reqwest::Client::new();
        let (twitch, _) =
            spawn_provider(vec![(StatusCode::OK, fixture!("twitch-channel-followers"))]).await;
        assert_eq!(
            fetch_twitch_followers(&client, &twitch, "token", "client", "1234").await,
            AudienceReading::Count(61_930)
        );
        let (x, _) = spawn_provider(vec![(
            StatusCode::OK,
            fixture!("x-users-me-public-metrics"),
        )])
        .await;
        assert_eq!(
            fetch_x_followers_oauth2(&client, &x, "token").await,
            AudienceReading::Count(12_873)
        );
        let (youtube, _) = spawn_provider(vec![(
            StatusCode::OK,
            fixture!("youtube-channels-statistics"),
        )])
        .await;
        assert_eq!(
            fetch_youtube_subscribers(&client, &youtube, "token").await,
            AudienceReading::Count(48_200)
        );
    }

    #[tokio::test]
    async fn a_refused_token_needs_a_reconnect_and_other_errors_are_transient() {
        let client = reqwest::Client::new();
        let (base, _) = spawn_provider(vec![
            (StatusCode::UNAUTHORIZED, json!({ "status": 401 })),
            (StatusCode::FORBIDDEN, json!({ "status": 403 })),
            (StatusCode::SERVICE_UNAVAILABLE, json!({})),
            (StatusCode::OK, json!({ "data": [] })),
        ])
        .await;
        for _ in 0..2 {
            assert_eq!(
                fetch_twitch_followers(&client, &base, "token", "client", "1").await,
                AudienceReading::NeedsReconnect("Reconnect Twitch to show followers.".to_string())
            );
        }
        assert!(matches!(
            fetch_twitch_followers(&client, &base, "token", "client", "1").await,
            AudienceReading::Failed(_)
        ));
        // A 200 without `total` is a shape problem, never a zero.
        assert!(matches!(
            fetch_twitch_followers(&client, &base, "token", "client", "1").await,
            AudienceReading::Failed(_)
        ));
    }

    #[tokio::test]
    async fn a_hidden_subscriber_count_is_reported_as_hidden() {
        let client = reqwest::Client::new();
        let mut hidden = fixture!("youtube-channels-statistics");
        hidden["items"][0]["statistics"]["hiddenSubscriberCount"] = json!(true);
        let (base, _) = spawn_provider(vec![(StatusCode::OK, hidden)]).await;
        assert_eq!(
            fetch_youtube_subscribers(&client, &base, "token").await,
            AudienceReading::Hidden
        );
    }

    #[test]
    fn failures_back_off_to_ten_minutes() {
        let failed = AudienceReading::Failed("HTTP 503".to_string());
        let first = failed.next_delay(None);
        assert_eq!(first, AUDIENCE_FIRST_BACKOFF);
        let second = failed.next_delay(Some(first));
        assert_eq!(second, Duration::from_secs(480));
        assert_eq!(failed.next_delay(Some(second)), AUDIENCE_MAX_BACKOFF);
        assert_eq!(
            failed.next_delay(Some(AUDIENCE_MAX_BACKOFF)),
            AUDIENCE_MAX_BACKOFF
        );
        assert_eq!(
            AudienceReading::Count(1).next_delay(Some(second)),
            AUDIENCE_POLL_INTERVAL
        );
        assert_eq!(
            AudienceReading::NeedsReconnect(String::new()).next_delay(None),
            AUDIENCE_MAX_BACKOFF
        );
    }

    #[test]
    fn the_first_reading_is_the_baseline_and_later_ones_are_deltas() {
        let mut hub = AudienceHub::default();
        let pending = hub.begin("s", &[StreamPlatform::X, StreamPlatform::Twitch], "t0");
        assert_eq!(
            pending
                .platforms
                .iter()
                .map(|entry| (entry.platform, entry.capability))
                .collect::<Vec<_>>(),
            vec![
                (StreamPlatform::Twitch, AudienceCapability::Pending),
                (StreamPlatform::X, AudienceCapability::Pending)
            ]
        );
        let first = hub
            .apply(
                "s",
                StreamPlatform::Twitch,
                &AudienceReading::Count(100),
                "t1",
            )
            .unwrap();
        let twitch = &first.platforms[0];
        assert_eq!(
            (twitch.total, twitch.baseline, twitch.delta),
            (Some(100), Some(100), Some(0))
        );
        let grown = hub
            .apply(
                "s",
                StreamPlatform::Twitch,
                &AudienceReading::Count(112),
                "t2",
            )
            .unwrap();
        assert_eq!(grown.platforms[0].delta, Some(12));
        let shrunk = hub
            .apply(
                "s",
                StreamPlatform::Twitch,
                &AudienceReading::Count(98),
                "t3",
            )
            .unwrap();
        assert_eq!(shrunk.platforms[0].delta, Some(-2));
        // A transient failure keeps the last total and emits nothing.
        assert!(
            hub.apply(
                "s",
                StreamPlatform::Twitch,
                &AudienceReading::Failed("x".to_string()),
                "t4"
            )
            .is_none()
        );
        // Another session's late read is ignored.
        assert!(
            hub.apply(
                "old",
                StreamPlatform::Twitch,
                &AudienceReading::Count(1),
                "t5"
            )
            .is_none()
        );
        let reconnect = hub
            .apply(
                "s",
                StreamPlatform::X,
                &AudienceReading::NeedsReconnect("Reconnect X to show followers.".to_string()),
                "t6",
            )
            .unwrap();
        let x = &reconnect.platforms[1];
        assert_eq!(x.capability, AudienceCapability::NeedsReconnect);
        assert_eq!(x.total, None);
        // Re-registering the same session keeps its baselines.
        let again = hub.begin("s", &[StreamPlatform::Twitch], "t7");
        assert_eq!(again.platforms[0].baseline, Some(100));
    }

    #[test]
    fn snapshots_serialize_without_nulls() {
        let mut hub = AudienceHub::default();
        let pending = hub.begin("s", &[StreamPlatform::Youtube], "t0");
        let wire = serde_json::to_value(&pending).unwrap();
        assert_eq!(
            wire,
            json!({
                "sessionId": "s",
                "platforms": [{ "platform": "youtube", "metric": "subscribers", "capability": "pending" }],
                "updatedAt": "t0"
            })
        );
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
    async fn a_fake_session_emits_a_baseline_and_then_a_delta() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let handles = start_audience(
            &state,
            "fake-session",
            Vec::new(),
            vec![FakeAudienceConfig {
                platform: StreamPlatform::Twitch,
                totals: vec![500, 512],
                capability: None,
                interval_ms: 50,
            }],
        );
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while seen.len() < 3 && tokio::time::Instant::now() < deadline {
            let Ok(Ok(event)) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            else {
                continue;
            };
            if event.event != "stream.audience" {
                continue;
            }
            let snapshot: AudienceSnapshot = serde_json::from_value(event.payload).unwrap();
            seen.push(snapshot.platforms[0].clone());
        }
        for handle in handles {
            handle.abort();
        }
        assert_eq!(seen[0].capability, AudienceCapability::Pending);
        assert_eq!((seen[1].total, seen[1].delta), (Some(500), Some(0)));
        assert_eq!((seen[2].total, seen[2].delta), (Some(512), Some(12)));
        let saved = session_audience(&state.database, "fake-session");
        // The fake session has no sessions row, so the log insert is refused
        // by the foreign key; the in-memory hub still answers.
        assert!(saved.is_ok());
        assert_eq!(
            state.audience.lock().unwrap().snapshot().unwrap().platforms[0].total,
            Some(512)
        );
    }
}
