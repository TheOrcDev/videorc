//! Kick live chat (plan 063, S5).
//!
//! Kick delivers chat, live-status and follow events only through webhooks
//! signed with Kick's key, so they cannot terminate inside a desktop app. The
//! Videorc web relay receives them and this connector long-polls it:
//!
//! 1. prove the Kick identity to the relay (the relay calls Kick's fixed
//!    `GET /public/v1/users` once with the user token and drops it);
//! 2. make sure the three event subscriptions exist for this app, created
//!    with the user token (Kick infers the broadcaster), and remember their
//!    ids in the secret store so they can be deleted after a crash;
//! 3. long-poll the relay for the broadcaster's events.
//!
//! Sending goes straight to Kick (`POST /public/v1/chat`, scope `chat:write`).
//! Subscriptions are deleted when the session ends and when Kick is
//! disconnected.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::sleep;
use unicode_segmentation::UnicodeSegmentation;

use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, LiveChatProviderConnectionState,
    ProviderSendReceipt, live_chat_message_id, set_provider_and_emit, try_deliver_message,
};
use crate::live_chat_persistence::LiveChatPersistenceFailure;
use crate::state::AppState;
use crate::streaming::StreamPlatform;

const RELAY_BIND_PATH: &str = "/api/desktop/kick-chat/bind";
const RELAY_READ_PATH: &str = "/api/desktop/kick-chat";
const KICK_SUBSCRIPTIONS_PATH: &str = "/public/v1/events/subscriptions";
const KICK_CHAT_PATH: &str = "/public/v1/chat";
/// The events the relay understands, all version 1.
pub const KICK_SUBSCRIPTION_EVENTS: [&str; 3] = [
    "chat.message.sent",
    "livestream.status.updated",
    "channel.followed",
];
/// Kick's documented chat limits.
pub const KICK_CHAT_MAX_GRAPHEMES: usize = 500;
pub const KICK_CHAT_MAX_BYTES: usize = 2_048;
pub const KICK_EVENTS_SCOPE: &str = "events:subscribe";
pub const KICK_CHAT_WRITE_SCOPE: &str = "chat:write";
pub const KICK_RATE_LIMITED_MESSAGE: &str = "Kick is rate limiting messages, try again in a moment";

const FAILURE_REPORT_ATTEMPTS: usize = 8;
#[cfg(not(test))]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_millis(150);
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
const DEFAULT_KICK_API_BASE_URL: &str = "https://api.kick.com";
// Unit tests must never reach production hosts.
#[cfg(test)]
const DEFAULT_KICK_API_BASE_URL: &str = "http://127.0.0.1:9";

#[cfg(not(test))]
fn default_relay_base_url() -> String {
    crate::videorc_api::api_base_url()
}

#[cfg(test)]
fn default_relay_base_url() -> String {
    "http://127.0.0.1:9".to_string()
}

/// Serializes subscription create/delete across session start, session end
/// and disconnect, so a late cleanup never deletes the ids a new session just
/// reused.
static KICK_SUBSCRIPTION_LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn subscription_ids_secret_ref(account_id: &str) -> String {
    format!("platform:kick:{account_id}:event-subscriptions")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickChatConfig {
    pub access_token: String,
    /// Kick user id of the connected account (the provider account id).
    pub account_id: String,
    /// The channel whose chat is read; for a user token it is the same user.
    pub broadcaster_user_id: String,
    #[serde(default)]
    pub target_id: Option<String>,
    /// How the connector renews `access_token`; never from params.
    #[serde(skip)]
    pub token_source: crate::session_token::SessionTokenSource,
    /// Test seam. Never deserialized: a renderer must not be able to point
    /// the account bearer or the Kick token at another host.
    #[serde(skip)]
    pub overrides: KickChatOverrides,
}

#[derive(Debug, Clone, Default)]
pub struct KickChatOverrides {
    pub relay_base_url: Option<String>,
    pub kick_api_base_url: Option<String>,
    pub session_token: Option<String>,
}

/// The credentials the send path needs (captured at liveChat.start).
#[derive(Debug, Clone)]
pub struct KickChatSenderConfig {
    pub access_token: String,
    pub account_id: String,
    pub broadcaster_user_id: String,
    pub api_base_url: Option<String>,
    pub token_source: crate::session_token::SessionTokenSource,
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
    #[serde(default)]
    kind: String,
    message_id: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    received_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayChatPayload {
    #[serde(default)]
    content: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    replies_to_message_id: Option<String>,
    #[serde(default)]
    sender: RelaySender,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelaySender {
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    badges: Vec<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayFollowPayload {
    #[serde(default)]
    follower_id: Option<String>,
    #[serde(default)]
    follower_username: Option<String>,
}

/// Retrying cannot fix this; the user has to act (sign in, reconnect Kick).
#[derive(Debug)]
struct KickChatTerminalFailure(String);

impl std::fmt::Display for KickChatTerminalFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for KickChatTerminalFailure {}

fn terminal(message: impl Into<String>) -> anyhow::Error {
    KickChatTerminalFailure(message.into()).into()
}

/// A Kick API call that answered with an HTTP error.
#[derive(Debug)]
pub struct KickApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for KickApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Kick answered HTTP {}: {}",
            self.status, self.message
        )
    }
}

impl std::error::Error for KickApiError {}

fn kick_status(error: &anyhow::Error) -> Option<u16> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<KickApiError>())
        .map(|error| error.status)
}

async fn kick_api_error(response: reqwest::Response) -> anyhow::Error {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "request failed".to_string());
    KickApiError { status, message }.into()
}

fn kick_base(base_url: Option<&str>) -> String {
    base_url
        .unwrap_or(DEFAULT_KICK_API_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

// --- Subscription lifecycle -----------------------------------------------

/// Makes sure one webhook subscription exists for each relayed event and
/// returns all their ids. Existing ones are reused; only missing ones are
/// created. Errors carry [`KickApiError`] so callers can tell a refused token
/// (401) or missing scope (403) from a transient failure.
pub async fn ensure_kick_subscriptions(
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
) -> Result<Vec<String>> {
    let base = kick_base(api_base_url);
    let response = client
        .get(format!("{base}{KICK_SUBSCRIPTIONS_PATH}"))
        .bearer_auth(access_token)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .send()
        .await
        .context("Could not reach Kick to list event subscriptions.")?;
    if !response.status().is_success() {
        return Err(kick_api_error(response).await);
    }
    let body: Value = response
        .json()
        .await
        .context("Could not parse Kick's event subscriptions.")?;
    let mut ids = Vec::new();
    let mut present = Vec::new();
    for subscription in body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let event = subscription.get("event").and_then(Value::as_str);
        let method = subscription.get("method").and_then(Value::as_str);
        let id = subscription.get("id").and_then(Value::as_str);
        if let (Some(event), Some(id)) = (event, id)
            && KICK_SUBSCRIPTION_EVENTS.contains(&event)
            && method.is_none_or(|method| method == "webhook")
            && !present.contains(&event)
        {
            present.push(event);
            ids.push(id.to_string());
        }
    }
    let missing: Vec<&str> = KICK_SUBSCRIPTION_EVENTS
        .iter()
        .copied()
        .filter(|event| !present.contains(event))
        .collect();
    if missing.is_empty() {
        return Ok(ids);
    }
    let events: Vec<Value> = missing
        .iter()
        .map(|name| json!({ "name": name, "version": 1 }))
        .collect();
    let response = client
        .post(format!("{base}{KICK_SUBSCRIPTIONS_PATH}"))
        .bearer_auth(access_token)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .json(&json!({ "events": events, "method": "webhook" }))
        .send()
        .await
        .context("Could not reach Kick to create event subscriptions.")?;
    if !response.status().is_success() {
        return Err(kick_api_error(response).await);
    }
    let body: Value = response
        .json()
        .await
        .context("Could not parse Kick's new event subscriptions.")?;
    let mut failures = Vec::new();
    for created in body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = created
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("event");
        match (
            created
                .get("subscription_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty()),
            created
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.is_empty()),
        ) {
            (Some(id), None) => ids.push(id.to_string()),
            (_, Some(error)) => failures.push(format!("{name}: {error}")),
            (None, None) => failures.push(format!("{name}: no subscription id")),
        }
    }
    if !failures.is_empty() {
        anyhow::bail!(
            "Kick did not create every event subscription ({}).",
            failures.join("; ")
        );
    }
    Ok(ids)
}

/// Deletes subscriptions by id. A 404 means they are already gone.
pub async fn delete_kick_subscriptions(
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
    ids: &[String],
) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let base = kick_base(api_base_url);
    let query: Vec<(&str, &str)> = ids.iter().map(|id| ("id", id.as_str())).collect();
    let response = client
        .delete(format!("{base}{KICK_SUBSCRIPTIONS_PATH}"))
        .bearer_auth(access_token)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .query(&query)
        .send()
        .await
        .context("Could not reach Kick to delete event subscriptions.")?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    Err(kick_api_error(response).await)
}

fn stored_subscription_ids(account_id: &str) -> Vec<String> {
    crate::secrets::try_get_secret(&subscription_ids_secret_ref(account_id))
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .unwrap_or_default()
}

/// Remembers every id this account may still own (old ones included), so a
/// crash mid-stream never leaves a subscription nobody can find.
fn remember_subscription_ids(account_id: &str, ids: &[String]) -> Result<()> {
    let mut all = stored_subscription_ids(account_id);
    for id in ids {
        if !all.contains(id) {
            all.push(id.clone());
        }
    }
    crate::secrets::put_secret(
        &subscription_ids_secret_ref(account_id),
        &serde_json::to_string(&all)?,
    )
}

/// Deletes the stored subscriptions for an account and forgets them.
async fn delete_stored_subscriptions(
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
    account_id: &str,
) -> Result<()> {
    let ids = stored_subscription_ids(account_id);
    delete_kick_subscriptions(client, api_base_url, access_token, &ids).await?;
    crate::secrets::delete_secret(&subscription_ids_secret_ref(account_id))
}

// --- Connector ---------------------------------------------------------------

pub async fn run_kick_chat_connector(
    state: AppState,
    session_id: String,
    session_generation: u64,
    config: KickChatConfig,
) {
    if let Err(error) = ensure_active_session(&state, &session_id, session_generation).await {
        state.emit_log(
            "warn",
            format!("Rejected stale Kick live chat attachment: {error}"),
        );
        return;
    }
    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        StreamPlatform::Kick,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to Kick live chat.",
    )
    .await;

    let mut token = crate::session_token::SessionToken::new(
        config.access_token.clone(),
        config.token_source.clone(),
    );
    let mut failed_attempts = 0;
    let mut backoff_ms = MIN_RECONNECT_BACKOFF_MS;
    loop {
        let mut reached_ready = false;
        let error = match run_kick_chat_session(
            &state,
            &session_id,
            session_generation,
            &config,
            &mut token,
            &mut reached_ready,
        )
        .await
        {
            Ok(()) => anyhow::anyhow!("Kick live chat relay read ended."),
            Err(error) => error,
        };

        if ensure_active_session(&state, &session_id, session_generation)
            .await
            .is_err()
        {
            state.emit_log(
                "info",
                format!("Stopped stale Kick live chat connector for session {session_id}."),
            );
            return;
        }

        let storage_terminal = error
            .downcast_ref::<LiveChatPersistenceFailure>()
            .filter(|failure| failure.is_terminal())
            .map(|failure| {
                format!("Kick live chat stopped because comments storage failed: {failure}")
            });
        let terminal_message = storage_terminal.or_else(|| {
            error
                .downcast_ref::<KickChatTerminalFailure>()
                .map(ToString::to_string)
        });
        if let Some(message) = terminal_message {
            report_failure(&state, &session_id, &message);
            set_provider_and_emit(
                &state,
                &session_id,
                session_generation,
                StreamPlatform::Kick,
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
            report_failure(
                &state,
                &session_id,
                &format!(
                    "Kick live chat has failed {FAILURE_REPORT_ATTEMPTS} consecutive connection attempts and keeps retrying: {error}"
                ),
            );
        }
        set_provider_and_emit(
            &state,
            &session_id,
            session_generation,
            StreamPlatform::Kick,
            config.target_id.as_deref(),
            LiveChatProviderConnectionState::Reconnecting,
            &format!("Reconnecting to Kick live chat: {error}"),
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
        "kick-live-chat-failed",
        message,
    );
}

async fn run_kick_chat_session(
    state: &AppState,
    session_id: &str,
    session_generation: u64,
    config: &KickChatConfig,
    token: &mut crate::session_token::SessionToken,
    reached_ready: &mut bool,
) -> Result<()> {
    ensure_active_session(state, session_id, session_generation).await?;
    let session_token = config
        .overrides
        .session_token
        .clone()
        .or_else(crate::account::stored_session_token)
        .ok_or_else(|| terminal("Sign in to your Videorc account to receive Kick comments."))?;
    let relay = RelayClient::new(config.overrides.relay_base_url.clone(), session_token)?;
    let api_base = config.overrides.kick_api_base_url.as_deref();

    // Bind: the relay checks the token with Kick. A refusal gets one renewal.
    let access_token = token.ensure_fresh(state, &relay.http).await.to_string();
    match relay.bind(&access_token).await {
        Err(error) if error.downcast_ref::<BindRejected>().is_some() => {
            let renewed = token
                .renew_after_refusal(state, &relay.http)
                .await
                .map_err(|_| terminal(BIND_REJECTED_MESSAGE))?
                .to_string();
            relay.bind(&renewed).await.map_err(|error| {
                if error.downcast_ref::<BindRejected>().is_some() {
                    terminal(BIND_REJECTED_MESSAGE)
                } else {
                    error
                }
            })?;
        }
        other => {
            other?;
        }
    }
    ensure_active_session(state, session_id, session_generation).await?;

    {
        let _lifecycle = KICK_SUBSCRIPTION_LIFECYCLE.lock().await;
        let access_token = token.ensure_fresh(state, &relay.http).await.to_string();
        let ids = match ensure_kick_subscriptions(&relay.http, api_base, &access_token).await {
            Err(error) if kick_status(&error) == Some(401) => {
                let renewed = token
                    .renew_after_refusal(state, &relay.http)
                    .await
                    .map_err(|_| {
                        terminal("Kick refused the connection. Reconnect Kick to receive comments.")
                    })?
                    .to_string();
                ensure_kick_subscriptions(&relay.http, api_base, &renewed).await
            }
            other => other,
        }
        .map_err(|error| match kick_status(&error) {
            Some(401) | Some(403) => {
                terminal("Kick refused the chat subscription. Reconnect Kick to receive comments.")
            }
            _ => error,
        })?;
        if let Err(error) = remember_subscription_ids(&config.account_id, &ids) {
            state.emit_log(
                "warn",
                format!("Could not remember the Kick event subscription ids: {error}"),
            );
        }
    }
    ensure_active_session(state, session_id, session_generation).await?;

    // The first read carries no cursor: the relay answers "from now".
    let mut cursor = relay.read(None).await?.cursor;
    ensure_active_session(state, session_id, session_generation).await?;
    set_provider_and_emit(
        state,
        session_id,
        session_generation,
        StreamPlatform::Kick,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connected,
        "Kick live chat connected.",
    )
    .await;
    *reached_ready = true;

    loop {
        let page = relay.read(Some(&cursor)).await?;
        ensure_active_session(state, session_id, session_generation).await?;
        for event in page.events {
            let is_follow = event.kind == "follow";
            let Some(mut chat_message) =
                relay_event_to_message(event, session_id, config.target_id.as_deref())
            else {
                continue;
            };
            if let Some(parent_id) = chat_message
                .reply
                .as_ref()
                .map(|reply| reply.parent_message_id.clone())
            {
                chat_message.reply = crate::live_chat::find_reply_parent(
                    state,
                    StreamPlatform::Kick,
                    config.target_id.as_deref(),
                    &parent_id,
                )
                .await;
            }
            let delivered =
                deliver_durably(state, session_id, session_generation, config, chat_message)
                    .await?;
            if is_follow && delivered {
                crate::audience::record_follow(state, session_id, StreamPlatform::Kick);
            }
        }
        // Advance only after every message of the page is durable.
        cursor = page.cursor;
    }
}

/// Returns whether the message was new (a duplicate re-read is not).
async fn deliver_durably(
    state: &AppState,
    session_id: &str,
    session_generation: u64,
    config: &KickChatConfig,
    chat_message: LiveChatMessage,
) -> Result<bool> {
    let mut persistence_backoff_ms = MIN_RECONNECT_BACKOFF_MS;
    let mut waited_for_storage = false;
    let message_id = chat_message.id.clone();
    let already_seen = crate::live_chat::has_message(state, &message_id).await;
    loop {
        match try_deliver_message(state, session_generation, chat_message.clone()).await {
            Ok(()) => break,
            Err(error) if error.is_terminal() => return Err(error.into()),
            Err(error) => {
                waited_for_storage = true;
                set_provider_and_emit(
                    state,
                    session_id,
                    session_generation,
                    StreamPlatform::Kick,
                    config.target_id.as_deref(),
                    LiveChatProviderConnectionState::Waiting,
                    &format!(
                        "Waiting for comments storage before accepting more Kick messages: {error}"
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
            StreamPlatform::Kick,
            config.target_id.as_deref(),
            LiveChatProviderConnectionState::Connected,
            "Kick live chat connected; comments storage recovered.",
        )
        .await;
    }
    Ok(!already_seen)
}

const BIND_REJECTED_MESSAGE: &str =
    "Kick did not confirm this account. Reconnect Kick to receive Kick comments.";

#[derive(Debug)]
struct BindRejected;

impl std::fmt::Display for BindRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(BIND_REJECTED_MESSAGE)
    }
}

impl std::error::Error for BindRejected {}

struct RelayClient {
    base_url: String,
    session_token: String,
    http: reqwest::Client,
}

impl RelayClient {
    fn new(base_url: Option<String>, session_token: String) -> Result<Self> {
        Ok(Self {
            base_url: base_url
                .unwrap_or_else(default_relay_base_url)
                .trim_end_matches('/')
                .to_string(),
            session_token,
            http: reqwest::Client::builder()
                .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .context("Could not build the Kick chat relay HTTP client.")?,
        })
    }

    async fn bind(&self, access_token: &str) -> Result<Value> {
        let response = self
            .http
            .post(format!("{}{RELAY_BIND_PATH}", self.base_url))
            .bearer_auth(&self.session_token)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .json(&json!({ "accessToken": access_token }))
            .send()
            .await
            .context("Could not reach the Videorc Kick chat relay.")?;
        Self::parse(response).await
    }

    async fn read(&self, after: Option<&str>) -> Result<RelayPage> {
        let mut query = vec![("waitMs", RELAY_READ_WAIT_MS.to_string())];
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
            .context("Could not read from the Videorc Kick chat relay.")?;
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
            .context("Could not reach the Videorc Kick chat relay.")?;
        if !response.status().is_success() {
            anyhow::bail!(
                "Kick chat relay unbind failed with HTTP {}",
                response.status()
            );
        }
        Ok(())
    }

    async fn parse<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
        let status = response.status();
        if status.is_success() {
            return response
                .json::<T>()
                .await
                .context("Could not parse the Kick chat relay response.");
        }
        let (code, message) = crate::videorc_api::read_error_code_and_message(response).await;
        match code.as_str() {
            "unauthorized" => Err(terminal(
                "Your Videorc sign-in expired. Sign in again to receive Kick comments.",
            )),
            "kick-chat-bind-rejected" => Err(BindRejected.into()),
            _ if status.as_u16() == 401 => Err(terminal(
                "Your Videorc sign-in expired. Sign in again to receive Kick comments.",
            )),
            // Relay not configured, binding lost, 5xx: can heal on its own.
            _ => anyhow::bail!("Kick chat relay answered HTTP {status} ({code}): {message}"),
        }
    }
}

/// After a session ends: delete this account's event subscriptions and the
/// relay binding, unless a new Kick session already took them over.
pub async fn end_kick_chat_session(state: AppState, account_id: String) {
    let _lifecycle = KICK_SUBSCRIPTION_LIFECYCLE.lock().await;
    if state.live_chat.lock().await.has_kick_sender() {
        return;
    }
    let client = crate::oauth::provider_http_client();
    match crate::session_platform_access_token(
        &state,
        StreamPlatform::Kick,
        Some(&account_id),
        &client,
        None,
    )
    .await
    {
        Ok(token) => {
            if let Err(error) =
                delete_stored_subscriptions(&client, None, &token, &account_id).await
            {
                state.emit_log(
                    "warn",
                    format!("Could not remove the Kick event subscriptions: {error}"),
                );
            }
        }
        Err(error) => state.emit_log(
            "warn",
            format!("Could not remove the Kick event subscriptions: {error}"),
        ),
    }
    unbind_relay(&state, None).await;
}

/// Best-effort cleanup when the user disconnects Kick. `access_token` must be
/// read before the local token is deleted (and before it is revoked).
pub async fn forget_kick_chat_relay(state: AppState, access_token: String, account_id: String) {
    let _lifecycle = KICK_SUBSCRIPTION_LIFECYCLE.lock().await;
    let client = crate::oauth::provider_http_client();
    if let Err(error) = delete_stored_subscriptions(&client, None, &access_token, &account_id).await
    {
        state.emit_log(
            "warn",
            format!("Could not remove the Kick event subscriptions: {error}"),
        );
    }
    unbind_relay(&state, None).await;
}

async fn unbind_relay(state: &AppState, base_url: Option<String>) {
    let Some(session_token) = crate::account::stored_session_token() else {
        return;
    };
    let unbind = match RelayClient::new(base_url, session_token) {
        Ok(relay) => relay.unbind().await,
        Err(error) => Err(error),
    };
    if let Err(error) = unbind {
        state.emit_log(
            "warn",
            format!("Could not remove the Kick chat relay binding: {error}"),
        );
    }
}

// --- Sending -------------------------------------------------------------------

/// Checks Kick's length limits before any network.
pub fn validate_kick_chat_text(text: &str) -> Result<(), String> {
    if text.graphemes(true).count() > KICK_CHAT_MAX_GRAPHEMES || text.len() > KICK_CHAT_MAX_BYTES {
        return Err(format!(
            "Kick limits chat messages to {KICK_CHAT_MAX_GRAPHEMES} characters. Shorten the message to reach Kick."
        ));
    }
    Ok(())
}

/// Send one chat message as the connected user.
pub async fn send_kick_chat_message(
    client: &reqwest::Client,
    config: &KickChatSenderConfig,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    validate_kick_chat_text(text)?;
    let broadcaster_user_id = config
        .broadcaster_user_id
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(config.broadcaster_user_id.clone()));
    let base = kick_base(config.api_base_url.as_deref());
    let response = client
        .post(format!("{base}{KICK_CHAT_PATH}"))
        .bearer_auth(&config.access_token)
        .json(&json!({
            "content": text,
            "type": "user",
            "broadcaster_user_id": broadcaster_user_id,
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Kick: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read Kick's send response: {error}"))?;
    if status.is_success() {
        let body = serde_json::from_slice::<Value>(&bytes)
            .map_err(|error| format!("Kick returned an unreadable send response: {error}"))?;
        let data = body.get("data").unwrap_or(&Value::Null);
        if !data
            .get("is_sent")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err("Kick did not send the message.".to_string());
        }
        let provider_message_id = data
            .get("message_id")
            .and_then(|id| {
                id.as_str()
                    .map(str::to_string)
                    .or_else(|| id.as_u64().map(|id| id.to_string()))
            })
            .filter(|id| !id.trim().is_empty());
        return Ok(ProviderSendReceipt {
            provider_message_id,
        });
    }
    let message = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Err(match status.as_u16() {
        401 | 403 => {
            "Kick rejected the send. Reconnect Kick to send chat from Videorc.".to_string()
        }
        429 => KICK_RATE_LIMITED_MESSAGE.to_string(),
        _ => message
            .map(|message| format!("Kick send failed ({status}): {message}"))
            .unwrap_or_else(|| format!("Kick send failed ({status}).")),
    })
}

// --- Mapping ---------------------------------------------------------------------

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
        "Kick live chat expected session {expected_session_id} generation {expected_generation}, but the active owner is {} generation {}.",
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

/// Kick badge texts ("Broadcaster", "Sub Gifter") as kebab ids.
fn badge_id(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

fn roles_from_badges(badges: &[String]) -> Vec<String> {
    let mut roles = Vec::new();
    for badge in badges {
        let role = match badge.as_str() {
            "broadcaster" => "owner",
            "moderator" => "moderator",
            "vip" => "vip",
            "subscriber" | "founder" => "member",
            _ => continue,
        };
        if !roles.iter().any(|held| held == role) {
            roles.push(role.to_string());
        }
    }
    roles
}

fn relay_event_to_message(
    event: RelayEvent,
    session_id: &str,
    target_id: Option<&str>,
) -> Option<LiveChatMessage> {
    let now = chrono::Utc::now().to_rfc3339();
    let received_at = non_empty(event.received_at.clone()).unwrap_or_else(|| now.clone());
    let base = |provider_message_id: String| LiveChatMessage {
        id: live_chat_message_id(
            session_id,
            StreamPlatform::Kick,
            target_id,
            &provider_message_id,
        ),
        provider_message_id,
        platform: StreamPlatform::Kick,
        target_id: target_id.map(ToOwned::to_owned),
        session_id: session_id.to_string(),
        author_id: None,
        author_name: "Kick viewer".to_string(),
        author_avatar_url: None,
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at: received_at.clone(),
        received_at: now.clone(),
        message_text: String::new(),
        fragments: Vec::new(),
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: None,
        details: None,
        reply: None,
        first_message: false,
    };
    match event.kind.as_str() {
        "chat" => {
            let payload: RelayChatPayload = serde_json::from_value(event.payload).ok()?;
            if payload.content.trim().is_empty() {
                return None;
            }
            let provider_message_id =
                non_empty(payload.message_id).or_else(|| non_empty(Some(event.message_id)))?;
            let mut message = base(provider_message_id);
            let badges: Vec<String> = payload
                .sender
                .badges
                .iter()
                .map(|badge| badge_id(badge))
                .filter(|badge| !badge.is_empty())
                .collect();
            message.author_id = non_empty(payload.sender.id);
            message.author_name =
                non_empty(payload.sender.username).unwrap_or_else(|| "Kick viewer".to_string());
            message.author_avatar_url =
                non_empty(payload.sender.avatar_url).filter(|url| url.starts_with("https://"));
            message.author_roles = roles_from_badges(&badges);
            message.author_badges = badges;
            if let Some(created_at) = non_empty(payload.created_at) {
                message.published_at = created_at;
            }
            message.message_text = payload.content;
            // Only the id is relayed; the connector fills the parent from
            // this session's rows, or drops the reply when it is not there.
            message.reply = non_empty(payload.replies_to_message_id).map(|parent_message_id| {
                crate::live_chat::LiveChatReply {
                    parent_message_id,
                    parent_author_name: String::new(),
                    parent_text: String::new(),
                }
            });
            message.raw_provider_type = Some("chat.message.sent".to_string());
            Some(message)
        }
        "follow" => {
            let payload: RelayFollowPayload = serde_json::from_value(event.payload).ok()?;
            let mut message = base(non_empty(Some(event.message_id))?);
            let name =
                non_empty(payload.follower_username).unwrap_or_else(|| "Kick viewer".to_string());
            message.author_id = non_empty(payload.follower_id);
            message.message_text = format!("{name} followed");
            message.author_name = name;
            message.event_type = LiveChatEventType::Follow;
            message.details = Some(LiveChatEventDetails::Follow);
            message.raw_provider_type = Some("channel.followed".to_string());
            Some(message)
        }
        // The model has no live/ended event; the session state already knows.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::{Query, RawQuery, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use tokio::sync::{Mutex, broadcast, oneshot};

    use crate::live_chat::{
        CommentsReadState, CommentsWriteState, LiveChatProviderState, current_status,
    };
    use crate::storage::Database;

    const SESSION_TOKEN: &str = "desktop-session-token";
    const KICK_TOKEN: &str = "kick-user-token";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MockMode {
        Deliver,
        FailReads(usize),
        BindRejected,
        SignedOut,
        SubscriptionForbidden,
    }

    #[derive(Clone)]
    struct MockState {
        mode: MockMode,
        bind_bodies: Arc<Mutex<Vec<Value>>>,
        read_calls: Arc<AtomicUsize>,
        read_queries: Arc<Mutex<Vec<std::collections::HashMap<String, String>>>>,
        unbind_calls: Arc<AtomicUsize>,
        subscriptions: Arc<Mutex<Vec<Value>>>,
        created: Arc<Mutex<Vec<Value>>>,
        deleted_queries: Arc<Mutex<Vec<String>>>,
        chat_bodies: Arc<Mutex<Vec<Value>>>,
        chat_status: StatusCode,
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

    fn bearer(headers: &HeaderMap) -> Option<String> {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_string)
    }

    async fn mock_bind(
        State(state): State<MockState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        if bearer(&headers).as_deref() != Some(SESSION_TOKEN) || state.mode == MockMode::SignedOut {
            return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        state.bind_bodies.lock().await.push(body);
        if state.mode == MockMode::BindRejected {
            return relay_error(StatusCode::FORBIDDEN, "kick-chat-bind-rejected");
        }
        (
            StatusCode::OK,
            Json(json!({ "kickUserId": "4242", "kickUsername": "orcdev" })),
        )
    }

    async fn mock_unbind(State(state): State<MockState>) -> Json<Value> {
        state.unbind_calls.fetch_add(1, Ordering::SeqCst);
        Json(json!({ "ok": true }))
    }

    fn chat_event(id: &str) -> Value {
        json!({
            "id": "42",
            "kind": "chat",
            "messageId": format!("delivery-{id}"),
            "receivedAt": "2026-09-25T20:00:01.000Z",
            "payload": {
                "content": "hello from kick",
                "createdAt": "2026-09-25T20:00:00.000Z",
                "emotes": [],
                "messageId": id,
                "repliesToMessageId": null,
                "sender": {
                    "avatarUrl": "https://files.kick.com/images/user/1/profile_image/a.webp",
                    "badges": ["Moderator", "Subscriber"],
                    "id": "777",
                    "username": "viewer",
                    "usernameColor": "#FF0000"
                }
            }
        })
    }

    async fn mock_read(
        State(state): State<MockState>,
        headers: HeaderMap,
        Query(query): Query<std::collections::HashMap<String, String>>,
    ) -> (StatusCode, Json<Value>) {
        if bearer(&headers).as_deref() != Some(SESSION_TOKEN) {
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
        if let MockMode::FailReads(failures) = state.mode
            && call <= failures
        {
            return relay_error(StatusCode::INTERNAL_SERVER_ERROR, "internal-error");
        }
        if after == "41" {
            return (
                StatusCode::OK,
                Json(json!({
                    "cursor": "44",
                    "events": [
                        chat_event("message-1"),
                        { "id": "43", "kind": "status", "messageId": "status-1",
                          "payload": { "isLive": true, "title": "t", "startedAt": null, "endedAt": null } },
                        { "id": "44", "kind": "follow", "messageId": "follow-1",
                          "payload": { "followerId": "888", "followerUsername": "new_friend" } }
                    ]
                })),
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
        if bearer(&headers).as_deref() != Some(KICK_TOKEN) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "message": "Unauthorized" })),
            );
        }
        if state.mode == MockMode::SubscriptionForbidden {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "message": "Forbidden" })),
            );
        }
        let data = state.subscriptions.lock().await.clone();
        (StatusCode::OK, Json(json!({ "data": data })))
    }

    async fn mock_create_subscriptions(
        State(state): State<MockState>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state.created.lock().await.push(body.clone());
        let mut data = Vec::new();
        for event in body["events"].as_array().cloned().unwrap_or_default() {
            let name = event["name"].as_str().unwrap_or_default().to_string();
            let id = format!("sub-{name}");
            state.subscriptions.lock().await.push(json!({
                "id": id, "app_id": "app", "broadcaster_user_id": 4242,
                "event": name, "version": 1, "method": "webhook",
                "created_at": "2026-09-25T20:00:00Z", "updated_at": "2026-09-25T20:00:00Z"
            }));
            data.push(json!({ "name": name, "version": 1, "subscription_id": id }));
        }
        Json(json!({ "data": data }))
    }

    async fn mock_delete_subscriptions(
        State(state): State<MockState>,
        RawQuery(query): RawQuery,
    ) -> StatusCode {
        let query = query.unwrap_or_default();
        state.subscriptions.lock().await.retain(|subscription| {
            !query.contains(&format!("id={}", subscription["id"].as_str().unwrap_or("")))
        });
        state.deleted_queries.lock().await.push(query);
        StatusCode::NO_CONTENT
    }

    async fn mock_chat(
        State(state): State<MockState>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        state.chat_bodies.lock().await.push(body);
        if state.chat_status != StatusCode::OK {
            return (state.chat_status, Json(json!({ "message": "nope" })));
        }
        (
            StatusCode::OK,
            Json(
                json!({ "data": { "is_sent": true, "message_id": "kick-sent-1" }, "message": "OK" }),
            ),
        )
    }

    async fn spawn_mock_server_with(
        mode: MockMode,
        subscriptions: Vec<Value>,
        chat_status: StatusCode,
    ) -> MockServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock listener");
        let addr = listener.local_addr().expect("mock address");
        let state = MockState {
            mode,
            bind_bodies: Arc::new(Mutex::new(Vec::new())),
            read_calls: Arc::new(AtomicUsize::new(0)),
            read_queries: Arc::new(Mutex::new(Vec::new())),
            unbind_calls: Arc::new(AtomicUsize::new(0)),
            subscriptions: Arc::new(Mutex::new(subscriptions)),
            created: Arc::new(Mutex::new(Vec::new())),
            deleted_queries: Arc::new(Mutex::new(Vec::new())),
            chat_bodies: Arc::new(Mutex::new(Vec::new())),
            chat_status,
        };
        let app = Router::new()
            .route(RELAY_BIND_PATH, post(mock_bind).delete(mock_unbind))
            .route(RELAY_READ_PATH, get(mock_read))
            .route(
                KICK_SUBSCRIPTIONS_PATH,
                get(mock_list_subscriptions)
                    .post(mock_create_subscriptions)
                    .delete(mock_delete_subscriptions),
            )
            .route(KICK_CHAT_PATH, post(mock_chat))
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

    async fn spawn_mock_server(mode: MockMode, subscriptions: Vec<Value>) -> MockServer {
        spawn_mock_server_with(mode, subscriptions, StatusCode::OK).await
    }

    fn mock_config(server: &MockServer, account_id: &str) -> KickChatConfig {
        KickChatConfig {
            access_token: KICK_TOKEN.to_string(),
            account_id: account_id.to_string(),
            broadcaster_user_id: "4242".to_string(),
            target_id: Some("kick-target".to_string()),
            token_source: Default::default(),
            overrides: KickChatOverrides {
                relay_base_url: Some(server.base_url.clone()),
                kick_api_base_url: Some(server.base_url.clone()),
                session_token: Some(SESSION_TOKEN.to_string()),
            },
        }
    }

    fn sender_config(server: &MockServer) -> KickChatSenderConfig {
        KickChatSenderConfig {
            access_token: KICK_TOKEN.to_string(),
            account_id: "4242".to_string(),
            broadcaster_user_id: "4242".to_string(),
            api_base_url: Some(server.base_url.clone()),
            token_source: Default::default(),
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

    fn kick_provider_row() -> LiveChatProviderState {
        LiveChatProviderState {
            id: "kick-target".to_string(),
            platform: StreamPlatform::Kick,
            target_id: Some("kick-target".to_string()),
            account_id: Some("kick-account".to_string()),
            account_label: Some("Kick Account".to_string()),
            read: CommentsReadState::Connecting,
            write: CommentsWriteState::Ready,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting to Kick live chat.".to_string(),
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
        coordinator.start_session(session_id.to_string(), vec![kick_provider_row()]);
        coordinator.session_generation()
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
                "timed out waiting for Kick message {provider_message_id}"
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
                        provider.platform == StreamPlatform::Kick && provider.state == expected
                    })
            {
                return provider;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for Kick provider state {expected:?}"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn renderer_params_cannot_redirect_the_relay_or_kick_api() {
        let config: KickChatConfig = serde_json::from_value(json!({
            "accessToken": "t",
            "accountId": "4242",
            "broadcasterUserId": "4242",
            "overrides": { "relayBaseUrl": "https://evil.example" },
            "relayBaseUrl": "https://evil.example"
        }))
        .unwrap();
        assert!(config.overrides.relay_base_url.is_none());
        assert!(config.overrides.kick_api_base_url.is_none());
        assert!(config.overrides.session_token.is_none());
    }

    #[test]
    fn relay_rows_map_to_comment_and_follow_rows() {
        let event: RelayEvent = serde_json::from_value(chat_event("m1")).unwrap();
        let message = relay_event_to_message(event, "s1", Some("kick-target")).unwrap();
        assert_eq!(message.provider_message_id, "m1");
        assert_eq!(message.platform, StreamPlatform::Kick);
        assert_eq!(message.author_name, "viewer");
        assert_eq!(message.author_id.as_deref(), Some("777"));
        assert_eq!(
            message.author_badges,
            vec!["moderator".to_string(), "subscriber".to_string()]
        );
        assert_eq!(
            message.author_roles,
            vec!["moderator".to_string(), "member".to_string()]
        );
        assert_eq!(message.published_at, "2026-09-25T20:00:00.000Z");
        assert!(message.author_avatar_url.unwrap().starts_with("https://"));
        assert!(message.reply.is_none());

        let mut reply = chat_event("m2");
        reply["payload"]["repliesToMessageId"] = json!("m1");
        reply["payload"]["sender"]["avatarUrl"] = json!("http://insecure/a.png");
        let message =
            relay_event_to_message(serde_json::from_value(reply).unwrap(), "s1", None).unwrap();
        assert_eq!(message.reply.unwrap().parent_message_id, "m1");
        assert!(message.author_avatar_url.is_none());

        let follow: RelayEvent = serde_json::from_value(json!({
            "kind": "follow", "messageId": "f1",
            "payload": { "followerId": "9", "followerUsername": "fan" }
        }))
        .unwrap();
        let message = relay_event_to_message(follow, "s1", None).unwrap();
        assert_eq!(message.event_type, LiveChatEventType::Follow);
        assert_eq!(message.details, Some(LiveChatEventDetails::Follow));
        assert_eq!(message.author_name, "fan");

        for ignored in [
            json!({ "kind": "status", "messageId": "s", "payload": { "isLive": false } }),
            json!({ "kind": "chat", "messageId": "c", "payload": { "content": "  " } }),
            json!({ "kind": "mystery", "messageId": "x", "payload": {} }),
        ] {
            let event: RelayEvent = serde_json::from_value(ignored).unwrap();
            assert!(relay_event_to_message(event, "s1", None).is_none());
        }
    }

    #[test]
    fn kick_length_limits_count_graphemes_and_bytes() {
        assert!(validate_kick_chat_text(&"a".repeat(500)).is_ok());
        assert!(validate_kick_chat_text(&"a".repeat(501)).is_err());
        // One family emoji is one grapheme but many bytes.
        let family = "👨‍👩‍👧‍👦";
        assert!(validate_kick_chat_text(&family.repeat(90)).is_err());
        assert!(validate_kick_chat_text(&family.repeat(50)).is_ok());
    }

    #[tokio::test]
    async fn bind_subscribe_read_flow_delivers_comments_and_follows() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let state = test_state();
        let generation = start_test_session(&state, "session-1").await;
        let connector = tokio::spawn(run_kick_chat_connector(
            state.clone(),
            "session-1".to_string(),
            generation,
            mock_config(&server, "kick-flow"),
        ));
        let message = wait_for_message(&state, "message-1").await;
        let follow = wait_for_message(&state, "follow-1").await;
        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Connected).await;
        connector.abort();

        assert_eq!(message.message_text, "hello from kick");
        assert_eq!(follow.event_type, LiveChatEventType::Follow);
        assert_eq!(provider.message, "Kick live chat connected.");
        assert_eq!(
            *server.state.bind_bodies.lock().await,
            vec![json!({ "accessToken": KICK_TOKEN })]
        );
        let created = server.state.created.lock().await.clone();
        assert_eq!(
            created,
            vec![json!({
                "events": [
                    { "name": "chat.message.sent", "version": 1 },
                    { "name": "livestream.status.updated", "version": 1 },
                    { "name": "channel.followed", "version": 1 }
                ],
                "method": "webhook"
            })]
        );
        assert_eq!(
            stored_subscription_ids("kick-flow"),
            vec![
                "sub-chat.message.sent".to_string(),
                "sub-livestream.status.updated".to_string(),
                "sub-channel.followed".to_string()
            ]
        );
        let queries = server.state.read_queries.lock().await;
        assert!(!queries[0].contains_key("after"));
        assert_eq!(queries[1].get("after").map(String::as_str), Some("41"));
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn existing_subscriptions_are_reused_and_only_missing_ones_created() {
        let existing = json!({
            "id": "old-chat", "app_id": "app", "broadcaster_user_id": 4242,
            "event": "chat.message.sent", "version": 1, "method": "webhook",
            "created_at": "x", "updated_at": "x"
        });
        let server = spawn_mock_server(MockMode::Deliver, vec![existing]).await;
        let client = reqwest::Client::new();
        let ids = ensure_kick_subscriptions(&client, Some(&server.base_url), KICK_TOKEN)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec![
                "old-chat".to_string(),
                "sub-livestream.status.updated".to_string(),
                "sub-channel.followed".to_string()
            ]
        );
        let created = server.state.created.lock().await.clone();
        assert_eq!(created[0]["events"].as_array().unwrap().len(), 2);

        // A second ensure creates nothing.
        let again = ensure_kick_subscriptions(&client, Some(&server.base_url), KICK_TOKEN)
            .await
            .unwrap();
        assert_eq!(again.len(), 3);
        assert_eq!(server.state.created.lock().await.len(), 1);

        delete_kick_subscriptions(&client, Some(&server.base_url), KICK_TOKEN, &again)
            .await
            .unwrap();
        assert_eq!(
            server.state.deleted_queries.lock().await[0],
            "id=old-chat&id=sub-livestream.status.updated&id=sub-channel.followed"
        );
        assert!(server.state.subscriptions.lock().await.is_empty());
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn stored_subscriptions_are_deleted_and_forgotten() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let client = reqwest::Client::new();
        remember_subscription_ids("kick-cleanup", &["a".to_string(), "b".to_string()]).unwrap();
        remember_subscription_ids("kick-cleanup", &["b".to_string(), "c".to_string()]).unwrap();
        assert_eq!(stored_subscription_ids("kick-cleanup"), vec!["a", "b", "c"]);
        delete_stored_subscriptions(&client, Some(&server.base_url), KICK_TOKEN, "kick-cleanup")
            .await
            .unwrap();
        assert_eq!(
            server.state.deleted_queries.lock().await[0],
            "id=a&id=b&id=c"
        );
        assert!(stored_subscription_ids("kick-cleanup").is_empty());
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn missing_events_scope_fails_terminally() {
        let server = spawn_mock_server(MockMode::SubscriptionForbidden, Vec::new()).await;
        let state = test_state();
        let generation = start_test_session(&state, "session-1").await;
        run_kick_chat_connector(
            state.clone(),
            "session-1".to_string(),
            generation,
            mock_config(&server, "kick-forbidden"),
        )
        .await;
        let provider =
            wait_for_provider_state(&state, LiveChatProviderConnectionState::Failed).await;
        assert!(provider.message.contains("Reconnect Kick"));
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn rejected_identity_and_signed_out_fail_terminally() {
        for (mode, expected) in [
            (MockMode::BindRejected, "Reconnect Kick"),
            (MockMode::SignedOut, "Sign in again"),
        ] {
            let server = spawn_mock_server(mode, Vec::new()).await;
            let state = test_state();
            let generation = start_test_session(&state, "session-1").await;
            run_kick_chat_connector(
                state.clone(),
                "session-1".to_string(),
                generation,
                mock_config(&server, "kick-rejected"),
            )
            .await;
            let provider =
                wait_for_provider_state(&state, LiveChatProviderConnectionState::Failed).await;
            assert!(provider.message.contains(expected), "{}", provider.message);
            let _ = server.shutdown.send(());
        }
    }

    #[tokio::test]
    async fn flapping_relay_reads_heal() {
        let server = spawn_mock_server(MockMode::FailReads(2), Vec::new()).await;
        let state = test_state();
        let generation = start_test_session(&state, "session-1").await;
        let connector = tokio::spawn(run_kick_chat_connector(
            state.clone(),
            "session-1".to_string(),
            generation,
            mock_config(&server, "kick-flap"),
        ));
        let message = wait_for_message(&state, "message-1").await;
        connector.abort();
        assert_eq!(message.author_name, "viewer");
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn send_posts_the_documented_body_and_returns_the_message_id() {
        let server = spawn_mock_server(MockMode::Deliver, Vec::new()).await;
        let client = reqwest::Client::new();
        let receipt = send_kick_chat_message(&client, &sender_config(&server), "hi chat")
            .await
            .unwrap();
        assert_eq!(receipt.provider_message_id.as_deref(), Some("kick-sent-1"));
        assert_eq!(
            server.state.chat_bodies.lock().await[0],
            json!({ "content": "hi chat", "type": "user", "broadcaster_user_id": 4242 })
        );
        let _ = server.shutdown.send(());
    }

    #[tokio::test]
    async fn send_failures_are_honest_receipts() {
        for (status, expected) in [
            (StatusCode::TOO_MANY_REQUESTS, KICK_RATE_LIMITED_MESSAGE),
            (StatusCode::UNAUTHORIZED, "Reconnect Kick"),
            (StatusCode::INTERNAL_SERVER_ERROR, "Kick send failed"),
        ] {
            let server = spawn_mock_server_with(MockMode::Deliver, Vec::new(), status).await;
            let error =
                send_kick_chat_message(&reqwest::Client::new(), &sender_config(&server), "hi")
                    .await
                    .unwrap_err();
            assert!(error.contains(expected), "{error}");
            let _ = server.shutdown.send(());
        }
        // Too long: rejected before any network.
        let config = KickChatSenderConfig {
            access_token: String::new(),
            account_id: String::new(),
            broadcaster_user_id: "1".to_string(),
            api_base_url: None,
            token_source: Default::default(),
        };
        let error = send_kick_chat_message(&reqwest::Client::new(), &config, &"a".repeat(501))
            .await
            .unwrap_err();
        assert!(error.contains("500 characters"));
    }
}
