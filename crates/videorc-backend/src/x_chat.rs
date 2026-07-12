//! X Livestream read-only chat connector.
//!
//! The X Livestream API document describes chat as a legacy Periscope/X handoff:
//! fetch a chat token from `api.twitter.com`, exchange it through
//! `proxsee.pscp.tv`, then connect to the returned WebSocket endpoint. This
//! module implements read access only. Sending X chat is intentionally
//! unsupported because the documented API does not include a send flow.

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::live_chat::{
    LiveChatEventType, LiveChatMessage, LiveChatProviderConnectionState, live_chat_message_id,
    set_provider_and_emit, try_deliver_message,
};
use crate::live_chat_persistence::LiveChatPersistenceFailure;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

const CHAT_STATUS_BASE_URL: &str = "https://api.twitter.com";
const CHAT_ACCESS_URL: &str = "https://proxsee.pscp.tv/api/v2/accessChatPublic";
const PERISCOPE_USER_AGENT: &str = "Twitter/m5";
#[cfg(not(test))]
const CHAT_TOKEN_ATTEMPTS: usize = 10;
#[cfg(test)]
const CHAT_TOKEN_ATTEMPTS: usize = 3;
#[cfg(not(test))]
const CHAT_TOKEN_RETRY_MS: u64 = 2_000;
#[cfg(test)]
const CHAT_TOKEN_RETRY_MS: u64 = 10;
const MAX_RECONNECT_ATTEMPTS: usize = 8;
#[cfg(not(test))]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const WEBSOCKET_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const WEBSOCKET_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const WEBSOCKET_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(test)]
const WEBSOCKET_IDLE_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const CONNECT_READY_GRACE_MS: u64 = 1_000;
#[cfg(test)]
const CONNECT_READY_GRACE_MS: u64 = 25;
#[cfg(not(test))]
const MIN_RECONNECT_BACKOFF_MS: u64 = 500;
#[cfg(test)]
const MIN_RECONNECT_BACKOFF_MS: u64 = 10;
#[cfg(not(test))]
const MAX_RECONNECT_BACKOFF_MS: u64 = 30_000;
#[cfg(test)]
const MAX_RECONNECT_BACKOFF_MS: u64 = 40;

pub const X_NATIVE_COMMENTS_AVAILABLE: bool = true;

pub const X_COMMENTS_EVIDENCE_CHECKLIST: &[&str] = &[
    "Official X Livestream API documentation covers read-only live chat token handoff.",
    "Approved X Livestream API access exists for source and broadcast lifecycle.",
    "The connector uses only documented read endpoints and does not send X chat messages.",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XChatConfig {
    pub broadcast_id: String,
    pub media_key: String,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub status_base_url: Option<String>,
    #[serde(default)]
    pub access_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XChatStatusResponse {
    #[serde(default)]
    chat_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct XChatAccessResponse {
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    replay_endpoint: Option<String>,
    #[serde(default)]
    replay_access_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct XChatFrame {
    kind: i64,
    #[serde(default)]
    payload: Option<String>,
}

pub fn x_chat_message(has_x_account: bool) -> &'static str {
    if has_x_account {
        "X live chat can be read for native X broadcasts."
    } else {
        "Connect or configure X native live before reading X chat."
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XChatReadiness {
    pub available: bool,
    pub message: String,
    pub evidence_checklist: Vec<String>,
}

pub fn x_chat_readiness(has_x_account: bool) -> XChatReadiness {
    XChatReadiness {
        available: X_NATIVE_COMMENTS_AVAILABLE,
        message: x_chat_message(has_x_account).to_string(),
        evidence_checklist: X_COMMENTS_EVIDENCE_CHECKLIST
            .iter()
            .map(|item| (*item).to_string())
            .collect(),
    }
}

pub async fn run_x_chat_connector(state: AppState, session_id: String, config: XChatConfig) {
    if let Err(error) = ensure_active_session(&state, &session_id).await {
        state.emit_log(
            "warn",
            format!("Rejected stale X live chat attachment: {error}"),
        );
        return;
    }

    set_provider_and_emit(
        &state,
        StreamPlatform::X,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to X live chat.",
    )
    .await;

    let mut reconnect_attempts = 0;
    let mut backoff_ms = MIN_RECONNECT_BACKOFF_MS;
    loop {
        let mut reached_ready = false;
        let error = match run_x_chat_session(&state, &session_id, &config, &mut reached_ready).await
        {
            Ok(()) => anyhow::anyhow!("X live chat WebSocket ended."),
            Err(error) => error,
        };

        if ensure_active_session(&state, &session_id).await.is_err() {
            state.emit_log(
                "info",
                format!("Stopped stale X live chat connector for session {session_id}."),
            );
            return;
        }

        if let Some(failure) = error.downcast_ref::<LiveChatPersistenceFailure>()
            && failure.is_terminal()
        {
            set_provider_and_emit(
                &state,
                StreamPlatform::X,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Failed,
                &format!("X live chat stopped because comments storage failed: {failure}"),
            )
            .await;
            return;
        }

        if reached_ready {
            reconnect_attempts = 0;
            backoff_ms = MIN_RECONNECT_BACKOFF_MS;
        }
        reconnect_attempts += 1;
        if reconnect_attempts >= MAX_RECONNECT_ATTEMPTS {
            set_provider_and_emit(
                &state,
                StreamPlatform::X,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Failed,
                &format!(
                    "X live chat stopped after {MAX_RECONNECT_ATTEMPTS} consecutive connection attempts: {error}"
                ),
            )
            .await;
            return;
        }

        set_provider_and_emit(
            &state,
            StreamPlatform::X,
            config.target_id.as_deref(),
            LiveChatProviderConnectionState::Reconnecting,
            &format!("Reconnecting to X live chat: {error}"),
        )
        .await;
        sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = next_reconnect_backoff_ms(backoff_ms);
    }
}

async fn run_x_chat_session(
    state: &AppState,
    session_id: &str,
    config: &XChatConfig,
    reached_ready: &mut bool,
) -> Result<()> {
    ensure_active_session(state, session_id).await?;
    let client = reqwest::Client::new();
    let chat_token = fetch_chat_token_with_retry(&client, config).await?;
    ensure_active_session(state, session_id).await?;
    let access = access_chat(&client, config, &chat_token).await?;
    ensure_active_session(state, session_id).await?;
    let (endpoint, access_token) = select_chat_access_pair(access)?;
    let ws_url = chat_ws_url(&endpoint)?;
    let (mut ws, _response) = timeout(WEBSOCKET_HANDSHAKE_TIMEOUT, connect_async(&ws_url))
        .await
        .with_context(|| format!("Timed out connecting to X chat WebSocket {ws_url}"))?
        .with_context(|| format!("Could not connect to X chat WebSocket {ws_url}"))?;

    ws.send(Message::Text(x_auth_frame(&access_token).into()))
        .await
        .context("Could not authenticate X chat WebSocket.")?;
    ws.send(Message::Text(
        x_subscribe_frame(&config.broadcast_id).into(),
    ))
    .await
    .context("Could not subscribe to X chat room.")?;

    // The private contract documents auth + subscribe writes but no server
    // acknowledgement. Do not claim connected merely because those writes
    // completed. Incoming chat is definitive; otherwise the socket must remain
    // open for this bounded grace period before it is considered ready.
    let ready_grace = sleep(Duration::from_millis(CONNECT_READY_GRACE_MS));
    tokio::pin!(ready_grace);
    let mut connected = false;

    loop {
        tokio::select! {
            _ = &mut ready_grace, if !connected => {
                mark_connected(
                    state,
                    session_id,
                    config.target_id.as_deref(),
                    &mut connected,
                    reached_ready,
                )
                .await?;
            }
            message = timeout(WEBSOCKET_IDLE_TIMEOUT, ws.next()) => {
                ensure_active_session(state, session_id).await?;
                let message = message.context(
                    "X live chat WebSocket exceeded the idle liveness deadline.",
                )?;
                let Some(message) = message else {
                    anyhow::bail!("X live chat WebSocket closed.");
                };
                let message = message.context("X chat WebSocket read failed.")?;
                match message {
                    Message::Text(text) => {
                        if let Some(chat_message) =
                            parse_x_chat_message(&text, session_id, config.target_id.as_deref())
                        {
                            mark_connected(
                                state,
                                session_id,
                                config.target_id.as_deref(),
                                &mut connected,
                                reached_ready,
                            )
                            .await?;
                            let mut persistence_backoff_ms = MIN_RECONNECT_BACKOFF_MS;
                            let mut waited_for_storage = false;
                            loop {
                                match try_deliver_message(state, chat_message.clone()).await {
                                    Ok(()) => break,
                                    Err(error) if error.is_terminal() => {
                                        return Err(error.into());
                                    }
                                    Err(error) => {
                                        // Neither the live nor replay X socket promises
                                        // redelivery for a frame already read. Preserve
                                        // this exact normalized message locally and do
                                        // not read a later frame until it is durable.
                                        waited_for_storage = true;
                                        set_provider_and_emit(
                                            state,
                                            StreamPlatform::X,
                                            config.target_id.as_deref(),
                                            LiveChatProviderConnectionState::Waiting,
                                            &format!(
                                                "Waiting for comments storage before accepting more X messages: {error}"
                                            ),
                                        )
                                        .await;
                                        sleep(Duration::from_millis(persistence_backoff_ms)).await;
                                        persistence_backoff_ms =
                                            next_reconnect_backoff_ms(persistence_backoff_ms);
                                        ensure_active_session(state, session_id).await?;
                                    }
                                }
                            }
                            if waited_for_storage {
                                set_provider_and_emit(
                                    state,
                                    StreamPlatform::X,
                                    config.target_id.as_deref(),
                                    LiveChatProviderConnectionState::Connected,
                                    "X live chat connected; comments storage recovered (read-only).",
                                )
                                .await;
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        ws.send(Message::Pong(payload))
                            .await
                            .context("Could not answer X chat WebSocket ping.")?;
                    }
                    Message::Close(_) => anyhow::bail!("X live chat WebSocket closed."),
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn select_chat_access_pair(access: XChatAccessResponse) -> Result<(String, String)> {
    if let (Some(endpoint), Some(access_token)) = (access.endpoint, access.access_token) {
        return Ok((endpoint, access_token));
    }
    if let (Some(endpoint), Some(access_token)) =
        (access.replay_endpoint, access.replay_access_token)
    {
        return Ok((endpoint, access_token));
    }
    anyhow::bail!(
        "X chat access response did not include a matching live or replay endpoint/token pair."
    )
}

async fn mark_connected(
    state: &AppState,
    session_id: &str,
    target_id: Option<&str>,
    connected: &mut bool,
    reached_ready: &mut bool,
) -> Result<()> {
    if *connected {
        return Ok(());
    }
    ensure_active_session(state, session_id).await?;
    set_provider_and_emit(
        state,
        StreamPlatform::X,
        target_id,
        LiveChatProviderConnectionState::Connected,
        "X live chat authenticated and subscribed (read-only).",
    )
    .await;
    *connected = true;
    *reached_ready = true;
    Ok(())
}

async fn ensure_active_session(state: &AppState, expected_session_id: &str) -> Result<()> {
    let active_session_id = crate::live_chat::current_status(state).await.session_id;
    if active_session_id.as_deref() == Some(expected_session_id) {
        return Ok(());
    }
    anyhow::bail!(
        "X live chat expected session {expected_session_id}, but the active session is {}.",
        active_session_id.as_deref().unwrap_or("none")
    )
}

fn next_reconnect_backoff_ms(current_ms: u64) -> u64 {
    current_ms
        .saturating_mul(2)
        .clamp(MIN_RECONNECT_BACKOFF_MS, MAX_RECONNECT_BACKOFF_MS)
}

async fn fetch_chat_token_with_retry(
    client: &reqwest::Client,
    config: &XChatConfig,
) -> Result<String> {
    for attempt in 0..CHAT_TOKEN_ATTEMPTS {
        if let Some(token) = fetch_chat_token(client, config).await? {
            return Ok(token);
        }

        // A successful status response can legitimately precede token
        // availability. Poll only that state here. Transport failures return
        // to the connector's backoff loop so they never incur two retry sleeps.
        if attempt + 1 < CHAT_TOKEN_ATTEMPTS {
            sleep(Duration::from_millis(CHAT_TOKEN_RETRY_MS)).await;
        }
    }
    anyhow::bail!("X chat token was not available after publishing.")
}

async fn fetch_chat_token(
    client: &reqwest::Client,
    config: &XChatConfig,
) -> Result<Option<String>> {
    let base = config
        .status_base_url
        .as_deref()
        .unwrap_or(CHAT_STATUS_BASE_URL)
        .trim_end_matches('/');
    let url = format!("{base}/1.1/live_video_stream/status/{}", config.media_key);
    let body = timeout(HTTP_REQUEST_TIMEOUT, async {
        let response = client
            .get(url)
            .header("x-periscope-user-agent", PERISCOPE_USER_AGENT)
            .send()
            .await
            .context("Could not fetch X chat token.")?;
        if !response.status().is_success() {
            let status = response.status();
            anyhow::bail!("X chat token request failed with HTTP {status}");
        }
        response
            .json::<XChatStatusResponse>()
            .await
            .context("Could not parse X chat token response.")
    })
    .await
    .context("X chat token request timed out.")??;
    Ok(body.chat_token.filter(|token| !token.trim().is_empty()))
}

async fn access_chat(
    client: &reqwest::Client,
    config: &XChatConfig,
    chat_token: &str,
) -> Result<XChatAccessResponse> {
    timeout(HTTP_REQUEST_TIMEOUT, async {
        let response = client
            .post(config.access_url.as_deref().unwrap_or(CHAT_ACCESS_URL))
            .header("content-type", "application/json")
            .header("x-periscope-user-agent", PERISCOPE_USER_AGENT)
            .header("x-idempotence", Uuid::new_v4().to_string())
            .header("x-attempt", "1")
            .json(&json!({ "chat_token": chat_token }))
            .send()
            .await
            .context("Could not request X chat access.")?;
        if !response.status().is_success() {
            let status = response.status();
            anyhow::bail!("X chat access request failed with HTTP {status}");
        }
        response
            .json::<XChatAccessResponse>()
            .await
            .context("Could not parse X chat access response.")
    })
    .await
    .context("X chat access request timed out.")?
}

fn chat_ws_url(endpoint: &str) -> Result<String> {
    let url = reqwest::Url::parse(endpoint).context("X chat endpoint URL is invalid.")?;
    let host = url
        .host_str()
        .context("X chat endpoint URL did not include a host.")?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        scheme => anyhow::bail!("X chat endpoint URL uses unsupported scheme {scheme}."),
    };
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    Ok(format!("{scheme}://{authority}/chatapi/v1/chatnow"))
}

fn x_auth_frame(access_token: &str) -> String {
    json!({
        "kind": 3,
        "payload": json!({ "access_token": access_token }).to_string()
    })
    .to_string()
}

fn x_subscribe_frame(broadcast_id: &str) -> String {
    json!({
        "kind": 2,
        "payload": json!({
            "kind": 1,
            "payload": json!({ "room": broadcast_id }).to_string()
        }).to_string()
    })
    .to_string()
}

fn parse_x_chat_message(
    text: &str,
    session_id: &str,
    target_id: Option<&str>,
) -> Option<LiveChatMessage> {
    let frame: XChatFrame = serde_json::from_str(text).ok()?;
    if frame.kind != 1 {
        return None;
    }
    let payload = frame.payload?;
    let payload: Value = serde_json::from_str(&payload).ok()?;
    let body = payload
        .get("body")
        .and_then(|body| body.as_str())
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
        .unwrap_or(payload);
    let text = body
        .get("body")
        .or_else(|| body.get("text"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let username = body
        .get("username")
        .or_else(|| body.get("displayName"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("X viewer");
    let provider_message_id = body
        .get("uuid")
        .or_else(|| body.get("id"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}:{}:{}",
                username,
                body.get("timestamp")
                    .map(Value::to_string)
                    .unwrap_or_default(),
                text
            )
        });
    let now = chrono::Utc::now().to_rfc3339();
    Some(LiveChatMessage {
        id: live_chat_message_id(
            session_id,
            StreamPlatform::X,
            target_id,
            &provider_message_id,
        ),
        provider_message_id,
        platform: StreamPlatform::X,
        target_id: target_id.map(ToOwned::to_owned),
        session_id: session_id.to_string(),
        author_id: body
            .get("user_id")
            .or_else(|| body.get("userId"))
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
        author_name: username.to_string(),
        author_avatar_url: None,
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at: now.clone(),
        received_at: now,
        message_text: text.to_string(),
        fragments: Vec::new(),
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: Some("x-chat".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::ws::{Message as AxumMessage, WebSocketUpgrade};
    use axum::extract::{Path, State};
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use tokio::sync::{Mutex, Notify, broadcast, oneshot};

    use crate::live_chat::{
        CommentsReadState, CommentsWriteState, LiveChatProviderConnectionState,
        LiveChatProviderState, current_diagnostics, current_status,
    };
    use crate::storage::Database;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MockSocketMode {
        Deliver,
        DeliverOnce,
        DropFirstThenDeliver,
        HangHandshake,
        WaitForRelease,
        StayOpen,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MockHttpMode {
        Respond,
        HangToken,
        HangAccess,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct MockAccessCall {
        chat_token: String,
        periscope_user_agent: String,
        idempotence: String,
        attempt: String,
    }

    #[derive(Clone)]
    struct MockXServerState {
        endpoint: String,
        mode: MockSocketMode,
        http_mode: MockHttpMode,
        token_calls: Arc<AtomicUsize>,
        access_calls: Arc<Mutex<Vec<MockAccessCall>>>,
        socket_connections: Arc<AtomicUsize>,
        chat_messages_sent: Arc<AtomicUsize>,
        socket_frames: Arc<Mutex<Vec<Value>>>,
        release_message: Arc<Notify>,
    }

    struct MockXServer {
        base_url: String,
        state: MockXServerState,
        shutdown: oneshot::Sender<()>,
    }

    async fn mock_chat_status(
        State(state): State<MockXServerState>,
        Path(media_key): Path<String>,
        headers: HeaderMap,
    ) -> Json<Value> {
        assert_eq!(media_key, "media-key-1");
        assert_eq!(
            headers
                .get("x-periscope-user-agent")
                .and_then(|value| value.to_str().ok()),
            Some(PERISCOPE_USER_AGENT)
        );
        let call = state.token_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if state.http_mode == MockHttpMode::HangToken {
            std::future::pending::<()>().await;
        }
        Json(json!({ "chatToken": format!("chat-token-{call}") }))
    }

    async fn mock_access_chat(
        State(state): State<MockXServerState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state.access_calls.lock().await.push(MockAccessCall {
            chat_token: body["chat_token"].as_str().unwrap_or_default().to_string(),
            periscope_user_agent: headers
                .get("x-periscope-user-agent")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            idempotence: headers
                .get("x-idempotence")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            attempt: headers
                .get("x-attempt")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        });
        if state.http_mode == MockHttpMode::HangAccess {
            std::future::pending::<()>().await;
        }
        Json(json!({
            "endpoint": state.endpoint,
            "access_token": "socket-access-token"
        }))
    }

    fn mock_chat_frame(message_id: &str) -> String {
        let body = json!({
            "body": "hello from mocked x",
            "username": "x-viewer",
            "uuid": message_id,
            "user_id": "viewer-1"
        });
        json!({
            "kind": 1,
            "payload": json!({ "body": body.to_string() }).to_string()
        })
        .to_string()
    }

    async fn mock_chat_socket(
        State(state): State<MockXServerState>,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        let connection = state.socket_connections.fetch_add(1, Ordering::SeqCst) + 1;
        if state.mode == MockSocketMode::HangHandshake {
            std::future::pending::<()>().await;
        }
        ws.on_upgrade(move |mut socket| async move {
            for _ in 0..2 {
                let Some(Ok(AxumMessage::Text(text))) = socket.recv().await else {
                    return;
                };
                if let Ok(frame) = serde_json::from_str(text.as_str()) {
                    state.socket_frames.lock().await.push(frame);
                }
            }

            if state.mode == MockSocketMode::DropFirstThenDeliver && connection == 1 {
                let _ = socket.send(AxumMessage::Close(None)).await;
                return;
            }

            match state.mode {
                MockSocketMode::Deliver | MockSocketMode::DropFirstThenDeliver => {
                    state.chat_messages_sent.fetch_add(1, Ordering::SeqCst);
                    let _ = socket
                        .send(AxumMessage::Text(mock_chat_frame("message-1").into()))
                        .await;
                }
                MockSocketMode::DeliverOnce => {
                    if state
                        .chat_messages_sent
                        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        let _ = socket
                            .send(AxumMessage::Text(mock_chat_frame("message-1").into()))
                            .await;
                    }
                }
                MockSocketMode::HangHandshake => unreachable!("handshake remains pending"),
                MockSocketMode::WaitForRelease => {
                    state.release_message.notified().await;
                    let _ = socket
                        .send(AxumMessage::Text(mock_chat_frame("late-message").into()))
                        .await;
                }
                MockSocketMode::StayOpen => {}
            }
            sleep(Duration::from_secs(5)).await;
        })
    }

    async fn spawn_mock_x_server(mode: MockSocketMode) -> MockXServer {
        spawn_mock_x_server_with_http(mode, MockHttpMode::Respond).await
    }

    async fn spawn_mock_x_server_with_http(
        mode: MockSocketMode,
        http_mode: MockHttpMode,
    ) -> MockXServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock X listener");
        let addr = listener.local_addr().expect("mock X address");
        let base_url = format!("http://{addr}");
        let state = MockXServerState {
            endpoint: base_url.clone(),
            mode,
            http_mode,
            token_calls: Arc::new(AtomicUsize::new(0)),
            access_calls: Arc::new(Mutex::new(Vec::new())),
            socket_connections: Arc::new(AtomicUsize::new(0)),
            chat_messages_sent: Arc::new(AtomicUsize::new(0)),
            socket_frames: Arc::new(Mutex::new(Vec::new())),
            release_message: Arc::new(Notify::new()),
        };
        let app = Router::new()
            .route(
                "/1.1/live_video_stream/status/{media_key}",
                get(mock_chat_status),
            )
            .route("/api/v2/accessChatPublic", post(mock_access_chat))
            .route("/chatapi/v1/chatnow", get(mock_chat_socket))
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        MockXServer {
            base_url,
            state,
            shutdown: shutdown_tx,
        }
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(32);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn x_provider_row() -> LiveChatProviderState {
        LiveChatProviderState {
            id: "x-target".to_string(),
            platform: StreamPlatform::X,
            target_id: Some("x-target".to_string()),
            account_id: Some("x-account".to_string()),
            account_label: Some("X Account".to_string()),
            read: CommentsReadState::Connecting,
            write: CommentsWriteState::ReadOnly,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting to X live chat.".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
        }
    }

    async fn start_test_session(state: &AppState, session_id: &str) {
        state
            .database
            .ensure_fake_live_chat_session(session_id)
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session(session_id.to_string(), vec![x_provider_row()]);
    }

    fn mock_config(server: &MockXServer) -> XChatConfig {
        XChatConfig {
            broadcast_id: "broadcast-1".to_string(),
            media_key: "media-key-1".to_string(),
            target_id: Some("x-target".to_string()),
            status_base_url: Some(server.base_url.clone()),
            access_url: Some(format!("{}/api/v2/accessChatPublic", server.base_url)),
        }
    }

    async fn wait_for_message(state: &AppState, provider_message_id: &str) -> LiveChatMessage {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = current_status(state).await;
            if let Some(message) = snapshot
                .messages
                .into_iter()
                .find(|message| message.provider_message_id == provider_message_id)
            {
                return message;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for X message {provider_message_id}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_socket_frames(state: &MockXServerState, expected: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if state.socket_frames.lock().await.len() >= expected {
                return;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for {expected} X WebSocket frames"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_count(counter: &AtomicUsize, expected: usize, label: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if counter.load(Ordering::SeqCst) >= expected {
                return;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for {expected} {label}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_persistence_rejection(state: &AppState) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if state.recent_logs(16).iter().any(|entry| {
                entry
                    .message
                    .contains("exact-message retry remains eligible")
            }) {
                return;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for forced X persistence rejection"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_persisted_message(state: &AppState, provider_message_id: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if state
                .database
                .list_live_chat_messages_recent("session-1", 10)
                .unwrap()
                .iter()
                .any(|message| message.provider_message_id == provider_message_id)
            {
                return;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for durable X message {provider_message_id}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_provider_state(
        state: &AppState,
        expected: LiveChatProviderConnectionState,
    ) -> LiveChatProviderState {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = current_status(state).await;
            if let Some(provider) = snapshot.providers.into_iter().find(|provider| {
                provider.platform == StreamPlatform::X && provider.state == expected
            }) {
                return provider;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for X provider state {expected:?}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn readiness_reports_available_read_only_path() {
        let readiness = x_chat_readiness(true);
        assert!(readiness.available);
        assert!(readiness.message.contains("read"));
        assert_eq!(readiness.evidence_checklist.len(), 3);
    }

    #[test]
    fn websocket_url_uses_returned_host() {
        assert_eq!(
            chat_ws_url("https://prod-chat-ancillary-eu-central-1.pscp.tv").unwrap(),
            "wss://prod-chat-ancillary-eu-central-1.pscp.tv/chatapi/v1/chatnow"
        );
        assert_eq!(
            chat_ws_url("http://127.0.0.1:4321").unwrap(),
            "ws://127.0.0.1:4321/chatapi/v1/chatnow"
        );
    }

    #[test]
    fn access_selection_keeps_endpoint_and_token_from_the_same_mode() {
        let live = select_chat_access_pair(XChatAccessResponse {
            endpoint: Some("https://live.example".to_string()),
            access_token: Some("live-token".to_string()),
            replay_endpoint: Some("https://replay.example".to_string()),
            replay_access_token: Some("replay-token".to_string()),
        })
        .unwrap();
        assert_eq!(
            live,
            ("https://live.example".to_string(), "live-token".to_string())
        );

        let replay = select_chat_access_pair(XChatAccessResponse {
            endpoint: Some("https://incomplete-live.example".to_string()),
            access_token: None,
            replay_endpoint: Some("https://replay.example".to_string()),
            replay_access_token: Some("replay-token".to_string()),
        })
        .unwrap();
        assert_eq!(
            replay,
            (
                "https://replay.example".to_string(),
                "replay-token".to_string()
            )
        );

        let error = select_chat_access_pair(XChatAccessResponse {
            endpoint: Some("https://live.example".to_string()),
            access_token: None,
            replay_endpoint: None,
            replay_access_token: Some("replay-token".to_string()),
        })
        .unwrap_err();
        assert!(error.to_string().contains("matching"));
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_bounded() {
        assert_eq!(
            next_reconnect_backoff_ms(MIN_RECONNECT_BACKOFF_MS),
            (MIN_RECONNECT_BACKOFF_MS * 2).min(MAX_RECONNECT_BACKOFF_MS)
        );
        assert_eq!(
            next_reconnect_backoff_ms(MAX_RECONNECT_BACKOFF_MS),
            MAX_RECONNECT_BACKOFF_MS
        );
        assert_eq!(
            next_reconnect_backoff_ms(u64::MAX),
            MAX_RECONNECT_BACKOFF_MS
        );
    }

    #[test]
    fn frames_double_encode_payloads() {
        let auth = x_auth_frame("access");
        assert!(auth.contains(r#""kind":3"#));
        assert!(auth.contains(r#"access_token"#));

        let subscribe = x_subscribe_frame("broadcast-1");
        assert!(subscribe.contains(r#""kind":2"#));
        assert!(subscribe.contains("broadcast-1"));
    }

    #[test]
    fn parses_double_json_chat_message() {
        let body = json!({
            "body": "hello from x",
            "username": "viewer",
            "uuid": "message-1"
        });
        let frame = json!({
            "kind": 1,
            "payload": json!({ "body": body.to_string() }).to_string()
        });

        let message = parse_x_chat_message(&frame.to_string(), "session-1", Some("x"))
            .expect("message parsed");

        assert_eq!(message.platform, StreamPlatform::X);
        assert_eq!(message.provider_message_id, "message-1");
        assert_eq!(message.author_name, "viewer");
        assert_eq!(message.message_text, "hello from x");
        assert_eq!(message.target_id.as_deref(), Some("x"));
    }

    #[tokio::test]
    async fn token_access_socket_flow_authenticates_subscribes_and_delivers() {
        let server = spawn_mock_x_server(MockSocketMode::Deliver).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        let message = wait_for_message(&state, "message-1").await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.platform, StreamPlatform::X);
        assert_eq!(message.session_id, "session-1");
        assert_eq!(message.target_id.as_deref(), Some("x-target"));
        assert_eq!(message.author_id.as_deref(), Some("viewer-1"));
        assert_eq!(message.author_name, "x-viewer");
        assert_eq!(message.message_text, "hello from mocked x");
        let provider = current_status(&state)
            .await
            .providers
            .into_iter()
            .find(|provider| provider.platform == StreamPlatform::X)
            .expect("X destination state");
        assert_eq!(provider.state, LiveChatProviderConnectionState::Connected);
        assert_eq!(provider.read, CommentsReadState::Ready);
        assert_eq!(provider.write, CommentsWriteState::ReadOnly);
        assert_eq!(server.state.token_calls.load(Ordering::SeqCst), 1);

        let access_calls = server.state.access_calls.lock().await;
        assert_eq!(access_calls.len(), 1);
        assert_eq!(access_calls[0].chat_token, "chat-token-1");
        assert_eq!(access_calls[0].periscope_user_agent, PERISCOPE_USER_AGENT);
        assert_eq!(access_calls[0].attempt, "1");
        assert!(!access_calls[0].idempotence.is_empty());
        drop(access_calls);

        let frames = server.state.socket_frames.lock().await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["kind"], 3);
        let auth_payload: Value =
            serde_json::from_str(frames[0]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(auth_payload["access_token"], "socket-access-token");
        assert_eq!(frames[1]["kind"], 2);
        let subscribe_envelope: Value =
            serde_json::from_str(frames[1]["payload"].as_str().unwrap()).unwrap();
        let subscribe_payload: Value =
            serde_json::from_str(subscribe_envelope["payload"].as_str().unwrap()).unwrap();
        assert_eq!(subscribe_payload["room"], "broadcast-1");
    }

    #[tokio::test]
    async fn socket_loss_reconnects_and_refreshes_chat_access() {
        let server = spawn_mock_x_server(MockSocketMode::DropFirstThenDeliver).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        let message = wait_for_message(&state, "message-1").await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.session_id, "session-1");
        assert_eq!(server.state.token_calls.load(Ordering::SeqCst), 2);
        assert_eq!(server.state.socket_connections.load(Ordering::SeqCst), 2);
        let access_calls = server.state.access_calls.lock().await;
        assert_eq!(
            access_calls
                .iter()
                .map(|call| call.chat_token.as_str())
                .collect::<Vec<_>>(),
            vec!["chat-token-1", "chat-token-2"]
        );
        drop(access_calls);
        assert_eq!(server.state.socket_frames.lock().await.len(), 4);
        assert_eq!(current_diagnostics(&state).await.reconnect_count, 1);
    }

    #[tokio::test]
    async fn persistence_rejection_retries_retained_x_message_without_server_replay() {
        let server = spawn_mock_x_server(MockSocketMode::DeliverOnce).await;
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), vec![x_provider_row()]);

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_persistence_rejection(&state).await;
        assert!(current_status(&state).await.messages.is_empty());
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let message = wait_for_message(&state, "message-1").await;
        wait_for_persisted_message(&state, "message-1").await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.session_id, "session-1");
        assert_eq!(message.provider_message_id, "message-1");
        assert_eq!(server.state.chat_messages_sent.load(Ordering::SeqCst), 1);
        assert_eq!(server.state.socket_connections.load(Ordering::SeqCst), 1);
        assert_eq!(
            state
                .database
                .list_live_chat_messages_recent("session-1", 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn hanging_token_http_reconnects_after_request_deadline() {
        let server =
            spawn_mock_x_server_with_http(MockSocketMode::StayOpen, MockHttpMode::HangToken).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_count(&server.state.token_calls, 2, "X chat token requests").await;
        let diagnostics = current_diagnostics(&state).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert!(diagnostics.reconnect_count >= 1);
    }

    #[tokio::test]
    async fn hanging_access_http_reconnects_after_request_deadline() {
        let server =
            spawn_mock_x_server_with_http(MockSocketMode::StayOpen, MockHttpMode::HangAccess).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_count(&server.state.token_calls, 2, "X chat token requests").await;
        let access_calls = server.state.access_calls.lock().await.len();
        let diagnostics = current_diagnostics(&state).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(access_calls, 2);
        assert!(diagnostics.reconnect_count >= 1);
    }

    #[tokio::test]
    async fn hanging_websocket_handshake_reconnects_after_deadline() {
        let server = spawn_mock_x_server(MockSocketMode::HangHandshake).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_count(
            &server.state.socket_connections,
            2,
            "X WebSocket handshake attempts",
        )
        .await;
        let diagnostics = current_diagnostics(&state).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert!(diagnostics.reconnect_count >= 1);
    }

    #[tokio::test]
    async fn half_open_socket_reconnects_after_idle_deadline() {
        let server = spawn_mock_x_server(MockSocketMode::StayOpen).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_count(
            &server.state.socket_connections,
            2,
            "X WebSocket connections",
        )
        .await;
        let diagnostics = current_diagnostics(&state).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert!(diagnostics.reconnect_count >= 1);
        assert!(server.state.token_calls.load(Ordering::SeqCst) >= 2);
        assert!(server.state.access_calls.lock().await.len() >= 2);
    }

    #[tokio::test]
    async fn open_socket_uses_bounded_grace_before_reporting_read_only_connected() {
        let server = spawn_mock_x_server(MockSocketMode::StayOpen).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_socket_frames(&server.state, 2).await;
        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Connected).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert!(provider.message.contains("authenticated and subscribed"));
        assert!(provider.message.contains("read-only"));
        assert_eq!(provider.read, CommentsReadState::Ready);
        assert_eq!(provider.write, CommentsWriteState::ReadOnly);
        assert!(current_status(&state).await.messages.is_empty());
    }

    #[tokio::test]
    async fn late_socket_traffic_cannot_attach_to_a_different_session() {
        let server = spawn_mock_x_server(MockSocketMode::WaitForRelease).await;
        let state = test_state();
        start_test_session(&state, "session-1").await;
        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            mock_config(&server),
        ));
        wait_for_socket_frames(&server.state, 2).await;

        start_test_session(&state, "session-2").await;
        server.state.release_message.notify_one();
        tokio::time::timeout(Duration::from_secs(1), connector)
            .await
            .expect("stale X connector stopped")
            .expect("stale X connector joined");
        let _ = server.shutdown.send(());

        let snapshot = current_status(&state).await;
        assert_eq!(snapshot.session_id.as_deref(), Some("session-2"));
        assert!(snapshot.messages.is_empty());
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Connecting
        );
        assert!(state.recent_logs(8).iter().any(|entry| {
            entry
                .message
                .contains("Stopped stale X live chat connector for session session-1")
        }));
    }
}
