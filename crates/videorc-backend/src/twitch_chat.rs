//! Twitch live chat connector (slice 5 of the In-App Livestream Comments plan:
//! `2026-06-06 - Videorc In-App Livestream Comments Plan`).
//!
//! Reads chat over the Twitch EventSub WebSocket: connect → `session_welcome` → create the
//! `channel.chat.*` subscriptions over Helix bound to the socket session → receive
//! `notification` frames. Messages are normalized into the shared `LiveChatMessage` model
//! (fragments + badges preserved), de-duplicated by provider message id, and fed to the
//! `LiveChatCoordinator`. `session_reconnect`/disconnects reconnect with exponential backoff
//! and provider status updates; a stream failure never results from a chat failure.
//!
//! The frame parser, message/notification normalization, de-dup, and subscription-body
//! builder are pure and unit-tested; the socket loop is thin glue validated by the slice 10
//! real-OAuth smoke. (IRC fallback is a later addition, gated behind this EventSub path.)

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::live_chat::{
    LiveChatEventType, LiveChatMessage, LiveChatMessageFragment, LiveChatProviderConnectionState,
    ProviderSendReceipt, deliver_message, live_chat_message_id, set_provider_and_emit,
};
use crate::state::AppState;
use crate::streaming::StreamPlatform;

const EVENTSUB_WS_URL: &str = "wss://eventsub.wss.twitch.tv/ws";
const TWITCH_API_BASE_URL: &str = "https://api.twitch.tv";
const MIN_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;

/// The chat-read EventSub subscription types (all share the broadcaster+user condition).
const CHAT_SUBSCRIPTION_TYPES: &[&str] = &[
    "channel.chat.message",
    "channel.chat.notification",
    "channel.chat.message_delete",
    "channel.chat.clear",
    "channel.chat.clear_user_messages",
];

/// Start config for the Twitch connector (an internal/session-aware `liveChat.start` field).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchChatConfig {
    pub access_token: String,
    pub client_id: String,
    /// The channel whose chat is read.
    pub broadcaster_user_id: String,
    /// The authorized user id used as the subscription `user_id` condition.
    pub user_id: String,
    #[serde(default)]
    pub target_id: Option<String>,
    /// Test-only override of the EventSub socket URL.
    #[serde(default)]
    pub eventsub_ws_url: Option<String>,
    /// Test-only override of the Helix API base URL.
    #[serde(default)]
    pub api_base_url: Option<String>,
}

/// Send one chat message via Helix (Comments upgrade S4). Requires the
/// `user:write:chat` scope — connections created before the scope bump can
/// read chat but classify sends as reconnect-required.
pub async fn send_twitch_chat_message(
    client: &reqwest::Client,
    config: &TwitchChatSenderConfig,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or(TWITCH_API_BASE_URL);
    let response = client
        .post(format!("{base}/helix/chat/messages"))
        .bearer_auth(&config.access_token)
        .header("Client-Id", &config.client_id)
        .json(&serde_json::json!({
            "broadcaster_id": config.broadcaster_user_id,
            "sender_id": config.sender_user_id,
            "message": text,
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Twitch: {error}"))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let response_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read Twitch's send response: {error}"))?;
    if status.is_success() {
        let body = serde_json::from_slice::<Value>(&response_bytes)
            .map_err(|error| format!("Twitch returned an unreadable send response: {error}"))?;
        let delivery = body
            .get("data")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .ok_or_else(|| "Twitch returned no delivery result.".to_string())?;
        if !delivery
            .get("is_sent")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let reason = delivery
                .pointer("/drop_reason/message")
                .and_then(Value::as_str)
                .or_else(|| {
                    delivery
                        .pointer("/drop_reason/code")
                        .and_then(Value::as_str)
                })
                .unwrap_or("Twitch dropped the message.");
            return Err(reason.to_string());
        }
        let provider_message_id = delivery
            .get("message_id")
            .and_then(Value::as_str)
            .filter(|message_id| !message_id.trim().is_empty())
            .ok_or_else(|| "Twitch reported sent without a message id.".to_string())?;
        return Ok(ProviderSendReceipt {
            provider_message_id: Some(provider_message_id.to_string()),
        });
    }

    // Helix error bodies can be empty or non-JSON. Preserve auth/rate-limit
    // classification from HTTP status, enriching other failures only when a
    // provider message parses successfully.
    let body = serde_json::from_slice::<Value>(&response_bytes).ok();
    Err(match status.as_u16() {
        401 | 403 => {
            "Twitch rejected the send — reconnect Twitch to grant the new chat permission."
                .to_string()
        }
        429 => format!(
            "Twitch rate-limited the send{}.",
            retry_after
                .map(|seconds| format!("; retry after {seconds}s"))
                .unwrap_or_default()
        ),
        _ => body
            .as_ref()
            .and_then(|body| body.get("message"))
            .and_then(Value::as_str)
            .map(|message| format!("Twitch send failed ({status}): {message}"))
            .unwrap_or_else(|| format!("Twitch send failed ({status}).")),
    })
}

/// The credentials the send path needs (captured at liveChat.start).
#[derive(Debug, Clone)]
pub struct TwitchChatSenderConfig {
    pub access_token: String,
    pub client_id: String,
    pub broadcaster_user_id: String,
    pub sender_user_id: String,
    pub api_base_url: Option<String>,
}

// --- Pure frame parsing + normalization (unit-tested) ---

/// A parsed EventSub websocket frame (the subset the connector reacts to).
#[derive(Debug, Clone, PartialEq, Eq)]
enum EventSubFrame {
    Welcome {
        session_id: String,
    },
    Keepalive,
    Reconnect {
        reconnect_url: Option<String>,
    },
    Notification {
        subscription_type: String,
        message_id: String,
        timestamp: Option<String>,
        event: Value,
    },
    Revocation,
    Unknown,
}

fn parse_envelope(text: &str) -> EventSubFrame {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return EventSubFrame::Unknown;
    };
    let metadata = &value["metadata"];
    match metadata["message_type"].as_str().unwrap_or_default() {
        "session_welcome" => EventSubFrame::Welcome {
            session_id: value["payload"]["session"]["id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        },
        "session_keepalive" => EventSubFrame::Keepalive,
        "session_reconnect" => EventSubFrame::Reconnect {
            reconnect_url: value["payload"]["session"]["reconnect_url"]
                .as_str()
                .map(ToOwned::to_owned),
        },
        "notification" => EventSubFrame::Notification {
            subscription_type: metadata["subscription_type"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            message_id: metadata["message_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            timestamp: metadata["message_timestamp"]
                .as_str()
                .map(ToOwned::to_owned),
            event: value["payload"]["event"].clone(),
        },
        "revocation" => EventSubFrame::Revocation,
        _ => EventSubFrame::Unknown,
    }
}

fn parse_fragments(fragments: &Value) -> Vec<LiveChatMessageFragment> {
    fragments
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|fragment| {
                    let fragment_type = fragment["type"].as_str()?.to_string();
                    let text = fragment["text"].as_str().unwrap_or_default().to_string();
                    let image_url = fragment
                        .get("emote")
                        .and_then(|emote| emote["id"].as_str())
                        .map(|id| {
                            format!(
                                "https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0"
                            )
                        });
                    Some(LiveChatMessageFragment {
                        fragment_type,
                        text,
                        image_url,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_badges(badges: &Value) -> Vec<String> {
    badges
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|badge| badge["set_id"].as_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn roles_from_badges(badges: &[String]) -> Vec<String> {
    let mut roles = Vec::new();
    for badge in badges {
        match badge.as_str() {
            "broadcaster" => roles.push("owner".to_string()),
            "moderator" => roles.push("moderator".to_string()),
            "vip" => roles.push("vip".to_string()),
            "subscriber" | "founder" => roles.push("member".to_string()),
            _ => {}
        }
    }
    roles
}

/// Profile-image URL from a Helix `GET /users` response body (pure, tested).
fn parse_helix_user_avatar(body: &Value, user_id: &str) -> Option<String> {
    body["data"].as_array()?.iter().find_map(|user| {
        (user["id"].as_str() == Some(user_id))
            .then(|| user["profile_image_url"].as_str().map(ToOwned::to_owned))
            .flatten()
            .filter(|url| !url.is_empty())
    })
}

/// Session-scoped avatar backfill: EventSub chat events carry no avatar, so
/// the FIRST message from each chatter costs one Helix `GET /users` lookup
/// (read scope) and every later message hits this cache. Failures cache None —
/// the feed shows a monogram instead of hammering Helix.
#[derive(Default)]
struct TwitchAvatarCache {
    by_user_id: std::collections::HashMap<String, Option<String>>,
}

impl TwitchAvatarCache {
    async fn lookup(
        &mut self,
        client: &reqwest::Client,
        config: &TwitchChatConfig,
        user_id: &str,
    ) -> Option<String> {
        if let Some(cached) = self.by_user_id.get(user_id) {
            return cached.clone();
        }
        let base = config
            .api_base_url
            .clone()
            .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
        let fetched = client
            .get(format!("{base}/helix/users"))
            .query(&[("id", user_id)])
            .bearer_auth(&config.access_token)
            .header("Client-Id", &config.client_id)
            .send()
            .await
            .ok()
            .filter(|response| response.status().is_success());
        let avatar = match fetched {
            Some(response) => match response.json::<Value>().await {
                Ok(body) => parse_helix_user_avatar(&body, user_id),
                Err(_) => None,
            },
            None => None,
        };
        self.by_user_id.insert(user_id.to_string(), avatar.clone());
        avatar
    }
}

fn base_message(
    provider_message_id: String,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> LiveChatMessage {
    let published_at = timestamp.unwrap_or(received_at).to_string();
    LiveChatMessage {
        id: live_chat_message_id(
            session_id,
            StreamPlatform::Twitch,
            target_id,
            &provider_message_id,
        ),
        provider_message_id,
        platform: StreamPlatform::Twitch,
        target_id: target_id.map(ToOwned::to_owned),
        session_id: session_id.to_string(),
        author_id: None,
        author_name: "Twitch".to_string(),
        author_avatar_url: None,
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at,
        received_at: received_at.to_string(),
        message_text: String::new(),
        fragments: Vec::new(),
        event_type: LiveChatEventType::System,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: None,
    }
}

fn normalize_chat_message(
    event: &Value,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let provider_message_id = event["message_id"].as_str()?.to_string();
    let fragments = parse_fragments(&event["message"]["fragments"]);
    let badges = parse_badges(&event["badges"]);
    let is_cheer = !event["cheer"].is_null();
    let amount_text = if is_cheer {
        event["cheer"]["bits"]
            .as_u64()
            .map(|bits| format!("{bits} bits"))
    } else {
        None
    };
    let mut message = base_message(
        provider_message_id,
        session_id,
        target_id,
        timestamp,
        received_at,
    );
    message.author_id = event["chatter_user_id"].as_str().map(ToOwned::to_owned);
    message.author_name = event["chatter_user_name"]
        .as_str()
        .unwrap_or("Twitch viewer")
        .to_string();
    message.author_roles = roles_from_badges(&badges);
    message.author_badges = badges;
    message.message_text = event["message"]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    message.fragments = fragments;
    message.event_type = if is_cheer {
        LiveChatEventType::Paid
    } else {
        LiveChatEventType::Message
    };
    message.amount_text = amount_text;
    message.raw_provider_type = Some("channel.chat.message".to_string());
    Some(message)
}

fn notice_event_type(notice_type: &str) -> LiveChatEventType {
    match notice_type {
        "sub" | "resub" | "sub_gift" | "community_sub_gift" | "gift_paid_upgrade"
        | "prime_paid_upgrade" | "pay_it_forward" => LiveChatEventType::Membership,
        _ => LiveChatEventType::System,
    }
}

fn normalize_chat_notification(
    event: &Value,
    message_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> LiveChatMessage {
    let notice_type = event["notice_type"].as_str().unwrap_or("notification");
    let text = event["system_message"]
        .as_str()
        .filter(|text| !text.is_empty())
        .or_else(|| event["message"]["text"].as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "Twitch chat event".to_string());
    let mut message = base_message(
        message_id.to_string(),
        session_id,
        target_id,
        timestamp,
        received_at,
    );
    message.author_name = event["chatter_user_name"]
        .as_str()
        .unwrap_or("Twitch")
        .to_string();
    message.message_text = text;
    message.fragments = parse_fragments(&event["message"]["fragments"]);
    message.event_type = notice_event_type(notice_type);
    message.raw_provider_type = Some(format!("channel.chat.notification:{notice_type}"));
    message
}

#[allow(clippy::too_many_arguments)]
fn moderation_row(
    message_id: &str,
    text: String,
    deleted: bool,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
    raw_provider_type: &str,
) -> LiveChatMessage {
    let mut message = base_message(
        message_id.to_string(),
        session_id,
        target_id,
        timestamp,
        received_at,
    );
    message.message_text = text;
    message.event_type = if deleted {
        LiveChatEventType::Deleted
    } else {
        LiveChatEventType::Moderation
    };
    message.is_deleted = deleted;
    message.raw_provider_type = Some(raw_provider_type.to_string());
    message
}

/// Normalize one notification frame into a message, or `None` for types we ignore. Unknown
/// notice/event types still produce a safe row rather than being dropped silently.
fn normalize_notification(
    subscription_type: &str,
    event: &Value,
    message_id: &str,
    timestamp: Option<&str>,
    session_id: &str,
    target_id: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    match subscription_type {
        "channel.chat.message" => {
            normalize_chat_message(event, session_id, target_id, timestamp, received_at)
        }
        "channel.chat.notification" => Some(normalize_chat_notification(
            event,
            message_id,
            session_id,
            target_id,
            timestamp,
            received_at,
        )),
        "channel.chat.message_delete" => {
            let deleted_message_id = event["message_id"]
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty());
            Some(match deleted_message_id {
                Some(deleted_message_id) => moderation_row(
                    deleted_message_id,
                    "A chat message was removed.".to_string(),
                    true,
                    session_id,
                    target_id,
                    timestamp,
                    received_at,
                    "channel.chat.message_delete",
                ),
                None => moderation_row(
                    message_id,
                    "Twitch reported a deleted message without its message id.".to_string(),
                    false,
                    session_id,
                    target_id,
                    timestamp,
                    received_at,
                    "channel.chat.message_delete:missing-message-id",
                ),
            })
        }
        "channel.chat.clear" => Some(moderation_row(
            message_id,
            "Chat was cleared.".to_string(),
            false,
            session_id,
            target_id,
            timestamp,
            received_at,
            "channel.chat.clear",
        )),
        "channel.chat.clear_user_messages" => {
            let name = event["target_user_name"].as_str().unwrap_or("a viewer");
            Some(moderation_row(
                message_id,
                format!("Messages from {name} were removed."),
                false,
                session_id,
                target_id,
                timestamp,
                received_at,
                "channel.chat.clear_user_messages",
            ))
        }
        _ => None,
    }
}

/// The Helix body that creates one chat subscription bound to a socket session.
fn chat_subscription_body(
    subscription_type: &str,
    broadcaster_user_id: &str,
    user_id: &str,
    session_id: &str,
) -> Value {
    json!({
        "type": subscription_type,
        "version": "1",
        "condition": {
            "broadcaster_user_id": broadcaster_user_id,
            "user_id": user_id,
        },
        "transport": {
            "method": "websocket",
            "session_id": session_id,
        },
    })
}

fn next_backoff_ms(current: u64) -> u64 {
    current
        .saturating_mul(2)
        .clamp(MIN_BACKOFF_MS, MAX_BACKOFF_MS)
}

// --- Live transport ---

enum SessionOutcome {
    Reconnect(Option<String>),
    Fatal(&'static str),
}

async fn create_subscriptions(
    client: &reqwest::Client,
    config: &TwitchChatConfig,
    session_id: &str,
) -> Result<()> {
    let base_url = config
        .api_base_url
        .clone()
        .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
    let url = format!(
        "{}/helix/eventsub/subscriptions",
        base_url.trim_end_matches('/')
    );
    for subscription_type in CHAT_SUBSCRIPTION_TYPES {
        let body = chat_subscription_body(
            subscription_type,
            &config.broadcaster_user_id,
            &config.user_id,
            session_id,
        );
        client
            .post(&url)
            .bearer_auth(&config.access_token)
            .header("Client-Id", &config.client_id)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("Could not create {subscription_type} subscription."))?
            .error_for_status()
            .with_context(|| format!("Twitch rejected the {subscription_type} subscription."))?;
    }
    Ok(())
}

async fn run_eventsub_session(
    state: &AppState,
    session_id: &str,
    config: &TwitchChatConfig,
    client: &reqwest::Client,
    ws_url: &str,
    seen: &mut HashSet<String>,
    avatars: &mut TwitchAvatarCache,
) -> SessionOutcome {
    let Ok((ws_stream, _response)) = connect_async(ws_url).await else {
        return SessionOutcome::Reconnect(None);
    };
    let (mut sink, mut stream) = ws_stream.split();

    while let Some(frame) = stream.next().await {
        let Ok(message) = frame else {
            return SessionOutcome::Reconnect(None);
        };
        match message {
            Message::Text(text) => match parse_envelope(text.as_str()) {
                EventSubFrame::Welcome {
                    session_id: socket_session,
                } => {
                    if create_subscriptions(client, config, &socket_session)
                        .await
                        .is_err()
                    {
                        return SessionOutcome::Fatal(
                            "Could not subscribe to Twitch live chat. Reconnect Twitch to enable live comments.",
                        );
                    }
                    set_provider_and_emit(
                        state,
                        StreamPlatform::Twitch,
                        config.target_id.as_deref(),
                        LiveChatProviderConnectionState::Connected,
                        "Twitch live chat connected.",
                    )
                    .await;
                }
                EventSubFrame::Notification {
                    subscription_type,
                    message_id,
                    timestamp,
                    event,
                } => {
                    let now = chrono::Utc::now().to_rfc3339();
                    if let Some(mut message) = normalize_notification(
                        &subscription_type,
                        &event,
                        &message_id,
                        timestamp.as_deref(),
                        session_id,
                        config.target_id.as_deref(),
                        &now,
                    ) && seen.insert(message.provider_message_id.clone())
                    {
                        // EventSub carries no avatar; backfill once per chatter
                        // (Comments window upgrade S1).
                        if message.author_avatar_url.is_none()
                            && let Some(author_id) = message.author_id.clone()
                        {
                            message.author_avatar_url =
                                avatars.lookup(client, config, &author_id).await;
                        }
                        deliver_message(state, message).await;
                    }
                }
                EventSubFrame::Reconnect { reconnect_url } => {
                    return SessionOutcome::Reconnect(reconnect_url);
                }
                EventSubFrame::Revocation => {
                    return SessionOutcome::Fatal(
                        "Twitch revoked live chat access. Reconnect Twitch to enable live comments.",
                    );
                }
                EventSubFrame::Keepalive | EventSubFrame::Unknown => {}
            },
            Message::Ping(payload) => {
                let _ = sink.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => return SessionOutcome::Reconnect(None),
            _ => {}
        }
    }
    SessionOutcome::Reconnect(None)
}

/// The connector task: connect to EventSub, subscribe, deliver normalized + de-duplicated
/// messages, and reconnect with backoff. Spawned by session integration (and `liveChat.start`
/// with a `twitch` config for the live smoke).
pub async fn run_twitch_chat_connector(
    state: AppState,
    session_id: String,
    config: TwitchChatConfig,
) {
    let client = reqwest::Client::new();
    let mut ws_url = config
        .eventsub_ws_url
        .clone()
        .unwrap_or_else(|| EVENTSUB_WS_URL.to_string());
    let default_ws_url = config
        .eventsub_ws_url
        .clone()
        .unwrap_or_else(|| EVENTSUB_WS_URL.to_string());
    let mut seen: HashSet<String> = HashSet::new();
    let mut backoff_ms = MIN_BACKOFF_MS;

    set_provider_and_emit(
        &state,
        StreamPlatform::Twitch,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to Twitch live chat…",
    )
    .await;

    let mut avatars = TwitchAvatarCache::default();
    loop {
        match run_eventsub_session(
            &state,
            &session_id,
            &config,
            &client,
            &ws_url,
            &mut seen,
            &mut avatars,
        )
        .await
        {
            SessionOutcome::Reconnect(next_url) => {
                ws_url = next_url.unwrap_or_else(|| default_ws_url.clone());
                set_provider_and_emit(
                    &state,
                    StreamPlatform::Twitch,
                    config.target_id.as_deref(),
                    LiveChatProviderConnectionState::Reconnecting,
                    "Reconnecting to Twitch live chat…",
                )
                .await;
                sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = next_backoff_ms(backoff_ms);
            }
            SessionOutcome::Fatal(message) => {
                set_provider_and_emit(
                    &state,
                    StreamPlatform::Twitch,
                    config.target_id.as_deref(),
                    LiveChatProviderConnectionState::Failed,
                    message,
                )
                .await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::extract::State;
    use axum::extract::ws::{Message as AxumMessage, WebSocketUpgrade};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use tokio::sync::{Mutex, broadcast, oneshot};

    use crate::live_chat::{
        LiveChatProviderConnectionState, LiveChatProviderState, current_status,
    };
    use crate::storage::Database;

    #[derive(Clone)]
    struct MockChatSendResponse {
        status: StatusCode,
        body: Value,
    }

    #[derive(Clone)]
    struct MockRawChatSendResponse {
        status: StatusCode,
        body: String,
    }

    async fn mock_chat_send(State(response): State<MockChatSendResponse>) -> impl IntoResponse {
        (response.status, Json(response.body))
    }

    async fn mock_raw_chat_send(
        State(response): State<MockRawChatSendResponse>,
    ) -> impl IntoResponse {
        (response.status, response.body)
    }

    async fn spawn_chat_send_server(status: StatusCode, body: Value) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/helix/chat/messages", post(mock_chat_send))
            .with_state(MockChatSendResponse { status, body });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    async fn spawn_raw_chat_send_server(status: StatusCode, body: &str) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/helix/chat/messages", post(mock_raw_chat_send))
            .with_state(MockRawChatSendResponse {
                status,
                body: body.to_string(),
            });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    fn chat_message_frame() -> String {
        json!({
            "metadata": {
                "message_type": "notification",
                "subscription_type": "channel.chat.message",
                "message_id": "delivery-1",
                "message_timestamp": "2026-06-06T10:00:00Z"
            },
            "payload": {
                "subscription": { "type": "channel.chat.message" },
                "event": {
                    "chatter_user_id": "987",
                    "chatter_user_name": "CoolViewer",
                    "message_id": "chat-1",
                    "message": {
                        "text": "hi Kappa",
                        "fragments": [
                            { "type": "text", "text": "hi " },
                            { "type": "emote", "text": "Kappa", "emote": { "id": "25" } }
                        ]
                    },
                    "badges": [
                        { "set_id": "broadcaster", "id": "1" },
                        { "set_id": "subscriber", "id": "12" }
                    ],
                    "cheer": null
                }
            }
        })
        .to_string()
    }

    #[derive(Clone)]
    struct MockTwitchServerState {
        subscriptions: Arc<Mutex<Vec<Value>>>,
    }

    async fn mock_eventsub_ws(ws: WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(|mut socket| async move {
            let welcome = json!({
                "metadata": { "message_type": "session_welcome" },
                "payload": { "session": { "id": "socket-session-1" } }
            })
            .to_string();
            let _ = socket.send(AxumMessage::Text(welcome.into())).await;
            sleep(Duration::from_millis(100)).await;
            let _ = socket
                .send(AxumMessage::Text(chat_message_frame().into()))
                .await;
            sleep(Duration::from_millis(100)).await;
        })
    }

    async fn mock_subscriptions(
        State(state): State<MockTwitchServerState>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state.subscriptions.lock().await.push(body);
        Json(json!({ "data": [] }))
    }

    async fn mock_users() -> Json<Value> {
        Json(json!({
            "data": [
                { "id": "987", "profile_image_url": "https://static-cdn.jtvnw.net/viewer.png" }
            ]
        }))
    }

    async fn spawn_mock_twitch_server()
    -> (String, String, Arc<Mutex<Vec<Value>>>, oneshot::Sender<()>) {
        let subscriptions = Arc::new(Mutex::new(Vec::new()));
        let state = MockTwitchServerState {
            subscriptions: subscriptions.clone(),
        };
        let app = Router::new()
            .route("/eventsub", get(mock_eventsub_ws))
            .route("/helix/eventsub/subscriptions", post(mock_subscriptions))
            .route("/helix/users", get(mock_users))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock twitch listener");
        let addr = listener.local_addr().expect("mock twitch addr");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        (
            format!("http://{addr}"),
            format!("ws://{addr}/eventsub"),
            subscriptions,
            shutdown_tx,
        )
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn twitch_provider_row() -> LiveChatProviderState {
        LiveChatProviderState {
            id: "twitch".to_string(),
            platform: StreamPlatform::Twitch,
            target_id: Some("twitch".to_string()),
            account_id: Some("broadcaster-1".to_string()),
            account_label: Some("Twitch Channel".to_string()),
            read: crate::live_chat::CommentsReadState::Connecting,
            write: crate::live_chat::CommentsWriteState::Ready,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting to Twitch live chat…".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
        }
    }

    async fn wait_for_twitch_message(state: &AppState) -> crate::live_chat::LiveChatSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = current_status(state).await;
            if snapshot
                .messages
                .iter()
                .any(|message| message.id == "session-1:twitch:twitch:chat-1")
            {
                return snapshot;
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for mocked Twitch chat message: {snapshot:?}");
            }
            sleep(Duration::from_millis(25)).await;
        }
    }

    fn sender_config(api_base_url: String) -> TwitchChatSenderConfig {
        TwitchChatSenderConfig {
            access_token: "token".to_string(),
            client_id: "client".to_string(),
            broadcaster_user_id: "broadcaster".to_string(),
            sender_user_id: "sender".to_string(),
            api_base_url: Some(api_base_url),
        }
    }

    #[tokio::test]
    async fn send_parses_delivery_receipt() {
        let base = spawn_chat_send_server(
            StatusCode::OK,
            json!({ "data": [{ "message_id": "tw-sent-1", "is_sent": true }] }),
        )
        .await;
        let receipt =
            send_twitch_chat_message(&reqwest::Client::new(), &sender_config(base), "hello")
                .await
                .unwrap();
        assert_eq!(receipt.provider_message_id.as_deref(), Some("tw-sent-1"));
    }

    #[tokio::test]
    async fn send_treats_dropped_success_response_as_failure() {
        let base = spawn_chat_send_server(
            StatusCode::OK,
            json!({
                "data": [{
                    "message_id": "",
                    "is_sent": false,
                    "drop_reason": { "code": "automod_held", "message": "Held by AutoMod" }
                }]
            }),
        )
        .await;
        let error =
            send_twitch_chat_message(&reqwest::Client::new(), &sender_config(base), "hello")
                .await
                .unwrap_err();
        assert_eq!(error, "Held by AutoMod");
    }

    #[tokio::test]
    async fn send_rejects_sent_response_without_provider_message_id() {
        let base = spawn_chat_send_server(
            StatusCode::OK,
            json!({ "data": [{ "is_sent": true, "message_id": "" }] }),
        )
        .await;
        let error =
            send_twitch_chat_message(&reqwest::Client::new(), &sender_config(base), "hello")
                .await
                .unwrap_err();
        assert!(error.contains("without a message id"));
    }

    #[tokio::test]
    async fn send_classifies_non_json_auth_and_rate_limit_errors_from_status() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, "reconnect Twitch"),
            (StatusCode::TOO_MANY_REQUESTS, "rate-limited"),
        ] {
            let base = spawn_raw_chat_send_server(status, "not-json").await;
            let error =
                send_twitch_chat_message(&reqwest::Client::new(), &sender_config(base), "hello")
                    .await
                    .unwrap_err();
            assert!(error.contains(expected), "{status}: {error}");
            assert!(!error.contains("unreadable"), "{status}: {error}");
        }
    }

    #[tokio::test]
    async fn eventsub_session_subscribes_and_delivers_chat_message() {
        let (api_base_url, eventsub_ws_url, subscriptions, shutdown) =
            spawn_mock_twitch_server().await;
        let state = test_state();
        {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
        }

        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            TwitchChatConfig {
                access_token: "token-1".to_string(),
                client_id: "client-1".to_string(),
                broadcaster_user_id: "broadcaster-1".to_string(),
                user_id: "user-1".to_string(),
                target_id: Some("twitch".to_string()),
                eventsub_ws_url: Some(eventsub_ws_url),
                api_base_url: Some(api_base_url),
            },
        ));

        let snapshot = wait_for_twitch_message(&state).await;
        connector.abort();
        let _ = shutdown.send(());

        let twitch = snapshot
            .providers
            .iter()
            .find(|provider| provider.platform == StreamPlatform::Twitch)
            .expect("twitch provider");
        assert_eq!(twitch.state, LiveChatProviderConnectionState::Connected);
        assert_eq!(snapshot.messages.len(), 1);
        let message = &snapshot.messages[0];
        assert_eq!(message.id, "session-1:twitch:twitch:chat-1");
        assert_eq!(message.message_text, "hi Kappa");
        assert_eq!(
            message.author_avatar_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/viewer.png")
        );

        let subscription_types = subscriptions
            .lock()
            .await
            .iter()
            .filter_map(|body| body["type"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        for subscription_type in CHAT_SUBSCRIPTION_TYPES {
            assert!(
                subscription_types
                    .iter()
                    .any(|submitted| submitted == subscription_type),
                "missing mocked subscription type {subscription_type}: {subscription_types:?}"
            );
        }
    }

    #[test]
    fn parses_session_welcome_and_reconnect_and_keepalive() {
        let welcome = parse_envelope(
            &json!({ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "sess-1" } } }).to_string(),
        );
        assert_eq!(
            welcome,
            EventSubFrame::Welcome {
                session_id: "sess-1".to_string()
            }
        );

        let reconnect = parse_envelope(
            &json!({ "metadata": { "message_type": "session_reconnect" }, "payload": { "session": { "reconnect_url": "wss://new" } } }).to_string(),
        );
        assert_eq!(
            reconnect,
            EventSubFrame::Reconnect {
                reconnect_url: Some("wss://new".to_string())
            }
        );

        let keepalive = parse_envelope(
            &json!({ "metadata": { "message_type": "session_keepalive" }, "payload": {} })
                .to_string(),
        );
        assert_eq!(keepalive, EventSubFrame::Keepalive);
    }

    #[test]
    fn parses_helix_user_avatar_by_id() {
        let body = serde_json::json!({
            "data": [
                { "id": "111", "profile_image_url": "https://static-cdn.jtvnw.net/a.png" },
                { "id": "222", "profile_image_url": "" }
            ]
        });
        assert_eq!(
            parse_helix_user_avatar(&body, "111").as_deref(),
            Some("https://static-cdn.jtvnw.net/a.png")
        );
        // Empty URL and unknown ids resolve to None (monogram fallback).
        assert_eq!(parse_helix_user_avatar(&body, "222"), None);
        assert_eq!(parse_helix_user_avatar(&body, "999"), None);
        assert_eq!(parse_helix_user_avatar(&serde_json::json!({}), "111"), None);
    }

    #[test]
    fn normalizes_chat_message_with_fragments_and_badges() {
        let frame = parse_envelope(&chat_message_frame());
        let EventSubFrame::Notification {
            subscription_type,
            message_id,
            timestamp,
            event,
        } = frame
        else {
            panic!("expected a notification frame");
        };
        let message = normalize_notification(
            &subscription_type,
            &event,
            &message_id,
            timestamp.as_deref(),
            "s1",
            Some("t1"),
            "2026-06-06T10:00:01Z",
        )
        .unwrap();

        assert_eq!(message.id, "s1:twitch:t1:chat-1");
        assert_eq!(message.provider_message_id, "chat-1");
        assert_eq!(message.platform, StreamPlatform::Twitch);
        assert_eq!(message.target_id.as_deref(), Some("t1"));
        assert_eq!(message.author_name, "CoolViewer");
        assert_eq!(message.author_id.as_deref(), Some("987"));
        assert_eq!(message.message_text, "hi Kappa");
        assert_eq!(message.event_type, LiveChatEventType::Message);
        // Fragments preserved (text + emote, with an emote image url).
        assert_eq!(message.fragments.len(), 2);
        assert_eq!(message.fragments[0].fragment_type, "text");
        assert_eq!(message.fragments[1].fragment_type, "emote");
        assert!(message.fragments[1].image_url.is_some());
        // Badges + derived roles.
        assert_eq!(
            message.author_badges,
            vec!["broadcaster".to_string(), "subscriber".to_string()]
        );
        assert_eq!(
            message.author_roles,
            vec!["owner".to_string(), "member".to_string()]
        );
        // Published timestamp comes from the frame metadata.
        assert_eq!(message.published_at, "2026-06-06T10:00:00Z");
    }

    #[test]
    fn cheer_message_is_paid_with_bits_amount() {
        let event = json!({
            "chatter_user_name": "Cheerer",
            "message_id": "chat-cheer",
            "message": { "text": "Cheer100", "fragments": [] },
            "badges": [],
            "cheer": { "bits": 100 }
        });
        let message = normalize_chat_message(&event, "s1", None, None, "now").unwrap();
        assert_eq!(message.event_type, LiveChatEventType::Paid);
        assert_eq!(message.amount_text.as_deref(), Some("100 bits"));
    }

    #[test]
    fn subscription_notification_maps_to_membership() {
        let event = json!({
            "notice_type": "resub",
            "chatter_user_name": "LoyalFan",
            "system_message": "LoyalFan subscribed for 6 months",
            "message": { "text": "love it", "fragments": [] }
        });
        let message = normalize_notification(
            "channel.chat.notification",
            &event,
            "delivery-9",
            None,
            "s1",
            None,
            "now",
        )
        .unwrap();
        assert_eq!(message.event_type, LiveChatEventType::Membership);
        assert_eq!(message.provider_message_id, "delivery-9");
        assert_eq!(message.message_text, "LoyalFan subscribed for 6 months");
    }

    #[test]
    fn message_delete_and_clear_become_safe_rows() {
        let deleted = normalize_notification(
            "channel.chat.message_delete",
            &json!({ "message_id": "x" }),
            "del-1",
            None,
            "s1",
            None,
            "now",
        )
        .unwrap();
        assert_eq!(deleted.event_type, LiveChatEventType::Deleted);
        assert!(deleted.is_deleted);
        assert_eq!(deleted.provider_message_id, "x");
        assert_eq!(deleted.id, "s1:twitch:default:x");

        let malformed = normalize_notification(
            "channel.chat.message_delete",
            &json!({ "target_user_id": "viewer-1" }),
            "delivery-id-not-a-chat-id",
            None,
            "s1",
            None,
            "now",
        )
        .unwrap();
        assert_eq!(malformed.event_type, LiveChatEventType::Moderation);
        assert!(!malformed.is_deleted);
        assert!(malformed.message_text.contains("without its message id"));

        let cleared = normalize_notification(
            "channel.chat.clear_user_messages",
            &json!({ "target_user_name": "Spammer" }),
            "clr-1",
            None,
            "s1",
            None,
            "now",
        )
        .unwrap();
        assert_eq!(cleared.event_type, LiveChatEventType::Moderation);
        assert!(cleared.message_text.contains("Spammer"));
    }

    #[test]
    fn duplicate_provider_message_ids_are_skipped() {
        let mut seen: HashSet<String> = HashSet::new();
        let frame = parse_envelope(&chat_message_frame());
        let EventSubFrame::Notification {
            subscription_type,
            message_id,
            timestamp,
            event,
        } = frame
        else {
            panic!("expected a notification frame");
        };
        let make = || {
            normalize_notification(
                &subscription_type,
                &event,
                &message_id,
                timestamp.as_deref(),
                "s1",
                None,
                "now",
            )
            .unwrap()
        };
        // First delivery is new; a redelivery of the same chat id is skipped.
        assert!(seen.insert(make().provider_message_id));
        assert!(!seen.insert(make().provider_message_id));
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn subscription_body_targets_socket_session_and_condition() {
        let body = chat_subscription_body("channel.chat.message", "bcast-1", "user-1", "sess-1");
        assert_eq!(body["type"], "channel.chat.message");
        assert_eq!(body["version"], "1");
        assert_eq!(body["condition"]["broadcaster_user_id"], "bcast-1");
        assert_eq!(body["condition"]["user_id"], "user-1");
        assert_eq!(body["transport"]["method"], "websocket");
        assert_eq!(body["transport"]["session_id"], "sess-1");
        // All five chat subscription types are covered.
        assert_eq!(CHAT_SUBSCRIPTION_TYPES.len(), 5);
    }

    #[test]
    fn reconnect_backoff_grows_and_is_clamped() {
        assert_eq!(next_backoff_ms(MIN_BACKOFF_MS), 2_000);
        assert_eq!(next_backoff_ms(2_000), 4_000);
        assert_eq!(next_backoff_ms(20_000), MAX_BACKOFF_MS);
        assert_eq!(next_backoff_ms(MAX_BACKOFF_MS), MAX_BACKOFF_MS);
    }
}
