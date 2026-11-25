//! Community (plan 225 C, D1–D14; Electron's `lib/community-view.ts`): what
//! Videorc remembers about the people in a streamer's chat, as the Sidekick
//! page's Community tab and the person card show it. videorc-rust had no
//! Community core; this is written from Electron. The arrival chip on a chat
//! row lives in `chat::arrival`, which this shares its labels with.
//!
//! The backend owns the people (`cohost.community.*`); these are the words
//! and the reads the card and the tab draw. Pure: no fetch here. In the GPUI
//! app the Stream Manager calls `cohost.community.*` itself, so Electron's
//! relay through the Studio (its Stream Manager had no backend socket) has
//! no counterpart.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::chat::arrival::since_label;
use crate::chat::model::LiveChatMessage;
use crate::stream_manager::format::group_thousands;

/// The YouTube retention line (D3), word for word.
pub const YOUTUBE_RETENTION_LINE: &str =
    "YouTube viewers are remembered for 30 days after they chat (YouTube's rules).";

/// Why "Sidekick remembers" is locked without Premium (D6).
pub const BUDDY_REMEMBERS_LOCK_REASON: &str =
    "Sidekick remembers what your regulars tell it with Premium.";

/// Why the manual link refuses an X account (D4 a).
pub const X_SELF_LINK_REASON: &str = "X viewers link themselves with !link";

/// The disclosure line for the channel description (H2), with Copy.
pub const COMMUNITY_DISCLOSURE_LINE: &str = "Videorc remembers regulars so Sidekick can greet you. Type !forgetme in chat anytime and it forgets you. Type !link word in two of my chats to be one person.";

/// The Community header before the first stream (D12).
pub const NOTHING_YET_LINE: &str = "Videorc starts remembering your chat from your next stream.";

/// `CommunitySupport`: what a person gave, read leniently.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommunitySupport {
    pub bits: u64,
    pub kicks: u64,
    pub gifted_subs: u64,
    pub sub_months: u64,
    /// Tips by currency, in micros.
    pub tips: BTreeMap<String, u64>,
}

/// `CommunityBackfill`: reading the past streams.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommunityBackfill {
    /// `idle`, `running`, `done` or `failed`, as the wire says it.
    pub state: String,
    pub done: u64,
    pub total: u64,
}

/// `CommunitySummary` (`cohost.community.summary` and the
/// `cohost.community.changed` event).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommunitySummary {
    pub people: u64,
    pub regulars: u64,
    pub streams: u64,
    pub new_regulars_this_week: u64,
    pub links_pending: u64,
    pub backfill: CommunityBackfill,
}

fn counted(count: u64, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{} {many}", group_thousands(count as i64))
    }
}

/// `personStatsLine`: "14 streams · since March 2026 · 5 in a row · 812
/// messages".
pub fn person_stats_line(
    streams: u64,
    first_seen_at: Option<&str>,
    in_a_row: u64,
    messages: u64,
) -> String {
    let mut parts = vec![counted(streams, "stream", "streams")];
    if let Some(since) = since_label(first_seen_at) {
        parts.push(format!("since {since}"));
    }
    if in_a_row >= 2 {
        parts.push(format!("{in_a_row} in a row"));
    }
    parts.push(counted(messages, "message", "messages"));
    parts.join(" · ")
}

/// `formatTip`: a tip in its currency. Electron uses the system locale's
/// `Intl.NumberFormat`; this writes the en-US spelling of the common
/// currencies ("$20.00", "€4.99") and "20.00 XYZ" for the rest.
pub fn format_tip(currency: &str, micros: u64) -> String {
    let amount = micros as f64 / 1_000_000.0;
    let symbol = match currency.to_ascii_uppercase().as_str() {
        "USD" => Some("$"),
        "EUR" => Some("€"),
        "GBP" => Some("£"),
        "CAD" => Some("CA$"),
        "AUD" => Some("A$"),
        "JPY" => Some("¥"),
        _ => None,
    };
    match symbol {
        Some("¥") => format!("¥{}", group_thousands(amount.round() as i64)),
        Some(symbol) => format!("{symbol}{amount:.2}"),
        None => format!("{amount:.2} {currency}"),
    }
}

/// `supportLine`: "4,500 bits · 3 gifted subs · $20.00"; none when none.
pub fn support_line(support: Option<&CommunitySupport>) -> Option<String> {
    let support = support?;
    let mut parts: Vec<String> = Vec::new();
    if support.bits > 0 {
        parts.push(format!("{} bits", group_thousands(support.bits as i64)));
    }
    if support.kicks > 0 {
        parts.push(format!("{} KICKs", group_thousands(support.kicks as i64)));
    }
    if support.gifted_subs > 0 {
        parts.push(counted(support.gifted_subs, "gifted sub", "gifted subs"));
    }
    if support.sub_months > 0 {
        parts.push(if support.sub_months == 1 {
            "1 month subscribed".to_owned()
        } else {
            format!("{} months subscribed", support.sub_months)
        });
    }
    for (currency, micros) in &support.tips {
        if *micros > 0 {
            parts.push(format_tip(currency, *micros));
        }
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// `personHasX` / `rowHasX`: an X account is never linked by hand (D4).
pub fn has_x<'a>(platforms: impl IntoIterator<Item = &'a str>) -> bool {
    platforms.into_iter().any(|platform| platform == "x")
}

/// `forgetCopy`: the Forget confirm's title, sentence and button (D13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetCopy {
    pub title: String,
    pub description: String,
    pub confirm: String,
}

pub fn forget_copy(name: &str) -> ForgetCopy {
    ForgetCopy {
        title: format!("Forget {name}?"),
        description: format!(
            "Videorc deletes what it remembers about {name} on this computer and never learns it again, unless {name} types !rememberme."
        ),
        confirm: format!("Forget {name}"),
    }
}

/// `communityHeaderLine` (D12): "Videorc knows 312 people from your 41
/// streams on this computer. 18 are regulars.", or the line before the first
/// stream.
pub fn community_header_line(summary: Option<&CommunitySummary>) -> String {
    let Some(summary) = summary.filter(|summary| summary.people > 0) else {
        return NOTHING_YET_LINE.to_owned();
    };
    let people = counted(summary.people, "person", "people");
    let streams = if summary.streams == 1 {
        "your 1 stream".to_owned()
    } else {
        format!("your {} streams", group_thousands(summary.streams as i64))
    };
    let regulars = if summary.regulars == 1 {
        "1 is a regular.".to_owned()
    } else {
        format!("{} are regulars.", group_thousands(summary.regulars as i64))
    };
    format!("Videorc knows {people} from {streams} on this computer. {regulars}")
}

/// `backfillLine`: "Reading your past streams… 12 of 41"; none when the
/// backfill is not running.
pub fn backfill_line(summary: Option<&CommunitySummary>) -> Option<String> {
    let backfill = &summary?.backfill;
    if backfill.state != "running" {
        return None;
    }
    Some(if backfill.total > 0 {
        format!(
            "Reading your past streams… {} of {}",
            group_thousands(backfill.done as i64),
            group_thousands(backfill.total as i64)
        )
    } else {
        "Reading your past streams…".to_owned()
    })
}

/// `lastChatLabel`: "today", "yesterday", "3 days ago", "3 weeks ago", then
/// the month ("March 2026"); none for a time it can't read.
pub fn last_chat_label(iso: &str, now: DateTime<Utc>) -> Option<String> {
    let at = DateTime::parse_from_rfc3339(iso).ok()?.with_timezone(&Utc);
    let days = (now - at).num_milliseconds().max(0) / 86_400_000;
    Some(match days {
        0 => "today".to_owned(),
        1 => "yesterday".to_owned(),
        2..=13 => format!("{days} days ago"),
        14..=59 => format!("{} weeks ago", days / 7),
        _ => return since_label(Some(at.to_rfc3339().as_str())),
    })
}

/// `personRowContext`: the People row's "14 streams · yesterday".
pub fn person_row_context(streams: u64, last_seen_at: Option<&str>, now: DateTime<Utc>) -> String {
    let streams = counted(streams, "stream", "streams");
    match last_seen_at.and_then(|at| last_chat_label(at, now)) {
        Some(last) => format!("{streams} · {last}"),
        None => streams,
    }
}

/// `linkEventLabel`: a link event in the person's history; none for a kind
/// a newer backend names.
pub fn link_event_label(kind: &str) -> Option<&'static str> {
    match kind {
        "self" => Some("Linked with !link"),
        "manual" => Some("Linked by you"),
        "split" => Some("Split off"),
        "suggestion-accepted" => Some("Linked from a suggestion"),
        _ => None,
    }
}

/// Platforms whose chat carries an author id Videorc can remember (D1).
const IDENTITY_PLATFORMS: [&str; 4] = ["youtube", "twitch", "kick", "x"];

/// The person a chat row is about (`chatRowPerson`, D11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowPerson {
    pub platform: String,
    pub author_id: String,
    pub name: String,
}

/// `chatRowPerson`: the person a row is about, for "About {name}" and the
/// right-click menu: only a viewer's row with an author id on a platform
/// with identity, never a system or moderation row, never the streamer's own
/// (the streamer is never a person, D1).
pub fn chat_row_person(message: &LiveChatMessage) -> Option<RowPerson> {
    let author_id = message
        .author_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if !IDENTITY_PLATFORMS.contains(&message.platform.as_str()) {
        return None;
    }
    if message.event_type == "system" || message.event_type == "moderation" {
        return None;
    }
    if message.author_roles.iter().any(|role| {
        let role = role.trim().to_lowercase();
        role == "owner" || role == "broadcaster"
    }) {
        return None;
    }
    let name = message.author_name.trim();
    Some(RowPerson {
        platform: message.platform.clone(),
        author_id: author_id.to_owned(),
        name: if name.is_empty() {
            "this viewer".to_owned()
        } else {
            name.to_owned()
        },
    })
}

/// "About {name}": the row menu's item that opens the person card (C2).
pub fn about_item(name: &str) -> String {
    format!("About {name}")
}

/// D10: the one-time offer, after the first stream regulars came to
/// (`community-copy.ts`).
pub const REMEMBER_OFFER_TITLE: &str = "Let Sidekick remember what your regulars tell it?";
pub const REMEMBER_OFFER_DESCRIPTION: &str = "After a stream, Sidekick reads what your regulars said about themselves and keeps a few short memories, so next time it can ask how the borrow checker is treating them. You see and delete every memory. YouTube chat is never read for this.";

/// `RememberOffer`'s conditions (remember-offer.tsx): regulars came, the
/// streamer has Premium, Remember my community is on, Sidekick remembers is
/// off and the offer was never answered.
pub fn remember_offer_shows(
    regulars_came: bool,
    entitled: bool,
    enabled: bool,
    remember: bool,
    remember_offered: bool,
) -> bool {
    regulars_came && entitled && enabled && !remember && !remember_offered
}

/// The retention note under the Community settings (D3).
pub fn retention_line() -> String {
    format!(
        "Twitch, Kick and X viewers are forgotten 12 months after their last chat. {YOUTUBE_RETENTION_LINE}"
    )
}

/// The People list's empty state: its title and its sentence, by the search
/// and the "Show" filter (community-tab.tsx).
pub fn people_empty_copy(query: &str, filter: &str) -> (&'static str, &'static str) {
    if !query.trim().is_empty() {
        ("No one by that name", "Try another name, or show Everyone.")
    } else if filter == "regulars" {
        (
            "No regulars yet",
            "Someone becomes a regular after chatting in a few of your streams.",
        )
    } else {
        (
            "No one here yet",
            "People show up here after they chat in one of your streams.",
        )
    }
}

/// "Regular after": one choice of the threshold select ("3 streams").
pub fn regular_after_label(streams: u32) -> String {
    format!("{streams} streams")
}

/// The card's account line: "Twitch · ada_l", the handle or else the name.
pub fn account_label(platform: &str, handle: Option<&str>, name: &str) -> String {
    let shown = handle
        .map(str::trim)
        .filter(|handle| !handle.is_empty())
        .unwrap_or(name);
    format!("{} · {shown}", crate::chat::view::platform_label(platform))
}

/// A person's `avatarUrl` worth asking the picture cache for
/// (`useCachedAvatar` skips an empty one): none when blank.
pub fn avatar_url(url: Option<&str>) -> Option<&str> {
    url.filter(|url| !url.trim().is_empty())
}

/// The People rows' and the card's pictures still to fetch: each usable
/// `avatarUrl` once, in order, skipping the ones `known` already holds.
pub fn avatar_urls_to_load<'a>(
    urls: impl IntoIterator<Item = Option<&'a str>>,
    known: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut wanted: Vec<String> = Vec::new();
    for url in urls.into_iter().filter_map(avatar_url) {
        if !known(url) && !wanted.iter().any(|existing| existing == url) {
            wanted.push(url.to_owned());
        }
    }
    wanted
}

/// The card header's line for a linked person.
pub fn linked_line(accounts: usize) -> String {
    format!("One person on {accounts} platforms")
}

/// The card's "Sidekick remembers" with no memories yet.
pub fn nothing_remembered_line(name: &str) -> String {
    format!("Nothing yet. Sidekick learns from what {name} says about themselves in chat.")
}

/// The card when `cohost.community.person` failed.
pub fn person_load_failed_line(name: &str) -> String {
    format!("Couldn't read what Videorc remembers about {name}.")
}

/// A memory's forget button, for a screen reader: "Forget “likes Rust”".
pub fn forget_memory_label(text: &str) -> String {
    format!("Forget “{text}”")
}

/// `memoryForgetCopy`: the one-memory confirm's title, sentence and button.
pub fn memory_forget_copy(name: &str, text: &str) -> ForgetCopy {
    ForgetCopy {
        title: "Forget this memory?".to_owned(),
        description: format!(
            "Sidekick stops remembering “{text}” about {name}. It can learn it again from a later stream."
        ),
        confirm: "Forget memory".to_owned(),
    }
}

/// `NOTE_MAX_CHARS`: the private note's length.
pub const NOTE_MAX_CHARS: usize = 300;

/// `NoteField`'s save: the draft trimmed and cut to the note's length, or
/// nothing when it is what was saved.
pub fn note_to_save(draft: &str, saved: &str) -> Option<String> {
    let next: String = draft.trim().chars().take(NOTE_MAX_CHARS).collect();
    (next != saved.trim()).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// `useCachedAvatar(row.avatarUrl)`: a blank URL shows the monogram.
    #[test]
    fn a_blank_avatar_url_is_no_picture() {
        assert_eq!(
            avatar_url(Some("https://yt3.ggpht.com/a.jpg")),
            Some("https://yt3.ggpht.com/a.jpg")
        );
        assert_eq!(avatar_url(Some("")), None);
        assert_eq!(avatar_url(Some("   ")), None);
        assert_eq!(avatar_url(None), None);
    }

    #[test]
    fn each_avatar_is_fetched_once_and_never_again_once_known() {
        let urls = [
            Some("https://a.example/1.png"),
            None,
            Some(""),
            Some("https://a.example/2.png"),
            Some("https://a.example/1.png"),
            Some("https://a.example/3.png"),
        ];
        assert_eq!(
            avatar_urls_to_load(urls, |url| url.ends_with("3.png")),
            vec![
                "https://a.example/1.png".to_owned(),
                "https://a.example/2.png".to_owned(),
            ]
        );
        assert!(avatar_urls_to_load([None, Some(" ")], |_| false).is_empty());
    }

    /// Electron's "writes the card lines and the forget question".
    #[test]
    fn the_card_lines_and_the_forget_question_read_as_electrons() {
        assert_eq!(
            person_stats_line(14, Some("2026-03-02T18:00:00Z"), 5, 812),
            "14 streams · since March 2026 · 5 in a row · 812 messages"
        );
        assert_eq!(person_stats_line(1, None, 1, 1), "1 stream · 1 message");
        let support = CommunitySupport {
            bits: 4500,
            gifted_subs: 3,
            ..CommunitySupport::default()
        };
        assert_eq!(
            support_line(Some(&support)).as_deref(),
            Some("4,500 bits · 3 gifted subs")
        );
        assert_eq!(support_line(Some(&CommunitySupport::default())), None);
        assert_eq!(support_line(None), None);
        let mut tips = BTreeMap::new();
        tips.insert("USD".to_owned(), 20_000_000);
        let tipped = CommunitySupport {
            tips,
            ..CommunitySupport::default()
        };
        assert!(support_line(Some(&tipped)).unwrap().contains("20"));
        assert_eq!(
            forget_copy("Ada"),
            ForgetCopy {
                title: "Forget Ada?".into(),
                description: "Videorc deletes what it remembers about Ada on this computer and never learns it again, unless Ada types !rememberme.".into(),
                confirm: "Forget Ada".into(),
            }
        );
    }

    /// Electron's "writes the Community header and the backfill line (D12)".
    #[test]
    fn the_header_and_the_backfill_line() {
        assert_eq!(community_header_line(None), NOTHING_YET_LINE);
        let summary = CommunitySummary {
            people: 312,
            regulars: 18,
            streams: 41,
            backfill: CommunityBackfill {
                state: "running".into(),
                done: 12,
                total: 41,
            },
            ..CommunitySummary::default()
        };
        assert_eq!(
            community_header_line(Some(&summary)),
            "Videorc knows 312 people from your 41 streams on this computer. 18 are regulars."
        );
        assert_eq!(
            backfill_line(Some(&summary)).as_deref(),
            Some("Reading your past streams… 12 of 41")
        );
        let one = CommunitySummary {
            people: 1,
            regulars: 1,
            streams: 1,
            ..CommunitySummary::default()
        };
        assert_eq!(
            community_header_line(Some(&one)),
            "Videorc knows 1 person from your 1 stream on this computer. 1 is a regular."
        );
        assert_eq!(backfill_line(Some(&one)), None);
    }

    #[test]
    fn last_chat_reads_in_days_then_weeks_then_the_month() {
        let now = at("2026-11-24T12:00:00Z");
        assert_eq!(
            last_chat_label("2026-11-24T08:00:00Z", now).as_deref(),
            Some("today")
        );
        assert_eq!(
            last_chat_label("2026-11-23T08:00:00Z", now).as_deref(),
            Some("yesterday")
        );
        assert_eq!(
            last_chat_label("2026-11-21T08:00:00Z", now).as_deref(),
            Some("3 days ago")
        );
        assert_eq!(
            last_chat_label("2026-11-03T08:00:00Z", now).as_deref(),
            Some("3 weeks ago")
        );
        assert_eq!(
            last_chat_label("2026-03-02T08:00:00Z", now).as_deref(),
            Some("March 2026")
        );
        assert_eq!(last_chat_label("soon", now), None);
        assert_eq!(
            person_row_context(14, Some("2026-11-23T08:00:00Z"), now),
            "14 streams · yesterday"
        );
        assert_eq!(person_row_context(1, None, now), "1 stream");
    }

    #[test]
    fn a_row_is_about_a_viewer_with_an_id_never_the_streamer() {
        let viewer = LiveChatMessage {
            platform: "twitch".into(),
            author_id: Some(" 42 ".into()),
            author_name: "Ada".into(),
            event_type: "message".into(),
            ..LiveChatMessage::default()
        };
        assert_eq!(
            chat_row_person(&viewer),
            Some(RowPerson {
                platform: "twitch".into(),
                author_id: "42".into(),
                name: "Ada".into()
            })
        );
        let owner = LiveChatMessage {
            author_roles: vec!["Broadcaster".into()],
            ..viewer.clone()
        };
        assert_eq!(chat_row_person(&owner), None);
        let system = LiveChatMessage {
            event_type: "system".into(),
            ..viewer.clone()
        };
        assert_eq!(chat_row_person(&system), None);
        let custom = LiveChatMessage {
            platform: "custom".into(),
            ..viewer.clone()
        };
        assert_eq!(chat_row_person(&custom), None);
        let nameless = LiveChatMessage {
            author_name: " ".into(),
            ..viewer
        };
        assert_eq!(chat_row_person(&nameless).unwrap().name, "this viewer");
        assert!(has_x(["twitch", "x"]));
        assert!(!has_x(["youtube"]));
        assert_eq!(link_event_label("manual"), Some("Linked by you"));
        assert_eq!(about_item("Ada"), "About Ada");
    }

    /// The words are Electron's, byte for byte.
    #[test]
    fn the_words_are_electrons() {
        const VIEW: &str =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/community-view.ts");
        for words in [
            YOUTUBE_RETENTION_LINE,
            BUDDY_REMEMBERS_LOCK_REASON,
            X_SELF_LINK_REASON,
            COMMUNITY_DISCLOSURE_LINE,
            NOTHING_YET_LINE,
            "Linked with !link",
            "Linked from a suggestion",
            "this viewer",
            " types !rememberme.",
            "Reading your past streams…",
        ] {
            assert!(
                VIEW.contains(words),
                "community-view.ts no longer says {words:?}"
            );
        }
    }

    #[test]
    fn the_offer_shows_once_to_a_premium_streamer_whose_regulars_came() {
        assert!(remember_offer_shows(true, true, true, false, false));
        assert!(!remember_offer_shows(false, true, true, false, false));
        assert!(!remember_offer_shows(true, false, true, false, false));
        assert!(!remember_offer_shows(true, true, false, false, false));
        assert!(!remember_offer_shows(true, true, true, true, false));
        assert!(!remember_offer_shows(true, true, true, false, true));
    }

    #[test]
    fn the_card_and_tab_lines() {
        assert_eq!(
            people_empty_copy(" ada ", "regulars").0,
            "No one by that name"
        );
        assert_eq!(people_empty_copy("", "regulars").0, "No regulars yet");
        assert_eq!(people_empty_copy("", "bots").0, "No one here yet");
        assert_eq!(regular_after_label(3), "3 streams");
        assert_eq!(
            account_label("twitch", Some(" ada_l "), "Ada"),
            "Twitch · ada_l"
        );
        assert_eq!(account_label("youtube", Some(" "), "Ada"), "YouTube · Ada");
        assert_eq!(linked_line(2), "One person on 2 platforms");
        assert_eq!(forget_memory_label("likes Rust"), "Forget “likes Rust”");
        let copy = memory_forget_copy("Ada", "likes Rust");
        assert_eq!(copy.title, "Forget this memory?");
        assert_eq!(
            copy.description,
            "Sidekick stops remembering “likes Rust” about Ada. It can learn it again from a later stream."
        );
        assert_eq!(copy.confirm, "Forget memory");
        assert!(retention_line().ends_with(YOUTUBE_RETENTION_LINE));
    }

    #[test]
    fn a_note_saves_trimmed_and_cut_and_never_twice() {
        assert_eq!(note_to_save(" hi ", ""), Some("hi".to_owned()));
        assert_eq!(note_to_save(" hi ", "hi"), None);
        assert_eq!(note_to_save("", " "), None);
        assert_eq!(note_to_save("", "old"), Some(String::new()));
        let long = "é".repeat(NOTE_MAX_CHARS + 5);
        assert_eq!(
            note_to_save(&long, "").map(|note| note.chars().count()),
            Some(NOTE_MAX_CHARS)
        );
    }

    /// The tab's, the card's and the offer's words are Electron's.
    #[test]
    fn the_tab_and_card_words_are_electrons() {
        const COPY: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/community/community-copy.ts"
        );
        const TAB: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/community/community-tab.tsx"
        );
        const CARD: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/community/person-card-body.tsx"
        );
        for words in [
            REMEMBER_OFFER_TITLE,
            REMEMBER_OFFER_DESCRIPTION,
            "Forget this memory?",
            "Sidekick stops remembering “",
            ". It can learn it again from a later stream.",
            "Forget memory",
        ] {
            assert!(
                COPY.contains(words),
                "community-copy.ts no longer says {words:?}"
            );
        }
        for words in [
            "Twitch, Kick and X viewers are forgotten 12 months after their last chat.",
            "No one by that name",
            "Try another name, or show Everyone.",
            "No regulars yet",
            "Someone becomes a regular after chatting in a few of your streams.",
            "No one here yet",
            "People show up here after they chat in one of your streams.",
        ] {
            assert!(
                TAB.contains(words),
                "community-tab.tsx no longer says {words:?}"
            );
        }
        for words in [
            "One person on ",
            "Nothing yet. Sidekick learns from what ",
            " says about themselves in chat.",
            "Couldn't read what Videorc remembers about ",
            "Forget “",
        ] {
            assert!(
                CARD.contains(words),
                "person-card-body.tsx no longer says {words:?}"
            );
        }
    }
}
