//! Know your viewers across platforms (plan 225): the pure rules.
//!
//! An **account** is one identity on one platform (`<platform>:<author_id>`,
//! as `chatter_key` builds it); a **person** owns one or more accounts, and
//! every count a streamer sees is the person's, over the union of its
//! accounts' attendance (D1). This module holds what needs no database: the
//! numbers (D7, D8), the arrival facts a chat row carries (`ViewerArrival`),
//! the `!` commands viewers type (D13), the `!link <word>` matcher (D4), the
//! name match behind "Might be the same person" (D4 c) and the settings
//! block. The store (`community_store.rs`) reads and writes SQLite; the live
//! hooks live in `live_chat.rs` and `cohost.rs`.
//!
//! Nothing here sends a chat message, and nothing here waits on the store
//! inside a delivery fence (D14).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};

use crate::streaming::{StreamPlatform, stream_platform_id};

/// A regular chatted in at least this many streams in the last
/// [`REGULAR_WINDOW_DAYS`] (D7); the streamer may set 2 to 10.
pub const REGULAR_STREAMS_DEFAULT: u32 = 3;
pub const REGULAR_STREAMS_MIN: u32 = 2;
pub const REGULAR_STREAMS_MAX: u32 = 10;
pub const REGULAR_WINDOW_DAYS: i64 = 90;
/// Memories that ride an arrival into the greet and tick context (D10).
pub const VIEWER_MEMORIES_MAX: usize = 3;
/// "Back": the person's last chat was this long ago or longer (D7).
pub const BACK_AFTER_DAYS: i64 = 30;
/// YouTube accounts are remembered this long after their last chat (D3,
/// YouTube's 30-day rule); the other platforms this long (D3).
pub const YOUTUBE_RETENTION_DAYS: i64 = 30;
pub const OTHER_RETENTION_DAYS: i64 = 365;
/// The milestones (D8): the Nth stream, N in a row, and a yearly
/// anniversary celebrated within this many days after the date.
pub const STREAM_MILESTONES: [u32; 7] = [5, 10, 25, 50, 100, 250, 500];
pub const ROW_MILESTONES: [u32; 4] = [3, 5, 10, 20];
pub const ANNIVERSARY_WINDOW_DAYS: i64 = 7;
/// `!link <word>`: both messages within this long (D4 b).
pub const LINK_WORD_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const LINK_WORD_MIN_CHARS: usize = 4;
pub const LINK_WORD_MAX_CHARS: usize = 24;
/// The streamer's note about a person (D2).
pub const NOTE_MAX_CHARS: usize = 300;
/// A "Linked … Undo" card stays this long (D4 b).
pub const LINK_MADE_TTL: Duration = Duration::from_secs(15 * 60);
/// `community.list` pages.
pub const LIST_LIMIT_MAX: usize = 100;
/// D15: a first-timer "stayed" when their first and last message of the
/// stream were this many minutes apart or more.
pub const STAYED_MINUTES: i64 = 40;
/// The refusal code for a manual link that touches an X account (D4).
pub const X_SELF_LINK_ONLY: &str = "x-self-link-only";

// --- Wire shapes ---------------------------------------------------------------

/// Which milestone an arrival celebrates (D8).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ViewerMilestoneKind {
    Streams,
    Row,
    Anniversary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ViewerMilestone {
    pub kind: ViewerMilestoneKind,
    /// The stream count, the run, or the anniversary's year.
    pub value: u32,
}

impl ViewerMilestone {
    /// The key kept in `milestones_json` ("streams-10", "row-5",
    /// "year-2027"), so each is celebrated once per person.
    pub fn key(&self) -> String {
        match self.kind {
            ViewerMilestoneKind::Streams => format!("streams-{}", self.value),
            ViewerMilestoneKind::Row => format!("row-{}", self.value),
            ViewerMilestoneKind::Anniversary => format!("year-{}", self.value),
        }
    }

    /// The chip and the card ("10th stream", "5 in a row", "One year").
    pub fn label(&self) -> String {
        match self.kind {
            ViewerMilestoneKind::Streams => format!("{} stream", ordinal(self.value)),
            ViewerMilestoneKind::Row => format!("{} in a row", self.value),
            ViewerMilestoneKind::Anniversary => "One year".to_string(),
        }
    }
}

/// What a returning person's arrival row carries (Wire shape). Set only on
/// the arrival row, never on a first-timer's, a bot's or the streamer's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewerArrival {
    /// Streams chatted in, including this one.
    pub streams: u32,
    pub regular: bool,
    /// Only for Back (D7): days since the last chat, 30 or more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_days: Option<u32>,
    pub in_a_row: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ViewerMilestone>,
    /// Only when the person has two or more accounts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<StreamPlatform>,
    /// "2026-03", for the hover line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// Plan 225 D10: what Buddy remembers of the person (the newest
    /// [`VIEWER_MEMORIES_MAX`]), read beside the arrival for one delivery
    /// when "Buddy remembers" is on. Never on the wire and never in SQLite:
    /// the greet and tick context read it here; the card fetches memories
    /// on open.
    #[serde(skip)]
    pub memories: Vec<String>,
    /// The streamer's note, the same way (the tick's `viewers` only).
    #[serde(skip)]
    pub note: Option<String>,
}

/// A person's status (D1, D13).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityPersonStatus {
    #[default]
    Normal,
    Bot,
    Forgotten,
}

impl CommunityPersonStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Bot => "bot",
            Self::Forgotten => "forgotten",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "bot" => Self::Bot,
            "forgotten" => Self::Forgotten,
            _ => Self::Normal,
        }
    }
}

/// Support totals from Activity rows (D2): never attendance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySupport {
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub bits: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub kicks: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub gifted_subs: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub sub_months: u64,
    /// Tips by currency, in micros ("USD" → 20_000_000 for $20).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub tips: std::collections::BTreeMap<String, u64>,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

impl CommunitySupport {
    pub fn is_empty(&self) -> bool {
        self.bits == 0
            && self.kicks == 0
            && self.gifted_subs == 0
            && self.sub_months == 0
            && self.tips.is_empty()
    }

    pub fn add(&mut self, other: &CommunitySupport) {
        self.bits = self.bits.saturating_add(other.bits);
        self.kicks = self.kicks.saturating_add(other.kicks);
        self.gifted_subs = self.gifted_subs.saturating_add(other.gifted_subs);
        self.sub_months = self.sub_months.saturating_add(other.sub_months);
        for (currency, micros) in &other.tips {
            let slot = self.tips.entry(currency.clone()).or_insert(0);
            *slot = slot.saturating_add(*micros);
        }
    }
}

/// One of a person's accounts, as the card shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityAccount {
    pub account_key: String,
    pub platform: StreamPlatform,
    pub author_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

/// A memory Buddy learned (Premium, D10). Phase A stores the shape; the
/// memory pass (Phase F) writes them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMemory {
    pub id: String,
    /// The account whose words taught it (D4: a split returns it there).
    pub account_key: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// "Might be the same person" (D4 c), or a cancelled `!link` (D4 b).
/// `cohost.community.suggestions` (D12): the open ones, newest first.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySuggestionsPage {
    pub suggestions: Vec<CommunitySuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySuggestion {
    pub account_a: CommunityAccount,
    pub account_b: CommunityAccount,
    pub reason: CommunitySuggestionReason,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommunitySuggestionReason {
    Name,
    LinkCancelled,
}

impl CommunitySuggestionReason {
    pub fn parse(value: &str) -> Self {
        match value {
            "link-cancelled" => Self::LinkCancelled,
            _ => Self::Name,
        }
    }
}

/// Who linked what and when (D4), kept so the streamer can see it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityLinkEvent {
    pub id: String,
    pub account_key: String,
    pub kind: CommunityLinkKind,
    pub at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityLinkKind {
    /// The viewer typed `!link <word>` in two chats.
    #[serde(rename = "self")]
    SelfLink,
    /// The streamer's "Same person as…".
    Manual,
    /// "Not the same person" or `!unlink`.
    Split,
    /// The streamer accepted "Might be the same person".
    SuggestionAccepted,
}

impl CommunityLinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelfLink => "self",
            Self::Manual => "manual",
            Self::Split => "split",
            Self::SuggestionAccepted => "suggestion-accepted",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "self" => Self::SelfLink,
            "manual" => Self::Manual,
            "split" => Self::Split,
            _ => Self::SuggestionAccepted,
        }
    }
}

/// `cohost.community.person`: one person, in full (D11, D12).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPerson {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub accounts: Vec<CommunityAccount>,
    pub streams: u32,
    pub messages: u64,
    pub in_a_row: u32,
    pub best_in_a_row: u32,
    pub regular: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub support: CommunitySupport,
    /// The milestones celebrated so far, by key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub milestones: Vec<String>,
    pub note: String,
    pub status: CommunityPersonStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memories: Vec<CommunityMemory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<CommunitySuggestion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub link_events: Vec<CommunityLinkEvent>,
    /// The person has a YouTube account: the card shows the retention line.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub youtube: bool,
}

/// One row of `cohost.community.list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPersonRow {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub platforms: Vec<StreamPlatform>,
    pub streams: u32,
    pub regular: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub status: CommunityPersonStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityListFilter {
    Regulars,
    #[default]
    Everyone,
    Linked,
    Bots,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityListSort {
    #[default]
    Streams,
    Recent,
    Name,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default)]
    pub filter: CommunityListFilter,
    #[serde(default)]
    pub sort: CommunityListSort,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityListPage {
    pub people: Vec<CommunityPersonRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CommunityBackfillState {
    #[default]
    Idle,
    Running,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityBackfill {
    pub state: CommunityBackfillState,
    pub done: u32,
    pub total: u32,
}

/// `cohost.community.summary` and the `cohost.community.changed` event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySummary {
    pub people: u32,
    pub regulars: u32,
    pub streams: u32,
    pub new_regulars_this_week: u32,
    pub links_pending: u32,
    pub backfill: CommunityBackfill,
}

/// `cohost.community.person` takes a person id or an account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPersonParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<StreamPlatform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    /// The latest name the caller knows, for the zero-count person an
    /// unknown account gets (A5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityUpdateParams {
    pub person_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `normal` or `bot`; `forgotten` goes through `forget`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<CommunityPersonStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityLinkParams {
    pub person_id: String,
    pub other_person_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityUnlinkParams {
    pub account_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityUnlinkResult {
    pub person_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySuggestionParams {
    pub account_a: String,
    pub account_b: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPersonIdParams {
    pub person_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityIdParams {
    pub id: String,
}

/// `cohost.community.export`, after main consumed the picker's
/// `outputDirectoryCapability` into `outputDirectory` (a raw folder from the
/// renderer is refused; the admin role may pass one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityExportParams {
    pub output_directory: String,
}

/// `cohost.community.import`, after main consumed the picker's
/// `sourceCapability` into `path` (a raw path from the renderer is refused;
/// the admin role may pass one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityImportParams {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityAccepted {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityExportResult {
    pub people: u32,
    pub bytes: u64,
    /// The file written into the chosen folder: `videorc-community-<date>.json`.
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityImportResult {
    pub people: u32,
    pub merged: u32,
}

/// `cohost.state.welcomeBack[]` (D11): a returning person's arrival, under
/// "Say hi", until waved at or welcomed, 15 minutes at most.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostWelcomeBack {
    pub person_id: String,
    pub author_key: String,
    pub name: String,
    pub platform: StreamPlatform,
    pub arrival: ViewerArrival,
    pub first_seen_at: String,
}

/// `cohost.state.linkMade[]` (D4 b): the "Linked … Undo" card, 15 minutes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostLinkMade {
    pub person_id: String,
    pub names: [String; 2],
    pub platforms: [StreamPlatform; 2],
    /// The account the Undo splits off (the one that joined).
    pub account_key: String,
    pub at: String,
}

/// `cohostSettings.community` (Wire shape), every field with a default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySettings {
    /// Remember my community (the master switch, default ON).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Regular after N streams (2 to 10, default 3).
    #[serde(default = "default_regular_streams")]
    pub regular_streams: u32,
    /// Welcome regulars on stream (the regular, comeback and milestone
    /// welcomes; default ON).
    #[serde(default = "default_true")]
    pub welcome_on_stream: bool,
    /// Show milestone cards automatically (default OFF).
    #[serde(default)]
    pub milestone_cards: bool,
    /// Buddy remembers (Premium, D10, default OFF).
    #[serde(default)]
    pub remember: bool,
    /// D10: the "Let Buddy remember…" card was answered (Turn on or Not
    /// now), so it is never offered twice.
    #[serde(default)]
    pub remember_offered: bool,
    /// Community sync (Premium, D5, default OFF).
    #[serde(default)]
    pub sync: bool,
}

fn default_true() -> bool {
    true
}

fn default_regular_streams() -> u32 {
    REGULAR_STREAMS_DEFAULT
}

impl Default for CommunitySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            regular_streams: REGULAR_STREAMS_DEFAULT,
            welcome_on_stream: true,
            milestone_cards: false,
            remember: false,
            remember_offered: false,
            sync: false,
        }
    }
}

impl CommunitySettings {
    /// The threshold within D7's bounds, whatever was stored or patched.
    pub fn normalized(mut self) -> Self {
        self.regular_streams = self
            .regular_streams
            .clamp(REGULAR_STREAMS_MIN, REGULAR_STREAMS_MAX);
        self
    }
}

// --- The numbers (D7, D8) ------------------------------------------------------

/// A stream the store knows (`community_streams`): when it started and the
/// platforms it reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownStream {
    pub session_id: String,
    pub started_at: DateTime<Utc>,
    pub platforms: Vec<StreamPlatform>,
}

/// Everything the rules need about one person, from the store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PersonHistory {
    /// The platforms of the person's live accounts.
    pub platforms: Vec<StreamPlatform>,
    /// `(session_id, started_at)` of every stream the person chatted in,
    /// any account, after retention.
    pub attended: Vec<(String, DateTime<Utc>)>,
    pub messages: u64,
    pub first_seen_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
    /// Milestone keys already celebrated.
    pub celebrated: Vec<String>,
}

impl PersonHistory {
    pub fn youtube_only(&self) -> bool {
        !self.platforms.is_empty()
            && self
                .platforms
                .iter()
                .all(|platform| *platform == StreamPlatform::Youtube)
    }

    /// Distinct streams chatted in.
    pub fn streams(&self) -> u32 {
        let mut ids: Vec<&str> = self.attended.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        u32::try_from(ids.len()).unwrap_or(u32::MAX)
    }
}

/// A regular chatted in `threshold` or more distinct streams in the last
/// [`REGULAR_WINDOW_DAYS`] (D7). YouTube attendance is at most 30 days old
/// by retention, so the same window serves it.
pub fn is_regular(history: &PersonHistory, now: DateTime<Utc>, threshold: u32) -> bool {
    let since = now - chrono::Duration::days(REGULAR_WINDOW_DAYS);
    let mut ids: Vec<&str> = history
        .attended
        .iter()
        .filter(|(_, started_at)| *started_at >= since)
        .map(|(id, _)| id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.len() >= threshold.max(1) as usize
}

/// Streams chatted in, in a row, counting only streams that reached one of
/// the person's platforms (D2), newest first, including `current` when it
/// is given. `streams` is every stream the store knows, any order.
pub fn in_a_row(history: &PersonHistory, streams: &[KnownStream]) -> u32 {
    let mut ordered: Vec<&KnownStream> = streams
        .iter()
        .filter(|stream| {
            stream
                .platforms
                .iter()
                .any(|platform| history.platforms.contains(platform))
        })
        .collect();
    ordered.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    let mut run = 0u32;
    for stream in ordered {
        if history
            .attended
            .iter()
            .any(|(id, _)| *id == stream.session_id)
        {
            run = run.saturating_add(1);
        } else {
            break;
        }
    }
    run
}

/// The longest run of streams chatted in, in a row, over the streams that
/// reached one of the person's platforms (F8). A YouTube-only person's
/// `best_in_a_row` is recomputed to this at every refresh, so it never
/// outlives the 30-day history it came from (D3).
pub fn best_in_a_row(history: &PersonHistory, streams: &[KnownStream]) -> u32 {
    let mut ordered: Vec<&KnownStream> = streams
        .iter()
        .filter(|stream| {
            stream
                .platforms
                .iter()
                .any(|platform| history.platforms.contains(platform))
        })
        .collect();
    ordered.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    let mut best = 0u32;
    let mut run = 0u32;
    for stream in ordered {
        if history
            .attended
            .iter()
            .any(|(id, _)| *id == stream.session_id)
        {
            run = run.saturating_add(1);
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

/// The celebrated milestones a YouTube-only person's recomputed counts
/// still justify (F8): a stream or in-a-row milestone no higher than the
/// counts, and never an anniversary (D3). The rest are forgotten with the
/// attendance that earned them.
pub fn milestones_within(celebrated: &[String], streams: u32, best_in_a_row: u32) -> Vec<String> {
    celebrated
        .iter()
        .filter(|key| {
            if let Some(value) = key.strip_prefix("streams-") {
                value.parse::<u32>().is_ok_and(|value| value <= streams)
            } else if let Some(value) = key.strip_prefix("row-") {
                value
                    .parse::<u32>()
                    .is_ok_and(|value| value <= best_in_a_row)
            } else {
                false
            }
        })
        .cloned()
        .collect()
}

/// Days since the last chat when it was [`BACK_AFTER_DAYS`] or more ago (D7);
/// never for a YouTube-only person, whose data is at most 30 days old.
pub fn away_days(history: &PersonHistory, now: DateTime<Utc>) -> Option<u32> {
    if history.youtube_only() {
        return None;
    }
    let last = history.last_seen_at?;
    let days = now.signed_duration_since(last).num_days();
    (days >= BACK_AFTER_DAYS).then(|| u32::try_from(days).unwrap_or(u32::MAX))
}

/// The milestone this arrival lands on (D8): the Nth stream, N in a row, or
/// the anniversary, each once per person; when two land together the
/// biggest wins (anniversary, then streams, then in a row). YouTube-only
/// people get no anniversary (D3).
pub fn milestone_due(
    history: &PersonHistory,
    streams: u32,
    in_a_row: u32,
    now: DateTime<Utc>,
) -> Option<ViewerMilestone> {
    let celebrated = |milestone: &ViewerMilestone| history.celebrated.contains(&milestone.key());
    let mut candidates: Vec<ViewerMilestone> = Vec::new();
    if let Some(first) = history.first_seen_at
        && !history.youtube_only()
    {
        let years = now.year() - first.year();
        if years >= 1
            && let Some(date) = anniversary_on(first, now.year())
        {
            let since = now.signed_duration_since(date).num_days();
            if (0..=ANNIVERSARY_WINDOW_DAYS).contains(&since) {
                candidates.push(ViewerMilestone {
                    kind: ViewerMilestoneKind::Anniversary,
                    value: u32::try_from(now.year()).unwrap_or(0),
                });
            }
        }
    }
    if STREAM_MILESTONES.contains(&streams) || smoke_stream_milestone() == Some(streams) {
        candidates.push(ViewerMilestone {
            kind: ViewerMilestoneKind::Streams,
            value: streams,
        });
    }
    if ROW_MILESTONES.contains(&in_a_row) {
        candidates.push(ViewerMilestone {
            kind: ViewerMilestoneKind::Row,
            value: in_a_row,
        });
    }
    let rank = |milestone: &ViewerMilestone| match milestone.kind {
        ViewerMilestoneKind::Anniversary => 2,
        ViewerMilestoneKind::Streams => 1,
        ViewerMilestoneKind::Row => 0,
    };
    candidates
        .into_iter()
        .filter(|milestone| !celebrated(milestone))
        .max_by_key(rank)
}

/// Debug builds only: `VIDEORC_SMOKE_COMMUNITY_MILESTONE_STREAMS=2` makes
/// the Nth stream a milestone too, so `smoke:cohost-fake` sees one on its
/// second fake session (plan 225 B6). Compiled out of release builds.
fn smoke_stream_milestone() -> Option<u32> {
    #[cfg(debug_assertions)]
    {
        std::env::var("VIDEORC_SMOKE_COMMUNITY_MILESTONE_STREAMS")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|value| *value >= 2)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// The first chat's anniversary in `year`, or `None` for a year without
/// that date (29 February).
fn anniversary_on(first: DateTime<Utc>, year: i32) -> Option<DateTime<Utc>> {
    first.with_year(year)
}

/// "2026-03" for the hover line.
pub fn since_month(first_seen_at: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", first_seen_at.year(), first_seen_at.month())
}

/// The arrival facts of a person who chatted before, for the stream they
/// just arrived in (`streams` already counts it; `in_a_row` too).
pub fn arrival_facts(
    history: &PersonHistory,
    streams: u32,
    in_a_row: u32,
    now: DateTime<Utc>,
    threshold: u32,
) -> ViewerArrival {
    let milestone = milestone_due(history, streams, in_a_row, now);
    let mut platforms = history.platforms.clone();
    platforms.sort_by_key(|platform| stream_platform_id(*platform));
    platforms.dedup();
    if platforms.len() < 2 {
        platforms.clear();
    }
    ViewerArrival {
        streams,
        regular: is_regular(history, now, threshold),
        away_days: away_days(history, now),
        in_a_row,
        milestone,
        platforms,
        since: history.first_seen_at.map(since_month),
        memories: Vec::new(),
        note: None,
    }
}

/// "10th", "21st", "112th".
pub fn ordinal(value: u32) -> String {
    let suffix = match (value % 10, value % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{value}{suffix}")
}

/// "3 weeks", "3 months", "12 days" for `{away}` and the card (D7: weeks
/// under 8, then months).
pub fn away_label(days: u32) -> String {
    if days < 14 {
        format!("{days} day{}", if days == 1 { "" } else { "s" })
    } else if days < 56 {
        let weeks = days / 7;
        format!("{weeks} week{}", if weeks == 1 { "" } else { "s" })
    } else {
        let months = (days / 30).max(2);
        format!("{months} months")
    }
}

/// "Back · 3 wk" / "Back · 3 mo", the chip's short form (the renderer
/// draws the chip in Phase C; this is the one source of its words).
#[cfg_attr(not(test), allow(dead_code))]
pub fn away_chip(days: u32) -> String {
    if days < 56 {
        format!("Back · {} wk", (days / 7).max(1))
    } else {
        format!("Back · {} mo", (days / 30).max(2))
    }
}

/// "March 2026" for `{since}`.
pub fn since_label(first_seen_at: DateTime<Utc>) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    format!(
        "{} {}",
        MONTHS[(first_seen_at.month0() as usize).min(11)],
        first_seen_at.year()
    )
}

// --- Platforms and names ---------------------------------------------------------

/// Whether chat on this platform carries an identity the store may keep:
/// YouTube, Twitch, Kick and X. The rest report chat as unsupported, and a
/// Custom RTMP row is never counted (D1).
pub fn platform_has_identity(platform: StreamPlatform) -> bool {
    matches!(
        platform,
        StreamPlatform::Youtube | StreamPlatform::Twitch | StreamPlatform::Kick | StreamPlatform::X
    )
}

/// `<platform>:<author_id>`, as `chatter_key` builds it.
pub fn account_key(platform: StreamPlatform, author_id: &str) -> String {
    format!("{}:{author_id}", stream_platform_id(platform))
}

/// The name as "Might be the same person" compares it (D4 c): lowercased,
/// without spaces, `_`, `.` and `-`. `None` when nothing is left.
pub fn suggestion_name_key(name: &str) -> Option<String> {
    let key: String = name
        .trim()
        .trim_start_matches('@')
        .chars()
        .filter(|ch| !ch.is_whitespace() && !matches!(ch, '_' | '.' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    (key.chars().count() >= 3).then_some(key)
}

// --- The viewer's own commands (D13, D4 b) ------------------------------------

/// A `!` command a viewer typed. The parser is a prefix check on the trimmed
/// text: a row that does not start with `!` costs nothing (D14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatCommand {
    /// `!forgetme`: forget this account on the spot.
    ForgetMe,
    /// `!rememberme`: lift the tombstone.
    RememberMe,
    /// `!unlink`: split this account off its person.
    Unlink,
    /// `!link <word>`: the word, lowercased.
    Link(String),
}

/// Parse a chat row's text (exact, any case, trimmed). `!link` needs one
/// word of 4 to 24 letters, digits, `-` or `_`; anything else after `!link`
/// is not a command.
pub fn parse_chat_command(text: &str) -> Option<ChatCommand> {
    let text = text.trim();
    if !text.starts_with('!') {
        return None;
    }
    let mut parts = text[1..].split_whitespace();
    let command = parts.next()?.to_ascii_lowercase();
    let rest: Vec<&str> = parts.collect();
    match (command.as_str(), rest.as_slice()) {
        ("forgetme", []) => Some(ChatCommand::ForgetMe),
        ("rememberme", []) => Some(ChatCommand::RememberMe),
        ("unlink", []) => Some(ChatCommand::Unlink),
        ("link", [word]) => link_word(word).map(ChatCommand::Link),
        _ => None,
    }
}

/// A `!link` word, lowercased, or `None` when it is not one.
pub fn link_word(word: &str) -> Option<String> {
    let count = word.chars().count();
    if !(LINK_WORD_MIN_CHARS..=LINK_WORD_MAX_CHARS).contains(&count)
        || !word
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return None;
    }
    Some(word.to_ascii_lowercase())
}

/// One `!link <word>` claim waiting for its pair (D4 b).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkClaim {
    pub account_key: String,
    pub platform: StreamPlatform,
    pub person_id: String,
    pub name: String,
    pub at: Instant,
}

/// What a `!link` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkOutcome {
    /// The first claim of this word: waiting for the second chat.
    Waiting,
    /// Two accounts on two platforms said the word within the window.
    Linked { first: LinkClaim, second: LinkClaim },
    /// A second account on the same platform claimed the word, or a claim
    /// came on a word already burnt: the word is burnt, and Community lists
    /// the pair for the streamer (D4 b).
    Cancelled { first: LinkClaim, second: LinkClaim },
    /// A third account claimed a word that linked within the window (the
    /// review of 2026-11-09, F5): the word was public, so the join may be
    /// a hijack. The caller splits `second` off again and lists all three
    /// under "Links that need you".
    Hijacked {
        first: LinkClaim,
        second: LinkClaim,
        third: LinkClaim,
    },
    /// The same account again, or the two accounts are already one person.
    Ignored,
}

/// A word that linked or was cancelled (F5): burnt for the rest of its
/// window, so a late third claim cannot start the word afresh.
#[derive(Debug, Clone)]
struct BurntWord {
    at: Instant,
    first: LinkClaim,
    second: LinkClaim,
    /// The word joined two accounts (a later claim undoes that); `false`
    /// once cancelled or hijacked.
    linked: bool,
}

/// Pending `!link` words, in memory only, keyed by word (Wire shape). They
/// die with the session.
#[derive(Debug, Default)]
pub struct PendingLinks {
    claims: HashMap<String, LinkClaim>,
    burnt: HashMap<String, BurntWord>,
}

impl PendingLinks {
    /// `account` says `word` at `now`. A word is single-use: once linked or
    /// cancelled it is burnt for the rest of its window (F5); a claim on a
    /// burnt word undoes the join it made and lists everyone involved.
    pub fn claim(&mut self, word: &str, claim: LinkClaim) -> LinkOutcome {
        self.expire(claim.at);
        if let Some(burnt) = self.burnt.get_mut(word) {
            if burnt.first.account_key == claim.account_key
                || burnt.second.account_key == claim.account_key
            {
                return LinkOutcome::Ignored;
            }
            if burnt.linked {
                burnt.linked = false;
                return LinkOutcome::Hijacked {
                    first: burnt.first.clone(),
                    second: burnt.second.clone(),
                    third: claim,
                };
            }
            return LinkOutcome::Cancelled {
                first: burnt.first.clone(),
                second: claim,
            };
        }
        let Some(first) = self.claims.get(word).cloned() else {
            self.claims.insert(word.to_string(), claim);
            return LinkOutcome::Waiting;
        };
        if first.account_key == claim.account_key || first.person_id == claim.person_id {
            return LinkOutcome::Ignored;
        }
        self.claims.remove(word);
        let linked = first.platform != claim.platform;
        self.burnt.insert(
            word.to_string(),
            BurntWord {
                at: first.at,
                first: first.clone(),
                second: claim.clone(),
                linked,
            },
        );
        if linked {
            LinkOutcome::Linked {
                first,
                second: claim,
            }
        } else {
            LinkOutcome::Cancelled {
                first,
                second: claim,
            }
        }
    }

    /// Drop claims and burnt words older than the window.
    pub fn expire(&mut self, now: Instant) {
        self.claims
            .retain(|_, claim| now.saturating_duration_since(claim.at) < LINK_WORD_WINDOW);
        self.burnt
            .retain(|_, burnt| now.saturating_duration_since(burnt.at) < LINK_WORD_WINDOW);
    }

    pub fn clear(&mut self) {
        self.claims.clear();
        self.burnt.clear();
    }

    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.claims.len()
    }
}

/// The bubble line a command earns, in Bubble mode only (D13, plan 211):
/// `None` for Off and Suggest, and never a chat send anywhere.
pub fn command_bubble_line(
    talk: crate::cohost::CohostTalkMode,
    command: &ChatCommand,
    name: &str,
    linked: Option<(&str, StreamPlatform, &str, StreamPlatform)>,
) -> Option<String> {
    if talk != crate::cohost::CohostTalkMode::Bubble {
        return None;
    }
    let name = name.trim();
    match command {
        ChatCommand::ForgetMe => Some(format!("Done, {name}. I've forgotten you.")),
        ChatCommand::RememberMe => Some(format!("Welcome back to the list, {name}.")),
        ChatCommand::Unlink => Some(format!("Unlinked, {name}.")),
        ChatCommand::Link(_) => linked.map(|(a, platform_a, b, platform_b)| {
            use crate::streaming::stream_platform_label;
            if a.eq_ignore_ascii_case(b) {
                format!(
                    "Linked: {a} on {} and {}.",
                    stream_platform_label(platform_a),
                    stream_platform_label(platform_b)
                )
            } else {
                format!(
                    "Linked: {a} on {} and {b} on {}.",
                    stream_platform_label(platform_a),
                    stream_platform_label(platform_b)
                )
            }
        }),
    }
}

/// One arrival of a stream, kept in memory for the report (D15). The
/// account key lets a `!forgetme` take the arrival out again before the
/// block is written (the review of 2026-11-09, F2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportArrival {
    pub account_key: String,
    pub name: String,
    pub platform: StreamPlatform,
    pub arrival: ViewerArrival,
}

/// The report's Community block (D15) from what the stream saw: its
/// arrivals (the rows that carried `arrival`), the store's first-timers and
/// how many stayed, and the links and opt-outs counted live. A "new
/// regular" is an arrival that is regular on exactly the threshold's
/// stream, so it became one with this stream.
pub fn report_community(
    arrivals: &[ReportArrival],
    first_timers: u32,
    first_timers_stayed: u32,
    links_made: u32,
    opt_outs: u32,
    threshold: u32,
) -> crate::protocol::CohostReportCommunity {
    use crate::protocol::{
        COHOST_REPORT_COMMUNITY_MILESTONES_CAP, COHOST_REPORT_COMMUNITY_NAMES_CAP,
        CohostReportCommunity, CohostReportCommunityMilestone, CohostReportCommunityPerson,
    };
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let mut regulars: Vec<&ReportArrival> = arrivals
        .iter()
        .filter(|entry| entry.arrival.regular)
        .collect();
    let regulars_back = count(regulars.len());
    let new_regulars = count(
        regulars
            .iter()
            .filter(|entry| entry.arrival.streams == threshold.max(1))
            .count(),
    );
    regulars.sort_by(|a, b| {
        b.arrival
            .streams
            .cmp(&a.arrival.streams)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    CohostReportCommunity {
        regulars_back,
        regulars: regulars
            .into_iter()
            .take(COHOST_REPORT_COMMUNITY_NAMES_CAP)
            .map(|entry| CohostReportCommunityPerson {
                name: entry.name.clone(),
                platform: entry.platform,
                platforms: entry.arrival.platforms.clone(),
                streams: entry.arrival.streams,
            })
            .collect(),
        new_regulars,
        comebacks: count(
            arrivals
                .iter()
                .filter(|entry| entry.arrival.away_days.is_some())
                .count(),
        ),
        first_timers,
        first_timers_stayed,
        milestones: arrivals
            .iter()
            .filter_map(|entry| {
                Some(CohostReportCommunityMilestone {
                    name: entry.name.clone(),
                    platform: entry.platform,
                    milestone: entry.arrival.milestone?,
                })
            })
            .take(COHOST_REPORT_COMMUNITY_MILESTONES_CAP)
            .collect(),
        links_made,
        memories_learned: 0,
        opt_outs,
        summary: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn day(year: i32, month: u32, day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, 12, 0, 0).unwrap()
    }

    fn stream(id: &str, started: DateTime<Utc>, platforms: &[StreamPlatform]) -> KnownStream {
        KnownStream {
            session_id: id.to_string(),
            started_at: started,
            platforms: platforms.to_vec(),
        }
    }

    #[test]
    fn a_regular_chatted_in_three_streams_in_ninety_days() {
        let now = day(2026, 11, 8);
        let mut history = PersonHistory {
            platforms: vec![StreamPlatform::Twitch],
            attended: vec![
                ("s1".into(), day(2026, 10, 1)),
                ("s2".into(), day(2026, 10, 15)),
                ("s3".into(), day(2026, 11, 1)),
            ],
            ..Default::default()
        };
        assert!(is_regular(&history, now, 3));
        assert!(!is_regular(&history, now, 4));
        // A stream older than 90 days drops out of the window.
        history.attended[0].1 = day(2026, 7, 1);
        assert!(!is_regular(&history, now, 3));
        assert!(is_regular(&history, now, 2));
        // The same stream twice (two accounts) counts once.
        history.attended.push(("s3".into(), day(2026, 11, 1)));
        assert!(!is_regular(&history, now, 3));
        assert_eq!(history.streams(), 3);
    }

    #[test]
    fn in_a_row_skips_streams_that_never_reached_the_persons_platform() {
        let history = PersonHistory {
            platforms: vec![StreamPlatform::Twitch],
            attended: vec![
                ("s1".into(), day(2026, 10, 1)),
                ("s2".into(), day(2026, 10, 2)),
                ("s4".into(), day(2026, 10, 4)),
            ],
            ..Default::default()
        };
        let streams = vec![
            stream("s1", day(2026, 10, 1), &[StreamPlatform::Twitch]),
            stream("s2", day(2026, 10, 2), &[StreamPlatform::Twitch]),
            // A YouTube-only stream: not a miss for a Twitch person.
            stream("s3", day(2026, 10, 3), &[StreamPlatform::Youtube]),
            stream("s4", day(2026, 10, 4), &[StreamPlatform::Twitch]),
        ];
        assert_eq!(in_a_row(&history, &streams), 3);
        // A Twitch stream they missed breaks the run.
        let mut with_miss = streams.clone();
        with_miss.push(stream("s5", day(2026, 10, 5), &[StreamPlatform::Twitch]));
        assert_eq!(in_a_row(&history, &with_miss), 0);
        with_miss.push(stream("s6", day(2026, 10, 6), &[StreamPlatform::Twitch]));
        let mut back = history.clone();
        back.attended.push(("s6".into(), day(2026, 10, 6)));
        assert_eq!(in_a_row(&back, &with_miss), 1);
        // F8: the best run over the whole history, and the milestones the
        // recomputed counts still justify.
        assert_eq!(best_in_a_row(&back, &with_miss), 3);
        assert_eq!(best_in_a_row(&history, &streams), 3);
        assert_eq!(
            milestones_within(
                &[
                    "streams-5".into(),
                    "streams-10".into(),
                    "row-3".into(),
                    "row-5".into(),
                    "year-2026".into()
                ],
                7,
                3
            ),
            vec!["streams-5".to_string(), "row-3".to_string()]
        );
    }

    #[test]
    fn back_after_thirty_days_never_on_a_youtube_only_person() {
        let now = day(2026, 11, 8);
        let mut history = PersonHistory {
            platforms: vec![StreamPlatform::Twitch],
            last_seen_at: Some(day(2026, 10, 1)),
            ..Default::default()
        };
        assert_eq!(away_days(&history, now), Some(38));
        history.last_seen_at = Some(day(2026, 10, 20));
        assert_eq!(away_days(&history, now), None);
        history.last_seen_at = Some(day(2026, 9, 1));
        history.platforms = vec![StreamPlatform::Youtube];
        assert_eq!(away_days(&history, now), None);
        history.platforms = vec![StreamPlatform::Youtube, StreamPlatform::Kick];
        assert_eq!(away_days(&history, now), Some(68));
        assert_eq!(away_chip(38), "Back · 5 wk");
        assert_eq!(away_chip(68), "Back · 2 mo");
        assert_eq!(away_label(38), "5 weeks");
        assert_eq!(away_label(100), "3 months");
        assert_eq!(away_label(12), "12 days");
    }

    #[test]
    fn each_milestone_lands_once_and_the_biggest_wins() {
        let now = day(2026, 11, 8);
        let mut history = PersonHistory {
            platforms: vec![StreamPlatform::Kick],
            first_seen_at: Some(day(2025, 11, 5)),
            ..Default::default()
        };
        // Streams 10 and 5 in a row together: streams wins.
        assert_eq!(
            milestone_due(&history, 10, 5, day(2026, 6, 1)),
            Some(ViewerMilestone {
                kind: ViewerMilestoneKind::Streams,
                value: 10
            })
        );
        // Once celebrated, the row milestone shows instead.
        history.celebrated.push("streams-10".into());
        assert_eq!(
            milestone_due(&history, 10, 5, day(2026, 6, 1)),
            Some(ViewerMilestone {
                kind: ViewerMilestoneKind::Row,
                value: 5
            })
        );
        // Nothing between the numbers.
        assert_eq!(milestone_due(&history, 11, 6, day(2026, 6, 1)), None);
        // The anniversary: within 7 days after the date, once a year, and it
        // beats a stream milestone that lands the same day.
        let anniversary = milestone_due(&history, 25, 1, now).unwrap();
        assert_eq!(anniversary.kind, ViewerMilestoneKind::Anniversary);
        assert_eq!(anniversary.key(), "year-2026");
        assert_eq!(anniversary.label(), "One year");
        assert_eq!(milestone_due(&history, 1, 1, day(2026, 11, 13)), None);
        assert_eq!(milestone_due(&history, 1, 1, day(2026, 11, 4)), None);
        history.celebrated.push("year-2026".into());
        assert_eq!(milestone_due(&history, 1, 1, now), None);
        // A YouTube-only person gets no anniversary (D3).
        history.celebrated.clear();
        history.platforms = vec![StreamPlatform::Youtube];
        assert_eq!(milestone_due(&history, 1, 1, now), None);
        assert_eq!(ordinal(10), "10th");
        assert_eq!(ordinal(21), "21st");
        assert_eq!(ordinal(112), "112th");
        assert_eq!(ordinal(3), "3rd");
        assert_eq!(
            ViewerMilestone {
                kind: ViewerMilestoneKind::Streams,
                value: 25
            }
            .label(),
            "25th stream"
        );
    }

    #[test]
    fn arrival_facts_carry_platforms_only_for_a_linked_person() {
        let now = day(2026, 11, 8);
        let history = PersonHistory {
            platforms: vec![StreamPlatform::Youtube, StreamPlatform::Twitch],
            attended: vec![
                ("s1".into(), day(2026, 10, 1)),
                ("s2".into(), day(2026, 10, 8)),
                ("s3".into(), day(2026, 11, 8)),
            ],
            messages: 812,
            first_seen_at: Some(day(2026, 3, 2)),
            last_seen_at: Some(day(2026, 10, 8)),
            celebrated: Vec::new(),
        };
        let arrival = arrival_facts(&history, 3, 2, now, 3);
        assert_eq!(
            arrival,
            ViewerArrival {
                streams: 3,
                regular: true,
                away_days: Some(31),
                in_a_row: 2,
                milestone: None,
                platforms: vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
                since: Some("2026-03".into()),
                memories: Vec::new(),
                note: None,
            }
        );
        let one = PersonHistory {
            platforms: vec![StreamPlatform::Twitch],
            ..history
        };
        assert!(arrival_facts(&one, 3, 2, now, 3).platforms.is_empty());
        // The wire never carries a null: every absent field is omitted.
        let json = serde_json::to_value(arrival_facts(&one, 1, 1, now, 3)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "streams": 1,
                "regular": true,
                "awayDays": 31,
                "inARow": 1,
                "since": "2026-03"
            })
        );
        assert_eq!(since_label(day(2026, 3, 2)), "March 2026");
    }

    #[test]
    fn chat_commands_are_exact_any_case_and_trimmed() {
        assert_eq!(
            parse_chat_command("  !ForgetMe "),
            Some(ChatCommand::ForgetMe)
        );
        assert_eq!(
            parse_chat_command("!rememberme"),
            Some(ChatCommand::RememberMe)
        );
        assert_eq!(parse_chat_command("!UNLINK"), Some(ChatCommand::Unlink));
        assert_eq!(
            parse_chat_command("!link Pixel42"),
            Some(ChatCommand::Link("pixel42".into()))
        );
        for text in [
            "forgetme",
            "!forgetme please",
            "!link",
            "!link a",
            "!link two words",
            "!link has.dots",
            "!link this-word-is-far-too-long-for-us",
            "hello !forgetme",
            "",
            "!",
        ] {
            assert_eq!(parse_chat_command(text), None, "{text:?}");
        }
    }

    #[test]
    fn link_words_join_two_platforms_and_burn_on_a_same_platform_claim() {
        let start = Instant::now();
        let claim = |key: &str, platform: StreamPlatform, person: &str, at: Instant| LinkClaim {
            account_key: key.to_string(),
            platform,
            person_id: person.to_string(),
            name: key.to_string(),
            at,
        };
        let mut links = PendingLinks::default();
        assert_eq!(
            links.claim(
                "pixel42",
                claim("twitch:1", StreamPlatform::Twitch, "p1", start)
            ),
            LinkOutcome::Waiting
        );
        // The same account again: nothing changes.
        assert_eq!(
            links.claim(
                "pixel42",
                claim("twitch:1", StreamPlatform::Twitch, "p1", start + secs(5))
            ),
            LinkOutcome::Ignored
        );
        // A clean self-link across platforms, inside the window.
        match links.claim(
            "pixel42",
            claim("youtube:2", StreamPlatform::Youtube, "p2", start + secs(20)),
        ) {
            LinkOutcome::Linked { first, second } => {
                assert_eq!(first.account_key, "twitch:1");
                assert_eq!(second.account_key, "youtube:2");
            }
            other => panic!("{other:?}"),
        }
        // Single use: the word is burnt for the rest of its window (F5).
        // The two who linked may repeat it; a third account undoes the
        // join, and everyone involved waits for the streamer.
        assert_eq!(links.waiting(), 0);
        assert_eq!(
            links.claim(
                "pixel42",
                claim("youtube:2", StreamPlatform::Youtube, "p2", start + secs(25))
            ),
            LinkOutcome::Ignored
        );
        match links.claim(
            "pixel42",
            claim("x:3", StreamPlatform::X, "p3", start + secs(30)),
        ) {
            LinkOutcome::Hijacked {
                first,
                second,
                third,
            } => {
                assert_eq!(first.account_key, "twitch:1");
                assert_eq!(second.account_key, "youtube:2");
                assert_eq!(third.account_key, "x:3");
            }
            other => panic!("{other:?}"),
        }
        // A fourth claim is listed too, and undoes nothing more.
        match links.claim(
            "pixel42",
            claim("x:4", StreamPlatform::X, "p4", start + secs(40)),
        ) {
            LinkOutcome::Cancelled { first, second } => {
                assert_eq!(first.account_key, "twitch:1");
                assert_eq!(second.account_key, "x:4");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(links.waiting(), 0);
        // Past the window the word is free again.
        assert_eq!(
            links.claim(
                "pixel42",
                claim("x:5", StreamPlatform::X, "p5", start + secs(601))
            ),
            LinkOutcome::Waiting
        );
        links.clear();
        // A hijack on the same platform burns the word: nothing links, and
        // a third claim within the window is listed against the first.
        assert_eq!(
            links.claim(
                "teacup",
                claim("x:3", StreamPlatform::X, "p3", start + secs(30))
            ),
            LinkOutcome::Waiting
        );
        match links.claim(
            "teacup",
            claim("x:4", StreamPlatform::X, "p4", start + secs(40)),
        ) {
            LinkOutcome::Cancelled { first, second } => {
                assert_eq!(first.account_key, "x:3");
                assert_eq!(second.account_key, "x:4");
            }
            other => panic!("{other:?}"),
        }
        match links.claim(
            "teacup",
            claim("twitch:9", StreamPlatform::Twitch, "p9", start + secs(50)),
        ) {
            LinkOutcome::Cancelled { first, second } => {
                assert_eq!(first.account_key, "x:3");
                assert_eq!(second.account_key, "twitch:9");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(links.waiting(), 0);
        // Expiry at 10 minutes: the second chat starts a new claim.
        assert_eq!(
            links.claim(
                "later",
                claim("kick:5", StreamPlatform::Kick, "p5", start + secs(100))
            ),
            LinkOutcome::Waiting
        );
        assert_eq!(
            links.claim(
                "later",
                claim(
                    "twitch:6",
                    StreamPlatform::Twitch,
                    "p6",
                    start + secs(100 + 600)
                )
            ),
            LinkOutcome::Waiting
        );
        assert_eq!(links.waiting(), 1);
        // Two accounts already one person: ignored, the word stays.
        assert_eq!(
            links.claim(
                "later",
                claim(
                    "youtube:7",
                    StreamPlatform::Youtube,
                    "p6",
                    start + secs(710)
                )
            ),
            LinkOutcome::Ignored
        );
        assert_eq!(links.waiting(), 1);
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn suggestion_names_fold_case_spaces_and_separators_and_skip_x() {
        assert_eq!(suggestion_name_key("Max Plays"), Some("maxplays".into()));
        assert_eq!(suggestion_name_key("max_plays"), Some("maxplays".into()));
        assert_eq!(suggestion_name_key("@Max.Plays-"), Some("maxplays".into()));
        assert_eq!(suggestion_name_key("ab"), None);
        assert_eq!(suggestion_name_key("  _ "), None);
        assert!(platform_has_identity(StreamPlatform::X));
        assert!(!platform_has_identity(StreamPlatform::Custom));
        assert!(!platform_has_identity(StreamPlatform::Facebook));
        assert_eq!(account_key(StreamPlatform::Twitch, "42"), "twitch:42");
    }

    #[test]
    fn command_lines_are_bubble_only_and_silent_in_off_and_suggest() {
        use crate::cohost::CohostTalkMode;
        for talk in [CohostTalkMode::Off, CohostTalkMode::Suggest] {
            assert_eq!(
                command_bubble_line(talk, &ChatCommand::ForgetMe, "Ada", None),
                None
            );
            assert_eq!(
                command_bubble_line(
                    talk,
                    &ChatCommand::Link("w".into()),
                    "Ada",
                    Some((
                        "Ada",
                        StreamPlatform::Twitch,
                        "ada_dev",
                        StreamPlatform::Youtube
                    ))
                ),
                None
            );
        }
        assert_eq!(
            command_bubble_line(CohostTalkMode::Bubble, &ChatCommand::ForgetMe, "Ada", None)
                .as_deref(),
            Some("Done, Ada. I've forgotten you.")
        );
        assert_eq!(
            command_bubble_line(
                CohostTalkMode::Bubble,
                &ChatCommand::Link("w".into()),
                "Ada",
                Some((
                    "Ada",
                    StreamPlatform::Twitch,
                    "ada",
                    StreamPlatform::Youtube
                ))
            )
            .as_deref(),
            Some("Linked: Ada on Twitch and YouTube.")
        );
        assert_eq!(
            command_bubble_line(
                CohostTalkMode::Bubble,
                &ChatCommand::Link("w".into()),
                "Ada",
                Some((
                    "Ada",
                    StreamPlatform::Twitch,
                    "ada_dev",
                    StreamPlatform::Youtube
                ))
            )
            .as_deref(),
            Some("Linked: Ada on Twitch and ada_dev on YouTube.")
        );
        // A `!link` still waiting for its pair says nothing.
        assert_eq!(
            command_bubble_line(
                CohostTalkMode::Bubble,
                &ChatCommand::Link("w".into()),
                "Ada",
                None
            ),
            None
        );
    }

    /// The shared fixture (`protocol-fixtures/community.json`, A6): every
    /// wire shape round-trips field for field, an absent field is never
    /// `null`, and the rejected shapes never parse.
    #[test]
    fn shared_community_fixture_round_trips_without_nulls() {
        use crate::cohost::{CohostSettings, CohostState};
        use crate::live_chat::LiveChatMessage;
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol-fixtures/community.json"))
                .unwrap();
        fn no_nulls(value: &serde_json::Value, path: &str) {
            match value {
                serde_json::Value::Null => panic!("{path} is null"),
                serde_json::Value::Object(map) => {
                    for (key, inner) in map {
                        no_nulls(inner, &format!("{path}/{key}"));
                    }
                }
                serde_json::Value::Array(items) => {
                    for (index, inner) in items.iter().enumerate() {
                        no_nulls(inner, &format!("{path}/{index}"));
                    }
                }
                _ => {}
            }
        }
        let arrival_row: LiveChatMessage =
            serde_json::from_value(fixture["arrivalRow"].clone()).unwrap();
        assert_eq!(arrival_row.arrival.as_ref().unwrap().streams, 14);
        assert_eq!(
            serde_json::to_value(&arrival_row).unwrap(),
            fixture["arrivalRow"]
        );
        let plain_row: LiveChatMessage =
            serde_json::from_value(fixture["plainRow"].clone()).unwrap();
        assert!(plain_row.arrival.is_none());
        let plain_wire = serde_json::to_value(&plain_row).unwrap();
        assert_eq!(plain_wire, fixture["plainRow"]);
        assert!(plain_wire.get("arrival").is_none(), "absent, never null");
        let minimal: ViewerArrival =
            serde_json::from_value(fixture["minimalArrival"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&minimal).unwrap(),
            fixture["minimalArrival"]
        );
        let settings: CommunitySettings =
            serde_json::from_value(fixture["settings"].clone()).unwrap();
        assert_eq!(settings, CommunitySettings::default());
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            fixture["settings"]
        );
        let whole_settings = serde_json::to_value(CohostSettings::default()).unwrap();
        assert_eq!(whole_settings["community"], fixture["settings"]);
        for (key, check) in [
            ("summary", "people"),
            ("person", "accounts"),
            ("unknownPerson", "status"),
            ("listPage", "people"),
            ("listParams", "filter"),
        ] {
            let wire = fixture[key].clone();
            assert!(wire.get(check).is_some());
            let round_trip = match key {
                "summary" => serde_json::to_value(
                    serde_json::from_value::<CommunitySummary>(wire.clone()).unwrap(),
                )
                .unwrap(),
                "person" | "unknownPerson" => serde_json::to_value(
                    serde_json::from_value::<CommunityPerson>(wire.clone()).unwrap(),
                )
                .unwrap(),
                "listPage" => serde_json::to_value(
                    serde_json::from_value::<CommunityListPage>(wire.clone()).unwrap(),
                )
                .unwrap(),
                _ => serde_json::to_value(
                    serde_json::from_value::<CommunityListParams>(wire.clone()).unwrap(),
                )
                .unwrap(),
            };
            assert_eq!(round_trip, wire, "{key}");
        }
        // Plan 225 D15: the report's Community block, full and minimal.
        for key in ["reportCommunity", "minimalReportCommunity"] {
            let wire = fixture[key].clone();
            let block: crate::protocol::CohostReportCommunity =
                serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(&block).unwrap(), wire, "{key}");
        }
        let state: CohostState = serde_json::from_value(fixture["state"].clone()).unwrap();
        assert_eq!(state.welcome_back.len(), 1);
        assert_eq!(state.link_made.len(), 1);
        assert_eq!(serde_json::to_value(&state).unwrap(), fixture["state"]);
        // An empty lane is omitted, never `[]` or `null`.
        let off = serde_json::to_value(CohostState::off()).unwrap();
        assert!(off.get("welcomeBack").is_none());
        assert!(off.get("linkMade").is_none());
        for key in [
            "arrivalRow",
            "plainRow",
            "minimalArrival",
            "settings",
            "summary",
            "person",
            "unknownPerson",
            "listPage",
            "listParams",
        ] {
            no_nulls(&fixture[key], key);
        }
        // The state's own nullable fields (`reason`, `detail`, `nextTickAt`)
        // predate this plan; the new lanes never carry a null.
        no_nulls(&fixture["state"]["welcomeBack"], "state/welcomeBack");
        no_nulls(&fixture["state"]["linkMade"], "state/linkMade");
        // The rejected shapes never parse here either: a null optional, an
        // unknown milestone kind, an unknown status.
        for bad in fixture["rejected"]["arrivals"].as_array().unwrap() {
            if bad.get("extra").is_some() {
                // Rust ignores unknown fields on a chat row; the renderer's
                // strict schema refuses them.
                continue;
            }
            if bad.get("milestone").is_some_and(|m| m.is_object())
                || bad.get("platforms").is_some_and(|p| p.is_null())
            {
                // An unknown milestone kind, or `null` where a list goes:
                // refused on both sides.
                assert!(serde_json::from_value::<ViewerArrival>(bad.clone()).is_err());
            } else {
                // `null` reads as absent on the way in (serde default), and
                // never goes back out as null.
                let parsed: ViewerArrival = serde_json::from_value(bad.clone()).unwrap();
                no_nulls(&serde_json::to_value(parsed).unwrap(), "rejected arrival");
            }
        }
        assert!(
            serde_json::from_value::<CommunityPerson>(fixture["rejected"]["people"][0].clone())
                .is_err()
        );
        for bad in fixture["rejected"]["linkMade"].as_array().unwrap() {
            assert!(serde_json::from_value::<CohostLinkMade>(bad.clone()).is_err());
        }
    }

    #[test]
    fn settings_default_on_with_the_threshold_clamped() {
        let settings = CommunitySettings::default();
        assert!(settings.enabled && settings.welcome_on_stream);
        assert!(!settings.milestone_cards && !settings.remember && !settings.sync);
        assert_eq!(settings.regular_streams, 3);
        let parsed: CommunitySettings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(parsed, settings);
        let wide: CommunitySettings =
            serde_json::from_value(serde_json::json!({ "regularStreams": 99 })).unwrap();
        assert_eq!(wide.normalized().regular_streams, 10);
        let narrow: CommunitySettings =
            serde_json::from_value(serde_json::json!({ "regularStreams": 0 })).unwrap();
        assert_eq!(narrow.normalized().regular_streams, 2);
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            serde_json::json!({
                "enabled": true,
                "regularStreams": 3,
                "welcomeOnStream": true,
                "milestoneCards": false,
                "remember": false,
                "rememberOffered": false,
                "sync": false
            })
        );
        let _ = at("2026-11-08T00:00:00Z");
    }

    #[test]
    fn the_report_block_counts_regulars_comebacks_milestones_and_names_the_top_ten() {
        let arrival = |streams: u32, regular: bool| ViewerArrival {
            streams,
            regular,
            away_days: None,
            in_a_row: 1,
            milestone: None,
            platforms: Vec::new(),
            since: None,
            memories: Vec::new(),
            note: None,
        };
        let mut arrivals: Vec<ReportArrival> = (0..12)
            .map(|index| ReportArrival {
                account_key: format!("twitch:r{index:02}"),
                name: format!("R{index:02}"),
                platform: StreamPlatform::Twitch,
                arrival: arrival(3 + index, true),
            })
            .collect();
        arrivals.push(ReportArrival {
            account_key: "kick:bo".to_string(),
            name: "Bo".to_string(),
            platform: StreamPlatform::Kick,
            arrival: ViewerArrival {
                away_days: Some(21 + 9),
                ..arrival(2, false)
            },
        });
        arrivals.push(ReportArrival {
            account_key: "youtube:kim".to_string(),
            name: "Kim".to_string(),
            platform: StreamPlatform::Youtube,
            arrival: ViewerArrival {
                milestone: Some(ViewerMilestone {
                    kind: ViewerMilestoneKind::Streams,
                    value: 10,
                }),
                platforms: vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
                ..arrival(10, true)
            },
        });
        let block = report_community(&arrivals, 5, 3, 1, 2, 3);
        assert_eq!(block.regulars_back, 13);
        // R00 has exactly 3 streams: a regular with this stream.
        assert_eq!(block.new_regulars, 1);
        assert_eq!(block.comebacks, 1);
        assert_eq!((block.first_timers, block.first_timers_stayed), (5, 3));
        assert_eq!((block.links_made, block.opt_outs), (1, 2));
        assert_eq!(block.regulars.len(), 10);
        assert_eq!(block.regulars[0].name, "R11");
        assert!(block.regulars.iter().any(|person| person.name == "Kim"
            && person.platforms == vec![StreamPlatform::Twitch, StreamPlatform::Youtube]));
        assert_eq!(block.milestones.len(), 1);
        assert_eq!(block.milestones[0].name, "Kim");
        assert!(block.summary.is_none());
        // Nothing at all: an empty block, which the report omits.
        assert!(report_community(&[], 0, 0, 0, 0, 3).is_empty());
    }
}
