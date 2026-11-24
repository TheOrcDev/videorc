//! The Studio's Chat section (plan 204) as plain data: when it shows, what
//! its body says, and each row (`lib/studio-chat.ts`,
//! `lib/studio-chat-view.ts`, `lib/live-chat-view.ts`,
//! `components/studio/studio-chat.tsx`, `lib/chat-notice.ts`).
//!
//! Each row is a small avatar, the name and the words, and the platform mark;
//! a click puts it on stream through the backend's card and a click on the
//! live row takes it off (owner call, D10). Its accessible name is who said
//! what where ("Ada on YouTube: Ship it!").

use super::highlight::{self, HighlightFailure, RowHighlight, RowPhase, StatusChip};
use super::model::{CommentHighlightState, LiveChatMessage, LiveChatProviderState};
use super::store::LiveChat;

/// The section's words (`studio-chat.tsx`, `studio-chat-view.ts`).
pub mod copy {
    // No section title (plan 235 D3, the owner's call): the rows are plainly
    // chat and the list names itself `LIST`; the header keeps the way to the
    // Stream Manager and Hide.
    /// `STUDIO_CHAT_NO_CHAT`.
    pub const NO_CHAT: &str = "No destination on this livestream has chat.";
    /// `STUDIO_CHAT_CONNECTED`.
    pub const CONNECTED: &str = "Chat is connected. New messages appear here.";
    /// `STUDIO_CHAT_NO_MESSAGES`.
    pub const NO_MESSAGES: &str = "No messages yet.";
    /// `HIDE_STUDIO_CHAT_LABEL`: the hide button and its tooltip.
    pub const HIDE: &str = "Hide chat in Studio";
    /// The hide's toast (`HIDDEN_TOAST_ID`), its line and its Undo.
    pub const HIDDEN_TOAST_ID: &str = "studio-chat-hidden";
    pub const HIDDEN: &str = "Chat hidden in Studio";
    pub const HIDDEN_WHERE: &str = "Turn it back on in Settings → General.";
    pub const UNDO: &str = "Undo";
    /// The list's name (`aria-label="Chat messages"`).
    pub const LIST: &str = "Chat messages";
    /// `ChatJumpChip`: the way back to the newest message.
    pub const NEW_CHAT: &str = "New chat";
    pub const LATEST: &str = "Latest";
    pub const READING_BACK: &str = "reading back";
}

/// `MAX_RENDERED_LIVE_CHAT_MESSAGES`: the newest rows a list draws at once.
pub const MAX_RENDERED: usize = 200;

/// `studioChatShows`: the Settings switch is on and a livestream is on air
/// (chat exists only for a livestream: idle, a recording, Clips alone and a
/// start in flight show nothing, D2).
pub fn studio_chat_shows(switch_on: bool, live: bool) -> bool {
    switch_on && live
}

/// `CHAT_PLATFORM_LABELS` (`platformLabel`): "YouTube", "X", "Custom RTMP".
pub fn platform_label(platform: &str) -> &'static str {
    match platform {
        "youtube" => "YouTube",
        "twitch" => "Twitch",
        "kick" => "Kick",
        "x" => "X",
        "facebook" => "Facebook",
        "tiktok" => "TikTok",
        "instagram" => "Instagram",
        _ => "Custom RTMP",
    }
}

/// `providerStatePriority`: failed first, then a missing scope, then a
/// destination that can't read or waits on a sign-in, then unsupported;
/// 4 is healthy.
fn provider_priority(provider: &LiveChatProviderState) -> u8 {
    if provider.state == "failed" || provider.read == "failed" {
        0
    } else if provider.write == "missing-scope" {
        1
    } else if matches!(
        provider.read.as_str(),
        "unavailable" | "needs-sign-in" | "needs-videorc-sign-in"
    ) {
        2
    } else if provider.state == "unsupported" {
        3
    } else {
        4
    }
}

/// `liveChatProviderNotice`: what the destination whose chat most needs the
/// streamer says, or none.
pub fn provider_notice(providers: &[LiveChatProviderState]) -> Option<String> {
    providers
        .iter()
        .filter(|provider| provider_priority(provider) < 4)
        .min_by_key(|provider| provider_priority(provider))
        .map(|provider| provider.message.clone())
}

/// `studioChatNotice`: the one quiet line under the header while a
/// destination's chat needs the streamer (D9).
pub fn studio_chat_notice(providers: &[LiveChatProviderState]) -> Option<String> {
    provider_notice(providers)
        .map(|notice| notice.trim().to_string())
        .filter(|notice| !notice.is_empty())
}

/// `StudioChatBody`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StudioChatBody {
    /// One line, no list area: nothing on this livestream has chat.
    NoChat(&'static str),
    /// The list area at its full height, with a line while it is empty.
    List { empty_text: &'static str },
}

/// `studioChatBody`.
pub fn studio_chat_body(providers: &[LiveChatProviderState]) -> StudioChatBody {
    if providers.is_empty() {
        return StudioChatBody::NoChat(copy::NO_CHAT);
    }
    StudioChatBody::List {
        empty_text: if studio_chat_notice(providers).is_some() {
            copy::NO_MESSAGES
        } else {
            copy::CONNECTED
        },
    }
}

/// `studioChatMessages`: every chat message, without the activity-only
/// events (the Stream Manager's chat with no filter on).
pub fn studio_chat_counts(message: &LiveChatMessage) -> bool {
    !message.is_activity_only()
}

/// `commentCanHighlight`: a deleted or moderation row never goes on stream;
/// a notice (system, membership or activity) only as an activity card.
pub fn comment_can_highlight(message: &LiveChatMessage) -> bool {
    if message.is_deleted || matches!(message.event_type.as_str(), "deleted" | "moderation") {
        return false;
    }
    if message.event_type == "system"
        || message.event_type == "membership"
        || message.is_activity_only()
    {
        return message.details.is_some();
    }
    true
}

/// `CommentRowTint`: the one background a row paints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowTint {
    Paid,
    Member,
}

/// `commentRowTint(message, {spotlight: false, onStream})`: none on stream
/// (its button fill says so); a paid message; a member's own message.
pub fn comment_row_tint(message: &LiveChatMessage, on_stream: bool) -> Option<RowTint> {
    if on_stream {
        return None;
    }
    if message.amount_text.is_some() {
        return Some(RowTint::Paid);
    }
    let viewer_row = matches!(
        message.event_type.as_str(),
        "message" | "paid" | "membership"
    );
    (viewer_row && !message.is_deleted && message.author_roles.iter().any(|role| role == "member"))
        .then_some(RowTint::Member)
}

/// `noticeViewerWords`: the viewer's own words on a Twitch notice (a sub
/// with a message), when they differ from Twitch's sentence.
pub fn notice_viewer_words(message: &LiveChatMessage) -> Option<String> {
    if !message
        .raw_provider_type
        .as_deref()
        .is_some_and(|kind| kind.starts_with("channel.chat.notification"))
    {
        return None;
    }
    if message.details_kind() == Some("announcement") {
        return None;
    }
    let words: String = message
        .fragments
        .iter()
        .map(|fragment| fragment.text.as_str())
        .collect();
    let words = words.trim();
    (!words.is_empty() && words != message.message_text.trim()).then(|| words.to_string())
}

/// `monogramInitials`: one rule for every avatar circle (`chat::overlay`).
pub use super::overlay::monogram_initials;

/// How the words read (`studio-chat.tsx`'s classes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordsStyle {
    Plain,
    /// Plain system text and moderation lines: italic, secondary.
    Notice,
    /// A removed message: struck through, secondary.
    Deleted,
}

/// One row of the section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRowView {
    pub id: String,
    pub author: String,
    /// A Twitch notice's own sentence, over the viewer's words.
    pub notice_sentence: Option<String>,
    /// The words: the message, or the fragments' text when it carries
    /// emotes (an emote shows its name; its picture joins with S3.2a).
    pub words: String,
    pub style: WordsStyle,
    pub platform: String,
    pub platform_label: &'static str,
    /// "Ada on YouTube: Ship it!": the button's accessible name.
    pub name: String,
    /// What a click does, then what failed (the button's description).
    pub description: String,
    /// A click puts it on stream (or takes it off): live, and allowed.
    pub highlightable: bool,
    pub phase: RowPhase,
    /// The failure's line under the words.
    pub problem: Option<String>,
    pub chips: Vec<(&'static str, StatusChip)>,
    pub tint: Option<RowTint>,
    /// A paid message's amount, as a warning chip.
    pub amount: Option<String>,
    pub avatar_url: Option<String>,
    pub initials: String,
    /// A returning person's arrival chip (plan 225 C1): on the arrival row
    /// only, after the role tags and First chat.
    pub arrival: Option<super::arrival::ArrivalChip>,
    /// S3.2b: the words as pieces, each emote its picture, and the GIFs as
    /// blocks (`CommentMessageBody`, the Stream Manager's message body).
    pub pieces: Vec<crate::stream_manager::rows::Piece>,
    pub gifs: Vec<crate::stream_manager::rows::Gif>,
}

/// The words a row shows (`MessageBody`'s text, the emotes as their names).
fn row_words(message: &LiveChatMessage, notice_words: Option<&String>) -> String {
    if let Some(words) = notice_words {
        return words.clone();
    }
    if message
        .fragments
        .iter()
        .any(|fragment| fragment.image_url.is_some())
    {
        return message
            .fragments
            .iter()
            .map(|fragment| fragment.text.as_str())
            .collect();
    }
    message.message_text.clone()
}

impl ChatRowView {
    /// `StudioChatRow` for one message.
    pub fn new(message: &LiveChatMessage, highlight: RowHighlight, live: bool) -> Self {
        let notice_words = notice_viewer_words(message);
        let words = row_words(message, notice_words.as_ref());
        let style = if message.is_deleted {
            WordsStyle::Deleted
        } else if (message.event_type == "system" && notice_words.is_none())
            || message.event_type == "moderation"
        {
            WordsStyle::Notice
        } else {
            WordsStyle::Plain
        };
        let platform_label = platform_label(&message.platform);
        let spoken = match &notice_words {
            Some(_) => [message.message_text.as_str(), words.as_str()].join(" "),
            None => words.clone(),
        };
        // `aria-labelledby` of the author, the mark's hidden words and the
        // text: who, where, what.
        let platform_words = format!("on {platform_label}:");
        Self {
            id: message.id.clone(),
            author: message.author_name.clone(),
            notice_sentence: notice_words.as_ref().map(|_| message.message_text.clone()),
            words,
            style,
            platform: message.platform.clone(),
            platform_label,
            name: [
                message.author_name.as_str(),
                platform_words.as_str(),
                spoken.trim(),
            ]
            .join(" "),
            description: highlight::row_description(&highlight),
            highlightable: live && comment_can_highlight(message),
            phase: highlight.phase,
            problem: highlight::problem(&highlight),
            chips: highlight::status_chips(&highlight),
            tint: comment_row_tint(message, highlight.phase == RowPhase::Live),
            amount: message.amount_text.clone(),
            avatar_url: message.author_avatar_url.clone(),
            initials: monogram_initials(&message.author_name),
            arrival: super::arrival::arrival_chip(message.arrival.as_ref()),
            pieces: Vec::new(),
            gifs: Vec::new(),
        }
        .with_pieces(message)
    }

    fn with_pieces(mut self, message: &LiveChatMessage) -> Self {
        let (pieces, gifs) = crate::stream_manager::rows::message_pieces(message, false);
        self.pieces = pieces;
        self.gifs = gifs;
        self
    }
}

/// The highlight as the rows read it.
#[derive(Debug, Clone, Copy)]
pub struct HighlightInput<'a> {
    pub state: &'a CommentHighlightState,
    pub applying_id: Option<&'a str>,
    pub failure: Option<&'a HighlightFailure>,
}

/// The whole section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudioChatView {
    pub notice: Option<String>,
    pub body: StudioChatBody,
    /// The newest [`MAX_RENDERED`] chat rows, oldest first.
    pub rows: Vec<ChatRowView>,
}

impl StudioChatView {
    pub fn new(chat: &LiveChat, highlight: HighlightInput<'_>) -> Self {
        // A message goes on stream only during the livestream it came from.
        let live = chat.session_id.is_some();
        let shown: Vec<&LiveChatMessage> = chat
            .messages
            .iter()
            .map(AsRef::as_ref)
            .filter(|message| studio_chat_counts(message))
            .collect();
        let start = shown.len().saturating_sub(MAX_RENDERED);
        let rows = shown[start..]
            .iter()
            .map(|message| {
                let row = highlight::presentation(
                    &message.id,
                    highlight.state,
                    highlight.applying_id,
                    highlight.failure,
                );
                ChatRowView::new(message, row, live)
            })
            .collect();
        Self {
            notice: studio_chat_notice(&chat.providers),
            body: studio_chat_body(&chat.providers),
            rows,
        }
    }
}

/// `ChatJumpChip`'s words: "12 new", "New chat" when the count is unknown,
/// or "Latest"; and its accessible name.
pub fn jump_chip(unread: usize, incomplete: bool) -> (String, String) {
    let text = if incomplete {
        copy::NEW_CHAT.to_string()
    } else if unread > 0 {
        format!("{unread} new")
    } else {
        copy::LATEST.to_string()
    };
    let state = if incomplete {
        copy::NEW_CHAT.to_string()
    } else if unread > 0 {
        format!("{unread} new")
    } else {
        copy::READING_BACK.to_string()
    };
    (text, format!("Chat paused: {state}. Jump to the newest"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::{CommentHighlightPhase, LiveChatFragment, LiveChatSnapshotWire};

    fn provider(read: &str, write: &str, state: &str, message: &str) -> LiveChatProviderState {
        LiveChatProviderState {
            id: format!("{read}-{write}-{state}"),
            platform: "youtube".into(),
            read: read.into(),
            write: write.into(),
            state: state.into(),
            message: message.into(),
            ..LiveChatProviderState::default()
        }
    }

    fn message(id: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: id.into(),
            session_id: "s".into(),
            platform: "youtube".into(),
            author_name: "Ada Lovelace".into(),
            received_at: format!("2026-11-10T10:00:{id}Z"),
            message_text: "Ship it!".into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        }
    }

    // `studio-chat.test.ts`.
    #[test]
    fn the_section_shows_only_while_on_air_with_the_switch_on() {
        assert!(studio_chat_shows(true, true));
        assert!(!studio_chat_shows(true, false));
        assert!(!studio_chat_shows(false, true));
    }

    // `studio-chat-view.test.ts`.
    #[test]
    fn the_body_and_the_notice_follow_the_destinations() {
        assert_eq!(studio_chat_body(&[]), StudioChatBody::NoChat(copy::NO_CHAT));
        let healthy = [provider("ready", "ready", "connected", "Connected")];
        assert_eq!(
            studio_chat_body(&healthy),
            StudioChatBody::List {
                empty_text: copy::CONNECTED
            }
        );
        assert_eq!(studio_chat_notice(&healthy), None);
        let broken = [
            provider(
                "unavailable",
                "ready",
                "connected",
                "Reconnect YouTube to read chat.",
            ),
            provider("failed", "ready", "failed", "  Twitch chat failed.  "),
        ];
        assert_eq!(
            studio_chat_body(&broken),
            StudioChatBody::List {
                empty_text: copy::NO_MESSAGES
            }
        );
        assert_eq!(
            studio_chat_notice(&broken).as_deref(),
            Some("Twitch chat failed.")
        );
    }

    #[test]
    fn a_row_is_named_by_who_said_what_where() {
        let row = ChatRowView::new(&message("01"), RowHighlight::default(), true);
        assert_eq!(row.name, "Ada Lovelace on YouTube: Ship it!");
        assert_eq!(row.description, "Shows it on stream");
        assert_eq!(row.initials, "AL");
        assert!(row.highlightable);
        assert_eq!(row.style, WordsStyle::Plain);
        // Off air: a fact, not a button.
        assert!(!ChatRowView::new(&message("01"), RowHighlight::default(), false).highlightable);
    }

    #[test]
    fn emotes_show_their_names_and_notices_their_sentence() {
        let mut emoted = message("02");
        emoted.message_text = "hello smokeHYPE".into();
        emoted.fragments = vec![
            LiveChatFragment {
                fragment_type: "text".into(),
                text: "hello ".into(),
                ..LiveChatFragment::default()
            },
            LiveChatFragment {
                fragment_type: "emote".into(),
                text: "smokeHYPE".into(),
                image_url: Some("https://files.kick.com/emotes/1/fullsize".into()),
                zero_width: false,
            },
        ];
        assert_eq!(
            ChatRowView::new(&emoted, RowHighlight::default(), true).words,
            "hello smokeHYPE"
        );

        let mut sub = message("03");
        sub.event_type = "system".into();
        sub.raw_provider_type = Some("channel.chat.notification".into());
        sub.message_text = "Ada subscribed for 3 months".into();
        sub.fragments = vec![LiveChatFragment {
            fragment_type: "text".into(),
            text: "love this stream".into(),
            ..LiveChatFragment::default()
        }];
        let row = ChatRowView::new(&sub, RowHighlight::default(), true);
        assert_eq!(
            row.notice_sentence.as_deref(),
            Some("Ada subscribed for 3 months")
        );
        assert_eq!(row.words, "love this stream");
        assert_eq!(row.style, WordsStyle::Plain);
        assert!(
            !row.highlightable,
            "a system row without details stays off the card"
        );

        let mut moderation = message("04");
        moderation.event_type = "moderation".into();
        assert_eq!(
            ChatRowView::new(&moderation, RowHighlight::default(), true).style,
            WordsStyle::Notice
        );
    }

    // `live-chat-view.test.ts`: commentCanHighlight and commentRowTint.
    #[test]
    fn what_can_go_on_stream_and_the_one_tint() {
        let mut deleted = message("05");
        deleted.is_deleted = true;
        assert!(!comment_can_highlight(&deleted));
        let mut sub = message("06");
        sub.event_type = "membership".into();
        assert!(!comment_can_highlight(&sub));
        sub.details = Some(serde_json::json!({"kind": "membership"}));
        assert!(comment_can_highlight(&sub));

        let mut paid = message("07");
        paid.amount_text = Some("$5.00".into());
        paid.author_roles = vec!["member".into()];
        assert_eq!(comment_row_tint(&paid, false), Some(RowTint::Paid));
        assert_eq!(comment_row_tint(&paid, true), None);
        let mut member = message("08");
        member.author_roles = vec!["member".into()];
        assert_eq!(comment_row_tint(&member, false), Some(RowTint::Member));
    }

    #[test]
    fn the_view_lists_chat_rows_newest_last_without_activity() {
        let mut chat = LiveChat::default();
        let mut follow = message("02");
        follow.event_type = "follow".into();
        chat.apply_snapshot(
            LiveChatSnapshotWire {
                session_id: Some("s".into()),
                providers: vec![provider("ready", "ready", "connected", "")],
                messages: vec![message("01"), follow, message("03")],
                updated_at: String::new(),
            },
            false,
        );
        let state = CommentHighlightState {
            session_id: Some("s".into()),
            message_id: Some("03".into()),
            generation: 2,
            phase: CommentHighlightPhase::Live,
            ..CommentHighlightState::default()
        };
        let view = StudioChatView::new(
            &chat,
            HighlightInput {
                state: &state,
                applying_id: None,
                failure: None,
            },
        );
        assert_eq!(
            view.rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["01", "03"]
        );
        assert_eq!(view.rows[1].phase, RowPhase::Live);
        assert_eq!(view.rows[1].description, "Takes it off the stream");
        assert_eq!(view.rows[1].chips, [("On stream", StatusChip::Chrome)]);
    }

    #[test]
    fn the_jump_chip_counts_or_says_new_chat() {
        assert_eq!(jump_chip(12, false).0, "12 new");
        assert_eq!(jump_chip(3, true).0, "New chat");
        assert_eq!(
            jump_chip(0, false),
            (
                "Latest".to_string(),
                "Chat paused: reading back. Jump to the newest".to_string()
            )
        );
    }

    #[test]
    fn initials_are_the_first_letters_of_two_words() {
        assert_eq!(monogram_initials("ada"), "A");
        assert_eq!(monogram_initials("  "), "?");
        assert_eq!(monogram_initials("élan vital extra"), "ÉV");
    }
}
