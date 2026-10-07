//! In-app live chat — capability + scope audit (Slice 1 of the In-App Livestream Comments
//! plan: `2026-06-06 - Videorc In-App Livestream Comments Plan`). Reports, per streaming
//! platform, whether the connected account can read live chat, needs to reconnect for a
//! missing scope, or has no verified native chat path. The `LiveChatCoordinator` and the
//! per-platform connectors arrive in later slices; this is the capability the Studio UI
//! uses to warn the streamer before they go live.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep, timeout};

use crate::live_chat_persistence::LiveChatPersistenceFailure;
use crate::state::AppState;
use crate::streaming::{PlatformAccount, StreamPlatform, stream_platform_id};

// --- Live chat shared data model (slice 2) ---

/// Runtime connection state of one platform's chat connector.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveChatProviderConnectionState {
    Disabled,
    Connecting,
    Connected,
    Reconnecting,
    Waiting,
    Failed,
    Unsupported,
    Ended,
}

/// Read capability for one concrete stream destination. This is intentionally
/// separate from the connector lifecycle above: a target can be readable while
/// writes are unavailable (X), or writable only after an OAuth scope refresh.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsReadState {
    Connecting,
    Ready,
    WaitingForBroadcastContext,
    Ended,
    Failed,
    Unavailable,
}

/// Write capability for one concrete stream destination.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsWriteState {
    Ready,
    MissingScope,
    ReadOnly,
    Failed,
    Unavailable,
}

/// Whether Videorc can remove a viewer's message on this destination (plan
/// 140 S4): the optional moderation scopes, the X Live credentials, and the
/// YouTube quota pause. Absent when no account is connected.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsModerateState {
    Ready,
    /// Reconnect (or authorize X Live) to grant the moderation permission.
    MissingScope,
    /// The platform has no way to remove messages from Videorc.
    Unsupported,
    /// YouTube calls are paused by the quota breaker.
    Paused,
}

/// What kind of chat row a message is — drives special styling for monetized/system events.
// Message-level types are constructed by the platform connectors (slices 4+); this slice
// only defines the shared model + serialization.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveChatEventType {
    Message,
    Paid,
    Membership,
    System,
    Deleted,
    Moderation,
    /// A new follower (Twitch `channel.follow`, only with the opt-in scope).
    /// The Stream Manager lists it under Activity and never in chat.
    Follow,
    /// A Twitch Power-up paid with bits (`channel.bits.use`, plan 162).
    /// Activity only, like a follow: a gigantified emote's own chat message
    /// stays an ordinary chat row.
    PowerUp,
    /// A Twitch channel point redemption (plan 162). Activity only.
    Redemption,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatProviderState {
    /// Stable destination identity. Never use platform alone as a registry key.
    pub id: String,
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub read: CommentsReadState,
    pub write: CommentsWriteState,
    /// "Remove messages" readiness (plan 140 S4), next to `write`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moderate: Option<CommentsModerateState>,
    pub state: LiveChatProviderConnectionState,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// While `state` is `Waiting` for a known reason with a known end (the
    /// YouTube quota pause, plan 094): when the connector resumes, RFC 3339.
    /// Absent otherwise; the renderer formats it in local time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

/// A rich-text fragment of a message (plain text, emote, mention, …) for faithful rendering.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LiveChatMessageFragment {
    #[serde(rename = "type")]
    pub fragment_type: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// A 7TV zero-width emote (plan 089): drawn on top of the emote before it.
    /// Omitted when false, so every other fragment serializes as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub zero_width: bool,
}

/// Structured facts of a monetized or community event (plan 055). `None` on a
/// plain chat message. Every optional field is skipped when absent: a
/// serialized `null` has broken app load before.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LiveChatEventDetails {
    /// YouTube Super Chat; `amount_micros` is in micros of `currency`.
    #[serde(rename_all = "camelCase")]
    SuperChat {
        amount_micros: u64,
        currency: String,
        amount_display: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tier: Option<u32>,
    },
    /// YouTube Super Sticker.
    #[serde(rename_all = "camelCase")]
    SuperSticker {
        amount_micros: u64,
        currency: String,
        amount_display: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alt_text: Option<String>,
    },
    /// A YouTube membership event.
    #[serde(rename_all = "camelCase")]
    Membership {
        membership: MembershipKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        months: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gift_count: Option<u32>,
    },
    /// A Twitch subscription notice. `months` is the cumulative total for a
    /// resub; `tier` is Twitch's `1000`/`2000`/`3000`.
    #[serde(rename_all = "camelCase")]
    Subscription {
        subscription: SubscriptionKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tier: Option<String>,
        #[serde(default)]
        is_prime: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        months: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        streak_months: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gift_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recipient_name: Option<String>,
        /// Ties a community gift to the single gifts Twitch also sends for
        /// it, so the Activity pane counts the gift once.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        community_gift_id: Option<String>,
    },
    /// Twitch bits.
    Cheer { bits: u64 },
    /// Kick KICKs (Kick's own gift currency, plan 066); `amount` is in KICKs
    /// and `gift_name` is the gift's name ("Rage Quit").
    #[serde(rename_all = "camelCase")]
    Kicks {
        amount: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gift_name: Option<String>,
    },
    /// A Twitch raid; the author is the raiding channel.
    #[serde(rename_all = "camelCase")]
    Raid { viewer_count: u64 },
    /// A Twitch announcement.
    Announcement {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    /// A Twitch watch streak (plan 151): the viewer watched `streak_count`
    /// streams in a row. `channel_points_awarded` is what Twitch gave them
    /// for it; kept on the wire, not shown.
    #[serde(rename_all = "camelCase")]
    WatchStreak {
        streak_count: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_points_awarded: Option<u64>,
    },
    /// A Twitch Power-up paid with bits (plan 162). `emote_name` is the
    /// gigantified emote, when there is one.
    #[serde(rename_all = "camelCase")]
    PowerUp {
        bits: u64,
        power_up: PowerUpKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emote_name: Option<String>,
    },
    /// A Twitch channel point redemption (plan 162). `title` is a custom
    /// reward's title; automatic rewards have none and the window names them.
    /// `emote_name` is the emote an automatic reward unlocked.
    #[serde(rename_all = "camelCase")]
    Redemption {
        reward: RedemptionKind,
        channel_points: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emote_name: Option<String>,
    },
    /// A new follower. `handle` is the @-mentionable login (Twitch
    /// `user_login`, X and Kick `username`) when it differs from, or is
    /// missing from, the display name (plan 071, S5).
    Follow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        handle: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MembershipKind {
    New,
    Upgrade,
    Milestone,
    Gift,
    GiftReceived,
}

/// Which Twitch Power-up a viewer paid bits for (`channel.bits.use`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PowerUpKind {
    Celebration,
    GigantifyAnEmote,
    MessageEffect,
    /// A Power-up the channel made itself (`custom_power_up`).
    Custom,
}

/// Which channel point reward a viewer redeemed: the channel's own custom
/// reward, or one of Twitch's automatic rewards.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RedemptionKind {
    Custom,
    HighlightedMessage,
    SubOnlyMessage,
    RandomEmoteUnlock,
    ChosenEmoteUnlock,
    ModifiedEmoteUnlock,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubscriptionKind {
    Sub,
    Resub,
    SubGift,
    CommunitySubGift,
    GiftPaidUpgrade,
    PrimePaidUpgrade,
    PayItForward,
}

/// The message a chat message replies to, when the platform threads replies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatReply {
    pub parent_message_id: String,
    pub parent_author_name: String,
    pub parent_text: String,
}

/// The organization badge a platform shows next to an affiliated author's
/// name: X's affiliation (a Verified Organization's logo, plan 086).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatAuthorAffiliation {
    /// An `https://` image URL; a badge without one is never kept.
    pub badge_url: String,
    /// The organization's name, e.g. "Neon".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The organization's profile URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LiveChatMessage {
    /// Stable app id, `{platform}:{providerMessageId}` — the de-duplication key.
    pub id: String,
    pub provider_message_id: String,
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    pub author_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    #[serde(default)]
    pub author_badges: Vec<String>,
    /// The organization badge next to the author's name (X affiliation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_affiliation: Option<LiveChatAuthorAffiliation>,
    #[serde(default)]
    pub author_roles: Vec<String>,
    pub published_at: String,
    pub received_at: String,
    pub message_text: String,
    #[serde(default)]
    pub fragments: Vec<LiveChatMessageFragment>,
    pub event_type: LiveChatEventType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_text: Option<String>,
    #[serde(default)]
    pub is_deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_provider_type: Option<String>,
    /// Structured event facts (plan 055); `None` for plain chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<LiveChatEventDetails>,
    /// The message this one replies to, when the platform threads replies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<LiveChatReply>,
    /// The author's first message in the channel: Twitch's own first-chat
    /// intro, or the first message from an author no earlier session saw.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub first_message: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub providers: Vec<LiveChatProviderState>,
    pub messages: Vec<LiveChatMessage>,
    pub unread_count: u64,
    pub updated_at: String,
}

/// The stable app id for a message. Provider ids are not globally unique, so
/// session and destination identity are part of the persisted de-dup key.
#[allow(dead_code)]
pub fn live_chat_message_id(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
    provider_message_id: &str,
) -> String {
    format!(
        "{}:{}:{}:{}",
        session_id,
        stream_platform_id(platform),
        target_id.unwrap_or("default"),
        provider_message_id
    )
}

pub(crate) fn comments_destination_id(platform: StreamPlatform, target_id: Option<&str>) -> String {
    target_id
        .map(str::to_string)
        .unwrap_or_else(|| stream_platform_id(platform).to_string())
}

/// Build the initial Live Chat snapshot for setup time (no session running): one provider
/// row per native platform derived from its chat capability, with no messages yet. The
/// LiveChatCoordinator replaces this with live connector state once Go Live starts.
pub fn initial_chat_snapshot(accounts: &[PlatformAccount], updated_at: String) -> LiveChatSnapshot {
    let providers = chat_capabilities(accounts)
        .into_iter()
        .map(provider_state_from_capability)
        .collect();
    LiveChatSnapshot {
        session_id: None,
        providers,
        messages: Vec::new(),
        unread_count: 0,
        updated_at,
    }
}

/// Map a setup-time capability to a provider row. No connector is running yet, so a
/// capable/connected platform is `Disabled` (idle) and platforms with no native path are
/// `Unsupported`; the human-readable readiness lives in `message` + `capabilities`.
fn provider_state_from_capability(capability: ChatCapability) -> LiveChatProviderState {
    let state = match capability.state {
        ChatCapabilityState::Unsupported => LiveChatProviderConnectionState::Unsupported,
        ChatCapabilityState::Available
        | ChatCapabilityState::NeedsReconnect
        | ChatCapabilityState::NotConnected => LiveChatProviderConnectionState::Disabled,
    };
    LiveChatProviderState {
        id: comments_destination_id(capability.platform, None),
        platform: capability.platform,
        target_id: None,
        account_id: capability.account_id,
        account_label: capability.account_label,
        read: capability.read,
        write: capability.write,
        moderate: capability.moderate,
        state,
        message: capability.message,
        last_connected_at: None,
        last_message_at: None,
        last_error: None,
        retry_at: None,
    }
}

/// The OAuth scope each platform needs to READ live chat.
///
/// YouTube's `youtube.force-ssl` (the one scope Videorc requests, approved by
/// Google 2026-09-30) covers live chat reads and sends. Twitch needs
/// `user:read:chat`, which is added to the OAuth config in the Twitch
/// connector slice — until an account is reconnected with it, Twitch chat
/// reports needs-reconnect.
pub const YOUTUBE_CHAT_SCOPE: &str = "https://www.googleapis.com/auth/youtube.force-ssl";
pub const TWITCH_CHAT_SCOPE: &str = "user:read:chat";
pub const TWITCH_CHAT_WRITE_SCOPE: &str = "user:write:chat";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChatCapabilityState {
    /// A connected account holds the scope needed to read chat.
    Available,
    /// Connected, but the granted scopes are missing the chat-read scope — reconnect needed.
    NeedsReconnect,
    /// No connected account for this platform.
    NotConnected,
    /// No verified native chat-read path (X pending API access, Custom RTMP).
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatCapability {
    pub platform: StreamPlatform,
    pub state: ChatCapabilityState,
    pub read: CommentsReadState,
    pub write: CommentsWriteState,
    /// "Remove messages" readiness (plan 140 S4); absent without an account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moderate: Option<CommentsModerateState>,
    /// True only when chat can actually be read right now.
    pub chat_read_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub message: String,
}

/// Capability to read live chat for one platform, given its connected account (if any).
pub fn chat_capability(
    platform: StreamPlatform,
    account: Option<&PlatformAccount>,
) -> ChatCapability {
    match platform {
        StreamPlatform::Youtube => {
            let mut capability = scope_capability(
                platform,
                account,
                YOUTUBE_CHAT_SCOPE,
                "YouTube live comments are ready.",
                "Reconnect YouTube to enable live comments.",
                "Connect YouTube to read live comments.",
            );
            // The same scope covers liveChatMessages.insert, so reading and
            // sending are granted together.
            capability.write = match capability.state {
                ChatCapabilityState::Available => CommentsWriteState::Ready,
                ChatCapabilityState::NeedsReconnect => CommentsWriteState::MissingScope,
                ChatCapabilityState::NotConnected | ChatCapabilityState::Unsupported => {
                    CommentsWriteState::Unavailable
                }
            };
            // `force-ssl` also covers liveChatMessages.delete (plan 140).
            capability.moderate = match capability.state {
                ChatCapabilityState::Available => Some(CommentsModerateState::Ready),
                ChatCapabilityState::NeedsReconnect => Some(CommentsModerateState::MissingScope),
                ChatCapabilityState::NotConnected | ChatCapabilityState::Unsupported => None,
            };
            capability
        }
        StreamPlatform::Twitch => {
            let mut capability = scope_capability(
                platform,
                account,
                TWITCH_CHAT_SCOPE,
                "Twitch live comments are ready.",
                "Reconnect Twitch to enable live comments.",
                "Connect Twitch to read live comments.",
            );
            capability.write = match account {
                Some(account)
                    if account.status == crate::streaming::PlatformAccountStatus::Connected
                        && account
                            .scopes
                            .iter()
                            .any(|scope| scope == TWITCH_CHAT_WRITE_SCOPE) =>
                {
                    CommentsWriteState::Ready
                }
                Some(_) => CommentsWriteState::MissingScope,
                None => CommentsWriteState::Unavailable,
            };
            capability.moderate =
                moderate_state_for_scope(account, crate::twitch_chat::TWITCH_CHAT_MODERATE_SCOPE);
            capability
        }
        StreamPlatform::X => {
            let x_live_ready = account.is_some_and(|account| {
                account.status == crate::streaming::PlatformAccountStatus::Connected
            }) && crate::x_live::x_livestream_credentials()
                .ok()
                .flatten()
                .is_some();
            ChatCapability {
                platform,
                state: if x_live_ready {
                    ChatCapabilityState::Available
                } else {
                    ChatCapabilityState::NotConnected
                },
                chat_read_available: x_live_ready,
                read: if x_live_ready {
                    CommentsReadState::Ready
                } else {
                    CommentsReadState::Unavailable
                },
                write: if x_live_ready {
                    // POST /2/broadcasts/:id/chat accepts the OAuth 1.0a user
                    // context we already hold (closed-beta Livestream API).
                    CommentsWriteState::Ready
                } else {
                    CommentsWriteState::ReadOnly
                },
                // The same credentials sign DELETE .../chat/{id} (plan 140);
                // without them "Authorize X Live" is the fix, like a scope.
                moderate: if x_live_ready {
                    Some(CommentsModerateState::Ready)
                } else if account.is_some() {
                    Some(CommentsModerateState::MissingScope)
                } else {
                    None
                },
                required_scope: None,
                account_id: account.map(|account| account.account_id.clone()),
                account_label: account.map(|account| account.account_label.clone()),
                message: crate::x_chat::x_chat_message(x_live_ready).to_string(),
            }
        }
        // Kick chat is read through the videorc-web relay (webhooks need a
        // public endpoint) and sent straight to Kick (plan 063, S5).
        StreamPlatform::Kick => {
            let mut capability = scope_capability(
                platform,
                account,
                crate::kick_chat::KICK_EVENTS_SCOPE,
                "Kick live comments are ready.",
                "Reconnect Kick to enable live comments.",
                "Connect Kick to read live comments.",
            );
            capability.write = match account {
                Some(account)
                    if account.status == crate::streaming::PlatformAccountStatus::Connected
                        && account
                            .scopes
                            .iter()
                            .any(|scope| scope == crate::kick_chat::KICK_CHAT_WRITE_SCOPE) =>
                {
                    CommentsWriteState::Ready
                }
                Some(_) => CommentsWriteState::MissingScope,
                None => CommentsWriteState::Unavailable,
            };
            capability.moderate =
                moderate_state_for_scope(account, crate::kick_chat::KICK_CHAT_MODERATE_SCOPE);
            capability
        }
        StreamPlatform::Tiktok | StreamPlatform::Instagram => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
            moderate: Some(CommentsModerateState::Unsupported),
            chat_read_available: false,
            required_scope: None,
            account_id: None,
            account_label: None,
            message: format!(
                "{} has no public comments API. Watch chat in their app while you stream.",
                crate::streaming::stream_platform_label(platform)
            ),
        },
        StreamPlatform::Custom => ChatCapability {
            platform,
            state: ChatCapabilityState::Unsupported,
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
            moderate: Some(CommentsModerateState::Unsupported),
            chat_read_available: false,
            required_scope: None,
            account_id: None,
            account_label: None,
            message: "Comments are not available for this destination yet.".to_string(),
        },
    }
}

/// "Remove messages" readiness for a platform whose delete needs an optional
/// OAuth scope (Twitch, Kick): `missing-scope` is the honest default until the
/// account reconnects with it (plan 140 S5 adds it to the connect flows).
fn moderate_state_for_scope(
    account: Option<&PlatformAccount>,
    moderate_scope: &str,
) -> Option<CommentsModerateState> {
    match account {
        Some(account)
            if account.status == crate::streaming::PlatformAccountStatus::Connected
                && account.scopes.iter().any(|scope| scope == moderate_scope) =>
        {
            Some(CommentsModerateState::Ready)
        }
        Some(_) => Some(CommentsModerateState::MissingScope),
        None => None,
    }
}

fn scope_capability(
    platform: StreamPlatform,
    account: Option<&PlatformAccount>,
    required_scope: &str,
    available_message: &str,
    reconnect_message: &str,
    not_connected_message: &str,
) -> ChatCapability {
    match account {
        None => ChatCapability {
            platform,
            state: ChatCapabilityState::NotConnected,
            read: CommentsReadState::Unavailable,
            write: CommentsWriteState::Unavailable,
            moderate: None,
            chat_read_available: false,
            required_scope: Some(required_scope.to_string()),
            account_id: None,
            account_label: None,
            message: not_connected_message.to_string(),
        },
        Some(account) if account.status != crate::streaming::PlatformAccountStatus::Connected => {
            ChatCapability {
                platform,
                state: ChatCapabilityState::NeedsReconnect,
                read: CommentsReadState::Unavailable,
                write: CommentsWriteState::MissingScope,
                moderate: None,
                chat_read_available: false,
                required_scope: Some(required_scope.to_string()),
                account_id: Some(account.account_id.clone()),
                account_label: Some(account.account_label.clone()),
                message: reconnect_message.to_string(),
            }
        }
        Some(account) => {
            let has_scope = account.scopes.iter().any(|scope| scope == required_scope);
            ChatCapability {
                platform,
                state: if has_scope {
                    ChatCapabilityState::Available
                } else {
                    ChatCapabilityState::NeedsReconnect
                },
                chat_read_available: has_scope,
                read: if has_scope {
                    CommentsReadState::Ready
                } else {
                    CommentsReadState::Unavailable
                },
                write: CommentsWriteState::Unavailable,
                moderate: None,
                required_scope: Some(required_scope.to_string()),
                account_id: Some(account.account_id.clone()),
                account_label: Some(account.account_label.clone()),
                message: if has_scope {
                    available_message
                } else {
                    reconnect_message
                }
                .to_string(),
            }
        }
    }
}

/// Chat capability for every native platform (YouTube, Twitch, X, Kick), preferring a connected
/// account over stale saved rows. Custom RTMP has no platform comments and is omitted.
pub fn chat_capabilities(accounts: &[PlatformAccount]) -> Vec<ChatCapability> {
    chat_capabilities_with_quota(accounts, false)
}

/// Like [`chat_capabilities`], with the YouTube quota breaker folded into the
/// "Remove messages" readiness (plan 140 S4): while YouTube is paused, a
/// ready YouTube destination reports `paused`.
pub fn chat_capabilities_with_quota(
    accounts: &[PlatformAccount],
    youtube_paused: bool,
) -> Vec<ChatCapability> {
    [
        StreamPlatform::Youtube,
        StreamPlatform::Twitch,
        StreamPlatform::X,
        StreamPlatform::Kick,
    ]
    .into_iter()
    .map(|platform| {
        let account = accounts
            .iter()
            .find(|account| {
                account.platform == platform
                    && account.status == crate::streaming::PlatformAccountStatus::Connected
            })
            .or_else(|| accounts.iter().find(|account| account.platform == platform));
        let mut capability = chat_capability(platform, account);
        if youtube_paused
            && platform == StreamPlatform::Youtube
            && capability.moderate == Some(CommentsModerateState::Ready)
        {
            capability.moderate = Some(CommentsModerateState::Paused);
        }
        capability
    })
    .collect()
}

// --- Live chat coordinator (slice 3) ---

/// Default cap on the in-memory message buffer for one active chat session.
pub const DEFAULT_MAX_CHAT_MESSAGES: usize = 5_000;

/// Shared, lockable handle to the live-chat coordinator owned by `AppState`.
pub type LiveChatSlot = Arc<tokio::sync::Mutex<LiveChatCoordinator>>;

/// Outcome of ingesting one message into the bounded, de-duplicated buffer.
///
/// New and updated outcomes carry the authoritative buffered value so callers
/// can persist and emit it without scanning the full message deque again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    /// A new message was buffered (the caller should emit it to the renderer).
    New(LiveChatMessage),
    /// An existing message was replaced by a provider tombstone.
    Updated(LiveChatMessage),
    /// The message id was already present and was skipped.
    Duplicate,
}

/// Point-in-time diagnostics for the active chat session (slice 9): per-provider connection
/// state + last error (carried on the provider rows) plus session counters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatDiagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub providers: Vec<LiveChatProviderState>,
    pub messages_received: u64,
    pub duplicates_skipped: u64,
    pub messages_trimmed: u64,
    pub reconnect_count: u64,
    pub buffered: u64,
    pub unread_count: u64,
}

/// Owns the active chat session's provider rows, a bounded + de-duplicated message buffer,
/// connector task handles, and lightweight diagnostics counters.
///
/// The coordinator is pure state: it never touches the websocket itself. The runtime
/// functions below lock it, mutate, drop the guard, and emit through `AppState`. Keeping
/// emission out of the coordinator makes the buffer/de-dup/lifecycle logic unit-testable
/// with no running backend.
/// Per-platform send credentials, captured at `liveChat.start` and dropped at
/// stop (Comments upgrade S4). YouTube's live chat id is resolved later by
/// its connector and filled in via `set_youtube_send_chat_id`.
#[derive(Debug, Clone)]
pub enum ChatSenderConfig {
    YouTube {
        access_token: String,
        api_base_url: Option<String>,
        live_chat_id: Option<String>,
        /// Sends hours into a stream refresh through the stored account (B2).
        token_source: crate::session_token::SessionTokenSource,
    },
    Twitch(crate::twitch_chat::TwitchChatSenderConfig),
    Kick(crate::kick_chat::KickChatSenderConfig),
    /// X live-broadcast chat (closed-beta Livestream API). Credentials are
    /// resolved per send so a rotated token is picked up without restarting
    /// the session.
    X {
        broadcast_id: String,
    },
    Fake(FakeChatSendBehavior),
    /// A fake destination with a scripted removal outcome (plan 140 S9).
    FakeModerated {
        send: FakeChatSendBehavior,
        delete: FakeChatDeleteBehavior,
    },
    #[cfg(test)]
    FakeProbe {
        behavior: FakeChatSendBehavior,
        probe: Arc<FakeSendProbe>,
        delay: Duration,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsSendParams {
    pub operation_id: String,
    pub session_id: String,
    pub text: String,
    /// Co-host reply: the open question this send answers. On a terminal
    /// `sent`/`partial` phase the engine clears it. Not persisted with the
    /// operation.
    #[serde(default)]
    pub in_reply_to_question_id: Option<String>,
    /// Send only to these providers (Stream Manager's "Send to" picker, plan
    /// 055 S10). Absent sends to every provider, as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommentsSendOperationPhase {
    Sending,
    Sent,
    Partial,
    Failed,
    DeliveryUnknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationDeliveryPhase {
    Pending,
    Sent,
    Failed,
    ReadOnly,
    Unavailable,
    TimedOutUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationDelivery {
    pub destination_id: String,
    pub platform: StreamPlatform,
    pub phase: DestinationDeliveryPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentsSendOperation {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub phase: CommentsSendOperationPhase,
    pub destinations: Vec<DestinationDelivery>,
    pub created_at: String,
    pub updated_at: String,
}

type SendOperationResult = Result<CommentsSendOperation, String>;
type SendOperationReceiver = tokio::sync::watch::Receiver<Option<SendOperationResult>>;

struct InFlightSendOperation {
    session_id: String,
    text: String,
    result: SendOperationReceiver,
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct FakeSendProbe {
    calls: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
}

#[cfg(test)]
impl FakeSendProbe {
    fn begin(self: &Arc<Self>) -> FakeSendProbeGuard {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        FakeSendProbeGuard(self.clone())
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn max_active(&self) -> usize {
        self.max_active.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
struct FakeSendProbeGuard(Arc<FakeSendProbe>);

#[cfg(test)]
impl Drop for FakeSendProbeGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl CommentsSendOperation {
    /// Crash recovery is deliberately non-retrying: a provider may have
    /// accepted an interrupted request even though Videorc never saw the ack.
    pub fn mark_interrupted_unknown(&mut self, now: String) {
        for delivery in &mut self.destinations {
            if delivery.phase == DestinationDeliveryPhase::Pending {
                delivery.phase = DestinationDeliveryPhase::TimedOutUnknown;
                delivery.reason = Some("interrupted-before-confirmation".to_string());
            }
        }
        self.phase = aggregate_send_phase(&self.destinations);
        self.updated_at = now;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSendReceipt {
    pub provider_message_id: Option<String>,
}

pub struct LiveChatCoordinator {
    session_id: Option<String>,
    /// Monotonic lifecycle ticket. Provider deliveries capture it before
    /// persistence and must still own it before emitting into the renderer.
    generation: u64,
    /// Connector ownership ticket. Unlike `generation`, this remains stable
    /// when only the local transcript view is cleared.
    session_generation: u64,
    providers: Vec<LiveChatProviderState>,
    messages: VecDeque<LiveChatMessage>,
    /// Ids currently in `messages` — the de-duplication set, kept in lock-step with the
    /// buffer (trimming a message drops its id) so it stays bounded.
    seen: HashSet<String>,
    unread_count: u64,
    max_messages: usize,
    /// Diagnostics (surfaced in slice 9; counted from the start so the cap is testable now).
    trimmed_count: u64,
    duplicates_skipped: u64,
    messages_received: u64,
    reconnect_count: u64,
    /// Running connector tasks, aborted on stop/restart.
    tasks: Vec<JoinHandle<()>>,
    /// Send credentials per concrete destination; session-scoped.
    senders: HashMap<String, ChatSenderConfig>,
    /// Same-id callers subscribe to one backend-owned operation task. The receiver is
    /// removed after terminal persistence; SQLite remains the durable idempotency
    /// authority afterward.
    send_operations_in_flight: HashMap<String, InFlightSendOperation>,
    /// `platform:author_id` of every chatter this session already checked for
    /// the first-time marker (plan 055). Reset per session, not by Clear view.
    chatters_seen: HashSet<String>,
    /// The session's 7TV emotes per platform (plan 089). The loader swaps
    /// the whole map; delivery clones the `Arc` and matches outside the lock.
    seventv_indexes: Arc<crate::seventv::SevenTvIndexes>,
    /// Where the 7TV loader sends requests. `None` turns 7TV off; unit tests
    /// start that way so they never reach the network.
    seventv_endpoint: Option<String>,
    /// The session's 7TV loader, kept apart from the connectors so the
    /// Settings switch can stop it alone. Aborted with them on stop.
    seventv_task: Option<JoinHandle<()>>,
    /// What Settings shows: the last 7TV outcome in this app run. Outlives
    /// sessions, so "Loads when you go live" only shows before the first.
    seventv_status: crate::seventv::SevenTvStatus,
}

/// Minimal authoritative answer needed at the comment-card commit edge. Do
/// not clone the full 5,000-row chat snapshot (or even one rich message) while
/// the bounded highlight fence is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HighlightMessageEligibility {
    Eligible,
    WrongSession,
    Missing,
    Ineligible,
}

struct ReversibleIngest {
    outcome: IngestOutcome,
    undo: LiveChatIngestUndo,
}

/// Constant-size undo data for one coordinator ingest. A delivery failure must
/// never clone the complete (normally 5,000-row) transcript merely to make one
/// provider message retryable.
enum LiveChatIngestUndo {
    Duplicate {
        previous_duplicates_skipped: u64,
    },
    Updated {
        index: usize,
        previous: Box<LiveChatMessage>,
        applied: Box<LiveChatMessage>,
    },
    New {
        inserted_id: String,
        inserted_received_at: String,
        trimmed: Option<Box<LiveChatMessage>>,
        provider_update: Option<(usize, Option<String>)>,
        previous_unread_count: u64,
        previous_trimmed_count: u64,
        previous_messages_received: u64,
    },
}

#[cfg(test)]
impl LiveChatIngestUndo {
    /// Regression metric for rollback space complexity. This count is bounded by
    /// the one ingest being reversed, never by the transcript capacity.
    fn retained_buffer_rows(&self) -> usize {
        match self {
            Self::Duplicate { .. } => 0,
            Self::Updated { .. } => 2,
            Self::New { trimmed, .. } => usize::from(trimmed.is_some()),
        }
    }
}

impl Default for LiveChatCoordinator {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CHAT_MESSAGES)
    }
}

impl LiveChatCoordinator {
    pub fn new(max_messages: usize) -> Self {
        Self {
            session_id: None,
            generation: 0,
            session_generation: 0,
            providers: Vec::new(),
            messages: VecDeque::new(),
            seen: HashSet::new(),
            unread_count: 0,
            max_messages: max_messages.max(1),
            trimmed_count: 0,
            duplicates_skipped: 0,
            messages_received: 0,
            reconnect_count: 0,
            tasks: Vec::new(),
            senders: HashMap::new(),
            send_operations_in_flight: HashMap::new(),
            chatters_seen: HashSet::new(),
            seventv_indexes: Arc::default(),
            seventv_endpoint: (!cfg!(test)).then(|| crate::seventv::SEVENTV_GQL_URL.to_string()),
            seventv_task: None,
            seventv_status: crate::seventv::SevenTvStatus::default(),
        }
    }

    pub fn register_sender(&mut self, destination_id: String, sender: ChatSenderConfig) {
        self.senders.insert(destination_id, sender);
    }

    /// Whether this session sends to Kick (its subscriptions are in use).
    pub fn has_kick_sender(&self) -> bool {
        self.session_id.is_some()
            && self
                .senders
                .values()
                .any(|sender| matches!(sender, ChatSenderConfig::Kick(_)))
    }

    /// The stored Kick account whose event subscriptions this session owns,
    /// for cleanup at stop. Fixture tokens own nothing.
    fn kick_cleanup_account(&self) -> Option<String> {
        self.senders.values().find_map(|sender| match sender {
            ChatSenderConfig::Kick(config)
                if matches!(
                    config.token_source,
                    crate::session_token::SessionTokenSource::Account { .. }
                ) =>
            {
                Some(config.account_id.clone())
            }
            _ => None,
        })
    }

    pub fn sender(&self, destination_id: &str) -> Option<ChatSenderConfig> {
        self.senders.get(destination_id).cloned()
    }

    /// One retained row by app id (the bounded buffer only; SQLite holds the
    /// rest). Chat moderation reads the target through it (plan 140 S4).
    pub(crate) fn message(&self, message_id: &str) -> Option<&LiveChatMessage> {
        if !self.seen.contains(message_id) {
            return None;
        }
        self.messages
            .iter()
            .find(|message| message.id == message_id)
    }

    pub(crate) fn highlight_message_eligibility(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> HighlightMessageEligibility {
        if self.session_id.as_deref() != Some(session_id) {
            return HighlightMessageEligibility::WrongSession;
        }
        let Some(message) = self
            .messages
            .iter()
            .find(|message| message.id == message_id)
        else {
            return HighlightMessageEligibility::Missing;
        };
        if message.session_id != session_id {
            return HighlightMessageEligibility::WrongSession;
        }
        // A notice goes on stream only as an activity event (a raid, an
        // announcement: plan 055, S11); plain system text never does.
        let plain_notice =
            message.event_type == LiveChatEventType::System && message.details.is_none();
        if message.is_deleted
            || plain_notice
            || matches!(
                message.event_type,
                LiveChatEventType::Deleted | LiveChatEventType::Moderation
            )
        {
            return HighlightMessageEligibility::Ineligible;
        }
        HighlightMessageEligibility::Eligible
    }

    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.session_id.is_some()
    }

    #[allow(dead_code)]
    pub fn trimmed_count(&self) -> u64 {
        self.trimmed_count
    }

    #[allow(dead_code)]
    pub fn duplicates_skipped(&self) -> u64 {
        self.duplicates_skipped
    }

    pub fn ensure_provider(&mut self, provider: LiveChatProviderState) {
        match self
            .providers
            .iter_mut()
            .find(|existing| existing.id == provider.id)
        {
            Some(existing) => {
                existing.target_id = provider.target_id;
                existing.account_id = provider.account_id;
                existing.account_label = provider.account_label;
                existing.read = provider.read;
                existing.write = provider.write;
            }
            None => self.providers.push(provider),
        }
    }

    /// True once a session has been started (or left a transcript) — drives whether
    /// `current_status` returns the live view versus the setup-time capability snapshot.
    /// The active chat session id, if a session is running.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(crate) fn session_generation(&self) -> u64 {
        self.session_generation
    }

    pub fn has_session_view(&self) -> bool {
        self.session_id.is_some() || !self.messages.is_empty() || !self.providers.is_empty()
    }

    /// Begin a chat session: abort any leftover tasks and reset the buffer/de-dup/counters,
    /// installing the provider rows for this session.
    pub fn start_session(&mut self, session_id: String, providers: Vec<LiveChatProviderState>) {
        self.abort_tasks();
        self.generation = self.generation.wrapping_add(1);
        self.session_generation = self.session_generation.wrapping_add(1);
        self.session_id = Some(session_id);
        self.providers = providers;
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
        self.trimmed_count = 0;
        self.duplicates_skipped = 0;
        self.messages_received = 0;
        self.reconnect_count = 0;
        self.senders.clear();
        self.chatters_seen.clear();
        self.seventv_indexes = Arc::default();
    }

    /// Abort connector tasks and mark every connected provider `ended`. The transcript is
    /// retained so the app can keep showing it until the local view is cleared.
    pub fn stop_session(&mut self) {
        self.abort_tasks();
        self.generation = self.generation.wrapping_add(1);
        self.session_generation = self.session_generation.wrapping_add(1);
        for provider in &mut self.providers {
            if provider.state != LiveChatProviderConnectionState::Unsupported {
                provider.state = LiveChatProviderConnectionState::Ended;
            }
        }
        self.session_id = None;
        self.senders.clear();
        self.seventv_indexes = Arc::default();
    }

    /// Clear the local message view (buffer + unread) without touching providers, the
    /// session, or platform-side messages — the `liveChat.clearLocal` semantics.
    pub fn clear_local(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.messages.clear();
        self.seen.clear();
        self.unread_count = 0;
    }

    /// Buffer one message, or replace an existing row with a provider deletion tombstone.
    /// A tombstone always wins over the original, including when it arrives first.
    #[allow(dead_code)]
    pub fn ingest(&mut self, message: LiveChatMessage) -> IngestOutcome {
        self.ingest_reversible(message).outcome
    }

    fn ingest_reversible(&mut self, mut message: LiveChatMessage) -> ReversibleIngest {
        if self.seen.contains(&message.id) {
            if let Some(index) = self
                .messages
                .iter()
                .position(|existing| existing.id == message.id)
                && message.is_deleted
                && !self.messages[index].is_deleted
            {
                let existing = &mut self.messages[index];
                let previous = existing.clone();
                // Keep the original row's identity and chronological position, but
                // discard its provider-visible content. The deletion event supplies
                // the safe replacement text and raw event type.
                message.author_id = existing.author_id.clone();
                message.author_name = existing.author_name.clone();
                message.author_avatar_url = existing.author_avatar_url.clone();
                message.author_badges = existing.author_badges.clone();
                message.author_affiliation = existing.author_affiliation.clone();
                message.author_roles = existing.author_roles.clone();
                message.published_at = existing.published_at.clone();
                message.received_at = existing.received_at.clone();
                message.fragments.clear();
                message.amount_text = None;
                *existing = message.clone();
                return ReversibleIngest {
                    outcome: IngestOutcome::Updated(message.clone()),
                    undo: LiveChatIngestUndo::Updated {
                        index,
                        previous: Box::new(previous),
                        applied: Box::new(message),
                    },
                };
            }
            let previous_duplicates_skipped = self.duplicates_skipped;
            self.duplicates_skipped += 1;
            return ReversibleIngest {
                outcome: IngestOutcome::Duplicate,
                undo: LiveChatIngestUndo::Duplicate {
                    previous_duplicates_skipped,
                },
            };
        }
        let provider_update = self.providers.iter().position(|provider| {
            provider.platform == message.platform
                && provider.target_id.as_deref() == message.target_id.as_deref()
        });
        let provider_update = provider_update.map(|index| {
            let previous = self.providers[index].last_message_at.clone();
            self.providers[index].last_message_at = Some(message.received_at.clone());
            (index, previous)
        });
        let previous_unread_count = self.unread_count;
        let previous_trimmed_count = self.trimmed_count;
        let previous_messages_received = self.messages_received;
        let inserted_id = message.id.clone();
        let inserted_received_at = message.received_at.clone();
        self.seen.insert(inserted_id.clone());
        self.messages.push_back(message.clone());
        self.unread_count += 1;
        self.messages_received += 1;
        debug_assert!(self.messages.len() <= self.max_messages + 1);
        let trimmed = if self.messages.len() > self.max_messages {
            self.messages
                .pop_front()
                .inspect(|trimmed| {
                    self.seen.remove(&trimmed.id);
                    self.trimmed_count += 1;
                })
                .map(Box::new)
        } else {
            None
        };
        ReversibleIngest {
            outcome: IngestOutcome::New(message),
            undo: LiveChatIngestUndo::New {
                inserted_id,
                inserted_received_at,
                trimmed,
                provider_update,
                previous_unread_count,
                previous_trimmed_count,
                previous_messages_received,
            },
        }
    }

    fn rollback_ingest(&mut self, undo: LiveChatIngestUndo) {
        match undo {
            LiveChatIngestUndo::Duplicate {
                previous_duplicates_skipped,
            } => {
                if self.duplicates_skipped == previous_duplicates_skipped.saturating_add(1) {
                    self.duplicates_skipped = previous_duplicates_skipped;
                }
            }
            LiveChatIngestUndo::Updated {
                index,
                previous,
                applied,
            } => {
                if self.messages.get(index) == Some(applied.as_ref())
                    && let Some(message) = self.messages.get_mut(index)
                {
                    *message = *previous;
                }
            }
            LiveChatIngestUndo::New {
                inserted_id,
                inserted_received_at,
                trimmed,
                provider_update,
                previous_unread_count,
                previous_trimmed_count,
                previous_messages_received,
            } => {
                if self
                    .messages
                    .back()
                    .map(|message| (message.id.as_str(), message.received_at.as_str()))
                    != Some((inserted_id.as_str(), inserted_received_at.as_str()))
                {
                    // A lifecycle operation replaced the transcript while persistence
                    // was pending. Do not mutate that newer session to restore old data.
                    return;
                }
                self.messages.pop_back();
                self.seen.remove(&inserted_id);
                if let Some(trimmed) = trimmed {
                    self.seen.insert(trimmed.id.clone());
                    self.messages.push_front(*trimmed);
                }
                self.unread_count = previous_unread_count;
                self.trimmed_count = previous_trimmed_count;
                self.messages_received = previous_messages_received;
                if let Some((index, previous)) = provider_update
                    && self
                        .providers
                        .get(index)
                        .and_then(|provider| provider.last_message_at.as_deref())
                        == Some(inserted_received_at.as_str())
                    && let Some(provider) = self.providers.get_mut(index)
                {
                    provider.last_message_at = previous;
                }
            }
        }
    }

    /// Update one provider's connection state + message (e.g. connecting → connected → ended).
    pub fn set_provider_status(
        &mut self,
        platform: StreamPlatform,
        target_id: Option<&str>,
        connection: LiveChatProviderConnectionState,
        message: &str,
        now: &str,
    ) {
        if connection == LiveChatProviderConnectionState::Reconnecting {
            self.reconnect_count += 1;
        }
        if let Some(provider) = self.providers.iter_mut().find(|provider| {
            provider.platform == platform
                && target_id
                    .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                    .unwrap_or(true)
        }) {
            provider.state = connection;
            provider.message = message.to_string();
            if connection != LiveChatProviderConnectionState::Waiting {
                provider.retry_at = None;
            }
            provider.read = match connection {
                LiveChatProviderConnectionState::Connecting
                | LiveChatProviderConnectionState::Reconnecting => CommentsReadState::Connecting,
                LiveChatProviderConnectionState::Connected => CommentsReadState::Ready,
                LiveChatProviderConnectionState::Waiting => {
                    CommentsReadState::WaitingForBroadcastContext
                }
                LiveChatProviderConnectionState::Ended => CommentsReadState::Ended,
                LiveChatProviderConnectionState::Failed => CommentsReadState::Failed,
                LiveChatProviderConnectionState::Disabled
                | LiveChatProviderConnectionState::Unsupported => CommentsReadState::Unavailable,
            };
            match connection {
                LiveChatProviderConnectionState::Connected => {
                    provider.last_connected_at = Some(now.to_string());
                    provider.last_error = None;
                }
                LiveChatProviderConnectionState::Failed
                | LiveChatProviderConnectionState::Reconnecting => {
                    provider.last_error = Some(message.to_string());
                }
                _ => {}
            }
        }
    }

    /// When a `Waiting` provider resumes on its own (plan 094: the YouTube
    /// quota pause). Cleared by the next non-waiting transition.
    pub fn set_provider_retry_at(
        &mut self,
        platform: StreamPlatform,
        target_id: Option<&str>,
        retry_at: Option<String>,
    ) {
        if let Some(provider) = self.providers.iter_mut().find(|provider| {
            provider.platform == platform
                && target_id
                    .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                    .unwrap_or(true)
        }) {
            provider.retry_at = retry_at;
        }
    }

    pub fn attach_task(&mut self, task: JoinHandle<()>) {
        self.tasks.push(task);
    }

    /// The session's 7TV emote indexes (plan 089); empty until loaded.
    pub(crate) fn seventv_indexes(&self) -> Arc<crate::seventv::SevenTvIndexes> {
        self.seventv_indexes.clone()
    }

    fn owns_seventv_session(&self, session_generation: u64) -> bool {
        self.session_id.is_some() && self.session_generation == session_generation
    }

    /// Install freshly loaded 7TV indexes and their status, unless the
    /// session they were loaded for has ended or been replaced. Returns
    /// whether it did.
    pub(crate) fn install_seventv_load(
        &mut self,
        session_generation: u64,
        indexes: crate::seventv::SevenTvIndexes,
        status: crate::seventv::SevenTvStatus,
    ) -> bool {
        if !self.owns_seventv_session(session_generation) {
            return false;
        }
        self.seventv_indexes = Arc::new(indexes);
        self.seventv_status = status;
        true
    }

    /// Record a 7TV status for Settings, under the same session check.
    pub(crate) fn set_seventv_status(
        &mut self,
        session_generation: u64,
        status: crate::seventv::SevenTvStatus,
    ) -> bool {
        if !self.owns_seventv_session(session_generation) {
            return false;
        }
        self.seventv_status = status;
        true
    }

    pub(crate) fn seventv_status(&self) -> crate::seventv::SevenTvStatus {
        self.seventv_status.clone()
    }

    /// Whether this session's 7TV loader is running.
    pub(crate) fn seventv_running(&self) -> bool {
        self.seventv_task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    fn attach_seventv_task(&mut self, task: JoinHandle<()>) {
        if let Some(previous) = self.seventv_task.replace(task) {
            previous.abort();
        }
    }

    /// The Settings switch went off: stop the loader, drop the emotes, and
    /// forget the last outcome. Messages already decorated keep their emotes.
    pub(crate) fn stop_seventv(&mut self) {
        if let Some(task) = self.seventv_task.take() {
            task.abort();
        }
        self.seventv_indexes = Arc::default();
        self.seventv_status = crate::seventv::SevenTvStatus::default();
    }

    /// Where 7TV requests go; `None` when 7TV is off.
    pub(crate) fn seventv_endpoint(&self) -> Option<String> {
        self.seventv_endpoint.clone()
    }

    #[cfg(test)]
    pub(crate) fn set_seventv_endpoint(&mut self, endpoint: Option<String>) {
        self.seventv_endpoint = endpoint;
    }

    /// The streamer's own Twitch, Kick and YouTube channels in this session,
    /// as 7TV connections (plan 089).
    pub(crate) fn seventv_connections(&self) -> Vec<crate::seventv::SevenTvConnection> {
        crate::seventv::session_connections(
            self.providers
                .iter()
                .map(|provider| (provider.platform, provider.account_id.as_deref())),
        )
    }

    #[cfg(test)]
    pub(crate) fn runtime_ownership(&self) -> (usize, usize) {
        (self.tasks.len(), self.senders.len())
    }

    fn abort_tasks(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        if let Some(task) = self.seventv_task.take() {
            task.abort();
        }
    }

    pub fn snapshot(&self, updated_at: String) -> LiveChatSnapshot {
        let mut messages: Vec<_> = self.messages.iter().cloned().collect();
        messages.sort_by(|left, right| {
            left.received_at
                .cmp(&right.received_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        LiveChatSnapshot {
            session_id: self.session_id.clone(),
            providers: self.providers.clone(),
            messages,
            unread_count: self.unread_count,
            updated_at,
        }
    }

    pub fn diagnostics(&self) -> LiveChatDiagnostics {
        LiveChatDiagnostics {
            session_id: self.session_id.clone(),
            providers: self.providers.clone(),
            messages_received: self.messages_received,
            duplicates_skipped: self.duplicates_skipped,
            messages_trimmed: self.trimmed_count,
            reconnect_count: self.reconnect_count,
            buffered: self.messages.len() as u64,
            unread_count: self.unread_count,
        }
    }
}

/// Provider rows for a starting session, derived from current chat capabilities. The
/// connectors (slices 4-5) drive each row to connecting → connected/failed; platforms with
/// no native path stay `unsupported`.
fn session_provider_rows(
    accounts: &[PlatformAccount],
    platforms: &[StreamPlatform],
    destinations: &[LiveChatDestinationStart],
) -> Vec<LiveChatProviderState> {
    if !destinations.is_empty() {
        return destinations
            .iter()
            .map(|destination| {
                let capability = chat_capability(
                    destination.platform,
                    accounts
                        .iter()
                        .find(|account| account.platform == destination.platform),
                );
                let mut provider = provider_state_from_capability(capability);
                provider.id = destination.target_id.clone();
                provider.target_id = Some(destination.target_id.clone());
                if let Some(read) = destination.read {
                    provider.read = read;
                }
                if let Some(write) = destination.write {
                    provider.write = write;
                }
                if let Some(error) = destination.preparation_error.as_deref() {
                    provider.state = LiveChatProviderConnectionState::Failed;
                    if destination.read.is_none() && provider.read != CommentsReadState::Unavailable
                    {
                        provider.read = CommentsReadState::Failed;
                    }
                    if destination.write.is_none() && provider.write == CommentsWriteState::Ready {
                        provider.write = CommentsWriteState::Failed;
                    }
                    provider.message = error.to_string();
                    provider.last_error = Some(error.to_string());
                }
                provider
            })
            .collect();
    }
    let requested: HashSet<StreamPlatform> = platforms.iter().copied().collect();
    chat_capabilities(accounts)
        .into_iter()
        .filter(|capability| requested.is_empty() || requested.contains(&capability.platform))
        .map(provider_state_from_capability)
        .collect()
}

/// Parameters for `liveChat.start`. Real connectors arrive in slices 4-5; until then a
/// `fake` connector exercises the buffer + event path for tests and the live-chat smoke.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatStartParams {
    pub session_id: String,
    /// Platforms this session should show. Empty preserves the legacy full readiness surface.
    #[serde(default)]
    pub platforms: Vec<StreamPlatform>,
    #[serde(default)]
    pub destinations: Vec<LiveChatDestinationStart>,
    #[serde(default)]
    pub fake: Option<FakeChatConfig>,
    #[serde(default)]
    pub fakes: Vec<FakeChatConfig>,
    #[serde(default)]
    pub youtube: Option<crate::youtube_chat::YouTubeChatConfig>,
    #[serde(default)]
    pub twitch: Option<crate::twitch_chat::TwitchChatConfig>,
    #[serde(default)]
    pub x: Option<crate::x_chat::XChatConfig>,
    #[serde(default)]
    pub kick: Option<crate::kick_chat::KickChatConfig>,
    /// Follower and subscriber sources (plan 055, S3). Built by the backend
    /// from the session's destinations; never read from RPC params, because
    /// they resolve stored credentials.
    #[serde(skip)]
    pub audience: Vec<crate::audience::AudienceSource>,
    /// Canned audience readings for smokes (no network, no credentials).
    #[serde(default)]
    pub fake_audience: Vec<crate::audience::FakeAudienceConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatDestinationStart {
    pub target_id: String,
    pub platform: StreamPlatform,
    #[serde(default)]
    pub read: Option<CommentsReadState>,
    #[serde(default)]
    pub write: Option<CommentsWriteState>,
    #[serde(default)]
    pub preparation_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartXLiveChatParams {
    pub session_id: String,
    pub broadcast_id: String,
    #[serde(default)]
    pub target_id: Option<String>,
}

/// A deterministic, bounded fake chat source for tests / `smoke:live-chat-fake-providers`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChatConfig {
    #[serde(default = "default_fake_platform")]
    pub platform: StreamPlatform,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default = "default_fake_count")]
    pub count: u32,
    #[serde(default = "default_fake_interval_ms")]
    pub interval_ms: u64,
    /// Re-send the first message once to prove de-duplication skips it.
    #[serde(default)]
    pub include_duplicate: bool,
    /// Give the second delivered row an earlier provider timestamp so the
    /// authoritative snapshot proves chronological convergence after disorder.
    #[serde(default)]
    pub out_of_order: bool,
    /// Before this sequence number, emit reconnecting -> connected once.
    #[serde(default)]
    pub reconnect_at: Option<u32>,
    #[serde(default)]
    pub send: FakeChatSendBehavior,
    /// After its messages, deliver one of each activity event its platform
    /// has, with structured details (the Stream Manager smoke, plan 055).
    #[serde(default)]
    pub events: bool,
    /// Give every fake message this author avatar (the comment-highlight
    /// smoke proves the avatar reaches the on-stream card, plan 095).
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// End every fake message with this emote as an image fragment, the way
    /// Twitch, Kick and 7TV deliver one (the same smoke proves it is drawn
    /// on the card, plan 095).
    #[serde(default)]
    pub emote: Option<FakeChatEmote>,
    /// After its messages, deliver one Twitch GIF Keyboard row (plan 155): a
    /// `gif` fragment with this URL, from a Tier 2 subscriber. The URL is
    /// taken as given; the real connector gates it in `twitch_chat.rs`.
    #[serde(default)]
    pub gif: Option<FakeChatGif>,
    /// Author names to rotate through (`authors[seq % len]`) instead of
    /// "Test Viewer N", so a smoke can say a name ("coders_x", plan 140 S9).
    #[serde(default)]
    pub authors: Vec<String>,
    /// A scripted removal outcome for this destination (plan 140 S9). Absent:
    /// the removal mirrors `send` (sent removes, failed fails, timeout hangs).
    #[serde(default)]
    pub delete: Option<FakeChatDeleteBehavior>,
}

/// What a fake destination answers a removal with (plan 140 S9's smoke).
/// Smoke input only: never serialized, never sent to a renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FakeChatDeleteBehavior {
    /// The platform removed it.
    Ok,
    /// The account lacks the moderation scope: hidden in Videorc.
    MissingScope,
    /// The platform no longer has it: counted as removed.
    NotFound,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChatEmote {
    pub text: String,
    pub image_url: String,
}

/// A fake Twitch GIF (plan 155). `title` is the GIPHY title as Twitch sends
/// it in the fragment text, brackets included (`[Y A Y Yes GIF]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeChatGif {
    pub title: String,
    pub image_url: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FakeChatSendBehavior {
    #[default]
    Sent,
    Failed,
    Timeout,
}

/// The send (and removal) credentials a fake destination registers.
fn fake_sender(fake: &FakeChatConfig) -> ChatSenderConfig {
    match fake.delete {
        Some(delete) => ChatSenderConfig::FakeModerated {
            send: fake.send,
            delete,
        },
        None => ChatSenderConfig::Fake(fake.send),
    }
}

fn default_fake_platform() -> StreamPlatform {
    StreamPlatform::Youtube
}

fn default_fake_count() -> u32 {
    5
}

fn default_fake_interval_ms() -> u64 {
    200
}

/// Start a chat session: install provider rows, optionally spawn the fake connector, and
/// emit the initial snapshot. Returns the snapshot for the command response.
pub async fn start_live_chat(state: &AppState, params: LiveChatStartParams) -> LiveChatSnapshot {
    start_live_chat_after_install(
        state,
        params,
        std::future::ready(()),
        std::future::ready(()),
    )
    .await
}

async fn start_live_chat_after_install<F, G>(
    state: &AppState,
    params: LiveChatStartParams,
    after_install: F,
    before_snapshot_emit: G,
) -> LiveChatSnapshot
where
    F: std::future::Future<Output = ()>,
    G: std::future::Future<Output = ()>,
{
    if (params.fake.is_some() || !params.fakes.is_empty())
        && let Err(error) = state
            .database
            .ensure_fake_live_chat_session(&params.session_id)
    {
        state.emit_log(
            "warn",
            format!("Could not prepare fake Comments session persistence: {error}"),
        );
    }
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let mut providers = session_provider_rows(&accounts, &params.platforms, &params.destinations);
    for provider in &mut providers {
        let configured_target_id = match provider.platform {
            StreamPlatform::Youtube => params
                .youtube
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::Twitch => params
                .twitch
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::X => params
                .x
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::Kick => params
                .kick
                .as_ref()
                .and_then(|config| config.target_id.clone()),
            StreamPlatform::Tiktok | StreamPlatform::Instagram | StreamPlatform::Custom => None,
        };
        let configured_target_id = configured_target_id.or_else(|| {
            params
                .fakes
                .iter()
                .chain(params.fake.iter())
                .find(|fake| fake.platform == provider.platform)
                .and_then(|fake| fake.target_id.clone())
        });
        if provider.target_id.is_none() && configured_target_id.is_some() {
            provider.target_id = configured_target_id;
        }
        provider.id = comments_destination_id(provider.platform, provider.target_id.as_deref());
        if provider.platform == StreamPlatform::Youtube && params.youtube.is_some() {
            provider.write = CommentsWriteState::Ready;
        }
        if provider.platform == StreamPlatform::X
            && params.x.is_none()
            && provider.state != LiveChatProviderConnectionState::Failed
        {
            provider.state = LiveChatProviderConnectionState::Waiting;
            provider.read = CommentsReadState::WaitingForBroadcastContext;
            provider.message = "Waiting for X broadcast context.".to_string();
        }
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    // A new chat session replaces any co-host session; keep that retirement
    // in the same lifecycle transaction as the coordinator replacement so a
    // concurrent start/stop cannot apply an older operation to the new engine.
    crate::cohost::stop_cohost_for_session_end_under_lifecycle_fence(
        state,
        &lifecycle_delivery,
        crate::captions::ListenStop::Abort,
    )
    .await;
    let session_generation = {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.start_session(params.session_id.clone(), providers);
        coordinator.session_generation()
    };
    // The coordinator session and every connector/sender handle are one
    // lifecycle transaction. A stop that observes this session must wait for
    // all of its runtime ownership to be attached so stop_session can retire
    // it completely; otherwise a half-finished explicit start can attach a
    // task after the monitor already returned from teardown.
    after_install.await;
    if let Some(fake) = params.fake.clone() {
        let handle = tokio::spawn(run_fake_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            fake.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        let destination_id = comments_destination_id(fake.platform, fake.target_id.as_deref());
        if let Some(provider) = coordinator
            .providers
            .iter_mut()
            .find(|provider| provider.id == destination_id)
        {
            provider.write = if fake.platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            };
        }
        if fake.platform != StreamPlatform::X {
            coordinator.register_sender(destination_id, fake_sender(&fake));
        }
        coordinator.attach_task(handle);
    }
    for fake in params.fakes.clone() {
        let handle = tokio::spawn(run_fake_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            fake.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        let destination_id = comments_destination_id(fake.platform, fake.target_id.as_deref());
        if let Some(provider) = coordinator
            .providers
            .iter_mut()
            .find(|provider| provider.id == destination_id)
        {
            provider.write = if fake.platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            };
        }
        if fake.platform != StreamPlatform::X {
            coordinator.register_sender(destination_id, fake_sender(&fake));
        }
        coordinator.attach_task(handle);
    }
    if let Some(youtube) = params.youtube.clone() {
        // Register before spawning: a zero-latency resolver may publish the
        // liveChatId immediately, and that update must always find its sender.
        let mut coordinator = state.live_chat.lock().await;
        coordinator.register_sender(
            comments_destination_id(StreamPlatform::Youtube, youtube.target_id.as_deref()),
            ChatSenderConfig::YouTube {
                access_token: youtube.access_token.clone(),
                api_base_url: youtube.api_base_url.clone(),
                live_chat_id: youtube.live_chat_id.clone(),
                token_source: youtube.token_source.clone(),
            },
        );
        drop(coordinator);
        let handle = tokio::spawn(crate::youtube_chat::run_youtube_chat_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            youtube,
        ));
        // Plan 094: the YouTube API usage summary every 10 minutes; the stop
        // path logs the last one.
        let usage = tokio::spawn(crate::youtube_quota::run_usage_reporter(
            state.clone(),
            params.session_id.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
        coordinator.attach_task(usage);
    }
    // Viewer sampler (plan rider V1): same session, same credentials as the
    // chat connectors, same abort-on-stop lifecycle. Polling failures are
    // missing data — never a chat or stream problem.
    {
        let youtube_viewers = params.youtube.as_ref().and_then(|config| {
            config.broadcast_id.clone().map(|broadcast_id| {
                crate::viewer_stats::YouTubeViewerConfig {
                    access_token: config.access_token.clone(),
                    broadcast_id,
                    api_base_url: config.api_base_url.clone(),
                    token_source: config.token_source.clone(),
                }
            })
        });
        let twitch_viewers =
            params
                .twitch
                .as_ref()
                .map(|config| crate::viewer_stats::TwitchViewerConfig {
                    access_token: config.access_token.clone(),
                    client_id: config.client_id.clone(),
                    broadcaster_user_id: config.broadcaster_user_id.clone(),
                    api_base_url: config.api_base_url.clone(),
                    token_source: config.token_source.clone(),
                });
        let kick_viewers =
            params
                .kick
                .as_ref()
                .map(|config| crate::viewer_stats::KickViewerConfig {
                    access_token: config.access_token.clone(),
                    api_base_url: config.overrides.kick_api_base_url.clone(),
                    token_source: config.token_source.clone(),
                });
        if youtube_viewers.is_some() || twitch_viewers.is_some() || kick_viewers.is_some() {
            let handle = tokio::spawn(crate::viewer_stats::run_viewer_sampler(
                state.clone(),
                params.session_id.clone(),
                youtube_viewers,
                twitch_viewers,
                None,
                kick_viewers,
            ));
            let mut coordinator = state.live_chat.lock().await;
            coordinator.attach_task(handle);
        }
    }
    if let Some(twitch) = params.twitch.clone() {
        let handle = tokio::spawn(crate::twitch_chat::run_twitch_chat_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            twitch.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
        coordinator.register_sender(
            comments_destination_id(StreamPlatform::Twitch, twitch.target_id.as_deref()),
            ChatSenderConfig::Twitch(crate::twitch_chat::TwitchChatSenderConfig {
                access_token: twitch.access_token,
                client_id: twitch.client_id,
                broadcaster_user_id: twitch.broadcaster_user_id.clone(),
                // The authorized user sends as themself.
                sender_user_id: twitch.user_id,
                api_base_url: twitch.api_base_url,
                token_source: twitch.token_source,
            }),
        );
    }
    if let Some(kick) = params.kick.clone() {
        let handle = tokio::spawn(crate::kick_chat::run_kick_chat_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            kick.clone(),
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
        coordinator.register_sender(
            comments_destination_id(StreamPlatform::Kick, kick.target_id.as_deref()),
            ChatSenderConfig::Kick(crate::kick_chat::KickChatSenderConfig {
                access_token: kick.access_token,
                account_id: kick.account_id,
                broadcaster_user_id: kick.broadcaster_user_id,
                api_base_url: kick.overrides.kick_api_base_url,
                token_source: kick.token_source,
            }),
        );
    }
    if let Some(x) = params.x.clone() {
        let handle = tokio::spawn(crate::x_chat::run_x_chat_connector(
            state.clone(),
            params.session_id.clone(),
            session_generation,
            x,
        ));
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(handle);
    }
    // Followers and subscribers (plan 055, S3) share the connectors'
    // abort-on-stop lifecycle.
    let audience_handles = crate::audience::start_audience(
        state,
        &params.session_id,
        params.audience.clone(),
        params.fake_audience.clone(),
    );
    if !audience_handles.is_empty() {
        let mut coordinator = state.live_chat.lock().await;
        for handle in audience_handles {
            coordinator.attach_task(handle);
        }
    }
    // 7TV emotes (plan 089) load beside the connectors and stop with them.
    start_seventv_for_session(state, session_generation).await;
    let snapshot = current_status(state).await;
    before_snapshot_emit.await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    drop(lifecycle_delivery);
    snapshot
}

/// Start the 7TV emote loader (plan 089) for a chat session that has a
/// Twitch, Kick or YouTube channel to look up, unless the streamer turned 7TV
/// off in Settings. X attaching later never needs it: 7TV has no X
/// connection.
async fn start_seventv_for_session(state: &AppState, session_generation: u64) {
    if !crate::seventv::load_settings(state).seven_tv {
        return;
    }
    {
        let mut coordinator = state.live_chat.lock().await;
        if coordinator.session_id().is_none()
            || coordinator.session_generation() != session_generation
        {
            return;
        }
        let Some(endpoint) = coordinator.seventv_endpoint() else {
            return;
        };
        let connections = coordinator.seventv_connections();
        if connections.is_empty() {
            return;
        }
        coordinator
            .set_seventv_status(session_generation, crate::seventv::SevenTvStatus::loading());
        let handle =
            crate::seventv::spawn_session_loader(state, session_generation, endpoint, connections);
        coordinator.attach_seventv_task(handle);
    }
    crate::seventv::publish_state(state).await;
}

/// The Settings switch went on mid-stream: load 7TV emotes now rather than
/// at the next Go Live.
pub(crate) async fn ensure_seventv_for_current_session(state: &AppState) {
    let generation = {
        let coordinator = state.live_chat.lock().await;
        (coordinator.session_id().is_some() && !coordinator.seventv_running())
            .then(|| coordinator.session_generation())
    };
    if let Some(generation) = generation {
        start_seventv_for_session(state, generation).await;
    }
}

pub async fn start_x_live_chat(
    state: &AppState,
    params: StartXLiveChatParams,
) -> Result<LiveChatSnapshot> {
    start_x_live_chat_before_snapshot_emit(state, params, std::future::ready(())).await
}

async fn start_x_live_chat_before_snapshot_emit<F>(
    state: &AppState,
    params: StartXLiveChatParams,
    before_snapshot_emit: F,
) -> Result<LiveChatSnapshot>
where
    F: std::future::Future<Output = ()>,
{
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    let mut provider = session_provider_rows(&accounts, &[StreamPlatform::X], &[])
        .into_iter()
        .next()
        .unwrap_or_else(|| LiveChatProviderState {
            id: comments_destination_id(StreamPlatform::X, params.target_id.as_deref()),
            platform: StreamPlatform::X,
            target_id: None,
            account_id: None,
            account_label: None,
            read: CommentsReadState::WaitingForBroadcastContext,
            write: CommentsWriteState::Ready,
            moderate: None,
            state: LiveChatProviderConnectionState::Disabled,
            message: crate::x_chat::x_chat_message(false).to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        });
    provider.target_id = params.target_id.clone();
    provider.id = comments_destination_id(StreamPlatform::X, provider.target_id.as_deref());

    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let session_generation = {
        let mut coordinator = state.live_chat.lock().await;
        if let Some(active_session_id) = coordinator.session_id.as_deref() {
            if active_session_id != params.session_id {
                return Err(anyhow!(
                    "Live chat session {active_session_id} is active; cannot attach X chat for {}.",
                    params.session_id
                ));
            }
            coordinator.ensure_provider(provider);
        } else {
            coordinator.start_session(params.session_id.clone(), vec![provider]);
        }
        coordinator.session_generation()
    };

    let config = crate::x_chat::XChatConfig {
        broadcast_id: params.broadcast_id,
        target_id: params.target_id,
        overrides: crate::x_chat::XChatOverrides::default(),
    };
    // X viewer counts ride the same session lifecycle as the chat connector
    // (plan 028 specified them; they were never implemented — owner report,
    // 2026-08-19: "cannot see how many watchers there are from X").
    let viewer_handle = tokio::spawn(crate::viewer_stats::run_viewer_sampler(
        state.clone(),
        params.session_id.clone(),
        None,
        None,
        Some(crate::viewer_stats::XViewerConfig {
            broadcast_id: config.broadcast_id.clone(),
            api_base_url: None,
        }),
        None,
    ));
    let sender_destination_id =
        comments_destination_id(StreamPlatform::X, config.target_id.as_deref());
    let sender_broadcast_id = config.broadcast_id.clone();
    let handle = tokio::spawn(crate::x_chat::run_x_chat_connector(
        state.clone(),
        params.session_id,
        session_generation,
        config,
    ));
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.attach_task(viewer_handle);
        coordinator.attach_task(handle);
        coordinator.register_sender(
            sender_destination_id,
            ChatSenderConfig::X {
                broadcast_id: sender_broadcast_id,
            },
        );
    }

    let snapshot = current_status(state).await;
    before_snapshot_emit.await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    drop(lifecycle_delivery);
    Ok(snapshot)
}

/// The YouTube connector resolves the live chat id from the broadcast id after
/// start; fill it into the sender so sends work without a second resolve.
pub async fn set_youtube_send_chat_id(
    state: &AppState,
    expected_session_id: &str,
    expected_generation: u64,
    target_id: Option<&str>,
    live_chat_id: &str,
) -> bool {
    set_youtube_send_chat_id_before_mutation(
        state,
        expected_session_id,
        expected_generation,
        target_id,
        live_chat_id,
        std::future::ready(()),
    )
    .await
}

async fn set_youtube_send_chat_id_before_mutation<F>(
    state: &AppState,
    expected_session_id: &str,
    expected_generation: u64,
    target_id: Option<&str>,
    live_chat_id: &str,
    before_mutation: F,
) -> bool
where
    F: std::future::Future<Output = ()>,
{
    before_mutation.await;
    let _lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut coordinator = state.live_chat.lock().await;
    if coordinator.session_id.as_deref() != Some(expected_session_id)
        || coordinator.session_generation() != expected_generation
    {
        return false;
    }
    let destination_id = comments_destination_id(StreamPlatform::Youtube, target_id);
    if let Some(ChatSenderConfig::YouTube {
        live_chat_id: slot, ..
    }) = coordinator.senders.get_mut(&destination_id)
    {
        *slot = Some(live_chat_id.to_string());
        true
    } else {
        false
    }
}

#[cfg(not(test))]
const CHAT_SEND_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(test)]
const CHAT_SEND_TIMEOUT: Duration = Duration::from_millis(50);

/// Send once to every writable destination. The operation id is an idempotency
/// key: an existing row is returned verbatim and providers are never called a
/// second time. Provider calls run concurrently with independent deadlines.
pub async fn send_live_chat_message(
    state: &AppState,
    mut params: CommentsSendParams,
) -> Result<CommentsSendOperation, String> {
    if uuid::Uuid::parse_str(&params.operation_id).is_err() {
        return Err("operationId must be a UUID.".to_string());
    }
    let text = params.text.trim().to_string();
    if text.is_empty() || text.chars().count() > 200 {
        return Err("Chat messages must be 1-200 characters.".to_string());
    }
    params.text = text;

    if let Some(result) = {
        let coordinator = state.live_chat.lock().await;
        coordinator
            .send_operations_in_flight
            .get(&params.operation_id)
            .map(|in_flight| {
                validate_send_operation_binding(
                    &params.operation_id,
                    &params.session_id,
                    &params.text,
                    &in_flight.session_id,
                    &in_flight.text,
                )?;
                Ok::<_, String>(in_flight.result.clone())
            })
            .transpose()
    }? {
        return wait_for_send_operation(result).await;
    }

    if let Some(existing) = state
        .database
        .get_chat_send_operation(&params.operation_id)
        .map_err(|error| format!("Could not read send operation: {error}"))?
    {
        validate_send_operation_binding(
            &params.operation_id,
            &params.session_id,
            &params.text,
            &existing.session_id,
            &existing.text,
        )?;
        return Ok(existing);
    }

    let (result, operation_task) = {
        let mut coordinator = state.live_chat.lock().await;
        match coordinator
            .send_operations_in_flight
            .entry(params.operation_id.clone())
        {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let in_flight = entry.get();
                validate_send_operation_binding(
                    &params.operation_id,
                    &params.session_id,
                    &params.text,
                    &in_flight.session_id,
                    &in_flight.text,
                )?;
                (in_flight.result.clone(), None)
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                let (sender, result) = tokio::sync::watch::channel(None);
                entry.insert(InFlightSendOperation {
                    session_id: params.session_id.clone(),
                    text: params.text.clone(),
                    result: result.clone(),
                });
                (result, Some(sender))
            }
        }
    };

    if let Some(operation_task) = operation_task {
        let task_state = state.clone();
        let operation_id = params.operation_id.clone();
        tokio::spawn(async move {
            let result = execute_send_live_chat_message(&task_state, params).await;
            let _ = operation_task.send(Some(result));
            let mut coordinator = task_state.live_chat.lock().await;
            coordinator.send_operations_in_flight.remove(&operation_id);
        });
    }

    wait_for_send_operation(result).await
}

async fn wait_for_send_operation(mut result: SendOperationReceiver) -> SendOperationResult {
    loop {
        if let Some(operation) = result.borrow().clone() {
            return operation;
        }
        if result.changed().await.is_err() {
            let terminal = result.borrow().clone();
            return terminal.unwrap_or_else(|| {
                Err("The Comments send operation stopped before producing a result.".to_string())
            });
        }
    }
}

fn validate_send_operation_binding(
    operation_id: &str,
    requested_session_id: &str,
    requested_text: &str,
    stored_session_id: &str,
    stored_text: &str,
) -> Result<(), String> {
    if requested_session_id == stored_session_id && requested_text == stored_text {
        return Ok(());
    }
    Err(format!(
        "operationId {operation_id} is already bound to a different Comments session or message."
    ))
}

async fn execute_send_live_chat_message(
    state: &AppState,
    params: CommentsSendParams,
) -> Result<CommentsSendOperation, String> {
    if let Some(existing) = state
        .database
        .get_chat_send_operation(&params.operation_id)
        .map_err(|error| format!("Could not read send operation: {error}"))?
    {
        validate_send_operation_binding(
            &params.operation_id,
            &params.session_id,
            &params.text,
            &existing.session_id,
            &existing.text,
        )?;
        return Ok(existing);
    }

    let (providers, senders) = {
        let coordinator = state.live_chat.lock().await;
        if coordinator.session_id.as_deref() != Some(params.session_id.as_str()) {
            return Err("The Comments session changed before this message could send.".to_string());
        }
        let providers = coordinator
            .providers
            .iter()
            .filter(|provider| {
                params
                    .destination_ids
                    .as_ref()
                    .is_none_or(|selected| selected.contains(&provider.id))
            })
            .cloned()
            .collect::<Vec<_>>();
        let senders = providers
            .iter()
            .map(|provider| (provider.id.clone(), coordinator.sender(&provider.id)))
            .collect::<HashMap<_, _>>();
        (providers, senders)
    };
    if params.destination_ids.is_some() && providers.is_empty() {
        return Err("Pick at least one destination to send to.".to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let in_reply_to_question_id = params
        .in_reply_to_question_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let mut operation = CommentsSendOperation {
        id: params.operation_id,
        session_id: params.session_id,
        text: params.text,
        phase: CommentsSendOperationPhase::Sending,
        destinations: providers
            .iter()
            .map(|provider| {
                initial_delivery_for_provider(
                    provider,
                    senders.get(&provider.id).and_then(Option::as_ref).is_some(),
                )
            })
            .collect(),
        created_at: now.clone(),
        updated_at: now,
    };
    operation.phase = aggregate_send_phase(&operation.destinations);
    state
        .database
        .save_chat_send_operation(&operation)
        .map_err(|error| format!("Could not persist send operation: {error}"))?;
    state.emit_event("liveChat.sendOperation", operation.clone());
    // Plan 068 D9: the echo of this text in chat is the streamer, never a
    // viewer to greet.
    crate::cohost::note_own_send_started(state, &operation.session_id, &operation.text).await;

    let client = reqwest::Client::new();
    let pending = operation
        .destinations
        .iter()
        .filter(|delivery| delivery.phase == DestinationDeliveryPhase::Pending)
        .filter_map(|delivery| {
            senders
                .get(&delivery.destination_id)
                .cloned()
                .flatten()
                .map(|sender| {
                    let client = client.clone();
                    let destination_id = delivery.destination_id.clone();
                    let text = operation.text.clone();
                    let state = state.clone();
                    async move {
                        let outcome = timeout(CHAT_SEND_TIMEOUT, async {
                            let sender = with_current_sender_token(&state, &client, sender).await;
                            send_to_destination(&state, &client, sender, &text).await
                        })
                        .await;
                        (destination_id, outcome)
                    }
                })
        })
        .collect::<Vec<_>>();

    for (destination_id, outcome) in futures_util::future::join_all(pending).await {
        let Some(delivery) = operation
            .destinations
            .iter_mut()
            .find(|delivery| delivery.destination_id == destination_id)
        else {
            continue;
        };
        match outcome {
            Ok(Ok(receipt)) => {
                delivery.phase = DestinationDeliveryPhase::Sent;
                delivery.provider_message_id = receipt.provider_message_id;
                delivery.reason = None;
            }
            Ok(Err(reason)) => {
                delivery.phase = DestinationDeliveryPhase::Failed;
                delivery.reason = Some(reason);
            }
            Err(_) => {
                delivery.phase = DestinationDeliveryPhase::TimedOutUnknown;
                delivery.reason = Some(
                    "Provider response timed out; delivery is unknown and was not retried."
                        .to_string(),
                );
            }
        }
    }

    operation.updated_at = chrono::Utc::now().to_rfc3339();
    operation.phase = aggregate_send_phase(&operation.destinations);
    state
        .database
        .save_chat_send_operation(&operation)
        .map_err(|error| format!("Could not persist send result: {error}"))?;
    state.emit_event("liveChat.sendOperation", operation.clone());
    if matches!(
        operation.phase,
        CommentsSendOperationPhase::Sent | CommentsSendOperationPhase::Partial
    ) {
        crate::cohost::note_own_send_delivered(
            state,
            &operation.session_id,
            &operation.text,
            in_reply_to_question_id.as_deref(),
        )
        .await;
    }
    Ok(operation)
}

fn initial_delivery_for_provider(
    provider: &LiveChatProviderState,
    has_sender: bool,
) -> DestinationDelivery {
    let (phase, reason) = match provider.write {
        CommentsWriteState::Ready if has_sender => (DestinationDeliveryPhase::Pending, None),
        CommentsWriteState::Ready => (
            DestinationDeliveryPhase::Unavailable,
            Some("This destination's comment sender is unavailable.".to_string()),
        ),
        CommentsWriteState::MissingScope => (
            DestinationDeliveryPhase::Unavailable,
            Some("Reconnect this account to grant chat write permission.".to_string()),
        ),
        CommentsWriteState::ReadOnly => (
            DestinationDeliveryPhase::ReadOnly,
            Some("This destination supports receiving comments only.".to_string()),
        ),
        CommentsWriteState::Failed => (
            DestinationDeliveryPhase::Failed,
            Some("This destination's comment sender is unavailable.".to_string()),
        ),
        CommentsWriteState::Unavailable => (
            DestinationDeliveryPhase::Unavailable,
            Some("Sending is unavailable for this destination.".to_string()),
        ),
    };
    DestinationDelivery {
        destination_id: provider.id.clone(),
        platform: provider.platform,
        phase,
        provider_message_id: None,
        reason,
    }
}

fn aggregate_send_phase(deliveries: &[DestinationDelivery]) -> CommentsSendOperationPhase {
    if deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Pending)
    {
        return CommentsSendOperationPhase::Sending;
    }
    let sent = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Sent);
    let failed = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::Failed);
    let unknown = deliveries
        .iter()
        .any(|delivery| delivery.phase == DestinationDeliveryPhase::TimedOutUnknown);
    let not_sent = deliveries
        .iter()
        .any(|delivery| delivery.phase != DestinationDeliveryPhase::Sent);
    match (sent, failed, unknown, not_sent) {
        (true, _, _, true) => CommentsSendOperationPhase::Partial,
        (true, false, false, false) => CommentsSendOperationPhase::Sent,
        (false, false, true, _) => CommentsSendOperationPhase::DeliveryUnknown,
        _ => CommentsSendOperationPhase::Failed,
    }
}

/// A send hours into a stream takes the account's current token, refreshed
/// when near expiry, instead of the one captured at Go Live (plan 055, B2).
pub(crate) async fn with_current_sender_token(
    state: &AppState,
    client: &reqwest::Client,
    sender: ChatSenderConfig,
) -> ChatSenderConfig {
    match sender {
        ChatSenderConfig::YouTube {
            access_token,
            api_base_url,
            live_chat_id,
            token_source,
        } => {
            let mut token =
                crate::session_token::SessionToken::unchecked(access_token, token_source.clone());
            let access_token = token.ensure_fresh(state, client).await.to_string();
            ChatSenderConfig::YouTube {
                access_token,
                api_base_url,
                live_chat_id,
                token_source,
            }
        }
        ChatSenderConfig::Twitch(mut config) => {
            let mut token = crate::session_token::SessionToken::unchecked(
                config.access_token.clone(),
                config.token_source.clone(),
            );
            config.access_token = token.ensure_fresh(state, client).await.to_string();
            ChatSenderConfig::Twitch(config)
        }
        ChatSenderConfig::Kick(mut config) => {
            let mut token = crate::session_token::SessionToken::unchecked(
                config.access_token.clone(),
                config.token_source.clone(),
            );
            config.access_token = token.ensure_fresh(state, client).await.to_string();
            ChatSenderConfig::Kick(config)
        }
        other => other,
    }
}

async fn send_to_destination(
    state: &AppState,
    client: &reqwest::Client,
    sender: ChatSenderConfig,
    text: &str,
) -> Result<ProviderSendReceipt, String> {
    match sender {
        ChatSenderConfig::YouTube {
            access_token,
            api_base_url,
            live_chat_id: Some(live_chat_id),
            ..
        } => {
            // Plan 094: a send costs 50 units; none goes out while the quota
            // breaker is set, and a quota refusal sets it.
            crate::youtube_chat::send_youtube_chat_message_guarded(
                state,
                client,
                api_base_url.as_deref(),
                &access_token,
                &live_chat_id,
                text,
            )
            .await
        }
        ChatSenderConfig::YouTube {
            live_chat_id: None, ..
        } => Err("YouTube live chat is not resolved yet. Try again in a moment.".to_string()),
        ChatSenderConfig::Twitch(config) => {
            crate::twitch_chat::send_twitch_chat_message(client, &config, text).await
        }
        ChatSenderConfig::Kick(config) => {
            crate::kick_chat::send_kick_chat_message(client, &config, text).await
        }
        ChatSenderConfig::X { broadcast_id } => {
            // X caps messages at 140 chars while the shared composer allows
            // more; fail the X leg honestly instead of truncating — the
            // partial-send phase already renders per-destination failures.
            if text.chars().count() > crate::x_live::X_CHAT_MESSAGE_MAX_CHARS {
                return Err(format!(
                    "X limits chat messages to {} characters. Shorten the message to reach X.",
                    crate::x_live::X_CHAT_MESSAGE_MAX_CHARS
                ));
            }
            let credentials = crate::x_live::x_livestream_credentials()
                .ok()
                .flatten()
                .ok_or_else(|| {
                    "X Live authorization is missing. Authorize X Live to send chat.".to_string()
                })?;
            crate::x_live::send_broadcast_chat_message(
                client,
                &credentials,
                crate::x_live::DEFAULT_API_BASE_URL,
                &broadcast_id,
                text,
            )
            .await
            .map(|timestamp| ProviderSendReceipt {
                provider_message_id: (!timestamp.is_empty()).then_some(timestamp),
            })
        }
        ChatSenderConfig::Fake(behavior)
        | ChatSenderConfig::FakeModerated { send: behavior, .. } => match behavior {
            FakeChatSendBehavior::Sent => Ok(ProviderSendReceipt {
                provider_message_id: Some(format!("fake-sent-{}", uuid::Uuid::new_v4())),
            }),
            FakeChatSendBehavior::Failed => Err("Fake provider rejected the send.".to_string()),
            FakeChatSendBehavior::Timeout => {
                sleep(CHAT_SEND_TIMEOUT + Duration::from_millis(250)).await;
                Ok(ProviderSendReceipt {
                    provider_message_id: Some("fake-timeout-late".to_string()),
                })
            }
        },
        #[cfg(test)]
        ChatSenderConfig::FakeProbe {
            behavior,
            probe,
            delay,
        } => {
            let _active = probe.begin();
            if !delay.is_zero() {
                sleep(delay).await;
            }
            match behavior {
                FakeChatSendBehavior::Sent => Ok(ProviderSendReceipt {
                    provider_message_id: Some(format!("fake-probe-{}", uuid::Uuid::new_v4())),
                }),
                FakeChatSendBehavior::Failed => Err("Fake provider rejected the send.".to_string()),
                FakeChatSendBehavior::Timeout => {
                    sleep(CHAT_SEND_TIMEOUT + Duration::from_millis(25)).await;
                    Ok(ProviderSendReceipt {
                        provider_message_id: Some("fake-probe-timeout-late".to_string()),
                    })
                }
            }
        }
    }
}

/// Stop the active chat session, aborting connectors and marking providers ended.
pub async fn stop_live_chat(state: &AppState) -> LiveChatSnapshot {
    stop_live_chat_before_snapshot_emit(
        state,
        std::future::ready(()),
        crate::captions::ListenStop::Abort,
    )
    .await
}

/// `session.stop`: the chat session ends with the capture. Orcle stops too,
/// but a listen-only transcription task drains with the capture so the
/// stream's last words still reach its SRT and Clip that (plan 068 review).
pub async fn stop_live_chat_for_capture_end(state: &AppState) -> LiveChatSnapshot {
    stop_live_chat_before_snapshot_emit(
        state,
        std::future::ready(()),
        crate::captions::ListenStop::DrainIfCapturing,
    )
    .await
}

async fn stop_live_chat_before_snapshot_emit<F>(
    state: &AppState,
    before_snapshot_emit: F,
    listen_stop: crate::captions::ListenStop,
) -> LiveChatSnapshot
where
    F: std::future::Future<Output = ()>,
{
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (kick_cleanup, ended_session) = {
        let mut coordinator = state.live_chat.lock().await;
        if let Some(session_id) = coordinator.session_id() {
            crate::youtube_quota::log_usage_summary(state, session_id, "session end");
        }
        let ended_session = coordinator.session_id().map(str::to_string);
        let kick_cleanup = coordinator.kick_cleanup_account();
        coordinator.stop_session();
        (kick_cleanup, ended_session)
    };
    spawn_kick_cleanup(state, kick_cleanup);
    if let Some(session_id) = ended_session {
        // Plan 140: a removal card still open when the session ends is
        // cancelled; nothing may act on a session that is over.
        crate::live_chat_moderation::note_session_ended(state, session_id);
    }
    crate::cohost::stop_cohost_for_session_end_under_lifecycle_fence(
        state,
        &lifecycle_delivery,
        listen_stop,
    )
    .await;
    let snapshot = current_status(state).await;
    before_snapshot_emit.await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    drop(lifecycle_delivery);
    snapshot
}

/// Stop only the chat runtime owned by `expected_session_id`. Recording
/// monitors call this after retiring their exact recording slot, so a late
/// monitor can never tear down a replacement session. The lifecycle delivery
/// fence also waits out any explicit start that is still attaching connector
/// handles and send credentials before the exact-session check commits.
pub(crate) async fn stop_live_chat_for_session(
    state: &AppState,
    expected_session_id: &str,
) -> Option<LiveChatSnapshot> {
    stop_live_chat_for_session_before_cohost_emit(
        state,
        expected_session_id,
        std::future::ready(()),
    )
    .await
}

async fn stop_live_chat_for_session_before_cohost_emit<F>(
    state: &AppState,
    expected_session_id: &str,
    before_cohost_emit: F,
) -> Option<LiveChatSnapshot>
where
    F: std::future::Future<Output = ()>,
{
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let stopped = {
        let mut coordinator = state.live_chat.lock().await;
        if coordinator.session_id() == Some(expected_session_id) {
            crate::youtube_quota::log_usage_summary(state, expected_session_id, "session end");
            let kick_cleanup = coordinator.kick_cleanup_account();
            coordinator.stop_session();
            Some(kick_cleanup)
        } else {
            None
        }
    };
    let kick_cleanup = stopped?;
    spawn_kick_cleanup(state, kick_cleanup);
    crate::live_chat_moderation::note_session_ended(state, expected_session_id.to_string());

    crate::cohost::stop_cohost_for_session_end_if_matching_before_emit(
        state,
        expected_session_id,
        &lifecycle_delivery,
        before_cohost_emit,
    )
    .await;
    let snapshot = current_status(state).await;
    state.emit_event("liveChat.snapshot", snapshot.clone());
    drop(lifecycle_delivery);
    Some(snapshot)
}

/// Kick event subscriptions and the relay binding end with the session
/// (plan 063, S5). Best effort, off the stop path.
fn spawn_kick_cleanup(state: &AppState, account_id: Option<String>) {
    if let Some(account_id) = account_id {
        tokio::spawn(crate::kick_chat::end_kick_chat_session(
            state.clone(),
            account_id,
        ));
    }
}

/// Whether the active view already holds this message id.
pub(crate) async fn has_message(state: &AppState, message_id: &str) -> bool {
    state.live_chat.lock().await.seen.contains(message_id)
}

/// The parent of a reply, when this session already holds it. Platforms that
/// relay only the parent id (Kick) get the author and text from here.
pub(crate) async fn find_reply_parent(
    state: &AppState,
    platform: StreamPlatform,
    target_id: Option<&str>,
    parent_provider_message_id: &str,
) -> Option<LiveChatReply> {
    let coordinator = state.live_chat.lock().await;
    let session_id = coordinator.session_id()?;
    let id = live_chat_message_id(session_id, platform, target_id, parent_provider_message_id);
    coordinator
        .messages
        .iter()
        .rev()
        .find(|message| message.id == id)
        .map(|parent| LiveChatReply {
            parent_message_id: parent_provider_message_id.to_string(),
            parent_author_name: parent.author_name.clone(),
            parent_text: parent.message_text.clone(),
        })
}

/// Clear the local message view (not platform messages) and emit `liveChat.cleared`.
pub async fn clear_local_live_chat(state: &AppState) -> LiveChatSnapshot {
    clear_local_live_chat_before_snapshot_emit(state, std::future::ready(())).await
}

async fn clear_local_live_chat_before_snapshot_emit<F>(
    state: &AppState,
    before_snapshot_emit: F,
) -> LiveChatSnapshot
where
    F: std::future::Future<Output = ()>,
{
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    {
        let mut coordinator = state.live_chat.lock().await;
        coordinator.clear_local();
    }
    let snapshot = current_status(state).await;
    before_snapshot_emit.await;
    state.emit_event("liveChat.cleared", snapshot.clone());
    drop(lifecycle_delivery);
    snapshot
}

/// Current status: the live coordinator view when a session is active or has a transcript,
/// otherwise the setup-time capability snapshot.
pub async fn current_status(state: &AppState) -> LiveChatSnapshot {
    let now = chrono::Utc::now().to_rfc3339();
    let live_view = {
        let coordinator = state.live_chat.lock().await;
        if coordinator.has_session_view() {
            Some(coordinator.snapshot(now.clone()))
        } else {
            None
        }
    };
    if let Some(snapshot) = live_view {
        return snapshot;
    }
    let accounts = state.database.list_platform_accounts().unwrap_or_default();
    initial_chat_snapshot(&accounts, now)
}

/// Current live-chat diagnostics for the `liveChat.diagnostics` command.
pub async fn current_diagnostics(state: &AppState) -> LiveChatDiagnostics {
    state.live_chat.lock().await.diagnostics()
}

/// Test convenience for injecting a message from the currently owned connector session.
#[cfg(test)]
pub(crate) async fn deliver_message(state: &AppState, message: LiveChatMessage) -> bool {
    let session_generation = state.live_chat.lock().await.session_generation();
    try_deliver_message(state, session_generation, message)
        .await
        .is_ok()
}

pub(crate) async fn try_deliver_message(
    state: &AppState,
    expected_session_generation: u64,
    message: LiveChatMessage,
) -> std::result::Result<(), LiveChatPersistenceFailure> {
    try_deliver_messages(state, expected_session_generation, vec![message]).await
}

fn chatter_key(platform: StreamPlatform, author_id: &str) -> String {
    format!("{}:{author_id}", stream_platform_id(platform))
}

/// Chat and tips count toward "first time"; notices and system rows do not.
fn counts_as_chatter(message: &LiveChatMessage) -> bool {
    matches!(
        message.event_type,
        LiveChatEventType::Message | LiveChatEventType::Paid
    ) && !message.is_deleted
}

/// Marks the first message of each author no earlier session saw (plan 055).
/// Runs before ingest, outside every delivery fence: one indexed query per
/// batch of new authors, off the async runtime. A database error marks nothing
/// rather than guessing; Twitch's own `user_intro` flag is kept as sent.
async fn mark_first_time_chatters(
    state: &AppState,
    mut messages: Vec<LiveChatMessage>,
) -> Vec<LiveChatMessage> {
    let (session_id, fresh) = {
        let coordinator = state.live_chat.lock().await;
        let Some(session_id) = coordinator.session_id.clone() else {
            return messages;
        };
        let mut fresh: Vec<(StreamPlatform, String)> = Vec::new();
        for message in &messages {
            let Some(author_id) = message.author_id.as_deref() else {
                continue;
            };
            if !counts_as_chatter(message)
                || coordinator
                    .chatters_seen
                    .contains(&chatter_key(message.platform, author_id))
                || fresh
                    .iter()
                    .any(|(platform, seen)| *platform == message.platform && seen == author_id)
            {
                continue;
            }
            fresh.push((message.platform, author_id.to_string()));
        }
        (session_id, fresh)
    };
    if fresh.is_empty() {
        return messages;
    }
    let database = state.database.clone();
    let lookup = fresh.clone();
    let lookup_session_id = session_id.clone();
    let returning = tokio::task::spawn_blocking(move || {
        database.live_chat_returning_authors(&lookup_session_id, &lookup)
    })
    .await;
    if let Ok(Ok(returning)) = returning {
        let mut marked = HashSet::new();
        for message in &mut messages {
            let Some(author_id) = message.author_id.clone() else {
                continue;
            };
            let key = chatter_key(message.platform, &author_id);
            if !counts_as_chatter(message)
                || !fresh
                    .iter()
                    .any(|(platform, seen)| *platform == message.platform && *seen == author_id)
                || !marked.insert(key.clone())
            {
                continue;
            }
            if !returning.contains(&key) {
                message.first_message = true;
            }
        }
    }
    let mut coordinator = state.live_chat.lock().await;
    if coordinator.session_id.as_deref() == Some(session_id.as_str()) {
        for (platform, author_id) in fresh {
            coordinator
                .chatters_seen
                .insert(chatter_key(platform, &author_id));
        }
    }
    messages
}

/// Turn 7TV emote names into image fragments (plan 089) before the buffer,
/// SQLite, the renderer, the phone and Orcle see the message, so they all
/// agree. A pure lookup in the session's loaded index, outside every fence;
/// it never touches the network.
async fn decorate_seventv_emotes(
    state: &AppState,
    mut messages: Vec<LiveChatMessage>,
) -> Vec<LiveChatMessage> {
    let indexes = state.live_chat.lock().await.seventv_indexes();
    crate::seventv::decorate(&mut messages, &indexes);
    messages
}

/// Persist and emit one sequential provider delivery as one atomic transaction. The
/// delivery guard plus constant-size per-message undo records make a terminal
/// persistence failure retryable without cloning the full transcript. Transient
/// database failures remain inside the worker and apply backpressure.
pub(crate) async fn try_deliver_messages(
    state: &AppState,
    expected_session_generation: u64,
    messages: Vec<LiveChatMessage>,
) -> std::result::Result<(), LiveChatPersistenceFailure> {
    if messages.is_empty() {
        return Ok(());
    }
    let messages = mark_first_time_chatters(state, messages).await;
    let messages = decorate_seventv_emotes(state, messages).await;
    let coordinator_inputs = messages.clone();
    let _delivery = state.live_chat_persistence.begin_delivery().await;
    let (delivery_generation, delivery_session_id, undos, authoritative_messages) = {
        // Coordinator ingest can turn an eligible message into a tombstone.
        // Publish that authority under the same short fence used by the final
        // highlight install; persistence remains outside the fence below.
        let _highlight_commit = state.comment_highlight_commit.lock().await;
        let mut coordinator = state.live_chat.lock().await;
        let Some(delivery_session_id) = coordinator.session_id.clone() else {
            return Err(LiveChatPersistenceFailure::terminal(
                "Live-chat delivery arrived after its session ended.",
            ));
        };
        if coordinator.session_generation() != expected_session_generation {
            return Err(LiveChatPersistenceFailure::terminal(
                "Live-chat delivery came from a replaced connector session.",
            ));
        }
        if messages
            .iter()
            .any(|message| message.session_id != delivery_session_id)
        {
            return Err(LiveChatPersistenceFailure::terminal(
                "Live-chat delivery belonged to a replaced session.",
            ));
        }
        let delivery_generation = coordinator.generation;
        let mut undos = Vec::with_capacity(messages.len());
        let mut authoritative_messages = Vec::with_capacity(messages.len());
        for message in messages {
            // Ordinary retained duplicates never reach SQLite. Validate their
            // immutable owner before that fast path can hide a conflicting ID.
            // Only the bounded retained buffer is inspected; no lifetime set.
            if coordinator.seen.contains(&message.id)
                && coordinator.messages.iter().any(|existing| {
                    existing.id == message.id
                        && (existing.session_id != message.session_id
                            || existing.platform != message.platform
                            || existing.target_id != message.target_id
                            || existing.provider_message_id != message.provider_message_id)
                })
            {
                for undo in undos.into_iter().rev() {
                    coordinator.rollback_ingest(undo);
                }
                return Err(LiveChatPersistenceFailure::terminal(
                    "Live-chat message identity conflicts with its retained owner.",
                ));
            }
            let ingested = coordinator.ingest_reversible(message);
            match ingested.outcome {
                IngestOutcome::New(message) | IngestOutcome::Updated(message) => {
                    authoritative_messages.push(message);
                }
                IngestOutcome::Duplicate => {}
            }
            undos.push(ingested.undo);
        }
        (
            delivery_generation,
            delivery_session_id,
            undos,
            authoritative_messages,
        )
    };
    if authoritative_messages.is_empty() {
        return Ok(());
    }
    let persisted_messages = match state
        .live_chat_persistence
        .persist_batch(authoritative_messages.clone())
        .await
    {
        Ok(messages) => messages,
        Err(error) => {
            let _highlight_commit = state.comment_highlight_commit.lock().await;
            let mut coordinator = state.live_chat.lock().await;
            for undo in undos.into_iter().rev() {
                coordinator.rollback_ingest(undo);
            }
            drop(coordinator);
            state.emit_log(
            "warn",
            format!(
                "Could not persist {} live chat message(s); exact-message retry remains eligible: {error}",
                authoritative_messages.len()
            ),
        );
            return Err(error);
        }
    };
    if persisted_messages.len() != authoritative_messages.len()
        || persisted_messages
            .iter()
            .zip(&authoritative_messages)
            .any(|(persisted, admitted)| {
                persisted.id != admitted.id
                    || persisted.session_id != admitted.session_id
                    || persisted.platform != admitted.platform
                    || persisted.target_id != admitted.target_id
                    || persisted.provider_message_id != admitted.provider_message_id
            })
    {
        let _highlight_commit = state.comment_highlight_commit.lock().await;
        let mut coordinator = state.live_chat.lock().await;
        for undo in undos.into_iter().rev() {
            coordinator.rollback_ingest(undo);
        }
        return Err(LiveChatPersistenceFailure::terminal(
            "Live-chat persistence returned a mismatched delivery owner.",
        ));
    }
    let _highlight_commit = state.comment_highlight_commit.lock().await;
    let delivery_still_current = {
        let coordinator = state.live_chat.lock().await;
        coordinator.generation == delivery_generation
            && coordinator.session_id.as_deref() == Some(delivery_session_id.as_str())
    };
    if !delivery_still_current {
        state.emit_log(
            "warn",
            "Persisted live-chat delivery was suppressed because its session was replaced.",
        );
        return Err(LiveChatPersistenceFailure::terminal(
            "Live-chat delivery completed after its session was replaced.",
        ));
    }
    let replayed_tombstones: HashSet<_> = persisted_messages
        .iter()
        .zip(&authoritative_messages)
        .filter(|(persisted, admitted)| persisted.is_deleted && !admitted.is_deleted)
        .map(|(persisted, _)| persisted.id.as_str())
        .collect();
    if !replayed_tombstones.is_empty() {
        // Restore compact batch undo records, then replay only real admissions.
        // A stored deletion encountered after clear/eviction is not new chat:
        // it must not alter unread, receive/trim counters or cohost publication.
        let mut coordinator = state.live_chat.lock().await;
        for undo in undos.into_iter().rev() {
            coordinator.rollback_ingest(undo);
        }
        for message in coordinator_inputs {
            if !replayed_tombstones.contains(message.id.as_str()) {
                coordinator.ingest(message);
            }
        }
    }
    let authoritative_messages: Vec<_> = persisted_messages
        .iter()
        .filter(|message| !replayed_tombstones.contains(message.id.as_str()))
        .cloned()
        .collect();
    for message in &authoritative_messages {
        if message.is_deleted {
            crate::comment_highlight::clear_comment_highlight_for_message_under_commit_fence(
                state,
                &message.session_id,
                &message.id,
            )
            .await;
        }
        state.emit_event("liveChat.message", message);
    }
    // A confirmed persisted snapshot, independent of the bounded paint buffer
    // and unread owner. Reconnect/lag readers hydrate it through the totals RPC.
    if let Ok(Some(totals)) = state.database.session_chat_totals(&delivery_session_id) {
        state.emit_event("liveChat.totals", totals);
    }
    drop(_highlight_commit);
    crate::cohost::note_messages_under_lifecycle_fence(state, &_delivery, &authoritative_messages)
        .await;
    Ok(())
}

/// Set a provider's connection state and emit `liveChat.providerStatus`.
pub(crate) async fn set_provider_and_emit(
    state: &AppState,
    expected_session_id: &str,
    expected_generation: u64,
    platform: StreamPlatform,
    target_id: Option<&str>,
    connection: LiveChatProviderConnectionState,
    message: &str,
) -> bool {
    set_provider_and_emit_with_hooks(
        state,
        (expected_session_id, expected_generation),
        platform,
        target_id,
        (connection, None),
        message,
        (std::future::ready(()), std::future::ready(())),
    )
    .await
}

/// `Waiting` with a known resume time: the provider parks until `retry_at`
/// (plan 094, the YouTube quota pause) and the renderer shows the local time.
pub(crate) async fn set_provider_waiting_and_emit(
    state: &AppState,
    expected_session_id: &str,
    expected_generation: u64,
    platform: StreamPlatform,
    target_id: Option<&str>,
    message: &str,
    retry_at: &str,
) -> bool {
    set_provider_and_emit_with_hooks(
        state,
        (expected_session_id, expected_generation),
        platform,
        target_id,
        (LiveChatProviderConnectionState::Waiting, Some(retry_at)),
        message,
        (std::future::ready(()), std::future::ready(())),
    )
    .await
}

async fn set_provider_and_emit_with_hooks<F, G>(
    state: &AppState,
    expected_owner: (&str, u64),
    platform: StreamPlatform,
    target_id: Option<&str>,
    transition: (LiveChatProviderConnectionState, Option<&str>),
    message: &str,
    hooks: (F, G),
) -> bool
where
    F: std::future::Future<Output = ()>,
    G: std::future::Future<Output = ()>,
{
    let (connection, retry_at) = transition;
    let (expected_session_id, expected_generation) = expected_owner;
    let (before_mutation, before_emit) = hooks;
    before_mutation.await;
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let now = chrono::Utc::now().to_rfc3339();
    let provider = {
        let mut coordinator = state.live_chat.lock().await;
        if coordinator.session_id.as_deref() != Some(expected_session_id)
            || coordinator.session_generation() != expected_generation
        {
            return false;
        }
        let provider_exists = coordinator.providers.iter().any(|provider| {
            provider.platform == platform
                && target_id
                    .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                    .unwrap_or(true)
        });
        if !provider_exists {
            return false;
        }
        coordinator.set_provider_status(platform, target_id, connection, message, &now);
        coordinator.set_provider_retry_at(platform, target_id, retry_at.map(str::to_string));
        coordinator
            .providers
            .iter()
            .find(|provider| {
                provider.platform == platform
                    && target_id
                        .map(|target_id| provider.target_id.as_deref() == Some(target_id))
                        .unwrap_or(true)
            })
            .cloned()
    };
    before_emit.await;
    if let Some(provider) = provider {
        state.emit_event("liveChat.providerStatus", provider);
        drop(lifecycle_delivery);
        true
    } else {
        false
    }
}

/// The fake connector task: marks its platform connected, delivers `count` messages at
/// `interval_ms`, optionally re-sending the first to exercise de-dup, then marks ended.
async fn run_fake_connector(
    state: AppState,
    session_id: String,
    session_generation: u64,
    config: FakeChatConfig,
) {
    let platform = config.platform;
    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        platform,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Connected,
        "Live chat connected.",
    )
    .await;
    let interval = Duration::from_millis(config.interval_ms.max(1));
    for seq in 0..config.count {
        sleep(interval).await;
        if config.reconnect_at == Some(seq) {
            set_provider_and_emit(
                &state,
                &session_id,
                session_generation,
                platform,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Reconnecting,
                "Fake live chat reconnecting.",
            )
            .await;
            sleep(interval).await;
            set_provider_and_emit(
                &state,
                &session_id,
                session_generation,
                platform,
                config.target_id.as_deref(),
                LiveChatProviderConnectionState::Connected,
                "Fake live chat reconnected.",
            )
            .await;
        }
        let mut message = fake_message_for(&config, &session_id, seq);
        message.author_avatar_url = config.avatar_url.clone();
        if let Some(emote) = &config.emote {
            message.fragments = vec![
                LiveChatMessageFragment {
                    fragment_type: "text".to_string(),
                    text: format!("{} ", message.message_text),
                    image_url: None,
                    zero_width: false,
                },
                LiveChatMessageFragment {
                    fragment_type: "emote".to_string(),
                    text: emote.text.clone(),
                    image_url: Some(emote.image_url.clone()),
                    zero_width: false,
                },
            ];
            message.message_text = format!("{} {}", message.message_text, emote.text);
        }
        if config.out_of_order && seq == 1 {
            let earlier = (chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339();
            message.published_at = earlier.clone();
            message.received_at = earlier;
        }
        let _ = try_deliver_message(&state, session_generation, message).await;
        if config.include_duplicate && seq == 0 {
            let _ = try_deliver_message(
                &state,
                session_generation,
                fake_message_for(&config, &session_id, 0),
            )
            .await;
        }
    }
    if let Some(gif) = &config.gif {
        sleep(interval).await;
        let message = fake_gif_message(&session_id, platform, config.target_id.as_deref(), gif);
        let _ = try_deliver_message(&state, session_generation, message).await;
    }
    if config.events {
        for message in fake_events(&session_id, platform, config.target_id.as_deref()) {
            sleep(interval).await;
            let _ = try_deliver_message(&state, session_generation, message).await;
        }
    }
    set_provider_and_emit(
        &state,
        &session_id,
        session_generation,
        platform,
        config.target_id.as_deref(),
        LiveChatProviderConnectionState::Ended,
        "Live chat ended.",
    )
    .await;
}

/// Build one deterministic fake message. Shared by the fake connector and the unit tests.
/// One of each activity event a platform has, shaped as its connector would
/// normalize it (plan 055 smoke; the parsers' own tests pin the real payloads).
fn fake_events(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
) -> Vec<LiveChatMessage> {
    let event = |kind: &str,
                 author: &str,
                 event_type: LiveChatEventType,
                 details: LiveChatEventDetails,
                 text: &str,
                 amount: Option<&str>| {
        let mut message = fake_message(session_id, platform, target_id, 0);
        message.provider_message_id = format!("fake-event-{kind}");
        message.id = live_chat_message_id(
            session_id,
            platform,
            target_id,
            &message.provider_message_id,
        );
        message.author_id = Some(format!("fake-{author}"));
        message.author_name = author.to_string();
        message.event_type = event_type;
        message.details = Some(details);
        message.message_text = text.to_string();
        message.amount_text = amount.map(str::to_string);
        message.raw_provider_type = Some(kind.to_string());
        message
    };
    let subscription = |kind: SubscriptionKind, months, gift_count, gift_id: Option<&str>| {
        LiveChatEventDetails::Subscription {
            subscription: kind,
            tier: Some("1000".to_string()),
            is_prime: false,
            months,
            streak_months: None,
            gift_count,
            recipient_name: None,
            community_gift_id: gift_id.map(str::to_string),
        }
    };
    match platform {
        StreamPlatform::Twitch => vec![
            event(
                "resub",
                "morgaesis",
                LiveChatEventType::Membership,
                subscription(SubscriptionKind::Resub, Some(8), None, None),
                "morgaesis subscribed at Tier 1. They've subscribed for 8 months!",
                None,
            ),
            event(
                "community-sub-gift",
                "generous",
                LiveChatEventType::Membership,
                subscription(
                    SubscriptionKind::CommunitySubGift,
                    None,
                    Some(5),
                    Some("fake-gift"),
                ),
                "generous is gifting 5 Tier 1 Subs!",
                None,
            ),
            event(
                "cheer",
                "sarzdotmd",
                LiveChatEventType::Paid,
                LiveChatEventDetails::Cheer { bits: 1500 },
                "Cheer1500 fake cheer",
                Some("1500 bits"),
            ),
            event(
                "raid",
                "raider42",
                LiveChatEventType::System,
                LiveChatEventDetails::Raid { viewer_count: 234 },
                "234 raiders from raider42 have joined!",
                None,
            ),
            {
                // Shaped as the real notice (plan 151): Twitch's sentence in
                // the text, the viewer's own words in the fragments.
                let mut streak = event(
                    "channel.chat.notification:watch_streak",
                    "loyal_lurker",
                    LiveChatEventType::System,
                    LiveChatEventDetails::WatchStreak {
                        streak_count: 20,
                        channel_points_awarded: Some(450),
                    },
                    "loyal_lurker watched 20 consecutive streams and sparked a watch streak!",
                    None,
                );
                streak.provider_message_id = "fake-event-watch-streak".to_string();
                streak.id = live_chat_message_id(
                    session_id,
                    platform,
                    target_id,
                    &streak.provider_message_id,
                );
                streak.fragments = vec![LiveChatMessageFragment {
                    fragment_type: "text".to_string(),
                    text: "welcome back! hope everything is good".to_string(),
                    image_url: None,
                    zero_width: false,
                }];
                streak
            },
            event(
                "follow",
                "new_friend",
                LiveChatEventType::Follow,
                LiveChatEventDetails::Follow {
                    handle: Some("new_friend".to_string()),
                },
                "new_friend followed",
                None,
            ),
        ],
        StreamPlatform::Kick => vec![
            event(
                "channel.followed",
                "kick_fan",
                LiveChatEventType::Follow,
                LiveChatEventDetails::Follow {
                    handle: Some("kick_fan".to_string()),
                },
                "kick_fan followed",
                None,
            ),
            event(
                "kicks.gifted",
                "kick_tipper",
                LiveChatEventType::Paid,
                LiveChatEventDetails::Kicks {
                    amount: 500,
                    gift_name: Some("Rage Quit".to_string()),
                },
                "w",
                Some("500 KICKs"),
            ),
        ],
        StreamPlatform::Youtube => vec![
            event(
                "super-chat",
                "Maria",
                LiveChatEventType::Paid,
                LiveChatEventDetails::SuperChat {
                    amount_micros: 5_000_000,
                    currency: "USD".to_string(),
                    amount_display: "$5.00".to_string(),
                    tier: Some(2),
                },
                "Great stream!",
                Some("$5.00"),
            ),
            event(
                "super-sticker",
                "Jonas",
                LiveChatEventType::Paid,
                LiveChatEventDetails::SuperSticker {
                    amount_micros: 2_000_000,
                    currency: "EUR".to_string(),
                    amount_display: "€2.00".to_string(),
                    alt_text: Some("Party hat".to_string()),
                },
                "",
                Some("€2.00"),
            ),
            event(
                "membership",
                "Newbie",
                LiveChatEventType::Membership,
                LiveChatEventDetails::Membership {
                    membership: MembershipKind::New,
                    level_name: Some("Gold".to_string()),
                    months: None,
                    gift_count: None,
                },
                "Welcome to Gold!",
                None,
            ),
        ],
        _ => Vec::new(),
    }
}

/// One scripted message for a fake lane, with its configured author.
/// One Twitch GIF Keyboard row as the connector would normalize it (plan
/// 154): a plain message whose only fragment is the GIF, text the bracketed
/// title, from a Tier 2 subscriber.
fn fake_gif_message(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
    gif: &FakeChatGif,
) -> LiveChatMessage {
    let mut message = fake_message(session_id, platform, target_id, 0);
    message.provider_message_id = "fake-gif".to_string();
    message.id = live_chat_message_id(
        session_id,
        platform,
        target_id,
        &message.provider_message_id,
    );
    message.author_id = Some("fake-gif-sender".to_string());
    message.author_name = "Tier2Fan".to_string();
    message.author_badges = vec!["subscriber".to_string()];
    message.author_roles = vec!["member".to_string()];
    message.message_text = gif.title.clone();
    message.fragments = vec![LiveChatMessageFragment {
        fragment_type: "gif".to_string(),
        text: gif.title.clone(),
        image_url: Some(gif.image_url.clone()),
        zero_width: false,
    }];
    message.raw_provider_type = Some("channel.chat.message".to_string());
    message
}

fn fake_message_for(config: &FakeChatConfig, session_id: &str, seq: u32) -> LiveChatMessage {
    let mut message = fake_message(
        session_id,
        config.platform,
        config.target_id.as_deref(),
        seq,
    );
    if !config.authors.is_empty() {
        let author = &config.authors[seq as usize % config.authors.len()];
        message.author_id = Some(format!("fake-author-{}", author.to_lowercase()));
        message.author_name = author.clone();
    }
    message
}

fn fake_message(
    session_id: &str,
    platform: StreamPlatform,
    target_id: Option<&str>,
    seq: u32,
) -> LiveChatMessage {
    let now = chrono::Utc::now().to_rfc3339();
    let provider_message_id = format!("fake-{seq}");
    LiveChatMessage {
        id: live_chat_message_id(session_id, platform, target_id, &provider_message_id),
        provider_message_id,
        platform,
        target_id: target_id.map(str::to_string),
        session_id: session_id.to_string(),
        author_id: Some(format!("fake-author-{}", seq % 3)),
        author_name: format!("Test Viewer {}", seq % 3),
        author_avatar_url: None,
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at: now.clone(),
        received_at: now,
        message_text: format!("Fake chat message #{seq}"),
        fragments: Vec::new(),
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: Some("fake".to_string()),
        details: None,
        reply: None,
        first_message: false,
        author_affiliation: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use crate::streaming::PlatformAccountStatus;
    use tokio::sync::broadcast;

    // Plan 071, S5: follow rows stored before the handle existed still load,
    // and a follow without one keeps its exact old wire shape.
    #[test]
    fn follow_details_keep_their_wire_shape_and_read_old_rows() {
        let old: LiveChatEventDetails = serde_json::from_str(r#"{"kind":"follow"}"#).unwrap();
        assert_eq!(old, LiveChatEventDetails::Follow { handle: None });
        assert_eq!(
            serde_json::to_value(LiveChatEventDetails::Follow { handle: None }).unwrap(),
            serde_json::json!({ "kind": "follow" })
        );
        assert_eq!(
            serde_json::to_value(LiveChatEventDetails::Follow {
                handle: Some("cool_user".to_string())
            })
            .unwrap(),
            serde_json::json!({ "kind": "follow", "handle": "cool_user" })
        );
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test]
    async fn first_time_chatters_are_marked_once_and_regulars_never() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("earlier")
            .unwrap();
        let mut earlier = fake_message("earlier", StreamPlatform::Twitch, None, 1);
        earlier.author_id = Some("regular".to_string());
        state.database.save_live_chat_message(&earlier).unwrap();

        state
            .database
            .ensure_fake_live_chat_session("current")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("current".to_string(), Vec::new());
        let with_author = |seq: u32, author: &str| {
            let mut message = fake_message("current", StreamPlatform::Twitch, None, seq);
            message.author_id = Some(author.to_string());
            message
        };
        assert!(deliver_message(&state, with_author(2, "regular")).await);
        assert!(deliver_message(&state, with_author(3, "newcomer")).await);
        assert!(deliver_message(&state, with_author(4, "newcomer")).await);

        let first = |provider_message_id: &str| {
            state
                .database
                .list_live_chat_messages_recent("current", 10)
                .unwrap()
                .into_iter()
                .find(|message| message.provider_message_id == provider_message_id)
                .unwrap()
                .first_message
        };
        assert!(
            !first("fake-2"),
            "a regular from an earlier session is not new"
        );
        assert!(first("fake-3"), "a newcomer's first message is marked");
        assert!(!first("fake-4"), "only the first message is marked");
    }

    #[tokio::test]
    async fn seventv_loads_only_with_an_endpoint_and_a_channel_to_look_up() {
        let state = test_state();
        let with_account = |platform: StreamPlatform, account_id: &str| LiveChatProviderState {
            account_id: Some(account_id.to_string()),
            ..provider_row(platform)
        };
        let start = |providers: Vec<LiveChatProviderState>| {
            let state = state.clone();
            async move {
                let mut coordinator = state.live_chat.lock().await;
                coordinator.start_session("s".to_string(), providers);
                coordinator.session_generation()
            }
        };

        // Unit tests start with 7TV off: no task, so no network.
        assert_eq!(state.live_chat.lock().await.seventv_endpoint(), None);
        let generation = start(vec![with_account(StreamPlatform::Twitch, "1")]).await;
        start_seventv_for_session(&state, generation).await;
        assert!(!state.live_chat.lock().await.seventv_running());

        // On, but only X and an account-less Kick row: nothing to look up.
        state
            .live_chat
            .lock()
            .await
            .set_seventv_endpoint(Some("http://127.0.0.1:9/v4/gql".to_string()));
        let generation = start(vec![
            with_account(StreamPlatform::X, "x-user"),
            provider_row(StreamPlatform::Kick),
        ])
        .await;
        start_seventv_for_session(&state, generation).await;
        assert!(!state.live_chat.lock().await.seventv_running());

        // On with a YouTube channel: the loader runs beside the connectors
        // (never counted as one), and a stop aborts it with them.
        let generation = start(vec![with_account(StreamPlatform::Youtube, "UC1")]).await;
        start_seventv_for_session(&state, generation).await;
        assert!(state.live_chat.lock().await.seventv_running());
        assert_eq!(state.live_chat.lock().await.runtime_ownership().0, 0);
        state.live_chat.lock().await.stop_session();
        assert!(!state.live_chat.lock().await.seventv_running());
    }

    #[tokio::test]
    async fn the_settings_switch_stops_and_starts_7tv_mid_stream() {
        use crate::seventv::{ChatEmoteSettingsPatch, SevenTvState};
        let state = test_state();
        let switch = |on: bool| ChatEmoteSettingsPatch {
            seven_tv: Some(on),
            twitch_gifs: None,
        };
        // On by default, with nothing loaded yet in this app run.
        let initial = crate::seventv::current_state(&state).await;
        assert!(initial.seven_tv);
        assert_eq!(initial.seven_tv_status.state, SevenTvState::Idle);
        assert_eq!(
            serde_json::to_value(&initial).unwrap(),
            serde_json::json!({
                "sevenTv": true,
                "sevenTvStatus": { "state": "idle" },
                "twitchGifs": "animated"
            })
        );

        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.set_seventv_endpoint(Some("http://127.0.0.1:9/v4/gql".to_string()));
            coordinator.start_session(
                "s".to_string(),
                vec![LiveChatProviderState {
                    account_id: Some("1".to_string()),
                    ..provider_row(StreamPlatform::Twitch)
                }],
            );
            coordinator.session_generation()
        };
        start_seventv_for_session(&state, generation).await;
        assert!(state.live_chat.lock().await.seventv_running());

        // Off: the loader stops at once, the setting persists, and a new
        // session does not start it.
        let off = crate::seventv::set_settings(&state, switch(false))
            .await
            .unwrap();
        assert!(!off.seven_tv);
        assert_eq!(off.seven_tv_status.state, SevenTvState::Off);
        assert!(!state.live_chat.lock().await.seventv_running());
        assert!(!crate::seventv::load_settings(&state).seven_tv);
        start_seventv_for_session(&state, generation).await;
        assert!(!state.live_chat.lock().await.seventv_running());

        // On again mid-stream: it loads without waiting for the next Go Live.
        let on = crate::seventv::set_settings(&state, switch(true))
            .await
            .unwrap();
        assert!(on.seven_tv);
        assert_ne!(on.seven_tv_status.state, SevenTvState::Off);
        assert!(state.live_chat.lock().await.seventv_running());

        // An unknown field is refused rather than ignored.
        assert!(
            serde_json::from_value::<ChatEmoteSettingsPatch>(
                serde_json::json!({ "sevenTv": true, "bttv": true })
            )
            .is_err()
        );
    }

    fn empty_start_params(session_id: &str) -> LiveChatStartParams {
        serde_json::from_value(serde_json::json!({
            "sessionId": session_id,
            "platforms": []
        }))
        .expect("empty live-chat start params")
    }

    async fn poll_future_once<F>(mut future: std::pin::Pin<&mut F>) -> Option<F::Output>
    where
        F: std::future::Future,
    {
        std::future::poll_fn(|context| {
            std::task::Poll::Ready(match future.as_mut().poll(context) {
                std::task::Poll::Ready(output) => Some(output),
                std::task::Poll::Pending => None,
            })
        })
        .await
    }

    fn drain_live_chat_publications(
        events: &mut broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<(String, Option<String>)> {
        let mut publications = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "liveChat.snapshot" || event.event == "liveChat.cleared" {
                publications.push((
                    event.event,
                    event
                        .payload
                        .get("sessionId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                ));
            }
        }
        publications
    }

    fn drain_live_chat_state_publication_names(
        events: &mut broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<String> {
        let mut publications = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "liveChat.snapshot" || event.event == "liveChat.providerStatus" {
                publications.push(event.event);
            }
        }
        publications
    }

    fn account(platform: StreamPlatform, scopes: &[&str]) -> PlatformAccount {
        PlatformAccount {
            id: "acct".to_string(),
            platform,
            account_id: "channel-1".to_string(),
            account_label: "Test Channel".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            access_token_present: true,
            refresh_token_present: true,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-06T00:00:00Z".to_string(),
            updated_at: "2026-06-06T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        }
    }

    fn provider_row(platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            id: comments_destination_id(platform, None),
            platform,
            target_id: None,
            account_id: None,
            account_label: None,
            read: CommentsReadState::Connecting,
            write: CommentsWriteState::Unavailable,
            moderate: None,
            state: LiveChatProviderConnectionState::Connecting,
            message: "Connecting…".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    fn connected_provider(id: &str, platform: StreamPlatform) -> LiveChatProviderState {
        LiveChatProviderState {
            id: id.to_string(),
            platform,
            target_id: Some(id.to_string()),
            account_id: Some(format!("{id}-account")),
            account_label: Some(format!("{id} account")),
            read: CommentsReadState::Ready,
            write: if platform == StreamPlatform::X {
                CommentsWriteState::ReadOnly
            } else {
                CommentsWriteState::Ready
            },
            moderate: None,
            state: LiveChatProviderConnectionState::Connected,
            message: "Comments connected.".to_string(),
            last_connected_at: Some("2026-07-10T00:00:00Z".to_string()),
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    async fn send_test_state(
        session_id: &str,
        providers: Vec<LiveChatProviderState>,
        senders: Vec<(String, ChatSenderConfig)>,
    ) -> AppState {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .database
            .ensure_fake_live_chat_session(session_id)
            .unwrap();
        {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(session_id.to_string(), providers);
            for (destination_id, sender) in senders {
                coordinator.register_sender(destination_id, sender);
            }
        }
        state
    }

    fn send_params(operation_id: &str, session_id: &str, text: &str) -> CommentsSendParams {
        CommentsSendParams {
            operation_id: operation_id.to_string(),
            session_id: session_id.to_string(),
            text: text.to_string(),
            in_reply_to_question_id: None,
            destination_ids: None,
        }
    }

    /// Plan 155: the fake connector's GIF row is shaped like the real one, so
    /// the fake-providers smoke exercises the same renderer path.
    #[test]
    fn the_fake_twitch_gif_row_is_a_plain_message_with_one_gif_fragment() {
        let gif = FakeChatGif {
            title: "[Y A Y Yes GIF]".to_string(),
            image_url: "https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif".to_string(),
        };
        let message = fake_gif_message("s1", StreamPlatform::Twitch, None, &gif);
        assert_eq!(message.event_type, LiveChatEventType::Message);
        assert_eq!(message.message_text, "[Y A Y Yes GIF]");
        assert_eq!(message.fragments.len(), 1);
        assert_eq!(message.fragments[0].fragment_type, "gif");
        assert_eq!(
            message.fragments[0].image_url.as_deref(),
            Some(gif.image_url.as_str())
        );
        assert_eq!(message.author_roles, vec!["member".to_string()]);
        assert_eq!(message.provider_message_id, "fake-gif");
        assert_eq!(
            message.id,
            fake_gif_message("s1", StreamPlatform::Twitch, None, &gif).id
        );
        assert!(message.details.is_none());
        // Deserialized from the smoke's JSON config, camelCase.
        let config: FakeChatConfig = serde_json::from_value(serde_json::json!({
            "platform": "twitch",
            "gif": { "title": "[Y A Y Yes GIF]", "imageUrl": gif.image_url }
        }))
        .unwrap();
        assert_eq!(config.gif.unwrap().title, "[Y A Y Yes GIF]");
    }

    #[test]
    fn activity_events_can_go_on_stream_but_plain_notices_cannot() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![connected_provider("twitch", StreamPlatform::Twitch)],
        );
        let mut raid = fake_message("s1", StreamPlatform::Twitch, None, 1);
        raid.event_type = LiveChatEventType::System;
        raid.details = Some(LiveChatEventDetails::Raid { viewer_count: 234 });
        let mut notice = fake_message("s1", StreamPlatform::Twitch, None, 2);
        notice.event_type = LiveChatEventType::System;
        let mut resub = fake_message("s1", StreamPlatform::Twitch, None, 3);
        resub.event_type = LiveChatEventType::Membership;
        for message in [&raid, &notice, &resub] {
            coordinator.ingest(message.clone());
        }
        assert_eq!(
            coordinator.highlight_message_eligibility("s1", &raid.id),
            HighlightMessageEligibility::Eligible
        );
        assert_eq!(
            coordinator.highlight_message_eligibility("s1", &notice.id),
            HighlightMessageEligibility::Ineligible
        );
        assert_eq!(
            coordinator.highlight_message_eligibility("s1", &resub.id),
            HighlightMessageEligibility::Eligible
        );
    }

    #[tokio::test]
    async fn a_send_reaches_only_the_picked_destinations() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("picked")
            .unwrap();
        {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(
                "picked".to_string(),
                vec![
                    connected_provider("youtube-a", StreamPlatform::Youtube),
                    connected_provider("twitch-a", StreamPlatform::Twitch),
                ],
            );
            coordinator.register_sender(
                "youtube-a".to_string(),
                ChatSenderConfig::Fake(FakeChatSendBehavior::Sent),
            );
            coordinator.register_sender(
                "twitch-a".to_string(),
                ChatSenderConfig::Fake(FakeChatSendBehavior::Sent),
            );
        }
        let mut params = send_params(
            "11111111-2222-4333-8444-555555555555",
            "picked",
            "only twitch",
        );
        params.destination_ids = Some(vec!["twitch-a".to_string()]);
        let operation = send_live_chat_message(&state, params).await.unwrap();
        assert_eq!(
            operation
                .destinations
                .iter()
                .map(|delivery| delivery.destination_id.as_str())
                .collect::<Vec<_>>(),
            vec!["twitch-a"]
        );
        assert_eq!(operation.phase, CommentsSendOperationPhase::Sent);

        let mut none = send_params("11111111-2222-4333-8444-666666666666", "picked", "nowhere");
        none.destination_ids = Some(Vec::new());
        assert!(send_live_chat_message(&state, none).await.is_err());
    }

    #[test]
    fn diagnostics_report_counters_and_provider_errors() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 1));
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0)); // duplicate
        coordinator.set_provider_status(
            StreamPlatform::Youtube,
            None,
            LiveChatProviderConnectionState::Reconnecting,
            "Reconnecting…",
            "now",
        );
        let diagnostics = coordinator.diagnostics();
        assert_eq!(diagnostics.messages_received, 2);
        assert_eq!(diagnostics.duplicates_skipped, 1);
        assert_eq!(diagnostics.reconnect_count, 1);
        assert_eq!(diagnostics.buffered, 2);
        assert_eq!(
            diagnostics.providers[0].last_error.as_deref(),
            Some("Reconnecting…")
        );
    }

    #[test]
    fn coordinator_caps_buffer_and_reports_trimmed_count() {
        let mut coordinator = LiveChatCoordinator::new(3);
        for seq in 0..5 {
            assert!(matches!(
                coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, seq)),
                IngestOutcome::New(_)
            ));
        }
        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(coordinator.trimmed_count(), 2);
        // The two oldest were trimmed; the buffer keeps seq 2, 3, 4 in order.
        assert_eq!(
            snapshot.messages.first().unwrap().provider_message_id,
            "fake-2"
        );
        assert_eq!(
            snapshot.messages.last().unwrap().provider_message_id,
            "fake-4"
        );
    }

    #[test]
    fn full_buffer_reversible_ingest_keeps_constant_size_undo() {
        let mut coordinator = LiveChatCoordinator::new(DEFAULT_MAX_CHAT_MESSAGES);
        coordinator.start_session("s1".to_string(), vec![provider_row(StreamPlatform::Twitch)]);
        for sequence in 0..DEFAULT_MAX_CHAT_MESSAGES as u32 {
            coordinator.ingest(fake_message("s1", StreamPlatform::Twitch, None, sequence));
        }
        let first_id = coordinator.messages.front().unwrap().id.clone();
        let last_id = coordinator.messages.back().unwrap().id.clone();
        let diagnostics = coordinator.diagnostics();

        let ingested = coordinator.ingest_reversible(fake_message(
            "s1",
            StreamPlatform::Twitch,
            None,
            DEFAULT_MAX_CHAT_MESSAGES as u32,
        ));
        assert!(matches!(ingested.outcome, IngestOutcome::New(_)));
        assert_eq!(
            ingested.undo.retained_buffer_rows(),
            1,
            "undo space must stay one row even when the 5,000-row buffer is full"
        );
        coordinator.rollback_ingest(ingested.undo);

        assert_eq!(coordinator.messages.len(), DEFAULT_MAX_CHAT_MESSAGES);
        assert_eq!(coordinator.messages.front().unwrap().id, first_id);
        assert_eq!(coordinator.messages.back().unwrap().id, last_id);
        assert_eq!(coordinator.diagnostics(), diagnostics);
    }

    #[test]
    fn coordinator_skips_duplicate_message_ids() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let message = fake_message("s1", StreamPlatform::Youtube, None, 0);
        assert_eq!(
            coordinator.ingest(message.clone()),
            IngestOutcome::New(message.clone())
        );
        assert_eq!(coordinator.ingest(message), IngestOutcome::Duplicate);
        assert_eq!(coordinator.duplicates_skipped(), 1);
        assert_eq!(coordinator.snapshot("now".to_string()).messages.len(), 1);
    }

    fn deletion_for(mut message: LiveChatMessage, received_at: &str) -> LiveChatMessage {
        message.author_name = "Provider moderation".to_string();
        message.message_text = "A chat message was removed.".to_string();
        message.fragments.clear();
        message.event_type = LiveChatEventType::Deleted;
        message.is_deleted = true;
        message.received_at = received_at.to_string();
        message.raw_provider_type = Some("message-delete".to_string());
        message
    }

    #[test]
    fn provider_deletion_tombstones_the_original_without_creating_a_second_row() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let original = fake_message("s1", StreamPlatform::Twitch, Some("target-1"), 1);
        assert_eq!(
            coordinator.ingest(original.clone()),
            IngestOutcome::New(original.clone())
        );

        let tombstone = deletion_for(original.clone(), "2026-07-10T12:00:10Z");
        let IngestOutcome::Updated(authoritative) = coordinator.ingest(tombstone) else {
            panic!("provider deletion must update the buffered message")
        };

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(authoritative, snapshot.messages[0]);
        assert_eq!(snapshot.messages[0].id, original.id);
        assert!(snapshot.messages[0].is_deleted);
        assert_eq!(snapshot.messages[0].event_type, LiveChatEventType::Deleted);
        assert_eq!(
            snapshot.messages[0].message_text,
            "A chat message was removed."
        );
        assert!(snapshot.messages[0].fragments.is_empty());
    }

    #[test]
    fn deletion_before_original_wins_and_destination_identity_is_isolated() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let original = fake_message("s1", StreamPlatform::Youtube, Some("target-1"), 2);
        let tombstone = deletion_for(original.clone(), "2026-07-10T12:00:10Z");
        assert!(matches!(
            coordinator.ingest(tombstone),
            IngestOutcome::New(_)
        ));
        assert_eq!(coordinator.ingest(original), IngestOutcome::Duplicate);

        let other_target = fake_message("s1", StreamPlatform::Youtube, Some("target-2"), 2);
        assert!(matches!(
            coordinator.ingest(other_target),
            IngestOutcome::New(_)
        ));
        let other_session = fake_message("s2", StreamPlatform::Youtube, Some("target-1"), 2);
        assert!(matches!(
            coordinator.ingest(other_session),
            IngestOutcome::New(_)
        ));

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(
            snapshot
                .messages
                .iter()
                .filter(|row| row.is_deleted)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn provider_deletion_clears_a_matching_active_highlight() {
        let state = send_test_state("s1", Vec::new(), Vec::new()).await;
        let original = fake_message("s1", StreamPlatform::Twitch, Some("target-1"), 3);
        state.live_chat.lock().await.ingest(original.clone());
        *state.comment_highlight.lock().await = crate::comment_highlight::CommentHighlightState {
            session_id: Some("s1".to_string()),
            message_id: Some(original.id.clone()),
            generation: 4,
            phase: crate::comment_highlight::CommentHighlightPhase::Live,
            expires_at: Some("2026-07-10T12:00:10Z".to_string()),
            reason: None,
        };

        deliver_message(&state, deletion_for(original, "2026-07-10T12:00:05Z")).await;

        let highlight = crate::comment_highlight::comment_highlight_status(&state).await;
        assert_eq!(
            highlight.phase,
            crate::comment_highlight::CommentHighlightPhase::Idle
        );
        assert_eq!(highlight.reason.as_deref(), Some("message-deleted"));
    }

    #[tokio::test]
    async fn persisted_parent_deletion_loses_legacy_gift_group_metadata() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("gift-session")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("gift-session".to_string(), Vec::new());
        let gift = |sequence, subscription, gift_count| {
            let mut row = fake_message(
                "gift-session",
                StreamPlatform::Twitch,
                Some("channel"),
                sequence,
            );
            row.event_type = LiveChatEventType::Membership;
            row.details = Some(LiveChatEventDetails::Subscription {
                subscription,
                tier: None,
                is_prime: false,
                months: None,
                streak_months: None,
                gift_count: Some(gift_count),
                recipient_name: None,
                community_gift_id: Some("gift-group".to_string()),
            });
            row
        };
        let parent = gift(1, SubscriptionKind::CommunitySubGift, 5);
        let child = gift(2, SubscriptionKind::SubGift, 1);
        assert!(deliver_message(&state, parent.clone()).await);
        assert!(deliver_message(&state, child.clone()).await);
        let mut tombstone = deletion_for(parent.clone(), "2026-07-10T12:00:10Z");
        tombstone.details = None;
        assert!(deliver_message(&state, tombstone).await);
        let persisted = state
            .database
            .list_live_chat_messages("gift-session")
            .unwrap();
        let deleted_parent = persisted.iter().find(|row| row.id == parent.id).unwrap();
        assert!(deleted_parent.is_deleted);
        assert_eq!(
            deleted_parent.details, None,
            "legacy persistence cannot recover this parent's gift-group ownership"
        );
        assert_eq!(
            persisted
                .iter()
                .find(|row| row.id == child.id)
                .unwrap()
                .details,
            child.details
        );
        assert_eq!(
            state
                .live_chat
                .lock()
                .await
                .messages
                .iter()
                .find(|row| row.id == parent.id)
                .unwrap()
                .details,
            None
        );
        assert!(matches!(
            state.database.session_chat_totals("gift-session").unwrap(),
            Some(crate::storage::SessionChatTotals::Available { supporters: 0, .. })
        ));
    }

    #[tokio::test]
    async fn durable_chat_totals_cover_delivery_rollover_local_clear_and_duplicates() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("durable-session")
            .unwrap();
        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("durable-session".to_string(), Vec::new());
            coordinator.session_generation()
        };
        let mut sub = fake_message("durable-session", StreamPlatform::Twitch, None, 0);
        sub.event_type = LiveChatEventType::Membership;
        sub.details = Some(LiveChatEventDetails::Subscription {
            subscription: SubscriptionKind::Sub,
            tier: None,
            is_prime: false,
            months: None,
            streak_months: None,
            gift_count: None,
            recipient_name: None,
            community_gift_id: None,
        });
        let mut tip = fake_message("durable-session", StreamPlatform::Youtube, None, 1);
        tip.event_type = LiveChatEventType::Paid;
        tip.details = Some(LiveChatEventDetails::SuperChat {
            amount_micros: 20_000_000,
            currency: "USD".to_string(),
            amount_display: "$20".to_string(),
            tier: None,
        });
        try_deliver_messages(&state, generation, vec![sub.clone(), tip])
            .await
            .unwrap();
        for start in (2..6002).step_by(100) {
            try_deliver_messages(
                &state,
                generation,
                (start..start + 100)
                    .map(|sequence| {
                        fake_message("durable-session", StreamPlatform::X, None, sequence)
                    })
                    .collect(),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            state.live_chat.lock().await.messages.len(),
            DEFAULT_MAX_CHAT_MESSAGES
        );
        let totals = state
            .database
            .session_chat_totals("durable-session")
            .unwrap()
            .unwrap();
        assert!(
            matches!(&totals, crate::storage::SessionChatTotals::Available { message_count: 6002, supporters: 1, tips, .. } if tips[0].amount_micros == 20_000_000)
        );
        let cleared = clear_local_live_chat(&state).await;
        assert!(cleared.messages.is_empty());
        assert_eq!(cleared.unread_count, 0);
        assert_eq!(
            state
                .database
                .session_chat_totals("durable-session")
                .unwrap(),
            Some(totals.clone())
        );
        assert!(deliver_message(&state, sub).await);
        assert_eq!(
            state
                .database
                .session_chat_totals("durable-session")
                .unwrap(),
            Some(totals)
        );
    }

    #[tokio::test]
    async fn persisted_tombstone_replays_do_not_reenter_live_delivery_after_clear_or_eviction() {
        for retirement in ["clear", "eviction"] {
            let state = test_state();
            state
                .database
                .ensure_fake_live_chat_session("replay-session")
                .unwrap();
            {
                let mut coordinator = state.live_chat.lock().await;
                *coordinator = LiveChatCoordinator::new(2);
                coordinator.start_session("replay-session".to_string(), Vec::new());
            }
            let original = fake_message("replay-session", StreamPlatform::Twitch, None, 0);
            assert!(deliver_message(&state, original.clone()).await);
            assert!(
                deliver_message(
                    &state,
                    deletion_for(original.clone(), "2026-07-10T12:00:10Z")
                )
                .await
            );
            if retirement == "clear" {
                clear_local_live_chat(&state).await;
            } else {
                for sequence in 1..3 {
                    assert!(
                        deliver_message(
                            &state,
                            fake_message("replay-session", StreamPlatform::Twitch, None, sequence)
                        )
                        .await
                    );
                }
            }
            let before = state.live_chat.lock().await.diagnostics();
            let mut events = state.events.subscribe();
            let fresh = fake_message("replay-session", StreamPlatform::Twitch, None, 3);
            let generation = state.live_chat.lock().await.session_generation();
            try_deliver_messages(&state, generation, vec![original.clone(), fresh.clone()])
                .await
                .unwrap();
            let coordinator = state.live_chat.lock().await;
            assert!(!coordinator.messages.iter().any(|row| row.id == original.id));
            assert_eq!(coordinator.messages_received, before.messages_received + 1);
            assert_eq!(
                coordinator.trimmed_count,
                before.messages_trimmed + u64::from(retirement == "eviction")
            );
            assert_eq!(
                coordinator.unread_count,
                if retirement == "clear" { 1 } else { 4 }
            );
            let mut admitted_ids = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.event == "liveChat.message" {
                    admitted_ids.push(event.payload["id"].as_str().unwrap().to_string());
                }
            }
            assert_eq!(admitted_ids, vec![fresh.id]);
        }
    }

    #[tokio::test]
    async fn conflicting_persisted_identity_rolls_back_live_batch_and_totals_without_publication() {
        let state = test_state();
        for session in ["prior", "current"] {
            state
                .database
                .ensure_fake_live_chat_session(session)
                .unwrap();
        }
        let prior = fake_message("prior", StreamPlatform::Twitch, None, 0);
        state.database.save_live_chat_message(&prior).unwrap();
        let before = state.database.session_chat_totals("prior").unwrap();
        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("current".to_string(), Vec::new());
            coordinator.session_generation()
        };
        let mut conflict = fake_message("current", StreamPlatform::Twitch, None, 0);
        conflict.id = prior.id;
        let mut events = state.events.subscribe();
        let result = try_deliver_messages(
            &state,
            generation,
            vec![
                fake_message("current", StreamPlatform::Twitch, None, 1),
                conflict,
            ],
        )
        .await;
        assert!(result.unwrap_err().is_terminal());
        let coordinator = state.live_chat.lock().await;
        assert!(coordinator.messages.is_empty());
        assert!(coordinator.seen.is_empty());
        assert_eq!(
            (
                coordinator.unread_count,
                coordinator.messages_received,
                coordinator.trimmed_count
            ),
            (0, 0, 0)
        );
        assert_eq!(state.database.session_chat_totals("prior").unwrap(), before);
        assert_eq!(
            state.database.session_chat_totals("current").unwrap(),
            Some(crate::storage::SessionChatTotals::empty("current"))
        );
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(
                event.event.as_str(),
                "liveChat.message" | "liveChat.totals"
            ));
        }
    }

    #[tokio::test]
    async fn session_chat_totals_fake_provider_rpc() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let destinations = [
            ("twitch", "smoke-twitch-events"),
            ("youtube", "smoke-youtube-events"),
            ("kick", "smoke-kick-events"),
        ];
        let start = crate::handle_text_message(
            &state,
            &serde_json::json!({
                "id": "activity-start", "method": "liveChat.start", "params": {
                    "sessionId": "activity-rpc",
                    "platforms": ["twitch", "youtube", "kick"],
                    "destinations": destinations.map(|(platform, target)| serde_json::json!({
                        "platform": platform, "targetId": target, "read": "ready", "write": "ready"
                    })),
                    "fakes": destinations.map(|(platform, target)| serde_json::json!({
                        "platform": platform, "targetId": target, "count": 1,
                        "intervalMs": 60, "events": true
                    }))
                }
            })
            .to_string(),
        )
        .await;
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            let mut ended = HashSet::new();
            let mut messages = Vec::new();
            while ended.len() != destinations.len() {
                let event = events.recv().await?;
                if event.event == "liveChat.providerStatus"
                    && event.payload["state"] == "ended"
                    && let Some(target) = event.payload["targetId"].as_str()
                    && destinations.iter().any(|(_, expected)| *expected == target)
                {
                    ended.insert(target.to_string());
                } else if event.event == "liveChat.message" {
                    messages.push(event.payload);
                }
            }
            Ok::<_, broadcast::error::RecvError>(messages)
        })
        .await;
        let response = crate::handle_text_message(
            &state,
            r#"{"id":"activity-totals","method":"sessions.comments.totals","params":{"sessionId":"activity-rpc"}}"#,
        )
        .await;

        // Retain exact fixture task ownership even on readiness failure. No
        // abort/drop handle or assertion can leave its connector running.
        let tasks = std::mem::take(&mut state.live_chat.lock().await.tasks);
        if !matches!(&completed, Ok(Ok(_))) {
            for task in &tasks {
                task.abort();
            }
        }
        let mut all_joined = true;
        for mut task in tasks {
            match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
                Ok(result) => all_joined &= result.is_ok(),
                Err(_) => {
                    task.abort();
                    all_joined &= tokio::time::timeout(Duration::from_secs(1), &mut task)
                        .await
                        .is_ok();
                }
            }
        }
        let stopped = tokio::time::timeout(Duration::from_secs(1), stop_live_chat(&state)).await;
        assert!(
            all_joined,
            "exact fake provider tasks must finish bounded cleanup"
        );
        assert!(stopped.is_ok(), "fixture session cleanup must complete");
        assert!(start.ok);
        let messages = completed
            .expect("all three exact fake provider end events must arrive")
            .expect("fixture events must not lag");
        assert_eq!(messages.len(), 14);
        assert_eq!(
            messages
                .iter()
                .filter_map(|message| message["id"].as_str())
                .collect::<HashSet<_>>()
                .len(),
            14
        );
        assert!(response.ok);
        let wire = serde_json::to_string(&response).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&wire).unwrap();
        let value = &parsed["payload"];
        let reduced = serde_json::json!({
            "status": value["status"], "messageCount": value["messageCount"],
            "chatters": value["chatters"], "supporters": value["supporters"],
            "follows": value["follows"], "raids": value["raids"],
            "bits": value["bits"], "tips": value["tips"]
        });
        assert_eq!(
            reduced,
            serde_json::json!({
                "status": "available", "messageCount": 14, "chatters": 7,
                "supporters": 7, "follows": 2, "raids": 1, "bits": 1500,
                "tips": [{ "currency": "USD", "amountMicros": 5_000_000 },
                         { "currency": "EUR", "amountMicros": 2_000_000 }]
            })
        );
        // This bounded synthetic-only projection connects the real serialized
        // reply to the Node smoke's acceptance regression; no session or text.
        eprintln!("fake-activity-rpc-reduced: {reduced}");
    }

    #[tokio::test]
    async fn session_chat_totals_match_normalized_fake_activity_rules() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("all-activity")
            .unwrap();
        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("all-activity".to_string(), Vec::new());
            coordinator.session_generation()
        };
        let mut messages = Vec::new();
        for platform in [
            StreamPlatform::Twitch,
            StreamPlatform::Youtube,
            StreamPlatform::Kick,
        ] {
            messages.push(fake_message("all-activity", platform, None, 0));
            messages.extend(fake_events("all-activity", platform, None));
        }
        try_deliver_messages(&state, generation, messages)
            .await
            .unwrap();
        let value = serde_json::to_value(
            state
                .database
                .session_chat_totals("all-activity")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["messageCount"], 14);
        assert_eq!(value["chatters"], 7);
        assert_eq!(value["supporters"], 7);
        assert_eq!(value["follows"], 2);
        assert_eq!(value["raids"], 1);
        assert_eq!(value["bits"], 1500);
        assert_eq!(
            value["tips"],
            serde_json::json!([{ "currency":"USD", "amountMicros":5_000_000 }, { "currency":"EUR", "amountMicros":2_000_000 }])
        );
    }

    #[tokio::test]
    async fn retained_identity_conflict_refuses_fresh_prefix_without_changing_duplicate_accounting()
    {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("retained-owner")
            .unwrap();
        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("retained-owner".to_string(), Vec::new());
            coordinator.session_generation()
        };
        let original = fake_message("retained-owner", StreamPlatform::Twitch, Some("target"), 0);
        try_deliver_messages(&state, generation, vec![original.clone()])
            .await
            .unwrap();
        // Admission owns first-message decoration. Compare to the confirmed
        // retained row, including that decoration, rather than the raw input.
        let confirmed = state
            .live_chat
            .lock()
            .await
            .messages
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        for field in ["platform", "target", "provider"] {
            let mut conflict = original.clone();
            match field {
                "platform" => conflict.platform = StreamPlatform::Youtube,
                "target" => conflict.target_id = Some("another-target".to_string()),
                "provider" => conflict.provider_message_id = "another-provider-id".to_string(),
                _ => unreachable!(),
            }
            let before = state.live_chat.lock().await.diagnostics();
            let totals = state
                .database
                .session_chat_totals("retained-owner")
                .unwrap();
            let mut events = state.events.subscribe();
            let fresh = fake_message("retained-owner", StreamPlatform::Twitch, Some("target"), 1);
            let result = try_deliver_messages(&state, generation, vec![fresh, conflict]).await;
            assert!(
                result.is_err(),
                "retained {field} conflicts must refuse the entire batch"
            );
            assert!(result.unwrap_err().is_terminal());
            let coordinator = state.live_chat.lock().await;
            assert_eq!(
                coordinator.messages.iter().cloned().collect::<Vec<_>>(),
                confirmed
            );
            assert_eq!(
                serde_json::to_value(coordinator.diagnostics()).unwrap(),
                serde_json::to_value(before).unwrap()
            );
            assert_eq!(
                state
                    .database
                    .session_chat_totals("retained-owner")
                    .unwrap(),
                totals
            );
            while let Ok(event) = events.try_recv() {
                assert!(!matches!(
                    event.event.as_str(),
                    "liveChat.message" | "liveChat.totals"
                ));
            }
        }
        let duplicates = state.live_chat.lock().await.duplicates_skipped;
        try_deliver_messages(&state, generation, vec![original])
            .await
            .unwrap();
        assert_eq!(
            state.live_chat.lock().await.duplicates_skipped,
            duplicates + 1
        );
    }

    #[tokio::test]
    async fn mismatched_persistence_outcomes_roll_back_compact_admission_before_publication() {
        for mismatch in ["length", "order", "owner"] {
            let mut state = test_state();
            state
                .database
                .ensure_fake_live_chat_session("worker-owner")
                .unwrap();
            state.live_chat_persistence =
                crate::live_chat_persistence::LiveChatPersistence::with_writer(Arc::new(
                    move |messages| {
                        let mut outcomes = messages.to_vec();
                        match mismatch {
                            "length" => {
                                outcomes.pop();
                            }
                            "order" => outcomes.reverse(),
                            "owner" => {
                                outcomes[0].provider_message_id = "foreign-provider".to_string()
                            }
                            _ => unreachable!(),
                        }
                        Ok(outcomes)
                    },
                ));
            let generation = {
                let mut coordinator = state.live_chat.lock().await;
                coordinator.start_session("worker-owner".to_string(), Vec::new());
                coordinator.session_generation()
            };
            let mut events = state.events.subscribe();
            let result = try_deliver_messages(
                &state,
                generation,
                vec![
                    fake_message("worker-owner", StreamPlatform::Twitch, None, 1),
                    fake_message("worker-owner", StreamPlatform::Twitch, None, 2),
                ],
            )
            .await;
            assert!(result.unwrap_err().is_terminal());
            let coordinator = state.live_chat.lock().await;
            assert!(coordinator.messages.is_empty() && coordinator.seen.is_empty());
            assert_eq!(
                (
                    coordinator.unread_count,
                    coordinator.messages_received,
                    coordinator.trimmed_count
                ),
                (0, 0, 0)
            );
            while let Ok(event) = events.try_recv() {
                assert!(!matches!(
                    event.event.as_str(),
                    "liveChat.message" | "liveChat.totals"
                ));
            }
        }
    }

    #[tokio::test]
    async fn persistence_failure_restores_dedup_state_for_redelivery() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let message = fake_message("late-session", StreamPlatform::Youtube, Some("target-1"), 7);
        state
            .live_chat
            .lock()
            .await
            .start_session("late-session".to_string(), Vec::new());

        assert!(!deliver_message(&state, message.clone()).await);
        {
            let coordinator = state.live_chat.lock().await;
            assert!(coordinator.messages.is_empty());
            assert!(!coordinator.seen.contains(&message.id));
            assert_eq!(coordinator.messages_received, 0);
        }

        state
            .database
            .ensure_fake_live_chat_session("late-session")
            .unwrap();
        assert!(deliver_message(&state, message.clone()).await);
        assert_eq!(state.live_chat.lock().await.messages.len(), 1);
        assert_eq!(
            state
                .database
                .list_live_chat_messages_recent("late-session", 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn delivery_for_a_replaced_session_is_rejected_before_persistence_or_emit() {
        let (events, mut receiver) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("new-session".to_string(), Vec::new());

        let delivered = deliver_message(
            &state,
            fake_message("old-session", StreamPlatform::Youtube, None, 9),
        )
        .await;

        assert!(!delivered);
        assert!(state.live_chat.lock().await.messages.is_empty());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_connector_delivery_cannot_mutate_same_session_replacement() {
        let state = send_test_state(
            "shared-session",
            vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            Vec::new(),
        )
        .await;
        let original_session_generation = state.live_chat.lock().await.session_generation();
        let mut events = state.events.subscribe();

        let replacement_session_generation = {
            let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(
                "shared-session".to_string(),
                vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            );
            let generation = coordinator.session_generation();
            drop(coordinator);
            drop(lifecycle_delivery);
            generation
        };
        assert_ne!(replacement_session_generation, original_session_generation);

        let result = try_deliver_message(
            &state,
            original_session_generation,
            fake_message(
                "shared-session",
                StreamPlatform::Youtube,
                Some("shared-target"),
                77,
            ),
        )
        .await;
        let snapshot = current_status(&state).await;
        let persisted = state
            .database
            .list_live_chat_messages_recent("shared-session", 10)
            .unwrap()
            .len();
        let mut message_events = 0;
        while let Ok(event) = events.try_recv() {
            if event.event == "liveChat.message" {
                message_events += 1;
            }
        }

        assert_eq!(
            (
                result.is_ok(),
                snapshot.messages.len(),
                persisted,
                snapshot.providers[0].last_message_at.clone(),
                message_events,
            ),
            (false, 0, 0, None, 0),
            "an old connector owner must not mutate memory, persistence, provider activity, or events",
        );
    }

    #[tokio::test]
    async fn session_replacement_waits_for_persistence_and_cannot_receive_the_old_message() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Condvar, Mutex};

        let (events, _) = broadcast::channel(16);
        let mut state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let writer_started = Arc::new(AtomicBool::new(false));
        let release_writer = Arc::new((Mutex::new(false), Condvar::new()));
        let writer_started_for_task = writer_started.clone();
        let release_writer_for_task = release_writer.clone();
        state.live_chat_persistence =
            crate::live_chat_persistence::LiveChatPersistence::with_writer(Arc::new(
                move |messages| {
                    writer_started_for_task.store(true, Ordering::SeqCst);
                    let (released, signal) = &*release_writer_for_task;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = signal.wait(released).unwrap();
                    }
                    Ok(messages.to_vec())
                },
            ));
        let session_generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session("old-session".to_string(), Vec::new());
            coordinator.session_generation()
        };

        let delivery_state = state.clone();
        let delivery = tokio::spawn(async move {
            try_deliver_message(
                &delivery_state,
                session_generation,
                fake_message("old-session", StreamPlatform::Twitch, None, 1),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !writer_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("persistence writer did not block");

        let replacement_state = state.clone();
        let replacement = tokio::spawn(async move {
            start_live_chat(
                &replacement_state,
                LiveChatStartParams {
                    session_id: "new-session".to_string(),
                    platforms: Vec::new(),
                    destinations: Vec::new(),
                    fake: None,
                    fakes: Vec::new(),
                    youtube: None,
                    twitch: None,
                    x: None,
                    kick: None,
                    audience: Vec::new(),
                    fake_audience: Vec::new(),
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !replacement.is_finished(),
            "session replacement must wait for the in-flight delivery"
        );

        {
            let (released, signal) = &*release_writer;
            *released.lock().unwrap() = true;
            signal.notify_all();
        }
        delivery.await.unwrap().unwrap();
        replacement.await.unwrap();

        let snapshot = current_status(&state).await;
        assert_eq!(snapshot.session_id.as_deref(), Some("new-session"));
        assert!(snapshot.messages.is_empty());
    }

    #[test]
    fn snapshot_is_authoritatively_chronological_under_concurrent_delivery() {
        let mut coordinator = LiveChatCoordinator::new(10);
        let mut later = fake_message("s1", StreamPlatform::Twitch, Some("tw"), 2);
        later.received_at = "2026-07-10T12:00:02Z".to_string();
        let mut earlier = fake_message("s1", StreamPlatform::Youtube, Some("yt"), 1);
        earlier.received_at = "2026-07-10T12:00:01Z".to_string();
        coordinator.ingest(later);
        coordinator.ingest(earlier);
        let ids = coordinator
            .snapshot("now".to_string())
            .messages
            .into_iter()
            .map(|message| message.provider_message_id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["fake-1", "fake-2"]);
    }

    #[test]
    fn clear_local_empties_view_but_keeps_session_active() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        let session_generation = coordinator.session_generation();
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
        coordinator.clear_local();
        let snapshot = coordinator.snapshot("now".to_string());
        assert!(coordinator.is_active());
        assert_eq!(coordinator.session_generation(), session_generation);
        assert_eq!(snapshot.session_id.as_deref(), Some("s1"));
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.unread_count, 0);
        assert_eq!(snapshot.providers.len(), 1);
    }

    #[test]
    fn ensure_provider_adds_late_x_without_resetting_existing_rows() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );

        coordinator.ensure_provider(LiveChatProviderState {
            id: "x-target".to_string(),
            platform: StreamPlatform::X,
            target_id: Some("x-target".to_string()),
            account_id: Some("123".to_string()),
            account_label: Some("OrcDev".to_string()),
            read: CommentsReadState::Ready,
            write: CommentsWriteState::ReadOnly,
            moderate: None,
            state: LiveChatProviderConnectionState::Disabled,
            message: "X comments ready.".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        });

        let snapshot = coordinator.snapshot("now".to_string());
        assert_eq!(snapshot.session_id.as_deref(), Some("s1"));
        assert_eq!(snapshot.providers.len(), 2);
        assert_eq!(snapshot.providers[0].platform, StreamPlatform::Youtube);
        assert_eq!(snapshot.providers[1].platform, StreamPlatform::X);
        assert_eq!(snapshot.providers[1].target_id.as_deref(), Some("x-target"));
    }

    #[test]
    fn sender_registry_is_session_scoped() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session("s1".to_string(), Vec::new());
        coordinator.register_sender(
            "youtube".to_string(),
            ChatSenderConfig::YouTube {
                access_token: "t".to_string(),
                api_base_url: None,
                live_chat_id: None,
                token_source: Default::default(),
            },
        );
        assert!(coordinator.sender("youtube").is_some());
        assert!(coordinator.sender("twitch").is_none());
        // Stop drops send credentials with the session.
        coordinator.stop_session();
        assert!(coordinator.sender("youtube").is_none());
        // A NEW session never inherits the previous session's senders.
        coordinator.register_sender(
            "twitch".to_string(),
            ChatSenderConfig::Twitch(crate::twitch_chat::TwitchChatSenderConfig {
                access_token: "t".to_string(),
                client_id: "c".to_string(),
                broadcaster_user_id: "b".to_string(),
                sender_user_id: "u".to_string(),
                api_base_url: None,
                token_source: Default::default(),
            }),
        );
        coordinator.start_session("s2".to_string(), Vec::new());
        assert!(coordinator.sender("twitch").is_none());
    }

    #[tokio::test]
    async fn resolved_youtube_chat_id_updates_only_its_destination_sender() {
        let state = send_test_state(
            "s1",
            Vec::new(),
            ["youtube-primary", "youtube-backup"]
                .into_iter()
                .map(|target_id| {
                    (
                        target_id.to_string(),
                        ChatSenderConfig::YouTube {
                            access_token: "token".to_string(),
                            api_base_url: None,
                            live_chat_id: None,
                            token_source: Default::default(),
                        },
                    )
                })
                .collect(),
        )
        .await;
        let session_generation = state.live_chat.lock().await.session_generation();

        assert!(
            set_youtube_send_chat_id(
                &state,
                "s1",
                session_generation,
                Some("youtube-backup"),
                "chat-backup",
            )
            .await
        );

        let coordinator = state.live_chat.lock().await;
        let resolved = |target_id: &str| match coordinator.sender(target_id).unwrap() {
            ChatSenderConfig::YouTube { live_chat_id, .. } => live_chat_id,
            _ => panic!("expected YouTube sender"),
        };
        assert_eq!(resolved("youtube-primary"), None);
        assert_eq!(resolved("youtube-backup").as_deref(), Some("chat-backup"));
    }

    #[tokio::test]
    async fn clearing_local_view_keeps_connector_owner_valid() {
        let state = send_test_state(
            "s1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::YouTube {
                    access_token: "token".to_string(),
                    api_base_url: None,
                    live_chat_id: None,
                    token_source: Default::default(),
                },
            )],
        )
        .await;
        let session_generation = state.live_chat.lock().await.session_generation();

        clear_local_live_chat(&state).await;

        assert!(
            set_youtube_send_chat_id(
                &state,
                "s1",
                session_generation,
                Some("youtube-target"),
                "chat-after-clear",
            )
            .await
        );
        assert!(
            set_provider_and_emit(
                &state,
                "s1",
                session_generation,
                StreamPlatform::Youtube,
                Some("youtube-target"),
                LiveChatProviderConnectionState::Reconnecting,
                "Reconnect after local clear.",
            )
            .await
        );
        assert!(
            try_deliver_message(
                &state,
                session_generation,
                fake_message("s1", StreamPlatform::Youtube, Some("youtube-target"), 88,),
            )
            .await
            .is_ok(),
            "clearing the local view must not retire connector message ownership",
        );

        let coordinator = state.live_chat.lock().await;
        assert_eq!(coordinator.messages.len(), 1);
        assert_eq!(
            coordinator.providers[0].state,
            LiveChatProviderConnectionState::Reconnecting
        );
        match coordinator
            .sender("youtube-target")
            .expect("YouTube sender remains registered")
        {
            ChatSenderConfig::YouTube { live_chat_id, .. } => {
                assert_eq!(live_chat_id.as_deref(), Some("chat-after-clear"));
            }
            _ => panic!("expected YouTube sender"),
        }
    }

    #[tokio::test]
    async fn send_rejects_wrong_session_before_calling_a_provider() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;

        let error =
            send_live_chat_message(&state, send_params(&operation_id, "session-2", "hello"))
                .await
                .unwrap_err();

        assert!(error.contains("session changed"));
        assert_eq!(probe.calls(), 0);
        assert!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn send_uses_independent_writer_while_read_connector_reconnects() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let mut twitch = connected_provider("twitch-target", StreamPlatform::Twitch);
        twitch.state = LiveChatProviderConnectionState::Reconnecting;
        twitch.read = CommentsReadState::Connecting;
        twitch.message = "Twitch comments reconnecting.".to_string();
        let state = send_test_state(
            "session-1",
            vec![twitch],
            vec![(
                "twitch-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;

        let operation = send_live_chat_message(
            &state,
            send_params(&operation_id, "session-1", "send during reconnect"),
        )
        .await
        .unwrap();

        assert_eq!(operation.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(
            operation.destinations[0].phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_duplicate_operation_id_sends_exactly_once_and_returns_terminal_result() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::from_millis(20),
                },
            )],
        )
        .await;
        let params = send_params(&operation_id, "session-1", "  hello everyone  ");

        let (first, second) = tokio::join!(
            send_live_chat_message(&state, params.clone()),
            send_live_chat_message(&state, params)
        );
        let first = first.unwrap();
        let second = second.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.text, "hello everyone");
        assert_eq!(first.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(first.destinations[0].phase, DestinationDeliveryPhase::Sent);
        assert_eq!(probe.calls(), 1);
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(first)
        );
    }

    #[tokio::test]
    async fn aborting_the_first_caller_does_not_cancel_or_duplicate_the_send_operation() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider(
                "youtube-target",
                StreamPlatform::Youtube,
            )],
            vec![(
                "youtube-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::from_millis(30),
                },
            )],
        )
        .await;
        let params = send_params(&operation_id, "session-1", "keep sending");
        let first_state = state.clone();
        let first_params = params.clone();
        let first_caller =
            tokio::spawn(async move { send_live_chat_message(&first_state, first_params).await });

        tokio::time::timeout(Duration::from_millis(100), async {
            while probe.calls() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provider send did not start");
        first_caller.abort();
        assert!(first_caller.await.unwrap_err().is_cancelled());

        let terminal = send_live_chat_message(&state, params).await.unwrap();

        assert_eq!(terminal.phase, CommentsSendOperationPhase::Sent);
        assert_eq!(
            terminal.destinations[0].phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(probe.calls(), 1);
        assert!(
            terminal
                .destinations
                .iter()
                .all(|delivery| { delivery.phase != DestinationDeliveryPhase::Pending })
        );
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(terminal)
        );
    }

    #[tokio::test]
    async fn reused_operation_id_conflicts_on_different_session_or_normalized_text() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![connected_provider("twitch-target", StreamPlatform::Twitch)],
            vec![(
                "twitch-target".to_string(),
                ChatSenderConfig::FakeProbe {
                    behavior: FakeChatSendBehavior::Sent,
                    probe: probe.clone(),
                    delay: Duration::ZERO,
                },
            )],
        )
        .await;
        send_live_chat_message(&state, send_params(&operation_id, "session-1", "same text"))
            .await
            .unwrap();

        let text_conflict = send_live_chat_message(
            &state,
            send_params(&operation_id, "session-1", "different text"),
        )
        .await
        .unwrap_err();
        let session_conflict =
            send_live_chat_message(&state, send_params(&operation_id, "session-2", "same text"))
                .await
                .unwrap_err();

        assert!(text_conflict.contains("already bound"));
        assert!(session_conflict.contains("already bound"));
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_fanout_isolates_timeout_and_persists_every_terminal_destination() {
        let probe = Arc::new(FakeSendProbe::default());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let state = send_test_state(
            "session-1",
            vec![
                connected_provider("youtube-target", StreamPlatform::Youtube),
                connected_provider("twitch-target", StreamPlatform::Twitch),
                connected_provider("x-target", StreamPlatform::X),
            ],
            vec![
                (
                    "youtube-target".to_string(),
                    ChatSenderConfig::FakeProbe {
                        behavior: FakeChatSendBehavior::Sent,
                        probe: probe.clone(),
                        delay: Duration::from_millis(30),
                    },
                ),
                (
                    "twitch-target".to_string(),
                    ChatSenderConfig::FakeProbe {
                        behavior: FakeChatSendBehavior::Timeout,
                        probe: probe.clone(),
                        delay: Duration::ZERO,
                    },
                ),
            ],
        )
        .await;

        let operation =
            send_live_chat_message(&state, send_params(&operation_id, "session-1", "fan out"))
                .await
                .unwrap();

        assert_eq!(probe.calls(), 2);
        assert!(probe.max_active() >= 2, "provider sends did not overlap");
        assert_eq!(operation.phase, CommentsSendOperationPhase::Partial);
        assert_eq!(operation.destinations.len(), 3);
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "youtube-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::Sent
        );
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "twitch-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(
            operation
                .destinations
                .iter()
                .find(|delivery| delivery.destination_id == "x-target")
                .unwrap()
                .phase,
            DestinationDeliveryPhase::ReadOnly
        );
        assert!(
            operation
                .destinations
                .iter()
                .all(|delivery| { delivery.phase != DestinationDeliveryPhase::Pending })
        );
        assert_eq!(
            state
                .database
                .get_chat_send_operation(&operation_id)
                .unwrap(),
            Some(operation)
        );
    }

    #[test]
    fn a_fake_lane_takes_scripted_authors_and_a_removal_outcome() {
        let config: FakeChatConfig = serde_json::from_value(serde_json::json!({
            "platform": "kick",
            "targetId": "noscope",
            "authors": ["coders_x", "Ana Dev"],
            "delete": "missing-scope"
        }))
        .unwrap();
        assert_eq!(config.delete, Some(FakeChatDeleteBehavior::MissingScope));
        let names: Vec<String> = (0..3)
            .map(|seq| fake_message_for(&config, "s1", seq).author_name)
            .collect();
        assert_eq!(names, ["coders_x", "Ana Dev", "coders_x"]);
        assert_eq!(
            fake_message_for(&config, "s1", 1).author_id.as_deref(),
            Some("fake-author-ana dev")
        );
        assert!(matches!(
            fake_sender(&config),
            ChatSenderConfig::FakeModerated {
                send: FakeChatSendBehavior::Sent,
                delete: FakeChatDeleteBehavior::MissingScope,
            }
        ));
        // Without them, nothing changes: "Test Viewer N" and a sender that
        // mirrors `send`.
        let plain: FakeChatConfig =
            serde_json::from_value(serde_json::json!({ "platform": "twitch" })).unwrap();
        assert_eq!(
            fake_message_for(&plain, "s1", 4).author_name,
            "Test Viewer 1"
        );
        assert!(matches!(
            fake_sender(&plain),
            ChatSenderConfig::Fake(FakeChatSendBehavior::Sent)
        ));
    }

    #[tokio::test]
    async fn same_platform_fake_connectors_keep_target_state_isolated() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let params: LiveChatStartParams = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "destinations": [
                { "targetId": "youtube-a", "platform": "youtube" },
                { "targetId": "youtube-b", "platform": "youtube" }
            ],
            "fakes": [
                { "platform": "youtube", "targetId": "youtube-a", "count": 0 },
                {
                    "platform": "youtube",
                    "targetId": "youtube-b",
                    "count": 1,
                    "intervalMs": 250
                }
            ]
        }))
        .unwrap();
        start_live_chat(&state, params).await;

        tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                let snapshot = current_status(&state).await;
                let a = snapshot
                    .providers
                    .iter()
                    .find(|provider| provider.id == "youtube-a")
                    .unwrap();
                let b = snapshot
                    .providers
                    .iter()
                    .find(|provider| provider.id == "youtube-b")
                    .unwrap();
                if a.state == LiveChatProviderConnectionState::Ended
                    && b.state == LiveChatProviderConnectionState::Connected
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("same-platform fake target states did not diverge");
        stop_live_chat(&state).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_live_chat_snapshot_emission_order_survives_replacement() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_live_chat_after_install(
                &start_state,
                empty_start_params("session-a"),
                std::future::ready(()),
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        captured_rx
            .await
            .expect("original start captures its live-chat snapshot");

        let mut replacement = Box::pin(start_live_chat(&state, empty_start_params("session-b")));
        let completed_during_emit_gap = poll_future_once(replacement.as_mut()).await;
        resume_tx.send(()).expect("resume original snapshot emit");
        assert_eq!(
            start
                .await
                .expect("original start task")
                .session_id
                .as_deref(),
            Some("session-a")
        );
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(
            current_status(&state).await.session_id.as_deref(),
            Some("session-b")
        );
        assert_eq!(
            drain_live_chat_publications(&mut events).last(),
            Some(&(
                "liveChat.snapshot".to_string(),
                Some("session-b".to_string())
            ))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_x_live_chat_snapshot_emission_order_survives_replacement() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_x_live_chat_before_snapshot_emit(
                &start_state,
                StartXLiveChatParams {
                    session_id: "session-a".to_string(),
                    broadcast_id: "broadcast-a".to_string(),
                    target_id: Some("x-a".to_string()),
                },
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        captured_rx
            .await
            .expect("X start captures its original live-chat snapshot");

        let mut replacement = Box::pin(start_live_chat(&state, empty_start_params("session-b")));
        let completed_during_emit_gap = poll_future_once(replacement.as_mut()).await;
        resume_tx.send(()).expect("resume X snapshot emit");
        assert_eq!(
            start
                .await
                .expect("X start task")
                .expect("X start result")
                .session_id
                .as_deref(),
            Some("session-a")
        );
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(
            current_status(&state).await.session_id.as_deref(),
            Some("session-b")
        );
        assert_eq!(
            drain_live_chat_publications(&mut events).last(),
            Some(&(
                "liveChat.snapshot".to_string(),
                Some("session-b".to_string())
            ))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_live_chat_snapshot_emission_order_survives_replacement() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let stop_state = state.clone();
        let stop = tokio::spawn(async move {
            stop_live_chat_before_snapshot_emit(
                &stop_state,
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
                crate::captions::ListenStop::Abort,
            )
            .await
        });
        captured_rx
            .await
            .expect("stop captures its retired live-chat snapshot");

        let mut replacement = Box::pin(start_live_chat(&state, empty_start_params("session-b")));
        let completed_during_emit_gap = poll_future_once(replacement.as_mut()).await;
        resume_tx.send(()).expect("resume stopped snapshot emit");
        assert!(
            stop.await.expect("stop task").session_id.is_none(),
            "original stop result must be retired"
        );
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(
            current_status(&state).await.session_id.as_deref(),
            Some("session-b")
        );
        assert_eq!(
            drain_live_chat_publications(&mut events).last(),
            Some(&(
                "liveChat.snapshot".to_string(),
                Some("session-b".to_string())
            ))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_live_chat_snapshot_emission_order_survives_replacement() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let clear_state = state.clone();
        let clear = tokio::spawn(async move {
            clear_local_live_chat_before_snapshot_emit(&clear_state, async move {
                let _ = captured_tx.send(());
                let _ = resume_rx.await;
            })
            .await
        });
        captured_rx
            .await
            .expect("clear captures its original live-chat snapshot");

        let mut replacement = Box::pin(start_live_chat(&state, empty_start_params("session-b")));
        let completed_during_emit_gap = poll_future_once(replacement.as_mut()).await;
        resume_tx.send(()).expect("resume cleared snapshot emit");
        assert_eq!(
            clear.await.expect("clear task").session_id.as_deref(),
            Some("session-a")
        );
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(
            current_status(&state).await.session_id.as_deref(),
            Some("session-b")
        );
        assert_eq!(
            drain_live_chat_publications(&mut events).last(),
            Some(&(
                "liveChat.snapshot".to_string(),
                Some("session-b".to_string())
            ))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_status_emission_order_survives_stop_snapshot() {
        let state = send_test_state(
            "session-a",
            vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            Vec::new(),
        )
        .await;
        let session_generation = state.live_chat.lock().await.session_generation();
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let update_state = state.clone();
        let update = tokio::spawn(async move {
            set_provider_and_emit_with_hooks(
                &update_state,
                ("session-a", session_generation),
                StreamPlatform::Youtube,
                Some("shared-target"),
                (LiveChatProviderConnectionState::Reconnecting, None),
                "Transient connection loss.",
                (std::future::ready(()), async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                }),
            )
            .await
        });
        captured_rx
            .await
            .expect("provider update captures its state before publication");

        let mut stop = Box::pin(stop_live_chat(&state));
        let completed_during_emit_gap = poll_future_once(stop.as_mut()).await;
        let stop_waited_for_publication = completed_during_emit_gap.is_none();
        resume_tx.send(()).expect("resume provider publication");
        assert!(update.await.expect("provider update task"));
        let stopped = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => stop.await,
        };

        assert!(
            stop_waited_for_publication,
            "stop must wait for the earlier provider publication"
        );
        assert!(stopped.session_id.is_none());
        assert_eq!(
            current_status(&state).await.providers[0].state,
            LiveChatProviderConnectionState::Ended
        );
        assert_eq!(
            drain_live_chat_state_publication_names(&mut events).last(),
            Some(&"liveChat.snapshot".to_string())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_provider_status_cannot_mutate_same_session_replacement() {
        let state = send_test_state(
            "shared-session",
            vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            Vec::new(),
        )
        .await;
        let original_generation = state.live_chat.lock().await.session_generation();
        let mut events = state.events.subscribe();
        let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let update_state = state.clone();
        let update = tokio::spawn(async move {
            set_provider_and_emit_with_hooks(
                &update_state,
                ("shared-session", original_generation),
                StreamPlatform::Youtube,
                Some("shared-target"),
                (LiveChatProviderConnectionState::Reconnecting, None),
                "Old connector retry.",
                (
                    async move {
                        let _ = paused_tx.send(());
                        let _ = resume_rx.await;
                    },
                    std::future::ready(()),
                ),
            )
            .await
        });
        paused_rx
            .await
            .expect("old provider update pauses before mutation");

        let replacement_generation = {
            let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(
                "shared-session".to_string(),
                vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            );
            let generation = coordinator.session_generation();
            drop(coordinator);
            drop(lifecycle_delivery);
            generation
        };
        assert_ne!(replacement_generation, original_generation);

        resume_tx.send(()).expect("resume stale provider update");
        assert!(
            !update.await.expect("stale provider update task"),
            "stale owner must be rejected"
        );
        let snapshot = current_status(&state).await;
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Connected
        );
        assert_eq!(current_diagnostics(&state).await.reconnect_count, 0);
        assert!(
            drain_live_chat_state_publication_names(&mut events).is_empty(),
            "stale owner must not publish provider state"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_youtube_chat_id_cannot_update_same_session_replacement_sender() {
        let state = send_test_state(
            "shared-session",
            vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            vec![(
                "shared-target".to_string(),
                ChatSenderConfig::YouTube {
                    access_token: "old-token".to_string(),
                    api_base_url: None,
                    live_chat_id: None,
                    token_source: Default::default(),
                },
            )],
        )
        .await;
        let original_generation = state.live_chat.lock().await.session_generation();
        let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let update_state = state.clone();
        let update = tokio::spawn(async move {
            set_youtube_send_chat_id_before_mutation(
                &update_state,
                "shared-session",
                original_generation,
                Some("shared-target"),
                "old-live-chat-id",
                async move {
                    let _ = paused_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        paused_rx
            .await
            .expect("old YouTube resolver pauses before sender mutation");

        let replacement_generation = {
            let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(
                "shared-session".to_string(),
                vec![connected_provider("shared-target", StreamPlatform::Youtube)],
            );
            coordinator.register_sender(
                "shared-target".to_string(),
                ChatSenderConfig::YouTube {
                    access_token: "replacement-token".to_string(),
                    api_base_url: None,
                    live_chat_id: None,
                    token_source: Default::default(),
                },
            );
            let generation = coordinator.session_generation();
            drop(coordinator);
            drop(lifecycle_delivery);
            generation
        };
        assert_ne!(replacement_generation, original_generation);

        resume_tx.send(()).expect("resume stale YouTube resolver");
        assert!(
            !update.await.expect("stale YouTube resolver task"),
            "stale resolver must be rejected"
        );
        let coordinator = state.live_chat.lock().await;
        match coordinator
            .sender("shared-target")
            .expect("replacement sender")
        {
            ChatSenderConfig::YouTube {
                access_token,
                live_chat_id,
                ..
            } => {
                assert_eq!(access_token, "replacement-token");
                assert!(live_chat_id.is_none());
            }
            _ => panic!("expected YouTube replacement sender"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scoped_stop_waits_for_explicit_start_attachments_and_preserves_replacement() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("retired-session".to_string(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("enable co-host");
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                session_id: "retired-session".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .expect("start retired co-host");
        let params: LiveChatStartParams = serde_json::from_value(serde_json::json!({
            "sessionId": "replacement-session",
            "platforms": ["youtube"],
            "fake": { "platform": "youtube", "count": 0 }
        }))
        .unwrap();
        let (installed_tx, installed_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_live_chat_after_install(
                &start_state,
                params,
                async move {
                    let _ = installed_tx.send(());
                    let _ = resume_rx.await;
                },
                std::future::ready(()),
            )
            .await
        });
        installed_rx
            .await
            .expect("replacement session installed before attachment pause");
        assert_eq!(
            state.live_chat.lock().await.runtime_ownership(),
            (0, 0),
            "the injected pause must precede all replacement runtime attachment"
        );
        assert!(
            crate::cohost::cohost_status(&state)
                .await
                .session_id
                .is_none(),
            "replacement start retires the old co-host inside its lifecycle transaction"
        );
        let cohost_start_state = state.clone();
        let mut cohost_start = tokio::spawn(async move {
            crate::cohost::start_cohost(
                &cohost_start_state,
                crate::protocol::CohostStartParams {
                    session_id: "replacement-session".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
            )
            .await
        });
        assert!(
            timeout(Duration::from_millis(50), &mut cohost_start)
                .await
                .is_err(),
            "co-host start must join the replacement lifecycle transaction"
        );

        let stop_state = state.clone();
        let mut old_monitor_stop = tokio::spawn(async move {
            stop_live_chat_for_session(&stop_state, "retired-session").await
        });
        assert!(
            timeout(Duration::from_millis(50), &mut old_monitor_stop)
                .await
                .is_err(),
            "the old monitor must wait for the full replacement-start transaction"
        );

        resume_tx.send(()).expect("resume replacement start");
        let started = start.await.expect("replacement start task");
        assert_eq!(started.session_id.as_deref(), Some("replacement-session"));
        let cohost_started = cohost_start
            .await
            .expect("replacement co-host start task")
            .expect("start replacement co-host");
        assert_eq!(
            cohost_started.session_id.as_deref(),
            Some("replacement-session")
        );
        assert!(
            old_monitor_stop
                .await
                .expect("old monitor stop task")
                .is_none(),
            "the old monitor must reject the replacement session"
        );
        let coordinator = state.live_chat.lock().await;
        assert_eq!(coordinator.session_id(), Some("replacement-session"));
        assert_eq!(coordinator.runtime_ownership(), (1, 1));
        drop(coordinator);
        assert_eq!(
            crate::cohost::cohost_status(&state)
                .await
                .session_id
                .as_deref(),
            Some("replacement-session"),
            "the retired monitor must preserve the replacement co-host"
        );
        stop_live_chat(&state).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scoped_stop_cohost_emission_order_survives_replacement() {
        use std::future::Future as _;
        use std::task::Poll;

        let (events, _) = broadcast::channel(32);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("enable co-host");
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                session_id: "session-a".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .expect("start original co-host");
        let mut events = state.events.subscribe();

        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let stop_state = state.clone();
        let stop = tokio::spawn(async move {
            stop_live_chat_for_session_before_cohost_emit(&stop_state, "session-a", async move {
                let _ = captured_tx.send(());
                let _ = resume_rx.await;
            })
            .await
        });
        captured_rx
            .await
            .expect("scoped stop captures the original co-host off state");

        let replacement_params: LiveChatStartParams = serde_json::from_value(serde_json::json!({
            "sessionId": "session-b",
            "platforms": []
        }))
        .expect("replacement live-chat params");
        let mut replacement = Box::pin(async {
            let chat = start_live_chat(&state, replacement_params).await;
            let cohost = crate::cohost::start_cohost(
                &state,
                crate::protocol::CohostStartParams {
                    session_id: "session-b".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
            )
            .await
            .expect("start replacement co-host");
            (chat, cohost)
        });
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match replacement.as_mut().poll(context) {
                Poll::Ready(snapshots) => Some(snapshots),
                Poll::Pending => None,
            })
        })
        .await;

        resume_tx.send(()).expect("resume old co-host off emit");
        assert!(
            stop.await.expect("scoped stop task").is_some(),
            "scoped stop must retire the original session"
        );
        let (chat, started) = match completed_during_emit_gap {
            Some(snapshots) => snapshots,
            None => replacement.await,
        };
        assert_eq!(chat.session_id.as_deref(), Some("session-b"));
        assert_eq!(started.session_id.as_deref(), Some("session-b"));
        assert_eq!(
            crate::cohost::cohost_status(&state)
                .await
                .session_id
                .as_deref(),
            Some("session-b")
        );

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == crate::cohost::COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "listening");
        assert_eq!(final_event["sessionId"], "session-b");
        stop_live_chat(&state).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_stops_cannot_finish_before_explicit_start_attaches_its_runtime() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let params: LiveChatStartParams = serde_json::from_value(serde_json::json!({
            "sessionId": "starting-session",
            "platforms": ["youtube"],
            "fake": { "platform": "youtube", "count": 0 }
        }))
        .unwrap();
        let (installed_tx, installed_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_live_chat_after_install(
                &start_state,
                params,
                async move {
                    let _ = installed_tx.send(());
                    let _ = resume_rx.await;
                },
                std::future::ready(()),
            )
            .await
        });
        installed_rx
            .await
            .expect("session installed before attachment pause");

        let scoped_state = state.clone();
        let mut scoped_stop = tokio::spawn(async move {
            stop_live_chat_for_session(&scoped_state, "starting-session").await
        });
        let explicit_state = state.clone();
        let mut explicit_stop = tokio::spawn(async move { stop_live_chat(&explicit_state).await });
        assert!(
            timeout(Duration::from_millis(50), &mut scoped_stop)
                .await
                .is_err()
        );
        assert!(
            timeout(Duration::from_millis(50), &mut explicit_stop)
                .await
                .is_err()
        );

        resume_tx.send(()).expect("resume explicit start");
        start.await.expect("explicit start task");
        scoped_stop.await.expect("scoped stop task");
        explicit_stop.await.expect("explicit stop task");
        let coordinator = state.live_chat.lock().await;
        assert_eq!(coordinator.session_id(), None);
        assert_eq!(
            coordinator.runtime_ownership(),
            (0, 0),
            "neither start nor a duplicate stop may leave late runtime ownership"
        );
    }

    #[test]
    fn stop_session_is_idempotent_so_both_terminal_paths_can_call_it() {
        // Teardown now runs from BOTH the session.stop RPC and the monitor's
        // terminal path (a capture that ends on its own must not leave the
        // chat connector and co-host running). Whichever fires second must be
        // a harmless no-op rather than corrupting state or bumping the
        // generation into a live session.
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );

        coordinator.stop_session();
        let generation_after_first = coordinator.generation;
        let session_after_first = coordinator.session_id.clone();

        coordinator.stop_session();

        assert_eq!(coordinator.session_id, session_after_first);
        assert!(coordinator.session_id.is_none());
        assert!(coordinator.senders.is_empty());
        assert_eq!(
            coordinator.generation,
            generation_after_first.wrapping_add(1),
            "a second stop only advances the guard generation; it must not resurrect a session"
        );
    }

    #[test]
    fn stop_session_marks_providers_ended_and_keeps_transcript() {
        let mut coordinator = LiveChatCoordinator::new(10);
        coordinator.start_session(
            "s1".to_string(),
            vec![provider_row(StreamPlatform::Youtube)],
        );
        coordinator.ingest(fake_message("s1", StreamPlatform::Youtube, None, 0));
        coordinator.stop_session();
        let snapshot = coordinator.snapshot("now".to_string());
        assert!(!coordinator.is_active());
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Ended
        );
        assert_eq!(snapshot.messages.len(), 1);

        coordinator.clear_local();
        assert!(
            coordinator
                .snapshot("later".to_string())
                .messages
                .is_empty()
        );
    }

    #[test]
    fn youtube_force_ssl_account_can_read_and_send_chat() {
        let granted = account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE]);
        let capability = chat_capability(StreamPlatform::Youtube, Some(&granted));
        assert_eq!(capability.state, ChatCapabilityState::Available);
        assert!(capability.chat_read_available);
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);

        let without_scope = account(StreamPlatform::Youtube, &[]);
        let capability = chat_capability(StreamPlatform::Youtube, Some(&without_scope));
        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert_eq!(capability.read, CommentsReadState::Unavailable);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);

        let capability = chat_capability(StreamPlatform::Youtube, None);
        assert_eq!(capability.state, ChatCapabilityState::NotConnected);
        assert_eq!(capability.write, CommentsWriteState::Unavailable);
    }

    #[test]
    fn twitch_without_user_read_chat_needs_reconnect() {
        // The current real Twitch scope set lacks user:read:chat until the account reconnects.
        let account = account(
            StreamPlatform::Twitch,
            &["channel:manage:broadcast", "channel:read:stream_key"],
        );
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert!(!capability.chat_read_available);
        assert!(capability.message.contains("Reconnect Twitch"));
    }

    #[test]
    fn twitch_with_user_read_chat_is_available() {
        let account = account(StreamPlatform::Twitch, &[TWITCH_CHAT_SCOPE]);
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.state, ChatCapabilityState::Available);
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);
    }

    #[test]
    fn twitch_read_and_write_scopes_are_modeled_separately() {
        let account = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        let capability = chat_capability(StreamPlatform::Twitch, Some(&account));
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);
    }

    #[test]
    fn stale_twitch_account_never_reports_ready_from_old_scopes() {
        let mut stale = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        stale.status = PlatformAccountStatus::NeedsReconnect;

        let capability = chat_capability(StreamPlatform::Twitch, Some(&stale));

        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert_eq!(capability.read, CommentsReadState::Unavailable);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);
        assert!(!capability.chat_read_available);
    }

    #[test]
    fn capability_list_prefers_connected_account_over_stale_first_row() {
        let mut stale = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        stale.id = "stale".to_string();
        stale.account_id = "stale-channel".to_string();
        stale.status = PlatformAccountStatus::NeedsReconnect;
        let mut connected = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        connected.id = "connected".to_string();
        connected.account_id = "connected-channel".to_string();

        let capability = chat_capabilities(&[stale, connected])
            .into_iter()
            .find(|capability| capability.platform == StreamPlatform::Twitch)
            .unwrap();

        assert_eq!(capability.account_id.as_deref(), Some("connected-channel"));
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);
    }

    fn test_state_for_send() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test]
    async fn x_send_enforces_the_140_char_platform_cap_before_any_network() {
        // The shared composer allows 200 chars; X caps at 140. The X leg must
        // fail honestly (Partial phase renders it) instead of truncating.
        let client = reqwest::Client::new();
        let long_message = "x".repeat(141);
        let error = send_to_destination(
            &test_state_for_send(),
            &client,
            ChatSenderConfig::X {
                broadcast_id: "1AbCdEfGhIjKl".to_string(),
            },
            &long_message,
        )
        .await
        .expect_err("141 chars must fail the X leg");
        assert!(
            error.contains("140"),
            "the error must name the limit: {error}"
        );

        // Within the cap but with no stored X Live credentials, the arm must
        // fail on authorization — proving credentials resolve per send.
        let error = send_to_destination(
            &test_state_for_send(),
            &client,
            ChatSenderConfig::X {
                broadcast_id: "1AbCdEfGhIjKl".to_string(),
            },
            "hello",
        )
        .await
        .expect_err("missing credentials must fail the X leg");
        assert!(
            error.contains("authoriz") || error.contains("Authoriz"),
            "the error must point at authorization: {error}"
        );
    }

    #[test]
    fn x_without_account_is_not_connected_and_custom_has_no_comments() {
        let x = chat_capability(StreamPlatform::X, None);
        assert_eq!(x.state, ChatCapabilityState::NotConnected);
        assert_eq!(x.write, CommentsWriteState::ReadOnly);
        assert_eq!(
            chat_capability(StreamPlatform::Custom, None).state,
            ChatCapabilityState::Unsupported
        );
    }

    #[test]
    fn missing_account_reports_not_connected() {
        assert_eq!(
            chat_capability(StreamPlatform::Twitch, None).state,
            ChatCapabilityState::NotConnected
        );
    }

    #[test]
    fn moderate_readiness_follows_the_moderation_scopes_and_the_quota_pause() {
        // Plan 140 S4: honest per-destination "Remove messages" readiness.
        // No account: absent on the wire.
        let no_account = chat_capability(StreamPlatform::Twitch, None);
        assert_eq!(no_account.moderate, None);
        assert!(
            serde_json::to_value(&no_account)
                .unwrap()
                .get("moderate")
                .is_none()
        );
        // Twitch and Kick need the optional moderation scope (S5 adds it).
        let twitch = account(
            StreamPlatform::Twitch,
            &[TWITCH_CHAT_SCOPE, TWITCH_CHAT_WRITE_SCOPE],
        );
        assert_eq!(
            chat_capability(StreamPlatform::Twitch, Some(&twitch)).moderate,
            Some(CommentsModerateState::MissingScope)
        );
        let twitch_moderator = account(
            StreamPlatform::Twitch,
            &[
                TWITCH_CHAT_SCOPE,
                crate::twitch_chat::TWITCH_CHAT_MODERATE_SCOPE,
            ],
        );
        assert_eq!(
            chat_capability(StreamPlatform::Twitch, Some(&twitch_moderator)).moderate,
            Some(CommentsModerateState::Ready)
        );
        let kick = account(StreamPlatform::Kick, &[crate::kick_chat::KICK_EVENTS_SCOPE]);
        assert_eq!(
            chat_capability(StreamPlatform::Kick, Some(&kick)).moderate,
            Some(CommentsModerateState::MissingScope)
        );
        let kick_moderator = account(
            StreamPlatform::Kick,
            &[
                crate::kick_chat::KICK_EVENTS_SCOPE,
                crate::kick_chat::KICK_CHAT_MODERATE_SCOPE,
            ],
        );
        assert_eq!(
            chat_capability(StreamPlatform::Kick, Some(&kick_moderator)).moderate,
            Some(CommentsModerateState::Ready)
        );
        // YouTube's force-ssl already covers deletes.
        let youtube = account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE]);
        assert_eq!(
            chat_capability(StreamPlatform::Youtube, Some(&youtube)).moderate,
            Some(CommentsModerateState::Ready)
        );
        let youtube_stale = account(StreamPlatform::Youtube, &[]);
        assert_eq!(
            chat_capability(StreamPlatform::Youtube, Some(&youtube_stale)).moderate,
            Some(CommentsModerateState::MissingScope)
        );
        // No native path at all.
        let custom = chat_capability(StreamPlatform::Custom, None);
        assert_eq!(custom.moderate, Some(CommentsModerateState::Unsupported));
        assert_eq!(
            serde_json::to_value(&custom).unwrap()["moderate"],
            "unsupported"
        );
        // The quota pause downgrades a ready YouTube destination only.
        let paused =
            chat_capabilities_with_quota(&[youtube.clone(), twitch_moderator.clone()], true);
        let by_platform = |capabilities: &[ChatCapability], platform: StreamPlatform| {
            capabilities
                .iter()
                .find(|capability| capability.platform == platform)
                .unwrap()
                .moderate
        };
        assert_eq!(
            by_platform(&paused, StreamPlatform::Youtube),
            Some(CommentsModerateState::Paused)
        );
        assert_eq!(
            by_platform(&paused, StreamPlatform::Twitch),
            Some(CommentsModerateState::Ready)
        );
        let running = chat_capabilities_with_quota(&[youtube.clone()], false);
        assert_eq!(
            by_platform(&running, StreamPlatform::Youtube),
            Some(CommentsModerateState::Ready)
        );
        // Provider rows carry it, and a row from an older backend still parses.
        let row = provider_state_from_capability(chat_capability(
            StreamPlatform::Youtube,
            Some(&youtube),
        ));
        assert_eq!(row.moderate, Some(CommentsModerateState::Ready));
        let mut wire = serde_json::to_value(&row).unwrap();
        assert_eq!(wire["moderate"], "ready");
        wire.as_object_mut().unwrap().remove("moderate");
        let legacy: LiveChatProviderState = serde_json::from_value(wire).unwrap();
        assert_eq!(legacy.moderate, None);
    }

    #[test]
    fn capabilities_cover_every_native_platform() {
        let accounts = vec![account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE])];
        let capabilities = chat_capabilities(&accounts);
        assert_eq!(capabilities.len(), 4);
        assert_eq!(capabilities[0].platform, StreamPlatform::Youtube);
        assert_eq!(capabilities[0].state, ChatCapabilityState::Available);
        assert_eq!(capabilities[1].platform, StreamPlatform::Twitch);
        assert_eq!(capabilities[1].state, ChatCapabilityState::NotConnected);
        assert_eq!(capabilities[2].platform, StreamPlatform::X);
        assert_eq!(capabilities[2].state, ChatCapabilityState::NotConnected);
        assert_eq!(capabilities[3].platform, StreamPlatform::Kick);
        assert_eq!(capabilities[3].state, ChatCapabilityState::NotConnected);
    }

    #[test]
    fn kick_read_and_write_scopes_are_modeled_separately() {
        let both = account(
            StreamPlatform::Kick,
            &[
                crate::kick_chat::KICK_EVENTS_SCOPE,
                crate::kick_chat::KICK_CHAT_WRITE_SCOPE,
            ],
        );
        let capability = chat_capability(StreamPlatform::Kick, Some(&both));
        assert_eq!(capability.state, ChatCapabilityState::Available);
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::Ready);

        let read_only = account(StreamPlatform::Kick, &[crate::kick_chat::KICK_EVENTS_SCOPE]);
        let capability = chat_capability(StreamPlatform::Kick, Some(&read_only));
        assert_eq!(capability.read, CommentsReadState::Ready);
        assert_eq!(capability.write, CommentsWriteState::MissingScope);

        let neither = account(StreamPlatform::Kick, &[]);
        let capability = chat_capability(StreamPlatform::Kick, Some(&neither));
        assert_eq!(capability.state, ChatCapabilityState::NeedsReconnect);
        assert!(capability.message.contains("Reconnect Kick"));
    }

    #[tokio::test]
    async fn manual_x_destination_stays_failed_instead_of_waiting_for_native_context() {
        let (events, _) = broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        let snapshot = start_live_chat(
            &state,
            LiveChatStartParams {
                session_id: "manual-x-session".to_string(),
                platforms: vec![StreamPlatform::X],
                destinations: vec![LiveChatDestinationStart {
                    target_id: "x-manual".to_string(),
                    platform: StreamPlatform::X,
                    read: Some(CommentsReadState::Unavailable),
                    write: Some(CommentsWriteState::ReadOnly),
                    preparation_error: Some(
                        "Manual RTMP has no native X broadcast context.".to_string(),
                    ),
                }],
                fake: None,
                fakes: Vec::new(),
                youtube: None,
                twitch: None,
                x: None,
                kick: None,
                audience: Vec::new(),
                fake_audience: Vec::new(),
            },
        )
        .await;

        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Failed
        );
        assert_eq!(snapshot.providers[0].read, CommentsReadState::Unavailable);
        assert_eq!(snapshot.providers[0].write, CommentsWriteState::ReadOnly);
        assert!(snapshot.providers[0].message.contains("Manual RTMP"));
    }

    #[test]
    fn unavailable_youtube_manual_rtmp_state_is_not_mislabeled_as_runtime_failure() {
        let providers = session_provider_rows(
            &[],
            &[],
            &[LiveChatDestinationStart {
                target_id: "youtube".to_string(),
                platform: StreamPlatform::Youtube,
                read: Some(CommentsReadState::Unavailable),
                write: Some(CommentsWriteState::Unavailable),
                preparation_error: Some(
                    "Connect YouTube and select the matching broadcast to attach Comments."
                        .to_string(),
                ),
            }],
        );

        assert_eq!(providers[0].state, LiveChatProviderConnectionState::Failed);
        assert_eq!(providers[0].read, CommentsReadState::Unavailable);
        assert_eq!(providers[0].write, CommentsWriteState::Unavailable);
    }

    #[test]
    fn live_chat_message_round_trips_with_camel_case_and_kebab_event_type() {
        let message = LiveChatMessage {
            id: live_chat_message_id(
                "session-1",
                StreamPlatform::Youtube,
                Some("target-1"),
                "abc123",
            ),
            provider_message_id: "abc123".to_string(),
            platform: StreamPlatform::Youtube,
            target_id: Some("target-1".to_string()),
            session_id: "session-1".to_string(),
            author_id: Some("author-1".to_string()),
            author_name: "Viewer".to_string(),
            author_avatar_url: None,
            author_badges: vec!["moderator".to_string()],
            author_roles: Vec::new(),
            published_at: "2026-06-06T00:00:00Z".to_string(),
            received_at: "2026-06-06T00:00:01Z".to_string(),
            message_text: "hello".to_string(),
            fragments: vec![LiveChatMessageFragment {
                fragment_type: "text".to_string(),
                text: "hello".to_string(),
                image_url: None,
                zero_width: false,
            }],
            event_type: LiveChatEventType::Paid,
            amount_text: Some("$5.00".to_string()),
            is_deleted: false,
            raw_provider_type: Some("superChatEvent".to_string()),
            details: None,
            reply: None,
            first_message: false,
            author_affiliation: None,
        };
        assert_eq!(message.id, "session-1:youtube:target-1:abc123");
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["providerMessageId"], "abc123");
        assert_eq!(json["eventType"], "paid");
        assert_eq!(json["platform"], "youtube");
        assert_eq!(json["fragments"][0]["type"], "text");
        let parsed: LiveChatMessage = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, message);
    }

    #[test]
    fn initial_snapshot_maps_capabilities_to_provider_rows() {
        let accounts = vec![account(StreamPlatform::Youtube, &[YOUTUBE_CHAT_SCOPE])];
        let snapshot = initial_chat_snapshot(&accounts, "now".to_string());
        assert_eq!(snapshot.providers.len(), 4);
        assert!(snapshot.messages.is_empty());
        assert_eq!(snapshot.providers[0].platform, StreamPlatform::Youtube);
        assert_eq!(
            snapshot.providers[0].state,
            LiveChatProviderConnectionState::Disabled
        );
        assert_eq!(
            snapshot.providers[2].state,
            LiveChatProviderConnectionState::Disabled
        );
    }

    #[test]
    fn delivery_matrix_keeps_read_only_and_unknown_truth() {
        let mut writable = provider_row(StreamPlatform::Twitch);
        writable.id = "tw-target".to_string();
        writable.target_id = Some("tw-target".to_string());
        writable.state = LiveChatProviderConnectionState::Connected;
        writable.read = CommentsReadState::Ready;
        writable.write = CommentsWriteState::Ready;
        let pending = initial_delivery_for_provider(&writable, true);
        assert_eq!(pending.phase, DestinationDeliveryPhase::Pending);

        let mut x = provider_row(StreamPlatform::X);
        x.id = "x-target".to_string();
        x.write = CommentsWriteState::ReadOnly;
        let read_only = initial_delivery_for_provider(&x, false);
        assert_eq!(read_only.phase, DestinationDeliveryPhase::ReadOnly);

        let mut operation = CommentsSendOperation {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "s1".to_string(),
            text: "hello".to_string(),
            phase: CommentsSendOperationPhase::Sending,
            destinations: vec![pending, read_only],
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };
        operation.mark_interrupted_unknown("later".to_string());
        assert_eq!(
            operation.destinations[0].phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(operation.phase, CommentsSendOperationPhase::DeliveryUnknown);
    }

    #[test]
    fn aggregate_send_phase_distinguishes_partial_from_unknown() {
        let delivery = |phase| DestinationDelivery {
            destination_id: format!("{phase:?}"),
            platform: StreamPlatform::Twitch,
            phase,
            provider_message_id: None,
            reason: None,
        };
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::TimedOutUnknown),
            ]),
            CommentsSendOperationPhase::Partial
        );
        assert_eq!(
            aggregate_send_phase(&[delivery(DestinationDeliveryPhase::TimedOutUnknown)]),
            CommentsSendOperationPhase::DeliveryUnknown
        );
        assert_eq!(
            aggregate_send_phase(&[delivery(DestinationDeliveryPhase::ReadOnly)]),
            CommentsSendOperationPhase::Failed
        );
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::ReadOnly),
            ]),
            CommentsSendOperationPhase::Partial
        );
        assert_eq!(
            aggregate_send_phase(&[
                delivery(DestinationDeliveryPhase::Sent),
                delivery(DestinationDeliveryPhase::Unavailable),
            ]),
            CommentsSendOperationPhase::Partial
        );
    }

    /// Plan 068 review, finding 2: `session.stop` retires chat and Orcle, but
    /// a listen-only transcription task drains with the capture (its last
    /// words reach the SRT and Clip that); with no capture running, or on an
    /// explicit `liveChat.stop`, it ends at once.
    #[tokio::test]
    async fn session_stop_lets_orcles_listen_task_drain_with_the_capture() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("session-a"));
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        crate::cohost::start_cohost_session_for_test(&state, "session-a").await;
        crate::captions::install_listen_only_test_task(&state).await;
        stop_live_chat_for_capture_end(&state).await;
        assert!(state.live_chat.lock().await.session_id().is_none());
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        assert!(crate::captions::caption_task_alive_for_test(&state).await);
        *state.recording.lock().await = None;
        crate::captions::finish_captions_for_capture(&state, "session-a").await;
        assert!(!crate::captions::caption_task_alive_for_test(&state).await);

        // No capture: nothing to drain with.
        state
            .live_chat
            .lock()
            .await
            .start_session("session-b".to_string(), Vec::new());
        crate::cohost::start_cohost_session_for_test(&state, "session-b").await;
        crate::captions::install_listen_only_test_task(&state).await;
        stop_live_chat_for_capture_end(&state).await;
        assert!(!crate::captions::caption_task_alive_for_test(&state).await);

        // An explicit chat stop is an opt-out: it aborts even while capturing.
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("session-c"));
        state
            .live_chat
            .lock()
            .await
            .start_session("session-c".to_string(), Vec::new());
        crate::cohost::start_cohost_session_for_test(&state, "session-c").await;
        crate::captions::install_listen_only_test_task(&state).await;
        stop_live_chat(&state).await;
        assert!(!crate::captions::caption_task_alive_for_test(&state).await);
        *state.recording.lock().await = None;
    }
}
