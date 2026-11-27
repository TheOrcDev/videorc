//! The Stream Manager's chat rows (`components/comment-row.tsx` at the
//! comfortable density, `components/stream-manager/chat-pane.tsx`): the
//! Studio's row (`chat::view::ChatRowView`: the name, the click on stream,
//! the chips, the tint) plus what the bigger row shows: the time, the role
//! tags, First chat and @you, the event's chip, the reply's line, and the
//! words with each emote as its picture (`groupEmoteOverlays`) and a GIF as
//! its own block (`splitGifFragments`).

use std::sync::Arc;

use super::copy;
use super::format::time_of_day;
use crate::chat::highlight::{self, HighlightFailure};
use crate::chat::model::{CommentHighlightState, LiveChatFragment, LiveChatMessage};
use crate::chat::view::{ChatRowView, notice_viewer_words, studio_chat_counts};

/// One drawable piece of a message's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    /// An emote's picture (its name until it draws), and the zero-width
    /// 7TV emotes stacked over it.
    Emote {
        text: String,
        url: String,
        overlays: Vec<(String, String)>,
    },
    /// S3.2b: a link in the viewer's own words (plan 151): underlined, inert
    /// to a left click (the row's), Open link and Copy link on a right click.
    Link(super::links::ChatLink),
}

/// A Twitch GIF Keyboard GIF: its own block, its title until it draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gif {
    pub title: String,
    pub url: String,
}

/// `EventStatus`'s chip and its Badge variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventChip {
    /// A paid message's amount (`warning`).
    Amount(String),
    /// A membership (`plate`).
    Member,
    Moderation,
    System,
}

/// One row of the Stream Manager's chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagerRow {
    /// What the Studio's row has: the name, the description, the click, the
    /// highlight's chips, the tint, the avatar.
    pub row: ChatRowView,
    /// "11:28 AM": while live it waits for the pointer.
    pub time: String,
    /// X's verified check after the name (plan 167): `blue`, `business` or
    /// `government`, and what it means.
    pub verified: Option<(&'static str, &'static str)>,
    /// The X author's organization badge: its picture's URL and its name.
    pub affiliation: Option<(String, String)>,
    /// `RoleTags`: Host, Mod, VIP, Member (the last on the plate).
    pub roles: Vec<&'static str>,
    pub first_chat: bool,
    pub mentioned: bool,
    pub event: Option<EventChip>,
    /// "↳ @name: words" when the message answers another.
    pub reply: Option<String>,
    /// A Twitch notice's own sentence (italic, secondary) over the viewer's
    /// words.
    pub notice: Option<String>,
    /// The words: text and emotes.
    pub pieces: Vec<Piece>,
    pub gifs: Vec<Gif>,
    /// S3.2b: the removal's chip and its line (plan 140, S6).
    pub removal: Option<super::removal::RemovalStatus>,
    /// S3.2d: what Buddy says about the message (`CohostMarks`).
    pub mark: Option<RowMark>,
}

/// Buddy's mark on a chat row: a flag (its kind, high severity, and at
/// most a suggestion's label), "Talking about this", or "Suggested".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RowMark {
    /// `flag`, `spotlight` or `suggested`.
    pub kind: &'static str,
    pub text: String,
    pub high: bool,
    pub action: String,
    /// The chip's hint (a flag's reason and what else scored high).
    pub hint: String,
}

/// `gifTitle`: `[Y A Y Yes GIF]` → `Y A Y Yes`; any other shape trimmed.
pub fn gif_title(text: &str) -> String {
    let trimmed = text.trim();
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
    .trim();
    if let Some(title) = inner.strip_suffix(" GIF") {
        let title = title.trim();
        if !title.is_empty() {
            return title.to_string();
        }
    }
    inner.to_string()
}

fn is_gif(fragment: &LiveChatFragment) -> bool {
    fragment.fragment_type == "gif" && fragment.image_url.is_some()
}

/// `groupEmoteOverlays`: each zero-width 7TV emote folds onto the emote
/// before it, the whitespace between them dropped.
pub fn group_emote_overlays(fragments: &[&LiveChatFragment]) -> Vec<Piece> {
    let mut pieces: Vec<Piece> = Vec::new();
    let mut gap: Vec<String> = Vec::new();
    let mut last_emote: Option<usize> = None;
    for fragment in fragments {
        let Some(url) = fragment.image_url.as_ref() else {
            if last_emote.is_some() && fragment.text.trim().is_empty() {
                gap.push(fragment.text.clone());
                continue;
            }
            pieces.extend(gap.drain(..).map(Piece::Text));
            pieces.push(Piece::Text(fragment.text.clone()));
            last_emote = None;
            continue;
        };
        if fragment.zero_width
            && let Some(index) = last_emote
            && let Some(Piece::Emote { overlays, .. }) = pieces.get_mut(index)
        {
            overlays.push((fragment.text.clone(), url.clone()));
            gap.clear();
            continue;
        }
        pieces.extend(gap.drain(..).map(Piece::Text));
        pieces.push(Piece::Emote {
            text: fragment.text.clone(),
            url: url.clone(),
            overlays: Vec::new(),
        });
        last_emote = Some(pieces.len() - 1);
    }
    pieces.extend(gap.drain(..).map(Piece::Text));
    pieces
}

/// `FragmentText`: the words as pieces, and the GIFs as blocks. Without an
/// image fragment it is `text` as is.
fn fragment_text(
    text: &str,
    fragments: &[LiveChatFragment],
    links: bool,
) -> (Vec<Piece>, Vec<Gif>) {
    if !fragments
        .iter()
        .any(|fragment| fragment.image_url.is_some())
    {
        return (
            linked(vec![Piece::Text(text.to_string())], links),
            Vec::new(),
        );
    }
    let gifs: Vec<Gif> = fragments
        .iter()
        .filter(|fragment| is_gif(fragment))
        .map(|fragment| Gif {
            title: gif_title(&fragment.text),
            url: fragment.image_url.clone().unwrap_or_default(),
        })
        .collect();
    let rest: Vec<&LiveChatFragment> = fragments
        .iter()
        .filter(|fragment| !is_gif(fragment))
        .collect();
    let pieces = if rest
        .iter()
        .any(|fragment| !fragment.text.trim().is_empty() || fragment.image_url.is_some())
    {
        group_emote_overlays(&rest)
    } else {
        Vec::new()
    };
    (linked(pieces, links), gifs)
}

/// S3.2b: a message's words as the rows draw them (`MessageBody` without
/// its notice line): the pieces (with `links`, the viewer's links as their
/// own pieces) and the GIFs. The Studio's rows take them without links.
pub fn message_pieces(message: &LiveChatMessage, links: bool) -> (Vec<Piece>, Vec<Gif>) {
    match notice_viewer_words(message) {
        Some(words) => fragment_text(&words, &message.fragments, links && !message.is_deleted),
        None => fragment_text(
            &message.message_text,
            &message.fragments,
            links && viewer_wrote(message),
        ),
    }
}

/// `LinkedText`: each text piece's links as their own pieces.
fn linked(pieces: Vec<Piece>, links: bool) -> Vec<Piece> {
    if !links {
        return pieces;
    }
    let mut out = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Text(text) => {
                for part in super::links::split_links(&text) {
                    out.push(match part {
                        super::links::TextPiece::Text(text) => Piece::Text(text),
                        super::links::TextPiece::Link(link) => Piece::Link(link),
                    });
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `viewerWrote`: only the viewer's own words get links; Twitch's sentences,
/// moderation rows and removed messages never do (plan 151, D8).
fn viewer_wrote(message: &LiveChatMessage) -> bool {
    !message.is_deleted && matches!(message.event_type.as_str(), "message" | "paid")
}

/// `commentMentions`: the message names one of the streamer's accounts.
pub fn comment_mentions(message: &LiveChatMessage, names: &[String]) -> bool {
    if names.is_empty() || message.event_type != "message" {
        return false;
    }
    let text = message.message_text.to_lowercase();
    names.iter().any(|name| {
        let handle = name.trim().to_lowercase();
        let handle = handle.trim_start_matches('@');
        handle.chars().count() > 1 && text.contains(&format!("@{handle}"))
    })
}

fn roles(message: &LiveChatMessage) -> Vec<&'static str> {
    let mut labels: Vec<&'static str> = Vec::new();
    for role in &message.author_roles {
        let label = match role.as_str() {
            "owner" => copy::ROLE_HOST,
            "moderator" => copy::ROLE_MOD,
            "vip" => copy::ROLE_VIP,
            "member" => copy::ROLE_MEMBER,
            _ => continue,
        };
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    labels
}

/// `X_VERIFIED_LABEL`: a check X sent, never one it did not.
fn verified(message: &LiveChatMessage) -> Option<(&'static str, &'static str)> {
    match message.author_verified.as_deref()? {
        "blue" => Some(("blue", copy::VERIFIED_BLUE)),
        "business" => Some(("business", copy::VERIFIED_BUSINESS)),
        "government" => Some(("government", copy::VERIFIED_GOVERNMENT)),
        _ => None,
    }
}

/// `AffiliationBadge`: an `https://` badge only.
fn affiliation(message: &LiveChatMessage) -> Option<(String, String)> {
    let badge = message.author_affiliation.as_ref()?;
    if !badge.badge_url.starts_with("https://") {
        return None;
    }
    let label = badge
        .description
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(copy::AFFILIATED_ORGANIZATION);
    Some((badge.badge_url.clone(), label.to_string()))
}

fn event_chip(message: &LiveChatMessage) -> Option<EventChip> {
    if let Some(amount) = &message.amount_text {
        return Some(EventChip::Amount(amount.clone()));
    }
    match message.event_type.as_str() {
        "membership" => Some(EventChip::Member),
        "moderation" => Some(EventChip::Moderation),
        "system" => Some(EventChip::System),
        _ => None,
    }
}

impl ManagerRow {
    /// Every image drawn by this row. The bool selects the GIF cache;
    /// avatars, affiliation badges and emotes use the avatar allowlist.
    pub fn image_requests(&self) -> Vec<(String, bool)> {
        let mut urls = Vec::new();
        if let Some(url) = &self.row.avatar_url {
            urls.push((url.clone(), false));
        }
        if let Some((url, _)) = &self.affiliation {
            urls.push((url.clone(), false));
        }
        for piece in &self.pieces {
            if let Piece::Emote { url, overlays, .. } = piece {
                urls.push((url.clone(), false));
                urls.extend(overlays.iter().map(|(_, url)| (url.clone(), false)));
            }
        }
        urls.extend(self.gifs.iter().map(|gif| (gif.url.clone(), true)));
        urls.sort();
        urls.dedup();
        urls
    }

    pub fn new(
        message: &LiveChatMessage,
        highlight: highlight::RowHighlight,
        live: bool,
        mention_names: &[String],
    ) -> Self {
        let row = ChatRowView::new(message, highlight, live);
        let notice_words = notice_viewer_words(message);
        let notice = notice_words.as_ref().map(|_| message.message_text.clone());
        let (pieces, gifs) = message_pieces(message, true);
        Self {
            row,
            time: time_of_day(&message.received_at),
            verified: verified(message),
            affiliation: affiliation(message),
            roles: roles(message),
            first_chat: message.first_message,
            mentioned: comment_mentions(message, mention_names),
            event: event_chip(message),
            reply: message
                .reply
                .as_ref()
                .map(|reply| format!("↳ @{}: {}", reply.parent_author_name, reply.parent_text)),
            notice,
            pieces,
            gifs,
            removal: None,
            mark: None,
        }
    }
}

/// The highlight as the rows read it.
#[derive(Debug, Clone, Copy)]
pub struct RowsHighlight<'a> {
    pub state: &'a CommentHighlightState,
    pub applying_id: Option<&'a str>,
    pub failure: Option<&'a HighlightFailure>,
}

/// S3.2b: the removals the rows show: the session's ledger and the
/// "Remove from chat" clicks no operation answered yet.
#[derive(Debug, Clone, Copy, Default)]
pub struct RowsRemovals<'a> {
    pub operations: &'a [super::removal::ModerationOperation],
    pub requesting: &'a [String],
}

/// `chatPaneMessages`: the chat messages the filters show (never the
/// activity-only events), oldest first. S3.2x.3: the list keeps them all
/// (the core's 2,000) and builds the rows of its window.
pub fn manager_shown<'a>(
    messages: &'a [Arc<LiveChatMessage>],
    mention_names: &[String],
    filter: &super::pane::ChatFilter,
) -> Vec<&'a Arc<LiveChatMessage>> {
    messages
        .iter()
        .filter(|message| studio_chat_counts(message) && filter.shows(message, mention_names))
        .collect()
}

/// S3.2x.3: the rows of `shown[range]`, the list's window
/// (`super::list_window`).
pub fn manager_rows_of(
    shown: &[&Arc<LiveChatMessage>],
    range: std::ops::Range<usize>,
    highlight: RowsHighlight<'_>,
    live: bool,
    mention_names: &[String],
    removals: RowsRemovals<'_>,
) -> Vec<ManagerRow> {
    let end = range.end.min(shown.len());
    let start = range.start.min(end);
    let latest = super::removal::latest_by_message(removals.operations);
    shown[start..end]
        .iter()
        .map(|message| {
            let presentation = highlight::presentation(
                &message.id,
                highlight.state,
                highlight.applying_id,
                highlight.failure,
            );
            let problem = highlight::problem(&presentation).is_some();
            let mut row = ManagerRow::new(message, presentation, live, mention_names);
            row.removal = super::removal::removal_status(
                message,
                latest.get(message.id.as_str()).copied(),
                removals.requesting.contains(&message.id),
            );
            // `commentRowDescription`: the removal's line after the click's.
            if let Some(line) = row
                .removal
                .as_ref()
                .and_then(|status| status.outcome_line())
            {
                row.row.description = if problem {
                    format!("{} {line}", row.row.description)
                } else {
                    format!("{}. {line}", row.row.description)
                };
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::highlight::RowHighlight;
    use crate::chat::model::LiveChatReply;

    fn fragment(kind: &str, text: &str, url: Option<&str>, zero_width: bool) -> LiveChatFragment {
        LiveChatFragment {
            fragment_type: kind.into(),
            text: text.into(),
            image_url: url.map(str::to_string),
            zero_width,
        }
    }

    fn message() -> LiveChatMessage {
        LiveChatMessage {
            id: "m".into(),
            session_id: "s".into(),
            platform: "twitch".into(),
            author_name: "Ada".into(),
            received_at: "2026-11-11T10:00:00Z".into(),
            message_text: "hello".into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        }
    }

    #[test]
    fn a_text_only_row_still_loads_its_avatar_and_affiliation_badge() {
        use crate::chat::model::LiveChatAuthorAffiliation;
        let mut message = message();
        message.author_avatar_url = Some("https://pbs.twimg.com/avatar.png".into());
        message.author_affiliation = Some(LiveChatAuthorAffiliation {
            badge_url: "https://pbs.twimg.com/badge.png".into(),
            ..LiveChatAuthorAffiliation::default()
        });
        let row = ManagerRow::new(&message, RowHighlight::default(), true, &[]);
        assert_eq!(
            row.image_requests(),
            vec![
                ("https://pbs.twimg.com/avatar.png".into(), false),
                ("https://pbs.twimg.com/badge.png".into(), false),
            ]
        );
        message.author_avatar_url = None;
        message.author_affiliation = None;
        assert!(
            ManagerRow::new(&message, RowHighlight::default(), true, &[])
                .image_requests()
                .is_empty()
        );
    }

    // `chat-emotes.test.ts`.
    #[test]
    fn a_zero_width_emote_stacks_on_the_one_before_it() {
        let fragments = [
            fragment("emote", "catJAM", Some("https://cdn.7tv.app/a"), false),
            fragment("text", " ", None, false),
            fragment("emote", "RainTime", Some("https://cdn.7tv.app/b"), true),
            fragment("text", " nice", None, false),
        ];
        let refs: Vec<&LiveChatFragment> = fragments.iter().collect();
        assert_eq!(
            group_emote_overlays(&refs),
            [
                Piece::Emote {
                    text: "catJAM".into(),
                    url: "https://cdn.7tv.app/a".into(),
                    overlays: vec![("RainTime".into(), "https://cdn.7tv.app/b".into())],
                },
                Piece::Text(" nice".into()),
            ]
        );
        // First in the message, it is drawn inline like any emote.
        let lone = [fragment(
            "emote",
            "Rain",
            Some("https://cdn.7tv.app/b"),
            true,
        )];
        let refs: Vec<&LiveChatFragment> = lone.iter().collect();
        assert!(
            matches!(&group_emote_overlays(&refs)[0], Piece::Emote { overlays, .. } if overlays.is_empty())
        );
    }

    #[test]
    fn a_row_carries_the_words_as_pieces_and_a_gif_as_its_block() {
        let mut emoted = message();
        emoted.message_text = "hi smokeHYPE".into();
        emoted.fragments = vec![
            fragment("text", "hi ", None, false),
            fragment(
                "emote",
                "smokeHYPE",
                Some("https://files.kick.com/e"),
                false,
            ),
            fragment(
                "gif",
                "[Y A Y Yes GIF]",
                Some("https://media1.giphy.com/x.gif"),
                false,
            ),
        ];
        emoted.author_roles = vec!["moderator".into(), "member".into(), "moderator".into()];
        emoted.first_message = true;
        emoted.reply = Some(LiveChatReply {
            parent_author_name: "Bo".into(),
            parent_text: "first!".into(),
        });
        let row = ManagerRow::new(&emoted, RowHighlight::default(), true, &[]);
        assert_eq!(row.pieces.len(), 2);
        assert_eq!(row.gifs[0].title, "Y A Y Yes");
        assert_eq!(row.roles, ["Mod", "Member"]);
        assert!(row.first_chat);
        assert_eq!(row.reply.as_deref(), Some("↳ @Bo: first!"));
        assert_eq!(row.row.name, "Ada on Twitch: hi smokeHYPE[Y A Y Yes GIF]");
        let plain = ManagerRow::new(&message(), RowHighlight::default(), true, &[]);
        assert_eq!(plain.pieces, [Piece::Text("hello".into())]);
        assert!(plain.event.is_none());
    }

    #[test]
    fn an_x_check_shows_only_as_x_sent_it_and_a_badge_needs_https() {
        use crate::chat::model::LiveChatAuthorAffiliation;
        let mut checked = message();
        checked.author_verified = Some("business".into());
        checked.author_affiliation = Some(LiveChatAuthorAffiliation {
            badge_url: "https://pbs.twimg.com/badge.png".into(),
            description: Some("Neon".into()),
            url: None,
        });
        let row = ManagerRow::new(&checked, RowHighlight::default(), true, &[]);
        assert_eq!(
            row.verified,
            Some(("business", "Verified organization on X"))
        );
        assert_eq!(
            row.affiliation,
            Some(("https://pbs.twimg.com/badge.png".into(), "Neon".into()))
        );
        checked.author_verified = Some("none".into());
        checked.author_affiliation = Some(LiveChatAuthorAffiliation {
            badge_url: "http://example.com/badge.png".into(),
            ..LiveChatAuthorAffiliation::default()
        });
        let row = ManagerRow::new(&checked, RowHighlight::default(), true, &[]);
        assert!(row.verified.is_none() && row.affiliation.is_none());
    }

    // `comment-row.test.ts`: only the viewer's own words get links.
    #[test]
    fn a_viewers_link_is_its_own_piece_and_a_removed_one_is_text() {
        let mut linked = message();
        linked.message_text = "see videorc.com now".into();
        let row = ManagerRow::new(&linked, RowHighlight::default(), true, &[]);
        assert_eq!(row.pieces.len(), 3);
        assert!(matches!(&row.pieces[1], Piece::Link(link) if link.host == "videorc.com"));
        linked.is_deleted = true;
        let row = ManagerRow::new(&linked, RowHighlight::default(), true, &[]);
        assert_eq!(row.pieces.len(), 1);
        let mut system = message();
        system.event_type = "system".into();
        system.message_text = "videorc.com".into();
        assert_eq!(message_pieces(&system, true).0.len(), 1);
        assert_eq!(
            message_pieces(&message(), false).0,
            [Piece::Text("hello".into())]
        );
    }

    #[test]
    fn a_mention_names_the_streamers_account() {
        let mut named = message();
        named.message_text = "hey @Videorc_TV look".into();
        assert!(comment_mentions(&named, &["videorc_tv".into()]));
        assert!(!comment_mentions(&named, &["@x".into()]));
        assert!(!comment_mentions(&named, &[]));
        let mut paid = message();
        paid.amount_text = Some("$5.00".into());
        assert_eq!(event_chip(&paid), Some(EventChip::Amount("$5.00".into())));
    }
}
