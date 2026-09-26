//! Kick Go Live over OAuth (plan 063, S3).
//!
//! Kick's public API exposes the caller's own channel (with its ingest URL and
//! stream key under `streamkey:read`) from `GET /public/v1/channels` with no
//! params, and title/category updates via `PATCH /public/v1/channels`.
//! Unlike Twitch there is no Client-Id header: the user token alone is enough.

use anyhow::{Context, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::streaming::{StreamMetadataDraft, StreamPlatform};

const KICK_API_BASE_URL: &str = "https://api.kick.com";
/// Kick's public ingest (IVS). Used only when the channel read has no
/// `stream.url`; the channel's own URL always wins.
pub const KICK_RTMP_SERVER_URL: &str =
    "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app";
/// Normalizes the ingest URL Kick returns in `stream.url` into the server URL
/// FFmpeg pushes to. Kick's channel read returns the bare host
/// (`rtmps://<id>.global-contribute.live-video.net`) while its ingest expects
/// `rtmps://<host>:443/app/<stream-key>`. Found live on 2026-09-26: the
/// bare-host URL produced `rtmps://<host>/<key>` and Kick answered
/// "Input/output error" until the stream was stopped. Keep the channel's own
/// host, add the `:443` port when missing, and make sure the path ends in
/// `/app`. Anything unparsable falls back to the documented public ingest.
pub fn kick_ingest_server_url(api_url: Option<&str>) -> String {
    let raw = api_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(KICK_RTMP_SERVER_URL);
    let Ok(mut url) = Url::parse(raw) else {
        return KICK_RTMP_SERVER_URL.to_string();
    };
    if !matches!(url.scheme(), "rtmp" | "rtmps") || url.host_str().is_none() {
        return KICK_RTMP_SERVER_URL.to_string();
    }
    if url.scheme() == "rtmps" && url.port().is_none() {
        // 443 is the RTMPS default, but the ingest is documented with it and
        // FFmpeg's librtmp path is happier when it is explicit.
        let _ = url.set_port(Some(443));
    }
    let path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() || path == "/" {
        url.set_path("/app");
    } else if !path.ends_with("/app") {
        url.set_path(&format!("{path}/app"));
    } else {
        url.set_path(&path);
    }
    url.set_query(None);
    url.set_fragment(None);
    url.to_string().trim_end_matches('/').to_string()
}

/// Kick does not document a stream title limit. Cap at Twitch's 140 so an
/// over-long title fails here with a clear message instead of at Kick.
const KICK_TITLE_MAX_CHARS: usize = 140;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KickPrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KickCategorySearchParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct KickPrepareRequest {
    pub access_token: String,
    pub account_id: String,
    pub account_label: String,
    pub metadata: StreamMetadataDraft,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct KickCategorySearchRequest {
    pub access_token: String,
    pub query: String,
    pub limit: Option<u32>,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedKickBroadcast {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub server_url: String,
    pub stream_key_secret_ref: String,
    pub stream_key_present: bool,
    pub redacted_url: String,
    pub broadcaster_user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KickAppliedMetadata {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KickCategorySearchResult {
    pub categories: Vec<KickCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KickCategory {
    pub id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectiveKickMetadata {
    pub title: String,
    pub category_id: Option<u64>,
    pub category_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KickChannelsResponse {
    data: Vec<KickChannel>,
}

#[derive(Debug, Deserialize)]
struct KickChannel {
    broadcaster_user_id: Value,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    stream: Option<KickChannelStream>,
}

#[derive(Debug, Deserialize)]
struct KickChannelStream {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KickCategoriesResponse {
    #[serde(default)]
    data: Vec<KickCategory>,
}

/// Kick answers a stale or revoked token with 401 (and a missing scope with
/// 403). Callers refresh once on these and retry.
pub fn is_kick_auth_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .and_then(reqwest::Error::status)
            .is_some_and(|status| status == reqwest::StatusCode::UNAUTHORIZED)
    })
}

/// Push the effective title/category with `PATCH /public/v1/channels`.
/// Works for OAuth-prepared and manual-key Kick targets alike.
pub async fn apply_kick_channel_metadata(
    request: &KickPrepareRequest,
    client: &reqwest::Client,
) -> Result<KickAppliedMetadata> {
    let metadata = effective_kick_metadata(&request.metadata)?;
    let body = kick_channel_patch_body(&metadata);
    if !body.is_empty() {
        let base_url = kick_base_url(request.api_base_url.as_deref());
        client
            .patch(kick_api_url(&base_url, "/public/v1/channels", &[])?)
            .bearer_auth(&request.access_token)
            .json(&Value::Object(body))
            .send()
            .await
            .context("Could not update Kick channel metadata.")?
            .error_for_status()
            .context("Kick channel metadata update failed.")?;
    }

    Ok(KickAppliedMetadata {
        platform: StreamPlatform::Kick,
        account_id: request.account_id.clone(),
        account_label: request.account_label.clone(),
        title: metadata.title,
        category_id: metadata.category_id,
        category_name: metadata.category_name,
    })
}

fn kick_channel_patch_body(metadata: &EffectiveKickMetadata) -> Map<String, Value> {
    let mut body = Map::new();
    if !metadata.title.is_empty() {
        body.insert(
            "stream_title".to_string(),
            Value::String(metadata.title.clone()),
        );
    }
    if let Some(category_id) = metadata.category_id {
        body.insert("category_id".to_string(), Value::from(category_id));
    }
    body
}

/// Apply metadata, then read the caller's channel and store its stream key as
/// a secret. The key is never logged or returned; only its secret ref is.
pub async fn prepare_kick_broadcast(
    request: KickPrepareRequest,
    client: &reqwest::Client,
    put_secret: impl FnOnce(&str, &str) -> Result<()>,
) -> Result<PreparedKickBroadcast> {
    let base_url = kick_base_url(request.api_base_url.as_deref());
    let applied = apply_kick_channel_metadata(&request, client).await?;

    let channels: KickChannelsResponse = client
        .get(kick_api_url(&base_url, "/public/v1/channels", &[])?)
        .bearer_auth(&request.access_token)
        .send()
        .await
        .context("Could not read the Kick channel.")?
        .error_for_status()
        .context("Kick channel read failed.")?
        .json()
        .await
        .context("Could not parse the Kick channel response.")?;
    let channel = channels
        .data
        .into_iter()
        .next()
        .context("Kick did not return a channel for this account.")?;
    let stream = channel.stream.unwrap_or(KickChannelStream {
        url: None,
        key: None,
    });
    let stream_key = stream
        .key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .context(
            "Kick did not return a stream key. Reconnect Kick so Videorc can read it (streamkey:read).",
        )?;
    let server_url = kick_ingest_server_url(stream.url.as_deref());

    let stream_key_secret_ref = format!("platform:kick:{}:stream-key", request.account_id);
    put_secret(&stream_key_secret_ref, stream_key).context("Could not store Kick stream key.")?;

    let broadcaster_user_id = match channel.broadcaster_user_id {
        Value::String(id) => id,
        other => other.to_string(),
    };

    Ok(PreparedKickBroadcast {
        platform: StreamPlatform::Kick,
        account_id: request.account_id,
        account_label: request.account_label,
        redacted_url: format!("{server_url}/<stream-key>"),
        server_url,
        stream_key_secret_ref,
        stream_key_present: true,
        broadcaster_user_id,
        slug: channel.slug.filter(|slug| !slug.trim().is_empty()),
        title: applied.title,
        category_id: applied.category_id,
        category_name: applied.category_name,
    })
}

/// Search categories: v2 first (`/public/v2/categories?q=&limit=`), then the
/// v1 search (`/public/v1/categories?q=`) if v2 is unavailable.
pub async fn search_kick_categories(
    request: KickCategorySearchRequest,
    client: &reqwest::Client,
) -> Result<KickCategorySearchResult> {
    let query = request.query.trim();
    if query.is_empty() {
        anyhow::bail!("Kick category search query cannot be empty.");
    }
    let limit = request.limit.unwrap_or(25).clamp(1, 100);
    let limit_param = limit.to_string();
    let base_url = kick_base_url(request.api_base_url.as_deref());

    let v2 = client
        .get(kick_api_url(
            &base_url,
            "/public/v2/categories",
            &[("q", query), ("limit", limit_param.as_str())],
        )?)
        .bearer_auth(&request.access_token)
        .send()
        .await
        .context("Could not search Kick categories.")?;
    let status = v2.status();
    let response: KickCategoriesResponse = if status.is_success() {
        v2.json()
            .await
            .context("Could not parse Kick category search response.")?
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        // A stale token fails v1 too; surface the 401 so the caller refreshes.
        let error = v2.error_for_status().expect_err("401 is an error status");
        return Err(anyhow::Error::new(error).context("Kick category search failed."));
    } else {
        client
            .get(kick_api_url(
                &base_url,
                "/public/v1/categories",
                &[("q", query)],
            )?)
            .bearer_auth(&request.access_token)
            .send()
            .await
            .context("Could not search Kick categories.")?
            .error_for_status()
            .context("Kick category search failed.")?
            .json()
            .await
            .context("Could not parse Kick category search response.")?
    };

    let mut categories = response.data;
    categories.truncate(limit as usize);
    Ok(KickCategorySearchResult { categories })
}

/// Title: the Kick row's custom title when the row is customized and not
/// blank, else the global title. Category is a platform setting (plan 059):
/// it applies whether or not the row customizes its title.
pub(crate) fn effective_kick_metadata(
    draft: &StreamMetadataDraft,
) -> Result<EffectiveKickMetadata> {
    let override_draft = draft
        .target_overrides
        .iter()
        .find(|target| target.platform == StreamPlatform::Kick);
    let title = override_draft
        .filter(|target| target.customize)
        .map(|target| target.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| draft.title.trim());
    if title.is_empty() {
        anyhow::bail!("A Kick stream title is required.");
    }
    if title.chars().count() > KICK_TITLE_MAX_CHARS {
        anyhow::bail!("Kick stream title must be {KICK_TITLE_MAX_CHARS} characters or fewer.");
    }
    let category_id = override_draft.and_then(|target| target.kick_category_id);
    let category_name = category_id.and_then(|_| {
        override_draft
            .and_then(|target| target.kick_category_name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });

    Ok(EffectiveKickMetadata {
        title: title.to_string(),
        category_id,
        category_name,
    })
}

fn kick_base_url(api_base_url: Option<&str>) -> String {
    api_base_url.unwrap_or(KICK_API_BASE_URL).to_string()
}

fn kick_api_url(base_url: &str, path: &str, query: &[(&str, &str)]) -> Result<Url> {
    let mut url = Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))
        .context("Invalid Kick API base URL.")?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().copied());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{OriginalUri, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;
    use crate::streaming::{StreamPlatform, default_stream_metadata_draft};

    #[derive(Debug, Clone)]
    struct RequestLog {
        method: String,
        query: String,
        authorization: Option<String>,
        body: Value,
    }

    type RequestLogs = Arc<Mutex<Vec<RequestLog>>>;

    fn log(
        logs: &RequestLogs,
        method: &str,
        uri: &axum::http::Uri,
        headers: &HeaderMap,
        body: Value,
    ) {
        logs.lock().unwrap().push(RequestLog {
            method: method.to_string(),
            query: uri.query().unwrap_or_default().to_string(),
            authorization: headers
                .get("authorization")
                .and_then(|header| header.to_str().ok())
                .map(ToOwned::to_owned),
            body,
        });
    }

    async fn serve(router: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://{address}")
    }

    fn draft_with_kick(
        customize: bool,
        title: &str,
        category: Option<(u64, &str)>,
    ) -> StreamMetadataDraft {
        let mut draft = default_stream_metadata_draft("2026-09-25T00:00:00Z".to_string());
        draft.title = "Global title".to_string();
        let kick = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Kick)
            .unwrap();
        kick.customize = customize;
        kick.title = title.to_string();
        kick.kick_category_id = category.map(|(id, _)| id);
        kick.kick_category_name = category.map(|(_, name)| name.to_string());
        draft
    }

    #[tokio::test]
    async fn prepares_kick_channel_and_stores_stream_key_as_secret() {
        async fn patch_channel(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> impl IntoResponse {
            log(&logs, "PATCH", &uri, &headers, body);
            StatusCode::NO_CONTENT
        }
        async fn read_channel(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl IntoResponse {
            log(&logs, "GET", &uri, &headers, Value::Null);
            Json(json!({
                "data": [{
                    "broadcaster_user_id": 424242,
                    "slug": "orcdev",
                    "stream_title": "old",
                    "category": { "id": 1, "name": "Old", "thumbnail": "" },
                    "stream": {
                        "url": "rtmps://ingest.example.live-video.net:443/app/",
                        "key": "sk_us-west-2_secret",
                        "is_live": false,
                        "viewer_count": 0
                    }
                }],
                "message": "OK"
            }))
        }

        let logs: RequestLogs = Arc::new(Mutex::new(Vec::new()));
        let base = serve(
            Router::new()
                .route(
                    "/public/v1/channels",
                    get(read_channel).patch(patch_channel),
                )
                .with_state(logs.clone()),
        )
        .await;

        let mut stored = Vec::new();
        let prepared = prepare_kick_broadcast(
            KickPrepareRequest {
                access_token: "kick-access".to_string(),
                account_id: "424242".to_string(),
                account_label: "orcdev".to_string(),
                metadata: draft_with_kick(true, "Kick title", Some((15, "Just Chatting"))),
                api_base_url: Some(base),
            },
            &reqwest::Client::new(),
            |secret_ref, value| {
                stored.push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(
            stored,
            vec![(
                "platform:kick:424242:stream-key".to_string(),
                "sk_us-west-2_secret".to_string()
            )]
        );
        assert!(
            !serde_json::to_string(&prepared)
                .unwrap()
                .contains("sk_us-west-2_secret")
        );
        assert_eq!(
            prepared.server_url,
            "rtmps://ingest.example.live-video.net:443/app"
        );
        assert_eq!(
            prepared.redacted_url,
            "rtmps://ingest.example.live-video.net:443/app/<stream-key>"
        );
        assert_eq!(prepared.broadcaster_user_id, "424242");
        assert_eq!(prepared.slug.as_deref(), Some("orcdev"));
        assert_eq!(prepared.title, "Kick title");
        assert_eq!(prepared.category_id, Some(15));
        assert_eq!(prepared.category_name.as_deref(), Some("Just Chatting"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert!(
            logs.iter()
                .all(|request| request.authorization.as_deref() == Some("Bearer kick-access"))
        );
        assert_eq!(logs[0].method, "PATCH");
        assert_eq!(
            logs[0].body,
            json!({ "stream_title": "Kick title", "category_id": 15 })
        );
        assert_eq!(logs[1].method, "GET");
        assert_eq!(logs[1].query, "");
    }

    #[test]
    fn kick_ingest_url_gets_port_and_app_path() {
        assert_eq!(
            kick_ingest_server_url(Some(
                "rtmps://fa723fc1b171.global-contribute.live-video.net"
            )),
            "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app"
        );
        assert_eq!(
            kick_ingest_server_url(Some(
                "rtmps://fa723fc1b171.global-contribute.live-video.net/"
            )),
            "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app"
        );
        assert_eq!(
            kick_ingest_server_url(Some("rtmps://ingest.example.live-video.net:443/app/")),
            "rtmps://ingest.example.live-video.net:443/app"
        );
        assert_eq!(
            kick_ingest_server_url(Some("rtmp://ingest.example.live-video.net/app")),
            "rtmp://ingest.example.live-video.net/app"
        );
        assert_eq!(kick_ingest_server_url(None), KICK_RTMP_SERVER_URL);
        assert_eq!(kick_ingest_server_url(Some("   ")), KICK_RTMP_SERVER_URL);
        assert_eq!(
            kick_ingest_server_url(Some("not a url")),
            KICK_RTMP_SERVER_URL
        );
        assert_eq!(
            kick_ingest_server_url(Some("https://kick.com/whatever")),
            KICK_RTMP_SERVER_URL
        );
    }

    #[tokio::test]
    async fn prepare_fails_without_a_stream_key_and_stores_nothing() {
        async fn read_channel() -> impl IntoResponse {
            Json(
                json!({ "data": [{ "broadcaster_user_id": 1, "stream": { "url": "rtmps://x/app", "key": "" } }] }),
            )
        }
        let base = serve(Router::new().route(
            "/public/v1/channels",
            get(read_channel).patch(|| async { StatusCode::NO_CONTENT }),
        ))
        .await;
        let mut stored = 0;
        let error = prepare_kick_broadcast(
            KickPrepareRequest {
                access_token: "t".to_string(),
                account_id: "1".to_string(),
                account_label: "a".to_string(),
                metadata: draft_with_kick(false, "", None),
                api_base_url: Some(base),
            },
            &reqwest::Client::new(),
            |_, _| {
                stored += 1;
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("stream key"));
        assert_eq!(stored, 0);
    }

    #[tokio::test]
    async fn searches_kick_categories_on_v2() {
        async fn v2(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl IntoResponse {
            log(&logs, "GET", &uri, &headers, Value::Null);
            Json(json!({
                "data": [{ "id": 15, "name": "Just Chatting", "thumbnail": "https://files.kick.com/c.webp" }],
                "next_cursor": "abc"
            }))
        }
        let logs: RequestLogs = Arc::new(Mutex::new(Vec::new()));
        let base = serve(
            Router::new()
                .route("/public/v2/categories", get(v2))
                .with_state(logs.clone()),
        )
        .await;

        let result = search_kick_categories(
            KickCategorySearchRequest {
                access_token: "kick-access".to_string(),
                query: "just chat".to_string(),
                limit: None,
                api_base_url: Some(base),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            result.categories,
            vec![KickCategory {
                id: 15,
                name: "Just Chatting".to_string(),
                thumbnail: Some("https://files.kick.com/c.webp".to_string())
            }]
        );
        let logs = logs.lock().unwrap();
        assert_eq!(logs[0].query, "q=just+chat&limit=25");
        assert_eq!(logs[0].authorization.as_deref(), Some("Bearer kick-access"));
    }

    #[tokio::test]
    async fn category_search_falls_back_to_v1_when_v2_is_missing() {
        async fn v1(OriginalUri(uri): OriginalUri) -> impl IntoResponse {
            assert_eq!(uri.query(), Some("q=fort"));
            Json(json!({ "data": [{ "id": 7, "name": "Fortnite", "thumbnail": "" }] }))
        }
        let base = serve(
            Router::new()
                .route(
                    "/public/v2/categories",
                    get(|| async { StatusCode::NOT_FOUND }),
                )
                .route("/public/v1/categories", get(v1)),
        )
        .await;
        let result = search_kick_categories(
            KickCategorySearchRequest {
                access_token: "t".to_string(),
                query: "fort".to_string(),
                limit: Some(10),
                api_base_url: Some(base),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.categories[0].id, 7);
    }

    #[tokio::test]
    async fn unauthorized_category_search_is_a_kick_auth_error() {
        let base = serve(Router::new().route(
            "/public/v2/categories",
            get(|| async { StatusCode::UNAUTHORIZED }),
        ))
        .await;
        let error = search_kick_categories(
            KickCategorySearchRequest {
                access_token: "stale".to_string(),
                query: "a".to_string(),
                limit: None,
                api_base_url: Some(base),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(is_kick_auth_error(&error));
        assert!(!is_kick_auth_error(&anyhow::anyhow!("plain")));
    }

    #[test]
    fn kick_category_applies_without_a_custom_title() {
        let draft = draft_with_kick(false, "Stale custom", Some((15, " Just Chatting ")));
        let effective = effective_kick_metadata(&draft).unwrap();
        assert_eq!(effective.title, "Global title");
        assert_eq!(effective.category_id, Some(15));
        assert_eq!(effective.category_name.as_deref(), Some("Just Chatting"));
    }

    #[test]
    fn kick_custom_title_needs_the_switch_and_blank_falls_back() {
        let custom = effective_kick_metadata(&draft_with_kick(true, "Kick only", None)).unwrap();
        assert_eq!(custom.title, "Kick only");
        assert_eq!(custom.category_id, None);
        let blank = effective_kick_metadata(&draft_with_kick(true, "   ", None)).unwrap();
        assert_eq!(blank.title, "Global title");
    }

    #[test]
    fn kick_metadata_enforces_title_limit_and_presence() {
        let mut draft = draft_with_kick(false, "", None);
        draft.title = "x".repeat(141);
        assert!(
            effective_kick_metadata(&draft)
                .unwrap_err()
                .to_string()
                .contains("140")
        );
        draft.title = "  ".to_string();
        assert!(effective_kick_metadata(&draft).is_err());
    }

    #[test]
    fn patch_body_carries_only_what_is_set() {
        let body = kick_channel_patch_body(&EffectiveKickMetadata {
            title: "Title".to_string(),
            category_id: None,
            category_name: None,
        });
        assert_eq!(Value::Object(body), json!({ "stream_title": "Title" }));
        assert!(
            kick_channel_patch_body(&EffectiveKickMetadata {
                title: String::new(),
                category_id: None,
                category_name: None,
            })
            .is_empty()
        );
    }
}
