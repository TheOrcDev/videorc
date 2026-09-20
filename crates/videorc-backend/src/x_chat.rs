//! X Livestream chat connector (read side).
//!
//! X delivers live chat for native broadcasts only through the X Activity API
//! (XAA) event `broadcast.chat`. XAA pushes to a public HTTPS webhook signed
//! with the app consumer secret, and its app-bearer stream is an app-wide
//! firehose, so neither can terminate inside a desktop app. The Videorc web
//! relay receives the webhook and this connector long-polls it:
//!
//! 1. prove the X identity to the relay (OAuth Echo — only a signed
//!    `GET /2/users/me` header leaves the machine, never the token);
//! 2. make sure one `broadcast.chat` subscription points at the relay webhook
//!    (OAuth 1.0a user context, the "Authorize X Live" credentials);
//! 3. long-poll the relay for this broadcast's messages.
//!
//! The legacy Periscope WebSocket handoff this replaced was shut off by X: the
//! socket closed right after subscribe on every session and never delivered a
//! message. Sending lives in `x_live::send_broadcast_chat_message`.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::sleep;

use crate::live_chat::{
    LiveChatEventType, LiveChatMessage, LiveChatProviderConnectionState, live_chat_message_id,
    set_provider_and_emit, try_deliver_message,
};
use crate::live_chat_persistence::LiveChatPersistenceFailure;
use crate::state::AppState;
use crate::streaming::StreamPlatform;
use crate::x_live::XLivestreamCredentials;

const RELAY_BIND_PATH: &str = "/api/desktop/x-chat/bind";
const RELAY_READ_PATH: &str = "/api/desktop/x-chat";
/// After this many consecutive failed attempts the outage is written to the
/// session health record once. The connector keeps retrying while the session
/// is live: a relay or network outage mid-stream must heal on its own.
const FAILURE_REPORT_ATTEMPTS: usize = 8;
#[cfg(not(test))]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_millis(150);
/// How long the relay may hold a read open waiting for messages.
#[cfg(not(test))]
const RELAY_READ_WAIT_MS: u64 = 20_000;
#[cfg(test)]
const RELAY_READ_WAIT_MS: u64 = 20;
#[cfg(not(test))]
const MIN_RECONNECT_BACKOFF_MS: u64 = 500;
#[cfg(test)]
const MIN_RECONNECT_BACKOFF_MS: u64 = 10;
#[cfg(not(test))]
const MAX_RECONNECT_BACKOFF_MS: u64 = 30_000;
#[cfg(test)]
const MAX_RECONNECT_BACKOFF_MS: u64 = 40;

#[cfg(not(test))]
const DEFAULT_X_API_BASE_URL: &str = crate::x_live::DEFAULT_API_BASE_URL;
// Unit tests must never reach production hosts, even through a code path that
// forgot to set the overrides.
#[cfg(test)]
const DEFAULT_X_API_BASE_URL: &str = "http://127.0.0.1:9";

#[cfg(not(test))]
fn default_relay_base_url() -> String {
    crate::videorc_api::api_base_url()
}

#[cfg(test)]
fn default_relay_base_url() -> String {
    "http://127.0.0.1:9".to_string()
}

pub const X_NATIVE_COMMENTS_AVAILABLE: bool = true;

pub const X_COMMENTS_EVIDENCE_CHECKLIST: &[&str] = &[
    "Official X documentation delivers live chat through the X Activity API broadcast.chat event.",
    "Approved X Livestream API access exists for source and broadcast lifecycle.",
    "Chat is read through the Videorc relay webhook and sent with the documented chat endpoint.",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XChatConfig {
    pub broadcast_id: String,
    #[serde(default)]
    pub target_id: Option<String>,
    /// Test seam. Never deserialized: a renderer must not be able to point the
    /// account bearer or the X signature at another host.
    #[serde(skip)]
    pub overrides: XChatOverrides,
}

#[derive(Debug, Clone, Default)]
pub struct XChatOverrides {
    pub relay_base_url: Option<String>,
    pub x_api_base_url: Option<String>,
    pub session_token: Option<String>,
    pub credentials: Option<XLivestreamCredentials>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayBinding {
    webhook_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayPage {
    cursor: String,
    #[serde(default)]
    events: Vec<RelayEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayEvent {
    message_id: String,
    text: String,
    #[serde(default)]
    is_subscriber: bool,
    #[serde(default)]
    received_at: Option<String>,
    #[serde(default)]
    author: RelayAuthor,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayAuthor {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

/// Retrying cannot fix this; the user has to act (sign in, re-authorize X).
#[derive(Debug)]
struct XChatTerminalFailure(String);

impl std::fmt::Display for XChatTerminalFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for XChatTerminalFailure {}

fn terminal(message: impl Into<String>) -> anyhow::Error {
    XChatTerminalFailure(message.into()).into()
}

pub fn x_chat_message(has_x_account: bool) -> &'static str {
    if has_x_account {
        "X live chat can be read and sent for native X broadcasts."
    } else {
        "Connect or configure X native live before using X chat."
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

pub async fn run_x_chat_connector(
    state: AppState,
    session_id: String,
    session_generation: u64,
    config: XChatConfig,
) {
    if let Err(error) = ensure_active_session(&state, &session_id, session_generation).await {
        state.emit_log(
            "warn",
            format!("Rejected stale X live chat attachment: {error}"),
        );
        return;
    }

    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        StreamPlatform::X,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to X live chat.",
    )
    .await;

    let mut failed_attempts = 0;
    let mut backoff_ms = MIN_RECONNECT_BACKOFF_MS;
    loop {
        let mut reached_ready = false;
        let error = match run_x_chat_session(
            &state,
            &session_id,
            session_generation,
            &config,
            &mut reached_ready,
        )
        .await
        {
            Ok(()) => anyhow::anyhow!("X live chat relay read ended."),
            Err(error) => error,
        };

        if ensure_active_session(&state, &session_id, session_generation)
            .await
            .is_err()
        {
            state.emit_log(
                "info",
                format!("Stopped stale X live chat connector for session {session_id}."),
            );
            return;
        }

        let storage_terminal = error
            .downcast_ref::<LiveChatPersistenceFailure>()
            .filter(|failure| failure.is_terminal())
            .map(|failure| {
                format!("X live chat stopped because comments storage failed: {failure}")
            });
        let terminal_message = storage_terminal.or_else(|| {
            error
                .downcast_ref::<XChatTerminalFailure>()
                .map(ToString::to_string)
        });
        if let Some(message) = terminal_message {
            report_failure(&state, &session_id, &message);
            set_provider_and_emit(
                &state,
                &session_id,
                session_generation,
                StreamPlatform::X,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Failed,
                &message,
            )
            .await;
            return;
        }

        if reached_ready {
            failed_attempts = 0;
            backoff_ms = MIN_RECONNECT_BACKOFF_MS;
        }
        failed_attempts += 1;
        if failed_attempts == FAILURE_REPORT_ATTEMPTS {
            // Owner report 2026-08-19: an empty X comment feed with no trace
            // anywhere burned a livestream's worth of debugging. A sustained
            // outage lands in the session health record so the cause is on
            // file even if nobody watched the provider row live.
            report_failure(
                &state,
                &session_id,
                &format!(
                    "X live chat has failed {FAILURE_REPORT_ATTEMPTS} consecutive connection attempts and keeps retrying: {error}"
                ),
            );
        }

        set_provider_and_emit(
            &state,
            &session_id,
            session_generation,
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

fn report_failure(state: &AppState, session_id: &str, message: &str) {
    let _ = crate::recording::emit_health_event(
        state,
        Some(session_id),
        crate::protocol::HealthLevel::Warn,
        "x-live-chat-failed",
        message,
    );
}

async fn run_x_chat_session(
    state: &AppState,
    session_id: &str,
    session_generation: u64,
    config: &XChatConfig,
    reached_ready: &mut bool,
) -> Result<()> {
    ensure_active_session(state, session_id, session_generation).await?;
    let session_token = config
        .overrides
        .session_token
        .clone()
        .or_else(crate::account::stored_session_token)
        .ok_or_else(|| terminal("Sign in to your Videorc account to receive X comments."))?;
    let credentials = match config.overrides.credentials.clone() {
        Some(credentials) => credentials,
        None => crate::x_live::x_livestream_credentials()
            .context("Could not load the X Live authorization.")?
            .ok_or_else(|| terminal("Authorize X Live to receive X comments."))?,
    };
    let relay = RelayClient::new(config, session_token)?;
    let x_api_base_url = config
        .overrides
        .x_api_base_url
        .as_deref()
        .unwrap_or(DEFAULT_X_API_BASE_URL);

    let echo = crate::x_live::x_identity_echo_authorization(&credentials, x_api_base_url)?;
    let binding = relay.bind(&echo).await?;
    ensure_active_session(state, session_id, session_generation).await?;

    crate::x_live::ensure_broadcast_chat_subscription(
        &relay.http,
        &credentials,
        x_api_base_url,
        &binding.webhook_id,
    )
    .await
    .map_err(|error| {
        if error.rejected {
            terminal(format!(
                "X refused the live chat subscription — re-authorize X Live. ({error})"
            ))
        } else {
            anyhow::Error::new(error)
        }
    })?;
    ensure_active_session(state, session_id, session_generation).await?;

    // The first read carries no cursor: the relay answers "from now" so a new
    // stream never replays a previous broadcast's backlog.
    let mut cursor = relay.read(None, &config.broadcast_id).await?.cursor;
    ensure_active_session(state, session_id, session_generation).await?;
    set_provider_and_emit(
        state,
        session_id,
        session_generation,
        StreamPlatform::X,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connected,
        "X live chat connected.",
    )
    .await;
    *reached_ready = true;

    loop {
        let page = relay.read(Some(&cursor), &config.broadcast_id).await?;
        ensure_active_session(state, session_id, session_generation).await?;
        for event in page.events {
            let Some(chat_message) =
                relay_event_to_message(event, session_id, config.target_id.as_deref())
            else {
                continue;
            };
            deliver_durably(state, session_id, session_generation, config, chat_message).await?;
        }
        // Advance only after every message of the page is durable: a failure
        // above re-reads the same page, and message ids de-duplicate it.
        cursor = page.cursor;
    }
}

async fn deliver_durably(
    state: &AppState,
    session_id: &str,
    session_generation: u64,
    config: &XChatConfig,
    chat_message: LiveChatMessage,
) -> Result<()> {
    let mut persistence_backoff_ms = MIN_RECONNECT_BACKOFF_MS;
    let mut waited_for_storage = false;
    loop {
        match try_deliver_message(state, session_generation, chat_message.clone()).await {
            Ok(()) => break,
            Err(error) if error.is_terminal() => return Err(error.into()),
            Err(error) => {
                // Hold this exact message and do not read further until it is
                // durable, so comments are never stored out of order.
                waited_for_storage = true;
                set_provider_and_emit(
                    state,
                    session_id,
                    session_generation,
                    StreamPlatform::X,
                    config.target_id.as_deref(),
                    LiveChatProviderConnectionState::Waiting,
                    &format!(
                        "Waiting for comments storage before accepting more X messages: {error}"
                    ),
                )
                .await;
                sleep(Duration::from_millis(persistence_backoff_ms)).await;
                persistence_backoff_ms = next_reconnect_backoff_ms(persistence_backoff_ms);
                ensure_active_session(state, session_id, session_generation).await?;
            }
        }
    }
    if waited_for_storage {
        set_provider_and_emit(
            state,
            session_id,
            session_generation,
            StreamPlatform::X,
            config.target_id.as_deref(),
            LiveChatProviderConnectionState::Connected,
            "X live chat connected; comments storage recovered.",
        )
        .await;
    }
    Ok(())
}

struct RelayClient {
    base_url: String,
    session_token: String,
    http: reqwest::Client,
}

impl RelayClient {
    fn new(config: &XChatConfig, session_token: String) -> Result<Self> {
        Ok(Self {
            base_url: config
                .overrides
                .relay_base_url
                .clone()
                .unwrap_or_else(default_relay_base_url)
                .trim_end_matches('/')
                .to_string(),
            session_token,
            http: reqwest::Client::builder()
                .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .context("Could not build the X chat relay HTTP client.")?,
        })
    }

    async fn bind(&self, echo_authorization: &str) -> Result<RelayBinding> {
        let response = self
            .http
            .post(format!("{}{RELAY_BIND_PATH}", self.base_url))
            .bearer_auth(&self.session_token)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .json(&json!({ "authorization": echo_authorization }))
            .send()
            .await
            .context("Could not reach the Videorc X chat relay.")?;
        Self::parse(response).await
    }

    async fn read(&self, after: Option<&str>, broadcast_id: &str) -> Result<RelayPage> {
        let mut query = vec![
            ("broadcastId", broadcast_id.to_string()),
            ("waitMs", RELAY_READ_WAIT_MS.to_string()),
        ];
        if let Some(after) = after {
            query.push(("after", after.to_string()));
        }
        let response = self
            .http
            .get(format!("{}{RELAY_READ_PATH}", self.base_url))
            .bearer_auth(&self.session_token)
            .timeout(HTTP_REQUEST_TIMEOUT + Duration::from_millis(RELAY_READ_WAIT_MS))
            .query(&query)
            .send()
            .await
            .context("Could not read from the Videorc X chat relay.")?;
        Self::parse(response).await
    }

    async fn unbind(&self) -> Result<()> {
        let response = self
            .http
            .delete(format!("{}{RELAY_BIND_PATH}", self.base_url))
            .bearer_auth(&self.session_token)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .send()
            .await
            .context("Could not reach the Videorc X chat relay.")?;
        if !response.status().is_success() {
            anyhow::bail!("X chat relay unbind failed with HTTP {}", response.status());
        }
        Ok(())
    }

    async fn parse<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
        let status = response.status();
        if status.is_success() {
            return response
                .json::<T>()
                .await
                .context("Could not parse the X chat relay response.");
        }
        let (code, message) = crate::videorc_api::read_error_code_and_message(response).await;
        match code.as_str() {
            "unauthorized" => Err(terminal(
                "Your Videorc sign-in expired — sign in again to receive X comments.",
            )),
            "x-chat-bind-rejected" => Err(terminal(
                "X did not confirm this account — re-authorize X Live to receive X comments.",
            )),
            _ if status.as_u16() == 401 => Err(terminal(
                "Your Videorc sign-in expired — sign in again to receive X comments.",
            )),
            // Everything else (relay not configured, binding lost, 5xx, rate
            // limits) can heal without the user, so the connector retries.
            _ => anyhow::bail!("X chat relay answered HTTP {status} ({code}): {message}"),
        }
    }
}

/// Best-effort cleanup when the user disconnects X: drop the XAA subscription
/// and the relay binding so no chat keeps flowing for a disconnected account.
/// `credentials` must be captured before the local token pair is deleted.
pub async fn forget_x_chat_relay(state: AppState, credentials: XLivestreamCredentials) {
    let client = reqwest::Client::new();
    if let Err(error) = crate::x_live::delete_broadcast_chat_subscriptions(
        &client,
        &credentials,
        crate::x_live::DEFAULT_API_BASE_URL,
    )
    .await
    {
        state.emit_log(
            "warn",
            format!("Could not remove the X live chat subscription: {error}"),
        );
    }
    let Some(session_token) = crate::account::stored_session_token() else {
        return;
    };
    let config = XChatConfig {
        broadcast_id: String::new(),
        target_id: None,
        overrides: XChatOverrides::default(),
    };
    let unbind = match RelayClient::new(&config, session_token) {
        Ok(relay) => relay.unbind().await,
        Err(error) => Err(error),
    };
    if let Err(error) = unbind {
        state.emit_log(
            "warn",
            format!("Could not remove the X chat relay binding: {error}"),
        );
    }
}

async fn ensure_active_session(
    state: &AppState,
    expected_session_id: &str,
    expected_generation: u64,
) -> Result<()> {
    let coordinator = state.live_chat.lock().await;
    if coordinator.session_id() == Some(expected_session_id)
        && coordinator.session_generation() == expected_generation
    {
        return Ok(());
    }
    anyhow::bail!(
        "X live chat expected session {expected_session_id} generation {expected_generation}, but the active owner is {} generation {}.",
        coordinator.session_id().unwrap_or("none"),
        coordinator.session_generation(),
    )
}

fn next_reconnect_backoff_ms(current_ms: u64) -> u64 {
    current_ms
        .saturating_mul(2)
        .clamp(MIN_RECONNECT_BACKOFF_MS, MAX_RECONNECT_BACKOFF_MS)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn relay_event_to_message(
    event: RelayEvent,
    session_id: &str,
    target_id: Option<&str>,
) -> Option<LiveChatMessage> {
    let provider_message_id = non_empty(Some(event.message_id))?;
    if event.text.trim().is_empty() {
        return None;
    }
    let username = non_empty(event.author.username);
    let author_name = non_empty(event.author.name)
        .or_else(|| username.clone())
        .unwrap_or_else(|| "X viewer".to_string());
    // The XAA payload carries no timestamp; the relay's receive time is the
    // closest thing to when the comment was posted.
    let now = chrono::Utc::now().to_rfc3339();
    let published_at = non_empty(event.received_at).unwrap_or_else(|| now.clone());
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
        author_id: non_empty(event.author.id),
        author_name,
        author_avatar_url: non_empty(event.author.avatar_url)
            .filter(|url| url.starts_with("https://")),
        author_badges: Vec::new(),
        author_roles: if event.is_subscriber {
            vec!["member".to_string()]
        } else {
            Vec::new()
        },
        published_at,
        received_at: now,
        message_text: event.text,
        fragments: Vec::new(),
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: Some("x-broadcast-chat".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{delete, get, post};
    use axum::{Json, Router};
    use serde_json::Value;
    use tokio::sync::{Mutex, Notify, broadcast, oneshot};

    use crate::live_chat::{
        CommentsReadState, CommentsWriteState, LiveChatProviderConnectionState,
        LiveChatProviderState, current_status,
    };
    use crate::storage::Database;

    const SESSION_TOKEN: &str = "desktop-session-token";
    const WEBHOOK_ID: &str = "2090847910112202752";
    const X_USER_ID: &str = "742673143";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MockMode {
        Deliver,
        /// Reads with a cursor answer 500 this many times, then deliver.
        FailReads(usize),
        BindRejected,
        SignedOut,
        SubscriptionRejected,
        HangRead,
        WaitForRelease,
    }

    #[derive(Clone)]
    struct MockState {
        mode: MockMode,
        bind_calls: Arc<AtomicUsize>,
        bind_authorizations: Arc<Mutex<Vec<String>>>,
        read_calls: Arc<AtomicUsize>,
        read_queries: Arc<Mutex<Vec<std::collections::HashMap<String, String>>>>,
        unbind_calls: Arc<AtomicUsize>,
        subscriptions: Arc<Mutex<Vec<Value>>>,
        created_subscriptions: Arc<Mutex<Vec<Value>>>,
        deleted_subscriptions: Arc<Mutex<Vec<String>>>,
        release: Arc<Notify>,
    }

    struct MockServer {
        base_url: String,
        state: MockState,
        shutdown: oneshot::Sender<()>,
    }

    fn relay_error(status: StatusCode, code: &str) -> (StatusCode, Json<Value>) {
        (
            status,
            Json(json!({ "error": { "code": code, "message": code } })),
        )
    }

    fn bearer_is_valid(headers: &HeaderMap) -> bool {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some(&format!("Bearer {SESSION_TOKEN}"))
    }

    async fn mock_bind(
        State(state): State<MockState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        state.bind_calls.fetch_add(1, Ordering::SeqCst);
        if !bearer_is_valid(&headers) || state.mode == MockMode::SignedOut {
            return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        state.bind_authorizations.lock().await.push(
            body["authorization"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        );
        if state.mode == MockMode::BindRejected {
            return relay_error(StatusCode::FORBIDDEN, "x-chat-bind-rejected");
        }
        (
            StatusCode::OK,
            Json(json!({ "webhookId": WEBHOOK_ID, "xUserId": X_USER_ID, "xUsername": "orcdev" })),
        )
    }

    async fn mock_unbind(State(state): State<MockState>) -> Json<Value> {
        state.unbind_calls.fetch_add(1, Ordering::SeqCst);
        Json(json!({ "ok": true }))
    }

    fn relay_event(id: &str) -> Value {
        json!({
            "id": "42",
            "broadcastId": "1NGarompkEqJj",
            "messageId": id,
            "text": "hello from mocked x",
            "isSubscriber": true,
            "receivedAt": "2026-09-19T20:00:00.000Z",
            "author": {
                "id": "1461047860854759434",
                "username": "viewer",
                "name": "Viewer Name",
                "avatarUrl": "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
                "verifiedType": "blue"
            }
        })
    }

    async fn mock_read(
        State(state): State<MockState>,
        headers: HeaderMap,
        Query(query): Query<std::collections::HashMap<String, String>>,
    ) -> (StatusCode, Json<Value>) {
        if !bearer_is_valid(&headers) {
            return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        let after = query.get("after").cloned();
        state.read_queries.lock().await.push(query);
        let Some(after) = after else {
            return (
                StatusCode::OK,
                Json(json!({ "cursor": "41", "events": [] })),
            );
        };
        let call = state.read_calls.fetch_add(1, Ordering::SeqCst) + 1;
        match state.mode {
            MockMode::FailReads(failures) if call <= failures => {
                return relay_error(StatusCode::INTERNAL_SERVER_ERROR, "internal-error");
            }
            MockMode::HangRead => std::future::pending::<()>().await,
            MockMode::WaitForRelease => state.release.notified().await,
            _ => {}
        }
        if after == "41" {
            return (
                StatusCode::OK,
                Json(json!({ "cursor": "42", "events": [relay_event("message-1")] })),
            );
        }
        sleep(Duration::from_millis(10)).await;
        (
            StatusCode::OK,
            Json(json!({ "cursor": after, "events": [] })),
        )
    }

    async fn mock_list_subscriptions(
        State(state): State<MockState>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<Value>) {
        let signed = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("OAuth "));
        if !signed || state.mode == MockMode::SubscriptionRejected {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "title": "Unauthorized", "detail": "Unauthorized" })),
            );
        }
        let subscriptions = state.subscriptions.lock().await.clone();
        (StatusCode::OK, Json(json!({ "data": subscriptions })))
    }

    async fn mock_create_subscription(
        State(state): State<MockState>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state.created_subscriptions.lock().await.push(body.clone());
        let mut subscription = body;
        subscription["subscription_id"] = json!("new-subscription");
        state.subscriptions.lock().await.push(subscription.clone());
        Json(json!({ "data": { "subscription": subscription } }))
    }

    async fn mock_app_token(headers: HeaderMap) -> (StatusCode, Json<Value>) {
        let basic = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("Basic "));
        if !basic {
            return (StatusCode::FORBIDDEN, Json(json!({})));
        }
        (
            StatusCode::OK,
            Json(json!({ "token_type": "bearer", "access_token": "app-bearer" })),
        )
    }

    // The live API answers 503 to a user-context DELETE; only the app bearer
    // may delete a subscription.
    async fn mock_delete_subscription(
        State(state): State<MockState>,
        Path(subscription_id): Path<String>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<Value>) {
        if headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some("Bearer app-bearer")
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "title": "Service Unavailable" })),
            );
        }
        state
            .subscriptions
            .lock()
            .await
            .retain(|subscription| subscription["subscription_id"] != subscription_id.as_str());
        state
            .deleted_subscriptions
            .lock()
            .await
            .push(subscription_id);
        (StatusCode::OK, Json(json!({ "data": { "deleted": true } })))
    }

    async fn spawn_mock_server(mode: MockMode, subscriptions: Vec<Value>) -> MockServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock listener");
        let addr = listener.local_addr().expect("mock address");
        let state = MockState {
            mode,
            bind_calls: Arc::new(AtomicUsize::new(0)),
            bind_authorizations: Arc::new(Mutex::new(Vec::new())),
            read_calls: Arc::new(AtomicUsize::new(0)),
            read_queries: Arc::new(Mutex::new(Vec::new())),
            unbind_calls: Arc::new(AtomicUsize::new(0)),
            subscriptions: Arc::new(Mutex::new(subscriptions)),
            created_subscriptions: Arc::new(Mutex::new(Vec::new())),
            deleted_subscriptions: Arc::new(Mutex::new(Vec::new())),
            release: Arc::new(Notify::new()),
        };
        let app = Router::new()
            .route(RELAY_BIND_PATH, post(mock_bind).delete(mock_unbind))
            .route(RELAY_READ_PATH, get(mock_read))
            .route(
                "/2/activity/subscriptions",
                get(mock_list_subscriptions).post(mock_create_subscription),
            )
            .route("/oauth2/token", post(mock_app_token))
            .route(
                "/2/activity/subscriptions/{subscription_id}",
                delete(mock_delete_subscription),
            )
            .with_state(state.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        MockServer {
            base_url: format!("http://{addr}"),
            state,
            shutdown: shutdown_tx,
        }
    }

    fn test_credentials() -> XLivestreamCredentials {
        XLivestreamCredentials {
            consumer_key: "consumer-key".to_string(),
            consumer_secret: "consumer-secret".to_string(),
            access_token: format!("{X_USER_ID}-access-token"),
            access_token_secret: "access-token-secret".to_string(),
            user_id: X_USER_ID.to_string(),
            account_label: None,
            credential_source: "test".to_string(),
        }
    }

    fn mock_config(server: &MockServer) -> XChatConfig {
        XChatConfig {
            broadcast_id: "1NGarompkEqJj".to_string(),
            target_id: Some("x-target".to_string()),
            overrides: XChatOverrides {
                relay_base_url: Some(server.base_url.clone()),
                x_api_base_url: Some(server.base_url.clone()),
                session_token: Some(SESSION_TOKEN.to_string()),
                credentials: Some(test_credentials()),
            },
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

    async fn start_test_session(state: &AppState, session_id: &str) -> u64 {
        state
            .database
            .ensure_fake_live_chat_session(session_id)
            .unwrap();
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(session_id.to_string(), vec![x_provider_row()]);
        coordinator.session_generation()
    }

    async fn wait_until<F, Fut>(label: &str, mut condition: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !condition().await {
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for {label}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_message(state: &AppState, provider_message_id: &str) -> LiveChatMessage {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(message) = current_status(state)
                .await
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

    async fn wait_for_provider_state(
        state: &AppState,
        expected: LiveChatProviderConnectionState,
    ) -> LiveChatProviderState {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(provider) =
                current_status(state)
                    .await
                    .providers
                    .into_iter()
                    .find(|provider| {
                        provider.platform == StreamPlatform::X && provider.state == expected
                    })
            {
                return provider;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for X provider state {expected:?}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    fn failure_events(state: &AppState, session_id: &str) -> Vec<String> {
        state
            .database
            .list_health_events(session_id)
            .unwrap()
            .into_iter()
            .filter(|event| event.code == "x-live-chat-failed")
            .map(|event| event.message)
            .collect()
    }

    #[test]
    fn readiness_reports_available_path() {
        let readiness = x_chat_readiness(true);
        assert!(readiness.available);
        assert!(readiness.message.contains("read"));
        assert_eq!(readiness.evidence_checklist.len(), 3);
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_bounded() {
        assert_eq!(
            next_reconnect_backoff_ms(MIN_RECONNECT_BACKOFF_MS),
            MIN_RECONNECT_BACKOFF_MS * 2
        );
        assert_eq!(
            next_reconnect_backoff_ms(MAX_RECONNECT_BACKOFF_MS),
            MAX_RECONNECT_BACKOFF_MS
        );
        assert_eq!(next_reconnect_backoff_ms(0), MIN_RECONNECT_BACKOFF_MS);
    }

    #[test]
    fn renderer_params_cannot_redirect_the_relay_or_x_api() {
        // Older renderers still send the Periscope-era fields; they must be
        // tolerated, and no wire field may reach the override seam.
        let config: XChatConfig = serde_json::from_value(json!({
            "broadcastId": "1NGarompkEqJj",
            "mediaKey": "28_123",
            "targetId": "x-target",
            "statusBaseUrl": "https://evil.example",
            "accessUrl": "https://evil.example",
            "overrides": { "relayBaseUrl": "https://evil.example" },
            "relayBaseUrl": "https://evil.example"
        }))
        .unwrap();
        assert_eq!(config.broadcast_id, "1NGarompkEqJj");
        assert!(config.overrides.relay_base_url.is_none());
        assert!(config.overrides.x_api_base_url.is_none());
        assert!(config.overrides.session_token.is_none());
        assert!(config.overrides.credentials.is_none());
    }

    #[test]
    fn relay_event_maps_to_a_comment_row() {
        let event: RelayEvent = serde_json::from_value(relay_event("2090000000000000004")).unwrap();
        let message = relay_event_to_message(event, "session-1", Some("x-target")).unwrap();
        assert_eq!(message.provider_message_id, "2090000000000000004");
        assert_eq!(message.platform, StreamPlatform::X);
        assert_eq!(message.author_name, "Viewer Name");
        assert_eq!(message.author_id.as_deref(), Some("1461047860854759434"));
        assert_eq!(
            message.author_avatar_url.as_deref(),
            Some("https://pbs.twimg.com/profile_images/1/a_normal.jpg")
        );
        assert_eq!(message.author_roles, vec!["member".to_string()]);
        assert_eq!(message.published_at, "2026-09-19T20:00:00.000Z");
        assert_eq!(message.message_text, "hello from mocked x");

        let sparse: RelayEvent =
            serde_json::from_value(json!({ "messageId": "m2", "text": "hi" })).unwrap();
        let message = relay_event_to_message(sparse, "session-1", None).unwrap();
        assert_eq!(message.author_name, "X viewer");
        assert!(message.author_avatar_url.is_none());
        assert!(message.author_roles.is_empty());

        let handle_only: RelayEvent = serde_json::from_value(json!({
            "messageId": "m3",
            "text": "hi",
            "author": { "username": "viewer", "avatarUrl": "http://insecure/a.jpg" }
        }))
        .unwrap();
        let message = relay_event_to_message(handle_only, "session-1", None).unwrap();
        assert_eq!(message.author_name, "viewer");
        assert!(message.author_avatar_url.is_none());

        for blank in [
            json!({ "messageId": "m4", "text": "   " }),
            json!({ "messageId": " ", "text": "hi" }),
        ] {
            let event: RelayEvent = serde_json::from_value(blank).unwrap();
            assert!(relay_event_to_message(event, "session-1", None).is_none());
        }
    }

    #[tokio::test]
    async fn bind_subscribe_read_flow_delivers_a_comment() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            mock_config(&server),
        ));
        let message = wait_for_message(&state, "message-1").await;
        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Connected).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.session_id, "session-1");
        assert_eq!(message.author_name, "Viewer Name");
        assert_eq!(provider.message, "X live chat connected.");

        // Only a one-shot signed header is handed to the relay, never a token.
        let authorizations = server.state.bind_authorizations.lock().await;
        assert_eq!(authorizations.len(), 1);
        assert!(authorizations[0].starts_with("OAuth "));
        assert!(!authorizations[0].contains("access-token-secret"));
        assert!(!authorizations[0].contains("consumer-secret"));

        let created = server.state.created_subscriptions.lock().await;
        assert_eq!(
            *created,
            vec![json!({
                "event_type": "broadcast.chat",
                "filter": { "user_id": X_USER_ID },
                "webhook_id": WEBHOOK_ID,
                "tag": "videorc-live-chat",
            })]
        );

        let queries = server.state.read_queries.lock().await;
        assert!(!queries[0].contains_key("after"));
        assert_eq!(queries[1].get("after").map(String::as_str), Some("41"));
        assert!(
            queries
                .iter()
                .all(|query| query.get("broadcastId").map(String::as_str) == Some("1NGarompkEqJj"))
        );
        assert!(failure_events(&state, "session-1").is_empty());
    }

    #[tokio::test]
    async fn matching_subscription_is_reused_and_stale_ones_are_replaced() {
        let other_user = json!({
            "subscription_id": "other-user",
            "event_type": "broadcast.chat",
            "filter": { "user_id": "999" },
            "webhook_id": "old-webhook"
        });
        let other_event = json!({
            "subscription_id": "other-event",
            "event_type": "broadcast.start",
            "filter": { "user_id": X_USER_ID }
        });
        let matching = json!({
            "subscription_id": "matching",
            "event_type": "broadcast.chat",
            "filter": { "user_id": X_USER_ID },
            "webhook_id": WEBHOOK_ID
        });
        let webhookless = json!({
            "subscription_id": "webhookless",
            "event_type": "broadcast.chat",
            "filter": { "user_id": X_USER_ID }
        });
        let client = reqwest::Client::new();

        let server = spawn_mock_server(
            MockMode::Deliver,
            vec![
                other_user.clone(),
                other_event.clone(),
                webhookless.clone(),
                matching,
            ],
        )
        .await;
        let kept = crate::x_live::ensure_broadcast_chat_subscription(
            &client,
            &test_credentials(),
            &server.base_url,
            WEBHOOK_ID,
        )
        .await
        .unwrap();
        assert_eq!(kept, "matching");
        assert_eq!(
            *server.state.deleted_subscriptions.lock().await,
            vec!["webhookless".to_string()]
        );
        assert!(server.state.created_subscriptions.lock().await.is_empty());
        let _ = server.shutdown.send(());

        let server = spawn_mock_server(
            MockMode::Deliver,
            vec![other_user, other_event, webhookless],
        )
        .await;
        let created = crate::x_live::ensure_broadcast_chat_subscription(
            &client,
            &test_credentials(),
            &server.base_url,
            WEBHOOK_ID,
        )
        .await
        .unwrap();
        assert_eq!(created, "new-subscription");
        assert_eq!(
            *server.state.deleted_subscriptions.lock().await,
            vec!["webhookless".to_string()]
        );

        let removed = crate::x_live::delete_broadcast_chat_subscriptions(
            &client,
            &test_credentials(),
            &server.base_url,
        )
        .await
        .unwrap();
        assert_eq!(removed, 1);
        let remaining: Vec<String> = server
            .state
            .subscriptions
            .lock()
            .await
            .iter()
            .map(|subscription| {
                subscription["subscription_id"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(remaining, vec!["other-user", "other-event"]);
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn flapping_relay_reads_heal_without_an_outage_report() {
        let failures = FAILURE_REPORT_ATTEMPTS + 2;
        let server = spawn_mock_server(MockMode::FailReads(failures), Vec::new()).await;
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            mock_config(&server),
        ));
        let message = wait_for_message(&state, "message-1").await;
        wait_for_provider_state(&state, LiveChatProviderConnectionState::Connected).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.provider_message_id, "message-1");
        // Every attempt reached Connected before its read failed, so the
        // consecutive-failure counter kept resetting: a flapping relay is
        // not an outage report.
        assert!(failure_events(&state, "session-1").is_empty());
        assert!(server.state.bind_calls.load(Ordering::SeqCst) > failures);
    }

    #[tokio::test]
    async fn unreachable_relay_reports_the_outage_once_and_keeps_retrying() {
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;
        let mut config = mock_config(&spawn_mock_server(MockMode::Deliver, Vec::new()).await);
        config.overrides.relay_base_url = Some("http://127.0.0.1:9".to_string());

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            config,
        ));
        wait_until("outage report", || async {
            !failure_events(&state, "session-1").is_empty()
        })
        .await;
        // Still retrying after the report, and it is not repeated.
        sleep(Duration::from_millis(150)).await;
        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Reconnecting).await;
        assert!(!connector.is_finished());
        connector.abort();

        let events = failure_events(&state, "session-1");
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("keeps retrying"));
        assert!(provider.message.starts_with("Reconnecting to X live chat"));
    }

    #[tokio::test]
    async fn rejected_identity_proof_fails_terminally_without_retrying() {
        for (mode, expected) in [
            (MockMode::BindRejected, "re-authorize X Live"),
            (MockMode::SignedOut, "sign in again"),
            (MockMode::SubscriptionRejected, "re-authorize X Live"),
        ] {
            let server = spawn_mock_server(mode, Vec::new()).await;
            let state = test_state();
            let session_generation = start_test_session(&state, "session-1").await;

            tokio::time::timeout(
                Duration::from_secs(3),
                run_x_chat_connector(
                    state.clone(),
                    "session-1".to_string(),
                    session_generation,
                    mock_config(&server),
                ),
            )
            .await
            .expect("terminal failure stops the connector");
            let _ = server.shutdown.send(());

            let provider =
                wait_for_provider_state(&state, LiveChatProviderConnectionState::Failed).await;
            assert!(provider.message.contains(expected), "{}", provider.message);
            assert_eq!(server.state.bind_calls.load(Ordering::SeqCst), 1);
            assert_eq!(failure_events(&state, "session-1").len(), 1);
        }
    }

    #[tokio::test]
    async fn missing_videorc_sign_in_is_a_truthful_terminal_state() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;
        let mut config = mock_config(&server);
        config.overrides.session_token = Some("stale-token".to_string());

        tokio::time::timeout(
            Duration::from_secs(3),
            run_x_chat_connector(
                state.clone(),
                "session-1".to_string(),
                session_generation,
                config,
            ),
        )
        .await
        .expect("terminal failure stops the connector");
        let _ = server.shutdown.send(());

        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Failed).await;
        assert!(provider.message.contains("sign in again"));
    }

    #[tokio::test]
    async fn persistence_rejection_retries_the_held_message_without_a_new_read() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let state = test_state();
        // No session row yet: storage rejects the message as retryable.
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![x_provider_row()]);
            coordinator.session_generation()
        };

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            mock_config(&server),
        ));
        wait_for_provider_state(&state, LiveChatProviderConnectionState::Waiting).await;
        assert!(current_status(&state).await.messages.is_empty());
        let reads_while_waiting = server.state.read_calls.load(Ordering::SeqCst);
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let message = wait_for_message(&state, "message-1").await;
        wait_for_provider_state(&state, LiveChatProviderConnectionState::Connected).await;
        connector.abort();
        let _ = server.shutdown.send(());

        assert_eq!(message.provider_message_id, "message-1");
        assert_eq!(reads_while_waiting, 1);
        assert_eq!(server.state.bind_calls.load(Ordering::SeqCst), 1);
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
    async fn hanging_relay_read_reconnects_after_the_request_deadline() {
        let server = spawn_mock_server(MockMode::HangRead, Vec::new()).await;
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;

        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            mock_config(&server),
        ));
        wait_until("second bind after a hung read", || async {
            server.state.bind_calls.load(Ordering::SeqCst) >= 2
        })
        .await;
        connector.abort();
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn late_relay_traffic_cannot_attach_to_a_different_session() {
        let server = spawn_mock_server(MockMode::WaitForRelease, Vec::new()).await;
        let state = test_state();
        let session_generation = start_test_session(&state, "session-1").await;
        let connector = tokio::spawn(run_x_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            mock_config(&server),
        ));
        wait_until("held read", || async {
            server.state.read_calls.load(Ordering::SeqCst) >= 1
        })
        .await;

        let _ = start_test_session(&state, "session-2").await;
        server.state.release.notify_one();
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
