use anyhow::{Context, Result};
use chrono::{Duration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::protocol::VideoSettings;
use crate::streaming::{StreamMetadataDraft, StreamPlatform, StreamPrivacy};

const YOUTUBE_API_BASE_URL: &str = "https://www.googleapis.com";

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
struct YouTubeBroadcastStatus {
    life_cycle_status: Option<String>,
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

    let broadcast: YouTubeIdResponse = client
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
            },
        }))
        .send()
        .await
        .context("Could not create YouTube broadcast.")?
        .error_for_status()
        .context("YouTube broadcast creation failed.")?
        .json()
        .await
        .context("Could not parse YouTube broadcast response.")?;

    let live_stream: YouTubeLiveStreamResponse = client
        .post(youtube_api_url(
            &base_url,
            "/youtube/v3/liveStreams",
            &[("part", "snippet,cdn,contentDetails,status")],
        )?)
        .bearer_auth(&request.access_token)
        .json(&json!({
            "snippet": {
                "title": format!("Videogre {}", request.account_label),
                "description": "Created by Videogre",
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
        .context("Could not create YouTube stream.")?
        .error_for_status()
        .context("YouTube stream creation failed.")?
        .json()
        .await
        .context("Could not parse YouTube stream response.")?;

    let _bound: YouTubeIdResponse = client
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
        .send()
        .await
        .context("Could not bind YouTube broadcast to stream.")?
        .error_for_status()
        .context("YouTube broadcast bind failed.")?
        .json()
        .await
        .context("Could not parse YouTube bind response.")?;

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
        .send()
        .await
        .context("Could not transition YouTube broadcast.")?;

    if !response.status().is_success() {
        let status_code = response.status();
        let body = response.text().await.unwrap_or_default();
        if body.contains("redundantTransition") {
            return Ok(YouTubeBroadcastTransitionResult {
                platform: StreamPlatform::Youtube,
                account_id: request.account_id,
                broadcast_id: request.broadcast_id,
                requested_status: request.status,
                lifecycle_status: Some(status.to_string()),
                message: format!("YouTube broadcast already requested transition: {status}."),
            });
        }
        anyhow::bail!("YouTube broadcast transition failed ({status_code}): {body}");
    }

    let response: YouTubeBroadcastTransitionResponse = response
        .json()
        .await
        .context("Could not parse YouTube broadcast transition response.")?;

    Ok(YouTubeBroadcastTransitionResult {
        platform: StreamPlatform::Youtube,
        account_id: request.account_id,
        broadcast_id: response.id,
        requested_status: request.status,
        lifecycle_status: response.status.and_then(|status| status.life_cycle_status),
        message: format!("YouTube broadcast transition requested: {status}."),
    })
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
    use axum::routing::post;
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
                account_label: "Videogre Channel".to_string(),
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
        assert!(result.message.contains("already requested"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(
            logs[0].query,
            "broadcastStatus=complete&id=broadcast-123&part=id%2Cstatus"
        );
    }

    #[test]
    fn youtube_metadata_requires_effective_title() {
        let draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        let error = effective_youtube_metadata(&draft).unwrap_err();

        assert!(error.to_string().contains("title"));
    }
}
