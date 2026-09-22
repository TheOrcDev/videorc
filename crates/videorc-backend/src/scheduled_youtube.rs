//! Small YouTube scheduling requests. Non-idempotent POSTs are never retried.
use crate::scheduled_streams::ScheduledStreamEvent;
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
#[error("YouTube HTTP {status} ({reason})")]
pub struct YouTubeRejection {
    pub status: u16,
    pub reason: String,
}

pub struct YouTubeEvents {
    pub client: Client,
    pub token: String,
    pub base: String,
    pub refresh_context: Option<(
        crate::state::AppState,
        crate::storage::PlatformAccountCredentials,
    )>,
}
impl YouTubeEvents {
    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        read: bool,
    ) -> Result<reqwest::Response> {
        self.send_with_refresh(request, read, || async {
            let Some((state, credential)) = &self.refresh_context else {
                return Ok(None);
            };
            Ok(Some(
                crate::refresh_platform_access_token_after_auth_error(
                    state,
                    credential,
                    &self.client,
                    &anyhow::anyhow!("YouTube HTTP 401"),
                )
                .await?
                .access_token,
            ))
        })
        .await
    }
    async fn send_with_refresh<F, Fut>(
        &self,
        request: reqwest::RequestBuilder,
        read: bool,
        refresh: F,
    ) -> Result<reqwest::Response>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<Option<String>>>,
    {
        let mut token = self.token.clone();
        let mut refreshed = false;
        let mut read_retries = 0;
        loop {
            let response = request
                .try_clone()
                .context("Provider request is not replayable")?
                .bearer_auth(&token)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(_) if read && read_retries < 2 => {
                    read_retries += 1;
                    tokio::time::sleep(Duration::from_millis(200 * read_retries)).await;
                    continue;
                }
                Err(error) => return Err(error).context("YouTube response unknown"),
            };
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && !refreshed {
                refreshed = true;
                if let Some(next_token) = refresh().await? {
                    token = next_token;
                    continue;
                }
            }
            if read
                && read_retries < 2
                && (response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || response.status().is_server_error())
            {
                let delay = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|value| {
                        value.parse::<u64>().ok().or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(value)
                                .ok()
                                .map(|date| {
                                    (date.with_timezone(&chrono::Utc) - chrono::Utc::now())
                                        .num_seconds()
                                        .max(0) as u64
                                })
                        })
                    })
                    .unwrap_or(1);
                // A long provider cooldown is surfaced, never retried early.
                if delay <= 5 {
                    read_retries += 1;
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                    continue;
                }
            }
            return Ok(response);
        }
    }

    pub async fn transition(&self, id: &str, status: &str) -> Result<()> {
        self.request(
            Method::POST,
            "/youtube/v3/liveBroadcasts/transition",
            &[
                ("part", "id,status"),
                ("id", id),
                ("broadcastStatus", status),
            ],
            None,
        )
        .await?;
        for attempt in 0..8 {
            let current = self
                .get(id)
                .await?
                .context("Event missing after transition")?;
            if current
                .pointer("/status/lifeCycleStatus")
                .and_then(Value::as_str)
                == Some(status)
            {
                return Ok(());
            }
            if attempt < 7 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        bail!("YouTube transition not yet confirmed; refresh before retrying.")
    }
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        let url = reqwest::Url::parse_with_params(&format!("{}{}", self.base, path), query)?;
        let mut request = self
            .client
            .request(method.clone(), url)
            .timeout(Duration::from_secs(15));
        if let Some(body) = body {
            request = request.json(&body);
        } else if method == Method::POST {
            request = request
                .header(reqwest::header::CONTENT_LENGTH, "0")
                .body("");
        }
        let response = self.send(request, method == Method::GET).await?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let parsed = response.json::<Value>().await;
        if !status.is_success() {
            let body = parsed.unwrap_or(Value::Null);
            // Only the provider's bounded reason code is retained, never raw
            // bodies, URLs, tokens or ingest credentials.
            let reason = body
                .pointer("/error/errors/0/reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let safe: String = reason
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(80)
                .collect();
            return Err(YouTubeRejection {
                status: status.as_u16(),
                reason: safe,
            }
            .into());
        }
        parsed.context("YouTube response unknown")
    }
    pub async fn get(&self, id: &str) -> Result<Option<Value>> {
        let value = self
            .request(
                Method::GET,
                "/youtube/v3/liveBroadcasts",
                &[("part", "id,snippet,status,contentDetails"), ("id", id)],
                None,
            )
            .await?;
        Ok(value["items"]
            .as_array()
            .and_then(|items| items.first())
            .cloned())
    }
    pub async fn candidates(&self) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut page = String::new();
        for _ in 0..20 {
            let mut query = vec![
                ("part", "id,snippet,status,contentDetails"),
                ("broadcastStatus", "upcoming"),
                ("maxResults", "50"),
            ];
            if !page.is_empty() {
                query.push(("pageToken", &page));
            }
            let response = self
                .request(Method::GET, "/youtube/v3/liveBroadcasts", &query, None)
                .await?;
            if let Some(batch) = response["items"].as_array() {
                items.extend(batch.iter().cloned());
            }
            page = response["nextPageToken"].as_str().unwrap_or("").into();
            if page.is_empty() {
                return Ok(items);
            }
        }
        bail!("Too many upcoming events. Open YouTube Studio to reconcile.")
    }
    pub async fn stream_candidates(&self) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut page = String::new();
        for _ in 0..20 {
            let mut query = vec![
                ("part", "id,snippet,cdn,status"),
                ("mine", "true"),
                ("maxResults", "50"),
            ];
            if !page.is_empty() {
                query.push(("pageToken", &page));
            }
            let response = self
                .request(Method::GET, "/youtube/v3/liveStreams", &query, None)
                .await?;
            if let Some(batch) = response["items"].as_array() {
                items.extend(batch.iter().cloned());
            }
            page = response["nextPageToken"].as_str().unwrap_or("").into();
            if page.is_empty() {
                return Ok(items);
            }
        }
        bail!("Too many ingest streams. Reconcile them in YouTube Studio.")
    }
    pub async fn create(&self, event: &ScheduledStreamEvent) -> Result<Value> {
        self.request(Method::POST,"/youtube/v3/liveBroadcasts",&[("part","snippet,status,contentDetails")],Some(json!({
            "snippet":{"title":event.requested.title,"description":event.requested.description,"scheduledStartTime":event.start_utc},
            "status":{"privacyStatus":event.requested.privacy,"selfDeclaredMadeForKids":event.requested.made_for_kids},
            "contentDetails":{"enableAutoStart":false,"enableAutoStop":false,"monitorStream":{"enableMonitorStream":false},"latencyPreference":"low"}
        }))).await
    }
    pub async fn update(&self, event: &ScheduledStreamEvent, current: &Value) -> Result<Value> {
        // Preserve all writable snippet/status fields. Read-only response fields
        // do not belong in an update. Audience declaration stays immutable in v1.
        let mut snippet = json!({"title":event.requested.title,"description":event.requested.description,"scheduledStartTime":event.start_utc});
        if let Some(end) = current.pointer("/snippet/scheduledEndTime") {
            snippet["scheduledEndTime"] = end.clone();
        }
        if let Some(category) = current.pointer("/snippet/categoryId") {
            snippet["categoryId"] = category.clone();
        }
        let status = json!({"privacyStatus":event.requested.privacy});
        self.request(
            Method::PUT,
            "/youtube/v3/liveBroadcasts",
            &[("part", "snippet,status")],
            Some(json!({"id":event.provider_event_id,"snippet":snippet,"status":status})),
        )
        .await
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.request(
            Method::DELETE,
            "/youtube/v3/liveBroadcasts",
            &[("id", id)],
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn thumbnail(&self, id: &str, path: &std::path::Path, asset_id: &str) -> Result<()> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if format!("{:x}", Sha256::digest(&bytes)) != asset_id {
            bail!("Thumbnail content changed. Pick it again.");
        }
        let format = validate_thumbnail(&bytes)?;
        let url = reqwest::Url::parse_with_params(
            &format!("{}/upload/youtube/v3/thumbnails/set", self.base),
            &[("videoId", id), ("uploadType", "media")],
        )?;
        let result = self
            .send(
                self.client
                    .post(url)
                    .timeout(Duration::from_secs(20))
                    .header(reqwest::header::CONTENT_TYPE, format)
                    .body(bytes),
                false,
            )
            .await?;
        if !result.status().is_success() {
            return Err(YouTubeRejection {
                status: result.status().as_u16(),
                reason: "thumbnailUploadDenied".into(),
            }
            .into());
        }
        Ok(())
    }
    pub async fn create_stream(
        &self,
        event: &ScheduledStreamEvent,
        video: &crate::protocol::VideoSettings,
    ) -> Result<Value> {
        self.request(Method::POST,"/youtube/v3/liveStreams",&[("part","id,snippet,cdn,contentDetails,status")],Some(json!({
            "snippet":{"title":format!("Videorc {}",event.id)},
            "cdn":{"frameRate":crate::youtube::youtube_frame_rate(video.fps),"ingestionType":"rtmp","resolution":crate::youtube::youtube_resolution(video.width.min(video.height))},
            "contentDetails":{"isReusable":true}
        }))).await
    }
    pub async fn stream(&self, id: &str) -> Result<Value> {
        let value = self
            .request(
                Method::GET,
                "/youtube/v3/liveStreams",
                &[("part", "id,snippet,cdn,status"), ("id", id)],
                None,
            )
            .await?;
        value["items"]
            .as_array()
            .and_then(|x| x.first())
            .cloned()
            .context("Ingest stream missing")
    }
    pub async fn bind(&self, id: &str, stream: &str) -> Result<()> {
        self.request(
            Method::POST,
            "/youtube/v3/liveBroadcasts/bind",
            &[
                ("part", "id,contentDetails"),
                ("id", id),
                ("streamId", stream),
            ],
            None,
        )
        .await?;
        Ok(())
    }
}

pub fn lifecycle(value: &Value) -> &'static str {
    match value
        .pointer("/status/lifeCycleStatus")
        .and_then(Value::as_str)
    {
        Some("live" | "liveStarting" | "testing" | "testStarting") => "live",
        Some("complete" | "revoked") => "completed",
        Some("created" | "ready") => "scheduled",
        _ => "unknown",
    }
}
pub fn metadata_snapshot(value: &Value) -> Value {
    json!({"title":value.pointer("/snippet/title"),"description":value.pointer("/snippet/description"),"scheduledStartTime":value.pointer("/snippet/scheduledStartTime"),"privacyStatus":value.pointer("/status/privacyStatus"),"selfDeclaredMadeForKids":value.pointer("/status/selfDeclaredMadeForKids")})
}
pub fn validate_thumbnail(bytes: &[u8]) -> Result<&'static str> {
    if bytes.len() > 2 * 1024 * 1024 {
        bail!("Thumbnail must be at most 2 MB.");
    }
    let format = image::guess_format(bytes).context("Invalid thumbnail image")?;
    if !matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg) {
        bail!("Choose a JPEG or PNG thumbnail.");
    }
    if format == image::ImageFormat::Png && bytes.windows(4).any(|part| part == b"acTL") {
        bail!("Animated thumbnails are not supported.");
    }
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let (width, height) = reader.into_dimensions()?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 20_000_000 {
        bail!("Thumbnail exceeds 20 megapixels.");
    }
    image::load_from_memory_with_format(bytes, format).context("Corrupt thumbnail")?;
    Ok(if format == image::ImageFormat::Png {
        "image/png"
    } else {
        "image/jpeg"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn safe_401_refresh_replays_once_even_for_thumbnail_uploads() {
        use axum::{Router, extract::Request, http::StatusCode};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                if req.headers().get("authorization").unwrap() == "Bearer refreshed" {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            }
        });
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = YouTubeEvents {
            client: Client::new(),
            token: "expired".into(),
            base: format!("http://127.0.0.1:{port}"),
            refresh_context: None,
        };
        let refreshes = AtomicUsize::new(0);
        let result = api
            .send_with_refresh(
                api.client.post(&api.base).body("thumbnail bytes"),
                false,
                || async {
                    refreshes.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("refreshed".into()))
                },
            )
            .await
            .unwrap();
        assert_eq!(result.status(), reqwest::StatusCode::OK);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        let result = api
            .send_with_refresh(api.client.post(&api.base).body("create"), false, || async {
                Ok(Some("still-expired".into()))
            })
            .await
            .unwrap();
        assert_eq!(result.status(), reqwest::StatusCode::UNAUTHORIZED);
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }
}
