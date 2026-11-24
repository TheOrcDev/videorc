//! Live chat as the backend sends it (`liveChat.status`, `liveChat.snapshot`,
//! `liveChat.message`, `liveChat.providerStatus`, `liveChat.cleared`,
//! `comments.highlight.status`), read leniently: the fields the Studio uses,
//! each with the default the renderer's code falls back to, so a field the
//! backend adds later never drops a message. The backend's own types live in
//! `videorc-backend` (`live_chat.rs`, `comment_highlight.rs`); these mirror
//! `shared/backend.ts`' `LiveChatMessage`, `LiveChatProviderState`,
//! `LiveChatSnapshot` and `CommentHighlightState`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One rich-text piece of a message (`LiveChatMessageFragment`): plain text,
/// an emote with its image, a mention, a Twitch GIF.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatFragment {
    #[serde(rename = "type", default)]
    pub fragment_type: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// A 7TV zero-width emote: drawn over the emote before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub zero_width: bool,
}

/// `ViewerArrival`: what the chat row's arrival chip says about a returning
/// person (plan 225 D11).
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerArrival {
    /// Streams chatted in, including this one.
    #[serde(default)]
    pub streams: u32,
    #[serde(default)]
    pub regular: bool,
    /// Only for Back (D7): days since the last chat, 30 or more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_days: Option<u32>,
    #[serde(default)]
    pub in_a_row: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ViewerMilestone>,
    /// Only when the person has two or more accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    /// `2026-03`, for the hover line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// `ViewerMilestone`: `streams`, `row` or `anniversary` (kept as the wire's
/// word), and the stream count, the run, or the anniversary's year.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
pub struct ViewerMilestone {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub value: u32,
}

/// One chat row (`LiveChatMessage`). The platform and the event type stay
/// the wire's words, so an older Studio never drops a row it can't name.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatMessage {
    /// `{session}:{platform}:{target}:{providerMessageId}`: the dedupe key.
    pub id: String,
    #[serde(default)]
    pub provider_message_id: String,
    /// `youtube`, `twitch`, `kick`, `x`, `facebook`, `tiktok`,
    /// `instagram` or `custom`.
    #[serde(default)]
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    #[serde(default)]
    pub author_roles: Vec<String>,
    /// The platform's badge names, as sent (`authorBadges`).
    #[serde(default)]
    pub author_badges: Vec<String>,
    /// A returning person's arrival facts (plan 225 D11): only on the
    /// arrival row, never on a first-timer's, a bot's or the streamer's.
    /// Absent, never null; the row's chip is drawn from it alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival: Option<ViewerArrival>,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub received_at: String,
    #[serde(default)]
    pub message_text: String,
    #[serde(default)]
    pub fragments: Vec<LiveChatFragment>,
    /// `message`, `paid`, `membership`, `system`, `deleted`, `moderation`,
    /// `follow`, `power-up` or `redemption`.
    #[serde(default)]
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_text: Option<String>,
    #[serde(default)]
    pub is_deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_provider_type: Option<String>,
    /// A monetized or community event's facts (`details`), kept as sent:
    /// the Studio only asks whether there are any, and which kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    /// S3.2a: the author's platform id (a chatter counts once by it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    /// S3.2a: the viewer's first message in this channel ("First chat").
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub first_message: bool,
    /// S3.2a: the message this one answers (Twitch's reply thread).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<LiveChatReply>,
    /// S3.2a: X's verified check (plan 167): `blue`, `business` or
    /// `government`; anything else shows none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_verified: Option<String>,
    /// S3.2a: the organization an X author is affiliated with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_affiliation: Option<LiveChatAuthorAffiliation>,
}

/// The message a reply answers (`LiveChatMessage['reply']`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatReply {
    #[serde(default)]
    pub parent_author_name: String,
    #[serde(default)]
    pub parent_text: String,
}

/// An X author's organization badge (`LiveChatAuthorAffiliation`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatAuthorAffiliation {
    #[serde(default)]
    pub badge_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl LiveChatMessage {
    /// `isActivityOnlyEvent`: a follow, a Power-up or a redemption is
    /// Activity's, never a chat row.
    pub fn is_activity_only(&self) -> bool {
        is_activity_only_event(&self.event_type)
    }

    /// `details.kind`, when the message carries facts.
    pub fn details_kind(&self) -> Option<&str> {
        self.details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(Value::as_str)
    }
}

/// `isActivityOnlyEvent` (`shared/backend.ts`).
pub fn is_activity_only_event(event_type: &str) -> bool {
    matches!(event_type, "follow" | "power-up" | "redemption")
}

/// One destination's chat (`LiveChatProviderState`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatProviderState {
    /// The destination's identity: never the platform alone.
    pub id: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// `connecting`, `ready`, `waiting-for-broadcast-context`, `ended`,
    /// `failed`, `unavailable`, `needs-sign-in`, `needs-videorc-sign-in`.
    #[serde(default)]
    pub read: String,
    /// `ready`, `missing-scope`, `read-only`, `failed`, `unavailable`.
    #[serde(default)]
    pub write: String,
    /// The connector's lifecycle (`connected`, `failed`, `unsupported` …).
    #[serde(default)]
    pub state: String,
    /// The streamer's sentence for this destination's chat.
    #[serde(default)]
    pub message: String,
    /// S3.2x.2: when a `waiting` connector resumes (plan 094's YouTube
    /// quota pause, `retryAt`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    /// S3.2a: the streamer's own account on it (a message naming it is a
    /// mention, "@you").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    /// S3.2b: whether the account may delete messages there (`ready`,
    /// `missing-scope`, …): Remove from chat says the fix when it can't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moderate: Option<String>,
}

/// The whole chat at once (`LiveChatSnapshot`): `liveChat.status`'s answer,
/// `liveChat.snapshot` and `liveChat.cleared`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatSnapshotWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<LiveChatProviderState>,
    #[serde(default)]
    pub messages: Vec<LiveChatMessage>,
    #[serde(default)]
    pub updated_at: String,
}

/// The backend's highlight lifecycle (`CommentHighlightState['phase']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommentHighlightPhase {
    #[default]
    Idle,
    Live,
    Failed,
}

/// `CommentHighlightState`: the backend owns `On stream` (the card, its
/// lifetime and its generation); the Studio only mirrors it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentHighlightState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub phase: CommentHighlightPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_returning_viewers_arrival_and_badges_survive_the_read() {
        let message: LiveChatMessage = serde_json::from_value(json!({
            "id": "s:twitch:t:1",
            "authorName": "Mia",
            "authorBadges": ["subscriber", "vip"],
            "arrival": {
                "streams": 12, "regular": true, "inARow": 3,
                "milestone": { "kind": "streams", "value": 10 },
                "platforms": ["twitch", "youtube"], "since": "2026-03"
            }
        }))
        .unwrap();
        assert_eq!(message.author_badges, ["subscriber", "vip"]);
        let arrival = message.arrival.expect("arrival");
        assert_eq!(
            (arrival.streams, arrival.regular, arrival.in_a_row),
            (12, true, 3)
        );
        assert_eq!(arrival.away_days, None);
        assert_eq!(
            arrival.milestone,
            Some(ViewerMilestone {
                kind: "streams".into(),
                value: 10
            })
        );
        assert_eq!(arrival.since.as_deref(), Some("2026-03"));
        // A first-timer's row has no arrival, and it stays absent when written back.
        let first: LiveChatMessage = serde_json::from_value(json!({ "id": "x" })).unwrap();
        assert!(first.arrival.is_none());
        assert!(
            serde_json::to_value(&first)
                .unwrap()
                .get("arrival")
                .is_none()
        );
    }

    #[test]
    fn a_message_reads_with_the_backends_fields_and_ignores_new_ones() {
        let message: LiveChatMessage = serde_json::from_value(json!({
            "id": "s:youtube:t:1",
            "providerMessageId": "1",
            "platform": "youtube",
            "targetId": "t",
            "sessionId": "s",
            "authorName": "Ada",
            "authorAvatarUrl": "https://yt3.ggpht.com/a.png",
            "authorBadges": [],
            "authorRoles": ["member"],
            "publishedAt": "2026-11-10T10:00:00Z",
            "receivedAt": "2026-11-10T10:00:01Z",
            "messageText": "Ship it!",
            "fragments": [{"type": "text", "text": "Ship it!"}],
            "eventType": "message",
            "someFutureField": {"x": 1}
        }))
        .unwrap();
        assert_eq!(message.author_name, "Ada");
        assert_eq!(message.fragments[0].text, "Ship it!");
        assert!(!message.is_deleted);
        assert!(!message.is_activity_only());
        assert_eq!(message.details_kind(), None);
    }

    #[test]
    fn the_highlight_state_reads_each_phase() {
        let live: CommentHighlightState = serde_json::from_value(json!({
            "sessionId": "s", "messageId": "m", "generation": 3, "phase": "live",
            "expiresAt": "2026-11-10T10:00:10Z"
        }))
        .unwrap();
        assert_eq!(live.phase, CommentHighlightPhase::Live);
        let idle: CommentHighlightState =
            serde_json::from_value(json!({"generation": 4, "phase": "idle"})).unwrap();
        assert_eq!(idle.phase, CommentHighlightPhase::Idle);
        assert_eq!(idle.message_id, None);
    }
}
