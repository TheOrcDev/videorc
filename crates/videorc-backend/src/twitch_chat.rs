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
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, LiveChatMessageFragment,
    LiveChatProviderConnectionState, LiveChatReply, PowerUpKind, ProviderSendReceipt,
    RedemptionKind, SubscriptionKind, live_chat_message_id, set_provider_and_emit,
    try_deliver_message,
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
    /// How the connector renews `access_token` mid-stream (plan 055, B2).
    /// Built by the backend from the stored account; never read from params.
    #[serde(skip)]
    pub token_source: crate::session_token::SessionTokenSource,
    /// Subscribe to `channel.follow` v2: only when the account granted the
    /// opt-in `moderator:read:followers` scope (plan 055, S6).
    #[serde(default)]
    pub follow_events: bool,
    /// Subscribe to `channel.bits.use`: only with the opt-in `bits:read`
    /// scope (plan 162).
    #[serde(default)]
    pub bits_events: bool,
    /// Subscribe to channel point redemptions: only with the opt-in
    /// `channel:read:redemptions` scope (plan 162).
    #[serde(default)]
    pub redemption_events: bool,
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
        401 | 403 => "Twitch rejected the send. Reconnect Twitch to grant the new chat permission."
            .to_string(),
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

/// The optional scope that lets Videorc delete chat messages (plan 140). Every
/// Twitch connect asks for it; until an account reconnects with it, removals
/// hide locally with `missing-scope`.
pub const TWITCH_CHAT_MODERATE_SCOPE: &str = crate::oauth::TWITCH_MODERATION_SCOPE;

/// Helix deletes only messages younger than this (checked before any call).
pub const TWITCH_DELETE_MAX_AGE: chrono::Duration = chrono::Duration::hours(6);

/// The hide reasons the moderation engine shows after "Viewers on Twitch
/// still see it."
pub const TWITCH_TOO_OLD_REASON: &str = "Twitch only removes messages under 6 hours old.";
pub const TWITCH_MODERATE_RECONNECT_REASON: &str = "Reconnect Twitch to let Orcle remove messages.";

/// Why an empty id is refused before any request is built: Helix clears the
/// WHOLE chat when `message_id` is omitted.
pub const TWITCH_EMPTY_MESSAGE_ID_REFUSED: &str = "Twitch needs the message id to remove one message; without it Twitch would clear the whole chat, so nothing was sent.";

/// Whether Helix would refuse to delete a message published at `published_at`
/// (RFC 3339) because it is 6 hours old or more. An unreadable time lets
/// Twitch decide.
pub fn twitch_message_too_old(published_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(published_at.trim()) {
        Ok(published) => {
            now.signed_duration_since(published.with_timezone(&chrono::Utc))
                >= TWITCH_DELETE_MAX_AGE
        }
        Err(_) => false,
    }
}

/// Remove one chat message via Helix (plan 140 S4):
/// `DELETE /helix/moderation/chat?broadcaster_id&moderator_id&message_id`
/// answers 204. Needs the `moderator:manage:chat_messages` scope; the
/// authorized user is the moderator (the broadcaster moderates their own
/// chat). An empty or blank `message_id` is refused before any request is
/// built, because Helix clears the whole chat without one.
pub async fn delete_twitch_chat_message(
    client: &reqwest::Client,
    config: &TwitchChatSenderConfig,
    message_id: &str,
) -> crate::live_chat_moderation::ProviderDeleteOutcome {
    use crate::live_chat_moderation::ProviderDeleteOutcome;

    let message_id = message_id.trim();
    if message_id.is_empty() {
        return ProviderDeleteOutcome::Failed(TWITCH_EMPTY_MESSAGE_ID_REFUSED.to_string());
    }
    let base = config
        .api_base_url
        .as_deref()
        .unwrap_or(TWITCH_API_BASE_URL);
    let response = match client
        .delete(format!("{base}/helix/moderation/chat"))
        .query(&[
            ("broadcaster_id", config.broadcaster_user_id.as_str()),
            ("moderator_id", config.sender_user_id.as_str()),
            ("message_id", message_id),
        ])
        .bearer_auth(&config.access_token)
        .header("Client-Id", &config.client_id)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return ProviderDeleteOutcome::Transient(format!("Could not reach Twitch: {error}"));
        }
    };
    let status = response.status().as_u16();
    let body = response.bytes().await.unwrap_or_default();
    classify_twitch_delete_response(status, &body)
}

/// Pure: what a Helix delete status and body mean. 400 carries Helix's reason
/// (a message over 6 hours old, or a broadcaster's or moderator's message);
/// 401/403 means the scope or the moderator role is missing.
pub(crate) fn classify_twitch_delete_response(
    status: u16,
    body: &[u8],
) -> crate::live_chat_moderation::ProviderDeleteOutcome {
    use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};

    if (200..300).contains(&status) {
        return ProviderDeleteOutcome::Deleted;
    }
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty());
    let lowered = message.as_deref().unwrap_or_default().to_ascii_lowercase();
    let detail = message
        .as_deref()
        .map(|message| format!(" ({message})"))
        .unwrap_or_default();
    match status {
        404 => ProviderDeleteOutcome::NotFound,
        400 if lowered.contains("6 hours") || lowered.contains("too old") => {
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::TooOld,
                reason: TWITCH_TOO_OLD_REASON.to_string(),
            }
        }
        400 => ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::Unsupported,
            reason: format!("Twitch does not allow removing this message{detail}."),
        },
        401 | 403 => ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::MissingScope,
            reason: TWITCH_MODERATE_RECONNECT_REASON.to_string(),
        },
        429 | 500..=599 => {
            ProviderDeleteOutcome::Transient(format!("Twitch answered HTTP {status}{detail}."))
        }
        _ => ProviderDeleteOutcome::Failed(format!("Twitch removal failed ({status}){detail}.")),
    }
}

/// The credentials the send path needs (captured at liveChat.start).
#[derive(Debug, Clone)]
pub struct TwitchChatSenderConfig {
    pub access_token: String,
    pub client_id: String,
    pub broadcaster_user_id: String,
    pub sender_user_id: String,
    pub api_base_url: Option<String>,
    /// Sends hours into a stream refresh through the stored account (B2).
    pub token_source: crate::session_token::SessionTokenSource,
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

/// Hosts a Twitch GIF Keyboard asset may be served from (plan 155, D3).
/// Twitch requires the `gif.url` it sends to be used unmodified, so unlike
/// emotes the URL is taken from the payload and gated here and again in
/// main's image cache. GIPHY's media CDNs (`media0-4.giphy.com`,
/// `i.giphy.com`) and Twitch's own CDN, pending the S0 capture.
pub(crate) const TWITCH_GIF_ASSET_HOSTS: &[&str] = &["giphy.com", "static-cdn.jtvnw.net"];

/// Longer than this is not a GIF asset URL (matches `chatLinkUrl`).
const TWITCH_GIF_URL_MAX_CHARS: usize = 2_048;

/// The `gif.url` of a GIF fragment, when it is safe to fetch: `https:`, no
/// userinfo, bounded, and on an allowlisted host. Anything else is `None`,
/// so the fragment keeps its title text and never a modified URL.
pub(crate) fn twitch_gif_asset_url(raw: &str) -> Option<String> {
    if raw.len() > TWITCH_GIF_URL_MAX_CHARS {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    TWITCH_GIF_ASSET_HOSTS
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
        .then(|| raw.to_string())
}

/// The host of a GIF URL, for the one deduped warning a refused asset earns.
pub(crate) fn gif_url_host(raw: &str) -> String {
    reqwest::Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_else(|| "<not a url>".to_string())
}

/// Hosts of the GIF fragments in a message whose URL the gate refused.
pub(crate) fn rejected_gif_hosts(fragments: &Value) -> Vec<String> {
    fragments
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|fragment| fragment["type"].as_str() == Some("gif"))
                .filter_map(|fragment| fragment["gif"]["url"].as_str())
                .filter(|url| twitch_gif_asset_url(url).is_none())
                .map(gif_url_host)
                .collect()
        })
        .unwrap_or_default()
}

/// One `warn` per refused GIF host per process, so a chat full of GIFs from a
/// host the allowlist does not know shows up once in the support bundle, not
/// once per message. The host only: a GIF URL path is not sensitive, but the
/// line stays short and the rule matches main's avatar-cache log.
fn warn_rejected_gif_assets(state: &AppState, fragments: &Value) {
    static WARNED_HOSTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    for host in rejected_gif_hosts(fragments) {
        let mut warned = WARNED_HOSTS
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if warned.contains(&host) {
            continue;
        }
        warned.push(host.clone());
        drop(warned);
        state.emit_log(
            "warn",
            format!(
                "Twitch GIF not shown: {host} is not an allowlisted GIF asset host (plan 155). The row keeps the GIF's title."
            ),
        );
    }
}

/// A GIF's title from its fragment text: Twitch sends the GIPHY title in
/// brackets with a ` GIF` suffix (`[Y A Y Yes GIF]` → `Y A Y Yes`). Text in
/// another shape is returned as is, trimmed.
pub(crate) fn gif_title(text: &str) -> String {
    let trimmed = text.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed)
        .trim();
    let title = inner
        .strip_suffix(" GIF")
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(inner);
    title.to_string()
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
                    let image_url = if fragment_type == "gif" {
                        // Plan 155: Twitch's GIF Keyboard. The id is `gif_id`
                        // in the changelog and `id` in the reference; neither
                        // is stored, only the gated URL.
                        fragment["gif"]["url"]
                            .as_str()
                            .and_then(twitch_gif_asset_url)
                    } else {
                        fragment
                            .get("emote")
                            .and_then(|emote| emote["id"].as_str())
                            .map(|id| {
                                format!(
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0"
                                )
                            })
                    };
                    Some(LiveChatMessageFragment {
                        fragment_type,
                        text,
                        image_url,
                        zero_width: false,
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

/// A failed Helix lookup is retried after this long. A session used to cache
/// `None` for good, so one Helix hiccup on a chatter's first message left them
/// a monogram for the whole stream (plan 095, S3).
const TWITCH_AVATAR_MISS_RETRY: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
struct TwitchAvatarEntry {
    avatar: Option<String>,
    fetched_at: Instant,
}

impl TwitchAvatarEntry {
    /// A hit is final for the session; a miss is served until the retry window
    /// passes, then looked up again.
    fn serves(&self, now: Instant) -> bool {
        self.avatar.is_some() || now.duration_since(self.fetched_at) < TWITCH_AVATAR_MISS_RETRY
    }
}

/// Session-scoped avatar backfill: EventSub chat events carry no avatar, so
/// the FIRST message from each chatter costs one Helix `GET /users` lookup
/// (read scope) and every later message hits this cache. A failure is cached
/// as None for `TWITCH_AVATAR_MISS_RETRY` (the feed shows a monogram instead
/// of hammering Helix), then retried once more.
#[derive(Default)]
struct TwitchAvatarCache {
    by_user_id: std::collections::HashMap<String, TwitchAvatarEntry>,
}

impl TwitchAvatarCache {
    async fn lookup(
        &mut self,
        client: &reqwest::Client,
        config: &TwitchChatConfig,
        access_token: &str,
        user_id: &str,
    ) -> Option<String> {
        let now = Instant::now();
        if let Some(cached) = self
            .by_user_id
            .get(user_id)
            .filter(|cached| cached.serves(now))
        {
            return cached.avatar.clone();
        }
        let base = config
            .api_base_url
            .clone()
            .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
        let fetched = client
            .get(format!("{base}/helix/users"))
            .query(&[("id", user_id)])
            .bearer_auth(access_token)
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
        self.by_user_id.insert(
            user_id.to_string(),
            TwitchAvatarEntry {
                avatar: avatar.clone(),
                fetched_at: now,
            },
        );
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
        details: None,
        reply: None,
        first_message: false,
        author_affiliation: None,
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
    message.details = event["cheer"]["bits"]
        .as_u64()
        .map(|bits| LiveChatEventDetails::Cheer { bits });
    message.reply = parse_reply(&event["reply"]);
    // Twitch's own first-chat intro; other authors are checked against earlier
    // sessions at delivery (`mark_first_time_chatters`).
    message.first_message = event["message_type"].as_str() == Some("user_intro");
    message.raw_provider_type = Some("channel.chat.message".to_string());
    Some(message)
}

/// The threaded-reply parent of a chat message, when Twitch sends one.
fn parse_reply(reply: &Value) -> Option<LiveChatReply> {
    let parent_message_id = reply["parent_message_id"]
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some(LiveChatReply {
        parent_message_id: parent_message_id.to_string(),
        parent_author_name: reply["parent_user_name"]
            .as_str()
            .unwrap_or("a viewer")
            .to_string(),
        parent_text: reply["parent_message_body"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

fn u32_field(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|number| u32::try_from(number).ok())
}

fn tier_field(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|tier| !tier.is_empty())
        .map(ToOwned::to_owned)
}

fn subscription_details(
    kind: SubscriptionKind,
    body: &Value,
    months: Option<u32>,
    gift_count: Option<u32>,
    recipient_name: Option<String>,
) -> LiveChatEventDetails {
    // `community_sub_gift.id` on the community notice, `community_gift_id`
    // on each single gift it produces.
    let community_gift_id = body["community_gift_id"]
        .as_str()
        .or(if kind == SubscriptionKind::CommunitySubGift {
            body["id"].as_str()
        } else {
            None
        })
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned);
    LiveChatEventDetails::Subscription {
        subscription: kind,
        tier: tier_field(&body["sub_tier"]),
        is_prime: body["is_prime"].as_bool().unwrap_or(false),
        months,
        streak_months: u32_field(&body["streak_months"]),
        gift_count,
        recipient_name,
        community_gift_id,
    }
}

/// Structured facts for a `channel.chat.notification`, keyed by its notice
/// type. Field names follow the EventSub reference (plan 055 S0).
fn notification_details(notice_type: &str, event: &Value) -> Option<LiveChatEventDetails> {
    match notice_type {
        "sub" => Some(subscription_details(
            SubscriptionKind::Sub,
            &event["sub"],
            None,
            None,
            None,
        )),
        "resub" => {
            let body = &event["resub"];
            Some(subscription_details(
                SubscriptionKind::Resub,
                body,
                u32_field(&body["cumulative_months"]),
                None,
                None,
            ))
        }
        "sub_gift" => {
            let body = &event["sub_gift"];
            Some(subscription_details(
                SubscriptionKind::SubGift,
                body,
                None,
                Some(1),
                body["recipient_user_name"].as_str().map(ToOwned::to_owned),
            ))
        }
        "community_sub_gift" => {
            let body = &event["community_sub_gift"];
            Some(subscription_details(
                SubscriptionKind::CommunitySubGift,
                body,
                None,
                u32_field(&body["total"]),
                None,
            ))
        }
        "gift_paid_upgrade" => Some(subscription_details(
            SubscriptionKind::GiftPaidUpgrade,
            &event["gift_paid_upgrade"],
            None,
            None,
            None,
        )),
        "prime_paid_upgrade" => Some(subscription_details(
            SubscriptionKind::PrimePaidUpgrade,
            &event["prime_paid_upgrade"],
            None,
            None,
            None,
        )),
        "pay_it_forward" => Some(subscription_details(
            SubscriptionKind::PayItForward,
            &event["pay_it_forward"],
            None,
            None,
            None,
        )),
        "raid" => event["raid"]["viewer_count"]
            .as_u64()
            .map(|viewer_count| LiveChatEventDetails::Raid { viewer_count }),
        "watch_streak" => {
            let body = &event["watch_streak"];
            u32_field(&body["streak_count"]).map(|streak_count| LiveChatEventDetails::WatchStreak {
                streak_count,
                channel_points_awarded: body["channel_points_awarded"].as_u64(),
            })
        }
        "announcement" => Some(LiveChatEventDetails::Announcement {
            color: event["announcement"]["color"]
                .as_str()
                .filter(|color| !color.is_empty())
                .map(ToOwned::to_owned),
        }),
        _ => None,
    }
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
    let anonymous = event["chatter_is_anonymous"].as_bool().unwrap_or(false);
    message.author_name = if anonymous {
        "Anonymous".to_string()
    } else {
        event["chatter_user_name"]
            .as_str()
            .unwrap_or("Twitch")
            .to_string()
    };
    if !anonymous {
        message.author_id = event["chatter_user_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
    }
    if notice_type == "raid" {
        // The raiding channel is the author; its avatar rides along.
        message.author_avatar_url = event["raid"]["profile_image_url"]
            .as_str()
            .filter(|url| !url.is_empty())
            .map(ToOwned::to_owned);
    }
    message.message_text = text;
    message.fragments = parse_fragments(&event["message"]["fragments"]);
    // The viewer's own words ride in the fragments, beside Twitch's system
    // sentence in `message_text` (plan 151, S3): keep them when Twitch sent
    // the text without fragments.
    if message.fragments.is_empty()
        && let Some(words) = event["message"]["text"]
            .as_str()
            .filter(|words| !words.trim().is_empty())
    {
        message.fragments = vec![LiveChatMessageFragment {
            fragment_type: "text".to_string(),
            text: words.to_string(),
            image_url: None,
            zero_width: false,
        }];
    }
    message.event_type = notice_event_type(notice_type);
    message.details = notification_details(notice_type, event);
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
        "channel.follow" => normalize_follow(
            event,
            message_id,
            session_id,
            target_id,
            timestamp,
            received_at,
        ),
        BITS_USE_TYPE => normalize_bits_use(
            event,
            message_id,
            session_id,
            target_id,
            timestamp,
            received_at,
        ),
        CUSTOM_REDEMPTION_TYPE => normalize_custom_redemption(
            event,
            message_id,
            session_id,
            target_id,
            timestamp,
            received_at,
        ),
        AUTOMATIC_REDEMPTION_TYPE => normalize_automatic_redemption(
            event,
            message_id,
            session_id,
            target_id,
            timestamp,
            received_at,
        ),
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

/// `channel.follow` v2: the broadcaster moderates their own channel.
fn follow_subscription_body(broadcaster_user_id: &str, session_id: &str) -> Value {
    json!({
        "type": "channel.follow",
        "version": "2",
        "condition": {
            "broadcaster_user_id": broadcaster_user_id,
            "moderator_user_id": broadcaster_user_id,
        },
        "transport": {
            "method": "websocket",
            "session_id": session_id,
        },
    })
}

/// A follow as an Activity row; it never shows in the chat list.
fn normalize_follow(
    event: &Value,
    message_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let user_id = event["user_id"].as_str()?.to_string();
    let name = event["user_name"]
        .as_str()
        .or_else(|| event["user_login"].as_str())
        .unwrap_or("Someone")
        .to_string();
    let followed_at = event["followed_at"].as_str().or(timestamp);
    let mut message = base_message(
        format!("follow:{message_id}"),
        session_id,
        target_id,
        followed_at,
        received_at,
    );
    message.message_text = format!("{name} followed");
    message.author_id = Some(user_id);
    message.author_name = name;
    message.event_type = LiveChatEventType::Follow;
    message.details = Some(LiveChatEventDetails::Follow {
        handle: event["user_login"]
            .as_str()
            .map(str::trim)
            .filter(|login| !login.is_empty())
            .map(ToOwned::to_owned),
    });
    message.raw_provider_type = Some("channel.follow".to_string());
    Some(message)
}

/// Twitch Power-ups paid with bits, and cheers (plan 162).
const BITS_USE_TYPE: &str = "channel.bits.use";
/// A viewer redeemed one of the channel's own rewards (plan 162).
const CUSTOM_REDEMPTION_TYPE: &str = "channel.channel_points_custom_reward_redemption.add";
/// A viewer redeemed one of Twitch's automatic rewards (plan 162). Version 2:
/// v1 still lists rewards that became Power-ups paid with bits.
const AUTOMATIC_REDEMPTION_TYPE: &str = "channel.channel_points_automatic_reward_redemption.add";

/// A subscription whose only condition is the broadcaster (plan 162).
fn broadcaster_subscription_body(
    subscription_type: &str,
    version: &str,
    broadcaster_user_id: &str,
    session_id: &str,
) -> Value {
    json!({
        "type": subscription_type,
        "version": version,
        "condition": {
            "broadcaster_user_id": broadcaster_user_id,
        },
        "transport": {
            "method": "websocket",
            "session_id": session_id,
        },
    })
}

/// The viewer behind a bits or channel point event, as an Activity row's
/// author. Twitch names them on every such event; "Someone" is a fallback.
fn activity_author(message: &mut LiveChatMessage, event: &Value) -> String {
    let name = event["user_name"]
        .as_str()
        .or_else(|| event["user_login"].as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Someone")
        .to_string();
    message.author_id = event["user_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned);
    message.author_name = name.clone();
    name
}

/// What the viewer typed with a bits or channel point event, as fragments.
fn activity_words(text: Option<&str>, fragments: &Value) -> Vec<LiveChatMessageFragment> {
    let parsed = parse_fragments(fragments);
    if !parsed.is_empty() {
        return parsed;
    }
    text.map(str::trim)
        .filter(|words| !words.is_empty())
        .map(|words| {
            vec![LiveChatMessageFragment {
                fragment_type: "text".to_string(),
                text: words.to_string(),
                image_url: None,
                zero_width: false,
            }]
        })
        .unwrap_or_default()
}

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

/// `channel.bits.use` as an Activity row (plan 162). A cheer is skipped: it
/// always posts a chat message, which already makes the Cheer row (D2).
fn normalize_bits_use(
    event: &Value,
    message_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let use_type = event["type"].as_str().unwrap_or_default();
    if use_type == "cheer" {
        return None;
    }
    let bits = event["bits"].as_u64()?;
    let power_up = if use_type == "custom_power_up" {
        PowerUpKind::Custom
    } else {
        match event["power_up"]["type"].as_str().unwrap_or_default() {
            "celebration" => PowerUpKind::Celebration,
            "gigantify_an_emote" => PowerUpKind::GigantifyAnEmote,
            "message_effect" => PowerUpKind::MessageEffect,
            _ => PowerUpKind::Custom,
        }
    };
    let emote_name = non_empty(&event["power_up"]["emote"]["name"]);
    // A Custom Power-up's own name (plan 163); Twitch sends no icon with it.
    let title = non_empty(&event["custom_power_up"]["title"]);
    let mut message = base_message(
        format!("bits:{message_id}"),
        session_id,
        target_id,
        timestamp,
        received_at,
    );
    let name = activity_author(&mut message, event);
    message.message_text = match (power_up, emote_name.as_deref()) {
        (PowerUpKind::Celebration, _) => format!("{name} used a Celebration"),
        (PowerUpKind::GigantifyAnEmote, Some(emote)) => format!("{name} gigantified {emote}"),
        (PowerUpKind::GigantifyAnEmote, None) => format!("{name} gigantified an emote"),
        (PowerUpKind::MessageEffect, _) => format!("{name} sent a message effect"),
        (PowerUpKind::Custom, _) => match title.as_deref() {
            Some(title) => format!("{name} used {title}"),
            None => format!("{name} used a Power-up"),
        },
    };
    message.fragments = activity_words(
        event["message"]["text"].as_str(),
        &event["message"]["fragments"],
    );
    message.event_type = LiveChatEventType::PowerUp;
    message.details = Some(LiveChatEventDetails::PowerUp {
        bits,
        power_up,
        emote_name,
        title,
    });
    message.raw_provider_type = Some(format!("{BITS_USE_TYPE}:{use_type}"));
    Some(message)
}

/// A custom channel point reward as an Activity row (plan 162). Keyed by the
/// redemption id, which survives a redelivery.
fn normalize_custom_redemption(
    event: &Value,
    message_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let redemption_id = non_empty(&event["id"]).unwrap_or_else(|| message_id.to_string());
    let reward = &event["reward"];
    let title = non_empty(&reward["title"]);
    let mut message = base_message(
        format!("redemption:{redemption_id}"),
        session_id,
        target_id,
        event["redeemed_at"].as_str().or(timestamp),
        received_at,
    );
    let name = activity_author(&mut message, event);
    message.message_text = match title.as_deref() {
        Some(title) => format!("{name} redeemed {title}"),
        None => format!("{name} redeemed a reward"),
    };
    message.fragments = activity_words(event["user_input"].as_str(), &Value::Null);
    message.event_type = LiveChatEventType::Redemption;
    message.details = Some(LiveChatEventDetails::Redemption {
        reward: RedemptionKind::Custom,
        channel_points: reward["cost"].as_u64().unwrap_or(0),
        title,
        emote_name: None,
        points_name: None,
    });
    message.raw_provider_type = Some(CUSTOM_REDEMPTION_TYPE.to_string());
    Some(message)
}

/// One of Twitch's automatic rewards as an Activity row (plan 162). Reads v2
/// (`channel_points`, `emote`) and tolerates v1 names (`cost`,
/// `unlocked_emote`).
fn normalize_automatic_redemption(
    event: &Value,
    message_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    timestamp: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let redemption_id = non_empty(&event["id"]).unwrap_or_else(|| message_id.to_string());
    let reward_body = &event["reward"];
    let reward = match reward_body["type"].as_str().unwrap_or_default() {
        "send_highlighted_message" => RedemptionKind::HighlightedMessage,
        "single_message_bypass_sub_mode" => RedemptionKind::SubOnlyMessage,
        "random_sub_emote_unlock" => RedemptionKind::RandomEmoteUnlock,
        "chosen_sub_emote_unlock" => RedemptionKind::ChosenEmoteUnlock,
        "chosen_modified_sub_emote_unlock" => RedemptionKind::ModifiedEmoteUnlock,
        _ => RedemptionKind::Other,
    };
    let emote_name = non_empty(&reward_body["emote"]["name"])
        .or_else(|| non_empty(&reward_body["unlocked_emote"]["name"]));
    let mut message = base_message(
        format!("redemption:{redemption_id}"),
        session_id,
        target_id,
        event["redeemed_at"].as_str().or(timestamp),
        received_at,
    );
    let name = activity_author(&mut message, event);
    message.message_text = match (reward, emote_name.as_deref()) {
        (RedemptionKind::HighlightedMessage, _) => format!("{name} highlighted their message"),
        (RedemptionKind::SubOnlyMessage, _) => format!("{name} sent a message in sub-only mode"),
        (
            RedemptionKind::RandomEmoteUnlock
            | RedemptionKind::ChosenEmoteUnlock
            | RedemptionKind::ModifiedEmoteUnlock,
            emote,
        ) => match emote {
            Some(emote) => format!("{name} unlocked {emote}"),
            None => format!("{name} unlocked an emote"),
        },
        _ => format!("{name} redeemed a reward"),
    };
    message.fragments = activity_words(
        event["message"]["text"]
            .as_str()
            .or_else(|| event["user_input"].as_str()),
        &event["message"]["fragments"],
    );
    message.event_type = LiveChatEventType::Redemption;
    message.details = Some(LiveChatEventDetails::Redemption {
        reward,
        channel_points: reward_body["channel_points"]
            .as_u64()
            .or_else(|| reward_body["cost"].as_u64())
            .unwrap_or(0),
        title: None,
        emote_name,
        points_name: None,
    });
    message.raw_provider_type = Some(AUTOMATIC_REDEMPTION_TYPE.to_string());
    Some(message)
}

/// Twitch's own GraphQL endpoint, the one twitch.tv's pages read. Helix has
/// no field for a channel's points name or icon (plan 163), so this is the
/// only place Videorc can read "Orc Gold". It is unofficial: it can change or
/// refuse without notice, so every failure falls back to "points". Only the
/// channel's public id is sent, never a Videorc token.
const TWITCH_GQL_URL: &str = "https://gql.twitch.tv/gql";
/// The public client id twitch.tv's web pages send with every GQL request.
const TWITCH_WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const POINTS_NAME_TIMEOUT: Duration = Duration::from_secs(5);
/// Twitch caps the name well below this; a longer one is not trusted.
const MAX_POINTS_NAME_CHARS: usize = 64;

/// What the channel calls its points, from Twitch's GQL reply. `Ok(None)` is
/// a channel that kept Twitch's default name.
fn parse_channel_points_name(body: &Value) -> std::result::Result<Option<String>, String> {
    let settings = &body["data"]["user"]["channel"]["communityPointsSettings"];
    if !settings.is_object() {
        return Err("Twitch returned no channel points settings".to_string());
    }
    Ok(non_empty(&settings["name"]).filter(|name| name.chars().count() <= MAX_POINTS_NAME_CHARS))
}

async fn fetch_channel_points_name(
    client: &reqwest::Client,
    config: &TwitchChatConfig,
) -> std::result::Result<Option<String>, String> {
    // Tests point `api_base_url` at a mock; the read follows it, so no test
    // ever reaches Twitch.
    let url = config
        .api_base_url
        .as_deref()
        .map(|base| format!("{}/gql", base.trim_end_matches('/')))
        .unwrap_or_else(|| TWITCH_GQL_URL.to_string());
    let response = client
        .post(url)
        .header("Client-Id", TWITCH_WEB_CLIENT_ID)
        .timeout(POINTS_NAME_TIMEOUT)
        .json(&json!({
            "operationName": "ChannelPointsName",
            "query": "query ChannelPointsName($id: ID!) { user(id: $id) { channel { communityPointsSettings { name } } } }",
            "variables": { "id": config.broadcaster_user_id },
        }))
        .send()
        .await
        .map_err(|error| format!("could not reach Twitch: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Twitch answered HTTP {}", response.status()));
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("unreadable reply: {error}"))?;
    parse_channel_points_name(&body)
}

/// The channel's points name for this stream, read on the first redemption
/// (plan 163). A failed read is logged once and not retried: the rows say
/// "points" instead.
#[derive(Debug, Default)]
struct ChannelPointsName {
    read: bool,
    name: Option<String>,
}

impl ChannelPointsName {
    async fn get(
        &mut self,
        state: &AppState,
        client: &reqwest::Client,
        config: &TwitchChatConfig,
    ) -> Option<String> {
        if !self.read {
            self.read = true;
            match fetch_channel_points_name(client, config).await {
                Ok(name) => self.name = name,
                Err(error) => state.emit_log(
                    "warn",
                    format!(
                        "Could not read the Twitch channel points name ({error}); Activity says points."
                    ),
                ),
            }
        }
        self.name.clone()
    }
}

fn stamp_points_name(message: &mut LiveChatMessage, name: Option<String>) {
    if let Some(LiveChatEventDetails::Redemption { points_name, .. }) = &mut message.details {
        *points_name = name;
    }
}

fn next_backoff_ms(current: u64) -> u64 {
    current
        .saturating_mul(2)
        .clamp(MIN_BACKOFF_MS, MAX_BACKOFF_MS)
}

// --- Live transport ---

enum SessionOutcome {
    Reconnect(Option<String>),
    Fatal(String),
}

/// Why subscribing failed: a refused token can be renewed, anything else
/// needs the user.
#[derive(Debug)]
enum SubscribeError {
    Unauthorized,
    Other(anyhow::Error),
}

/// The optional event subscriptions on top of chat: follows (plan 055) and
/// Power-ups and channel point redemptions (plan 162). Each is held only with
/// its opt-in scope, and a refusal never costs the chat itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ExtraEvents {
    follows: bool,
    bits: bool,
    redemptions: bool,
}

impl ExtraEvents {
    fn any_missing_from(self, live: ExtraEvents) -> bool {
        (self.follows && !live.follows)
            || (self.bits && !live.bits)
            || (self.redemptions && !live.redemptions)
    }
}

/// Makes the chat subscriptions, then whichever optional ones `wanted` names.
/// Returns which optional ones Twitch holds on this socket.
async fn create_subscriptions(
    client: &reqwest::Client,
    config: &TwitchChatConfig,
    access_token: &str,
    session_id: &str,
    wanted: ExtraEvents,
) -> std::result::Result<ExtraEvents, SubscribeError> {
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
        let response = client
            .post(&url)
            .bearer_auth(access_token)
            .header("Client-Id", &config.client_id)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("Could not create {subscription_type} subscription."))
            .map_err(SubscribeError::Other)?;
        match response.status() {
            status if status.is_success() => {}
            // A retry after a renewal finds the ones made before the refusal.
            reqwest::StatusCode::CONFLICT => {}
            reqwest::StatusCode::UNAUTHORIZED => return Err(SubscribeError::Unauthorized),
            status => {
                return Err(SubscribeError::Other(anyhow::anyhow!(
                    "Twitch rejected the {subscription_type} subscription (HTTP {status})."
                )));
            }
        }
    }
    // The rest are extra: a refusal here never costs the chat itself.
    create_extra_subscriptions(
        client,
        config,
        access_token,
        session_id,
        wanted,
        ExtraEvents::default(),
    )
    .await
    .map_err(SubscribeError::Other)
}

/// Creates each optional subscription `wanted` names that `live` lacks.
/// Returns `live` plus the ones Twitch now holds (a 409 means an earlier
/// attempt already made it). Only a transport failure is an error.
async fn create_extra_subscriptions(
    client: &reqwest::Client,
    config: &TwitchChatConfig,
    access_token: &str,
    session_id: &str,
    wanted: ExtraEvents,
    mut live: ExtraEvents,
) -> Result<ExtraEvents> {
    let broadcaster = config.broadcaster_user_id.as_str();
    if wanted.follows && !live.follows {
        live.follows = create_extra_subscription(
            client,
            config,
            access_token,
            &follow_subscription_body(broadcaster, session_id),
        )
        .await;
    }
    if wanted.bits && !live.bits {
        live.bits = create_extra_subscription(
            client,
            config,
            access_token,
            &broadcaster_subscription_body(BITS_USE_TYPE, "1", broadcaster, session_id),
        )
        .await;
    }
    if wanted.redemptions && !live.redemptions {
        // Both reward kinds ride one scope; the row is live when both are.
        let custom = create_extra_subscription(
            client,
            config,
            access_token,
            &broadcaster_subscription_body(CUSTOM_REDEMPTION_TYPE, "1", broadcaster, session_id),
        )
        .await;
        let automatic = create_extra_subscription(
            client,
            config,
            access_token,
            &broadcaster_subscription_body(AUTOMATIC_REDEMPTION_TYPE, "2", broadcaster, session_id),
        )
        .await;
        live.redemptions = custom && automatic;
    }
    Ok(live)
}

/// One optional subscription on this socket. True when Twitch holds it.
async fn create_extra_subscription(
    client: &reqwest::Client,
    config: &TwitchChatConfig,
    access_token: &str,
    body: &Value,
) -> bool {
    let base_url = config
        .api_base_url
        .clone()
        .unwrap_or_else(|| TWITCH_API_BASE_URL.to_string());
    let url = format!(
        "{}/helix/eventsub/subscriptions",
        base_url.trim_end_matches('/')
    );
    client
        .post(url)
        .bearer_auth(access_token)
        .header("Client-Id", &config.client_id)
        .json(body)
        .send()
        .await
        .is_ok_and(|response| {
            response.status().is_success() || response.status() == reqwest::StatusCode::CONFLICT
        })
}

/// Which optional events the account now allows. Read from the stored
/// account, not only the start config, so a reconnect that grants a scope
/// mid-stream starts its events on the open socket (plan 071, S2; plan 162).
fn extra_events_held(state: &AppState, config: &TwitchChatConfig) -> ExtraEvents {
    let mut held = ExtraEvents {
        follows: config.follow_events,
        bits: config.bits_events,
        redemptions: config.redemption_events,
    };
    let crate::session_token::SessionTokenSource::Account {
        platform: StreamPlatform::Twitch,
        account_id,
    } = &config.token_source
    else {
        return held;
    };
    if let Ok(credential) = crate::twitch_account_credentials(state, account_id.as_deref()) {
        let holds = |wanted: &str| {
            credential
                .account
                .scopes
                .iter()
                .any(|scope| scope == wanted)
        };
        held.follows |= holds(crate::oauth::TWITCH_FOLLOWERS_SCOPE);
        held.bits |= holds(crate::oauth::TWITCH_BITS_SCOPE);
        held.redemptions |= holds(crate::oauth::TWITCH_REDEMPTIONS_SCOPE);
    }
    held
}

/// Logs the optional Power-up and redemption subscriptions Twitch refused,
/// once per attempt: a channel without bits or channel points refuses them,
/// and chat carries on (plan 162, D5).
fn log_refused_extras(state: &AppState, wanted: ExtraEvents, live: ExtraEvents) {
    if wanted.bits && !live.bits {
        state.emit_log(
            "warn",
            "Twitch refused the Power-ups subscription; Activity will not list Power-ups this stream."
                .to_string(),
        );
    }
    if wanted.redemptions && !live.redemptions {
        state.emit_log(
            "warn",
            "Twitch refused the channel point subscriptions; Activity will not list redemptions this stream."
                .to_string(),
        );
    }
}

/// How often an open socket missing an optional subscription checks whether
/// its scope arrived. Keepalives come about every 10 s; the check is a local
/// read.
const EXTRA_SCOPE_RECHECK: Duration = Duration::from_secs(30);

/// Subscribes this socket, renewing a refused token once (plan 055, B2).
async fn subscribe_socket(
    state: &AppState,
    client: &reqwest::Client,
    config: &TwitchChatConfig,
    token: &mut crate::session_token::SessionToken,
    socket_session: &str,
) -> std::result::Result<ExtraEvents, String> {
    let wanted = extra_events_held(state, config);
    let access_token = token.ensure_fresh(state, client).await.to_string();
    let subscribe_failed = |error: anyhow::Error| {
        state.emit_log(
            "warn",
            format!("Twitch chat subscription failed: {error:#}"),
        );
        "Could not subscribe to Twitch live chat. Reconnect Twitch to enable live comments."
            .to_string()
    };
    match create_subscriptions(client, config, &access_token, socket_session, wanted).await {
        Ok(live) => {
            log_refused_extras(state, wanted, live);
            return Ok(live);
        }
        Err(SubscribeError::Other(error)) => return Err(subscribe_failed(error)),
        Err(SubscribeError::Unauthorized) => {}
    }
    let Ok(renewed) = token.renew_after_refusal(state, client).await else {
        return Err(TWITCH_SIGN_IN_EXPIRED.to_string());
    };
    let renewed = renewed.to_string();
    let live = create_subscriptions(client, config, &renewed, socket_session, wanted)
        .await
        .map_err(|error| match error {
            SubscribeError::Unauthorized => TWITCH_SIGN_IN_EXPIRED.to_string(),
            SubscribeError::Other(error) => subscribe_failed(error),
        })?;
    log_refused_extras(state, wanted, live);
    Ok(live)
}

/// The provider message when Twitch refuses even a renewed token.
pub const TWITCH_SIGN_IN_EXPIRED: &str =
    "Twitch sign-in expired. Reconnect Twitch to keep live comments.";

/// One EventSub socket. `subscribe` is false for a socket opened from a
/// Twitch `session_reconnect` URL: its subscriptions carry over, and making
/// them again would be refused.
#[allow(clippy::too_many_arguments)]
async fn run_eventsub_session(
    state: &AppState,
    session_owner: (&str, u64),
    config: &TwitchChatConfig,
    token: &mut crate::session_token::SessionToken,
    client: &reqwest::Client,
    ws_url: &str,
    subscribe: bool,
    seen: &mut HashSet<String>,
    avatars: &mut TwitchAvatarCache,
    points_name: &mut ChannelPointsName,
    extras_live: &mut ExtraEvents,
) -> SessionOutcome {
    let (session_id, session_generation) = session_owner;
    let Ok((ws_stream, _response)) = connect_async(ws_url).await else {
        return SessionOutcome::Reconnect(None);
    };
    let (mut sink, mut stream) = ws_stream.split();
    let mut socket_session_id: Option<String> = None;
    let mut extra_scopes_checked_at = std::time::Instant::now();
    // Power-ups and redemptions a channel refused are not asked for again on
    // this socket; follows keep retrying, as before plan 162.
    let mut extras_attempted = *extras_live;

    while let Some(frame) = stream.next().await {
        let Ok(message) = frame else {
            return SessionOutcome::Reconnect(None);
        };
        match message {
            Message::Text(text) => match parse_envelope(text.as_str()) {
                EventSubFrame::Welcome {
                    session_id: socket_session,
                } => {
                    // A socket from Twitch's reconnect URL keeps the old
                    // socket's subscriptions, follows included.
                    if subscribe {
                        match subscribe_socket(state, client, config, token, &socket_session).await
                        {
                            Ok(live) => {
                                *extras_live = live;
                                extras_attempted = extra_events_held(state, config);
                                crate::audience::set_named_follows(
                                    state,
                                    session_id,
                                    StreamPlatform::Twitch,
                                    live.follows,
                                );
                            }
                            Err(message) => return SessionOutcome::Fatal(message),
                        }
                    }
                    socket_session_id = Some(socket_session);
                    extra_scopes_checked_at = std::time::Instant::now();
                    set_provider_and_emit(
                        state,
                        session_id,
                        session_generation,
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
                    warn_rejected_gif_assets(state, &event["message"]["fragments"]);
                    if let Some(mut message) = normalize_notification(
                        &subscription_type,
                        &event,
                        &message_id,
                        timestamp.as_deref(),
                        session_id,
                        config.target_id.as_deref(),
                        &now,
                    ) && !seen.contains(&message.provider_message_id)
                    {
                        // A redemption says the channel's own name for its
                        // points (plan 163): read once, on the first one.
                        if matches!(
                            message.details,
                            Some(LiveChatEventDetails::Redemption { .. })
                        ) {
                            let name = points_name.get(state, client, config).await;
                            stamp_points_name(&mut message, name);
                        }
                        // EventSub carries no avatar; backfill once per chatter
                        // (Comments window upgrade S1).
                        if message.author_avatar_url.is_none()
                            && let Some(author_id) = message.author_id.clone()
                        {
                            message.author_avatar_url = avatars
                                .lookup(client, config, token.current(), &author_id)
                                .await;
                        }
                        let provider_message_id = message.provider_message_id.clone();
                        let mut persistence_backoff_ms = MIN_BACKOFF_MS;
                        let mut waited_for_storage = false;
                        loop {
                            match try_deliver_message(state, session_generation, message.clone())
                                .await
                            {
                                Ok(()) => break,
                                Err(error) if error.is_terminal() => {
                                    return SessionOutcome::Fatal(format!(
                                        "Twitch live chat stopped because comments storage failed: {error}"
                                    ));
                                }
                                Err(error) => {
                                    // EventSub WebSockets do not guarantee notification
                                    // replay. Retain this exact normalized message locally,
                                    // release global delivery ordering between attempts, and
                                    // retry it before reading a later Twitch frame.
                                    waited_for_storage = true;
                                    set_provider_and_emit(
                                        state,
                                        session_id,
                                        session_generation,
                                        StreamPlatform::Twitch,
                                        config.target_id.as_deref(),
                                        LiveChatProviderConnectionState::Waiting,
                                        &format!(
                                            "Waiting for comments storage before accepting more Twitch messages: {error}"
                                        ),
                                    )
                                    .await;
                                    sleep(Duration::from_millis(persistence_backoff_ms)).await;
                                    persistence_backoff_ms =
                                        next_backoff_ms(persistence_backoff_ms);
                                }
                            }
                        }
                        if waited_for_storage {
                            set_provider_and_emit(
                                state,
                                session_id,
                                session_generation,
                                StreamPlatform::Twitch,
                                config.target_id.as_deref(),
                                LiveChatProviderConnectionState::Connected,
                                "Twitch live chat connected; comments storage recovered.",
                            )
                            .await;
                        }
                        seen.insert(provider_message_id);
                    }
                }
                EventSubFrame::Reconnect { reconnect_url } => {
                    return SessionOutcome::Reconnect(reconnect_url);
                }
                EventSubFrame::Revocation => {
                    return SessionOutcome::Fatal(
                        "Twitch revoked live chat access. Reconnect Twitch to enable live comments."
                            .to_string(),
                    );
                }
                // Keepalives only pace the scope recheck below.
                EventSubFrame::Keepalive => {}
                EventSubFrame::Unknown => {}
            },
            Message::Ping(payload) => {
                let _ = sink.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => return SessionOutcome::Reconnect(None),
            _ => {}
        }
        // A scope can arrive mid-stream (Show who followed, the Activity
        // reconnect): add its events to this socket without a new Go Live.
        // Checked after every frame, not only keepalives: Twitch sends those
        // only while the socket is quiet, so a busy chat would never recheck.
        if let Some(socket_session) = socket_session_id.as_deref()
            && extra_scopes_checked_at.elapsed() >= EXTRA_SCOPE_RECHECK
        {
            extra_scopes_checked_at = std::time::Instant::now();
            let held = extra_events_held(state, config);
            let wanted = ExtraEvents {
                follows: held.follows,
                bits: held.bits && !extras_attempted.bits,
                redemptions: held.redemptions && !extras_attempted.redemptions,
            };
            if wanted.any_missing_from(*extras_live) {
                let access_token = token.ensure_fresh(state, client).await.to_string();
                if let Ok(live) = create_extra_subscriptions(
                    client,
                    config,
                    &access_token,
                    socket_session,
                    wanted,
                    *extras_live,
                )
                .await
                {
                    let newly = ExtraEvents {
                        follows: false,
                        bits: wanted.bits && !extras_live.bits,
                        redemptions: wanted.redemptions && !extras_live.redemptions,
                    };
                    log_refused_extras(state, newly, live);
                    if live.follows && !extras_live.follows {
                        crate::audience::set_named_follows(
                            state,
                            session_id,
                            StreamPlatform::Twitch,
                            true,
                        );
                    }
                    *extras_live = live;
                    extras_attempted.bits |= held.bits;
                    extras_attempted.redemptions |= held.redemptions;
                }
            }
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
    session_generation: u64,
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
    let mut token = crate::session_token::SessionToken::new(
        config.access_token.clone(),
        config.token_source.clone(),
    );
    let mut subscribe = true;

    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        StreamPlatform::Twitch,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to Twitch live chat…",
    )
    .await;

    let mut avatars = TwitchAvatarCache::default();
    let mut points_name = ChannelPointsName::default();
    let mut extras_live = ExtraEvents::default();
    loop {
        match run_eventsub_session(
            &state,
            (&session_id, session_generation),
            &config,
            &mut token,
            &client,
            &ws_url,
            subscribe,
            &mut seen,
            &mut avatars,
            &mut points_name,
            &mut extras_live,
        )
        .await
        {
            SessionOutcome::Reconnect(next_url) => {
                // Twitch's own reconnect URL carries the subscriptions over;
                // a dropped socket starts a new session that needs them.
                subscribe = next_url.is_none();
                ws_url = next_url.unwrap_or_else(|| default_ws_url.clone());
                set_provider_and_emit(
                    &state,
                    &session_id,
                    session_generation,
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
                if extras_live.follows {
                    // No named follows from here on: counts show again.
                    crate::audience::set_named_follows(
                        &state,
                        &session_id,
                        StreamPlatform::Twitch,
                        false,
                    );
                }
                set_provider_and_emit(
                    &state,
                    &session_id,
                    session_generation,
                    StreamPlatform::Twitch,
                    config.target_id.as_deref(),
                    LiveChatProviderConnectionState::Failed,
                    &message,
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
    use crate::live_chat_persistence::{BatchWriter, LiveChatPersistence};
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
        socket_connections: Arc<AtomicUsize>,
        notifications_sent: Arc<AtomicUsize>,
        replay_notifications: bool,
        frame: Arc<String>,
        /// Subscription types the mock refuses with 403 (plan 162).
        refused_types: Arc<Vec<&'static str>>,
    }

    async fn mock_eventsub_ws(
        State(state): State<MockTwitchServerState>,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        state.socket_connections.fetch_add(1, Ordering::SeqCst);
        ws.on_upgrade(move |mut socket| async move {
            let welcome = json!({
                "metadata": { "message_type": "session_welcome" },
                "payload": { "session": { "id": "socket-session-1" } }
            })
            .to_string();
            let _ = socket.send(AxumMessage::Text(welcome.into())).await;
            sleep(Duration::from_millis(100)).await;
            let should_send = if state.replay_notifications {
                state.notifications_sent.fetch_add(1, Ordering::SeqCst);
                true
            } else {
                state
                    .notifications_sent
                    .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            };
            if should_send {
                let _ = socket
                    .send(AxumMessage::Text(state.frame.as_str().into()))
                    .await;
            }
            sleep(Duration::from_millis(100)).await;
        })
    }

    async fn mock_subscriptions(
        State(state): State<MockTwitchServerState>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let refused = state
            .refused_types
            .iter()
            .any(|refused| body["type"] == *refused);
        state.subscriptions.lock().await.push(body);
        if refused {
            return (StatusCode::FORBIDDEN, Json(json!({ "error": "Forbidden" })));
        }
        (StatusCode::ACCEPTED, Json(json!({ "data": [] })))
    }

    /// Twitch's GQL, as the points-name read must call it (plan 163): no
    /// Videorc token, twitch.tv's web client id and the channel's id as a
    /// variable. Anything else is refused, so the row would say "points".
    async fn mock_gql(
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        let well_formed = headers.get("authorization").is_none()
            && headers
                .get("client-id")
                .is_some_and(|id| id == TWITCH_WEB_CLIENT_ID)
            && body["variables"]["id"] == "broadcaster-1";
        if !well_formed {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad request" })),
            );
        }
        (
            StatusCode::OK,
            Json(json!({
                "data": { "user": { "channel": {
                    "communityPointsSettings": { "name": "Orc Gold" }
                } } }
            })),
        )
    }

    async fn mock_users() -> Json<Value> {
        Json(json!({
            "data": [
                { "id": "987", "profile_image_url": "https://static-cdn.jtvnw.net/viewer.png" }
            ]
        }))
    }

    async fn spawn_mock_twitch_server() -> (
        String,
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
    ) {
        spawn_mock_twitch_server_with_notification_replay(true).await
    }

    async fn spawn_mock_twitch_server_sending_notification_once() -> (
        String,
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
    ) {
        spawn_mock_twitch_server_with_notification_replay(false).await
    }

    async fn spawn_mock_twitch_server_with_notification_replay(
        replay_notifications: bool,
    ) -> (
        String,
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
    ) {
        spawn_mock_twitch_server_sending(replay_notifications, chat_message_frame()).await
    }

    async fn spawn_mock_twitch_server_sending(
        replay_notifications: bool,
        frame: String,
    ) -> (
        String,
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
    ) {
        spawn_mock_twitch_server_refusing(replay_notifications, frame, Vec::new()).await
    }

    async fn spawn_mock_twitch_server_refusing(
        replay_notifications: bool,
        frame: String,
        refused_types: Vec<&'static str>,
    ) -> (
        String,
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        oneshot::Sender<()>,
    ) {
        let subscriptions = Arc::new(Mutex::new(Vec::new()));
        let socket_connections = Arc::new(AtomicUsize::new(0));
        let notifications_sent = Arc::new(AtomicUsize::new(0));
        let state = MockTwitchServerState {
            subscriptions: subscriptions.clone(),
            socket_connections: socket_connections.clone(),
            notifications_sent: notifications_sent.clone(),
            replay_notifications,
            frame: Arc::new(frame),
            refused_types: Arc::new(refused_types),
        };
        let app = Router::new()
            .route("/eventsub", get(mock_eventsub_ws))
            .route("/helix/eventsub/subscriptions", post(mock_subscriptions))
            .route("/helix/users", get(mock_users))
            .route("/gql", post(mock_gql))
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
            socket_connections,
            notifications_sent,
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
            moderate: None,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting to Twitch live chat…".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
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

    async fn wait_for_persistence_rejection(state: &AppState) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
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
                "timed out waiting for forced Twitch persistence rejection"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn wait_for_persisted_message(state: &AppState, provider_message_id: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
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
                "timed out waiting for durable Twitch message {provider_message_id}"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn wait_for_terminal_storage_failure(state: &AppState) -> LiveChatProviderState {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = current_status(state).await;
            if let Some(provider) = snapshot.providers.into_iter().find(|provider| {
                provider.platform == StreamPlatform::Twitch
                    && provider.state == LiveChatProviderConnectionState::Failed
            }) {
                return provider;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "timed out waiting for terminal Twitch comments-storage failure"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    /// A Twitch whose first socket drops after the user token expired
    /// (plan 055, B2): the next socket's subscriptions refuse `token-1`
    /// and accept only `token-2`. With `twitch_reconnect`, the first socket
    /// instead hands over through a `session_reconnect` URL.
    #[derive(Clone)]
    struct ExpiringTokenTwitch {
        sockets: Arc<AtomicUsize>,
        expired: Arc<std::sync::atomic::AtomicBool>,
        accepted: Arc<Mutex<Vec<String>>>,
        refused: Arc<AtomicUsize>,
        twitch_reconnect: bool,
        base_ws: Arc<std::sync::OnceLock<String>>,
    }

    async fn expiring_eventsub_ws(
        State(server): State<ExpiringTokenTwitch>,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        let socket_number = server.sockets.fetch_add(1, Ordering::SeqCst) + 1;
        ws.on_upgrade(move |mut socket| async move {
            let welcome = json!({
                "metadata": { "message_type": "session_welcome" },
                "payload": { "session": { "id": format!("socket-{socket_number}") } }
            })
            .to_string();
            let _ = socket.send(AxumMessage::Text(welcome.into())).await;
            if socket_number == 1 {
                // Let the first subscriptions land, then the token expires.
                sleep(Duration::from_millis(150)).await;
                server
                    .expired
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                if server.twitch_reconnect {
                    let reconnect = json!({
                        "metadata": { "message_type": "session_reconnect" },
                        "payload": { "session": {
                            "id": "socket-1",
                            "reconnect_url": server.base_ws.get().unwrap(),
                        } }
                    })
                    .to_string();
                    let _ = socket.send(AxumMessage::Text(reconnect.into())).await;
                }
                return;
            }
            // Later sockets deliver chat once they are usable.
            sleep(Duration::from_millis(150)).await;
            let _ = socket
                .send(AxumMessage::Text(chat_message_frame().into()))
                .await;
            sleep(Duration::from_millis(500)).await;
        })
    }

    async fn expiring_subscriptions(
        State(server): State<ExpiringTokenTwitch>,
        headers: axum::http::HeaderMap,
    ) -> (StatusCode, Json<Value>) {
        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .trim_start_matches("Bearer ")
            .to_string();
        let expired = server.expired.load(std::sync::atomic::Ordering::SeqCst);
        if token == "token-2" || (token == "token-1" && !expired) {
            server.accepted.lock().await.push(token);
            (StatusCode::ACCEPTED, Json(json!({ "data": [] })))
        } else {
            server.refused.fetch_add(1, Ordering::SeqCst);
            (StatusCode::UNAUTHORIZED, Json(json!({ "status": 401 })))
        }
    }

    async fn spawn_expiring_token_twitch(
        twitch_reconnect: bool,
    ) -> (String, String, ExpiringTokenTwitch) {
        let server = ExpiringTokenTwitch {
            sockets: Arc::new(AtomicUsize::new(0)),
            expired: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            accepted: Arc::new(Mutex::new(Vec::new())),
            refused: Arc::new(AtomicUsize::new(0)),
            twitch_reconnect,
            base_ws: Arc::new(std::sync::OnceLock::new()),
        };
        let app = Router::new()
            .route("/eventsub", get(expiring_eventsub_ws))
            .route(
                "/helix/eventsub/subscriptions",
                post(expiring_subscriptions),
            )
            .route("/helix/users", get(mock_users))
            .with_state(server.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("mock twitch listener");
        let addr = listener.local_addr().expect("mock twitch addr");
        let ws_url = format!("ws://{addr}/eventsub");
        server.base_ws.set(ws_url.clone()).unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), ws_url, server)
    }

    fn expiring_config(
        api_base_url: String,
        eventsub_ws_url: String,
        token_source: crate::session_token::SessionTokenSource,
    ) -> TwitchChatConfig {
        TwitchChatConfig {
            access_token: "token-1".to_string(),
            client_id: "client-1".to_string(),
            broadcaster_user_id: "broadcaster-1".to_string(),
            user_id: "user-1".to_string(),
            target_id: Some("twitch".to_string()),
            eventsub_ws_url: Some(eventsub_ws_url),
            api_base_url: Some(api_base_url),
            token_source,
            follow_events: false,
            bits_events: false,
            redemption_events: false,
        }
    }

    #[tokio::test]
    async fn chat_keeps_flowing_after_the_token_expires_mid_session() {
        let (api, ws, server) = spawn_expiring_token_twitch(false).await;
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };
        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            expiring_config(
                api,
                ws,
                crate::session_token::SessionTokenSource::scripted(vec![Ok("token-2")]),
            ),
        ));

        let snapshot = wait_for_twitch_message(&state).await;
        connector.abort();
        let twitch = snapshot
            .providers
            .iter()
            .find(|provider| provider.platform == StreamPlatform::Twitch)
            .unwrap();
        assert_eq!(twitch.state, LiveChatProviderConnectionState::Connected);
        let accepted = server.accepted.lock().await.clone();
        let renewed = accepted.iter().filter(|token| *token == "token-2").count();
        assert_eq!(renewed, CHAT_SUBSCRIPTION_TYPES.len(), "{accepted:?}");
        assert_eq!(server.refused.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_revoked_refresh_token_fails_clearly_instead_of_going_quiet() {
        let (api, ws, _server) = spawn_expiring_token_twitch(false).await;
        let state = test_state();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };
        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            expiring_config(
                api,
                ws,
                crate::session_token::SessionTokenSource::scripted(vec![Err("revoked")]),
            ),
        ));
        let failed = wait_for_terminal_storage_failure(&state).await;
        connector.abort();
        assert_eq!(failed.message, TWITCH_SIGN_IN_EXPIRED);
    }

    #[tokio::test]
    async fn a_twitch_reconnect_url_keeps_its_subscriptions() {
        let (api, ws, server) = spawn_expiring_token_twitch(true).await;
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };
        // No renewal is scripted: resubscribing after the handover would
        // fail on the expired token.
        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            expiring_config(
                api,
                ws,
                crate::session_token::SessionTokenSource::scripted(Vec::new()),
            ),
        ));
        let snapshot = wait_for_twitch_message(&state).await;
        connector.abort();
        assert!(
            snapshot
                .providers
                .iter()
                .any(|provider| provider.state == LiveChatProviderConnectionState::Connected)
        );
        assert_eq!(server.sockets.load(Ordering::SeqCst), 2);
        assert_eq!(server.refused.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.accepted.lock().await.len(),
            CHAT_SUBSCRIPTION_TYPES.len()
        );
    }

    #[test]
    fn a_follow_notification_becomes_a_follow_row() {
        let event: Value = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/stream-manager/twitch-channel-follow.json"
        ))
        .unwrap();
        let row = normalize_notification(
            "channel.follow",
            &event,
            "delivery-9",
            Some("2026-09-24T10:04:01Z"),
            "session-1",
            Some("twitch"),
            "2026-09-24T10:04:01.2Z",
        )
        .expect("follow row");
        assert_eq!(row.event_type, LiveChatEventType::Follow);
        assert_eq!(
            row.details,
            Some(LiveChatEventDetails::Follow {
                handle: Some("cool_user".to_string())
            })
        );
        assert_eq!(row.author_name, "Cool_User");
        assert_eq!(row.author_id.as_deref(), Some("1234"));
        assert_eq!(row.message_text, "Cool_User followed");
        assert_eq!(row.published_at, "2026-09-24T10:04:00.123456789Z");
        assert_eq!(row.provider_message_id, "follow:delivery-9");
    }

    #[tokio::test]
    async fn follow_events_subscribe_only_with_the_opt_in_scope() {
        for follow_events in [false, true] {
            let (api_base_url, eventsub_ws_url, subscriptions, _, _, shutdown) =
                spawn_mock_twitch_server().await;
            let mut config = expiring_config(
                api_base_url,
                eventsub_ws_url,
                crate::session_token::SessionTokenSource::Fixed,
            );
            config.follow_events = follow_events;
            let live = create_subscriptions(
                &reqwest::Client::new(),
                &config,
                "token-1",
                "socket-1",
                ExtraEvents {
                    follows: follow_events,
                    ..ExtraEvents::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(live.follows, follow_events);
            let bodies = subscriptions.lock().await.clone();
            let follow = bodies
                .iter()
                .find(|body| body["type"] == "channel.follow")
                .cloned();
            assert_eq!(
                bodies.len(),
                CHAT_SUBSCRIPTION_TYPES.len() + usize::from(follow_events)
            );
            if follow_events {
                let follow = follow.expect("channel.follow subscription");
                assert_eq!(follow["version"], "2");
                assert_eq!(follow["condition"]["moderator_user_id"], "broadcaster-1");
                assert_eq!(follow["transport"]["session_id"], "socket-1");
            } else {
                assert!(follow.is_none(), "no follow subscription without the scope");
            }
            let _ = shutdown.send(());
        }
    }

    fn bits_use_event(use_type: &str, power_up: Value) -> Value {
        json!({
            "user_id": "1010",
            "user_login": "gvaste",
            "user_name": "GVASTE",
            "broadcaster_user_id": "broadcaster-1",
            "broadcaster_user_login": "orcdev",
            "broadcaster_user_name": "OrcDev",
            "bits": 300,
            "type": use_type,
            "power_up": power_up,
            "message": null
        })
    }

    fn normalize_test(subscription_type: &str, event: &Value) -> Option<LiveChatMessage> {
        normalize_notification(
            subscription_type,
            event,
            "delivery-1",
            Some("2026-10-07T20:17:00Z"),
            "session-1",
            Some("twitch"),
            "2026-10-07T20:17:00.1Z",
        )
    }

    // Plan 162: Power-ups paid with bits are Activity rows; a cheer is not,
    // because its chat message already makes the Cheer row (D2).
    #[test]
    fn bits_use_power_ups_become_activity_rows_and_cheers_are_skipped() {
        let celebration = normalize_test(
            "channel.bits.use",
            &bits_use_event(
                "power_up",
                json!({ "type": "celebration", "emote": null, "message_effect_id": null }),
            ),
        )
        .expect("celebration row");
        assert_eq!(celebration.event_type, LiveChatEventType::PowerUp);
        assert_eq!(
            celebration.details,
            Some(LiveChatEventDetails::PowerUp {
                bits: 300,
                power_up: PowerUpKind::Celebration,
                emote_name: None,
                title: None,
            })
        );
        assert_eq!(celebration.author_name, "GVASTE");
        assert_eq!(celebration.author_id.as_deref(), Some("1010"));
        assert_eq!(celebration.message_text, "GVASTE used a Celebration");
        assert_eq!(celebration.provider_message_id, "bits:delivery-1");
        assert_eq!(
            celebration.raw_provider_type.as_deref(),
            Some("channel.bits.use:power_up")
        );
        assert!(celebration.fragments.is_empty());

        let mut gigantify = bits_use_event(
            "power_up",
            json!({
                "type": "gigantify_an_emote",
                "emote": { "id": "emotesv2_a152", "name": "orcdevBONK" },
                "message_effect_id": null
            }),
        );
        gigantify["bits"] = json!(50);
        gigantify["message"] = json!({
            "text": "orcdevBONK",
            "fragments": [{ "type": "emote", "text": "orcdevBONK", "emote": { "id": "emotesv2_a152" } }]
        });
        let gigantify = normalize_test("channel.bits.use", &gigantify).expect("gigantify row");
        assert_eq!(gigantify.message_text, "GVASTE gigantified orcdevBONK");
        assert_eq!(
            gigantify.details,
            Some(LiveChatEventDetails::PowerUp {
                bits: 50,
                power_up: PowerUpKind::GigantifyAnEmote,
                emote_name: Some("orcdevBONK".to_string()),
                title: None,
            })
        );
        assert_eq!(gigantify.fragments[0].fragment_type, "emote");

        let effect = normalize_test(
            "channel.bits.use",
            &bits_use_event(
                "power_up",
                json!({ "type": "message_effect", "emote": null, "message_effect_id": "cosmic-abyss" }),
            ),
        )
        .expect("message effect row");
        assert_eq!(effect.message_text, "GVASTE sent a message effect");

        let custom = normalize_test(
            "channel.bits.use",
            &bits_use_event("custom_power_up", Value::Null),
        )
        .expect("custom power-up row");
        assert!(matches!(
            custom.details,
            Some(LiveChatEventDetails::PowerUp {
                power_up: PowerUpKind::Custom,
                title: None,
                ..
            })
        ));
        assert_eq!(custom.message_text, "GVASTE used a Power-up");

        // Plan 163: a Custom Power-up keeps its own name.
        let mut named = bits_use_event("custom_power_up", Value::Null);
        named["custom_power_up"] = json!({ "title": "Meow, Mao", "reward_id": "reward-7" });
        named["message"] = json!({ "text": "meow", "fragments": [] });
        let named = normalize_test("channel.bits.use", &named).expect("named custom row");
        assert_eq!(named.message_text, "GVASTE used Meow, Mao");
        assert_eq!(
            named.details,
            Some(LiveChatEventDetails::PowerUp {
                bits: 300,
                power_up: PowerUpKind::Custom,
                emote_name: None,
                title: Some("Meow, Mao".to_string()),
            })
        );
        assert_eq!(named.fragments[0].text, "meow");

        let mut cheer = bits_use_event("cheer", Value::Null);
        cheer["message"] = json!({ "text": "Cheer100 hi", "fragments": [] });
        assert!(normalize_test("channel.bits.use", &cheer).is_none());
    }

    #[test]
    fn a_custom_redemption_becomes_a_rewards_row_keyed_by_its_redemption_id() {
        let event = json!({
            "id": "17fa2df1-ad76-4804-bfa5-a40ef63efe63",
            "broadcaster_user_id": "broadcaster-1",
            "user_id": "1011",
            "user_login": "von6",
            "user_name": "Von6",
            "user_input": "drink water orc",
            "status": "unfulfilled",
            "reward": {
                "id": "92af127c",
                "title": "Hydrate",
                "cost": 500,
                "prompt": "Make the streamer drink"
            },
            "redeemed_at": "2026-10-07T20:20:00.1Z"
        });
        let row = normalize_test(CUSTOM_REDEMPTION_TYPE, &event).expect("redemption row");
        assert_eq!(row.event_type, LiveChatEventType::Redemption);
        assert_eq!(
            row.provider_message_id,
            "redemption:17fa2df1-ad76-4804-bfa5-a40ef63efe63"
        );
        assert_eq!(row.message_text, "Von6 redeemed Hydrate");
        assert_eq!(row.fragments[0].text, "drink water orc");
        assert_eq!(row.published_at, "2026-10-07T20:20:00.1Z");
        assert_eq!(
            row.details,
            Some(LiveChatEventDetails::Redemption {
                reward: RedemptionKind::Custom,
                channel_points: 500,
                title: Some("Hydrate".to_string()),
                emote_name: None,
                points_name: None,
            })
        );

        let mut silent = event.clone();
        silent["user_input"] = json!("");
        let row = normalize_test(CUSTOM_REDEMPTION_TYPE, &silent).expect("row without words");
        assert!(row.fragments.is_empty());
    }

    #[test]
    fn automatic_redemptions_read_v2_and_name_the_reward() {
        let highlighted = json!({
            "broadcaster_user_id": "broadcaster-1",
            "user_id": "1012",
            "user_login": "twitchdev",
            "user_name": "TwitchDev",
            "id": "f024099a-e0fe-4339-9a0a-a706fb59f353",
            "reward": { "type": "send_highlighted_message", "channel_points": 100, "emote": null },
            "message": {
                "text": "Hello world! VoHiYo",
                "fragments": [
                    { "type": "text", "text": "Hello world! ", "emote": null },
                    { "type": "emote", "text": "VoHiYo", "emote": { "id": "81274" } }
                ]
            },
            "redeemed_at": "2024-08-12T21:14:34.260398045Z"
        });
        let row = normalize_test(AUTOMATIC_REDEMPTION_TYPE, &highlighted).expect("row");
        assert_eq!(row.message_text, "TwitchDev highlighted their message");
        assert_eq!(row.fragments.len(), 2);
        assert_eq!(
            row.details,
            Some(LiveChatEventDetails::Redemption {
                reward: RedemptionKind::HighlightedMessage,
                channel_points: 100,
                title: None,
                emote_name: None,
                points_name: None,
            })
        );

        let mut unlock = highlighted.clone();
        unlock["reward"] = json!({
            "type": "chosen_sub_emote_unlock",
            "channel_points": 2000,
            "emote": { "id": "emotesv2_e7b8", "name": "orcdevLURK" }
        });
        unlock["message"] = Value::Null;
        let row = normalize_test(AUTOMATIC_REDEMPTION_TYPE, &unlock).expect("unlock row");
        assert_eq!(row.message_text, "TwitchDev unlocked orcdevLURK");
        assert!(row.fragments.is_empty());

        let mut future = unlock.clone();
        future["reward"] = json!({ "type": "some_new_reward", "channel_points": 10 });
        let row = normalize_test(AUTOMATIC_REDEMPTION_TYPE, &future).expect("future row");
        assert_eq!(row.message_text, "TwitchDev redeemed a reward");
        assert!(matches!(
            row.details,
            Some(LiveChatEventDetails::Redemption {
                reward: RedemptionKind::Other,
                ..
            })
        ));
    }

    #[test]
    fn the_points_name_is_the_channels_own_or_none() {
        let reply = |settings: Value| {
            json!({ "data": { "user": { "channel": {
            "communityPointsSettings": settings
        } } } })
        };
        assert_eq!(
            parse_channel_points_name(&reply(json!({ "name": " Orc Gold " }))),
            Ok(Some("Orc Gold".to_string()))
        );
        // Twitch's default name comes back as null: the window says "points".
        assert_eq!(
            parse_channel_points_name(&reply(json!({ "name": null }))),
            Ok(None)
        );
        assert_eq!(
            parse_channel_points_name(&reply(json!({ "name": "" }))),
            Ok(None)
        );
        assert_eq!(
            parse_channel_points_name(&reply(json!({ "name": "x".repeat(65) }))),
            Ok(None)
        );
        assert!(parse_channel_points_name(&json!({ "data": { "user": null } })).is_err());
        assert!(parse_channel_points_name(&json!({ "errors": [{ "message": "no" }] })).is_err());
    }

    #[tokio::test]
    async fn a_failed_points_name_read_is_logged_once_and_never_retried() {
        let (api_base_url, eventsub_ws_url, _, _, _, shutdown) = spawn_mock_twitch_server().await;
        let state = test_state();
        let mut config = expiring_config(
            api_base_url,
            eventsub_ws_url,
            crate::session_token::SessionTokenSource::Fixed,
        );
        // The mock refuses any other channel id.
        config.broadcaster_user_id = "someone-else".to_string();
        let client = reqwest::Client::new();
        let mut points_name = ChannelPointsName::default();
        assert_eq!(points_name.get(&state, &client, &config).await, None);
        assert!(points_name.read);
        config.broadcaster_user_id = "broadcaster-1".to_string();
        assert_eq!(points_name.get(&state, &client, &config).await, None);
        let _ = shutdown.send(());

        let mut points_name = ChannelPointsName::default();
        let (api_base_url, eventsub_ws_url, _, _, _, shutdown) = spawn_mock_twitch_server().await;
        let config = expiring_config(
            api_base_url,
            eventsub_ws_url,
            crate::session_token::SessionTokenSource::Fixed,
        );
        assert_eq!(
            points_name.get(&state, &client, &config).await.as_deref(),
            Some("Orc Gold")
        );
        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn bits_and_redemptions_subscribe_only_with_their_scopes() {
        for (bits, redemptions) in [(false, false), (true, false), (false, true), (true, true)] {
            let (api_base_url, eventsub_ws_url, subscriptions, _, _, shutdown) =
                spawn_mock_twitch_server().await;
            let config = expiring_config(
                api_base_url,
                eventsub_ws_url,
                crate::session_token::SessionTokenSource::Fixed,
            );
            let live = create_subscriptions(
                &reqwest::Client::new(),
                &config,
                "token-1",
                "socket-1",
                ExtraEvents {
                    follows: false,
                    bits,
                    redemptions,
                },
            )
            .await
            .unwrap();
            assert_eq!((live.bits, live.redemptions), (bits, redemptions));
            let bodies = subscriptions.lock().await.clone();
            let find = |kind: &str| bodies.iter().find(|body| body["type"] == kind).cloned();
            assert_eq!(
                bodies.len(),
                CHAT_SUBSCRIPTION_TYPES.len() + usize::from(bits) + 2 * usize::from(redemptions)
            );
            for (kind, version, wanted) in [
                (BITS_USE_TYPE, "1", bits),
                (CUSTOM_REDEMPTION_TYPE, "1", redemptions),
                (AUTOMATIC_REDEMPTION_TYPE, "2", redemptions),
            ] {
                match find(kind) {
                    Some(body) => {
                        assert!(wanted, "{kind} without its scope");
                        assert_eq!(body["version"], version);
                        assert_eq!(
                            body["condition"],
                            json!({ "broadcaster_user_id": "broadcaster-1" })
                        );
                        assert_eq!(body["transport"]["session_id"], "socket-1");
                    }
                    None => assert!(!wanted, "{kind} missing"),
                }
            }
            let _ = shutdown.send(());
        }
    }

    // Plan 162, D5: a channel without bits or channel points refuses those
    // subscriptions; chat still connects and the rest stay live.
    #[tokio::test]
    async fn a_refused_power_up_subscription_never_costs_the_chat() {
        let (api_base_url, eventsub_ws_url, subscriptions, _, _, shutdown) =
            spawn_mock_twitch_server_refusing(
                true,
                chat_message_frame(),
                vec![BITS_USE_TYPE, AUTOMATIC_REDEMPTION_TYPE],
            )
            .await;
        let config = expiring_config(
            api_base_url,
            eventsub_ws_url,
            crate::session_token::SessionTokenSource::Fixed,
        );
        let live = create_subscriptions(
            &reqwest::Client::new(),
            &config,
            "token-1",
            "socket-1",
            ExtraEvents {
                follows: true,
                bits: true,
                redemptions: true,
            },
        )
        .await
        .expect("chat subscriptions still succeed");
        assert_eq!(
            live,
            ExtraEvents {
                follows: true,
                bits: false,
                redemptions: false,
            }
        );
        let bodies = subscriptions.lock().await.clone();
        for kind in CHAT_SUBSCRIPTION_TYPES {
            assert!(bodies.iter().any(|body| body["type"] == *kind), "{kind}");
        }
        let _ = shutdown.send(());
    }

    fn redemption_frame() -> String {
        json!({
            "metadata": {
                "message_type": "notification",
                "subscription_type": CUSTOM_REDEMPTION_TYPE,
                "message_id": "delivery-redemption-1",
                "message_timestamp": "2026-10-07T20:20:00Z"
            },
            "payload": {
                "subscription": { "type": CUSTOM_REDEMPTION_TYPE },
                "event": {
                    "id": "redemption-1",
                    "broadcaster_user_id": "broadcaster-1",
                    "user_id": "987",
                    "user_login": "coolviewer",
                    "user_name": "CoolViewer",
                    "user_input": "",
                    "status": "unfulfilled",
                    "reward": { "id": "reward-1", "title": "Hydrate", "cost": 500, "prompt": "" },
                    "redeemed_at": "2026-10-07T20:20:00Z"
                }
            }
        })
        .to_string()
    }

    // Each new socket replays the frame: one redemption still makes one row,
    // with the viewer's Helix avatar like any chat author.
    #[tokio::test]
    async fn a_redelivered_redemption_makes_one_activity_row() {
        let (api_base_url, eventsub_ws_url, subscriptions, sockets, _, shutdown) =
            spawn_mock_twitch_server_sending(true, redemption_frame()).await;
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };
        let mut config = expiring_config(
            api_base_url,
            eventsub_ws_url,
            crate::session_token::SessionTokenSource::Fixed,
        );
        config.redemption_events = true;
        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            config,
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while sockets.load(Ordering::SeqCst) < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for a second socket"
            );
            sleep(Duration::from_millis(25)).await;
        }
        sleep(Duration::from_millis(250)).await;
        connector.abort();
        let _ = shutdown.send(());

        let snapshot = current_status(&state).await;
        let rows: Vec<_> = snapshot
            .messages
            .iter()
            .filter(|message| message.event_type == LiveChatEventType::Redemption)
            .collect();
        assert_eq!(rows.len(), 1, "{snapshot:?}");
        assert_eq!(rows[0].author_name, "CoolViewer");
        // Plan 163: the channel's own name for its points rides on the row.
        assert!(matches!(
            &rows[0].details,
            Some(LiveChatEventDetails::Redemption {
                points_name: Some(name),
                ..
            }) if name == "Orc Gold"
        ));
        assert_eq!(
            rows[0].author_avatar_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/viewer.png")
        );
        assert!(
            subscriptions
                .lock()
                .await
                .iter()
                .any(|body| body["type"] == AUTOMATIC_REDEMPTION_TYPE)
        );
    }

    fn follow_frame() -> String {
        json!({
            "metadata": {
                "message_type": "notification",
                "subscription_type": "channel.follow",
                "message_id": "delivery-follow-1",
                "message_timestamp": "2026-09-28T10:00:00Z"
            },
            "payload": {
                "subscription": { "type": "channel.follow" },
                "event": {
                    "user_id": "987",
                    "user_login": "coolviewer",
                    "user_name": "CoolViewer",
                    "broadcaster_user_id": "broadcaster-1",
                    "followed_at": "2026-09-28T10:00:00Z"
                }
            }
        })
        .to_string()
    }

    // Plan 071, S2: a follow is a named row with the follower's Helix avatar,
    // and the audience learns that Twitch follows are named from now on.
    #[tokio::test]
    async fn a_follow_arrives_with_the_followers_avatar_and_marks_follows_named() {
        let (api_base_url, eventsub_ws_url, subscriptions, _, _, shutdown) =
            spawn_mock_twitch_server_sending(false, follow_frame()).await;
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };
        let mut config = expiring_config(
            api_base_url,
            eventsub_ws_url,
            crate::session_token::SessionTokenSource::Fixed,
        );
        config.follow_events = true;
        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            config,
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let follow = loop {
            let snapshot = current_status(&state).await;
            if let Some(message) = snapshot
                .messages
                .iter()
                .find(|message| message.event_type == LiveChatEventType::Follow)
            {
                break message.clone();
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for the follow row: {snapshot:?}"
            );
            sleep(Duration::from_millis(25)).await;
        };
        connector.abort();
        let _ = shutdown.send(());

        assert_eq!(follow.author_name, "CoolViewer");
        assert_eq!(
            follow.author_avatar_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/viewer.png")
        );
        assert!(
            subscriptions
                .lock()
                .await
                .iter()
                .any(|body| body["type"] == "channel.follow")
        );
        // The connector reported before the audience began: the report waits
        // for the platform and applies when it registers.
        let snapshot =
            state
                .audience
                .lock()
                .unwrap()
                .begin("session-1", &[StreamPlatform::Twitch], "t0");
        assert!(snapshot.platforms[0].named_follows_since.is_some());
    }

    fn sender_config(api_base_url: String) -> TwitchChatSenderConfig {
        TwitchChatSenderConfig {
            access_token: "token".to_string(),
            client_id: "client".to_string(),
            broadcaster_user_id: "broadcaster".to_string(),
            sender_user_id: "sender".to_string(),
            api_base_url: Some(api_base_url),
            token_source: Default::default(),
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
            (StatusCode::UNAUTHORIZED, "Reconnect Twitch"),
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
        let (
            api_base_url,
            eventsub_ws_url,
            subscriptions,
            _socket_connections,
            _notifications_sent,
            shutdown,
        ) = spawn_mock_twitch_server().await;
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };

        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            TwitchChatConfig {
                access_token: "token-1".to_string(),
                client_id: "client-1".to_string(),
                broadcaster_user_id: "broadcaster-1".to_string(),
                user_id: "user-1".to_string(),
                target_id: Some("twitch".to_string()),
                eventsub_ws_url: Some(eventsub_ws_url),
                api_base_url: Some(api_base_url),
                token_source: Default::default(),
                follow_events: false,
                bits_events: false,
                redemption_events: false,
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

    #[tokio::test]
    async fn persistence_rejection_retries_retained_twitch_message_without_server_replay() {
        let (
            api_base_url,
            eventsub_ws_url,
            _subscriptions,
            socket_connections,
            notifications_sent,
            shutdown,
        ) = spawn_mock_twitch_server_sending_notification_once().await;
        let state = test_state();
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };

        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            TwitchChatConfig {
                access_token: "token-1".to_string(),
                client_id: "client-1".to_string(),
                broadcaster_user_id: "broadcaster-1".to_string(),
                user_id: "user-1".to_string(),
                target_id: Some("twitch".to_string()),
                eventsub_ws_url: Some(eventsub_ws_url),
                api_base_url: Some(api_base_url),
                token_source: Default::default(),
                follow_events: false,
                bits_events: false,
                redemption_events: false,
            },
        ));

        wait_for_persistence_rejection(&state).await;
        assert!(current_status(&state).await.messages.is_empty());
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        let snapshot = wait_for_twitch_message(&state).await;
        wait_for_persisted_message(&state, "chat-1").await;
        connector.abort();
        let _ = shutdown.send(());

        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].provider_message_id, "chat-1");
        assert_eq!(notifications_sent.load(Ordering::SeqCst), 1);
        assert_eq!(socket_connections.load(Ordering::SeqCst), 1);
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
    async fn terminal_storage_failure_marks_twitch_failed_instead_of_reconnecting_forever() {
        let (
            api_base_url,
            eventsub_ws_url,
            _subscriptions,
            _socket_connections,
            _notifications_sent,
            shutdown,
        ) = spawn_mock_twitch_server().await;
        let mut state = test_state();
        let writer: BatchWriter = Arc::new(|_| {
            Err(anyhow::Error::new(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::DatabaseCorrupt,
                    extended_code: 11,
                },
                Some("injected corrupt comments database".to_string()),
            )))
        });
        state.live_chat_persistence = LiveChatPersistence::with_writer(writer);
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![twitch_provider_row()]);
            coordinator.session_generation()
        };

        let connector = tokio::spawn(run_twitch_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            TwitchChatConfig {
                access_token: "token-1".to_string(),
                client_id: "client-1".to_string(),
                broadcaster_user_id: "broadcaster-1".to_string(),
                user_id: "user-1".to_string(),
                target_id: Some("twitch".to_string()),
                eventsub_ws_url: Some(eventsub_ws_url),
                api_base_url: Some(api_base_url),
                token_source: Default::default(),
                follow_events: false,
                bits_events: false,
                redemption_events: false,
            },
        ));

        let provider = wait_for_terminal_storage_failure(&state).await;
        tokio::time::timeout(Duration::from_secs(5), connector)
            .await
            .expect("terminal Twitch connector stopped")
            .expect("terminal Twitch connector joined");
        let _ = shutdown.send(());

        assert!(provider.message.contains("comments storage failed"));
        assert!(current_status(&state).await.messages.is_empty());
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
    fn a_missed_helix_avatar_lookup_is_retried_after_five_minutes() {
        let fetched_at = Instant::now();
        let miss = TwitchAvatarEntry {
            avatar: None,
            fetched_at,
        };
        assert!(miss.serves(fetched_at), "a fresh miss is served");
        assert!(
            miss.serves(fetched_at + TWITCH_AVATAR_MISS_RETRY - Duration::from_secs(1)),
            "a miss inside the window is still served"
        );
        assert!(
            !miss.serves(fetched_at + TWITCH_AVATAR_MISS_RETRY),
            "a miss past the window is looked up again"
        );
        let hit = TwitchAvatarEntry {
            avatar: Some("https://static-cdn.jtvnw.net/a.png".to_string()),
            fetched_at,
        };
        assert!(
            hit.serves(fetched_at + Duration::from_secs(60 * 60)),
            "a hit is final for the session"
        );
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

    macro_rules! fixture {
        ($name:literal) => {
            serde_json::from_str::<Value>(include_str!(concat!(
                "../../../scripts/fixtures/stream-manager/",
                $name,
                ".json"
            )))
            .unwrap()
        };
    }

    fn notice(event: &Value) -> LiveChatMessage {
        normalize_notification(
            "channel.chat.notification",
            event,
            "delivery",
            None,
            "s1",
            None,
            "now",
        )
        .unwrap()
    }

    #[test]
    fn notifications_carry_structured_details() {
        let resub = notice(&fixture!("twitch-notification-resub"));
        assert_eq!(resub.event_type, LiveChatEventType::Membership);
        assert_eq!(resub.author_id.as_deref(), Some("49912639"));
        assert_eq!(
            resub.details,
            Some(LiveChatEventDetails::Subscription {
                subscription: SubscriptionKind::Resub,
                tier: Some("1000".to_string()),
                is_prime: false,
                months: Some(3),
                streak_months: Some(2),
                gift_count: None,
                recipient_name: None,
                community_gift_id: None,
            })
        );

        let sub = notice(&fixture!("twitch-notification-sub"));
        assert!(matches!(
            sub.details,
            Some(LiveChatEventDetails::Subscription {
                subscription: SubscriptionKind::Sub,
                is_prime: true,
                ..
            })
        ));

        let gift = notice(&fixture!("twitch-notification-sub-gift"));
        assert_eq!(gift.author_name, "Anonymous");
        assert_eq!(gift.author_id, None);
        assert!(matches!(
            &gift.details,
            Some(LiveChatEventDetails::Subscription {
                subscription: SubscriptionKind::SubGift,
                gift_count: Some(1),
                recipient_name: Some(name),
                ..
            }) if name == "LuckyViewer"
        ));

        let community = notice(&fixture!("twitch-notification-community-sub-gift"));
        assert!(matches!(
            &community.details,
            Some(LiveChatEventDetails::Subscription {
                subscription: SubscriptionKind::CommunitySubGift,
                gift_count: Some(5),
                community_gift_id: Some(id),
                ..
            }) if id == "gift-batch-1"
        ));
        // One of the single gifts Twitch sends for that community gift.
        let mut single = fixture!("twitch-notification-sub-gift");
        single["sub_gift"]["community_gift_id"] = serde_json::json!("gift-batch-1");
        assert!(matches!(
            &notice(&single).details,
            Some(LiveChatEventDetails::Subscription {
                subscription: SubscriptionKind::SubGift,
                community_gift_id: Some(id),
                ..
            }) if id == "gift-batch-1"
        ));

        let raid = notice(&fixture!("twitch-notification-raid"));
        assert_eq!(raid.event_type, LiveChatEventType::System);
        assert_eq!(raid.author_name, "Raider42");
        assert_eq!(
            raid.details,
            Some(LiveChatEventDetails::Raid { viewer_count: 234 })
        );
        assert!(raid.author_avatar_url.is_some());

        let announcement = notice(&fixture!("twitch-notification-announcement"));
        assert_eq!(
            announcement.details,
            Some(LiveChatEventDetails::Announcement {
                color: Some("PURPLE".to_string())
            })
        );
    }

    #[test]
    fn a_watch_streak_carries_its_count_and_the_viewers_words() {
        let streak = notice(&fixture!("twitch-notification-watch-streak"));
        assert_eq!(streak.event_type, LiveChatEventType::System);
        assert_eq!(streak.author_name, "Snowy77x");
        assert_eq!(
            streak.raw_provider_type.as_deref(),
            Some("channel.chat.notification:watch_streak")
        );
        assert_eq!(
            streak.details,
            Some(LiveChatEventDetails::WatchStreak {
                streak_count: 20,
                channel_points_awarded: Some(450),
            })
        );
        assert_eq!(
            streak.message_text,
            "Snowy77x watched 20 consecutive streams and sparked a watch streak!"
        );
        let words: String = streak.fragments.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(words, "welcome back hands <3 hopefully everything is good");
        let wire = serde_json::to_value(streak.details.as_ref().unwrap()).unwrap();
        assert_eq!(
            wire,
            json!({ "kind": "watch-streak", "streakCount": 20, "channelPointsAwarded": 450 })
        );

        // No points: the field is omitted, never `null`.
        let mut no_points = fixture!("twitch-notification-watch-streak");
        no_points["watch_streak"]["channel_points_awarded"] = Value::Null;
        let wire = serde_json::to_value(notice(&no_points).details.unwrap()).unwrap();
        assert_eq!(wire, json!({ "kind": "watch-streak", "streakCount": 20 }));

        // A streak without its body stays a plain system row.
        let mut malformed = fixture!("twitch-notification-watch-streak");
        malformed["watch_streak"] = Value::Null;
        let row = notice(&malformed);
        assert_eq!(row.details, None);
        assert_eq!(row.event_type, LiveChatEventType::System);
    }

    #[test]
    fn a_notice_keeps_the_viewers_words_without_fragments() {
        let mut resub = fixture!("twitch-notification-resub");
        resub["message"]["fragments"] = json!([]);
        let row = notice(&resub);
        assert_eq!(
            row.message_text,
            "morgaesis subscribed at Tier 1. They've subscribed for 3 months!"
        );
        assert_eq!(row.fragments.len(), 1);
        assert_eq!(row.fragments[0].fragment_type, "text");
        assert_eq!(row.fragments[0].text, "Happy Wednesday");

        // No words at all: no fragment is invented.
        resub["message"]["text"] = json!("");
        assert!(notice(&resub).fragments.is_empty());
    }

    #[test]
    fn chat_messages_carry_reply_first_chat_and_cheer_details() {
        let intro = normalize_chat_message(
            &fixture!("twitch-chat-message-intro"),
            "s1",
            None,
            None,
            "now",
        )
        .unwrap();
        assert!(intro.first_message);
        assert_eq!(intro.reply, None);
        assert_eq!(intro.details, None);

        let reply = normalize_chat_message(
            &fixture!("twitch-chat-message-reply"),
            "s1",
            None,
            None,
            "now",
        )
        .unwrap();
        assert!(!reply.first_message);
        assert_eq!(
            reply.reply,
            Some(LiveChatReply {
                parent_message_id: "chat-parent-1".to_string(),
                parent_author_name: "ph4se_on3".to_string(),
                parent_text: "old skateboard injury".to_string(),
            })
        );

        let cheer = normalize_chat_message(
            &fixture!("twitch-chat-message-cheer"),
            "s1",
            None,
            None,
            "now",
        )
        .unwrap();
        assert_eq!(cheer.event_type, LiveChatEventType::Paid);
        assert_eq!(
            cheer.details,
            Some(LiveChatEventDetails::Cheer { bits: 1500 })
        );
    }

    #[test]
    fn gif_fragment_keeps_twitch_url_through_the_gate() {
        // Plan 155: a GIF Keyboard message is one `gif` fragment whose text
        // is the bracketed title; the URL is Twitch's, unmodified.
        let message =
            normalize_chat_message(&fixture!("twitch-chat-gif"), "s1", None, None, "now").unwrap();
        assert_eq!(message.message_text, "[Y A Y Yes GIF]");
        assert_eq!(message.event_type, LiveChatEventType::Message);
        assert_eq!(message.fragments.len(), 1);
        assert_eq!(message.fragments[0].fragment_type, "gif");
        assert_eq!(message.fragments[0].text, "[Y A Y Yes GIF]");
        assert_eq!(
            message.fragments[0].image_url.as_deref(),
            Some("https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif")
        );
        assert!(!message.fragments[0].zero_width);
        assert_eq!(
            rejected_gif_hosts(&fixture!("twitch-chat-gif")["message"]["fragments"]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn gif_fragment_beside_an_emote_keeps_both() {
        let fragments = json!([
            { "type": "emote", "text": "Kappa", "emote": { "id": "25" } },
            { "type": "text", "text": " " },
            { "type": "gif", "text": "[Clap GIF]", "gif": { "gif_id": "x1", "url": "https://i.giphy.com/x1.gif" } }
        ]);
        let parsed = parse_fragments(&fragments);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].fragment_type, "emote");
        assert!(
            parsed[0]
                .image_url
                .as_deref()
                .unwrap()
                .starts_with("https://static-cdn.jtvnw.net/emoticons/v2/25/")
        );
        assert_eq!(parsed[2].fragment_type, "gif");
        assert_eq!(
            parsed[2].image_url.as_deref(),
            Some("https://i.giphy.com/x1.gif")
        );
    }

    #[test]
    fn gif_url_gate_refuses_everything_but_https_allowlisted_hosts() {
        assert_eq!(
            twitch_gif_asset_url("https://media0.giphy.com/media/a/giphy.gif").as_deref(),
            Some("https://media0.giphy.com/media/a/giphy.gif")
        );
        assert_eq!(
            twitch_gif_asset_url("https://static-cdn.jtvnw.net/gifs/a.gif").as_deref(),
            Some("https://static-cdn.jtvnw.net/gifs/a.gif")
        );
        assert_eq!(
            twitch_gif_asset_url("https://GIPHY.com/a.gif").as_deref(),
            Some("https://GIPHY.com/a.gif"),
            "host matching is case-insensitive and the URL is returned untouched"
        );
        for refused in [
            "http://media0.giphy.com/media/a/giphy.gif",
            "https://user:pw@media0.giphy.com/a.gif",
            "https://user@media0.giphy.com/a.gif",
            "https://giphy.com.evil.example/a.gif",
            "https://cdn.7tv.app/emote/x/2x.webp",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert_eq!(twitch_gif_asset_url(refused), None, "{refused}");
        }
        let long = format!("https://i.giphy.com/{}", "a".repeat(3_000));
        assert_eq!(twitch_gif_asset_url(&long), None);

        // A refused URL leaves the fragment with its title and no image.
        let fragments = json!([
            { "type": "gif", "text": "[Nope GIF]", "gif": { "id": "n", "url": "http://media0.giphy.com/n.gif" } }
        ]);
        let parsed = parse_fragments(&fragments);
        assert_eq!(parsed[0].fragment_type, "gif");
        assert_eq!(parsed[0].text, "[Nope GIF]");
        assert_eq!(parsed[0].image_url, None);
        assert_eq!(
            rejected_gif_hosts(&fragments),
            vec!["media0.giphy.com".to_string()]
        );
        assert_eq!(
            rejected_gif_hosts(&json!([{ "type": "gif", "text": "x", "gif": { "url": "nope" } }])),
            vec!["<not a url>".to_string()]
        );
        // A GIF fragment without a url is a title, not a rejection.
        assert_eq!(
            rejected_gif_hosts(&json!([{ "type": "gif", "text": "[x GIF]" }])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn gif_title_strips_brackets_and_suffix() {
        assert_eq!(gif_title("[Y A Y Yes GIF]"), "Y A Y Yes");
        assert_eq!(gif_title("[Clap GIF]"), "Clap");
        assert_eq!(gif_title("[GIF]"), "GIF");
        assert_eq!(gif_title("Y A Y Yes GIF"), "Y A Y Yes");
        assert_eq!(gif_title("[no suffix]"), "no suffix");
        assert_eq!(gif_title("  plain  "), "plain");
        assert_eq!(gif_title(""), "");
        assert_eq!(gif_title("[ GIF ]"), "GIF");
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

    // --- Removing (plan 140 S4) ----------------------------------------------------

    #[derive(Clone)]
    struct DeleteProbe {
        status: StatusCode,
        body: &'static str,
        hits: Arc<AtomicUsize>,
        /// `(uri, "authorization|client-id")` per request.
        requests: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    async fn probe_delete(
        State(probe): State<DeleteProbe>,
        request: axum::extract::Request,
    ) -> impl IntoResponse {
        probe.hits.fetch_add(1, Ordering::SeqCst);
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string()
        };
        probe.requests.lock().unwrap().push((
            request.uri().to_string(),
            format!("{}|{}", header("authorization"), header("client-id")),
        ));
        (probe.status, probe.body)
    }

    async fn spawn_delete_probe(status: StatusCode, body: &'static str) -> (String, DeleteProbe) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let probe = DeleteProbe {
            status,
            body,
            hits: Arc::new(AtomicUsize::new(0)),
            requests: Arc::default(),
        };
        let app = Router::new()
            .route(
                "/helix/moderation/chat",
                axum::routing::delete(probe_delete),
            )
            .with_state(probe.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), probe)
    }

    #[tokio::test]
    async fn delete_refuses_an_empty_message_id_before_building_any_request() {
        use crate::live_chat_moderation::ProviderDeleteOutcome;
        let (base, probe) = spawn_delete_probe(StatusCode::NO_CONTENT, "").await;
        let client = reqwest::Client::new();
        // Helix clears the WHOLE chat when message_id is omitted. Blank ids
        // must be refused before a request exists, so none reaches the server.
        for empty in ["", "   ", "\n\t"] {
            let outcome =
                delete_twitch_chat_message(&client, &sender_config(base.clone()), empty).await;
            assert_eq!(
                outcome,
                ProviderDeleteOutcome::Failed(TWITCH_EMPTY_MESSAGE_ID_REFUSED.to_string()),
                "{empty:?}"
            );
        }
        assert_eq!(
            probe.hits.load(Ordering::SeqCst),
            0,
            "an empty message_id must never become a Helix request"
        );
        assert!(TWITCH_EMPTY_MESSAGE_ID_REFUSED.contains("whole chat"));

        // With an id, exactly one request goes out, with the documented query
        // and the chat credentials.
        let outcome =
            delete_twitch_chat_message(&client, &sender_config(base.clone()), " msg-1 ").await;
        assert_eq!(outcome, ProviderDeleteOutcome::Deleted);
        assert_eq!(probe.hits.load(Ordering::SeqCst), 1);
        let (uri, headers) = probe.requests.lock().unwrap()[0].clone();
        assert!(uri.starts_with("/helix/moderation/chat?"), "{uri}");
        assert!(uri.contains("broadcaster_id=broadcaster"), "{uri}");
        assert!(uri.contains("moderator_id=sender"), "{uri}");
        assert!(uri.contains("message_id=msg-1"), "{uri}");
        assert!(!uri.contains("message_id=&"), "{uri}");
        assert_eq!(headers, "Bearer token|client");
    }

    #[tokio::test]
    async fn delete_reports_a_missing_scope_as_a_local_hide() {
        use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};
        let (base, probe) = spawn_delete_probe(
            StatusCode::UNAUTHORIZED,
            r#"{"error":"Unauthorized","status":401,"message":"Missing scope: moderator:manage:chat_messages"}"#,
        )
        .await;
        let outcome = delete_twitch_chat_message(
            &reqwest::Client::new(),
            &sender_config(base.clone()),
            "msg-1",
        )
        .await;
        assert_eq!(
            outcome,
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::MissingScope,
                reason: TWITCH_MODERATE_RECONNECT_REASON.to_string(),
            }
        );
        assert_eq!(probe.hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn delete_answers_classify_by_status_and_helix_message() {
        use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};
        let body = |message: &str| {
            serde_json::to_vec(
                &json!({ "error": "Bad Request", "status": 400, "message": message }),
            )
            .unwrap()
        };
        assert_eq!(
            classify_twitch_delete_response(204, b""),
            ProviderDeleteOutcome::Deleted
        );
        assert_eq!(
            classify_twitch_delete_response(404, b""),
            ProviderDeleteOutcome::NotFound
        );
        assert_eq!(
            classify_twitch_delete_response(
                400,
                &body("The message_id was for a message that was created more than 6 hours ago.")
            ),
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::TooOld,
                reason: TWITCH_TOO_OLD_REASON.to_string(),
            }
        );
        assert_eq!(
            classify_twitch_delete_response(
                400,
                &body("You may not delete another moderator's messages.")
            ),
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::Unsupported,
                reason: "Twitch does not allow removing this message (You may not delete another moderator's messages.).".to_string(),
            }
        );
        for status in [401, 403] {
            assert_eq!(
                classify_twitch_delete_response(status, b""),
                ProviderDeleteOutcome::CannotDelete {
                    code: ModerationOutcomeCode::MissingScope,
                    reason: TWITCH_MODERATE_RECONNECT_REASON.to_string(),
                }
            );
        }
        assert!(matches!(
            classify_twitch_delete_response(429, b""),
            ProviderDeleteOutcome::Transient(_)
        ));
        assert!(matches!(
            classify_twitch_delete_response(503, b"<html>"),
            ProviderDeleteOutcome::Transient(_)
        ));
        assert!(matches!(
            classify_twitch_delete_response(418, b""),
            ProviderDeleteOutcome::Failed(_)
        ));
    }

    #[test]
    fn the_six_hour_rule_is_checked_against_the_published_time() {
        let now = chrono::Utc::now();
        let published = |hours_ago: i64| (now - chrono::Duration::hours(hours_ago)).to_rfc3339();
        assert!(twitch_message_too_old(&published(7), now));
        assert!(twitch_message_too_old(&published(6), now));
        assert!(!twitch_message_too_old(&published(5), now));
        assert!(!twitch_message_too_old(&published(0), now));
        // An unreadable time lets Twitch decide.
        assert!(!twitch_message_too_old("yesterday", now));
        assert!(!twitch_message_too_old("", now));
    }
}
