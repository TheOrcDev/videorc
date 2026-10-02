use anyhow::{Context, Result, bail};
use chrono::{Duration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration as StdDuration;

use crate::protocol::VideoSettings;
use crate::streaming::{StreamMetadataDraft, StreamPlatform, StreamPrivacy};

const YOUTUBE_TRANSITION_CONFIRM_POLL_ATTEMPTS: usize = 30;
const YOUTUBE_TRANSITION_CONFIRM_POLL_DELAY: StdDuration = StdDuration::from_secs(1);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubePrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The destination this broadcast is prepared for. Scopes the stored
    /// stream key so two YouTube destinations on one channel (horizontal +
    /// vertical simulcast) never overwrite each other's key. Older renderers
    /// send none and keep the account-scoped slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub video: VideoSettings,
}

#[derive(Debug, Clone)]
pub struct YouTubePrepareRequest {
    pub access_token: String,
    pub account_id: String,
    pub account_label: String,
    pub target_id: Option<String>,
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeThumbnailRetryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub broadcast_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum YouTubeThumbnailState {
    Uploaded,
    Error,
}

/// Plan 083: the outcome of setting the Broadcast info thumbnail on an
/// instant broadcast. Emitted as `streamTargets.youtube.thumbnail`; a failure
/// never fails Go Live.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeThumbnailResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub broadcast_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub state: YouTubeThumbnailState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub retryable: bool,
}

impl YouTubeThumbnailResult {
    pub fn new(
        account_id: &str,
        broadcast_id: &str,
        target_id: Option<String>,
        outcome: Result<(), String>,
    ) -> Self {
        let (state, code, message, retryable) = match outcome {
            Ok(()) => (YouTubeThumbnailState::Uploaded, None, None, false),
            Err(code) => {
                let message = youtube_thumbnail_failure_message(&code).to_string();
                // The daily limits only reset after hours; Retry would just fail.
                let retryable = !matches!(
                    code.as_str(),
                    "uploadRateLimitExceeded" | "quotaPaused" | "budgetShed"
                );
                (
                    YouTubeThumbnailState::Error,
                    Some(code),
                    Some(message),
                    retryable,
                )
            }
        };
        Self {
            platform: StreamPlatform::Youtube,
            account_id: account_id.to_string(),
            broadcast_id: broadcast_id.to_string(),
            target_id,
            state,
            code,
            message,
            retryable,
        }
    }
}

/// A bounded code for a failed thumbnail upload: the provider's reason when
/// YouTube gave one, else what went wrong on our side. Never a raw body.
pub fn youtube_thumbnail_failure_code(error: &anyhow::Error) -> String {
    if let Some(rejection) = error.downcast_ref::<crate::scheduled_youtube::YouTubeRejection>() {
        return crate::scheduled_youtube::thumbnail_provider_reason(&rejection.reason)
            .filter(|reason| reason != "uploadDenied")
            .unwrap_or_else(|| {
                if rejection.status == 401 {
                    "reconnect".to_string()
                } else {
                    "thumbnailFailed".to_string()
                }
            });
    }
    if is_youtube_auth_error(error) || error.to_string().contains("Reconnect") {
        return "reconnect".to_string();
    }
    "thumbnailFailed".to_string()
}

/// Which Go Live step a YouTube failure belongs to, for its copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YouTubeFailureStep {
    Prepare,
    TransitionLive,
    TransitionComplete,
}

/// A failed YouTube call as the renderer receives it: a bounded code it can
/// branch on and Videorc copy. Google's message, HTML and raw bodies never
/// reach a toast (plan 094, S2). The quota code lets the renderer treat a
/// failed `complete` as settled and offer the stream-key path at Go Live.
pub fn youtube_failure_response(
    error: &anyhow::Error,
    step: YouTubeFailureStep,
) -> (&'static str, String) {
    use crate::youtube_quota::{YouTubeApiError, YouTubeApiErrorClass, YouTubeQuotaPaused};
    let default_code = match step {
        YouTubeFailureStep::Prepare => "youtube-prepare-failed",
        YouTubeFailureStep::TransitionLive | YouTubeFailureStep::TransitionComplete => {
            "youtube-transition-failed"
        }
    };
    let quota_message = |step: YouTubeFailureStep| match step {
        YouTubeFailureStep::Prepare => {
            "YouTube's daily API limit is used up, so Videorc can't create the YouTube broadcast. Go live on YouTube with your stream key instead."
        }
        YouTubeFailureStep::TransitionLive => {
            "YouTube's daily API limit is used up. YouTube takes the broadcast live on its own when your stream arrives."
        }
        YouTubeFailureStep::TransitionComplete => {
            "YouTube's daily API limit is used up. YouTube ends the broadcast on its own about a minute after you stop."
        }
    };
    if error.downcast_ref::<YouTubeQuotaPaused>().is_some()
        || matches!(
            error.downcast_ref::<crate::youtube_quota::YouTubeNotAttempted>(),
            Some(crate::youtube_quota::YouTubeNotAttempted::Paused)
        )
        || crate::youtube_quota::is_quota_exhausted_error(error)
    {
        return ("youtube-quota-paused", quota_message(step).to_string());
    }
    let Some(api) = error.downcast_ref::<YouTubeApiError>() else {
        if is_youtube_auth_error(error) {
            return (
                default_code,
                "Reconnect YouTube in Destinations, then retry.".to_string(),
            );
        }
        // Videorc's own wording (ingest never active, status never reached…)
        // or a transport failure: nothing from Google is in it.
        return (default_code, format!("{error:#}"));
    };
    let reason = api.reason.as_deref().unwrap_or("");
    let message = match (api.class(), reason) {
        (_, "liveBroadcastNotFound") | (YouTubeApiErrorClass::NotFound, _) => {
            return (
                "youtube-broadcast-not-found",
                "This broadcast no longer exists on YouTube.".to_string(),
            );
        }
        (YouTubeApiErrorClass::AuthExpired, _) => {
            "Reconnect YouTube in Destinations, then retry.".to_string()
        }
        (_, "liveStreamingNotEnabled") => {
            "Live streaming is not enabled for this YouTube channel. Enable it in YouTube Studio, then retry.".to_string()
        }
        (_, "insufficientLivePermissions") | (_, "livePermissionBlocked") => {
            "This YouTube channel can't live stream right now. Check YouTube Studio for the reason.".to_string()
        }
        (_, "invalidTransition") | (_, "errorStreamInactive") => {
            "YouTube refused the transition because the stream isn't active yet. Wait for ingest, then retry.".to_string()
        }
        (YouTubeApiErrorClass::RateLimited, _) => {
            "YouTube is rate limiting Videorc. Try again in a moment.".to_string()
        }
        (YouTubeApiErrorClass::Forbidden, _) => {
            "YouTube refused this request for the connected account. Check the channel's live streaming permissions in YouTube Studio.".to_string()
        }
        (YouTubeApiErrorClass::Transient, _) => {
            format!("YouTube answered HTTP {}. Try again in a moment.", api.status)
        }
        _ => {
            let safe: String = reason
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(80)
                .collect();
            if safe.is_empty() {
                format!("YouTube rejected the request (HTTP {}).", api.status)
            } else {
                format!("YouTube rejected the request ({safe}).")
            }
        }
    };
    (default_code, message)
}

pub fn youtube_thumbnail_failure_message(code: &str) -> &'static str {
    match code {
        "forbidden" => {
            "YouTube refused the thumbnail. Check that custom thumbnails are enabled for this channel in YouTube Studio."
        }
        "uploadRateLimitExceeded" => {
            "YouTube's daily thumbnail limit is reached for this channel. The stream goes on without it."
        }
        "invalidImage" | "mediaBodyRequired" | "uploadTooLarge" => {
            "YouTube could not read this image. Choose another JPEG or PNG."
        }
        "thumbnailUnavailable" => "Thumbnail is unavailable. Pick it again.",
        "reconnect" => "Reconnect YouTube in Destinations, then retry.",
        "quotaPaused" => {
            "YouTube's daily API limit is used up, so the thumbnail was not set. The stream is not affected."
        }
        "budgetShed" => {
            "The thumbnail was skipped to save Videorc's daily YouTube limit. The stream is not affected."
        }
        _ => "The thumbnail was not set. The stream is not affected.",
    }
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
    state: &crate::state::AppState,
    request: YouTubePrepareRequest,
    client: &reqwest::Client,
    put_secret: impl FnOnce(&str, &str) -> Result<()>,
) -> Result<PreparedYouTubeBroadcast> {
    let metadata = effective_youtube_metadata(&request.metadata)?;
    let stream_key_secret_ref =
        youtube_stream_key_secret_ref(&request.account_id, request.target_id.as_deref())?;
    let scheduled_start_time = request.scheduled_start_time.unwrap_or_else(|| {
        (Utc::now() + Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    });
    let base_url = crate::youtube_quota::youtube_api_base_url(request.api_base_url.as_deref());

    let broadcast_response = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsInsert,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client
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
            })),
    )
    .await
    .context("Could not create YouTube broadcast.")?;
    let broadcast: YouTubeIdResponse = require_youtube_success(
        state,
        broadcast_response,
        "YouTube broadcast creation failed",
    )
    .await?
    .json()
    .await
    .context("Could not parse YouTube broadcast response.")?;

    // From here on a failure must roll back what was already created on the
    // channel; otherwise every failed Go Live leaves an orphaned scheduled
    // broadcast behind in YouTube Studio.
    let stream_and_bind = async {
        let stream_response = crate::youtube_quota::send_attempt(
            state,
            crate::youtube_quota::YouTubeEndpoint::LiveStreamsInsert,
            crate::youtube_quota::BudgetCall::GoLiveEssential,
            client,
            client
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
                        // A portrait (vertical simulcast) profile is named by its
                        // SHORT side like its landscape twin: 1080x1920 is "1080p",
                        // not the "2160p" its height alone would select.
                        "resolution": youtube_resolution(
                            request.video.height.min(request.video.width),
                        ),
                    },
                    "contentDetails": {
                        "isReusable": true,
                    },
                })),
        )
        .await
        .context("Could not create YouTube stream.")?;
        let live_stream: YouTubeLiveStreamResponse =
            require_youtube_success(state, stream_response, "YouTube stream creation failed")
                .await?
                .json()
                .await
                .context("Could not parse YouTube stream response.")?;

        let bind_response = crate::youtube_quota::send_attempt(
            state,
            crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsBind,
            crate::youtube_quota::BudgetCall::GoLiveEssential,
            client,
            client
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
                .body(""),
        )
        .await
        .context("Could not bind YouTube broadcast to stream.")?;
        let _bound: YouTubeIdResponse =
            require_youtube_success(state, bind_response, "YouTube broadcast bind failed")
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
                state,
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
    state: &crate::state::AppState,
    request: YouTubeChannelListRequest,
    client: &reqwest::Client,
) -> Result<YouTubeChannelListResult> {
    let base_url = crate::youtube_quota::youtube_api_base_url(request.api_base_url.as_deref());
    let channels_response = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::ChannelsList,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client
            .get(youtube_api_url(
                &base_url,
                "/youtube/v3/channels",
                &[("part", "snippet"), ("mine", "true"), ("maxResults", "50")],
            )?)
            .bearer_auth(&request.access_token),
    )
    .await
    .context("Could not fetch YouTube channels.")?;
    let response: YouTubeChannelListResponse = require_youtube_success(
        state,
        channels_response,
        "YouTube channel list request failed",
    )
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
    state: &crate::state::AppState,
    request: YouTubeStreamStatusRequest,
    client: &reqwest::Client,
) -> Result<YouTubeStreamStatusResult> {
    if request.stream_id.trim().is_empty() {
        anyhow::bail!("A YouTube stream ID is required.");
    }

    let base_url = crate::youtube_quota::youtube_api_base_url(request.api_base_url.as_deref());
    let status_response = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveStreamsList,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client
            .get(youtube_api_url(
                &base_url,
                "/youtube/v3/liveStreams",
                &[("part", "status"), ("id", request.stream_id.as_str())],
            )?)
            .bearer_auth(&request.access_token),
    )
    .await
    .context("Could not fetch YouTube stream status.")?;
    let response: YouTubeLiveStreamListResponse = require_youtube_success(
        state,
        status_response,
        "YouTube stream status request failed",
    )
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
    state: &crate::state::AppState,
    request: YouTubeBroadcastTransitionRequest,
    client: &reqwest::Client,
) -> Result<YouTubeBroadcastTransitionResult> {
    if request.broadcast_id.trim().is_empty() {
        anyhow::bail!("A YouTube broadcast ID is required.");
    }

    let base_url = crate::youtube_quota::youtube_api_base_url(request.api_base_url.as_deref());
    let status = youtube_transition_status(request.status);
    let response = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsTransition,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client
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
            .body(""),
    )
    .await
    .context("Could not transition YouTube broadcast.")?;

    if !response.status().is_success() {
        let status_code = response.status();
        let body = response.text().await.unwrap_or_default();
        if body.contains("redundantTransition") {
            let lifecycle_status = get_youtube_broadcast_lifecycle_status(
                state,
                client,
                &base_url,
                &request.access_token,
                &request.broadcast_id,
            )
            .await?;
            let lifecycle_status = confirm_youtube_lifecycle_status(
                state,
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
        // Typed (plan 094, S2): the caller maps reason/domain to Videorc copy
        // and never forwards Google's message or HTML.
        return Err(crate::youtube_quota::YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            status_code,
            &body,
        )
        .into());
    }

    let response: YouTubeBroadcastTransitionResponse = response
        .json()
        .await
        .context("Could not parse YouTube broadcast transition response.")?;
    let lifecycle_status = confirm_youtube_lifecycle_status(
        state,
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
    state: &crate::state::AppState,
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    broadcast_id: &str,
) -> Result<Option<String>> {
    let response = crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsList,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client
            .get(youtube_api_url(
                base_url,
                "/youtube/v3/liveBroadcasts",
                &[("part", "status"), ("id", broadcast_id)],
            )?)
            .bearer_auth(access_token),
    )
    .await
    .context("Could not fetch YouTube broadcast status.")?;
    let response: YouTubeLiveBroadcastListResponse =
        require_youtube_success(state, response, "YouTube broadcast status request failed")
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
    state: &crate::state::AppState,
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
        latest_status = get_youtube_broadcast_lifecycle_status(
            state,
            client,
            base_url,
            access_token,
            broadcast_id,
        )
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
    state: &crate::state::AppState,
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
    match crate::youtube_quota::send_attempt(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsDelete,
        crate::youtube_quota::BudgetCall::GoLiveEssential,
        client,
        client.delete(url).bearer_auth(access_token),
    )
    .await
    {
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
            state.emit_log("warn", format!("YouTube broadcast {id} could not be cleaned up after preparation failed. It may remain in YouTube Studio; remove it after API access resumes."));
            tracing::warn!("YouTube rollback delete for {path} failed: {error}");
        }
    }
}

/// Replace `error_for_status` for YouTube API calls: Google puts the actionable
/// reason (liveStreamingNotEnabled, insufficientLivePermissions, quota…) in the
/// error BODY, and dropping it leaves the user with an unfixable generic message.
async fn require_youtube_success(
    state: &crate::state::AppState,
    response: reqwest::Response,
    action: &str,
) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    // Typed (plan 094): callers classify quota/auth/permissions from the
    // reason and domain, and the Display keeps the historical text shape.
    let error = crate::youtube_quota::YouTubeApiError::from_body(action, status, &body).into();
    crate::youtube_quota::note_error(state, action, &error);
    Err(error)
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

pub(crate) fn youtube_frame_rate(fps: u32) -> &'static str {
    if fps > 30 { "60fps" } else { "30fps" }
}

/// The secret slot a prepared broadcast's stream key is stored in. Scoped per
/// DESTINATION when the renderer names one: every prepare creates its own
/// broadcast + liveStream, so an account-scoped slot let the last prepare win
/// and both destinations of a dual-orientation session pushed to one key
/// (YouTube: "More than one ingestion is using the primary URL"). Without a
/// target id the legacy account-scoped slot is kept.
pub fn youtube_stream_key_secret_ref(account_id: &str, target_id: Option<&str>) -> Result<String> {
    let Some(target_id) = target_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(format!("platform:youtube:{account_id}:stream-key"));
    };
    if !target_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        bail!("Stream target id is invalid.");
    }
    Ok(format!(
        "platform:youtube:{account_id}:target:{target_id}:stream-key"
    ))
}

pub(crate) fn youtube_resolution(height: u32) -> &'static str {
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
    fn test_quota_state() -> crate::state::AppState {
        crate::state::AppState::new(
            "test".into(),
            1234,
            tokio::sync::broadcast::channel(64).0,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }
    use crate::protocol::{VideoPreset, VideoSettings};
    use crate::streaming::{StreamPrivacy, default_stream_metadata_draft};

    #[test]
    fn thumbnail_failures_map_to_codes_and_user_copy() {
        use crate::scheduled_youtube::YouTubeRejection;
        let rejection = |status, reason: &str| {
            anyhow::Error::new(YouTubeRejection {
                status,
                reason: reason.to_string(),
            })
        };
        assert_eq!(
            youtube_thumbnail_failure_code(&rejection(403, "thumbnailForbidden")),
            "forbidden"
        );
        assert_eq!(
            youtube_thumbnail_failure_code(&rejection(429, "thumbnailUploadRateLimitExceeded")),
            "uploadRateLimitExceeded"
        );
        assert_eq!(
            youtube_thumbnail_failure_code(&rejection(401, "thumbnailUploadDenied")),
            "reconnect"
        );
        assert_eq!(
            youtube_thumbnail_failure_code(&rejection(500, "thumbnailUploadDenied")),
            "thumbnailFailed"
        );
        assert_eq!(
            youtube_thumbnail_failure_code(&anyhow::anyhow!(
                "Reconnect the exact scheduled channel."
            )),
            "reconnect"
        );
        assert_eq!(
            youtube_thumbnail_failure_code(&anyhow::anyhow!("connection reset")),
            "thumbnailFailed"
        );

        assert!(youtube_thumbnail_failure_message("forbidden").contains("YouTube Studio"));
        assert!(youtube_thumbnail_failure_message("invalidImage").contains("another JPEG or PNG"));
        assert_eq!(
            youtube_thumbnail_failure_message("thumbnailUnavailable"),
            "Thumbnail is unavailable. Pick it again."
        );
        assert_eq!(
            youtube_thumbnail_failure_message("anythingElse"),
            "The thumbnail was not set. The stream is not affected."
        );
    }

    #[test]
    fn thumbnail_result_is_retryable_except_at_the_daily_limit_and_has_no_null_keys() {
        let uploaded = YouTubeThumbnailResult::new("acct", "b1", None, Ok(()));
        let json = serde_json::to_value(&uploaded).unwrap();
        assert_eq!(json["state"], "uploaded");
        for key in ["targetId", "code", "message"] {
            assert!(json.get(key).is_none(), "{key} must be absent, never null");
        }

        let forbidden = YouTubeThumbnailResult::new(
            "acct",
            "b1",
            Some("youtube".into()),
            Err("forbidden".into()),
        );
        assert_eq!(forbidden.state, YouTubeThumbnailState::Error);
        assert!(forbidden.retryable);
        assert_eq!(
            serde_json::to_value(&forbidden).unwrap()["targetId"],
            "youtube"
        );

        let limited =
            YouTubeThumbnailResult::new("acct", "b1", None, Err("uploadRateLimitExceeded".into()));
        assert!(!limited.retryable);
    }

    #[derive(Debug, Clone)]
    struct RequestLog {
        path: String,
        query: String,
        authorization: Option<String>,
        body: Value,
    }

    type RequestLogs = Arc<Mutex<Vec<RequestLog>>>;

    #[tokio::test]
    async fn prepare_counts_only_attempted_steps_and_quota_prevents_rollback_traffic() {
        for (reject_first, quota_failure, expected_calls, expected_units) in [
            (true, false, 1, 50),
            (false, false, 3, 150),
            (false, true, 2, 100),
        ] {
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let captured = calls.clone();
            let app = Router::new().fallback(move |request: axum::extract::Request| {
                let calls = captured.clone();
                async move {
                    let attempt = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if request.method() == reqwest::Method::DELETE { return StatusCode::NO_CONTENT.into_response(); }
                    if attempt == 0 && !reject_first { return Json(json!({"id":"created-broadcast"})).into_response(); }
                    (StatusCode::FORBIDDEN, Json(json!({"error":{"errors":[{"reason": if quota_failure { "quotaExceeded" } else { "forbidden" }}]}}))).into_response()
                }
            });
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let state = test_quota_state();
            let mut metadata = default_stream_metadata_draft("2026-10-02T00:00:00Z".into());
            metadata.title = "fixture".into();
            let error = prepare_youtube_broadcast(
                &state,
                YouTubePrepareRequest {
                    access_token: "fixture".into(),
                    account_id: "channel".into(),
                    account_label: "fixture".into(),
                    target_id: None,
                    metadata,
                    video: VideoSettings {
                        preset: VideoPreset::Stream1080p60,
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        bitrate_kbps: 6000,
                    },
                    api_base_url: Some(base),
                    scheduled_start_time: Some("2026-10-02T00:05:00Z".into()),
                },
                &reqwest::Client::new(),
                |_, _| Ok(()),
            )
            .await
            .unwrap_err();
            assert!(format!("{error:#}").contains(if quota_failure {
                "quotaExceeded"
            } else {
                "forbidden"
            }));
            assert_eq!(
                calls.load(std::sync::atomic::Ordering::SeqCst),
                expected_calls
            );
            let usage = crate::youtube_quota::usage_snapshot(&state);
            assert_eq!(usage.total_calls, expected_calls as u64);
            assert_eq!(usage.total_units, expected_units);
            server.abort();
        }
    }

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
        let quota = test_quota_state();
        let error = prepare_youtube_broadcast(
            &quota,
            YouTubePrepareRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                account_label: "Videorc Channel".to_string(),
                target_id: None,
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
        assert_eq!(
            crate::youtube_quota::usage_snapshot(&quota).total_units,
            200
        );
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

    #[test]
    fn stream_key_secret_ref_is_scoped_per_destination() {
        // Legacy renderers (no target id) keep the account-scoped slot.
        assert_eq!(
            youtube_stream_key_secret_ref("UC123", None).unwrap(),
            "platform:youtube:UC123:stream-key"
        );
        assert_eq!(
            youtube_stream_key_secret_ref("UC123", Some("  ")).unwrap(),
            "platform:youtube:UC123:stream-key"
        );
        // Two destinations on ONE channel never share a slot: the 2026-09-21
        // dual-orientation incident pushed both legs to a single key.
        let horizontal = youtube_stream_key_secret_ref("UC123", Some("youtube")).unwrap();
        let vertical = youtube_stream_key_secret_ref("UC123", Some("youtube-vertical")).unwrap();
        assert_eq!(
            horizontal,
            "platform:youtube:UC123:target:youtube:stream-key"
        );
        assert_eq!(
            vertical,
            "platform:youtube:UC123:target:youtube-vertical:stream-key"
        );
        assert_ne!(horizontal, vertical);
        assert!(youtube_stream_key_secret_ref("UC123", Some("../escape")).is_err());
        assert!(youtube_stream_key_secret_ref("UC123", Some("a:b")).is_err());
    }

    #[test]
    fn portrait_profiles_are_named_by_their_short_side() {
        // 1080x1920 is a 1080p broadcast, not the 2160p its height selects.
        assert_eq!(youtube_resolution(1920_u32.min(1080)), "1080p");
        assert_eq!(youtube_resolution(1080_u32.min(1920)), "1080p");
        assert_eq!(youtube_resolution(1280_u32.min(720)), "720p");
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
            &test_quota_state(),
            YouTubePrepareRequest {
                access_token: "access-token".to_string(),
                account_id: "UC123".to_string(),
                account_label: "Videorc Channel".to_string(),
                target_id: None,
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
            &test_quota_state(),
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
                        "lifeCycleStatus": if logs.lock().unwrap().len() < 4 { "liveStarting" } else { "live" }
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

        let quota = test_quota_state();
        let result = transition_youtube_broadcast(
            &quota,
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
        assert_eq!(logs.len(), 4);
        assert_eq!(crate::youtube_quota::usage_snapshot(&quota).total_calls, 4);
        assert_eq!(crate::youtube_quota::usage_snapshot(&quota).total_units, 53);
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
            &test_quota_state(),
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
            &test_quota_state(),
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
            &test_quota_state(),
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
            &test_quota_state(),
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

    /// Plan 094, S2: the owner's Stop toast carried Google's JSON and escaped
    /// HTML. Every failure now maps to a bounded code and Videorc copy.
    #[test]
    fn youtube_failures_map_to_codes_and_videorc_copy_never_googles_text() {
        use crate::youtube_quota::YouTubeApiError;
        let google_html = "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.";
        let owner_body =
            serde_json::json!({ "error": { "code": 403, "message": google_html, "errors": [{
            "message": google_html, "domain": "youtube.quota", "reason": "quotaExceeded"
        }] } })
            .to_string();
        let quota: anyhow::Error = YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            reqwest::StatusCode::FORBIDDEN,
            &owner_body,
        )
        .into();
        let (code, message) =
            youtube_failure_response(&quota, YouTubeFailureStep::TransitionComplete);
        assert_eq!(code, "youtube-quota-paused");
        assert!(message.contains("ends the broadcast on its own"));
        assert!(
            !message.contains('<') && !message.contains('{'),
            "{message}"
        );
        let (code, message) = youtube_failure_response(&quota, YouTubeFailureStep::Prepare);
        assert_eq!(code, "youtube-quota-paused");
        assert!(message.contains("stream key"));
        let (code, message) = youtube_failure_response(&quota, YouTubeFailureStep::TransitionLive);
        assert_eq!(code, "youtube-quota-paused");
        assert!(message.contains("on its own when your stream arrives"));

        let paused: anyhow::Error = crate::youtube_quota::YouTubeQuotaPaused {
            paused_until: chrono::Utc::now(),
        }
        .into();
        assert_eq!(
            youtube_failure_response(&paused, YouTubeFailureStep::Prepare).0,
            "youtube-quota-paused"
        );

        let not_found: anyhow::Error = YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            reqwest::StatusCode::NOT_FOUND,
            r#"{"error":{"errors":[{"reason":"liveBroadcastNotFound","domain":"youtube.liveBroadcast","message":"gone"}]}}"#,
        )
        .into();
        assert_eq!(
            youtube_failure_response(&not_found, YouTubeFailureStep::TransitionComplete),
            (
                "youtube-broadcast-not-found",
                "This broadcast no longer exists on YouTube.".to_string()
            )
        );

        let not_enabled: anyhow::Error = YouTubeApiError::from_body(
            "YouTube broadcast creation failed",
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"errors":[{"reason":"liveStreamingNotEnabled","domain":"youtube.liveBroadcast","message":"The user is not enabled for live streaming."}]}}"#,
        )
        .into();
        let (code, message) = youtube_failure_response(&not_enabled, YouTubeFailureStep::Prepare);
        assert_eq!(code, "youtube-prepare-failed");
        assert!(message.contains("YouTube Studio"));
        assert!(!message.contains("The user is not enabled"));

        let unknown: anyhow::Error = YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"errors":[{"reason":"someNewReason","message":"<b>raw</b>"}]}}"#,
        )
        .into();
        let (_, message) =
            youtube_failure_response(&unknown, YouTubeFailureStep::TransitionComplete);
        assert_eq!(message, "YouTube rejected the request (someNewReason).");

        let auth: anyhow::Error = YouTubeApiError::from_body(
            "YouTube broadcast transition failed",
            reqwest::StatusCode::UNAUTHORIZED,
            "",
        )
        .into();
        assert!(
            youtube_failure_response(&auth, YouTubeFailureStep::TransitionLive)
                .1
                .contains("Reconnect YouTube")
        );
        // Videorc's own wording passes through unchanged.
        let ours = anyhow::anyhow!("YouTube ingest did not become active yet.");
        assert_eq!(
            youtube_failure_response(&ours, YouTubeFailureStep::TransitionLive).1,
            "YouTube ingest did not become active yet."
        );
    }

    #[test]
    fn youtube_rejections_surface_google_reason_and_message() {
        use crate::youtube_quota::YouTubeApiError;
        let body = r#"{"error":{"code":403,"message":"The user is not enabled for live streaming.","errors":[{"message":"The user is not enabled for live streaming.","domain":"youtube.liveBroadcast","reason":"liveStreamingNotEnabled"}]}}"#;
        let error = YouTubeApiError::from_body("Action", reqwest::StatusCode::FORBIDDEN, body);
        assert_eq!(
            error.to_string(),
            "Action (403 Forbidden): liveStreamingNotEnabled: The user is not enabled for live streaming."
        );
        assert_eq!(error.reason.as_deref(), Some("liveStreamingNotEnabled"));

        // Non-JSON bodies degrade to a truncated raw snippet, never an empty message.
        assert_eq!(
            YouTubeApiError::from_body(
                "Action",
                reqwest::StatusCode::BAD_GATEWAY,
                "<html>boom</html>"
            )
            .detail,
            "<html>boom</html>"
        );
        assert_eq!(
            YouTubeApiError::from_body("Action", reqwest::StatusCode::BAD_GATEWAY, "  ").detail,
            "no error body"
        );
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
            &test_quota_state(),
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

    #[test]
    fn youtube_made_for_kids_applies_without_a_custom_title() {
        let mut draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        draft.title = "Global title".to_string();
        draft.description = "Global description".to_string();
        draft.default_privacy = StreamPrivacy::Unlisted;
        let youtube_override = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        youtube_override.customize = false;
        youtube_override.title = "Stale custom title".to_string();
        youtube_override.privacy = StreamPrivacy::Public;
        youtube_override.youtube_made_for_kids = Some(true);

        let effective = effective_youtube_metadata(&draft).unwrap();

        assert_eq!(effective.title, "Global title");
        assert_eq!(effective.description, "Global description");
        assert_eq!(effective.privacy, StreamPrivacy::Unlisted);
        assert!(effective.made_for_kids);
    }
}
