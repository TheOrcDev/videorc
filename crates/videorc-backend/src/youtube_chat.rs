//! YouTube live chat connector (slice 4 of the In-App Livestream Comments plan:
//! `2026-06-06 - Videorc In-App Livestream Comments Plan`).
//!
//! Resolves the broadcast `liveChatId`, reads `liveChatMessages`, normalizes items into the
//! shared `LiveChatMessage` model, and classifies disabled/ended/quota/token/auth errors
//! into provider status transitions — never a stream failure. Messages are fed into the
//! `LiveChatCoordinator` through the shared deliver/provider-status helpers.
//!
//! Transport (plan 094, S1): the connector polls `liveChatMessages` (`list`) and never
//! flips transport on an error. The `streamList` URL stays for S5, which reads the
//! streamed body incrementally; the old "request `stream`, parse it as one JSON page"
//! path could not work and burned the shared quota at one call per second.
//!
//! Quota discipline: every page costs 1 unit of a quota shared by every Videorc user.
//! Polls never run faster than [`MIN_POLLING_INTERVAL_MS`], stretch to
//! [`IDLE_POLLING_INTERVAL_MS`] after [`IDLE_EMPTY_PAGES`] empty pages, and a
//! `quotaExceeded` answer parks the reader (`Waiting` with `retryAt`) through the shared
//! breaker in `youtube_quota` until the reset, then resumes from its page token.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use tokio::time::sleep;

use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, LiveChatProviderConnectionState,
    MembershipKind, ProviderSendReceipt, live_chat_message_id, set_provider_and_emit,
    try_deliver_messages,
};
use crate::state::AppState;
use crate::streaming::StreamPlatform;

const LIVE_CHAT_MESSAGES_PATH: &str = "/youtube/v3/liveChat/messages";
const LIVE_CHAT_MESSAGES_STREAM_PATH: &str = "/youtube/v3/liveChat/messages/stream";
const LIVE_BROADCASTS_PATH: &str = "/youtube/v3/liveBroadcasts";
const DEFAULT_POLLING_INTERVAL_MS: u64 = 5_000;
/// Plan 094, D1: never poll faster than every 5 s (one shared project quota).
pub const MIN_POLLING_INTERVAL_MS: u64 = 5_000;
/// After [`IDLE_EMPTY_PAGES`] empty pages in a row the poll stretches to this.
pub const IDLE_POLLING_INTERVAL_MS: u64 = 10_000;
pub const IDLE_EMPTY_PAGES: u32 = 6;
const MAX_BACKOFF_MS: u64 = 30_000;

/// Start config for the YouTube connector (an internal/session-aware `liveChat.start` field).
/// Either `liveChatId` is provided directly or `broadcastId` is resolved to one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChatConfig {
    pub access_token: String,
    #[serde(default)]
    pub live_chat_id: Option<String>,
    #[serde(default)]
    pub broadcast_id: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    /// Test-only override of the API base URL.
    #[serde(default)]
    pub api_base_url: Option<String>,
    /// How the connector renews `access_token` mid-stream (plan 055, B2).
    /// Built by the backend from the stored account; never read from params.
    #[serde(skip)]
    pub token_source: crate::session_token::SessionTokenSource,
}

/// The provider message when YouTube refuses even a renewed token.
pub const YOUTUBE_SIGN_IN_EXPIRED: &str =
    "YouTube sign-in expired. Reconnect YouTube to keep live comments.";

/// Request body for `liveChatMessages.insert` (pure, tested).
pub fn chat_send_body(live_chat_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "snippet": {
            "liveChatId": live_chat_id,
            "type": "textMessageEvent",
            "textMessageDetails": { "messageText": text }
        }
    })
}

/// Send one chat message to the broadcast's live chat (Comments upgrade S4).
/// The `youtube.force-ssl` scope already granted for reading authorizes this.
///
/// `api_base_url` is the API host, the same override the reader takes. The
/// documented insert route is `POST /youtube/v3/liveChat/messages`, which is
/// the reader's `list` path. The resource is named `liveChatMessages`, but
/// `/youtube/v3/liveChatMessages` is not a route (Google answers HTML 404).
/// Test seam for the unguarded send; production goes through
/// [`send_youtube_chat_message_guarded`].
#[cfg(test)]
pub async fn send_youtube_chat_message(
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
    live_chat_id: &str,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    send_youtube_chat_message_classified(client, api_base_url, access_token, live_chat_id, text)
        .await
        .map_err(|failure| failure.message)
}

/// The send behind the shared quota breaker (plan 094): nothing goes out while
/// YouTube is paused, every attempt is counted, and a quota refusal pauses
/// every other YouTube caller too.
pub async fn send_youtube_chat_message_guarded(
    state: &AppState,
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
    live_chat_id: &str,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    if crate::youtube_quota::paused_until(state).is_some() {
        return Err(crate::youtube_quota::SEND_PAUSED_MESSAGE.to_string());
    }
    // Plan 094 (S6): at 100% of the daily budget only Go Live essentials and
    // chat read keep calling; a send costs 50 units.
    if crate::youtube_quota::budget_refuses(state, crate::youtube_quota::BudgetCall::ChatSend)
        .is_some()
    {
        return Err(crate::youtube_quota::SEND_SHED_MESSAGE.to_string());
    }
    crate::youtube_quota::record_call(
        state,
        crate::youtube_quota::YouTubeEndpoint::LiveChatMessagesInsert,
    );
    match send_youtube_chat_message_classified(
        client,
        api_base_url,
        access_token,
        live_chat_id,
        text,
    )
    .await
    {
        Ok(receipt) => Ok(receipt),
        Err(failure) => {
            if failure.quota_exhausted {
                crate::youtube_quota::record_quota_exhausted(state, "chat send");
            }
            Err(failure.message)
        }
    }
}

/// A failed send: the user-facing message, and whether it was the shared
/// quota (so the caller can set the breaker).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YouTubeSendFailure {
    pub message: String,
    pub quota_exhausted: bool,
}

impl From<String> for YouTubeSendFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            quota_exhausted: false,
        }
    }
}

async fn send_youtube_chat_message_classified(
    client: &reqwest::Client,
    api_base_url: Option<&str>,
    access_token: &str,
    live_chat_id: &str,
    text: &str,
) -> Result<ProviderSendReceipt, YouTubeSendFailure> {
    let base = crate::youtube_quota::youtube_api_base_url(api_base_url);
    let response = client
        .post(format!(
            "{}{LIVE_CHAT_MESSAGES_PATH}",
            base.trim_end_matches('/')
        ))
        .query(&[("part", "snippet")])
        .bearer_auth(access_token)
        .json(&chat_send_body(live_chat_id, text))
        .send()
        .await
        .map_err(|error| format!("Could not reach YouTube: {error}"))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let response_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read YouTube's send response: {error}"))?;
    if status.is_success() {
        let body = serde_json::from_slice::<Value>(&response_bytes)
            .map_err(|error| format!("YouTube returned an unreadable send response: {error}"))?;
        let provider_message_id = body
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "YouTube accepted the request without a message id.".to_string())?;
        return Ok(ProviderSendReceipt {
            provider_message_id: Some(provider_message_id.to_string()),
        });
    }

    // Error responses are not guaranteed to be JSON. Classify the HTTP status
    // first, then enrich it from a provider body when one is available.
    let body = serde_json::from_slice::<Value>(&response_bytes).ok();
    Err(classify_youtube_send_error(
        status,
        body.as_ref(),
        retry_after.as_deref(),
    ))
}

fn classify_youtube_send_error(
    status: reqwest::StatusCode,
    body: Option<&Value>,
    retry_after: Option<&str>,
) -> YouTubeSendFailure {
    let (reason, domain) = body
        .map(crate::youtube_quota::error_reason_and_domain)
        .unwrap_or((None, None));
    if crate::youtube_quota::classify_youtube_api_error(
        status.as_u16(),
        reason.as_deref(),
        domain.as_deref(),
    ) == crate::youtube_quota::YouTubeApiErrorClass::QuotaExhausted
    {
        return YouTubeSendFailure {
            message: crate::youtube_quota::SEND_PAUSED_MESSAGE.to_string(),
            quota_exhausted: true,
        };
    }
    classify_youtube_send_error_message(status, body, retry_after).into()
}

fn classify_youtube_send_error_message(
    status: reqwest::StatusCode,
    body: Option<&Value>,
    retry_after: Option<&str>,
) -> String {
    let provider_code = body
        .and_then(|body| body.pointer("/error/errors/0/reason"))
        .and_then(Value::as_str);
    let provider_message = body
        .and_then(|body| body.pointer("/error/message"))
        .and_then(Value::as_str);
    let provider_reason = provider_message.or(provider_code);
    let normalized_code = provider_code.unwrap_or_default().to_ascii_lowercase();
    let normalized_message = provider_message.unwrap_or_default().to_ascii_lowercase();
    let retry_suffix = || {
        retry_after
            .map(|seconds| format!("; retry after {seconds}s"))
            .unwrap_or_default()
    };

    match status.as_u16() {
        401 => "YouTube rejected the send. Reconnect YouTube to refresh access.".to_string(),
        403 if normalized_code.contains("livechatdisabled")
            || normalized_message.contains("live chat is disabled") =>
        {
            "YouTube live chat is disabled for this broadcast.".to_string()
        }
        403 if normalized_code.contains("livechatended")
            || normalized_message.contains("live chat has ended") =>
        {
            "YouTube live chat has ended for this broadcast.".to_string()
        }
        403 if normalized_code.contains("ratelimit")
            || normalized_message.contains("rate limit") =>
        {
            format!("YouTube rate-limited the send{}.", retry_suffix())
        }
        403 if matches!(
            normalized_code.as_str(),
            "autherror" | "forbidden" | "insufficientpermissions"
        ) =>
        {
            "YouTube rejected the send. Reconnect YouTube to refresh access.".to_string()
        }
        403 => provider_reason
            .map(|reason| format!("YouTube send failed ({status}): {reason}"))
            .unwrap_or_else(|| format!("YouTube send failed ({status}).")),
        // Documented `liveChatNotFound`. A 404 without that reason (Google's
        // HTML "no such route" page) falls through with its raw status, so a
        // wrong send path stays diagnosable instead of reading as "ended".
        404 if normalized_code == "livechatnotfound" => {
            "YouTube live chat isn't available for this broadcast (it may have ended).".to_string()
        }
        429 => format!("YouTube rate-limited the send{}.", retry_suffix()),
        _ => provider_reason
            .map(|reason| format!("YouTube send failed ({status}): {reason}"))
            .unwrap_or_else(|| format!("YouTube send failed ({status}).")),
    }
}

/// Which `liveChatMessages` endpoint a request targets. The connector uses
/// `List`; `StreamList` is the S5 path and only its URL is built today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YouTubeChatTransport {
    #[cfg_attr(not(test), allow(dead_code))]
    StreamList,
    List,
}

// --- API response model (the subset we consume) ---

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveChatMessagesResponse {
    #[serde(default)]
    offline_at: Option<String>,
    #[serde(default)]
    polling_interval_millis: Option<u64>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    items: Vec<LiveChatItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveChatItem {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    snippet: LiveChatItemSnippet,
    #[serde(default)]
    author_details: Option<LiveChatAuthorDetails>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveChatItemSnippet {
    #[serde(rename = "type", default)]
    message_type: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    display_message: Option<String>,
    #[serde(default)]
    super_chat_details: Option<AmountDetails>,
    #[serde(default)]
    super_sticker_details: Option<AmountDetails>,
    #[serde(default)]
    message_deleted_details: Option<MessageDeletedDetails>,
    #[serde(default)]
    new_sponsor_details: Option<NewSponsorDetails>,
    #[serde(default)]
    member_milestone_chat_details: Option<MemberMilestoneDetails>,
    #[serde(default)]
    membership_gifting_details: Option<MembershipGiftingDetails>,
    #[serde(default)]
    gift_membership_received_details: Option<GiftMembershipReceivedDetails>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageDeletedDetails {
    #[serde(default)]
    deleted_message_id: Option<String>,
}

/// Super Chat and Super Sticker amounts. Google encodes unsigned longs as JSON
/// strings, so the numeric fields accept either form.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmountDetails {
    #[serde(default)]
    amount_display_string: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    amount_micros: Option<u64>,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    tier: Option<u64>,
    #[serde(default)]
    super_sticker_metadata: Option<SuperStickerMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuperStickerMetadata {
    #[serde(default)]
    alt_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSponsorDetails {
    #[serde(default)]
    member_level_name: Option<String>,
    #[serde(default)]
    is_upgrade: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberMilestoneDetails {
    #[serde(default)]
    member_level_name: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    member_month: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipGiftingDetails {
    #[serde(default, deserialize_with = "lenient_u64")]
    gift_memberships_count: Option<u64>,
    #[serde(default)]
    gift_memberships_level_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GiftMembershipReceivedDetails {
    #[serde(default)]
    member_level_name: Option<String>,
}

fn lenient_u64<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error> {
    Ok(
        match Option::<serde_json::Value>::deserialize(deserializer)? {
            Some(serde_json::Value::Number(number)) => number.as_u64(),
            Some(serde_json::Value::String(text)) => text.trim().parse().ok(),
            _ => None,
        },
    )
}

fn small(value: Option<u64>) -> Option<u32> {
    value.and_then(|number| u32::try_from(number).ok())
}

/// Structured facts for a YouTube monetized or membership event (plan 055).
fn event_details(
    snippet: &LiveChatItemSnippet,
    message_type: &str,
) -> Option<LiveChatEventDetails> {
    let amount = |details: &AmountDetails| {
        Some((
            details.amount_micros?,
            details.currency.clone().filter(|code| !code.is_empty())?,
            details.amount_display_string.clone().unwrap_or_default(),
        ))
    };
    match message_type {
        "superChatEvent" => {
            let details = snippet.super_chat_details.as_ref()?;
            let (amount_micros, currency, amount_display) = amount(details)?;
            Some(LiveChatEventDetails::SuperChat {
                amount_micros,
                currency,
                amount_display,
                tier: small(details.tier),
            })
        }
        "superStickerEvent" => {
            let details = snippet.super_sticker_details.as_ref()?;
            let (amount_micros, currency, amount_display) = amount(details)?;
            Some(LiveChatEventDetails::SuperSticker {
                amount_micros,
                currency,
                amount_display,
                alt_text: details
                    .super_sticker_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.alt_text.clone()),
            })
        }
        "newSponsorEvent" => {
            let details = snippet.new_sponsor_details.as_ref();
            Some(LiveChatEventDetails::Membership {
                membership: if details.is_some_and(|details| details.is_upgrade) {
                    MembershipKind::Upgrade
                } else {
                    MembershipKind::New
                },
                level_name: details.and_then(|details| details.member_level_name.clone()),
                months: None,
                gift_count: None,
            })
        }
        "memberMilestoneChatEvent" => {
            let details = snippet.member_milestone_chat_details.as_ref();
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::Milestone,
                level_name: details.and_then(|details| details.member_level_name.clone()),
                months: details.and_then(|details| small(details.member_month)),
                gift_count: None,
            })
        }
        "membershipGiftingEvent" => {
            let details = snippet.membership_gifting_details.as_ref();
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::Gift,
                level_name: details.and_then(|details| details.gift_memberships_level_name.clone()),
                months: None,
                gift_count: details.and_then(|details| small(details.gift_memberships_count)),
            })
        }
        "giftMembershipReceivedEvent" => Some(LiveChatEventDetails::Membership {
            membership: MembershipKind::GiftReceived,
            level_name: snippet
                .gift_membership_received_details
                .as_ref()
                .and_then(|details| details.member_level_name.clone()),
            months: None,
            gift_count: None,
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveChatAuthorDetails {
    #[serde(default)]
    channel_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    profile_image_url: Option<String>,
    #[serde(default)]
    is_verified: bool,
    #[serde(default)]
    is_chat_owner: bool,
    #[serde(default)]
    is_chat_sponsor: bool,
    #[serde(default)]
    is_chat_moderator: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveBroadcastListResponse {
    #[serde(default)]
    items: Vec<LiveBroadcastItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveBroadcastItem {
    #[serde(default)]
    snippet: Option<LiveBroadcastSnippet>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveBroadcastSnippet {
    #[serde(default)]
    live_chat_id: Option<String>,
}

// --- Pure normalization + classification (unit-tested) ---

/// A normalized page of chat: messages oldest-to-newest, the resume token, the server's poll
/// interval (clamped), and whether chat has ended.
#[derive(Debug, Clone, PartialEq, Eq)]
struct YouTubeChatPage {
    messages: Vec<LiveChatMessage>,
    next_page_token: Option<String>,
    polling_interval_ms: u64,
    ended: bool,
}

/// How a request failed, mapped to a provider-status reaction (never a stream failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YouTubeChatErrorKind {
    Disabled,
    Ended,
    /// Too fast: back off, keep polling.
    RateLimited,
    /// The project's daily quota is used up (plan 094): park through the
    /// shared breaker until the reset, then resume from the page token.
    QuotaExhausted,
    /// Another 403: permissions, not "chat disabled".
    Forbidden,
    InvalidPageToken,
    AuthExpired,
    Transient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FetchError {
    Api(YouTubeChatErrorKind),
    Network,
}

fn event_type_for(message_type: &str) -> LiveChatEventType {
    match message_type {
        "textMessageEvent" => LiveChatEventType::Message,
        "superChatEvent" | "superStickerEvent" => LiveChatEventType::Paid,
        "newSponsorEvent"
        | "memberMilestoneChatEvent"
        | "membershipGiftingEvent"
        | "giftMembershipReceivedEvent" => LiveChatEventType::Membership,
        "messageDeletedEvent" | "tombstone" => LiveChatEventType::Deleted,
        "userBannedEvent" => LiveChatEventType::Moderation,
        _ => LiveChatEventType::System,
    }
}

/// A safe, human-readable row for events YouTube does not give a `displayMessage` (so we
/// never silently drop an event the panel can't style yet).
fn system_text_for(message_type: &str, amount: Option<&str>) -> String {
    let suffix = amount.map(|a| format!(": {a}")).unwrap_or_default();
    match message_type {
        "superChatEvent" => format!("Super Chat{suffix}"),
        "superStickerEvent" => format!("Super Sticker{suffix}"),
        "newSponsorEvent" => "New member".to_string(),
        "memberMilestoneChatEvent" => "Member milestone".to_string(),
        "membershipGiftingEvent" => "Gifted memberships".to_string(),
        "giftMembershipReceivedEvent" => "Received a gifted membership".to_string(),
        "messageDeletedEvent" | "tombstone" => "Message deleted".to_string(),
        "userBannedEvent" => "A user was removed from chat".to_string(),
        "chatEndedEvent" => "Live chat has ended".to_string(),
        "sponsorOnlyModeStartedEvent" => "Members-only chat started".to_string(),
        "sponsorOnlyModeEndedEvent" => "Members-only chat ended".to_string(),
        _ => "Live chat event".to_string(),
    }
}

fn author_roles(author: &LiveChatAuthorDetails) -> Vec<String> {
    let mut roles = Vec::new();
    if author.is_chat_owner {
        roles.push("owner".to_string());
    }
    if author.is_chat_moderator {
        roles.push("moderator".to_string());
    }
    if author.is_chat_sponsor {
        roles.push("member".to_string());
    }
    if author.is_verified {
        roles.push("verified".to_string());
    }
    roles
}

fn normalize_item(
    item: &LiveChatItem,
    session_id: &str,
    target_id: Option<&str>,
    received_at: &str,
) -> Option<LiveChatMessage> {
    let event_provider_message_id = item.id.clone()?;
    let message_type = item
        .snippet
        .message_type
        .as_deref()
        .unwrap_or("textMessageEvent");
    let event_type = event_type_for(message_type);
    let provider_message_id = if event_type == LiveChatEventType::Deleted {
        item.snippet
            .message_deleted_details
            .as_ref()
            .and_then(|details| details.deleted_message_id.clone())
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(event_provider_message_id)
    } else {
        event_provider_message_id
    };
    let author = item.author_details.as_ref();
    let amount_text = item
        .snippet
        .super_chat_details
        .as_ref()
        .and_then(|details| details.amount_display_string.clone())
        .or_else(|| {
            item.snippet
                .super_sticker_details
                .as_ref()
                .and_then(|details| details.amount_display_string.clone())
        });
    let message_text = item
        .snippet
        .display_message
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| system_text_for(message_type, amount_text.as_deref()));
    Some(LiveChatMessage {
        id: live_chat_message_id(
            session_id,
            StreamPlatform::Youtube,
            target_id,
            &provider_message_id,
        ),
        provider_message_id,
        platform: StreamPlatform::Youtube,
        target_id: target_id.map(ToOwned::to_owned),
        session_id: session_id.to_string(),
        author_id: author.and_then(|details| details.channel_id.clone()),
        author_name: author
            .and_then(|details| details.display_name.clone())
            .unwrap_or_else(|| "YouTube viewer".to_string()),
        author_avatar_url: author.and_then(|details| details.profile_image_url.clone()),
        author_badges: Vec::new(),
        author_roles: author.map(author_roles).unwrap_or_default(),
        published_at: item
            .snippet
            .published_at
            .clone()
            .unwrap_or_else(|| received_at.to_string()),
        received_at: received_at.to_string(),
        message_text,
        fragments: Vec::new(),
        event_type,
        amount_text,
        is_deleted: matches!(event_type, LiveChatEventType::Deleted),
        raw_provider_type: Some(message_type.to_string()),
        details: event_details(&item.snippet, message_type),
        reply: None,
        first_message: false,
        author_affiliation: None,
    })
}

fn normalize_page(
    response: LiveChatMessagesResponse,
    session_id: &str,
    target_id: Option<&str>,
    received_at: &str,
) -> YouTubeChatPage {
    let ended = response.offline_at.is_some()
        || response
            .items
            .iter()
            .any(|item| item.snippet.message_type.as_deref() == Some("chatEndedEvent"));
    let polling_interval_ms = next_poll_delay_ms(response.polling_interval_millis, 0);
    let messages = response
        .items
        .iter()
        .filter_map(|item| normalize_item(item, session_id, target_id, received_at))
        .collect();
    YouTubeChatPage {
        messages,
        next_page_token: response.next_page_token,
        polling_interval_ms,
        ended,
    }
}

/// The delay before the next `list` poll (plan 094, D1). The server's
/// `pollingIntervalMillis` is honoured when larger than the floor; after
/// [`IDLE_EMPTY_PAGES`] empty pages in a row the poll stretches to
/// [`IDLE_POLLING_INTERVAL_MS`], and snaps back on the next message.
pub fn next_poll_delay_ms(server_interval_ms: Option<u64>, empty_pages_in_a_row: u32) -> u64 {
    next_poll_delay_ms_with_floor(
        server_interval_ms,
        empty_pages_in_a_row,
        MIN_POLLING_INTERVAL_MS,
    )
}

/// The same with the remote `minPollMs` floor (plan 094, S7): never below the
/// compiled 5 s floor, and the idle stretch never below the remote floor.
pub fn next_poll_delay_ms_with_floor(
    server_interval_ms: Option<u64>,
    empty_pages_in_a_row: u32,
    floor_ms: u64,
) -> u64 {
    let floor_ms = floor_ms.max(MIN_POLLING_INTERVAL_MS);
    let floor = if empty_pages_in_a_row >= IDLE_EMPTY_PAGES {
        IDLE_POLLING_INTERVAL_MS.max(floor_ms)
    } else {
        floor_ms
    };
    server_interval_ms
        .unwrap_or(DEFAULT_POLLING_INTERVAL_MS)
        .max(floor)
}

/// Map an HTTP status + YouTube error `reason`/`domain` to a reaction. 403/404/quota are
/// provider statuses, not crashes — the stream keeps running even when chat cannot.
fn classify_status(
    status: u16,
    reason: Option<&str>,
    domain: Option<&str>,
) -> YouTubeChatErrorKind {
    use crate::youtube_quota::YouTubeApiErrorClass;
    match crate::youtube_quota::classify_youtube_api_error(status, reason, domain) {
        YouTubeApiErrorClass::QuotaExhausted => YouTubeChatErrorKind::QuotaExhausted,
        YouTubeApiErrorClass::RateLimited => YouTubeChatErrorKind::RateLimited,
        YouTubeApiErrorClass::AuthExpired if status == 401 => YouTubeChatErrorKind::AuthExpired,
        YouTubeApiErrorClass::AuthExpired | YouTubeApiErrorClass::Forbidden => match reason {
            Some("liveChatDisabled") => YouTubeChatErrorKind::Disabled,
            Some("liveChatEnded") => YouTubeChatErrorKind::Ended,
            _ => YouTubeChatErrorKind::Forbidden,
        },
        YouTubeApiErrorClass::BadRequest => match reason {
            Some("pageTokenInvalid") | Some("invalidPageToken") => {
                YouTubeChatErrorKind::InvalidPageToken
            }
            _ => YouTubeChatErrorKind::Transient,
        },
        YouTubeApiErrorClass::NotFound => YouTubeChatErrorKind::Ended,
        YouTubeApiErrorClass::Transient => YouTubeChatErrorKind::Transient,
    }
}

/// `(provider state, message, should_stop)` for an error kind.
fn provider_reaction(
    kind: YouTubeChatErrorKind,
) -> (LiveChatProviderConnectionState, &'static str, bool) {
    match kind {
        YouTubeChatErrorKind::Disabled => (
            LiveChatProviderConnectionState::Failed,
            "Live chat is disabled for this YouTube broadcast.",
            true,
        ),
        YouTubeChatErrorKind::Ended => (
            LiveChatProviderConnectionState::Ended,
            "YouTube live chat has ended.",
            true,
        ),
        YouTubeChatErrorKind::RateLimited => (
            LiveChatProviderConnectionState::Reconnecting,
            "YouTube live chat is rate limited; backing off.",
            false,
        ),
        YouTubeChatErrorKind::QuotaExhausted => (
            LiveChatProviderConnectionState::Waiting,
            crate::youtube_quota::CHAT_PAUSED_MESSAGE,
            false,
        ),
        YouTubeChatErrorKind::Forbidden => (
            LiveChatProviderConnectionState::Failed,
            "YouTube refused live chat for this account. Check the channel's live chat permissions, or reconnect YouTube.",
            true,
        ),
        YouTubeChatErrorKind::InvalidPageToken => (
            LiveChatProviderConnectionState::Reconnecting,
            "Resyncing YouTube live chat.",
            false,
        ),
        YouTubeChatErrorKind::AuthExpired => (
            LiveChatProviderConnectionState::Failed,
            "Reconnect YouTube to enable live comments.",
            true,
        ),
        YouTubeChatErrorKind::Transient => (
            LiveChatProviderConnectionState::Reconnecting,
            "Reconnecting to YouTube live chat…",
            false,
        ),
    }
}

fn chat_messages_url(
    base_url: &str,
    transport: YouTubeChatTransport,
    live_chat_id: &str,
    page_token: Option<&str>,
) -> Result<Url> {
    let path = match transport {
        YouTubeChatTransport::StreamList => LIVE_CHAT_MESSAGES_STREAM_PATH,
        YouTubeChatTransport::List => LIVE_CHAT_MESSAGES_PATH,
    };
    let mut url = Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))
        .context("Invalid YouTube API base URL.")?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("liveChatId", live_chat_id);
        pairs.append_pair("part", "snippet,authorDetails");
        if let Some(token) = page_token {
            pairs.append_pair("pageToken", token);
        }
    }
    Ok(url)
}

/// `(reason, domain)` of Google's error envelope; `(None, None)` for HTML bodies.
async fn extract_error_reason(response: reqwest::Response) -> (Option<String>, Option<String>) {
    match response.json::<Value>().await {
        Ok(body) => crate::youtube_quota::error_reason_and_domain(&body),
        Err(_) => (None, None),
    }
}

async fn fetch_chat_page(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    transport: YouTubeChatTransport,
    live_chat_id: &str,
    page_token: Option<&str>,
) -> std::result::Result<LiveChatMessagesResponse, FetchError> {
    let url = chat_messages_url(base_url, transport, live_chat_id, page_token)
        .map_err(|_| FetchError::Network)?;
    let response = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| FetchError::Network)?;
    let status = response.status();
    if status.is_success() {
        response
            .json::<LiveChatMessagesResponse>()
            .await
            .map_err(|_| FetchError::Network)
    } else {
        let (reason, domain) = extract_error_reason(response).await;
        Err(FetchError::Api(classify_status(
            status.as_u16(),
            reason.as_deref(),
            domain.as_deref(),
        )))
    }
}

/// Resolve a broadcast's `liveChatId` via `liveBroadcasts.list?part=snippet&id=...`.
pub async fn resolve_live_chat_id(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    broadcast_id: &str,
) -> Result<Option<String>> {
    let mut url = Url::parse(&format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        LIVE_BROADCASTS_PATH
    ))
    .context("Invalid YouTube API base URL.")?;
    url.query_pairs_mut()
        .append_pair("part", "snippet")
        .append_pair("id", broadcast_id);
    let response = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("Could not resolve YouTube live chat id.")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(crate::youtube_quota::YouTubeApiError::from_body(
            "YouTube broadcast lookup failed",
            status,
            &body,
        )
        .into());
    }
    let response: LiveBroadcastListResponse = response
        .json()
        .await
        .context("Could not parse YouTube broadcast lookup.")?;
    Ok(response
        .items
        .into_iter()
        .next()
        .and_then(|item| item.snippet)
        .and_then(|snippet| snippet.live_chat_id))
}

/// The connector task: resolve the chat id, then poll → normalize → deliver, honoring the
/// server poll interval, with backoff + status transitions on errors. Spawned by session
/// integration (and `liveChat.start` with a `youtube` config for the live smoke).
pub async fn run_youtube_chat_connector(
    state: AppState,
    session_id: String,
    session_generation: u64,
    config: YouTubeChatConfig,
) {
    let client = reqwest::Client::new();
    let base_url = crate::youtube_quota::youtube_api_base_url(config.api_base_url.as_deref());
    let target_id = config.target_id.clone();
    let mut token = crate::session_token::SessionToken::new(
        config.access_token.clone(),
        config.token_source.clone(),
    );

    // Park while the remote `chatTransport: off` flag is set (plan 094, S7):
    // Waiting with a clear message, no request, back by itself on the next
    // flag refresh.
    let park_while_off = || {
        let state = state.clone();
        let session_id = session_id.clone();
        let target_id = target_id.clone();
        async move {
            if crate::youtube_quota::chat_switched_off(&state) {
                set_provider_and_emit(
                    &state,
                    &session_id,
                    session_generation,
                    StreamPlatform::Youtube,
                    target_id.as_deref(),
                    LiveChatProviderConnectionState::Waiting,
                    crate::youtube_quota::CHAT_OFF_MESSAGE,
                )
                .await;
                crate::youtube_quota::wait_while_chat_off(&state).await;
                return true;
            }
            false
        }
    };
    // Park while the shared breaker is set (plan 094): chat says it is waiting
    // and until when, spends nothing, and comes back by itself.
    let park = |message: &'static str| {
        let state = state.clone();
        let session_id = session_id.clone();
        let target_id = target_id.clone();
        async move {
            if let Some(until) = crate::youtube_quota::paused_until(&state) {
                crate::live_chat::set_provider_waiting_and_emit(
                    &state,
                    &session_id,
                    session_generation,
                    StreamPlatform::Youtube,
                    target_id.as_deref(),
                    message,
                    &until.to_rfc3339(),
                )
                .await;
                crate::youtube_quota::wait_until_resumed(&state).await;
            }
        }
    };

    let resolved = match config.live_chat_id.clone() {
        Some(id) => Some(id),
        None => match &config.broadcast_id {
            Some(broadcast_id) => loop {
                park_while_off().await;
                park(crate::youtube_quota::CHAT_PAUSED_MESSAGE).await;
                let access_token = token.ensure_fresh(&state, &client).await.to_string();
                crate::youtube_quota::record_call(
                    &state,
                    crate::youtube_quota::YouTubeEndpoint::LiveBroadcastsList,
                );
                match resolve_live_chat_id(&client, &base_url, &access_token, broadcast_id).await {
                    Ok(live_chat_id) => break live_chat_id,
                    Err(error) => {
                        if crate::youtube_quota::note_error(&state, "chat id lookup", &error)
                            .is_some()
                        {
                            continue;
                        }
                        set_provider_and_emit(
                            &state,
                            &session_id,
                            session_generation,
                            StreamPlatform::Youtube,
                            target_id.as_deref(),
                            LiveChatProviderConnectionState::Failed,
                            &format!("Could not resolve YouTube live chat: {error:#}"),
                        )
                        .await;
                        return;
                    }
                }
            },
            None => None,
        },
    };
    let Some(live_chat_id) = resolved else {
        set_provider_and_emit(
            &state,
            &session_id,
            session_generation,
            StreamPlatform::Youtube,
            target_id.as_deref(),
            LiveChatProviderConnectionState::Failed,
            "No live chat is available for this YouTube broadcast.",
        )
        .await;
        return;
    };
    // The send path needs the resolved id too (Comments upgrade S4).
    crate::live_chat::set_youtube_send_chat_id(
        &state,
        &session_id,
        session_generation,
        target_id.as_deref(),
        &live_chat_id,
    )
    .await;

    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        StreamPlatform::Youtube,
        target_id.as_deref(),
        LiveChatProviderConnectionState::Connecting,
        "Connecting to YouTube live chat…",
    )
    .await;

    // S5 replaces this with a real streamList reader. Until then the transport
    // is fixed: no error ever flips it (plan 094, S1 item 6).
    let transport = YouTubeChatTransport::List;
    let mut page_token: Option<String> = None;
    let mut backoff_ms = MIN_POLLING_INTERVAL_MS;
    let mut empty_pages_in_a_row: u32 = 0;
    let mut connected = false;
    // One renewal per refusal: a second refusal right after it means the
    // account itself must be reconnected (plan 055, B2).
    let mut renewed_since_success = false;

    loop {
        if park_while_off().await {
            connected = false;
            continue;
        }
        if crate::youtube_quota::paused_until(&state).is_some() {
            park(crate::youtube_quota::CHAT_PAUSED_MESSAGE).await;
            // Resumed: the page token still points at the next unseen page.
            connected = false;
            continue;
        }
        let access_token = token.ensure_fresh(&state, &client).await.to_string();
        crate::youtube_quota::record_call(
            &state,
            crate::youtube_quota::YouTubeEndpoint::LiveChatMessagesList,
        );
        match fetch_chat_page(
            &client,
            &base_url,
            &access_token,
            transport,
            &live_chat_id,
            page_token.as_deref(),
        )
        .await
        {
            Ok(response) => {
                renewed_since_success = false;
                let now = chrono::Utc::now().to_rfc3339();
                let server_interval_ms = response.polling_interval_millis;
                let page = normalize_page(response, &session_id, target_id.as_deref(), &now);
                if !connected {
                    connected = true;
                    set_provider_and_emit(
                        &state,
                        &session_id,
                        session_generation,
                        StreamPlatform::Youtube,
                        target_id.as_deref(),
                        LiveChatProviderConnectionState::Connected,
                        "YouTube live chat connected.",
                    )
                    .await;
                }
                if page.messages.is_empty() {
                    empty_pages_in_a_row = empty_pages_in_a_row.saturating_add(1);
                } else {
                    empty_pages_in_a_row = 0;
                }
                let delay_ms = next_poll_delay_ms_with_floor(
                    server_interval_ms,
                    empty_pages_in_a_row,
                    crate::youtube_quota::chat_poll_floor_ms(&state),
                );
                if let Err(error) =
                    try_deliver_messages(&state, session_generation, page.messages).await
                {
                    if error.is_terminal() {
                        set_provider_and_emit(
                            &state,
                            &session_id,
                            session_generation,
                            StreamPlatform::Youtube,
                            target_id.as_deref(),
                            LiveChatProviderConnectionState::Failed,
                            &format!(
                                "YouTube live chat stopped because comments storage failed: {error}"
                            ),
                        )
                        .await;
                        return;
                    }
                    // Do not advance the provider cursor past a page that was
                    // rejected by durable persistence. The next poll requests
                    // the same page and the restored de-dup state accepts it.
                    sleep(Duration::from_millis(delay_ms)).await;
                    continue;
                }
                page_token = page.next_page_token;
                backoff_ms = MIN_POLLING_INTERVAL_MS;
                if page.ended {
                    set_provider_and_emit(
                        &state,
                        &session_id,
                        session_generation,
                        StreamPlatform::Youtube,
                        target_id.as_deref(),
                        LiveChatProviderConnectionState::Ended,
                        "YouTube live chat has ended.",
                    )
                    .await;
                    return;
                }
                sleep(Duration::from_millis(delay_ms)).await;
            }
            Err(error) => {
                let kind = match error {
                    FetchError::Api(kind) => kind,
                    FetchError::Network => YouTubeChatErrorKind::Transient,
                };
                if kind == YouTubeChatErrorKind::QuotaExhausted {
                    // Set the breaker for every YouTube caller, then park. The
                    // page token is kept: the reader resumes where it stopped.
                    crate::youtube_quota::record_quota_exhausted(&state, "chat read");
                    park(crate::youtube_quota::CHAT_PAUSED_MESSAGE).await;
                    connected = false;
                    continue;
                }
                if kind == YouTubeChatErrorKind::AuthExpired {
                    if !renewed_since_success
                        && token.renew_after_refusal(&state, &client).await.is_ok()
                    {
                        renewed_since_success = true;
                        continue;
                    }
                    set_provider_and_emit(
                        &state,
                        &session_id,
                        session_generation,
                        StreamPlatform::Youtube,
                        target_id.as_deref(),
                        LiveChatProviderConnectionState::Failed,
                        YOUTUBE_SIGN_IN_EXPIRED,
                    )
                    .await;
                    return;
                }
                let (provider_state, message, stop) = provider_reaction(kind);
                set_provider_and_emit(
                    &state,
                    &session_id,
                    session_generation,
                    StreamPlatform::Youtube,
                    target_id.as_deref(),
                    provider_state,
                    message,
                )
                .await;
                if stop {
                    return;
                }
                if kind == YouTubeChatErrorKind::InvalidPageToken {
                    page_token = None;
                }
                connected = false;
                sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms.saturating_mul(2)).min(MAX_BACKOFF_MS);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{OriginalUri, State};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;

    #[derive(Clone)]
    struct MockSendResponse {
        status: StatusCode,
        body: Value,
    }

    #[derive(Clone)]
    struct MockRawSendResponse {
        status: StatusCode,
        body: String,
    }

    async fn mock_send_response(State(response): State<MockSendResponse>) -> impl IntoResponse {
        (response.status, Json(response.body))
    }

    async fn mock_raw_send_response(
        State(response): State<MockRawSendResponse>,
    ) -> impl IntoResponse {
        (response.status, response.body)
    }

    async fn spawn_send_server(status: StatusCode, body: Value) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(LIVE_CHAT_MESSAGES_PATH, post(mock_send_response))
            .with_state(MockSendResponse { status, body });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    async fn spawn_raw_send_server(status: StatusCode, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(LIVE_CHAT_MESSAGES_PATH, post(mock_raw_send_response))
            .with_state(MockRawSendResponse {
                status,
                body: body.to_string(),
            });
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    #[derive(Debug, Clone)]
    struct CapturedSend {
        method: String,
        path: String,
        query: String,
        authorization: String,
        body: Value,
    }

    async fn capture_send(
        State(captured): State<Arc<Mutex<Option<CapturedSend>>>>,
        method: axum::http::Method,
        OriginalUri(uri): OriginalUri,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        *captured.lock().unwrap() = Some(CapturedSend {
            method: method.to_string(),
            path: uri.path().to_string(),
            query: uri.query().unwrap_or_default().to_string(),
            authorization: headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            body,
        });
        Json(json!({ "id": "yt-sent-1" }))
    }

    fn text_response() -> LiveChatMessagesResponse {
        serde_json::from_value(json!({
            "pollingIntervalMillis": 3000,
            "nextPageToken": "tok-2",
            "items": [{
                "id": "msg-1",
                "snippet": {
                    "type": "textMessageEvent",
                    "publishedAt": "2026-06-06T10:00:00Z",
                    "displayMessage": "hello world"
                },
                "authorDetails": {
                    "channelId": "UCviewer",
                    "displayName": "Viewer One",
                    "profileImageUrl": "https://example.test/a.jpg",
                    "isChatModerator": true
                }
            }]
        }))
        .unwrap()
    }

    #[test]
    fn monetized_and_membership_events_carry_structured_details() {
        let response: LiveChatMessagesResponse = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/stream-manager/youtube-live-chat-page.json"
        ))
        .unwrap();
        let page = normalize_page(response, "s1", None, "now");
        let details = |id: &str| {
            page.messages
                .iter()
                .find(|message| message.provider_message_id == id)
                .unwrap()
                .details
                .clone()
        };
        assert_eq!(
            details("yt-super-chat"),
            Some(LiveChatEventDetails::SuperChat {
                amount_micros: 5_000_000,
                currency: "USD".to_string(),
                amount_display: "$5.00".to_string(),
                tier: Some(2),
            })
        );
        assert_eq!(
            details("yt-super-sticker"),
            Some(LiveChatEventDetails::SuperSticker {
                amount_micros: 2_000_000,
                currency: "EUR".to_string(),
                amount_display: "€2.00".to_string(),
                alt_text: Some("Party hat".to_string()),
            })
        );
        assert!(matches!(
            details("yt-new-member"),
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::Upgrade,
                ..
            })
        ));
        assert!(matches!(
            details("yt-milestone"),
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::Milestone,
                months: Some(12),
                ..
            })
        ));
        assert!(matches!(
            details("yt-gifting"),
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::Gift,
                gift_count: Some(5),
                ..
            })
        ));
        assert!(matches!(
            details("yt-gift-received"),
            Some(LiveChatEventDetails::Membership {
                membership: MembershipKind::GiftReceived,
                ..
            })
        ));
        assert_eq!(details("yt-text"), None);
    }

    #[test]
    fn plain_rows_serialize_without_the_new_fields_and_details_use_camel_case() {
        let response: LiveChatMessagesResponse = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/stream-manager/youtube-live-chat-page.json"
        ))
        .unwrap();
        let page = normalize_page(response, "s1", None, "now");
        let text = page
            .messages
            .iter()
            .find(|message| message.provider_message_id == "yt-text")
            .unwrap();
        let json = serde_json::to_value(text).unwrap();
        for key in ["details", "reply", "firstMessage"] {
            assert!(json.get(key).is_none(), "{key} must be absent, never null");
        }
        let super_chat = page
            .messages
            .iter()
            .find(|message| message.provider_message_id == "yt-super-chat")
            .unwrap();
        let json = serde_json::to_value(super_chat).unwrap();
        assert_eq!(json["details"]["kind"], "super-chat");
        assert_eq!(json["details"]["amountMicros"], 5_000_000);
        assert_eq!(json["details"]["amountDisplay"], "$5.00");
    }

    #[test]
    fn chat_send_body_shapes_the_insert_request() {
        let body = chat_send_body("chat-1", "hello viewers");
        assert_eq!(body["snippet"]["liveChatId"], "chat-1");
        assert_eq!(body["snippet"]["type"], "textMessageEvent");
        assert_eq!(
            body["snippet"]["textMessageDetails"]["messageText"],
            "hello viewers"
        );
    }

    /// Pins the documented `liveChatMessages.insert` route. The resource is
    /// named `liveChatMessages` but its REST path is `liveChat/messages`;
    /// posting to `/youtube/v3/liveChatMessages` gets Google's HTML 404.
    #[tokio::test]
    async fn send_posts_to_the_documented_insert_route() {
        let captured = Arc::new(Mutex::new(None));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .fallback(capture_send)
            .with_state(captured.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let receipt = send_youtube_chat_message(
            &reqwest::Client::new(),
            Some(&format!("http://{address}")),
            "token-1",
            "chat-1",
            "hello",
        )
        .await
        .unwrap();

        assert_eq!(receipt.provider_message_id.as_deref(), Some("yt-sent-1"));
        let request = captured
            .lock()
            .unwrap()
            .clone()
            .expect("send reached the mock");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/youtube/v3/liveChat/messages");
        assert_eq!(request.path, LIVE_CHAT_MESSAGES_PATH);
        assert_eq!(request.query, "part=snippet");
        assert_eq!(request.authorization, "Bearer token-1");
        assert_eq!(request.body, chat_send_body("chat-1", "hello"));
    }

    #[test]
    fn send_classifies_documented_live_chat_not_found() {
        let body = json!({
            "error": {
                "code": 404,
                "message": "The live chat identified in the API request does not exist.",
                "errors": [{ "reason": "liveChatNotFound", "domain": "youtube.liveChat" }]
            }
        });
        let error = classify_youtube_send_error(StatusCode::NOT_FOUND, Some(&body), None);
        assert_eq!(
            error.message,
            "YouTube live chat isn't available for this broadcast (it may have ended)."
        );
        assert!(!error.quota_exhausted);
    }

    #[test]
    fn send_keeps_route_level_404_explicit() {
        // A non-JSON 404 is Google saying the route does not exist (our bug),
        // not a missing chat; keep the raw status so it stays diagnosable.
        let error = classify_youtube_send_error(StatusCode::NOT_FOUND, None, None);
        assert_eq!(error.message, "YouTube send failed (404 Not Found).");
    }

    #[tokio::test]
    async fn send_parses_provider_message_id() {
        let base = spawn_send_server(StatusCode::OK, json!({ "id": "yt-sent-1" })).await;
        let receipt = send_youtube_chat_message(
            &reqwest::Client::new(),
            Some(&base),
            "token",
            "chat-1",
            "hello",
        )
        .await
        .unwrap();
        assert_eq!(receipt.provider_message_id.as_deref(), Some("yt-sent-1"));
    }

    #[tokio::test]
    async fn send_rejects_success_without_provider_message_id() {
        let base =
            spawn_send_server(StatusCode::OK, json!({ "kind": "youtube#liveChatMessage" })).await;
        let error = send_youtube_chat_message(
            &reqwest::Client::new(),
            Some(&base),
            "token",
            "chat-1",
            "hello",
        )
        .await
        .unwrap_err();
        assert!(error.contains("without a message id"));
    }

    #[tokio::test]
    async fn send_preserves_provider_error_reason() {
        let base = spawn_send_server(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "message": "Live chat is disabled." } }),
        )
        .await;
        let error = send_youtube_chat_message(
            &reqwest::Client::new(),
            Some(&base),
            "token",
            "chat-1",
            "hello",
        )
        .await
        .unwrap_err();
        assert!(error.contains("Live chat is disabled"));
    }

    #[tokio::test]
    async fn send_classifies_non_json_auth_and_rate_limit_errors_from_status() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, "Reconnect YouTube"),
            (StatusCode::TOO_MANY_REQUESTS, "rate-limited"),
        ] {
            let base = spawn_raw_send_server(status, "not-json").await;
            let error = send_youtube_chat_message(
                &reqwest::Client::new(),
                Some(&base),
                "token",
                "chat-1",
                "hello",
            )
            .await
            .unwrap_err();
            assert!(error.contains(expected), "{status}: {error}");
            assert!(!error.contains("unreadable"), "{status}: {error}");
        }
    }

    #[test]
    fn youtube_403_reason_classification_preserves_broadcast_quota_and_auth_truth() {
        let disabled = json!({
            "error": {
                "message": "Live chat is disabled.",
                "errors": [{ "reason": "liveChatDisabled" }]
            }
        });
        assert_eq!(
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&disabled), None).message,
            "YouTube live chat is disabled for this broadcast."
        );

        let ended = json!({
            "error": {
                "message": "Live chat has ended.",
                "errors": [{ "reason": "liveChatEnded" }]
            }
        });
        assert_eq!(
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&ended), None).message,
            "YouTube live chat has ended for this broadcast."
        );

        let quota = json!({
            "error": {
                "message": "Quota exhausted.",
                "errors": [{ "reason": "quotaExceeded", "domain": "youtube.quota" }]
            }
        });
        let quota_error =
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&quota), Some("30"));
        assert!(quota_error.quota_exhausted);
        assert_eq!(
            quota_error.message,
            crate::youtube_quota::SEND_PAUSED_MESSAGE
        );

        let rate = json!({
            "error": {
                "message": "Too fast.",
                "errors": [{ "reason": "rateLimitExceeded", "domain": "usageLimits" }]
            }
        });
        let rate_error =
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&rate), Some("30"));
        assert!(!rate_error.quota_exhausted);
        assert!(rate_error.message.contains("rate-limited"));
        assert!(rate_error.message.contains("retry after 30s"));

        let auth = json!({
            "error": {
                "message": "Insufficient Permission",
                "errors": [{ "reason": "insufficientPermissions" }]
            }
        });
        assert!(
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&auth), None)
                .message
                .contains("Reconnect YouTube")
        );

        let unknown = json!({ "error": { "message": "Broadcast owner disabled posting." } });
        let unknown_error =
            classify_youtube_send_error(StatusCode::FORBIDDEN, Some(&unknown), None).message;
        assert!(unknown_error.contains("Broadcast owner disabled posting"));
        assert!(!unknown_error.contains("Reconnect YouTube"));
    }

    #[test]
    fn normalizes_text_message_with_author_roles() {
        let page = normalize_page(text_response(), "s1", Some("t1"), "2026-06-06T10:00:01Z");
        assert_eq!(page.messages.len(), 1);
        let message = &page.messages[0];
        assert_eq!(message.id, "s1:youtube:t1:msg-1");
        assert_eq!(message.provider_message_id, "msg-1");
        assert_eq!(message.platform, StreamPlatform::Youtube);
        assert_eq!(message.target_id.as_deref(), Some("t1"));
        assert_eq!(message.session_id, "s1");
        assert_eq!(message.author_name, "Viewer One");
        assert_eq!(message.author_id.as_deref(), Some("UCviewer"));
        assert_eq!(message.message_text, "hello world");
        assert_eq!(message.event_type, LiveChatEventType::Message);
        assert_eq!(message.author_roles, vec!["moderator".to_string()]);
        assert!(!message.is_deleted);
        // The 5 s floor wins over the server's 3 s (plan 094, D1), and the
        // resume token is threaded out.
        assert_eq!(page.polling_interval_ms, MIN_POLLING_INTERVAL_MS);
        assert_eq!(page.next_page_token.as_deref(), Some("tok-2"));
        assert!(!page.ended);
    }

    #[test]
    fn normalizes_super_chat_with_amount_and_paid_type() {
        let response: LiveChatMessagesResponse = serde_json::from_value(json!({
            "items": [{
                "id": "sc-1",
                "snippet": {
                    "type": "superChatEvent",
                    "superChatDetails": { "amountDisplayString": "$5.00" }
                },
                "authorDetails": { "displayName": "Generous Fan" }
            }]
        }))
        .unwrap();
        let page = normalize_page(response, "s1", None, "now");
        let message = &page.messages[0];
        assert_eq!(message.event_type, LiveChatEventType::Paid);
        assert_eq!(message.amount_text.as_deref(), Some("$5.00"));
        // No displayMessage → a safe styled row, not an empty/dropped one.
        assert_eq!(message.message_text, "Super Chat: $5.00");
    }

    #[test]
    fn membership_and_deletion_map_to_event_types() {
        let response: LiveChatMessagesResponse = serde_json::from_value(json!({
            "items": [
                { "id": "m1", "snippet": { "type": "newSponsorEvent" } },
                {
                    "id": "deletion-event-1",
                    "snippet": {
                        "type": "messageDeletedEvent",
                        "messageDeletedDetails": { "deletedMessageId": "message-1" }
                    }
                }
            ]
        }))
        .unwrap();
        let page = normalize_page(response, "s1", None, "now");
        assert_eq!(page.messages[0].event_type, LiveChatEventType::Membership);
        assert_eq!(page.messages[1].event_type, LiveChatEventType::Deleted);
        assert!(page.messages[1].is_deleted);
        assert_eq!(page.messages[1].provider_message_id, "message-1");
        assert_eq!(page.messages[1].id, "s1:youtube:default:message-1");
    }

    #[test]
    fn current_tombstone_contract_uses_the_outer_message_id() {
        let response: LiveChatMessagesResponse = serde_json::from_value(json!({
            "items": [
                {
                    "id": "message-1",
                    "snippet": { "type": "textMessageEvent", "displayMessage": "remove me" }
                },
                {
                    "id": "message-1",
                    "snippet": { "type": "tombstone" }
                }
            ]
        }))
        .unwrap();

        let page = normalize_page(response, "s1", Some("youtube-target"), "now");
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[0].id, page.messages[1].id);
        assert_eq!(page.messages[1].provider_message_id, "message-1");
        assert_eq!(page.messages[1].event_type, LiveChatEventType::Deleted);
        assert!(page.messages[1].is_deleted);
        assert_eq!(page.messages[1].message_text, "Message deleted");
    }

    #[test]
    fn unknown_event_becomes_safe_system_row_not_dropped() {
        let response: LiveChatMessagesResponse = serde_json::from_value(json!({
            "items": [{ "id": "x1", "snippet": { "type": "someBrandNewEvent" } }]
        }))
        .unwrap();
        let page = normalize_page(response, "s1", None, "now");
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].event_type, LiveChatEventType::System);
        assert!(!page.messages[0].message_text.is_empty());
    }

    #[test]
    fn offline_at_and_chat_ended_mark_page_ended() {
        let offline: LiveChatMessagesResponse =
            serde_json::from_value(json!({ "offlineAt": "2026-06-06T11:00:00Z", "items": [] }))
                .unwrap();
        assert!(normalize_page(offline, "s1", None, "now").ended);

        let ended: LiveChatMessagesResponse = serde_json::from_value(json!({
            "items": [{ "id": "e1", "snippet": { "type": "chatEndedEvent" } }]
        }))
        .unwrap();
        assert!(normalize_page(ended, "s1", None, "now").ended);
    }

    #[test]
    fn polling_interval_is_clamped_to_minimum() {
        let response: LiveChatMessagesResponse =
            serde_json::from_value(json!({ "pollingIntervalMillis": 10, "items": [] })).unwrap();
        assert_eq!(
            normalize_page(response, "s1", None, "now").polling_interval_ms,
            MIN_POLLING_INTERVAL_MS
        );
    }

    #[test]
    fn classifies_disabled_ended_quota_token_and_auth_errors() {
        assert_eq!(
            classify_status(403, Some("liveChatDisabled"), Some("youtube.liveChat")),
            YouTubeChatErrorKind::Disabled
        );
        assert_eq!(
            classify_status(403, Some("liveChatEnded"), None),
            YouTubeChatErrorKind::Ended
        );
        assert_eq!(
            classify_status(403, Some("rateLimitExceeded"), Some("usageLimits")),
            YouTubeChatErrorKind::RateLimited
        );
        assert_eq!(
            classify_status(403, Some("userRateLimitExceeded"), None),
            YouTubeChatErrorKind::RateLimited
        );
        // Plan 094: quota is its own kind, never "too fast" and never "disabled".
        assert_eq!(
            classify_status(403, Some("quotaExceeded"), Some("youtube.quota")),
            YouTubeChatErrorKind::QuotaExhausted
        );
        assert_eq!(
            classify_status(403, Some("dailyLimitExceeded"), None),
            YouTubeChatErrorKind::QuotaExhausted
        );
        assert_eq!(
            classify_status(403, Some("brandNewReason"), Some("youtube.quota")),
            YouTubeChatErrorKind::QuotaExhausted
        );
        // Any other 403 is a permissions problem, not "chat disabled".
        assert_eq!(
            classify_status(403, Some("forbidden"), Some("global")),
            YouTubeChatErrorKind::Forbidden
        );
        assert_eq!(
            classify_status(403, None, None),
            YouTubeChatErrorKind::Forbidden
        );
        assert_eq!(
            classify_status(429, None, None),
            YouTubeChatErrorKind::RateLimited
        );
        assert_eq!(
            classify_status(400, Some("pageTokenInvalid"), None),
            YouTubeChatErrorKind::InvalidPageToken
        );
        assert_eq!(
            classify_status(401, None, None),
            YouTubeChatErrorKind::AuthExpired
        );
        assert_eq!(
            classify_status(503, None, None),
            YouTubeChatErrorKind::Transient
        );
    }

    #[test]
    fn disabled_and_ended_stop_but_rate_limit_retries() {
        assert!(provider_reaction(YouTubeChatErrorKind::Disabled).2);
        assert!(provider_reaction(YouTubeChatErrorKind::Ended).2);
        assert!(provider_reaction(YouTubeChatErrorKind::AuthExpired).2);
        assert!(provider_reaction(YouTubeChatErrorKind::Forbidden).2);
        assert!(!provider_reaction(YouTubeChatErrorKind::RateLimited).2);
        assert!(!provider_reaction(YouTubeChatErrorKind::Transient).2);
        assert!(!provider_reaction(YouTubeChatErrorKind::InvalidPageToken).2);
        let (state, message, stop) = provider_reaction(YouTubeChatErrorKind::QuotaExhausted);
        assert_eq!(state, LiveChatProviderConnectionState::Waiting);
        assert_eq!(message, crate::youtube_quota::CHAT_PAUSED_MESSAGE);
        assert!(!stop);
        assert!(
            !provider_reaction(YouTubeChatErrorKind::Forbidden)
                .1
                .contains("disabled")
        );
    }

    #[test]
    fn poll_floor_is_five_seconds_and_stretches_after_six_empty_pages() {
        // The server asks for 1 s; the floor wins.
        assert_eq!(next_poll_delay_ms(Some(1_000), 0), 5_000);
        assert_eq!(next_poll_delay_ms(None, 0), 5_000);
        // A larger server interval is honoured.
        assert_eq!(next_poll_delay_ms(Some(7_500), 0), 7_500);
        // Empty pages stretch the poll after six in a row, and a message snaps it back.
        let sequence: Vec<u64> = (0..8u32)
            .map(|empty_pages| next_poll_delay_ms(Some(1_000), empty_pages))
            .collect();
        assert_eq!(
            sequence,
            vec![5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 10_000, 10_000]
        );
        assert_eq!(next_poll_delay_ms(Some(1_000), 0), 5_000, "snap back");
        assert_eq!(next_poll_delay_ms(Some(12_000), IDLE_EMPTY_PAGES), 12_000);
        // Plan 094 (S7): a remote floor only ever slows the reader down.
        assert_eq!(next_poll_delay_ms_with_floor(Some(1_000), 0, 8_000), 8_000);
        assert_eq!(next_poll_delay_ms_with_floor(Some(9_000), 0, 8_000), 9_000);
        assert_eq!(
            next_poll_delay_ms_with_floor(Some(1_000), 0, 10),
            5_000,
            "never below 5 s"
        );
        assert_eq!(
            next_poll_delay_ms_with_floor(Some(1_000), IDLE_EMPTY_PAGES, 8_000),
            10_000
        );
        assert_eq!(
            next_poll_delay_ms_with_floor(Some(1_000), IDLE_EMPTY_PAGES, 15_000),
            15_000
        );
    }

    #[test]
    fn url_uses_list_vs_stream_path_and_threads_page_token() {
        let list = chat_messages_url(
            "https://api.test",
            YouTubeChatTransport::List,
            "LC1",
            Some("tokA"),
        )
        .unwrap();
        assert_eq!(list.path(), LIVE_CHAT_MESSAGES_PATH);
        let query = list.query().unwrap();
        assert!(query.contains("liveChatId=LC1"));
        assert!(query.contains("part=snippet%2CauthorDetails"));
        assert!(query.contains("pageToken=tokA"));

        let stream = chat_messages_url(
            "https://api.test",
            YouTubeChatTransport::StreamList,
            "LC1",
            None,
        )
        .unwrap();
        assert_eq!(stream.path(), LIVE_CHAT_MESSAGES_STREAM_PATH);
        assert!(!stream.query().unwrap().contains("pageToken"));
    }

    /// YouTube accepts `token-1` for one page, then refuses it as expired;
    /// only `token-2` works after that (plan 055, B2).
    #[derive(Clone)]
    struct ExpiringYouTube {
        pages: Arc<std::sync::atomic::AtomicUsize>,
        refused: Arc<std::sync::atomic::AtomicUsize>,
    }

    fn text_item(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "snippet": {
                "type": "textMessageEvent",
                "liveChatId": "chat-1",
                "authorChannelId": "UC-viewer",
                "publishedAt": "2026-09-24T10:00:00Z",
                "hasDisplayContent": true,
                "displayMessage": text,
                "textMessageDetails": { "messageText": text }
            },
            "authorDetails": {
                "channelId": "UC-viewer",
                "displayName": "Viewer",
                "isChatOwner": false,
                "isChatSponsor": false,
                "isChatModerator": false
            }
        })
    }

    async fn expiring_messages(
        State(server): State<ExpiringYouTube>,
        headers: axum::http::HeaderMap,
    ) -> (StatusCode, Json<Value>) {
        use std::sync::atomic::Ordering;
        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .trim_start_matches("Bearer ")
            .to_string();
        let served = server.pages.load(Ordering::SeqCst);
        if token == "token-1" && served >= 1 {
            server.refused.fetch_add(1, Ordering::SeqCst);
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": { "errors": [{ "reason": "authError" }] } })),
            );
        }
        let page = server.pages.fetch_add(1, Ordering::SeqCst) + 1;
        (
            StatusCode::OK,
            Json(json!({
                "nextPageToken": format!("page-{page}"),
                "pollingIntervalMillis": 1000,
                "items": [text_item(&format!("m{page}"), &format!("message {page}"))]
            })),
        )
    }

    async fn spawn_expiring_youtube() -> (String, ExpiringYouTube) {
        let server = ExpiringYouTube {
            pages: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            refused: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(LIVE_CHAT_MESSAGES_STREAM_PATH, get(expiring_messages))
            .route(LIVE_CHAT_MESSAGES_PATH, get(expiring_messages))
            .with_state(server.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), server)
    }

    fn expiry_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        state
            .database
            .ensure_fake_live_chat_session("session-1")
            .unwrap();
        state
    }

    async fn start_expiring_connector(
        state: &AppState,
        base_url: String,
        token_source: crate::session_token::SessionTokenSource,
    ) -> tokio::task::JoinHandle<()> {
        let provider = crate::live_chat::LiveChatProviderState {
            id: "youtube".to_string(),
            platform: StreamPlatform::Youtube,
            target_id: Some("youtube".to_string()),
            account_id: None,
            account_label: None,
            read: crate::live_chat::CommentsReadState::Connecting,
            write: crate::live_chat::CommentsWriteState::Ready,
            state: LiveChatProviderConnectionState::Connecting,
            message: String::new(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        };
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("session-1".to_string(), vec![provider]);
            coordinator.session_generation()
        };
        tokio::spawn(run_youtube_chat_connector(
            state.clone(),
            "session-1".to_string(),
            session_generation,
            YouTubeChatConfig {
                access_token: "token-1".to_string(),
                live_chat_id: Some("chat-1".to_string()),
                broadcast_id: None,
                target_id: Some("youtube".to_string()),
                api_base_url: Some(base_url),
                token_source,
            },
        ))
    }

    async fn wait_for_provider(
        state: &AppState,
        done: impl Fn(&crate::live_chat::LiveChatSnapshot) -> bool,
    ) -> crate::live_chat::LiveChatSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let snapshot = crate::live_chat::current_status(state).await;
            if done(&snapshot) {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out: {snapshot:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn chat_keeps_polling_after_the_token_expires_mid_session() {
        let (base_url, server) = spawn_expiring_youtube().await;
        let state = expiry_state();
        let connector = start_expiring_connector(
            &state,
            base_url,
            crate::session_token::SessionTokenSource::scripted(vec![Ok("token-2")]),
        )
        .await;
        let snapshot = wait_for_provider(&state, |snapshot| snapshot.messages.len() >= 2).await;
        connector.abort();
        assert_eq!(
            snapshot
                .messages
                .iter()
                .map(|message| message.message_text.as_str())
                .collect::<Vec<_>>(),
            vec!["message 1", "message 2"]
        );
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Connected
        );
        assert_eq!(server.refused.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_revoked_youtube_sign_in_fails_clearly() {
        let (base_url, _server) = spawn_expiring_youtube().await;
        let state = expiry_state();
        let connector = start_expiring_connector(
            &state,
            base_url,
            crate::session_token::SessionTokenSource::scripted(vec![Err("revoked")]),
        )
        .await;
        let snapshot = wait_for_provider(&state, |snapshot| {
            snapshot.providers[0].state == LiveChatProviderConnectionState::Failed
        })
        .await;
        connector.abort();
        assert_eq!(snapshot.providers[0].message, YOUTUBE_SIGN_IN_EXPIRED);
        assert_eq!(snapshot.messages.len(), 1);
    }

    #[tokio::test]
    async fn resolve_live_chat_id_reads_snippet_from_broadcast() {
        async fn broadcasts() -> impl IntoResponse {
            Json(json!({ "items": [{ "snippet": { "liveChatId": "LCID-123" } }] }))
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/youtube/v3/liveBroadcasts", get(broadcasts)),
            )
            .await
            .unwrap();
        });

        let resolved = resolve_live_chat_id(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "token",
            "bcast-1",
        )
        .await
        .unwrap();
        assert_eq!(resolved.as_deref(), Some("LCID-123"));
    }

    #[tokio::test]
    async fn fetch_reconnect_resumes_from_stored_page_token() {
        // The mock records the pageToken it received so the test can assert the resume.
        type Seen = Arc<Mutex<Vec<String>>>;
        async fn messages(
            State(seen): State<Seen>,
            OriginalUri(uri): OriginalUri,
        ) -> impl IntoResponse {
            let query = uri.query().unwrap_or_default().to_string();
            seen.lock().unwrap().push(query.clone());
            let token = if query.contains("pageToken=resume-1") {
                "resume-2"
            } else {
                "resume-1"
            };
            Json(json!({ "nextPageToken": token, "pollingIntervalMillis": 1500, "items": [] }))
        }
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn({
            let seen = seen.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/youtube/v3/liveChat/messages/stream", get(messages))
                        .with_state(seen),
                )
                .await
                .unwrap();
            }
        });

        let client = reqwest::Client::new();
        let base_url = format!("http://{address}");
        let first = fetch_chat_page(
            &client,
            &base_url,
            "token",
            YouTubeChatTransport::StreamList,
            "LC1",
            None,
        )
        .await
        .unwrap();
        assert_eq!(first.next_page_token.as_deref(), Some("resume-1"));

        let second = fetch_chat_page(
            &client,
            &base_url,
            "token",
            YouTubeChatTransport::StreamList,
            "LC1",
            first.next_page_token.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(second.next_page_token.as_deref(), Some("resume-2"));

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(!seen[0].contains("pageToken"));
        assert!(seen[1].contains("pageToken=resume-1"));
    }

    #[tokio::test]
    async fn disabled_chat_is_classified_not_a_hard_error() {
        async fn forbidden() -> impl IntoResponse {
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": { "errors": [{ "reason": "liveChatDisabled" }] } })),
            )
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/youtube/v3/liveChat/messages/stream", get(forbidden)),
            )
            .await
            .unwrap();
        });

        let error = fetch_chat_page(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "token",
            YouTubeChatTransport::StreamList,
            "LC1",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error, FetchError::Api(YouTubeChatErrorKind::Disabled));
    }

    /// Plan 094: page 1 flows, page 2 answers `quotaExceeded`. The reader
    /// parks as `Waiting` with `retryAt`, spends nothing while paused, and
    /// resumes from its page token when the breaker clears.
    #[derive(Clone)]
    struct QuotaYouTube {
        hits: Arc<Mutex<Vec<String>>>,
    }

    async fn quota_messages(
        State(server): State<QuotaYouTube>,
        OriginalUri(uri): OriginalUri,
    ) -> (StatusCode, Json<Value>) {
        let query = uri.query().unwrap_or_default().to_string();
        let served = {
            let mut hits = server.hits.lock().unwrap();
            hits.push(query.clone());
            hits.len()
        };
        match served {
            1 => (
                StatusCode::OK,
                Json(json!({
                    "nextPageToken": "page-1",
                    "pollingIntervalMillis": 1000,
                    "items": [text_item("m1", "message 1")]
                })),
            ),
            2 => (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": { "errors": [{
                    "reason": "quotaExceeded", "domain": "youtube.quota"
                }] } })),
            ),
            _ => (
                StatusCode::OK,
                Json(json!({
                    "nextPageToken": "page-2",
                    "pollingIntervalMillis": 1000,
                    "items": [text_item("m2", "message 2")]
                })),
            ),
        }
    }

    #[tokio::test]
    async fn a_quota_refusal_parks_chat_as_waiting_and_resumes_from_its_page_token() {
        let server = QuotaYouTube {
            hits: Arc::new(Mutex::new(Vec::new())),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(LIVE_CHAT_MESSAGES_PATH, get(quota_messages))
            .with_state(server.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let state = expiry_state();
        let connector = start_expiring_connector(
            &state,
            format!("http://{address}"),
            crate::session_token::SessionTokenSource::scripted(vec![]),
        )
        .await;

        // Page 1 arrives, then (after the 5 s floor) page 2 is the quota refusal.
        let snapshot = wait_for_provider_within(&state, Duration::from_secs(12), |snapshot| {
            snapshot.providers[0].state == LiveChatProviderConnectionState::Waiting
        })
        .await;
        let provider = &snapshot.providers[0];
        assert_eq!(provider.message, crate::youtube_quota::CHAT_PAUSED_MESSAGE);
        let paused_until = crate::youtube_quota::paused_until(&state).expect("breaker set");
        assert_eq!(
            provider.retry_at.as_deref(),
            Some(paused_until.to_rfc3339().as_str())
        );
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(server.hits.lock().unwrap().len(), 2);

        // Parked: no request goes out while the breaker is set.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            server.hits.lock().unwrap().len(),
            2,
            "zero requests while paused"
        );

        // The breaker clears (the probe would do this): chat resumes with the
        // page token it held, with no click.
        crate::youtube_quota::clear_for_tests(&state);
        let snapshot = wait_for_provider(&state, |snapshot| snapshot.messages.len() >= 2).await;
        connector.abort();
        assert_eq!(snapshot.messages[1].message_text, "message 2");
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Connected
        );
        assert_eq!(snapshot.providers[0].retry_at, None);
        let hits = server.hits.lock().unwrap().clone();
        assert_eq!(hits.len(), 3);
        assert!(hits[1].contains("pageToken=page-1"), "{hits:?}");
        assert!(
            hits[2].contains("pageToken=page-1"),
            "resumed from the held token: {hits:?}"
        );
        let usage = crate::youtube_quota::usage_snapshot(&state);
        assert_eq!(usage.total_calls, 3);
        assert_eq!(usage.total_units, 3);
    }

    async fn wait_for_provider_within(
        state: &AppState,
        within: Duration,
        done: impl Fn(&crate::live_chat::LiveChatSnapshot) -> bool,
    ) -> crate::live_chat::LiveChatSnapshot {
        let deadline = std::time::Instant::now() + within;
        loop {
            let snapshot = crate::live_chat::current_status(state).await;
            if done(&snapshot) {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out: {snapshot:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn a_paused_breaker_refuses_the_send_without_a_request() {
        let captured = Arc::new(Mutex::new(None));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .fallback(capture_send)
            .with_state(captured.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let state = expiry_state();
        crate::youtube_quota::record_quota_exhausted(&state, "test");
        let error = send_youtube_chat_message_guarded(
            &state,
            &reqwest::Client::new(),
            Some(&format!("http://{address}")),
            "token-1",
            "chat-1",
            "hello",
        )
        .await
        .unwrap_err();
        assert_eq!(error, crate::youtube_quota::SEND_PAUSED_MESSAGE);
        assert!(
            captured.lock().unwrap().is_none(),
            "no request while paused"
        );
        assert_eq!(crate::youtube_quota::usage_snapshot(&state).total_calls, 0);
    }

    #[tokio::test]
    async fn a_quota_refusal_on_send_sets_the_breaker() {
        let base = spawn_send_server(
            StatusCode::FORBIDDEN,
            json!({ "error": { "errors": [{ "reason": "quotaExceeded", "domain": "youtube.quota" }] } }),
        )
        .await;
        let state = expiry_state();
        let error = send_youtube_chat_message_guarded(
            &state,
            &reqwest::Client::new(),
            Some(&base),
            "token-1",
            "chat-1",
            "hello",
        )
        .await
        .unwrap_err();
        assert_eq!(error, crate::youtube_quota::SEND_PAUSED_MESSAGE);
        assert!(crate::youtube_quota::paused_until(&state).is_some());
        assert_eq!(crate::youtube_quota::usage_snapshot(&state).sends.units, 50);
    }
}
