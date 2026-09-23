//! Small X Livestream Scheduling API requests for the scheduler
//! (`/2/broadcasts/scheduled`). Every call is signed with the user's OAuth
//! 1.0a token, exactly like instant X Go Live. Non-idempotent POSTs are never
//! retried; reads retry a bounded number of times.
use crate::scheduled_streams::ScheduledStreamEvent;
use crate::x_live::{self, XLivestreamCredentials, XStreamSource};
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::time::Duration;

/// Name prefix of the dedicated ingest source every X schedule owns. Instant
/// X Go Live never deletes a source with this prefix (see
/// `x_live::x_source_cleanup_ids`).
pub const SCHEDULED_SOURCE_NAME_PREFIX: &str = "Videorc Scheduled ";

#[derive(Debug, thiserror::Error)]
#[error("X HTTP {status} ({reason})")]
pub struct XRejection {
    pub status: u16,
    pub reason: String,
}

pub struct XScheduledBroadcasts {
    pub client: Client,
    pub credentials: XLivestreamCredentials,
    pub base: String,
}

/// The dedicated source name for one scheduled event.
pub fn scheduled_source_name(event_id: &str) -> String {
    format!(
        "{SCHEDULED_SOURCE_NAME_PREFIX}{}",
        event_id.chars().take(8).collect::<String>()
    )
}

/// Decimal-string Unix epoch milliseconds, the only time shape X accepts.
pub fn epoch_ms(rfc3339: &str) -> Result<String> {
    let instant = chrono::DateTime::parse_from_rfc3339(rfc3339).context("Invalid start time")?;
    let ms = instant.timestamp_millis();
    if ms < 0 {
        bail!("Times before 1970 are not schedulable.");
    }
    Ok(ms.to_string())
}

pub fn rfc3339_from_epoch_ms(value: &str) -> Result<String> {
    let ms: i64 = value
        .trim()
        .parse()
        .context("X returned a non-numeric time")?;
    let instant = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .context("X time out of range")?;
    Ok(instant.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Scheduler `state` → Videorc lifecycle.
pub fn lifecycle(value: &Value) -> &'static str {
    match value["state"]
        .as_str()
        .map(|state| state.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("created" | "scheduled") => "scheduled",
        Some("running") => "live",
        Some("ended") => "completed",
        _ => "unknown",
    }
}

/// The fields a user can edit on X, in the shape X returns them.
pub fn metadata_snapshot(value: &Value) -> Value {
    json!({
        "title": value["title"],
        "description": value["description"],
        "scheduledStartMs": value["scheduled_start_ms"],
        "scheduledEndMs": value["scheduled_end_ms"],
        "thumbnailMediaId": value["thumbnail_media_id"],
        "availableForReplay": value["available_for_replay"]
    })
}

pub fn share_url(broadcast_id: &str) -> String {
    format!("https://x.com/i/broadcasts/{broadcast_id}")
}

/// Unwraps the `data` (v2) or `broadcast` (producer) envelope.
pub fn payload(value: &Value) -> &Value {
    if value.get("data").is_some_and(|data| data.is_object()) {
        &value["data"]
    } else if value.get("broadcast").is_some_and(|data| data.is_object()) {
        &value["broadcast"]
    } else {
        value
    }
}

/// Body of `POST /2/broadcasts/scheduled`. `manual_publish` is always true:
/// Videorc, never a timer, starts the broadcast.
pub fn create_body(
    event: &ScheduledStreamEvent,
    thumbnail_media_id: Option<&str>,
) -> Result<Value> {
    let ingest = event
        .ingest
        .as_ref()
        .context("This broadcast has no ingest source yet.")?;
    let mut body = json!({
        "source_id": ingest.source_id,
        "scheduled_start_ms": epoch_ms(&event.start_utc)?,
        "scheduled_end_ms": event.planned_end_utc()?.timestamp_millis().to_string(),
        "title": event.requested.title,
        "description": event.requested.description,
        "manual_publish": true,
        "available_for_replay": event.requested.available_for_replay.unwrap_or(true),
        "chat_option": x_live::default_chat_option().to_string(),
        "locale": x_live::default_publish_locale(),
    });
    if let Some(media) = thumbnail_media_id.or(event.thumbnail_media_id.as_deref()) {
        body["thumbnail_media_id"] = json!(media);
    }
    Ok(body)
}

/// Body of `PUT /2/broadcasts/scheduled/{id}`. X fully replaces the schedule,
/// so every field the user did not touch is copied from `current`.
pub fn update_body(
    event: &ScheduledStreamEvent,
    current: &Value,
    thumbnail_media_id: Option<&str>,
) -> Result<Value> {
    let schedule_id = current["scheduled_broadcast_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .context("X schedule id missing; refresh the broadcast before editing.")?;
    let source_id = current["source_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| event.ingest.as_ref().map(|ingest| ingest.source_id.clone()))
        .context("This broadcast has no ingest source.")?;
    let mut body = json!({
        "scheduled_broadcast_id": schedule_id,
        "source_id": source_id,
        "scheduled_start_ms": epoch_ms(&event.start_utc)?,
        "scheduled_end_ms": event.planned_end_utc()?.timestamp_millis().to_string(),
        "title": event.requested.title,
        "description": event.requested.description,
        "manual_publish": true,
        "available_for_replay": event
            .requested
            .available_for_replay
            .or_else(|| current["available_for_replay"].as_bool())
            .unwrap_or(true),
        "chat_option": current["chat_option"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| x_live::default_chat_option().to_string()),
        "locale": current["locale"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(x_live::default_publish_locale),
    });
    for key in ["telecast_id", "is_locked"] {
        if let Some(value) = current.get(key).filter(|value| !value.is_null()) {
            body[key] = value.clone();
        }
    }
    if let Some(media) = thumbnail_media_id
        .or(event.thumbnail_media_id.as_deref())
        .or(current["thumbnail_media_id"].as_str())
        .filter(|media| !media.is_empty())
    {
        body["thumbnail_media_id"] = json!(media);
    }
    Ok(body)
}

fn bounded_reason(body: &str) -> String {
    x_live::x_error_detail(body)
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
        .take(80)
        .collect::<String>()
        .trim()
        .to_string()
}

impl XScheduledBroadcasts {
    fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<Url> {
        let mut url = Url::parse(&format!("{}{}", self.base.trim_end_matches('/'), path))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }

    async fn send(&self, method: Method, url: Url, body: Option<Value>) -> Result<Value> {
        let read = method == Method::GET;
        let mut read_retries = 0;
        loop {
            let mut request = self.signed(method.clone(), &url)?;
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(_) if read && read_retries < 2 => {
                    read_retries += 1;
                    tokio::time::sleep(Duration::from_millis(200 * read_retries)).await;
                    continue;
                }
                Err(error) => return Err(error).context("X response unknown"),
            };
            let status = response.status();
            if read
                && read_retries < 2
                && (status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
            {
                read_retries += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            return finish(response).await;
        }
    }

    /// One multipart POST. Never retried: the form is consumed by the request.
    async fn send_form(&self, url: Url, form: reqwest::multipart::Form) -> Result<Value> {
        let response = self
            .signed(Method::POST, &url)?
            .multipart(form)
            .send()
            .await
            .context("X response unknown")?;
        finish(response).await
    }

    fn signed(&self, method: Method, url: &Url) -> Result<reqwest::RequestBuilder> {
        let authorization = x_live::oauth1_authorization_header(
            method.as_str(),
            url.as_str(),
            &self.credentials,
            &x_live::oauth_nonce(),
            x_live::oauth_timestamp(),
        )?;
        Ok(self
            .client
            .request(method, url.clone())
            .timeout(Duration::from_secs(20))
            .header("Authorization", authorization))
    }

    async fn optional(&self, path: &str) -> Result<Option<Value>> {
        match self.send(Method::GET, self.url(path, &[])?, None).await {
            Ok(value) => Ok(Some(value)),
            Err(error)
                if error
                    .downcast_ref::<XRejection>()
                    .is_some_and(|rejection| rejection.status == 404) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn get(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .optional(&format!("/2/broadcasts/scheduled/{id}"))
            .await?
            .map(|value| payload(&value).clone()))
    }
    /// Owned schedules, one page of 100. The response carries no pagination
    /// token, so more than that asks the user to reconcile on X.
    pub async fn list(&self) -> Result<Vec<Value>> {
        let value = self
            .send(
                Method::GET,
                self.url("/2/broadcasts/scheduled", &[("max_results", "100")])?,
                None,
            )
            .await?;
        let items = value["data"].as_array().cloned().unwrap_or_default();
        if items.len() >= 100 {
            bail!("Too many scheduled broadcasts. Reconcile them on X.");
        }
        Ok(items)
    }
    pub async fn create(
        &self,
        event: &ScheduledStreamEvent,
        thumbnail_media_id: Option<&str>,
    ) -> Result<Value> {
        let value = self
            .send(
                Method::POST,
                self.url("/2/broadcasts/scheduled", &[])?,
                Some(create_body(event, thumbnail_media_id)?),
            )
            .await?;
        Ok(payload(&value).clone())
    }
    pub async fn update(
        &self,
        event: &ScheduledStreamEvent,
        current: &Value,
        thumbnail_media_id: Option<&str>,
    ) -> Result<Value> {
        let id = event
            .provider_event_id
            .as_deref()
            .context("Schedule this draft first.")?;
        let value = self
            .send(
                Method::PUT,
                self.url(&format!("/2/broadcasts/scheduled/{id}"), &[])?,
                Some(update_body(event, current, thumbnail_media_id)?),
            )
            .await?;
        Ok(payload(&value).clone())
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        let value = self
            .send(
                Method::DELETE,
                self.url(&format!("/2/broadcasts/scheduled/{id}"), &[])?,
                None,
            )
            .await?;
        if payload(&value)["deleted"].as_bool() == Some(false) {
            bail!("X did not delete the scheduled broadcast.");
        }
        Ok(())
    }
    /// `POST /2/broadcasts/scheduled/{id}/live`: only valid for a
    /// `manual_publish` schedule whose source is already receiving video.
    pub async fn go_live(&self, id: &str) -> Result<Value> {
        let value = self
            .send(
                Method::POST,
                self.url(&format!("/2/broadcasts/scheduled/{id}/live"), &[])?,
                Some(json!({})),
            )
            .await?;
        Ok(payload(&value).clone())
    }
    /// The live broadcast object (`media_key`, `share_url`, viewer counts).
    pub async fn broadcast(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .optional(&format!("/2/broadcasts/{id}"))
            .await?
            .map(|value| {
                let mut inner = payload(&value).clone();
                for key in ["share_url", "video_access"] {
                    if inner.get(key).is_none()
                        && let Some(outer) = value.get(key)
                    {
                        inner[key] = outer.clone();
                    }
                }
                inner
            }))
    }
    pub async fn end_broadcast(&self, id: &str) -> Result<()> {
        x_live::end_broadcast(&self.client, &self.credentials, &self.base, id).await
    }

    pub async fn source(&self, id: &str) -> Result<Option<XStreamSource>> {
        let path = format!("/2/users/{}/sources/{id}", self.credentials.user_id);
        let Some(value) = self.optional(&path).await? else {
            return Ok(None);
        };
        let source = value.get("source").cloned().unwrap_or(value);
        Ok(Some(
            serde_json::from_value(source).context("X source response unknown")?,
        ))
    }
    pub async fn sources(&self) -> Result<Vec<XStreamSource>> {
        let value = self
            .send(
                Method::GET,
                self.url(
                    &format!("/2/users/{}/sources", self.credentials.user_id),
                    &[],
                )?,
                None,
            )
            .await?;
        serde_json::from_value(value.get("sources").cloned().unwrap_or_else(|| json!([])))
            .context("X sources response unknown")
    }
    pub async fn create_source(&self, name: &str) -> Result<XStreamSource> {
        let region = x_live::get_region(&self.client, &self.credentials, &self.base).await?;
        let value = self
            .send(
                Method::POST,
                self.url(
                    &format!("/2/users/{}/sources", self.credentials.user_id),
                    &[],
                )?,
                Some(json!({ "name": name, "region": region })),
            )
            .await?;
        let source = value.get("source").cloned().unwrap_or(value);
        serde_json::from_value(source).context("X source response unknown")
    }
    pub async fn delete_source(&self, id: &str) -> Result<()> {
        self.send(
            Method::DELETE,
            self.url(
                &format!("/2/users/{}/sources/{id}", self.credentials.user_id),
                &[],
            )?,
            None,
        )
        .await?;
        Ok(())
    }

    /// Uploads a managed thumbnail through `POST /2/media/upload` and returns
    /// the numeric media id X wants in `thumbnail_media_id`.
    pub async fn upload_thumbnail(&self, path: &std::path::Path, asset_id: &str) -> Result<String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if format!("{:x}", Sha256::digest(&bytes)) != asset_id {
            bail!("Thumbnail content changed. Pick it again.");
        }
        let mime = crate::scheduled_youtube::validate_thumbnail(&bytes)?;
        let form = reqwest::multipart::Form::new()
            .part(
                "media",
                reqwest::multipart::Part::bytes(bytes)
                    .file_name(if mime == "image/png" {
                        "thumbnail.png"
                    } else {
                        "thumbnail.jpg"
                    })
                    .mime_str(mime)?,
            )
            .text("media_category", "tweet_image");
        let value = self
            .send_form(self.url("/2/media/upload", &[])?, form)
            .await
            .context("Thumbnail upload failed")?;
        let inner = payload(&value);
        let id = inner["id"]
            .as_str()
            .map(str::to_string)
            .or_else(|| inner["media_id_string"].as_str().map(str::to_string))
            .or_else(|| inner["media_id"].as_u64().map(|id| id.to_string()))
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
            .context("Thumbnail upload returned no media id")?;
        Ok(id)
    }
}

async fn finish(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(XRejection {
            status: status.as_u16(),
            reason: bounded_reason(&text),
        }
        .into());
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).context("X response unknown")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_streams::{EventMetadata, ScheduledIngest};
    use axum::{
        Router,
        extract::{Request, State},
        http::StatusCode,
        response::IntoResponse,
    };
    use std::sync::{Arc, Mutex};

    fn event() -> ScheduledStreamEvent {
        let mut event = ScheduledStreamEvent::draft(
            uuid::Uuid::new_v4().to_string(),
            "x",
            "123".into(),
            "@videorc".into(),
            EventMetadata {
                title: "Launch".into(),
                description: "Live from the launch".into(),
                privacy: "private".into(),
                made_for_kids: false,
                local_start: "2035-01-01T12:00".into(),
                time_zone: "UTC".into(),
                offset_choice: None,
                thumbnail_asset_id: None,
                planned_end_local: Some("2035-01-01T13:30".into()),
                available_for_replay: Some(false),
            },
        )
        .unwrap();
        event.ingest = Some(ScheduledIngest {
            source_id: "src123".into(),
            region: "eu".into(),
            server_url: "rtmps://ingest/live".into(),
            stream_key_secret_ref: "platform:x:123:src123:stream-key".into(),
        });
        event
    }

    #[test]
    fn create_body_is_manual_publish_with_an_end_and_string_times() {
        let body = create_body(&event(), Some("777")).unwrap();
        assert_eq!(body["source_id"], "src123");
        assert_eq!(body["manual_publish"], true);
        assert_eq!(body["scheduled_start_ms"], "2051265600000");
        assert_eq!(body["scheduled_end_ms"], "2051271000000");
        assert_eq!(body["available_for_replay"], false);
        assert_eq!(body["thumbnail_media_id"], "777");
        assert_eq!(body["chat_option"], "2");
        assert!(body["scheduled_start_ms"].is_string());
        assert_eq!(
            rfc3339_from_epoch_ms("2051265600000").unwrap(),
            "2035-01-01T12:00:00Z"
        );
        assert!(rfc3339_from_epoch_ms("abc").is_err());
    }

    #[test]
    fn default_planned_end_is_two_hours_after_start() {
        let mut event = event();
        event.requested.planned_end_local = None;
        let body = create_body(&event, None).unwrap();
        assert_eq!(body["scheduled_end_ms"], "2051272800000");
        assert!(body.get("thumbnail_media_id").is_none());
    }

    #[test]
    fn update_body_fully_replaces_and_keeps_untouched_remote_fields() {
        let mut event = event();
        event.provider_event_id = Some("1AxRnanzLOrxl".into());
        event.requested.available_for_replay = None;
        let current = json!({
            "broadcast_id": "1AxRnanzLOrxl",
            "scheduled_broadcast_id": "2075599796786561024",
            "source_id": "src123",
            "chat_option": "1",
            "locale": "es",
            "available_for_replay": true,
            "telecast_id": "42",
            "thumbnail_media_id": "555",
            "manual_publish": true
        });
        let body = update_body(&event, &current, None).unwrap();
        assert_eq!(body["scheduled_broadcast_id"], "2075599796786561024");
        assert_eq!(body["manual_publish"], true);
        assert_eq!(body["chat_option"], "1");
        assert_eq!(body["locale"], "es");
        assert_eq!(body["available_for_replay"], true);
        assert_eq!(body["telecast_id"], "42");
        assert_eq!(body["thumbnail_media_id"], "555");
        assert_eq!(body["scheduled_end_ms"], "2051271000000");
        assert_eq!(body["title"], "Launch");
        assert!(update_body(&event, &json!({}), None).is_err());
        let replaced = update_body(&event, &current, Some("999")).unwrap();
        assert_eq!(replaced["thumbnail_media_id"], "999");
    }

    #[test]
    fn scheduler_states_map_to_lifecycle() {
        for (state, expected) in [
            ("Created", "scheduled"),
            ("Scheduled", "scheduled"),
            ("RUNNING", "live"),
            ("Ended", "completed"),
            ("Error", "unknown"),
        ] {
            assert_eq!(lifecycle(&json!({"state": state})), expected);
        }
        assert_eq!(lifecycle(&json!({})), "unknown");
        assert_eq!(payload(&json!({"data": {"a": 1}}))["a"], 1);
        assert_eq!(payload(&json!({"broadcast": {"a": 2}}))["a"], 2);
        assert_eq!(
            scheduled_source_name("11111111-2222"),
            "Videorc Scheduled 11111111"
        );
    }

    #[derive(Default)]
    struct Fixture {
        calls: Vec<(String, String, String)>,
        reject: Option<(u16, String)>,
    }

    async fn respond(
        State(fixture): State<Arc<Mutex<Fixture>>>,
        request: Request,
    ) -> axum::response::Response {
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let signed = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("OAuth ") && value.contains("oauth_signature="));
        let content_type = request
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = axum::body::to_bytes(request.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let mut fixture = fixture.lock().unwrap();
        fixture
            .calls
            .push((method.clone(), path.clone(), content_type.clone()));
        if !signed {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({"title":"Unauthorized"})),
            )
                .into_response();
        }
        if let Some((status, reason)) = fixture.reject.clone() {
            return (
                StatusCode::from_u16(status).unwrap(),
                axum::Json(json!({"errors":[{"message":reason}]})),
            )
                .into_response();
        }
        match (method.as_str(), path.as_str()) {
            ("POST", "/2/broadcasts/scheduled") => {
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                (
                    StatusCode::CREATED,
                    axum::Json(json!({"data": {"broadcast_id":"1AxRnanzLOrxl","scheduled_broadcast_id":"2075599796786561024","state":"Created","source_id":body["source_id"],"title":body["title"],"manual_publish":body["manual_publish"]}})),
                )
                    .into_response()
            }
            ("GET", "/2/broadcasts/scheduled/missing") => {
                (StatusCode::NOT_FOUND, axum::Json(json!({"title":"Not Found"}))).into_response()
            }
            ("GET", "/2/broadcasts/scheduled/1AxRnanzLOrxl") => axum::Json(
                json!({"data": {"broadcast_id":"1AxRnanzLOrxl","state":"Created"}}),
            )
            .into_response(),
            ("POST", "/2/broadcasts/scheduled/1AxRnanzLOrxl/live") => axum::Json(
                json!({"data": {"broadcast_id":"1AxRnanzLOrxl","state":"Running"}}),
            )
            .into_response(),
            ("GET", "/2/broadcasts/1AxRnanzLOrxl") => axum::Json(
                json!({"broadcast": {"id":"1AxRnanzLOrxl","media_key":"28_1","state":"RUNNING"},"share_url":"https://x.com/i/broadcasts/1AxRnanzLOrxl"}),
            )
            .into_response(),
            ("DELETE", "/2/broadcasts/scheduled/1AxRnanzLOrxl") => {
                axum::Json(json!({"data": {"deleted": true}})).into_response()
            }
            ("POST", "/2/media/upload") => {
                assert!(content_type.starts_with("multipart/form-data"));
                let text = String::from_utf8_lossy(&bytes);
                assert!(text.contains("name=\"media_category\""));
                assert!(text.contains("tweet_image"));
                assert!(text.contains("name=\"media\""));
                axum::Json(json!({"data": {"id":"1880028106020515840","media_key":"3_1880028106020515840"}}))
                    .into_response()
            }
            _ => (StatusCode::NOT_FOUND, axum::Json(json!({}))).into_response(),
        }
    }

    async fn api() -> (
        XScheduledBroadcasts,
        Arc<Mutex<Fixture>>,
        tokio::task::JoinHandle<()>,
    ) {
        let fixture = Arc::new(Mutex::new(Fixture::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new().fallback(respond).with_state(fixture.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = XScheduledBroadcasts {
            client: Client::new(),
            credentials: XLivestreamCredentials {
                consumer_key: "ck".into(),
                consumer_secret: "cs".into(),
                access_token: "123-token".into(),
                access_token_secret: "ts".into(),
                user_id: "123".into(),
                account_label: Some("@videorc".into()),
                credential_source: "test".into(),
            },
            base: format!("http://127.0.0.1:{port}"),
        };
        (api, fixture, server)
    }

    #[tokio::test]
    async fn signed_requests_reach_every_scheduling_endpoint() {
        let (api, fixture, server) = api().await;
        let created = api.create(&event(), None).await.unwrap();
        assert_eq!(created["broadcast_id"], "1AxRnanzLOrxl");
        assert_eq!(created["manual_publish"], true);
        assert!(api.get("missing").await.unwrap().is_none());
        assert_eq!(
            api.get("1AxRnanzLOrxl").await.unwrap().unwrap()["state"],
            "Created"
        );
        assert_eq!(
            api.go_live("1AxRnanzLOrxl").await.unwrap()["state"],
            "Running"
        );
        let broadcast = api.broadcast("1AxRnanzLOrxl").await.unwrap().unwrap();
        assert_eq!(broadcast["media_key"], "28_1");
        assert_eq!(
            broadcast["share_url"],
            "https://x.com/i/broadcasts/1AxRnanzLOrxl"
        );
        api.delete("1AxRnanzLOrxl").await.unwrap();
        let png = {
            let mut buffer = std::io::Cursor::new(Vec::new());
            image::RgbImage::from_pixel(16, 9, image::Rgb([0, 0, 255]))
                .write_to(&mut buffer, image::ImageFormat::Png)
                .unwrap();
            buffer.into_inner()
        };
        let path = std::env::temp_dir().join(format!("x-thumb-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, &png).unwrap();
        let asset = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(&png))
        };
        assert_eq!(
            api.upload_thumbnail(&path, &asset).await.unwrap(),
            "1880028106020515840"
        );
        assert!(api.upload_thumbnail(&path, "wrong").await.is_err());
        let _ = std::fs::remove_file(path);
        let calls = fixture.lock().unwrap().calls.clone();
        assert!(calls.iter().all(|(_, path, _)| path.starts_with("/2/")));
        fixture.lock().unwrap().reject = Some((
            400,
            "scheduled_start_ms must be in the future <secret>".into(),
        ));
        let error = api.create(&event(), None).await.unwrap_err();
        let rejection = error.downcast_ref::<XRejection>().unwrap();
        assert_eq!(rejection.status, 400);
        assert!(!rejection.reason.contains('<'));
        assert!(rejection.reason.contains("future"));
        assert_eq!(
            crate::scheduled_streams::sanitized_error(&error).code,
            "invalid-time"
        );
        server.abort();
    }
}
