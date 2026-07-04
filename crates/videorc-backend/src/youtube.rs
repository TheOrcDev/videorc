use anyhow::{Context, Result};
use chrono::{Duration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration as StdDuration;

use crate::protocol::VideoSettings;
use crate::streaming::{StreamMetadataDraft, StreamPlatform, StreamPrivacy};

const YOUTUBE_API_BASE_URL: &str = "https://www.googleapis.com";
const YOUTUBE_TRANSITION_CONFIRM_POLL_ATTEMPTS: usize = 30;
const YOUTUBE_TRANSITION_CONFIRM_POLL_DELAY: StdDuration = StdDuration::from_secs(1);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub video: VideoSettings,
}

#[derive(Debug, Clone)]
pub struct YouTubePrepareRequest {
    pub access_token: String,
    pub account_id: String,
    pub account_label: String,
    pub metadata: StreamMetadataDraft,
    pub video: VideoSettings,
    pub api_base_url: Option<String>,
    pub scheduled_start_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedYouTubeBroadcast {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub broadcast_id: String,
    pub stream_id: String,
    pub server_url: String,
    pub stream_key_secret_ref: String,
    pub stream_key_present: bool,
    pub redacted_url: String,
    pub title: String,
    pub description: String,
    pub privacy: StreamPrivacy,
    pub made_for_kids: bool,
    pub scheduled_start_time: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum YouTubeBroadcastTransitionStatus {
    Complete,
    Live,
    Testing,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeBroadcastTransitionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub broadcast_id: String,
    pub status: YouTubeBroadcastTransitionStatus,
}

#[derive(Debug, Clone)]
pub struct YouTubeBroadcastTransitionRequest {
    pub access_token: String,
    pub account_id: String,
    pub broadcast_id: String,
    pub status: YouTubeBroadcastTransitionStatus,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeBroadcastTransitionResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub broadcast_id: String,
    pub requested_status: YouTubeBroadcastTransitionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_status: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeStreamStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub stream_id: String,
}

#[derive(Debug, Clone)]
pub struct YouTubeStreamStatusRequest {
    pub access_token: String,
    pub account_id: String,
    pub stream_id: String,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeStreamStatusResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub stream_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_status: Option<String>,
    pub active: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannelListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct YouTubeChannelListRequest {
    pub access_token: String,
    pub account_id: String,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannelListResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub channels: Vec<YouTubeChannel>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannelSelectParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannel {
    pub channel_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveYouTubeMetadata {
    title: String,
    description: String,
    privacy: StreamPrivacy,
    made_for_kids: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeIdResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamResponse {
    id: String,
    cdn: YouTubeLiveStreamCdn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamCdn {
    ingestion_info: YouTubeIngestionInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeIngestionInfo {
    ingestion_address: String,
    stream_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeBroadcastTransitionResponse {
    id: String,
    status: Option<YouTubeBroadcastStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveBroadcastListResponse {
    items: Vec<YouTubeBroadcastTransitionResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeBroadcastStatus {
    life_cycle_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamListResponse {
    items: Vec<YouTubeLiveStreamStatusItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamStatusItem {
    id: String,
    status: Option<YouTubeLiveStreamStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamStatus {
    stream_status: Option<String>,
    health_status: Option<YouTubeLiveStreamHealthStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeLiveStreamHealthStatus {
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeChannelListResponse {
    items: Vec<YouTubeChannelItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeChannelItem {
    id: String,
    snippet: YouTubeChannelSnippet,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YouTubeChannelSnippet {
    title: String,
    custom_url: Option<String>,
    thumbnails: Option<YouTubeChannelThumbnails>,
}

#[derive(Debug, Deserialize)]
struct YouTubeChannelThumbnails {
    high: Option<YouTubeThumbnail>,
    medium: Option<YouTubeThumbnail>,
    default: Option<YouTubeThumbnail>,
}

#[derive(Debug, Deserialize)]
struct YouTubeThumbnail {
    url: String,
}

pub async fn prepare_youtube_broadcast(
    request: YouTubePrepareRequest,
    client: &reqwest::Client,
    put_secret: impl FnOnce(&str, &str) -> Result<()>,
) -> Result<PreparedYouTubeBroadcast> {
    let metadata = effective_youtube_metadata(&request.metadata)?;
    let scheduled_start_time = request.scheduled_start_time.unwrap_or_else(|| {
        (Utc::now() + Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    });
    let base_url = request
        .api_base_url
        .unwrap_or_else(|| YOUTUBE_API_BASE_URL.to_string());

    let broadcast_response = client
        .post(youtube_api_url(
            &base_url,
            "/youtube/v3/liveBroadcasts",
            &[("part", "snippet,status,contentDetails")],
        )?)
        .bearer_auth(&request.access_token)
        .json(&json!({
            "snippet": {
                "title": metadata.title,
                "description": metadata.description,
                "scheduledStartTime": scheduled_start_time,
            },
            "status": {
                "privacyStatus": youtube_privacy(metadata.privacy),
                "selfDeclaredMadeForKids": metadata.made_for_kids,
            },
            "contentDetails": {
                "enableAutoStart": true,
                "enableAutoStop": true,
                // The API defaults monitor streams to enabled. With a monitor stream
                // enabled, YouTube rejects direct ready -> live transitions; our Go
                // Live flow waits for active ingest, then transitions directly live.
                "monitorStream": {
                    "enableMonitorStream": false,
                },
                // YouTube defaults to "normal" latency (30-60s by design). Low keeps
                // every feature at ~10-15s glass-to-glass; ultraLow restricts
                // resolutions and is deliberately not the default here.
                "latencyPreference": "low",
            },
        }))
        .send()
        .await
        .context("Could not create YouTube broadcast.")?;
    let broadcast: YouTubeIdResponse =
        require_youtube_success(broadcast_response, "YouTube broadcast creation failed")
            .await?
            .json()
            .await
            .context("Could not parse YouTube broadcast response.")?;

    // From here on a failure must roll back what was already created on the
    // channel; otherwise every failed Go Live leaves an orphaned scheduled
    // broadcast behind in YouTube Studio.
    let stream_and_bind = async {
        let stream_response = client
            .post(youtube_api_url(
                &base_url,
                "/youtube/v3/liveStreams",
                &[("part", "snippet,cdn,contentDetails,status")],
            )?)
            .bearer_auth(&request.access_token)
            .json(&json!({
                "snippet": {
                    "title": format!("Videorc {}", request.account_label),
                    "description": "Created by Videorc",
                },
                "cdn": {
                    "frameRate": youtube_frame_rate(request.video.fps),
                    "ingestionType": "rtmp",
                    "resolution": youtube_resolution(request.video.height),
                },
                "contentDetails": {
                    "isReusable": true,
                },
            }))
            .send()
            .await
            .context("Could not create YouTube stream.")?;
        let live_stream: YouTubeLiveStreamResponse =
            require_youtube_success(stream_response, "YouTube stream creation failed")
                .await?
                .json()
                .await
                .context("Could not parse YouTube stream response.")?;

        let bind_response = client
            .post(youtube_api_url(
                &base_url,
                "/youtube/v3/liveBroadcasts/bind",
                &[
                    ("id", broadcast.id.as_str()),
                    ("part", "id,contentDetails"),
                    ("streamId", live_stream.id.as_str()),
                ],
            )?)
            .bearer_auth(&request.access_token)
            // Parameter-only POST: Google's front end rejects requests without a
            // Content-Length header with 411. reqwest/hyper omit the header for empty
            // bodies (even `.body("")`), so it must be set explicitly — proven by
            // tests/content_length_wire.rs.
            .header(reqwest::header::CONTENT_LENGTH, "0")
            .body("")
            .send()
            .await
            .context("Could not bind YouTube broadcast to stream.")?;
        let _bound: YouTubeIdResponse =
            require_youtube_success(bind_response, "YouTube broadcast bind failed")
                .await?
                .json()
                .await
                .context("Could not parse YouTube bind response.")?;
        Ok::<YouTubeLiveStreamResponse, anyhow::Error>(live_stream)
    }
    .await;
    let live_stream = match stream_and_bind {
        Ok(live_stream) => live_stream,
        Err(error) => {
            delete_youtube_resource(
                client,
                &base_url,
                &request.access_token,
                "/youtube/v3/liveBroadcasts",
                &broadcast.id,
            )
            .await;
            return Err(error);
        }
    };

    let stream_key_secret_ref = format!("platform:youtube:{}:stream-key", request.account_id);
    put_secret(
        &stream_key_secret_ref,
        &live_stream.cdn.ingestion_info.stream_name,
    )
    .context("Could not store YouTube stream key.")?;

    Ok(PreparedYouTubeBroadcast {
        platform: StreamPlatform::Youtube,
        account_id: request.account_id,
        account_label: request.account_label,
        broadcast_id: broadcast.id,
        stream_id: live_stream.id,
        server_url: live_stream.cdn.ingestion_info.ingestion_address,
        stream_key_secret_ref,
        stream_key_present: true,
        redacted_url: "rtmp://<youtube-ingest>/<stream-key>".to_string(),
        title: metadata.title,
        description: metadata.description,
        privacy: metadata.privacy,
        made_for_kids: metadata.made_for_kids,
        scheduled_start_time,
    })
}

pub async fn list_youtube_channels(
    request: YouTubeChannelListRequest,
    client: &reqwest::Client,
) -> Result<YouTubeChannelListResult> {
    let base_url = request
        .api_base_url
        .unwrap_or_else(|| YOUTUBE_API_BASE_URL.to_string());
    let channels_response = client
        .get(youtube_api_url(
            &base_url,
            "/youtube/v3/channels",
            &[("part", "snippet"), ("mine", "true"), ("maxResults", "50")],
        )?)
        .bearer_auth(&request.access_token)
        .send()
        .await
        .context("Could not fetch YouTube channels.")?;
    let response: YouTubeChannelListResponse =
        require_youtube_success(channels_response, "YouTube channel list request failed")
            .await?
            .json()
            .await
            .context("Could not parse YouTube channel list response.")?;

    Ok(YouTubeChannelListResult {
        platform: StreamPlatform::Youtube,
        account_id: request.account_id,
        channels: response
            .items
            .into_iter()
            .map(|item| YouTubeChannel {
                channel_id: item.id,
                title: item.snippet.title,
                handle: item.snippet.custom_url,
                avatar_url: item.snippet.thumbnails.and_then(youtube_thumbnail_url),
            })
            .collect(),
    })
}

pub fn select_youtube_channel(
    channels: &[YouTubeChannel],
    channel_id: &str,
) -> Result<YouTubeChannel> {
    let channel_id = channel_id.trim();
    if channel_id.is_empty() {
        anyhow::bail!("A YouTube channel ID is required.");
    }

    channels
        .iter()
        .find(|channel| channel.channel_id == channel_id)
        .cloned()
        .with_context(|| format!("YouTube channel {channel_id} is not available for this account."))
}

pub async fn get_youtube_stream_status(
    request: YouTubeStreamStatusRequest,
    client: &reqwest::Client,
) -> Result<YouTubeStreamStatusResult> {
    if request.stream_id.trim().is_empty() {
        anyhow::bail!("A YouTube stream ID is required.");
    }

    let base_url = request
        .api_base_url
        .unwrap_or_else(|| YOUTUBE_API_BASE_URL.to_string());
    let status_response = client
        .get(youtube_api_url(
            &base_url,
            "/youtube/v3/liveStreams",
            &[("part", "status"), ("id", request.stream_id.as_str())],
        )?)
        .bearer_auth(&request.access_token)
        .send()
        .await
        .context("Could not fetch YouTube stream status.")?;
    let response: YouTubeLiveStreamListResponse =
        require_youtube_success(status_response, "YouTube stream status request failed")
            .await?
            .json()
            .await
            .context("Could not parse YouTube stream status response.")?;

    let item = response
        .items
        .into_iter()
        .next()
        .context("YouTube stream was not found.")?;
    let stream_status = item
        .status
        .as_ref()
        .and_then(|status| status.stream_status.clone());
    let health_status = item
        .status
        .and_then(|status| status.health_status)
        .and_then(|health| health.status);
    let active = stream_status.as_deref() == Some("active");
    let message = match (&stream_status, &health_status) {
        (Some(stream_status), Some(health_status)) => {
            format!("YouTube stream status is {stream_status}; health is {health_status}.")
        }
        (Some(stream_status), None) => format!("YouTube stream status is {stream_status}."),
        (None, Some(health_status)) => format!("YouTube stream health is {health_status}."),
        (None, None) => "YouTube stream status is unavailable.".to_string(),
    };

    Ok(YouTubeStreamStatusResult {
        platform: StreamPlatform::Youtube,
        account_id: request.account_id,
        stream_id: item.id,
        stream_status,
        health_status,
        active,
        message,
    })
}

fn youtube_thumbnail_url(thumbnails: YouTubeChannelThumbnails) -> Option<String> {
    thumbnails
        .high
        .or(thumbnails.medium)
        .or(thumbnails.default)
        .map(|thumbnail| thumbnail.url)
}

pub async fn transition_youtube_broadcast(
    request: YouTubeBroadcastTransitionRequest,
    client: &reqwest::Client,
) -> Result<YouTubeBroadcastTransitionResult> {
    if request.broadcast_id.trim().is_empty() {
        anyhow::bail!("A YouTube broadcast ID is required.");
    }

    let base_url = request
        .api_base_url
        .unwrap_or_else(|| YOUTUBE_API_BASE_URL.to_string());
    let status = youtube_transition_status(request.status);
    let response = client
        .post(youtube_api_url(
            &base_url,
            "/youtube/v3/liveBroadcasts/transition",
            &[
                ("broadcastStatus", status),
                ("id", request.broadcast_id.as_str()),
                ("part", "id,status"),
            ],
        )?)
        .bearer_auth(&request.access_token)
        // Parameter-only POST (see bind): Content-Length must be set explicitly.
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .body("")
        .send()
        .await
        .context("Could not transition YouTube broadcast.")?;

    if !response.status().is_success() {
        let status_code = response.status();
        let body = response.text().await.unwrap_or_default();
        if body.contains("redundantTransition") {
            let lifecycle_status = get_youtube_broadcast_lifecycle_status(
                client,
                &base_url,
                &request.access_token,
                &request.broadcast_id,
            )
            .await?;
            let lifecycle_status = confirm_youtube_lifecycle_status(
                client,
                &base_url,
                &request.access_token,
                &request.broadcast_id,
                lifecycle_status,
                request.status,
            )
            .await?;
            return Ok(YouTubeBroadcastTransitionResult {
                platform: StreamPlatform::Youtube,
                account_id: request.account_id,
                broadcast_id: request.broadcast_id,
                requested_status: request.status,
                lifecycle_status: Some(lifecycle_status),
                message: format!("YouTube broadcast is already {status}."),
            });
        }
        anyhow::bail!("YouTube broadcast transition failed ({status_code}): {body}");
    }

    let response: YouTubeBroadcastTransitionResponse = response
        .json()
        .await
        .context("Could not parse YouTube broadcast transition response.")?;
    let lifecycle_status = confirm_youtube_lifecycle_status(
        client,
        &base_url,
        &request.access_token,
        &request.broadcast_id,
        response.status.and_then(|status| status.life_cycle_status),
        request.status,
    )
    .await?;

    Ok(YouTubeBroadcastTransitionResult {
        platform: StreamPlatform::Youtube,
        account_id: request.account_id,
        broadcast_id: response.id,
        requested_status: request.status,
        lifecycle_status: Some(lifecycle_status),
        message: format!("YouTube broadcast transition requested: {status}."),
    })
}

async fn get_youtube_broadcast_lifecycle_status(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    broadcast_id: &str,
) -> Result<Option<String>> {
    let response = client
        .get(youtube_api_url(
            base_url,
            "/youtube/v3/liveBroadcasts",
            &[("part", "status"), ("id", broadcast_id)],
        )?)
        .bearer_auth(access_token)
        .send()
        .await
        .context("Could not fetch YouTube broadcast status.")?;
    let response: YouTubeLiveBroadcastListResponse =
        require_youtube_success(response, "YouTube broadcast status request failed")
            .await?
            .json()
            .await
            .context("Could not parse YouTube broadcast status response.")?;

    let broadcast = response
        .items
        .into_iter()
        .next()
        .context("YouTube broadcast was not found.")?;
    Ok(broadcast.status.and_then(|status| status.life_cycle_status))
}

async fn confirm_youtube_lifecycle_status(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    broadcast_id: &str,
    lifecycle_status: Option<String>,
    requested_status: YouTubeBroadcastTransitionStatus,
) -> Result<String> {
    if let Ok(status) = require_youtube_lifecycle_status(lifecycle_status.clone(), requested_status)
    {
        return Ok(status);
    }
    if !is_youtube_transition_pending_status(lifecycle_status.as_deref(), requested_status) {
        return require_youtube_lifecycle_status(lifecycle_status, requested_status);
    }

    let mut latest_status = lifecycle_status;
    for attempt in 0..YOUTUBE_TRANSITION_CONFIRM_POLL_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(YOUTUBE_TRANSITION_CONFIRM_POLL_DELAY).await;
        }
        latest_status =
            get_youtube_broadcast_lifecycle_status(client, base_url, access_token, broadcast_id)
                .await?;
        if let Ok(status) =
            require_youtube_lifecycle_status(latest_status.clone(), requested_status)
        {
            return Ok(status);
        }
        if !is_youtube_transition_pending_status(latest_status.as_deref(), requested_status) {
            return require_youtube_lifecycle_status(latest_status, requested_status);
        }
    }

    let expected = youtube_transition_status(requested_status);
    let current = latest_status.unwrap_or_else(|| "unavailable".to_string());
    anyhow::bail!(
        "YouTube did not reach {expected} after waiting; current broadcast status is {current}."
    )
}

fn is_youtube_transition_pending_status(
    lifecycle_status: Option<&str>,
    requested_status: YouTubeBroadcastTransitionStatus,
) -> bool {
    matches!(
        (requested_status, lifecycle_status),
        (_, None)
            | (YouTubeBroadcastTransitionStatus::Live, Some("liveStarting"))
            | (
                YouTubeBroadcastTransitionStatus::Testing,
                Some("testStarting")
            )
    )
}

fn require_youtube_lifecycle_status(
    lifecycle_status: Option<String>,
    requested_status: YouTubeBroadcastTransitionStatus,
) -> Result<String> {
    let expected = youtube_transition_status(requested_status);
    match lifecycle_status.as_deref() {
        Some(current) if current == expected => Ok(current.to_string()),
        Some(current) => anyhow::bail!(
            "YouTube did not reach {expected}; current broadcast status is {current}."
        ),
        None => anyhow::bail!(
            "YouTube did not confirm {expected}; current broadcast status is unavailable."
        ),
    }
}

fn effective_youtube_metadata(draft: &StreamMetadataDraft) -> Result<EffectiveYouTubeMetadata> {
    let override_draft = draft
        .target_overrides
        .iter()
        .find(|target| target.platform == StreamPlatform::Youtube);
    let title = override_draft
        .filter(|target| target.customize)
        .map(|target| target.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| draft.title.trim());
    if title.is_empty() {
        anyhow::bail!("A YouTube broadcast title is required.");
    }

    let description = override_draft
        .filter(|target| target.customize)
        .map(|target| target.description.trim())
        .unwrap_or_else(|| draft.description.trim())
        .to_string();
    let privacy = override_draft
        .filter(|target| target.customize)
        .map(|target| target.privacy)
        .unwrap_or(draft.default_privacy);
    let made_for_kids = override_draft
        .and_then(|target| target.youtube_made_for_kids)
        .unwrap_or(false);

    Ok(EffectiveYouTubeMetadata {
        title: title.to_string(),
        description,
        privacy,
        made_for_kids,
    })
}

fn youtube_api_url(base_url: &str, path: &str, query: &[(&str, &str)]) -> Result<Url> {
    let mut url = Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))
        .context("Invalid YouTube API base URL.")?;
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    Ok(url)
}

/// Best-effort rollback delete for a YouTube resource created during a failed
/// prepare flow. Failures are logged, never propagated — the original error is
/// what the user must see.
async fn delete_youtube_resource(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    path: &str,
    id: &str,
) {
    let url = match youtube_api_url(base_url, path, &[("id", id)]) {
        Ok(url) => url,
        Err(error) => {
            tracing::warn!("Could not build YouTube rollback delete URL: {error}");
            return;
        }
    };
    match client.delete(url).bearer_auth(access_token).send().await {
        Ok(response) if response.status().is_success() => {
            tracing::info!("Rolled back orphaned YouTube resource {path} id redacted.");
        }
        Ok(response) => {
            tracing::warn!(
                "YouTube rollback delete for {path} returned {}.",
                response.status()
            );
        }
        Err(error) => {
            tracing::warn!("YouTube rollback delete for {path} failed: {error}");
        }
    }
}

/// Replace `error_for_status` for YouTube API calls: Google puts the actionable
/// reason (liveStreamingNotEnabled, insufficientLivePermissions, quota…) in the
/// error BODY, and dropping it leaves the user with an unfixable generic message.
async fn require_youtube_success(
    response: reqwest::Response,
    action: &str,
) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    anyhow::bail!("{action} ({status}): {}", youtube_error_detail(&body));
}

pub fn is_youtube_auth_error(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("401 unauthorized")
        || message.contains("401 unauthenticated")
        || message.contains("(401")
        || message.contains("invalid credentials")
        || message.contains("autherror")
        || message.contains("unauthenticated")
}

fn youtube_error_detail(body: &str) -> String {
    #[derive(Deserialize)]
    struct GoogleErrorEnvelope {
        error: Option<GoogleErrorBody>,
    }
    #[derive(Deserialize)]
    struct GoogleErrorBody {
        message: Option<String>,
        status: Option<String>,
        errors: Option<Vec<GoogleErrorItem>>,
    }
    #[derive(Deserialize)]
    struct GoogleErrorItem {
        reason: Option<String>,
        message: Option<String>,
    }

    if let Ok(envelope) = serde_json::from_str::<GoogleErrorEnvelope>(body)
        && let Some(error) = envelope.error
    {
        let reason = error
            .errors
            .as_ref()
            .and_then(|errors| errors.first())
            .and_then(|item| item.reason.clone())
            .or(error.status);
        let message = error
            .errors
            .as_ref()
            .and_then(|errors| errors.first())
            .and_then(|item| item.message.clone())
            .or(error.message)
            .unwrap_or_else(|| "no detail".to_string());
        return match reason {
            Some(reason) => format!("{reason}: {message}"),
            None => message,
        };
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "no error body".to_string()
    } else {
        trimmed.chars().take(300).collect()
    }
}

fn youtube_privacy(privacy: StreamPrivacy) -> &'static str {
    match privacy {
        StreamPrivacy::Public => "public",
        StreamPrivacy::Unlisted => "unlisted",
        StreamPrivacy::Private => "private",
    }
}

fn youtube_transition_status(status: YouTubeBroadcastTransitionStatus) -> &'static str {
    match status {
        YouTubeBroadcastTransitionStatus::Complete => "complete",
        YouTubeBroadcastTransitionStatus::Live => "live",
        YouTubeBroadcastTransitionStatus::Testing => "testing",
    }
}

fn youtube_frame_rate(fps: u32) -> &'static str {
    if fps > 30 { "60fps" } else { "30fps" }
}

fn youtube_resolution(height: u32) -> &'static str {
    match height {
        0..=240 => "240p",
        241..=360 => "360p",
        361..=480 => "480p",
        481..=720 => "720p",
        721..=1080 => "1080p",
        1081..=1440 => "1440p",
        _ => "2160p",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{OriginalUri, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::Value;
    use tokio::net::TcpListener;

    use super::*;
    use crate::protocol::{VideoPreset, VideoSettings};
    use crate::streaming::{StreamPrivacy, default_stream_metadata_draft};

    #[derive(Debug, Clone)]
    struct RequestLog {
        path: String,
        query: String,
        authorization: Option<String>,
        body: Value,
    }

    type RequestLogs = Arc<Mutex<Vec<RequestLog>>>;

    #[tokio::test]
    async fn failed_bind_rolls_back_the_created_broadcast() {
        async fn create_broadcast() -> impl axum::response::IntoResponse {
            Json(json!({ "id": "broadcast-123" })).into_response()
        }
        async fn create_stream() -> impl axum::response::IntoResponse {
            Json(json!({
                "id": "stream-456",
                "cdn": {
                    "ingestionInfo": {
                        "ingestionAddress": "rtmp://a.rtmp.youtube.com/live2",
                        "streamName": "secret-stream-name"
                    }
                }
            }))
            .into_response()
        }
        async fn bind_fails() -> impl axum::response::IntoResponse {
            (
                axum::http::StatusCode::FORBIDDEN,
                Json(json!({
                    "error": {
                        "code": 403,
                        "message": "The user is not enabled for live streaming.",
                        "errors": [{
                            "message": "The user is not enabled for live streaming.",
                            "domain": "youtube.liveBroadcast",
                            "reason": "liveStreamingNotEnabled"
                        }]
                    }
                })),
            )
                .into_response()
        }
        async fn delete_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "DELETE /youtube/v3/liveBroadcasts".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: None,
                body: Value::Null,
            });
            axum::http::StatusCode::NO_CONTENT.into_response()
        }

        let logs: RequestLogs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route(
                            "/youtube/v3/liveBroadcasts",
                            post(create_broadcast).delete(delete_broadcast),
                        )
                        .route("/youtube/v3/liveStreams", post(create_stream))
                        .route("/youtube/v3/liveBroadcasts/bind", post(bind_fails))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let mut metadata = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        metadata.title = "Rollback test".to_string();
        let error = prepare_youtube_broadcast(
            YouTubePrepareRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                account_label: "Videorc Channel".to_string(),
                metadata,
                video: VideoSettings {
                    preset: VideoPreset::Stream1080p60,
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    bitrate_kbps: 6000,
                },
                api_base_url: Some(format!("http://{address}")),
                scheduled_start_time: Some("2026-06-03T10:05:00Z".to_string()),
            },
            &reqwest::Client::new(),
            |_, _| Ok(()),
        )
        .await
        .expect_err("bind failure must propagate");

        // The user sees Google's actual reason, not a generic line…
        let message = format!("{error:#}");
        assert!(
            message.contains("liveStreamingNotEnabled"),
            "error should carry Google's reason: {message}"
        );

        // …and the orphaned broadcast is rolled back.
        let logs = logs.lock().unwrap();
        let delete = logs
            .iter()
            .find(|log| log.path == "DELETE /youtube/v3/liveBroadcasts")
            .expect("failed bind must delete the created broadcast");
        assert!(
            delete.query.contains("id=broadcast-123"),
            "{}",
            delete.query
        );
    }

    #[tokio::test]
    async fn prepares_youtube_broadcast_and_stores_stream_name_as_secret() {
        async fn create_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body,
            });
            Json(json!({ "id": "broadcast-123" })).into_response()
        }

        async fn create_stream(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveStreams".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body,
            });
            Json(json!({
                "id": "stream-456",
                "cdn": {
                    "ingestionInfo": {
                        "ingestionAddress": "rtmp://a.rtmp.youtube.com/live2",
                        "streamName": "secret-stream-name"
                    }
                }
            }))
            .into_response()
        }

        async fn bind_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts/bind".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({ "id": "broadcast-123" })).into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/youtube/v3/liveBroadcasts", post(create_broadcast))
                        .route("/youtube/v3/liveStreams", post(create_stream))
                        .route("/youtube/v3/liveBroadcasts/bind", post(bind_broadcast))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let mut metadata = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        metadata.title = "Global title".to_string();
        metadata.description = "Global description".to_string();
        metadata.default_privacy = StreamPrivacy::Public;
        let youtube_override = metadata
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        youtube_override.customize = true;
        youtube_override.title = "YouTube title".to_string();
        youtube_override.description = "YouTube description".to_string();
        youtube_override.privacy = StreamPrivacy::Unlisted;
        youtube_override.youtube_made_for_kids = Some(false);

        let mut stored = Vec::new();
        let prepared = prepare_youtube_broadcast(
            YouTubePrepareRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                account_label: "Videorc Channel".to_string(),
                metadata,
                video: VideoSettings {
                    preset: VideoPreset::Stream1080p60,
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    bitrate_kbps: 6000,
                },
                api_base_url: Some(format!("http://{address}")),
                scheduled_start_time: Some("2026-06-03T10:05:00Z".to_string()),
            },
            &reqwest::Client::new(),
            |secret_ref, value| {
                stored.push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(prepared.broadcast_id, "broadcast-123");
        assert_eq!(prepared.stream_id, "stream-456");
        assert_eq!(prepared.server_url, "rtmp://a.rtmp.youtube.com/live2");
        assert_eq!(
            prepared.stream_key_secret_ref,
            "platform:youtube:UC123:stream-key"
        );
        assert_eq!(
            prepared.redacted_url,
            "rtmp://<youtube-ingest>/<stream-key>"
        );
        assert_eq!(prepared.title, "YouTube title");
        assert_eq!(prepared.description, "YouTube description");
        assert_eq!(prepared.privacy, StreamPrivacy::Unlisted);
        assert_eq!(
            serde_json::to_string(&prepared)
                .unwrap()
                .contains("secret-stream-name"),
            false
        );
        assert_eq!(
            stored,
            vec![(
                "platform:youtube:UC123:stream-key".to_string(),
                "secret-stream-name".to_string()
            )]
        );

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 3);
        assert!(
            logs.iter()
                .all(|request| request.authorization.as_deref() == Some("Bearer access-token"))
        );
        assert_eq!(logs[0].path, "/youtube/v3/liveBroadcasts");
        assert_eq!(logs[0].query, "part=snippet%2Cstatus%2CcontentDetails");
        // Low latency is the product default: YouTube's "normal" mode buffers 30-60s.
        assert_eq!(logs[0].body["contentDetails"]["latencyPreference"], "low");
        assert_eq!(logs[0].body["contentDetails"]["enableAutoStart"], true);
        assert_eq!(
            logs[0].body["contentDetails"]["monitorStream"]["enableMonitorStream"],
            false
        );
        assert_eq!(logs[0].body["snippet"]["title"], "YouTube title");
        assert_eq!(
            logs[0].body["snippet"]["description"],
            "YouTube description"
        );
        assert_eq!(logs[0].body["status"]["privacyStatus"], "unlisted");
        assert_eq!(logs[0].body["status"]["selfDeclaredMadeForKids"], false);
        assert_eq!(logs[1].path, "/youtube/v3/liveStreams");
        assert_eq!(
            logs[1].query,
            "part=snippet%2Ccdn%2CcontentDetails%2Cstatus"
        );
        assert_eq!(logs[1].body["cdn"]["ingestionType"], "rtmp");
        assert_eq!(logs[1].body["cdn"]["resolution"], "1080p");
        assert_eq!(logs[1].body["cdn"]["frameRate"], "60fps");
        assert_eq!(logs[2].path, "/youtube/v3/liveBroadcasts/bind");
        assert_eq!(
            logs[2].query,
            "id=broadcast-123&part=id%2CcontentDetails&streamId=stream-456"
        );
    }

    #[tokio::test]
    async fn transitions_youtube_broadcast_without_request_body() {
        async fn transition_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts/transition".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "id": "broadcast-123",
                "status": {
                    "lifeCycleStatus": "live"
                }
            }))
            .into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route(
                            "/youtube/v3/liveBroadcasts/transition",
                            post(transition_broadcast),
                        )
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = transition_youtube_broadcast(
            YouTubeBroadcastTransitionRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                broadcast_id: "broadcast-123".to_string(),
                status: YouTubeBroadcastTransitionStatus::Live,
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(result.platform, StreamPlatform::Youtube);
        assert_eq!(result.account_id, "UC123");
        assert_eq!(result.broadcast_id, "broadcast-123");
        assert_eq!(
            result.requested_status,
            YouTubeBroadcastTransitionStatus::Live
        );
        assert_eq!(result.lifecycle_status.as_deref(), Some("live"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].path, "/youtube/v3/liveBroadcasts/transition");
        assert_eq!(
            logs[0].query,
            "broadcastStatus=live&id=broadcast-123&part=id%2Cstatus"
        );
        assert_eq!(
            logs[0].authorization.as_deref(),
            Some("Bearer access-token")
        );
        assert_eq!(logs[0].body, Value::Null);
    }

    #[tokio::test]
    async fn waits_for_live_starting_to_confirm_live() {
        async fn transition_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts/transition".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "id": "broadcast-123",
                "status": {
                    "lifeCycleStatus": "liveStarting"
                }
            }))
            .into_response()
        }
        async fn list_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "items": [{
                    "id": "broadcast-123",
                    "status": {
                        "lifeCycleStatus": "live"
                    }
                }]
            }))
            .into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route(
                            "/youtube/v3/liveBroadcasts/transition",
                            post(transition_broadcast),
                        )
                        .route("/youtube/v3/liveBroadcasts", get(list_broadcast))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = transition_youtube_broadcast(
            YouTubeBroadcastTransitionRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                broadcast_id: "broadcast-123".to_string(),
                status: YouTubeBroadcastTransitionStatus::Live,
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(result.broadcast_id, "broadcast-123");
        assert_eq!(result.lifecycle_status.as_deref(), Some("live"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].path, "/youtube/v3/liveBroadcasts/transition");
        assert_eq!(logs[1].path, "/youtube/v3/liveBroadcasts");
        assert_eq!(logs[1].query, "part=status&id=broadcast-123");
    }

    #[tokio::test]
    async fn treats_redundant_youtube_transition_as_successful_noop() {
        async fn transition_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts/transition".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": {
                        "errors": [{
                            "reason": "redundantTransition"
                        }],
                        "message": "Invalid transition"
                    }
                })),
            )
                .into_response()
        }
        async fn list_broadcast(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveBroadcasts".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "items": [{
                    "id": "broadcast-123",
                    "status": {
                        "lifeCycleStatus": "complete"
                    }
                }]
            }))
            .into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route(
                            "/youtube/v3/liveBroadcasts/transition",
                            post(transition_broadcast),
                        )
                        .route("/youtube/v3/liveBroadcasts", get(list_broadcast))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = transition_youtube_broadcast(
            YouTubeBroadcastTransitionRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                broadcast_id: "broadcast-123".to_string(),
                status: YouTubeBroadcastTransitionStatus::Complete,
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(result.broadcast_id, "broadcast-123");
        assert_eq!(
            result.requested_status,
            YouTubeBroadcastTransitionStatus::Complete
        );
        assert_eq!(result.lifecycle_status.as_deref(), Some("complete"));
        assert!(result.message.contains("already complete"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(
            logs[0].query,
            "broadcastStatus=complete&id=broadcast-123&part=id%2Cstatus"
        );
        assert_eq!(logs[1].path, "/youtube/v3/liveBroadcasts");
        assert_eq!(logs[1].query, "part=status&id=broadcast-123");
    }

    #[tokio::test]
    async fn rejects_youtube_transition_when_lifecycle_does_not_match_requested_status() {
        async fn transition_broadcast() -> impl axum::response::IntoResponse {
            Json(json!({
                "id": "broadcast-123",
                "status": {
                    "lifeCycleStatus": "testing"
                }
            }))
            .into_response()
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/youtube/v3/liveBroadcasts/transition",
                    post(transition_broadcast),
                ),
            )
            .await
            .unwrap();
        });

        let error = transition_youtube_broadcast(
            YouTubeBroadcastTransitionRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                broadcast_id: "broadcast-123".to_string(),
                status: YouTubeBroadcastTransitionStatus::Live,
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .expect_err("transition must not report live until YouTube confirms live");

        assert!(error.to_string().contains("did not reach live"));
        assert!(error.to_string().contains("testing"));
    }

    #[tokio::test]
    async fn fetches_youtube_stream_status_for_active_ingest() {
        async fn stream_status(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/liveStreams".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "items": [{
                    "id": "stream-456",
                    "status": {
                        "streamStatus": "active",
                        "healthStatus": {
                            "status": "good"
                        }
                    }
                }]
            }))
            .into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/youtube/v3/liveStreams", get(stream_status))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = get_youtube_stream_status(
            YouTubeStreamStatusRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                stream_id: "stream-456".to_string(),
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(result.platform, StreamPlatform::Youtube);
        assert_eq!(result.account_id, "UC123");
        assert_eq!(result.stream_id, "stream-456");
        assert_eq!(result.stream_status.as_deref(), Some("active"));
        assert_eq!(result.health_status.as_deref(), Some("good"));
        assert!(result.active);

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].path, "/youtube/v3/liveStreams");
        assert_eq!(logs[0].query, "part=status&id=stream-456");
        assert_eq!(
            logs[0].authorization.as_deref(),
            Some("Bearer access-token")
        );
    }

    #[tokio::test]
    async fn lists_authenticated_youtube_channels() {
        async fn channels(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                path: "/youtube/v3/channels".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "items": [
                    {
                        "id": "UC123",
                        "snippet": {
                            "title": "Main Channel",
                            "customUrl": "@main",
                            "thumbnails": {
                                "medium": { "url": "https://yt.example/main-medium.jpg" },
                                "high": { "url": "https://yt.example/main-high.jpg" }
                            }
                        }
                    },
                    {
                        "id": "UC456",
                        "snippet": {
                            "title": "Brand Channel",
                            "thumbnails": {
                                "default": { "url": "https://yt.example/brand.jpg" }
                            }
                        }
                    }
                ]
            }))
            .into_response()
        }

        let logs = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let logs = logs.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/youtube/v3/channels", get(channels))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = list_youtube_channels(
            YouTubeChannelListRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(result.platform, StreamPlatform::Youtube);
        assert_eq!(result.account_id, "UC123");
        assert_eq!(result.channels.len(), 2);
        assert_eq!(result.channels[0].channel_id, "UC123");
        assert_eq!(result.channels[0].title, "Main Channel");
        assert_eq!(result.channels[0].handle.as_deref(), Some("@main"));
        assert_eq!(
            result.channels[0].avatar_url.as_deref(),
            Some("https://yt.example/main-high.jpg")
        );
        assert_eq!(result.channels[1].channel_id, "UC456");
        assert_eq!(
            result.channels[1].avatar_url.as_deref(),
            Some("https://yt.example/brand.jpg")
        );

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].path, "/youtube/v3/channels");
        assert_eq!(logs[0].query, "part=snippet&mine=true&maxResults=50");
        assert_eq!(
            logs[0].authorization.as_deref(),
            Some("Bearer access-token")
        );
    }

    #[test]
    fn youtube_error_detail_surfaces_google_reason_and_message() {
        let body = r#"{"error":{"code":403,"message":"The user is not enabled for live streaming.","errors":[{"message":"The user is not enabled for live streaming.","domain":"youtube.liveBroadcast","reason":"liveStreamingNotEnabled"}]}}"#;
        assert_eq!(
            youtube_error_detail(body),
            "liveStreamingNotEnabled: The user is not enabled for live streaming."
        );

        // Non-JSON bodies degrade to a truncated raw snippet, never an empty message.
        assert_eq!(
            youtube_error_detail("<html>boom</html>"),
            "<html>boom</html>"
        );
        assert_eq!(youtube_error_detail("  "), "no error body");
    }

    #[test]
    fn detects_youtube_access_token_auth_errors() {
        assert!(is_youtube_auth_error(&anyhow::anyhow!(
            "YouTube channel list request failed (401 Unauthorized): authError: Invalid Credentials"
        )));
        assert!(is_youtube_auth_error(&anyhow::anyhow!(
            "YouTube broadcast status request failed (401 Unauthorized): UNAUTHENTICATED: Request had invalid authentication credentials."
        )));
        assert!(!is_youtube_auth_error(&anyhow::anyhow!(
            "YouTube broadcast transition failed (403 Forbidden): invalidTransition: Invalid transition"
        )));
        assert!(!is_youtube_auth_error(&anyhow::anyhow!(
            "YouTube profile lookup failed with HTTP 403 Forbidden: quotaExceeded: quota exhausted"
        )));
    }

    #[test]
    fn selects_available_youtube_channel_by_id() {
        let channels = vec![
            YouTubeChannel {
                channel_id: "UC123".to_string(),
                title: "Main Channel".to_string(),
                handle: Some("@main".to_string()),
                avatar_url: None,
            },
            YouTubeChannel {
                channel_id: "UC456".to_string(),
                title: "Brand Channel".to_string(),
                handle: None,
                avatar_url: Some("https://yt.example/brand.jpg".to_string()),
            },
        ];

        let selected = select_youtube_channel(&channels, " UC456 ").unwrap();
        assert_eq!(selected.channel_id, "UC456");
        assert_eq!(selected.title, "Brand Channel");
        assert_eq!(
            selected.avatar_url.as_deref(),
            Some("https://yt.example/brand.jpg")
        );

        let missing = select_youtube_channel(&channels, "UC789").unwrap_err();
        assert!(missing.to_string().contains("not available"));

        let empty = select_youtube_channel(&channels, " ").unwrap_err();
        assert!(empty.to_string().contains("channel ID is required"));
    }

    #[tokio::test]
    async fn youtube_stream_status_errors_when_stream_is_missing() {
        async fn stream_status() -> impl axum::response::IntoResponse {
            Json(json!({ "items": [] })).into_response()
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/youtube/v3/liveStreams", get(stream_status)),
            )
            .await
            .unwrap();
        });

        let error = get_youtube_stream_status(
            YouTubeStreamStatusRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                stream_id: "stream-456".to_string(),
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("not found"));
    }

    #[test]
    fn youtube_metadata_requires_effective_title() {
        let draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        let error = effective_youtube_metadata(&draft).unwrap_err();

        assert!(error.to_string().contains("title"));
    }
}
