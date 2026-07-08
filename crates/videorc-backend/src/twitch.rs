use anyhow::{Context, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::streaming::{StreamMetadataDraft, StreamPlatform};

const TWITCH_API_BASE_URL: &str = "https://api.twitch.tv";
const TWITCH_RTMP_SERVER_URL: &str = "rtmp://live.twitch.tv/app";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwitchPrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwitchCategorySearchParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct TwitchPrepareRequest {
    pub access_token: String,
    pub client_id: String,
    pub account_id: String,
    pub account_label: String,
    pub metadata: StreamMetadataDraft,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TwitchCategorySearchRequest {
    pub access_token: String,
    pub client_id: String,
    pub query: String,
    pub first: Option<u32>,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTwitchBroadcast {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub server_url: String,
    pub stream_key_secret_ref: String,
    pub stream_key_present: bool,
    pub redacted_url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// Result of pushing channel metadata without touching the stream key —
/// used for manual-RTMP Twitch targets, where the stream transport is a
/// user-provided key but the channel page can still be updated via Helix.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwitchAppliedMetadata {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwitchCategorySearchResult {
    pub categories: Vec<TwitchCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwitchCategory {
    pub id: String,
    pub name: String,
    #[serde(rename(serialize = "boxArtUrl", deserialize = "box_art_url"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_art_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveTwitchMetadata {
    title: String,
    category_id: Option<String>,
    category_name: Option<String>,
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TwitchStreamKeyResponse {
    data: Vec<TwitchStreamKey>,
}

#[derive(Debug, Deserialize)]
struct TwitchStreamKey {
    stream_key: String,
}

#[derive(Debug, Deserialize)]
struct TwitchCategorySearchResponse {
    data: Vec<TwitchCategory>,
}

/// Push effective title/category/language to the channel via Helix
/// `PATCH /helix/channels`. Works regardless of how the stream is ingested
/// (OAuth-prepared or manual stream key).
pub async fn apply_twitch_channel_metadata(
    request: &TwitchPrepareRequest,
    client: &reqwest::Client,
) -> Result<TwitchAppliedMetadata> {
    let metadata = effective_twitch_metadata(&request.metadata)?;
    let base_url = request
        .api_base_url
        .clone()
        .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());

    let mut channel_body = Map::new();
    channel_body.insert("title".to_string(), Value::String(metadata.title.clone()));
    if let Some(category_id) = metadata.category_id.as_deref() {
        channel_body.insert(
            "game_id".to_string(),
            Value::String(category_id.to_string()),
        );
    }
    if let Some(language) = metadata.language.as_deref() {
        channel_body.insert(
            "broadcaster_language".to_string(),
            Value::String(language.to_string()),
        );
    }

    client
        .patch(twitch_api_url(
            &base_url,
            "/helix/channels",
            &[("broadcaster_id", request.account_id.as_str())],
        )?)
        .bearer_auth(&request.access_token)
        .header("Client-Id", &request.client_id)
        .json(&Value::Object(channel_body))
        .send()
        .await
        .context("Could not update Twitch channel metadata.")?
        .error_for_status()
        .context("Twitch channel metadata update failed.")?;

    Ok(TwitchAppliedMetadata {
        platform: StreamPlatform::Twitch,
        account_id: request.account_id.clone(),
        account_label: request.account_label.clone(),
        title: metadata.title,
        category_id: metadata.category_id,
        category_name: metadata.category_name,
        language: metadata.language,
    })
}

pub async fn prepare_twitch_broadcast(
    request: TwitchPrepareRequest,
    client: &reqwest::Client,
    put_secret: impl FnOnce(&str, &str) -> Result<()>,
) -> Result<PreparedTwitchBroadcast> {
    let base_url = request
        .api_base_url
        .clone()
        .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
    let applied = apply_twitch_channel_metadata(&request, client).await?;

    let key_response: TwitchStreamKeyResponse = client
        .get(twitch_api_url(
            &base_url,
            "/helix/streams/key",
            &[("broadcaster_id", request.account_id.as_str())],
        )?)
        .bearer_auth(&request.access_token)
        .header("Client-Id", &request.client_id)
        .send()
        .await
        .context("Could not fetch Twitch stream key.")?
        .error_for_status()
        .context("Twitch stream key fetch failed.")?
        .json()
        .await
        .context("Could not parse Twitch stream key response.")?;
    let stream_key = key_response
        .data
        .first()
        .map(|item| item.stream_key.trim())
        .filter(|stream_key| !stream_key.is_empty())
        .context("Twitch stream key response did not include a stream key.")?;

    let stream_key_secret_ref = format!("platform:twitch:{}:stream-key", request.account_id);
    put_secret(&stream_key_secret_ref, stream_key).context("Could not store Twitch stream key.")?;

    Ok(PreparedTwitchBroadcast {
        platform: StreamPlatform::Twitch,
        account_id: request.account_id,
        account_label: request.account_label,
        server_url: TWITCH_RTMP_SERVER_URL.to_string(),
        stream_key_secret_ref,
        stream_key_present: true,
        redacted_url: "rtmp://live.twitch.tv/app/<stream-key>".to_string(),
        title: applied.title,
        category_id: applied.category_id,
        category_name: applied.category_name,
        language: applied.language,
    })
}

pub async fn search_twitch_categories(
    request: TwitchCategorySearchRequest,
    client: &reqwest::Client,
) -> Result<TwitchCategorySearchResult> {
    let query = request.query.trim();
    if query.is_empty() {
        anyhow::bail!("Twitch category search query cannot be empty.");
    }
    let first = request.first.unwrap_or(20).clamp(1, 100).to_string();
    let base_url = request
        .api_base_url
        .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
    let response: TwitchCategorySearchResponse = client
        .get(twitch_api_url(
            &base_url,
            "/helix/search/categories",
            &[("query", query), ("first", first.as_str())],
        )?)
        .bearer_auth(&request.access_token)
        .header("Client-Id", &request.client_id)
        .send()
        .await
        .context("Could not search Twitch categories.")?
        .error_for_status()
        .context("Twitch category search failed.")?
        .json()
        .await
        .context("Could not parse Twitch category search response.")?;

    Ok(TwitchCategorySearchResult {
        categories: response.data,
    })
}

fn effective_twitch_metadata(draft: &StreamMetadataDraft) -> Result<EffectiveTwitchMetadata> {
    let override_draft = draft
        .target_overrides
        .iter()
        .find(|target| target.platform == StreamPlatform::Twitch);
    let title = override_draft
        .filter(|target| target.customize)
        .map(|target| target.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| draft.title.trim());
    if title.is_empty() {
        anyhow::bail!("A Twitch stream title is required.");
    }
    if title.chars().count() > 140 {
        anyhow::bail!("Twitch stream title must be 140 characters or fewer.");
    }

    let category_id = override_draft
        .filter(|target| target.customize)
        .and_then(|target| target.twitch_category_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let category_name = override_draft
        .filter(|target| target.customize)
        .and_then(|target| target.twitch_category_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let language = override_draft
        .filter(|target| target.customize)
        .and_then(|target| target.twitch_language.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Ok(EffectiveTwitchMetadata {
        title: title.to_string(),
        category_id,
        category_name,
        language,
    })
}

fn twitch_api_url(base_url: &str, path: &str, query: &[(&str, &str)]) -> Result<Url> {
    let mut url = Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))
        .context("Invalid Twitch API base URL.")?;
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{OriginalUri, State};
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::{get, patch};
    use axum::{Json, Router};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;
    use crate::streaming::{StreamPlatform, default_stream_metadata_draft};

    #[derive(Debug, Clone)]
    struct RequestLog {
        method: String,
        path: String,
        query: String,
        authorization: Option<String>,
        client_id: Option<String>,
        body: Value,
    }

    type RequestLogs = Arc<Mutex<Vec<RequestLog>>>;

    #[tokio::test]
    async fn prepares_twitch_channel_and_stores_stream_key_as_secret() {
        async fn update_channel(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                method: "PATCH".to_string(),
                path: "/helix/channels".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                client_id: headers
                    .get("client-id")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body,
            });
            axum::http::StatusCode::NO_CONTENT.into_response()
        }

        async fn get_stream_key(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                method: "GET".to_string(),
                path: "/helix/streams/key".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                client_id: headers
                    .get("client-id")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({ "data": [{ "stream_key": "live_secret_key" }] })).into_response()
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
                        .route("/helix/channels", patch(update_channel))
                        .route("/helix/streams/key", get(get_stream_key))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let mut metadata = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        metadata.title = "Global Twitch title".to_string();
        let twitch_override = metadata
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch_override.customize = true;
        twitch_override.title = "Twitch title".to_string();
        twitch_override.twitch_category_id = Some("509658".to_string());
        twitch_override.twitch_category_name = Some("Just Chatting".to_string());
        twitch_override.twitch_language = Some("en".to_string());

        let mut stored = Vec::new();
        let prepared = prepare_twitch_broadcast(
            TwitchPrepareRequest {
                access_token: "access-token".to_string(),
                client_id: "client-id".to_string(),
                account_id: "141981764".to_string(),
                account_label: "Videorc Twitch".to_string(),
                metadata,
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
            |secret_ref, value| {
                stored.push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(prepared.server_url, TWITCH_RTMP_SERVER_URL);
        assert_eq!(
            prepared.stream_key_secret_ref,
            "platform:twitch:141981764:stream-key"
        );
        assert_eq!(
            serde_json::to_string(&prepared)
                .unwrap()
                .contains("live_secret_key"),
            false
        );
        assert_eq!(
            stored,
            vec![(
                "platform:twitch:141981764:stream-key".to_string(),
                "live_secret_key".to_string()
            )]
        );
        assert_eq!(prepared.title, "Twitch title");
        assert_eq!(prepared.category_id.as_deref(), Some("509658"));
        assert_eq!(prepared.category_name.as_deref(), Some("Just Chatting"));
        assert_eq!(prepared.language.as_deref(), Some("en"));

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().all(|request| request.authorization.as_deref()
            == Some("Bearer access-token")
            && request.client_id.as_deref() == Some("client-id")));
        assert_eq!(logs[0].method, "PATCH");
        assert_eq!(logs[0].path, "/helix/channels");
        assert_eq!(logs[0].query, "broadcaster_id=141981764");
        assert_eq!(logs[0].body["title"], "Twitch title");
        assert_eq!(logs[0].body["game_id"], "509658");
        assert_eq!(logs[0].body["broadcaster_language"], "en");
        assert_eq!(logs[1].method, "GET");
        assert_eq!(logs[1].path, "/helix/streams/key");
        assert_eq!(logs[1].query, "broadcaster_id=141981764");
    }

    #[tokio::test]
    async fn searches_twitch_categories_with_user_token_and_client_id() {
        async fn search_categories(
            State(logs): State<RequestLogs>,
            OriginalUri(uri): OriginalUri,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            logs.lock().unwrap().push(RequestLog {
                method: "GET".to_string(),
                path: "/helix/search/categories".to_string(),
                query: uri.query().unwrap_or_default().to_string(),
                authorization: headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                client_id: headers
                    .get("client-id")
                    .and_then(|header| header.to_str().ok())
                    .map(ToOwned::to_owned),
                body: Value::Null,
            });
            Json(json!({
                "data": [{
                    "id": "509658",
                    "name": "Just Chatting",
                    "box_art_url": "https://static-cdn.jtvnw.net/ttv-boxart/509658-52x72.jpg"
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
                        .route("/helix/search/categories", get(search_categories))
                        .with_state(logs),
                )
                .await
                .unwrap();
            }
        });

        let result = search_twitch_categories(
            TwitchCategorySearchRequest {
                access_token: "access-token".to_string(),
                client_id: "client-id".to_string(),
                query: "just chat".to_string(),
                first: Some(10),
                api_base_url: Some(format!("http://{address}")),
            },
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            result.categories,
            vec![TwitchCategory {
                id: "509658".to_string(),
                name: "Just Chatting".to_string(),
                box_art_url: Some(
                    "https://static-cdn.jtvnw.net/ttv-boxart/509658-52x72.jpg".to_string()
                )
            }]
        );

        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].query, "query=just+chat&first=10");
        assert_eq!(
            logs[0].authorization.as_deref(),
            Some("Bearer access-token")
        );
        assert_eq!(logs[0].client_id.as_deref(), Some("client-id"));
    }

    #[test]
    fn twitch_metadata_enforces_title_limit() {
        let mut draft = default_stream_metadata_draft("2026-06-03T00:00:00Z".to_string());
        draft.title = "x".repeat(141);

        let error = effective_twitch_metadata(&draft).unwrap_err();

        assert!(error.to_string().contains("140"));
    }
}
