//! The chat pane's read side beyond the rows (`chat-pane.tsx`,
//! `lib/stream-manager-chat.ts`, `platform-filter.tsx`,
//! `chat-sign-in-rows.tsx`, the row's ⋯ menu in `comment-row.tsx`):
//!
//! - the filters (plan 055, D3): the platform, mentions of the streamer and
//!   search; Sidekick's Questions join with the Sidekick pane (S3.2d);
//! - the one platform filter for Chat (plan 174 S3.16a, H-19): an All chip
//!   and one icon chip per platform from 640 px, the same choice as a radio
//!   group in the Filters menu below it, and nothing with one platform;
//! - the rows that say a chat needs a sign-in (plan 213 J1, plan 215 A3);
//! - each row's ⋯ menu: Show on stream (or Take off stream), Reply, a link's
//!   Open and Copy, Copy, and Remove from chat last, destructive.

use std::sync::Arc;

use super::links::{MAX_MENU_LINKS, chat_links_in};
use super::removal::REMOVE_FROM_CHAT;
use super::rows::comment_mentions;
use crate::chat::model::{LiveChatMessage, LiveChatProviderState};
use crate::chat::view::{notice_viewer_words, platform_label};

/// The pane's words.
pub mod copy {
    /// S3.2f (plan 226 D12): the failure rows over the chat.
    pub const FAILURES_LABEL: &str = "Chat command replies that couldn't go out";
    pub fn dismiss_label(line: &str) -> String {
        format!("Dismiss: {line}")
    }
    pub const SHOW_CHAT_FROM: &str = "Show chat from";
    pub const CHAT_FILTERS: &str = "Chat filters";
    pub const FILTERS: &str = "Filters";
    pub const ALL: &str = "All";
    pub const EVERY_PLATFORM: &str = "Every platform";
    pub const MENTIONS: &str = "Mentions";
    pub const MENTIONS_HINT: &str = "Messages that @mention your channel";
    /// S3.2d: Sidekick's Questions filter.
    pub const QUESTIONS: &str = "Questions";
    pub const QUESTIONS_HINT: &str = "Messages behind Sidekick's open questions";
    pub const SEARCH_LABEL: &str = "Search chat";
    pub const SEARCH_PLACEHOLDER: &str = "Search chat…";
    pub const NO_MATCH: &str = "No messages match these filters.";
    pub const SIGN_IN_ROWS: &str = "Chat that needs a sign-in";
    pub const SIGN_IN_TO_VIDEORC: &str = "Sign in to Videorc";
    pub const USE_SIGN_IN: &str = "Use Sign in";
    pub const SHOW_ON_STREAM: &str = "Show on stream";
    pub const TAKE_OFF_STREAM: &str = "Take off stream";
    pub const REPLY: &str = "Reply";
    pub const COPY: &str = "Copy";
    pub const OPEN_LINK: &str = "Open link";
    pub const COPY_LINK: &str = "Copy link";
    pub const OPEN_FAILED: &str = "Couldn't open that link";
    pub const OPEN_FAILED_NEXT: &str = "Copy it and open it in your browser.";
    pub const COPY_LINK_FAILED: &str = "Couldn't copy that link";
    pub const COPY_LINK_FAILED_NEXT: &str = "Select the text and copy it from there.";
    /// `copyChatText`'s default failure (a row's Copy and C).
    pub const COPY_FAILED: &str = "Couldn't copy that.";
}

/// `ChatPaneFilter`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatFilter {
    /// `None` is every platform.
    pub platform: Option<String>,
    pub mentions: bool,
    /// S3.2d: the messages behind Sidekick's open questions only, and those
    /// messages as Buddy has them now.
    pub questions: bool,
    pub question_messages: Vec<String>,
    pub search: String,
}

impl ChatFilter {
    /// The chips that are on (the Filters button's count).
    pub fn active_count(&self) -> usize {
        usize::from(self.platform.is_some())
            + usize::from(self.mentions)
            + usize::from(self.questions)
    }

    /// A filter or a search hides some messages.
    pub fn filtering(&self) -> bool {
        self.active_count() > 0 || !self.search.trim().is_empty()
    }

    /// `chatPaneMessages` for one message.
    pub fn shows(&self, message: &LiveChatMessage, mention_names: &[String]) -> bool {
        if message.is_activity_only() {
            return false;
        }
        if self
            .platform
            .as_deref()
            .is_some_and(|platform| message.platform != platform)
        {
            return false;
        }
        if self.questions && !self.question_messages.contains(&message.id) {
            return false;
        }
        if self.mentions && !comment_mentions(message, mention_names) {
            return false;
        }
        let query = self.search.trim().to_lowercase();
        if !query.is_empty()
            && !message.message_text.to_lowercase().contains(&query)
            && !message.author_name.to_lowercase().contains(&query)
        {
            return false;
        }
        true
    }
}

/// `chatPaneMessages`.
pub fn chat_pane_messages<'a>(
    messages: &'a [Arc<LiveChatMessage>],
    filter: &ChatFilter,
    mention_names: &[String],
) -> Vec<&'a Arc<LiveChatMessage>> {
    messages
        .iter()
        .filter(|message| filter.shows(message, mention_names))
        .collect()
}

/// The platforms the filter offers: the destinations', then any a message
/// came from, each once.
pub fn filter_platforms(
    providers: &[LiveChatProviderState],
    messages: &[Arc<LiveChatMessage>],
) -> Vec<String> {
    let mut platforms: Vec<String> = Vec::new();
    for platform in providers
        .iter()
        .map(|provider| &provider.platform)
        .chain(messages.iter().map(|message| &message.platform))
    {
        if !platforms.contains(platform) {
            platforms.push(platform.clone());
        }
    }
    platforms
}

/// `Only YouTube`: a platform chip's tooltip.
pub fn only_platform(platform: &str) -> String {
    format!("Only {}", platform_label(platform))
}

/// One "needs a sign-in" row (`ChatSignInRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInRow {
    pub id: String,
    pub target_id: Option<String>,
    pub platform: String,
    pub message: String,
    /// The Videorc sign-in (true) or the platform's (Use Sign in).
    pub videorc: bool,
}

impl SignInRow {
    /// The button's name: "X: Sign in to Videorc", "X: Use Sign in".
    pub fn button_label(&self) -> String {
        let label = platform_label(&self.platform);
        if self.videorc {
            format!("{label}: Sign in to Videorc")
        } else {
            format!("{label}: Use Sign in")
        }
    }
}

/// `chatSignInRows`: the destinations whose chat only a sign-in brings.
pub fn chat_sign_in_rows(providers: &[LiveChatProviderState]) -> Vec<SignInRow> {
    providers
        .iter()
        .filter_map(|provider| {
            let videorc = provider.read == "needs-videorc-sign-in";
            let platform = provider.read == "needs-sign-in" && provider.target_id.is_some();
            (videorc || platform).then(|| SignInRow {
                id: provider.id.clone(),
                target_id: provider.target_id.clone(),
                platform: provider.platform.clone(),
                message: provider.message.clone(),
                videorc,
            })
        })
        .collect()
}

/// `commentLinkText`: the viewer-written text whose links a row offers.
pub fn comment_link_text(message: &LiveChatMessage) -> Option<String> {
    if message.is_deleted {
        return None;
    }
    if let Some(words) = notice_viewer_words(message) {
        return Some(words);
    }
    matches!(message.event_type.as_str(), "message" | "paid").then(|| message.message_text.clone())
}

/// One item of a row's ⋯ menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowAction {
    Highlight,
    Reply,
    OpenLink(String),
    CopyLink(String),
    Copy,
    Remove,
}

/// One entry: its words, its glyph, and its state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowMenuItem {
    pub action: RowAction,
    pub label: String,
    /// `livestream`, `send`, `external-link`, `copy` or `delete`.
    pub icon: &'static str,
    pub destructive: bool,
    pub disabled: bool,
    /// Why it is off (Remove from chat without the permission).
    pub reason: Option<String>,
    /// A hairline above it (the destructive group).
    pub separated: bool,
}

fn item(action: RowAction, label: impl Into<String>, icon: &'static str) -> RowMenuItem {
    RowMenuItem {
        action,
        label: label.into(),
        icon,
        destructive: false,
        disabled: false,
        reason: None,
        separated: false,
    }
}

/// What a row's ⋯ menu offers.
#[derive(Debug, Clone, Copy, Default)]
pub struct RowMenuInputs<'a> {
    pub highlightable: bool,
    pub on_stream: bool,
    pub can_reply: bool,
    /// Remove from chat can run (`rowRemoval`'s `onRemove`).
    pub removable: bool,
    /// Why Remove from chat is off; the item stays, disabled.
    pub remove_reason: Option<&'a str>,
}

/// `commentRowMenu`: the stream toggle says "Take off stream", never
/// "Remove": only the irreversible item may say remove. Copy and the links
/// stay in History too.
pub fn row_menu(message: &LiveChatMessage, inputs: RowMenuInputs<'_>) -> Vec<RowMenuItem> {
    let mut items = Vec::new();
    if inputs.highlightable {
        items.push(item(
            RowAction::Highlight,
            if inputs.on_stream {
                copy::TAKE_OFF_STREAM
            } else {
                copy::SHOW_ON_STREAM
            },
            "livestream",
        ));
    }
    if inputs.can_reply && matches!(message.event_type.as_str(), "message" | "paid") {
        items.push(item(RowAction::Reply, copy::REPLY, "send"));
    }
    let links = comment_link_text(message)
        .map(|text| chat_links_in(&text))
        .unwrap_or_default();
    let named = links.len() > 1;
    for link in links.into_iter().take(MAX_MENU_LINKS) {
        items.push(item(
            RowAction::OpenLink(link.href.clone()),
            if named {
                format!("Open {}", link.host)
            } else {
                copy::OPEN_LINK.to_string()
            },
            "external-link",
        ));
        items.push(item(
            RowAction::CopyLink(link.href.clone()),
            if named {
                format!("Copy {} link", link.host)
            } else {
                copy::COPY_LINK.to_string()
            },
            "copy",
        ));
    }
    items.push(item(RowAction::Copy, copy::COPY, "copy"));
    if inputs.removable || inputs.remove_reason.is_some() {
        items.push(RowMenuItem {
            destructive: true,
            disabled: !inputs.removable,
            reason: inputs.remove_reason.map(str::to_string),
            separated: true,
            ..item(RowAction::Remove, REMOVE_FROM_CHAT, "delete")
        });
    }
    items
}

/// The ⋯ trigger's name: "Actions for Ada's message".
pub fn row_menu_label(author: &str) -> String {
    format!("Actions for {author}'s message")
}

/// "name: words" for Copy and C.
pub fn copy_text(message: &LiveChatMessage) -> String {
    format!("{}: {}", message.author_name, message.message_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, platform: &str, author: &str, text: &str) -> Arc<LiveChatMessage> {
        Arc::new(LiveChatMessage {
            id: id.into(),
            session_id: "s".into(),
            platform: platform.into(),
            author_name: author.into(),
            message_text: text.into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        })
    }

    // `stream-manager-chat.test.ts`.
    #[test]
    fn the_filters_narrow_by_platform_mention_and_search() {
        let messages = vec![
            message("1", "youtube", "Ada", "hello @orc"),
            message("2", "twitch", "Bo", "Ship it"),
            Arc::new(LiveChatMessage {
                event_type: "follow".into(),
                ..(*message("3", "twitch", "Cy", "")).clone()
            }),
        ];
        let names = ["orc".to_string()];
        let all = ChatFilter::default();
        assert_eq!(
            chat_pane_messages(&messages, &all, &names).len(),
            2,
            "no follows"
        );
        assert!(!all.filtering());
        let twitch = ChatFilter {
            platform: Some("twitch".into()),
            ..ChatFilter::default()
        };
        assert_eq!(chat_pane_messages(&messages, &twitch, &names)[0].id, "2");
        assert_eq!(twitch.active_count(), 1);
        let mentions = ChatFilter {
            mentions: true,
            ..ChatFilter::default()
        };
        assert_eq!(chat_pane_messages(&messages, &mentions, &names)[0].id, "1");
        let search = ChatFilter {
            search: " BO ".into(),
            ..ChatFilter::default()
        };
        assert_eq!(chat_pane_messages(&messages, &search, &names)[0].id, "2");
        assert!(search.filtering());
        assert_eq!(filter_platforms(&[], &messages), ["youtube", "twitch"]);
    }

    #[test]
    fn a_rows_menu_offers_its_links_and_removal_last() {
        let row = message("1", "twitch", "Ada", "see videorc.com and docs.videorc.com");
        let menu = row_menu(
            &row,
            RowMenuInputs {
                highlightable: true,
                on_stream: true,
                can_reply: true,
                removable: false,
                remove_reason: Some("Reconnect Twitch to remove messages"),
            },
        );
        let labels: Vec<&str> = menu.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Take off stream",
                "Reply",
                "Open videorc.com",
                "Copy videorc.com link",
                "Open docs.videorc.com",
                "Copy docs.videorc.com link",
                "Copy",
                "Remove from chat"
            ]
        );
        let remove = menu.last().unwrap();
        assert!(remove.destructive && remove.disabled && remove.separated);
        let plain = row_menu(&message("2", "x", "Bo", "hi"), RowMenuInputs::default());
        assert_eq!(plain.len(), 1, "History: Copy alone");
        assert_eq!(row_menu_label("Ada"), "Actions for Ada's message");
    }

    #[test]
    fn a_sign_in_row_names_its_door() {
        let providers = [
            LiveChatProviderState {
                id: "x1".into(),
                platform: "x".into(),
                read: "needs-videorc-sign-in".into(),
                message: "Sign in to Videorc to read X chat.".into(),
                ..LiveChatProviderState::default()
            },
            LiveChatProviderState {
                id: "x2".into(),
                platform: "x".into(),
                read: "needs-sign-in".into(),
                target_id: Some("t".into()),
                ..LiveChatProviderState::default()
            },
            LiveChatProviderState {
                id: "x3".into(),
                platform: "x".into(),
                read: "needs-sign-in".into(),
                ..LiveChatProviderState::default()
            },
        ];
        let rows = chat_sign_in_rows(&providers);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].button_label(), "X: Sign in to Videorc");
        assert_eq!(rows[1].button_label(), "X: Use Sign in");
    }
}
