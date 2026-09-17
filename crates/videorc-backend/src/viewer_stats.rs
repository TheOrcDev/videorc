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

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;

use crate::protocol::HealthLevel;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

pub const VIEWER_SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
pub const VIEWER_SAMPLE_LOG_CODE: &str = "stream-viewers";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeViewerConfig {
    pub access_token: String,
    pub broadcast_id: String,
    #[serde(default)]
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchViewerConfig {
    pub access_token: String,
    pub client_id: String,
    pub broadcaster_user_id: String,
    #[serde(default)]
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XViewerConfig {
    pub broadcast_id: String,
    #[serde(default)]
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPlatformCount {
    pub platform: StreamPlatform,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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

async fn fetch_youtube_count(
    client: &reqwest::Client,
    config: &YouTubeViewerConfig,
) -> Option<u64> {
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or("https://www.googleapis.com/youtube/v3");
    let url = format!(
        "{}/videos?part=liveStreamingDetails&id={}",
        base.trim_end_matches('/'),
        config.broadcast_id
    );
    let response = client
        .get(url)
        .bearer_auth(&config.access_token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    parse_youtube_concurrent_viewers(&body)
}

async fn fetch_twitch_count(client: &reqwest::Client, config: &TwitchViewerConfig) -> Option<u64> {
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or("https://api.twitch.tv/helix");
    let url = format!(
        "{}/streams?user_id={}",
        base.trim_end_matches('/'),
        config.broadcaster_user_id
    );
    let response = client
        .get(url)
        .bearer_auth(&config.access_token)
        .header("Client-Id", &config.client_id)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    parse_twitch_viewer_count(&body)
}

async fn fetch_x_count(client: &reqwest::Client, config: &XViewerConfig) -> Option<u64> {
    // Credentials are resolved per poll so a rotated token is picked up
    // without restarting the sampler.
    let credentials = crate::x_live::x_livestream_credentials().ok().flatten()?;
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or(crate::x_live::DEFAULT_API_BASE_URL);
    crate::x_live::fetch_broadcast_viewer_count(client, &credentials, base, &config.broadcast_id)
        .await
}

/// Session-scoped sampler task; aborted with the live-chat connectors on stop.
pub async fn run_viewer_sampler(
    state: AppState,
    session_id: String,
    youtube: Option<YouTubeViewerConfig>,
    twitch: Option<TwitchViewerConfig>,
    x: Option<XViewerConfig>,
) {
    if youtube.is_none() && twitch.is_none() && x.is_none() {
        return;
    }
    let client = reqwest::Client::new();
    // Deterministic jitter from the session id keeps concurrent sessions from
    // aligning their polls without needing a RNG.
    let jitter_ms = (session_id.bytes().map(u64::from).sum::<u64>() % 5000) + 500;
    sleep(Duration::from_millis(jitter_ms)).await;

    loop {
        let mut counts: Vec<(StreamPlatform, Option<u64>)> = Vec::new();
        if let Some(config) = youtube.as_ref() {
            counts.push((
                StreamPlatform::Youtube,
                fetch_youtube_count(&client, config).await,
            ));
        }
        if let Some(config) = twitch.as_ref() {
            counts.push((
                StreamPlatform::Twitch,
                fetch_twitch_count(&client, config).await,
            ));
        }
        if let Some(config) = x.as_ref() {
            counts.push((StreamPlatform::X, fetch_x_count(&client, config).await));
        }

        let at = chrono::Utc::now().to_rfc3339();
        if let Some(sample) = merge_viewer_sample(&session_id, counts, at) {
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
}
