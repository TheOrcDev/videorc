//! The community store (plan 225): local SQLite, the truth (D5).
//!
//! Tables per the plan's Wire shape (`CREATE TABLE IF NOT EXISTS`, no foreign
//! keys to `sessions`: community data outlives recordings, D3). Every count a
//! person shows is computed over the union of its live accounts' attendance
//! (D1), so a link or a split restores both sides exactly (D4). A forgotten
//! account keeps only its key, platform, author id and status (D13): a
//! tombstone the store never learns again.
//!
//! Every method here takes the connection lock for one short transaction and
//! is called off the async runtime (`spawn_blocking`), never inside a chat
//! delivery fence (D14).

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::cohost::truncate_utf16;
use crate::cohost_greetings::is_known_bot;
use crate::community::{
    CommunityAccount, CommunityBackfill, CommunityBackfillState, CommunityLinkEvent,
    CommunityLinkKind, CommunityListFilter, CommunityListPage, CommunityListParams,
    CommunityListSort, CommunityMemory, CommunityPerson, CommunityPersonParams, CommunityPersonRow,
    CommunityPersonStatus, CommunitySuggestion, CommunitySuggestionReason, CommunitySummary,
    CommunitySupport, KnownStream, LIST_LIMIT_MAX, NOTE_MAX_CHARS, OTHER_RETENTION_DAYS,
    PersonHistory, REGULAR_WINDOW_DAYS, VIEWER_MEMORIES_MAX, ViewerArrival, ViewerMilestone,
    YOUTUBE_RETENTION_DAYS, account_key, arrival_facts, away_days, in_a_row, is_regular,
    platform_has_identity, suggestion_name_key,
};
use crate::live_chat::{LiveChatEventDetails, LiveChatEventType, LiveChatMessage};
use crate::storage::Database;
use crate::streaming::{StreamPlatform, stream_platform_from_id, stream_platform_id};

/// `app_settings` keys: the backfill marker (A3) and the last prune (A4).
pub const BACKFILL_SETTING_KEY: &str = "communityBackfill";
pub const PRUNED_AT_SETTING_KEY: &str = "communityPrunedAt";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommunityError {
    #[error("No such person.")]
    NotFound,
    #[error("X viewers link themselves with !link.")]
    XSelfLinkOnly,
    #[error("{0}")]
    Invalid(String),
    #[error("The community store failed: {0}")]
    Storage(String),
}

impl CommunityError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::XSelfLinkOnly => crate::community::X_SELF_LINK_ONLY,
            Self::Invalid(_) => "invalid-params",
            Self::Storage(_) => "storage",
        }
    }
}

impl From<anyhow::Error> for CommunityError {
    fn from(error: anyhow::Error) -> Self {
        Self::Storage(format!("{error:#}"))
    }
}

impl From<rusqlite::Error> for CommunityError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

/// The backfill marker in `app_settings` (A3): resumable by cursor, done
/// once, with the counts the Community header shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackfillProgress {
    #[serde(default)]
    pub done: bool,
    /// `"<started_at>|<session_id>"` of the last session folded in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub sessions_done: u32,
    #[serde(default)]
    pub sessions_total: u32,
}

impl BackfillProgress {
    pub fn wire(&self, running: bool) -> CommunityBackfill {
        CommunityBackfill {
            state: if self.done {
                CommunityBackfillState::Done
            } else if running {
                CommunityBackfillState::Running
            } else {
                CommunityBackfillState::Idle
            },
            done: self.sessions_done,
            total: self.sessions_total,
        }
    }
}

/// What one delivered chat row tells the store (B1): the account's latest
/// name and avatar, whether it counts as attendance (chat and paid only,
/// D1), its support (Activity rows), and the milestone to mark celebrated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityRowFacts {
    pub session_id: String,
    pub platform: StreamPlatform,
    pub author_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub at: DateTime<Utc>,
    pub counts: bool,
    pub support: CommunitySupport,
    pub celebrate: Option<ViewerMilestone>,
}

impl CommunityRowFacts {
    pub fn key(&self) -> String {
        account_key(self.platform, &self.author_id)
    }

    /// The facts of one chat row, or `None` for a row the store never
    /// counts: no author id, a platform without identity, a tombstone, a
    /// system row, or the streamer's own row.
    pub fn from_message(
        message: &LiveChatMessage,
        streamer_keys: &HashSet<String>,
    ) -> Option<Self> {
        let author_id = message.author_id.as_deref()?.trim();
        if author_id.is_empty()
            || !platform_has_identity(message.platform)
            || message.is_deleted
            || message.author_roles.iter().any(|role| {
                matches!(
                    role.trim().to_ascii_lowercase().as_str(),
                    "owner" | "broadcaster"
                )
            })
        {
            return None;
        }
        let key = account_key(message.platform, author_id);
        if streamer_keys.contains(&key) {
            return None;
        }
        let name = message.author_name.trim();
        if name.is_empty() {
            return None;
        }
        let at = DateTime::parse_from_rfc3339(&message.received_at)
            .map(|at| at.with_timezone(&Utc))
            .or_else(|_| {
                DateTime::parse_from_rfc3339(&message.published_at).map(|at| at.with_timezone(&Utc))
            })
            .ok()?;
        let counts = matches!(
            message.event_type,
            LiveChatEventType::Message | LiveChatEventType::Paid
        );
        Some(Self {
            session_id: message.session_id.clone(),
            platform: message.platform,
            author_id: author_id.to_string(),
            name: truncate_utf16(name, 120),
            avatar_url: message
                .author_avatar_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_string),
            at,
            counts,
            support: support_of(message),
            celebrate: message
                .arrival
                .as_ref()
                .and_then(|arrival| arrival.milestone),
        })
    }
}

/// Support totals from an Activity row (D2): bits, KICKs, gifted subs, sub
/// months, tips by currency. Never attendance.
fn support_of(message: &LiveChatMessage) -> CommunitySupport {
    let mut support = CommunitySupport::default();
    match &message.details {
        Some(LiveChatEventDetails::Cheer { bits }) => support.bits = *bits,
        Some(LiveChatEventDetails::Kicks { amount, .. }) => support.kicks = *amount,
        Some(LiveChatEventDetails::SuperChat {
            amount_micros,
            currency,
            ..
        })
        | Some(LiveChatEventDetails::SuperSticker {
            amount_micros,
            currency,
            ..
        }) => {
            support
                .tips
                .insert(currency.trim().to_ascii_uppercase(), *amount_micros);
        }
        Some(LiveChatEventDetails::Subscription {
            months, gift_count, ..
        }) => {
            support.gifted_subs = u64::from(gift_count.unwrap_or(0));
            support.sub_months =
                u64::from(months.unwrap_or(if gift_count.is_some() { 0 } else { 1 }));
        }
        Some(LiveChatEventDetails::Membership {
            months, gift_count, ..
        }) => {
            support.gifted_subs = u64::from(gift_count.unwrap_or(0));
            support.sub_months =
                u64::from(months.unwrap_or(if gift_count.is_some() { 0 } else { 1 }));
        }
        _ => {}
    }
    support
}

/// A queued memory pass (D10, F3): one per stream that ended with "Buddy
/// remembers" on, retried for a week.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityMemoryJob {
    pub session_id: String,
    pub created_at: DateTime<Utc>,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<DateTime<Utc>>,
}

/// One person of a memory pass, as the store knows them (D10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityMemoryPersonFacts {
    pub name: String,
    pub regular: bool,
    pub streams: u32,
    /// The live accounts: key and platform.
    pub accounts: Vec<(String, StreamPlatform)>,
    pub memories: Vec<CommunityMemory>,
    pub note: String,
}

/// Memories a pass may add per person, and keep in all (plan 183 D14).
pub const MEMORY_ADDS_MAX: usize = 2;
pub const MEMORY_PER_PERSON_MAX: usize = 8;

/// The arrival lookup's answer for one fresh account (B1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArrivalLookup {
    pub key: String,
    /// The person the account belongs to; `None` for an account the store
    /// has not met (a first-timer by local history).
    pub person_id: Option<String>,
    /// Set for a returning person; `None` for a first-timer, a bot, a
    /// forgotten account or the streamer.
    pub arrival: Option<ViewerArrival>,
    /// The person already arrived this stream on another account (F6): the
    /// row is neither a first chat nor a return, and earns no welcome.
    pub already_arrived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommunityWriteOutcome {
    /// Accounts the store met for the first time, by key and name.
    pub new_accounts: Vec<(String, String)>,
    pub suggestions_made: u32,
}

/// The export file (Export… / Import…, D5 and D12).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityExportFile {
    pub version: u32,
    pub exported_at: String,
    pub people: Vec<ExportPerson>,
    pub streams: Vec<ExportStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportPerson {
    pub id: String,
    pub note: String,
    pub status: String,
    pub support: CommunitySupport,
    pub milestones: Vec<String>,
    pub best_in_a_row: u32,
    pub updated_at: String,
    pub accounts: Vec<ExportAccount>,
    #[serde(default)]
    pub memories: Vec<CommunityMemory>,
    #[serde(default)]
    pub link_events: Vec<CommunityLinkEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportAccount {
    pub account_key: String,
    pub platform: String,
    pub author_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub status: String,
    pub updated_at: String,
    pub attendance: Vec<ExportAttendance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportAttendance {
    pub session_id: String,
    pub first_message_at: String,
    pub last_message_at: String,
    pub messages: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportStream {
    pub session_id: String,
    pub started_at: String,
    pub platforms: Vec<String>,
}

pub const EXPORT_VERSION: u32 = 1;

// --- Schema -------------------------------------------------------------------

pub(crate) fn create_community_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS community_people (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar_url TEXT,
            streams INTEGER NOT NULL DEFAULT 0,
            messages INTEGER NOT NULL DEFAULT 0,
            in_a_row INTEGER NOT NULL DEFAULT 0,
            best_in_a_row INTEGER NOT NULL DEFAULT 0,
            first_seen_at TEXT,
            last_seen_at TEXT,
            support_json TEXT NOT NULL DEFAULT '{}',
            milestones_json TEXT NOT NULL DEFAULT '[]',
            note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'normal',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_accounts (
            account_key TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            author_id TEXT NOT NULL,
            person_id TEXT NOT NULL,
            name TEXT NOT NULL,
            handle TEXT,
            avatar_url TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'normal',
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_community_accounts_person
            ON community_accounts(person_id);
        CREATE INDEX IF NOT EXISTS idx_community_accounts_platform_seen
            ON community_accounts(platform, last_seen_at);
        CREATE TABLE IF NOT EXISTS community_streams (
            session_id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            platforms_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_attendance (
            account_key TEXT NOT NULL,
            session_id TEXT NOT NULL,
            first_message_at TEXT NOT NULL,
            last_message_at TEXT NOT NULL,
            messages INTEGER NOT NULL,
            PRIMARY KEY (account_key, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_community_attendance_session
            ON community_attendance(session_id);
        CREATE TABLE IF NOT EXISTS community_link_events (
            id TEXT PRIMARY KEY,
            person_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_suggestions (
            account_a TEXT NOT NULL,
            account_b TEXT NOT NULL,
            reason TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL,
            PRIMARY KEY (account_a, account_b)
        );
        CREATE INDEX IF NOT EXISTS idx_community_suggestions_state
            ON community_suggestions(state);
        CREATE TABLE IF NOT EXISTS community_memories (
            id TEXT PRIMARY KEY,
            person_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            text TEXT NOT NULL,
            session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_community_memories_person
            ON community_memories(person_id);
        CREATE TABLE IF NOT EXISTS community_memory_jobs (
            session_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            last_attempt_at TEXT
        );",
    )?;
    // A store from before the memory pass (Phase A) lacks the column.
    let has_last_attempt = conn
        .prepare("PRAGMA table_info(community_memory_jobs)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "last_attempt_at");
    if !has_last_attempt {
        conn.execute(
            "ALTER TABLE community_memory_jobs ADD COLUMN last_attempt_at TEXT",
            [],
        )?;
    }
    Ok(())
}

// --- Row helpers ----------------------------------------------------------------

fn parse_at(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn platforms_json(platforms: &[StreamPlatform]) -> String {
    let ids: Vec<&str> = platforms.iter().map(|p| stream_platform_id(*p)).collect();
    serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
}

fn platforms_from_json(json: &str) -> Vec<StreamPlatform> {
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .iter()
        .filter_map(|id| stream_platform_from_id(id))
        .collect()
}

#[derive(Debug, Clone)]
struct AccountRow {
    account_key: String,
    platform: StreamPlatform,
    author_id: String,
    person_id: String,
    name: String,
    handle: Option<String>,
    avatar_url: Option<String>,
    first_seen_at: String,
    last_seen_at: String,
    status: CommunityPersonStatus,
}

impl AccountRow {
    fn wire(&self) -> CommunityAccount {
        CommunityAccount {
            account_key: self.account_key.clone(),
            platform: self.platform,
            author_id: self.author_id.clone(),
            name: self.name.clone(),
            handle: self.handle.clone(),
            avatar_url: self.avatar_url.clone(),
            first_seen_at: self.first_seen_at.clone(),
            last_seen_at: self.last_seen_at.clone(),
        }
    }
}

const ACCOUNT_COLUMNS: &str = "account_key, platform, author_id, person_id, name, handle, avatar_url, first_seen_at, last_seen_at, status";

fn account_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountRow> {
    let platform: String = row.get(1)?;
    let status: String = row.get(9)?;
    Ok(AccountRow {
        account_key: row.get(0)?,
        platform: stream_platform_from_id(&platform).unwrap_or(StreamPlatform::Custom),
        author_id: row.get(2)?,
        person_id: row.get(3)?,
        name: row.get(4)?,
        handle: row.get(5)?,
        avatar_url: row.get(6)?,
        first_seen_at: row.get(7)?,
        last_seen_at: row.get(8)?,
        status: CommunityPersonStatus::parse(&status),
    })
}

fn account_locked(conn: &Connection, key: &str) -> Result<Option<AccountRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ACCOUNT_COLUMNS} FROM community_accounts WHERE account_key = ?1"),
            params![key],
            account_from_row,
        )
        .optional()?)
}

/// The person's live accounts (never a tombstone).
fn live_accounts_locked(conn: &Connection, person_id: &str) -> Result<Vec<AccountRow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM community_accounts
         WHERE person_id = ?1 AND status != 'forgotten'
         ORDER BY first_seen_at ASC, account_key ASC"
    ))?;
    let rows = statement.query_map(params![person_id], account_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// One `IN (...)` per this many keys (F4): SQLite's bundled variable limit
/// is far above it, and a raid of 400 fresh authors stays at one read per
/// table.
const IN_CHUNK: usize = 500;

fn in_placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The accounts behind these keys, by key (F4: one query per chunk).
fn accounts_by_keys_locked(
    conn: &Connection,
    keys: &[String],
) -> Result<HashMap<String, AccountRow>> {
    let mut out = HashMap::with_capacity(keys.len());
    for chunk in keys.chunks(IN_CHUNK) {
        let mut statement = conn.prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM community_accounts WHERE account_key IN ({})",
            in_placeholders(chunk.len())
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), account_from_row)?;
        for row in rows {
            let row = row?;
            out.insert(row.account_key.clone(), row);
        }
    }
    Ok(out)
}

/// The live accounts of these people, by person (F4).
fn live_accounts_by_people_locked(
    conn: &Connection,
    person_ids: &[String],
) -> Result<HashMap<String, Vec<AccountRow>>> {
    let mut out: HashMap<String, Vec<AccountRow>> = HashMap::with_capacity(person_ids.len());
    for chunk in person_ids.chunks(IN_CHUNK) {
        let mut statement = conn.prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM community_accounts
             WHERE person_id IN ({}) AND status != 'forgotten'
             ORDER BY first_seen_at ASC, account_key ASC",
            in_placeholders(chunk.len())
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), account_from_row)?;
        for row in rows {
            let row = row?;
            out.entry(row.person_id.clone()).or_default().push(row);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
struct PersonRow {
    id: String,
    name: String,
    avatar_url: Option<String>,
    best_in_a_row: u32,
    support: CommunitySupport,
    milestones: Vec<String>,
    note: String,
    status: CommunityPersonStatus,
}

const PERSON_COLUMNS: &str =
    "id, name, avatar_url, best_in_a_row, support_json, milestones_json, note, status";

fn person_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersonRow> {
    let support_json: String = row.get(4)?;
    let milestones_json: String = row.get(5)?;
    let status: String = row.get(7)?;
    Ok(PersonRow {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar_url: row.get(2)?,
        best_in_a_row: row.get::<_, i64>(3)?.max(0) as u32,
        support: serde_json::from_str(&support_json).unwrap_or_default(),
        milestones: serde_json::from_str(&milestones_json).unwrap_or_default(),
        note: row.get(6)?,
        status: CommunityPersonStatus::parse(&status),
    })
}

fn person_locked(conn: &Connection, id: &str) -> Result<Option<PersonRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PERSON_COLUMNS} FROM community_people WHERE id = ?1"),
            params![id],
            person_from_row,
        )
        .optional()?)
}

/// The people behind these ids, by id (F4: one query per chunk).
fn people_by_ids_locked(
    conn: &Connection,
    person_ids: &[String],
) -> Result<HashMap<String, PersonRow>> {
    let mut out = HashMap::with_capacity(person_ids.len());
    for chunk in person_ids.chunks(IN_CHUNK) {
        let mut statement = conn.prepare(&format!(
            "SELECT {PERSON_COLUMNS} FROM community_people WHERE id IN ({})",
            in_placeholders(chunk.len())
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), person_from_row)?;
        for row in rows {
            let row = row?;
            out.insert(row.id.clone(), row);
        }
    }
    Ok(out)
}

fn known_streams_locked(conn: &Connection) -> Result<Vec<KnownStream>> {
    let mut statement =
        conn.prepare("SELECT session_id, started_at, platforms_json FROM community_streams")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut streams = Vec::new();
    for row in rows {
        let (session_id, started_at, platforms) = row?;
        let Some(started_at) = parse_at(&started_at) else {
            continue;
        };
        streams.push(KnownStream {
            session_id,
            started_at,
            platforms: platforms_from_json(&platforms),
        });
    }
    Ok(streams)
}

/// Everything the rules need about a person: its live accounts' platforms,
/// the streams they chatted in (joined to `community_streams` for the start
/// time; an attendance row whose stream is unknown uses its own first
/// message time), messages, first and last chat, celebrated milestones.
fn person_history_locked(conn: &Connection, person: &PersonRow) -> Result<PersonHistory> {
    Ok(histories_locked(conn, &[person])?
        .remove(&person.id)
        .unwrap_or_default())
}

/// [`person_history_locked`] for many people at once (F4): one read of the
/// live accounts and one of the attendance, whatever the count. Every
/// person given gets an entry.
fn histories_locked(
    conn: &Connection,
    people: &[&PersonRow],
) -> Result<HashMap<String, PersonHistory>> {
    let ids: Vec<String> = people.iter().map(|person| person.id.clone()).collect();
    let mut accounts = live_accounts_by_people_locked(conn, &ids)?;
    let mut histories: HashMap<String, PersonHistory> = HashMap::with_capacity(people.len());
    for person in people {
        let accounts = accounts.remove(&person.id).unwrap_or_default();
        let mut history = PersonHistory {
            platforms: accounts.iter().map(|account| account.platform).collect(),
            celebrated: person.milestones.clone(),
            ..Default::default()
        };
        history
            .platforms
            .sort_by_key(|platform| stream_platform_id(*platform));
        history.platforms.dedup();
        histories.insert(person.id.clone(), history);
    }
    for chunk in ids.chunks(IN_CHUNK) {
        let mut statement = conn.prepare(&format!(
            "SELECT a.person_id, t.session_id, t.first_message_at, t.last_message_at, t.messages, s.started_at
             FROM community_attendance t
             JOIN community_accounts a ON a.account_key = t.account_key
             LEFT JOIN community_streams s ON s.session_id = t.session_id
             WHERE a.person_id IN ({}) AND a.status != 'forgotten'",
            in_placeholders(chunk.len())
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (person_id, session_id, first, last, messages, started_at) = row?;
            let Some(history) = histories.get_mut(&person_id) else {
                continue;
            };
            let first_at = parse_at(&first);
            let last_at = parse_at(&last);
            let started = started_at.as_deref().and_then(parse_at).or(first_at);
            if let Some(started) = started {
                history.attended.push((session_id, started));
            }
            history.messages = history.messages.saturating_add(messages.max(0) as u64);
            if let Some(first_at) = first_at {
                history.first_seen_at = Some(
                    history
                        .first_seen_at
                        .map_or(first_at, |seen| seen.min(first_at)),
                );
            }
            if let Some(last_at) = last_at {
                history.last_seen_at = Some(
                    history
                        .last_seen_at
                        .map_or(last_at, |seen| seen.max(last_at)),
                );
            }
        }
    }
    Ok(histories)
}

/// The memories of these people, by person, newest first (F4: one read).
fn memories_by_people_locked(
    conn: &Connection,
    person_ids: &[String],
) -> Result<HashMap<String, Vec<CommunityMemory>>> {
    let mut out: HashMap<String, Vec<CommunityMemory>> = HashMap::with_capacity(person_ids.len());
    for chunk in person_ids.chunks(IN_CHUNK) {
        let mut statement = conn.prepare(&format!(
            "SELECT person_id, id, account_key, text, session_id, created_at, updated_at
             FROM community_memories WHERE person_id IN ({})
             ORDER BY updated_at DESC, id ASC",
            in_placeholders(chunk.len())
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                CommunityMemory {
                    id: row.get(1)?,
                    account_key: row.get(2)?,
                    text: row.get(3)?,
                    session_id: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                },
            ))
        })?;
        for row in rows {
            let (person_id, memory) = row?;
            out.entry(person_id).or_default().push(memory);
        }
    }
    Ok(out)
}

/// Recompute a person's stored counts and newest name from its accounts
/// and attendance (D1, D2). A person with no live account left is deleted
/// with its memories, note and link events (F2: a forgotten person leaves
/// no trace; the kept side of a split keeps its own events).
fn refresh_person_locked(conn: &Connection, person_id: &str) -> Result<()> {
    let Some(person) = person_locked(conn, person_id)? else {
        return Ok(());
    };
    let accounts = live_accounts_locked(conn, person_id)?;
    if accounts.is_empty() {
        delete_person_locked(conn, person_id)?;
        return Ok(());
    }
    let history = person_history_locked(conn, &person)?;
    let streams = known_streams_locked(conn)?;
    let run = in_a_row(&history, &streams);
    let newest = accounts
        .iter()
        .max_by(|a, b| a.last_seen_at.cmp(&b.last_seen_at))
        .unwrap_or(&accounts[0]);
    conn.execute(
        "UPDATE community_people SET name = ?2, avatar_url = ?3, streams = ?4, messages = ?5,
            in_a_row = ?6, best_in_a_row = MAX(best_in_a_row, ?6), first_seen_at = ?7,
            last_seen_at = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            person_id,
            newest.name,
            newest.avatar_url,
            i64::from(history.streams()),
            i64::try_from(history.messages).unwrap_or(i64::MAX),
            i64::from(run),
            history.first_seen_at.map(iso),
            history.last_seen_at.map(iso),
            iso(Utc::now()),
        ],
    )?;
    Ok(())
}

fn delete_person_locked(conn: &Connection, person_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM community_memories WHERE person_id = ?1",
        params![person_id],
    )?;
    conn.execute(
        "DELETE FROM community_link_events WHERE person_id = ?1",
        params![person_id],
    )?;
    conn.execute(
        "DELETE FROM community_people WHERE id = ?1",
        params![person_id],
    )?;
    Ok(())
}

/// F2: take forgotten names out of past Buddy reports' Community blocks
/// (the regulars named and the milestones celebrated). `gone` lists
/// `(name, platform)` pairs; `None` scrubs every name ("Forget
/// everyone"). The counts stay: the report counts opt-outs, never names
/// them (D13). Returns how many reports changed.
fn scrub_report_names_locked(
    conn: &Connection,
    gone: Option<&[(String, StreamPlatform)]>,
    now: DateTime<Utc>,
) -> Result<u32> {
    let mut statement = conn.prepare("SELECT session_id, report_json FROM cohost_reports")?;
    let rows: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let matches = |name: &str, platform: StreamPlatform| match gone {
        None => true,
        Some(gone) => gone
            .iter()
            .any(|(gone_name, gone_platform)| *gone_platform == platform && gone_name == name),
    };
    let mut scrubbed = 0u32;
    for (session_id, json) in rows {
        let Some(mut report) = crate::protocol::CohostSessionReport::from_stored_json(&json)
        else {
            continue;
        };
        let Some(community) = report.community.as_mut() else {
            continue;
        };
        let before = (community.regulars.len(), community.milestones.len());
        community
            .regulars
            .retain(|person| !matches(&person.name, person.platform));
        community
            .milestones
            .retain(|milestone| !matches(&milestone.name, milestone.platform));
        if before == (community.regulars.len(), community.milestones.len()) {
            continue;
        }
        conn.execute(
            "UPDATE cohost_reports SET report_json = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, serde_json::to_string(&report)?, iso(now)],
        )?;
        scrubbed = scrubbed.saturating_add(1);
    }
    Ok(scrubbed)
}

fn insert_person_locked(
    conn: &Connection,
    name: &str,
    avatar_url: Option<&str>,
    status: CommunityPersonStatus,
    now: DateTime<Utc>,
) -> Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO community_people (id, name, avatar_url, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, avatar_url, status.as_str(), iso(now)],
    )?;
    Ok(id)
}

fn insert_link_event_locked(
    conn: &Connection,
    person_id: &str,
    account_key: &str,
    kind: CommunityLinkKind,
    now: DateTime<Utc>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO community_link_events (id, person_id, account_key, kind, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_id(), person_id, account_key, kind.as_str(), iso(now)],
    )?;
    Ok(())
}

/// "Might be the same person" (D4 c): a new account with the same folded
/// name as an account on another platform, neither on X, different
/// people, not dismissed before. Returns how many were opened.
fn suggest_for_account_locked(
    conn: &Connection,
    account: &AccountRow,
    now: DateTime<Utc>,
) -> Result<u32> {
    if account.platform == StreamPlatform::X {
        return Ok(0);
    }
    let Some(wanted) = suggestion_name_key(&account.name) else {
        return Ok(0);
    };
    let mut statement = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM community_accounts
         WHERE platform != ?1 AND platform != 'x' AND person_id != ?2 AND status != 'forgotten'"
    ))?;
    let rows = statement.query_map(
        params![stream_platform_id(account.platform), account.person_id],
        account_from_row,
    )?;
    let mut made = 0;
    for other in rows {
        let other = other?;
        if suggestion_name_key(&other.name).as_deref() != Some(wanted.as_str()) {
            continue;
        }
        let (a, b) = ordered_pair(&account.account_key, &other.account_key);
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO community_suggestions (account_a, account_b, reason, state, created_at)
             VALUES (?1, ?2, 'name', 'open', ?3)",
            params![a, b, iso(now)],
        )?;
        made += u32::try_from(inserted).unwrap_or(0);
    }
    Ok(made)
}

fn ordered_pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Move every live account of `from` into `into` (D4): memories follow
/// their account, support and milestones merge, the older note stays.
fn merge_people_locked(
    conn: &Connection,
    into: &str,
    from: &str,
    kind: CommunityLinkKind,
    now: DateTime<Utc>,
) -> Result<()> {
    let Some(kept) = person_locked(conn, into)? else {
        return Err(anyhow::anyhow!("no such person"));
    };
    let Some(gone) = person_locked(conn, from)? else {
        return Err(anyhow::anyhow!("no such person"));
    };
    let moved = live_accounts_locked(conn, from)?;
    for account in &moved {
        conn.execute(
            "UPDATE community_accounts SET person_id = ?2, updated_at = ?3 WHERE account_key = ?1",
            params![account.account_key, into, iso(now)],
        )?;
        insert_link_event_locked(conn, into, &account.account_key, kind, now)?;
    }
    conn.execute(
        "UPDATE community_accounts SET person_id = ?2 WHERE person_id = ?1",
        params![from, into],
    )?;
    conn.execute(
        "UPDATE community_memories SET person_id = ?2, updated_at = ?3 WHERE person_id = ?1",
        params![from, into, iso(now)],
    )?;
    conn.execute(
        "UPDATE community_link_events SET person_id = ?2 WHERE person_id = ?1",
        params![from, into],
    )?;
    let mut support = kept.support.clone();
    support.add(&gone.support);
    let mut milestones = kept.milestones.clone();
    for key in gone.milestones {
        if !milestones.contains(&key) {
            milestones.push(key);
        }
    }
    let note = if kept.note.trim().is_empty() {
        gone.note
    } else {
        kept.note
    };
    let status =
        if kept.status == CommunityPersonStatus::Bot || gone.status == CommunityPersonStatus::Bot {
            CommunityPersonStatus::Bot
        } else {
            CommunityPersonStatus::Normal
        };
    conn.execute(
        "UPDATE community_people SET support_json = ?2, milestones_json = ?3, note = ?4,
            best_in_a_row = MAX(best_in_a_row, ?5), status = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            into,
            serde_json::to_string(&support)?,
            serde_json::to_string(&milestones)?,
            note,
            i64::from(gone.best_in_a_row),
            status.as_str(),
            iso(now),
        ],
    )?;
    // Suggestions between the two sides are settled.
    let keys: Vec<String> = live_accounts_locked(conn, into)?
        .into_iter()
        .map(|account| account.account_key)
        .collect();
    for a in &keys {
        for b in &keys {
            if a < b {
                conn.execute(
                    "UPDATE community_suggestions SET state = 'dismissed'
                     WHERE account_a = ?1 AND account_b = ?2",
                    params![a, b],
                )?;
            }
        }
    }
    conn.execute("DELETE FROM community_people WHERE id = ?1", params![from])?;
    refresh_person_locked(conn, into)?;
    Ok(())
}

/// The older person (by first chat) keeps the note and the id (D4).
fn older_first_locked(conn: &Connection, a: &str, b: &str) -> Result<(String, String)> {
    let first = |id: &str| -> Result<String> {
        Ok(conn
            .query_row(
                "SELECT MIN(first_seen_at) FROM community_accounts WHERE person_id = ?1 AND status != 'forgotten'",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .unwrap_or_default())
    };
    let (first_a, first_b) = (first(a)?, first(b)?);
    if first_a <= first_b {
        Ok((a.to_string(), b.to_string()))
    } else {
        Ok((b.to_string(), a.to_string()))
    }
}

fn memories_locked(conn: &Connection, person_id: &str) -> Result<Vec<CommunityMemory>> {
    let mut statement = conn.prepare(
        "SELECT id, account_key, text, session_id, created_at, updated_at
         FROM community_memories WHERE person_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![person_id], |row| {
        Ok(CommunityMemory {
            id: row.get(0)?,
            account_key: row.get(1)?,
            text: row.get(2)?,
            session_id: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn link_events_locked(conn: &Connection, person_id: &str) -> Result<Vec<CommunityLinkEvent>> {
    let mut statement = conn.prepare(
        "SELECT id, account_key, kind, at FROM community_link_events
         WHERE person_id = ?1 ORDER BY at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![person_id], |row| {
        let kind: String = row.get(2)?;
        Ok(CommunityLinkEvent {
            id: row.get(0)?,
            account_key: row.get(1)?,
            kind: CommunityLinkKind::parse(&kind),
            at: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn open_suggestions_locked(
    conn: &Connection,
    keys: Option<&[String]>,
) -> Result<Vec<CommunitySuggestion>> {
    let mut statement = conn.prepare(
        "SELECT account_a, account_b, reason, created_at FROM community_suggestions
         WHERE state = 'open' ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        let reason: String = row.get(2)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            CommunitySuggestionReason::parse(&reason),
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (a, b, reason, created_at) = row?;
        if let Some(keys) = keys
            && !keys.contains(&a)
            && !keys.contains(&b)
        {
            continue;
        }
        let (Some(account_a), Some(account_b)) =
            (account_locked(conn, &a)?, account_locked(conn, &b)?)
        else {
            // One side is gone (forgotten, pruned): the suggestion is moot.
            conn.execute(
                "UPDATE community_suggestions SET state = 'dismissed' WHERE account_a = ?1 AND account_b = ?2",
                params![a, b],
            )?;
            continue;
        };
        if account_a.status == CommunityPersonStatus::Forgotten
            || account_b.status == CommunityPersonStatus::Forgotten
            || account_a.person_id == account_b.person_id
        {
            conn.execute(
                "UPDATE community_suggestions SET state = 'dismissed' WHERE account_a = ?1 AND account_b = ?2",
                params![a, b],
            )?;
            continue;
        }
        out.push(CommunitySuggestion {
            account_a: account_a.wire(),
            account_b: account_b.wire(),
            reason,
            created_at,
        });
    }
    Ok(out)
}

fn person_wire_locked(
    conn: &Connection,
    person: &PersonRow,
    now: DateTime<Utc>,
    threshold: u32,
) -> Result<CommunityPerson> {
    let accounts = live_accounts_locked(conn, &person.id)?;
    let history = person_history_locked(conn, person)?;
    let streams = known_streams_locked(conn)?;
    let keys: Vec<String> = accounts.iter().map(|a| a.account_key.clone()).collect();
    Ok(CommunityPerson {
        id: person.id.clone(),
        name: person.name.clone(),
        avatar_url: person.avatar_url.clone(),
        youtube: accounts
            .iter()
            .any(|account| account.platform == StreamPlatform::Youtube),
        accounts: accounts.iter().map(AccountRow::wire).collect(),
        streams: history.streams(),
        messages: history.messages,
        in_a_row: in_a_row(&history, &streams),
        best_in_a_row: person.best_in_a_row,
        regular: is_regular(&history, now, threshold),
        away_days: away_days(&history, now),
        first_seen_at: history.first_seen_at.map(iso),
        last_seen_at: history.last_seen_at.map(iso),
        support: person.support.clone(),
        milestones: person.milestones.clone(),
        note: person.note.clone(),
        status: person.status,
        memories: memories_locked(conn, &person.id)?,
        suggestions: open_suggestions_locked(conn, Some(&keys))?,
        link_events: link_events_locked(conn, &person.id)?,
    })
}

// --- The store ------------------------------------------------------------------

impl Database {
    /// The streamer's own account keys (D1): `platform:account_id` of every
    /// connected platform account.
    pub fn community_streamer_keys(&self) -> Result<HashSet<String>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare("SELECT platform, account_id FROM platform_accounts")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut keys = HashSet::new();
        for row in rows {
            let (platform, account_id) = row?;
            if let Some(platform) = stream_platform_from_id(&platform) {
                keys.insert(account_key(platform, account_id.trim()));
            }
        }
        Ok(keys)
    }

    /// A stream the store knows (B1, session start): when it started and
    /// the platforms it reached. A second call adds platforms.
    pub fn community_record_stream(
        &self,
        session_id: &str,
        started_at: DateTime<Utc>,
        platforms: &[StreamPlatform],
    ) -> Result<()> {
        let conn = self.lock()?;
        let mut reached: Vec<StreamPlatform> = platforms
            .iter()
            .copied()
            .filter(|platform| platform_has_identity(*platform))
            .collect();
        if let Some(existing) = conn
            .query_row(
                "SELECT platforms_json FROM community_streams WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            reached.extend(platforms_from_json(&existing));
        }
        reached.sort_by_key(|platform| stream_platform_id(*platform));
        reached.dedup();
        conn.execute(
            "INSERT INTO community_streams (session_id, started_at, platforms_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET platforms_json = excluded.platforms_json",
            params![session_id, iso(started_at), platforms_json(&reached)],
        )?;
        Ok(())
    }

    /// The arrival facts of fresh authors (B1, D14): one read per table for
    /// the whole batch, off the runtime (F4: a raid of 400 fresh authors
    /// costs five statements, not five per author). A returning person gets
    /// `arrival`; a first-timer, a bot, a forgotten account or the streamer
    /// gets none. `arrived` holds the people already given an arrival this
    /// stream, so a two-account person gets one whichever account chats
    /// first. `streams` caches the known streams for the session: filled
    /// here on first use, kept by the caller.
    #[allow(clippy::too_many_arguments)]
    pub fn community_lookup_arrivals(
        &self,
        session_id: &str,
        authors: &[(StreamPlatform, String)],
        streamer_keys: &HashSet<String>,
        arrived: &mut HashSet<String>,
        streams: &mut Option<Vec<KnownStream>>,
        now: DateTime<Utc>,
        threshold: u32,
        remember: bool,
    ) -> Result<Vec<ArrivalLookup>> {
        let conn = self.lock()?;
        let streams: &Vec<KnownStream> = match streams {
            Some(streams) => streams,
            None => streams.insert(known_streams_locked(&conn)?),
        };
        let mut wanted: Vec<String> = Vec::with_capacity(authors.len());
        let mut seen: HashSet<String> = HashSet::with_capacity(authors.len());
        for (platform, author_id) in authors {
            if !platform_has_identity(*platform) {
                continue;
            }
            let key = account_key(*platform, author_id);
            if streamer_keys.contains(&key) || !seen.insert(key.clone()) {
                continue;
            }
            wanted.push(key);
        }
        let accounts = accounts_by_keys_locked(&conn, &wanted)?;
        let person_ids: Vec<String> = accounts
            .values()
            .filter(|account| account.status != CommunityPersonStatus::Forgotten)
            .map(|account| account.person_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let people = people_by_ids_locked(&conn, &person_ids)?;
        // Only the people who may arrive need their history.
        let candidates: Vec<&PersonRow> = people
            .values()
            .filter(|person| {
                person.status == CommunityPersonStatus::Normal && !arrived.contains(&person.id)
            })
            .collect();
        let histories = histories_locked(&conn, &candidates)?;
        let mut memories = if remember {
            let ids: Vec<String> = candidates.iter().map(|person| person.id.clone()).collect();
            memories_by_people_locked(&conn, &ids)?
        } else {
            HashMap::new()
        };
        let current_started_at = streams
            .iter()
            .find(|stream| stream.session_id == session_id)
            .map(|stream| stream.started_at);
        let mut out = Vec::with_capacity(authors.len());
        for (platform, author_id) in authors {
            let key = account_key(*platform, author_id);
            let mut lookup = ArrivalLookup {
                key: key.clone(),
                person_id: None,
                arrival: None,
                already_arrived: false,
            };
            if !platform_has_identity(*platform) || streamer_keys.contains(&key) {
                out.push(lookup);
                continue;
            }
            let Some(account) = accounts.get(&key) else {
                out.push(lookup);
                continue;
            };
            lookup.person_id = Some(account.person_id.clone());
            if account.status == CommunityPersonStatus::Forgotten {
                out.push(lookup);
                continue;
            }
            let Some(person) = people.get(&account.person_id) else {
                out.push(lookup);
                continue;
            };
            if person.status != CommunityPersonStatus::Normal {
                out.push(lookup);
                continue;
            }
            if !arrived.insert(person.id.clone()) {
                lookup.already_arrived = true;
                out.push(lookup);
                continue;
            }
            let Some(before) = histories.get(&person.id) else {
                out.push(lookup);
                continue;
            };
            let earlier: Vec<&(String, DateTime<Utc>)> = before
                .attended
                .iter()
                .filter(|(id, _)| id != session_id)
                .collect();
            if earlier.is_empty() {
                // Met, but never chatted before this stream: a first-timer.
                out.push(lookup);
                continue;
            }
            let mut with_current = before.clone();
            if !with_current.attended.iter().any(|(id, _)| id == session_id) {
                with_current
                    .attended
                    .push((session_id.to_string(), current_started_at.unwrap_or(now)));
            }
            let run = if current_started_at.is_some() {
                in_a_row(&with_current, streams)
            } else {
                let mut streams_with_current = streams.clone();
                streams_with_current.push(KnownStream {
                    session_id: session_id.to_string(),
                    started_at: now,
                    platforms: with_current.platforms.clone(),
                });
                in_a_row(&with_current, &streams_with_current)
            };
            let streams_count = with_current.streams();
            // Regular and milestones count this stream; Back and "since"
            // read the history before it.
            let mut facts = arrival_facts(&with_current, streams_count, run, now, threshold);
            facts.away_days = away_days(before, now);
            if remember {
                // D10: with "Buddy remembers" on, the newest memories and
                // the streamer's note ride the arrival for one delivery
                // (never the wire), so the greet and the tick can use them.
                facts.memories = memories
                    .remove(&person.id)
                    .unwrap_or_default()
                    .into_iter()
                    .take(VIEWER_MEMORIES_MAX)
                    .map(|memory| memory.text)
                    .collect();
                let note = person.note.trim();
                facts.note = (!note.is_empty()).then(|| note.to_string());
            }
            lookup.arrival = Some(facts);
            out.push(lookup);
        }
        Ok(out)
    }

    /// One write transaction per delivered batch (B1, D14): accounts and
    /// people met or refreshed, attendance counted, support added, the
    /// celebrated milestone marked, suggestions opened for new accounts.
    pub fn community_record_batch(
        &self,
        rows: &[CommunityRowFacts],
        now: DateTime<Utc>,
    ) -> Result<CommunityWriteOutcome> {
        let mut outcome = CommunityWriteOutcome::default();
        if rows.is_empty() {
            return Ok(outcome);
        }
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let mut touched: Vec<String> = Vec::new();
        for row in rows {
            let key = row.key();
            let account = match account_locked(&transaction, &key)? {
                Some(account) if account.status == CommunityPersonStatus::Forgotten => continue,
                Some(account) => {
                    transaction.execute(
                        "UPDATE community_accounts SET name = ?2, avatar_url = COALESCE(?3, avatar_url),
                            last_seen_at = MAX(last_seen_at, ?4), updated_at = ?5
                         WHERE account_key = ?1",
                        params![key, row.name, row.avatar_url, iso(row.at), iso(now)],
                    )?;
                    account
                }
                None => {
                    let status = if is_known_bot(&row.name) {
                        CommunityPersonStatus::Bot
                    } else {
                        CommunityPersonStatus::Normal
                    };
                    let person_id = insert_person_locked(
                        &transaction,
                        &row.name,
                        row.avatar_url.as_deref(),
                        status,
                        now,
                    )?;
                    transaction.execute(
                        "INSERT INTO community_accounts (account_key, platform, author_id, person_id, name,
                            handle, avatar_url, first_seen_at, last_seen_at, status, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?7, 'normal', ?8)",
                        params![
                            key,
                            stream_platform_id(row.platform),
                            row.author_id,
                            person_id,
                            row.name,
                            row.avatar_url,
                            iso(row.at),
                            iso(now),
                        ],
                    )?;
                    outcome.new_accounts.push((key.clone(), row.name.clone()));
                    let account = account_locked(&transaction, &key)?
                        .context("the account just inserted is missing")?;
                    outcome.suggestions_made +=
                        suggest_for_account_locked(&transaction, &account, now)?;
                    account
                }
            };
            if row.counts {
                transaction.execute(
                    "INSERT INTO community_attendance (account_key, session_id, first_message_at, last_message_at, messages)
                     VALUES (?1, ?2, ?3, ?3, 1)
                     ON CONFLICT(account_key, session_id) DO UPDATE SET
                        first_message_at = MIN(first_message_at, excluded.first_message_at),
                        last_message_at = MAX(last_message_at, excluded.last_message_at),
                        messages = messages + 1",
                    params![key, row.session_id, iso(row.at)],
                )?;
            }
            if (!row.support.is_empty() || row.celebrate.is_some())
                && let Some(person) = person_locked(&transaction, &account.person_id)?
            {
                let mut support = person.support.clone();
                support.add(&row.support);
                let mut milestones = person.milestones.clone();
                if let Some(milestone) = row.celebrate {
                    let key = milestone.key();
                    if !milestones.contains(&key) {
                        milestones.push(key);
                    }
                }
                transaction.execute(
                        "UPDATE community_people SET support_json = ?2, milestones_json = ?3, updated_at = ?4 WHERE id = ?1",
                        params![
                            person.id,
                            serde_json::to_string(&support)?,
                            serde_json::to_string(&milestones)?,
                            iso(now)
                        ],
                    )?;
            }
            if !touched.contains(&account.person_id) {
                touched.push(account.person_id.clone());
            }
        }
        for person_id in touched {
            refresh_person_locked(&transaction, &person_id)?;
        }
        transaction.commit()?;
        Ok(outcome)
    }

    /// `cohost.community.summary`.
    pub fn community_summary(
        &self,
        now: DateTime<Utc>,
        threshold: u32,
        backfill: CommunityBackfill,
    ) -> Result<CommunitySummary> {
        let conn = self.lock()?;
        let people: i64 = conn.query_row(
            "SELECT COUNT(*) FROM community_people WHERE status != 'forgotten'",
            [],
            |row| row.get(0),
        )?;
        let streams: i64 = conn.query_row("SELECT COUNT(*) FROM community_streams", [], |row| {
            row.get(0)
        })?;
        let regulars = regular_people_locked(&conn, now, threshold)?;
        let week_ago = now - chrono::Duration::days(7);
        let new_regulars_this_week = regulars
            .values()
            .filter(|(count, newest)| *count == threshold.max(1) as usize && *newest >= week_ago)
            .count();
        let links_pending = open_suggestions_locked(&conn, None)?.len();
        Ok(CommunitySummary {
            people: u32::try_from(people.max(0)).unwrap_or(u32::MAX),
            regulars: u32::try_from(regulars.len()).unwrap_or(u32::MAX),
            streams: u32::try_from(streams.max(0)).unwrap_or(u32::MAX),
            new_regulars_this_week: u32::try_from(new_regulars_this_week).unwrap_or(u32::MAX),
            links_pending: u32::try_from(links_pending).unwrap_or(u32::MAX),
            backfill,
        })
    }

    /// D12 "Links that need you": the open suggestions, newest first.
    pub fn community_open_suggestions(&self) -> Result<Vec<CommunitySuggestion>> {
        let conn = self.lock()?;
        open_suggestions_locked(&conn, None)
    }

    /// `cohost.community.list` (D12): search, filter, sort, page.
    pub fn community_list(
        &self,
        params: &CommunityListParams,
        now: DateTime<Utc>,
        threshold: u32,
    ) -> Result<CommunityListPage> {
        let conn = self.lock()?;
        let regulars = regular_people_locked(&conn, now, threshold)?;
        let mut statement = conn.prepare(
            "SELECT id, name, avatar_url, streams, last_seen_at, status FROM community_people
             WHERE status != 'forgotten'",
        )?;
        let rows = statement.query_map([], |row| {
            let status: String = row.get(5)?;
            Ok(CommunityPersonRow {
                id: row.get(0)?,
                name: row.get(1)?,
                avatar_url: row.get(2)?,
                platforms: Vec::new(),
                streams: row.get::<_, i64>(3)?.max(0) as u32,
                regular: false,
                last_seen_at: row.get(4)?,
                status: CommunityPersonStatus::parse(&status),
            })
        })?;
        let mut platforms_by_person: HashMap<String, Vec<StreamPlatform>> = HashMap::new();
        {
            let mut accounts = conn.prepare(
                "SELECT person_id, platform FROM community_accounts WHERE status != 'forgotten'",
            )?;
            let pairs = accounts.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for pair in pairs {
                let (person_id, platform) = pair?;
                if let Some(platform) = stream_platform_from_id(&platform) {
                    platforms_by_person
                        .entry(person_id)
                        .or_default()
                        .push(platform);
                }
            }
        }
        let query = params
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(str::to_lowercase);
        let mut people: Vec<CommunityPersonRow> = Vec::new();
        for row in rows {
            let mut row = row?;
            let mut platforms = platforms_by_person.remove(&row.id).unwrap_or_default();
            platforms.sort_by_key(|platform| stream_platform_id(*platform));
            platforms.dedup();
            row.platforms = platforms;
            row.regular = regulars.contains_key(&row.id);
            let keep = match params.filter {
                CommunityListFilter::Everyone => row.status != CommunityPersonStatus::Bot,
                CommunityListFilter::Regulars => {
                    row.regular && row.status == CommunityPersonStatus::Normal
                }
                CommunityListFilter::Linked => row.platforms.len() >= 2,
                CommunityListFilter::Bots => row.status == CommunityPersonStatus::Bot,
            };
            if !keep {
                continue;
            }
            if let Some(query) = &query
                && !row.name.to_lowercase().contains(query.as_str())
                && !row
                    .platforms
                    .iter()
                    .any(|platform| stream_platform_id(*platform).contains(query.as_str()))
            {
                continue;
            }
            people.push(row);
        }
        match params.sort {
            CommunityListSort::Streams => people.sort_by(|a, b| {
                b.streams
                    .cmp(&a.streams)
                    .then_with(|| b.last_seen_at.cmp(&a.last_seen_at))
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            }),
            CommunityListSort::Recent => people.sort_by(|a, b| {
                b.last_seen_at
                    .cmp(&a.last_seen_at)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            }),
            CommunityListSort::Name => people.sort_by(|a, b| {
                a.name
                    .to_lowercase()
                    .cmp(&b.name.to_lowercase())
                    .then_with(|| a.id.cmp(&b.id))
            }),
        }
        let offset: usize = params
            .cursor
            .as_deref()
            .and_then(|cursor| cursor.parse().ok())
            .unwrap_or(0);
        let limit = params
            .limit
            .unwrap_or(LIST_LIMIT_MAX)
            .clamp(1, LIST_LIMIT_MAX);
        let total = people.len();
        let page: Vec<CommunityPersonRow> = people.into_iter().skip(offset).take(limit).collect();
        let next = offset.saturating_add(page.len());
        Ok(CommunityListPage {
            people: page,
            next_cursor: (next < total).then(|| next.to_string()),
        })
    }

    /// `cohost.community.person` by id or by account (A5). An unknown
    /// account returns a one-account person with zero counts, never an
    /// error, so the card always opens.
    pub fn community_person(
        &self,
        params: &CommunityPersonParams,
        now: DateTime<Utc>,
        threshold: u32,
    ) -> Result<CommunityPerson, CommunityError> {
        let conn = self.lock()?;
        if let Some(person_id) = params
            .person_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            let person = person_locked(&conn, person_id)?.ok_or(CommunityError::NotFound)?;
            return Ok(person_wire_locked(&conn, &person, now, threshold)?);
        }
        let (Some(platform), Some(author_id)) = (
            params.platform,
            params
                .author_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty()),
        ) else {
            return Err(CommunityError::Invalid(
                "personId, or platform and authorId, are required.".to_string(),
            ));
        };
        let key = account_key(platform, author_id);
        if let Some(account) = account_locked(&conn, &key)?
            && account.status != CommunityPersonStatus::Forgotten
            && let Some(person) = person_locked(&conn, &account.person_id)?
        {
            return Ok(person_wire_locked(&conn, &person, now, threshold)?);
        }
        let name = params
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("Viewer")
            .to_string();
        let forgotten = account_locked(&conn, &key)?
            .is_some_and(|account| account.status == CommunityPersonStatus::Forgotten);
        Ok(CommunityPerson {
            id: String::new(),
            name: name.clone(),
            avatar_url: None,
            accounts: vec![CommunityAccount {
                account_key: key,
                platform,
                author_id: author_id.to_string(),
                name,
                handle: None,
                avatar_url: None,
                first_seen_at: iso(now),
                last_seen_at: iso(now),
            }],
            streams: 0,
            messages: 0,
            in_a_row: 0,
            best_in_a_row: 0,
            regular: false,
            away_days: None,
            first_seen_at: None,
            last_seen_at: None,
            support: CommunitySupport::default(),
            milestones: Vec::new(),
            note: String::new(),
            status: if forgotten {
                CommunityPersonStatus::Forgotten
            } else {
                CommunityPersonStatus::Normal
            },
            memories: Vec::new(),
            suggestions: Vec::new(),
            link_events: Vec::new(),
            youtube: platform == StreamPlatform::Youtube,
        })
    }

    /// `cohost.community.update`: the note (≤300 characters) and the bot
    /// mark (D1, D11).
    pub fn community_update(
        &self,
        person_id: &str,
        note: Option<&str>,
        status: Option<CommunityPersonStatus>,
        now: DateTime<Utc>,
    ) -> Result<(), CommunityError> {
        let conn = self.lock()?;
        if person_locked(&conn, person_id)?.is_none() {
            return Err(CommunityError::NotFound);
        }
        if let Some(note) = note {
            let note = truncate_utf16(note.trim(), NOTE_MAX_CHARS);
            conn.execute(
                "UPDATE community_people SET note = ?2, updated_at = ?3 WHERE id = ?1",
                params![person_id, note, iso(now)],
            )?;
        }
        match status {
            Some(CommunityPersonStatus::Forgotten) => {
                return Err(CommunityError::Invalid(
                    "Use cohost.community.forget to forget a person.".to_string(),
                ));
            }
            Some(status) => {
                conn.execute(
                    "UPDATE community_people SET status = ?2, updated_at = ?3 WHERE id = ?1",
                    params![person_id, status.as_str(), iso(now)],
                )?;
            }
            None => {}
        }
        Ok(())
    }

    /// `cohost.community.link` (D4 a) and a `!link` (D4 b): join two people.
    /// A manual link (or an accepted suggestion) refuses an X account on
    /// either side with `x-self-link-only`; only the viewer's own `!link`
    /// may join one. Returns the kept person's id.
    pub fn community_link(
        &self,
        person_id: &str,
        other_person_id: &str,
        kind: CommunityLinkKind,
        now: DateTime<Utc>,
    ) -> Result<String, CommunityError> {
        if person_id == other_person_id {
            return Err(CommunityError::Invalid(
                "A person cannot be linked to itself.".to_string(),
            ));
        }
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        for id in [person_id, other_person_id] {
            if person_locked(&transaction, id)?.is_none() {
                return Err(CommunityError::NotFound);
            }
        }
        if kind != CommunityLinkKind::SelfLink {
            for id in [person_id, other_person_id] {
                if live_accounts_locked(&transaction, id)?
                    .iter()
                    .any(|account| account.platform == StreamPlatform::X)
                {
                    return Err(CommunityError::XSelfLinkOnly);
                }
            }
        }
        let (into, from) = older_first_locked(&transaction, person_id, other_person_id)?;
        merge_people_locked(&transaction, &into, &from, kind, now)?;
        transaction.commit()?;
        Ok(into)
    }

    /// Accept "Might be the same person" (D4 c): link the two accounts'
    /// people; same refusal rules as a manual link.
    pub fn community_suggestion_accept(
        &self,
        account_a: &str,
        account_b: &str,
        now: DateTime<Utc>,
    ) -> Result<String, CommunityError> {
        let (person_a, person_b) = {
            let conn = self.lock()?;
            let a = account_locked(&conn, account_a)?.ok_or(CommunityError::NotFound)?;
            let b = account_locked(&conn, account_b)?.ok_or(CommunityError::NotFound)?;
            (a.person_id, b.person_id)
        };
        self.community_link(
            &person_a,
            &person_b,
            CommunityLinkKind::SuggestionAccepted,
            now,
        )
    }

    /// "Not the same person" or `!unlink` (D4): the account moves into a new
    /// person; its memories follow; both sides' counts come back from the
    /// per-account attendance. Returns the new person's id.
    pub fn community_unlink(
        &self,
        account_key: &str,
        now: DateTime<Utc>,
    ) -> Result<String, CommunityError> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let account = account_locked(&transaction, account_key)?.ok_or(CommunityError::NotFound)?;
        if account.status == CommunityPersonStatus::Forgotten {
            return Err(CommunityError::NotFound);
        }
        let siblings = live_accounts_locked(&transaction, &account.person_id)?;
        if siblings.len() < 2 {
            // Alone already: nothing to split.
            return Ok(account.person_id);
        }
        let old_person =
            person_locked(&transaction, &account.person_id)?.ok_or(CommunityError::NotFound)?;
        let new_person = insert_person_locked(
            &transaction,
            &account.name,
            account.avatar_url.as_deref(),
            old_person.status,
            now,
        )?;
        transaction.execute(
            "UPDATE community_accounts SET person_id = ?2, updated_at = ?3 WHERE account_key = ?1",
            params![account_key, new_person, iso(now)],
        )?;
        transaction.execute(
            "UPDATE community_memories SET person_id = ?2, updated_at = ?3 WHERE account_key = ?1",
            params![account_key, new_person, iso(now)],
        )?;
        insert_link_event_locked(
            &transaction,
            &new_person,
            account_key,
            CommunityLinkKind::Split,
            now,
        )?;
        insert_link_event_locked(
            &transaction,
            &old_person.id,
            account_key,
            CommunityLinkKind::Split,
            now,
        )?;
        refresh_person_locked(&transaction, &old_person.id)?;
        refresh_person_locked(&transaction, &new_person)?;
        transaction.commit()?;
        Ok(new_person)
    }

    /// "Not the same" (D4 c): the pair never shows again.
    pub fn community_suggestion_dismiss(&self, account_a: &str, account_b: &str) -> Result<()> {
        let conn = self.lock()?;
        let (a, b) = ordered_pair(account_a, account_b);
        conn.execute(
            "INSERT INTO community_suggestions (account_a, account_b, reason, state, created_at)
             VALUES (?1, ?2, 'name', 'dismissed', ?3)
             ON CONFLICT(account_a, account_b) DO UPDATE SET state = 'dismissed'",
            params![a, b, iso(Utc::now())],
        )?;
        Ok(())
    }

    /// A cancelled `!link` (D4 b): the pair waits for the streamer under
    /// "Links that need you".
    pub fn community_link_cancelled(
        &self,
        account_a: &str,
        account_b: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.lock()?;
        let (a, b) = ordered_pair(account_a, account_b);
        conn.execute(
            "INSERT INTO community_suggestions (account_a, account_b, reason, state, created_at)
             VALUES (?1, ?2, 'link-cancelled', 'open', ?3)
             ON CONFLICT(account_a, account_b) DO UPDATE SET reason = 'link-cancelled',
                state = CASE WHEN state = 'dismissed' THEN 'dismissed' ELSE 'open' END",
            params![a, b, iso(now)],
        )?;
        Ok(())
    }

    /// `!forgetme` (D13): the account's attendance and memories go, and a
    /// tombstone stays so the account is never learned again. If it was the
    /// person's last account, the person goes with its note, memories and
    /// milestones. Returns the person's name as it was, for the bubble.
    pub fn community_forget_account(
        &self,
        account_key: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<String>> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let Some(account) = account_locked(&transaction, account_key)? else {
            // Never met: the tombstone still keeps it out.
            let Some((platform, author_id)) = account_key.split_once(':') else {
                return Ok(None);
            };
            transaction.execute(
                "INSERT OR IGNORE INTO community_accounts (account_key, platform, author_id, person_id, name,
                    first_seen_at, last_seen_at, status, updated_at)
                 VALUES (?1, ?2, ?3, '', '', ?4, ?4, 'forgotten', ?4)",
                params![account_key, platform, author_id, iso(now)],
            )?;
            transaction.commit()?;
            return Ok(None);
        };
        let name = account.name.clone();
        forget_account_locked(&transaction, &account, now)?;
        // F2: past reports named them as a regular or a milestone.
        scrub_report_names_locked(
            &transaction,
            Some(&[(name.clone(), account.platform)]),
            now,
        )?;
        transaction.commit()?;
        Ok((!name.is_empty()).then_some(name))
    }

    /// `!rememberme` (D13): lift the tombstone; the account is learned
    /// afresh from its next chat.
    pub fn community_remember_account(&self, account_key: &str) -> Result<bool> {
        let conn = self.lock()?;
        let removed = conn.execute(
            "DELETE FROM community_accounts WHERE account_key = ?1 AND status = 'forgotten'",
            params![account_key],
        )?;
        Ok(removed > 0)
    }

    /// "Forget Ada…" (D13): every account of the person, as `!forgetme`.
    pub fn community_forget_person(
        &self,
        person_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), CommunityError> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        if person_locked(&transaction, person_id)?.is_none() {
            return Err(CommunityError::NotFound);
        }
        let accounts = live_accounts_locked(&transaction, person_id)?;
        let gone: Vec<(String, StreamPlatform)> = accounts
            .iter()
            .map(|account| (account.name.clone(), account.platform))
            .collect();
        for account in &accounts {
            forget_account_locked(&transaction, account, now)?;
        }
        delete_person_locked(&transaction, person_id)?;
        scrub_report_names_locked(&transaction, Some(&gone), now)?;
        transaction.commit()?;
        Ok(())
    }

    /// "Forget everyone…" (D13): the whole store, except the `!forgetme`
    /// tombstones (F3): a viewer who asked never to be learned again stays
    /// unlearned after the streamer wipes the store, with nothing but the
    /// account key, platform, author id and status left on the row.
    pub fn community_forget_all(&self, now: DateTime<Utc>) -> Result<()> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        transaction.execute_batch(
            "DELETE FROM community_attendance;
             DELETE FROM community_memories;
             DELETE FROM community_memory_jobs;
             DELETE FROM community_link_events;
             DELETE FROM community_suggestions;
             DELETE FROM community_accounts WHERE status != 'forgotten';
             UPDATE community_accounts SET person_id = '', name = '', handle = NULL, avatar_url = NULL
                WHERE status = 'forgotten';
             DELETE FROM community_people;
             DELETE FROM community_streams;",
        )?;
        // F2: every name in every past report's Community block goes too.
        scrub_report_names_locked(&transaction, None, now)?;
        transaction.commit()?;
        Ok(())
    }

    /// `cohost.community.memory.delete`.
    pub fn community_memory_delete(&self, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute("DELETE FROM community_memories WHERE id = ?1", params![id])? > 0)
    }

    // --- The memory pass (D10, F3) -------------------------------------------------

    /// A stream ended with "Buddy remembers" on: one pass is owed for it.
    /// Queued once per session; a second call is a no-op.
    pub fn community_memory_job_enqueue(&self, session_id: &str, now: DateTime<Utc>) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT OR IGNORE INTO community_memory_jobs (session_id, created_at, attempts)
             VALUES (?1, ?2, 0)",
            params![session_id, iso(now)],
        )?;
        Ok(())
    }

    /// The queued passes, oldest first.
    pub fn community_memory_jobs(&self) -> Result<Vec<CommunityMemoryJob>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT session_id, created_at, attempts, last_error, last_attempt_at
             FROM community_memory_jobs ORDER BY created_at ASC, session_id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut jobs = Vec::new();
        for row in rows {
            let (session_id, created_at, attempts, last_error, last_attempt_at) = row?;
            let Some(created_at) = parse_at(&created_at) else {
                continue;
            };
            jobs.push(CommunityMemoryJob {
                session_id,
                created_at,
                attempts: u32::try_from(attempts.max(0)).unwrap_or(u32::MAX),
                last_error,
                last_attempt_at: last_attempt_at.as_deref().and_then(parse_at),
            });
        }
        Ok(jobs)
    }

    /// A pass was tried and did not finish: count the attempt and keep why.
    pub fn community_memory_job_attempted(
        &self,
        session_id: &str,
        error: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE community_memory_jobs
             SET attempts = attempts + 1, last_error = ?2, last_attempt_at = ?3
             WHERE session_id = ?1",
            params![session_id, error, iso(now)],
        )?;
        Ok(())
    }

    /// The pass finished, or is dropped (its session is gone, or it is
    /// older than the retry window).
    pub fn community_memory_job_delete(&self, session_id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM community_memory_jobs WHERE session_id = ?1",
            params![session_id],
        )? > 0)
    }

    /// Test helper: age a queued pass.
    #[cfg(test)]
    pub(crate) fn community_memory_job_backdate(
        &self,
        session_id: &str,
        created_at: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE community_memory_jobs SET created_at = ?2, last_attempt_at = NULL
             WHERE session_id = ?1",
            params![session_id, iso(created_at)],
        )?;
        Ok(())
    }

    /// The people behind these account keys, for a memory pass: each live,
    /// normal person once (a bot, a forgotten account or an account the
    /// store never met is left out), with their live accounts, what Buddy
    /// knows and the streamer's note. Returns the key → person map and the
    /// people by id.
    pub fn community_memory_people(
        &self,
        keys: &[String],
        now: DateTime<Utc>,
        threshold: u32,
    ) -> Result<(
        HashMap<String, String>,
        HashMap<String, CommunityMemoryPersonFacts>,
    )> {
        let conn = self.lock()?;
        let mut by_key = HashMap::new();
        let mut people: HashMap<String, CommunityMemoryPersonFacts> = HashMap::new();
        for key in keys {
            let Some(account) = account_locked(&conn, key)? else {
                continue;
            };
            if account.status == CommunityPersonStatus::Forgotten {
                continue;
            }
            let Some(person) = person_locked(&conn, &account.person_id)? else {
                continue;
            };
            if person.status != CommunityPersonStatus::Normal {
                continue;
            }
            by_key.insert(key.clone(), person.id.clone());
            if people.contains_key(&person.id) {
                continue;
            }
            let history = person_history_locked(&conn, &person)?;
            let accounts = live_accounts_locked(&conn, &person.id)?
                .into_iter()
                .map(|account| (account.account_key, account.platform))
                .collect();
            let facts = CommunityMemoryPersonFacts {
                name: person.name.clone(),
                regular: is_regular(&history, now, threshold),
                streams: history.streams(),
                accounts,
                memories: memories_locked(&conn, &person.id)?,
                note: person.note.clone(),
            };
            people.insert(person.id.clone(), facts);
        }
        Ok((by_key, people))
    }

    /// A pass's answer for one person (D10): forget what the person
    /// contradicted, rewrite what changed, then add what is new, at most
    /// two new and eight in all. Only this person's own memory ids count;
    /// a new memory records the account whose words taught it. Returns how
    /// many were added.
    pub fn community_memories_apply(
        &self,
        person_id: &str,
        session_id: &str,
        adds: &[(String, String)],
        updates: &[(String, String)],
        removes: &[String],
        now: DateTime<Utc>,
    ) -> Result<u32> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let at = iso(now);
        for id in removes {
            transaction.execute(
                "DELETE FROM community_memories WHERE id = ?1 AND person_id = ?2",
                params![id, person_id],
            )?;
        }
        for (id, text) in updates {
            transaction.execute(
                "UPDATE community_memories SET text = ?1, updated_at = ?2
                 WHERE id = ?3 AND person_id = ?4",
                params![text, at, id, person_id],
            )?;
        }
        let kept: usize = transaction.query_row(
            "SELECT COUNT(*) FROM community_memories WHERE person_id = ?1",
            params![person_id],
            |row| row.get::<_, i64>(0),
        )? as usize;
        let room = MEMORY_PER_PERSON_MAX
            .saturating_sub(kept)
            .min(MEMORY_ADDS_MAX);
        let mut learned = 0u32;
        for (text, account_key) in adds.iter().take(room) {
            transaction.execute(
                "INSERT INTO community_memories
                 (id, person_id, account_key, text, session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![new_id(), person_id, account_key, text, session_id, at],
            )?;
            learned += 1;
        }
        if learned > 0 || !updates.is_empty() || !removes.is_empty() {
            transaction.execute(
                "UPDATE community_people SET updated_at = ?2 WHERE id = ?1",
                params![person_id, at],
            )?;
        }
        transaction.commit()?;
        Ok(learned)
    }

    /// The daily and at-start prune (D3, A4), per account clock: a YouTube
    /// account and everything derived from it go 30 days after its last
    /// chat (and its older attendance rows go daily); a Twitch, Kick or X
    /// account 12 months after. Tombstones stay. A linked person outlives
    /// one account's expiry; a person with no live account left is deleted.
    /// Returns how many accounts went.
    pub fn community_prune(&self, now: DateTime<Utc>) -> Result<u32> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let youtube_cutoff = iso(now - chrono::Duration::days(YOUTUBE_RETENTION_DAYS));
        let other_cutoff = iso(now - chrono::Duration::days(OTHER_RETENTION_DAYS));
        // YouTube attendance older than 30 days leaves the union even while
        // the account is alive (D3: counts are recomputed daily).
        transaction.execute(
            "DELETE FROM community_attendance WHERE last_message_at < ?1 AND account_key IN (
                SELECT account_key FROM community_accounts WHERE platform = 'youtube')",
            params![youtube_cutoff],
        )?;
        let mut expired: Vec<AccountRow> = Vec::new();
        {
            let mut statement = transaction.prepare(&format!(
                "SELECT {ACCOUNT_COLUMNS} FROM community_accounts
                 WHERE status != 'forgotten' AND (
                    (platform = 'youtube' AND last_seen_at < ?1)
                    OR (platform != 'youtube' AND last_seen_at < ?2))"
            ))?;
            let rows =
                statement.query_map(params![youtube_cutoff, other_cutoff], account_from_row)?;
            for row in rows {
                expired.push(row?);
            }
        }
        let mut touched: Vec<String> = Vec::new();
        for account in &expired {
            transaction.execute(
                "DELETE FROM community_attendance WHERE account_key = ?1",
                params![account.account_key],
            )?;
            transaction.execute(
                "DELETE FROM community_memories WHERE account_key = ?1",
                params![account.account_key],
            )?;
            transaction.execute(
                "DELETE FROM community_suggestions WHERE account_a = ?1 OR account_b = ?1",
                params![account.account_key],
            )?;
            transaction.execute(
                "DELETE FROM community_link_events WHERE account_key = ?1",
                params![account.account_key],
            )?;
            transaction.execute(
                "DELETE FROM community_accounts WHERE account_key = ?1",
                params![account.account_key],
            )?;
            if !touched.contains(&account.person_id) {
                touched.push(account.person_id.clone());
            }
        }
        // Every YouTube person's counts are recomputed after the attendance
        // prune, not only the expired accounts'.
        {
            let mut statement = transaction.prepare(
                "SELECT DISTINCT person_id FROM community_accounts WHERE platform = 'youtube' AND status != 'forgotten'",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                let person_id = row?;
                if !touched.contains(&person_id) {
                    touched.push(person_id);
                }
            }
        }
        for person_id in touched {
            refresh_person_locked(&transaction, &person_id)?;
        }
        transaction.execute(
            "DELETE FROM community_people WHERE id NOT IN (
                SELECT DISTINCT person_id FROM community_accounts WHERE status != 'forgotten')",
            [],
        )?;
        transaction.execute(
            "DELETE FROM community_memories WHERE person_id NOT IN (SELECT id FROM community_people)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM community_link_events WHERE person_id NOT IN (SELECT id FROM community_people)",
            [],
        )?;
        transaction.commit()?;
        Ok(u32::try_from(expired.len()).unwrap_or(u32::MAX))
    }

    // --- Backfill (A3) ------------------------------------------------------

    /// Every session with chat on this computer, oldest first, as
    /// `(session_id, started_at)`; the cursor the backfill resumes from.
    pub fn community_backfill_sessions(&self) -> Result<Vec<(String, DateTime<Utc>)>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT m.session_id, COALESCE(s.started_at, MIN(m.received_at))
             FROM live_chat_messages m
             LEFT JOIN sessions s ON s.id = m.session_id
             WHERE m.author_id IS NOT NULL AND m.is_deleted = 0
             GROUP BY m.session_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut sessions = Vec::new();
        for row in rows {
            let (session_id, started_at) = row?;
            if let Some(started_at) = parse_at(&started_at) {
                sessions.push((session_id, started_at));
            }
        }
        sessions.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        Ok(sessions)
    }

    /// Fold one past session into the store (A3): the stream row, every
    /// counted author's attendance (set, not added, so a re-run changes
    /// nothing), the latest name, support, and suggestions. YouTube rows
    /// older than 30 days are left out (D3).
    pub fn community_backfill_session(
        &self,
        session_id: &str,
        started_at: DateTime<Utc>,
        streamer_keys: &HashSet<String>,
        now: DateTime<Utc>,
    ) -> Result<u32> {
        let messages = {
            let conn = self.lock()?;
            crate::storage::live_chat_messages_for_session_for_community(&conn, session_id)?
        };
        let youtube_cutoff = now - chrono::Duration::days(YOUTUBE_RETENTION_DAYS);
        let mut platforms: Vec<StreamPlatform> = Vec::new();
        let mut facts: BTreeMap<String, CommunityRowFacts> = BTreeMap::new();
        let mut attendance: BTreeMap<String, (DateTime<Utc>, DateTime<Utc>, u64)> = BTreeMap::new();
        for message in &messages {
            if platform_has_identity(message.platform) && !platforms.contains(&message.platform) {
                platforms.push(message.platform);
            }
            let Some(row) = CommunityRowFacts::from_message(message, streamer_keys) else {
                continue;
            };
            if row.platform == StreamPlatform::Youtube && row.at < youtube_cutoff {
                continue;
            }
            let key = row.key();
            if row.counts {
                let slot = attendance.entry(key.clone()).or_insert((row.at, row.at, 0));
                slot.0 = slot.0.min(row.at);
                slot.1 = slot.1.max(row.at);
                slot.2 += 1;
            }
            match facts.get_mut(&key) {
                Some(existing) => {
                    if row.at >= existing.at {
                        existing.name = row.name.clone();
                        if row.avatar_url.is_some() {
                            existing.avatar_url = row.avatar_url.clone();
                        }
                        existing.at = row.at;
                    }
                    existing.support.add(&row.support);
                }
                None => {
                    let mut first = row.clone();
                    first.counts = false;
                    first.celebrate = None;
                    facts.insert(key, first);
                }
            }
        }
        self.community_record_stream(session_id, started_at, &platforms)?;
        let rows: Vec<CommunityRowFacts> = facts.into_values().collect();
        let counted = rows.len();
        self.community_record_batch(&rows, now)?;
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let mut touched: Vec<String> = Vec::new();
        for (key, (first, last, messages)) in attendance {
            transaction.execute(
                "INSERT INTO community_attendance (account_key, session_id, first_message_at, last_message_at, messages)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_key, session_id) DO UPDATE SET
                    first_message_at = excluded.first_message_at,
                    last_message_at = excluded.last_message_at,
                    messages = excluded.messages",
                params![key, session_id, iso(first), iso(last), i64::try_from(messages).unwrap_or(i64::MAX)],
            )?;
            // The account's own clock follows its attendance.
            transaction.execute(
                "UPDATE community_accounts SET first_seen_at = MIN(first_seen_at, ?2), last_seen_at = MAX(last_seen_at, ?3)
                 WHERE account_key = ?1 AND status != 'forgotten'",
                params![key, iso(first), iso(last)],
            )?;
            if let Some(account) = account_locked(&transaction, &key)?
                && !touched.contains(&account.person_id)
            {
                touched.push(account.person_id);
            }
        }
        for person_id in touched {
            refresh_person_locked(&transaction, &person_id)?;
        }
        transaction.commit()?;
        Ok(u32::try_from(counted).unwrap_or(u32::MAX))
    }

    pub fn community_backfill_progress(&self) -> BackfillProgress {
        self.load_setting::<BackfillProgress>(BACKFILL_SETTING_KEY)
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    pub fn community_save_backfill_progress(&self, progress: &BackfillProgress) -> Result<()> {
        self.save_setting(BACKFILL_SETTING_KEY, progress)
    }

    // --- Export and import (D5, D12) ------------------------------------------

    pub fn community_export(&self, now: DateTime<Utc>) -> Result<CommunityExportFile> {
        let conn = self.lock()?;
        let mut file = CommunityExportFile {
            version: EXPORT_VERSION,
            exported_at: iso(now),
            people: Vec::new(),
            streams: Vec::new(),
        };
        let mut streams =
            conn.prepare("SELECT session_id, started_at, platforms_json FROM community_streams")?;
        for row in streams.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (session_id, started_at, platforms) = row?;
            file.streams.push(ExportStream {
                session_id,
                started_at,
                platforms: serde_json::from_str(&platforms).unwrap_or_default(),
            });
        }
        let mut people = conn.prepare(
            "SELECT id, note, status, support_json, milestones_json, best_in_a_row, updated_at FROM community_people",
        )?;
        let rows: Vec<(String, String, String, String, String, i64, String)> = people
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (id, note, status, support, milestones, best, updated_at) in rows {
            let mut person = ExportPerson {
                id: id.clone(),
                note,
                status,
                support: serde_json::from_str(&support).unwrap_or_default(),
                milestones: serde_json::from_str(&milestones).unwrap_or_default(),
                best_in_a_row: best.max(0) as u32,
                updated_at,
                accounts: Vec::new(),
                memories: memories_locked(&conn, &id)?,
                link_events: link_events_locked(&conn, &id)?,
            };
            let mut accounts = conn.prepare(&format!(
                "SELECT {ACCOUNT_COLUMNS}, updated_at FROM community_accounts WHERE person_id = ?1"
            ))?;
            let account_rows: Vec<(AccountRow, String)> = accounts
                .query_map(params![id], |row| {
                    Ok((account_from_row(row)?, row.get::<_, String>(10)?))
                })?
                .collect::<Result<_, _>>()?;
            for (account, updated_at) in account_rows {
                let mut attendance = conn.prepare(
                    "SELECT session_id, first_message_at, last_message_at, messages FROM community_attendance WHERE account_key = ?1",
                )?;
                let attendance: Vec<ExportAttendance> = attendance
                    .query_map(params![account.account_key], |row| {
                        Ok(ExportAttendance {
                            session_id: row.get(0)?,
                            first_message_at: row.get(1)?,
                            last_message_at: row.get(2)?,
                            messages: row.get::<_, i64>(3)?.max(0) as u64,
                        })
                    })?
                    .collect::<Result<_, _>>()?;
                person.accounts.push(ExportAccount {
                    account_key: account.account_key,
                    platform: stream_platform_id(account.platform).to_string(),
                    author_id: account.author_id,
                    name: account.name,
                    handle: account.handle,
                    avatar_url: account.avatar_url,
                    first_seen_at: account.first_seen_at,
                    last_seen_at: account.last_seen_at,
                    status: account.status.as_str().to_string(),
                    updated_at,
                    attendance,
                });
            }
            file.people.push(person);
        }
        // Tombstones without a person row.
        let mut orphans = conn.prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS}, updated_at FROM community_accounts
             WHERE status = 'forgotten' AND person_id NOT IN (SELECT id FROM community_people)"
        ))?;
        let orphan_rows: Vec<(AccountRow, String)> = orphans
            .query_map([], |row| {
                Ok((account_from_row(row)?, row.get::<_, String>(10)?))
            })?
            .collect::<Result<_, _>>()?;
        for (account, updated_at) in orphan_rows {
            file.people.push(ExportPerson {
                id: String::new(),
                status: "forgotten".to_string(),
                updated_at: updated_at.clone(),
                accounts: vec![ExportAccount {
                    account_key: account.account_key,
                    platform: stream_platform_id(account.platform).to_string(),
                    author_id: account.author_id,
                    name: String::new(),
                    handle: None,
                    avatar_url: None,
                    first_seen_at: account.first_seen_at,
                    last_seen_at: account.last_seen_at,
                    status: "forgotten".to_string(),
                    updated_at,
                    attendance: Vec::new(),
                }],
                ..Default::default()
            });
        }
        Ok(file)
    }

    /// Merge an export file in (D5's rules): account and person rows
    /// last-writer-wins by `updated_at`, attendance a union, a forgotten
    /// tombstone wins over everything. Returns `(people, merged)`: people in
    /// the file, and how many met an existing person.
    pub fn community_import(
        &self,
        file: &CommunityExportFile,
        now: DateTime<Utc>,
    ) -> Result<(u32, u32)> {
        if file.version != EXPORT_VERSION {
            anyhow::bail!(
                "This file was made by a newer Videorc (version {}).",
                file.version
            );
        }
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        for stream in &file.streams {
            let platforms: Vec<StreamPlatform> = stream
                .platforms
                .iter()
                .filter_map(|id| stream_platform_from_id(id))
                .collect();
            let json = platforms_json(&platforms);
            transaction.execute(
                "INSERT INTO community_streams (session_id, started_at, platforms_json) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO NOTHING",
                params![stream.session_id, stream.started_at, json],
            )?;
        }
        let mut merged = 0u32;
        let mut touched: Vec<String> = Vec::new();
        for person in &file.people {
            // Tombstones first: a forgotten account wins everywhere.
            let tombstones: Vec<&ExportAccount> = person
                .accounts
                .iter()
                .filter(|account| account.status == "forgotten")
                .collect();
            for account in &tombstones {
                if let Some(existing) = account_locked(&transaction, &account.account_key)? {
                    if existing.status != CommunityPersonStatus::Forgotten {
                        forget_account_locked(&transaction, &existing, now)?;
                    }
                } else {
                    transaction.execute(
                        "INSERT OR IGNORE INTO community_accounts (account_key, platform, author_id, person_id, name,
                            first_seen_at, last_seen_at, status, updated_at)
                         VALUES (?1, ?2, ?3, '', '', ?4, ?5, 'forgotten', ?6)",
                        params![
                            account.account_key,
                            account.platform,
                            account.author_id,
                            account.first_seen_at,
                            account.last_seen_at,
                            account.updated_at
                        ],
                    )?;
                }
            }
            let live: Vec<&ExportAccount> = person
                .accounts
                .iter()
                .filter(|account| account.status != "forgotten")
                .collect();
            if live.is_empty() {
                continue;
            }
            // The person this file's accounts land in: an existing person of
            // any of them, else a new one.
            let mut target: Option<String> = None;
            for account in &live {
                if let Some(existing) = account_locked(&transaction, &account.account_key)?
                    && existing.status != CommunityPersonStatus::Forgotten
                {
                    target = Some(existing.person_id);
                    break;
                }
            }
            let (person_id, existing) = match target {
                Some(id) => (id, true),
                None => {
                    let first = live[0];
                    let status = CommunityPersonStatus::parse(&person.status);
                    let id = insert_person_locked(
                        &transaction,
                        &first.name,
                        first.avatar_url.as_deref(),
                        status,
                        now,
                    )?;
                    (id, false)
                }
            };
            if existing {
                merged += 1;
            }
            for account in &live {
                let Some(platform) = stream_platform_from_id(&account.platform) else {
                    continue;
                };
                match account_locked(&transaction, &account.account_key)? {
                    Some(current) if current.status == CommunityPersonStatus::Forgotten => continue,
                    Some(current) => {
                        // Last writer wins for the name and avatar; the
                        // account stays with its current person.
                        let newer: bool = transaction.query_row(
                            "SELECT updated_at < ?2 FROM community_accounts WHERE account_key = ?1",
                            params![account.account_key, account.updated_at],
                            |row| row.get(0),
                        )?;
                        if newer {
                            transaction.execute(
                                "UPDATE community_accounts SET name = ?2, handle = ?3, avatar_url = ?4, updated_at = ?5,
                                    first_seen_at = MIN(first_seen_at, ?6), last_seen_at = MAX(last_seen_at, ?7)
                                 WHERE account_key = ?1",
                                params![
                                    account.account_key,
                                    account.name,
                                    account.handle,
                                    account.avatar_url,
                                    account.updated_at,
                                    account.first_seen_at,
                                    account.last_seen_at
                                ],
                            )?;
                        }
                        if !touched.contains(&current.person_id) {
                            touched.push(current.person_id.clone());
                        }
                    }
                    None => {
                        transaction.execute(
                            "INSERT INTO community_accounts (account_key, platform, author_id, person_id, name,
                                handle, avatar_url, first_seen_at, last_seen_at, status, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'normal', ?10)",
                            params![
                                account.account_key,
                                stream_platform_id(platform),
                                account.author_id,
                                person_id,
                                account.name,
                                account.handle,
                                account.avatar_url,
                                account.first_seen_at,
                                account.last_seen_at,
                                account.updated_at
                            ],
                        )?;
                    }
                }
                for row in &account.attendance {
                    transaction.execute(
                        "INSERT INTO community_attendance (account_key, session_id, first_message_at, last_message_at, messages)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(account_key, session_id) DO UPDATE SET
                            first_message_at = MIN(first_message_at, excluded.first_message_at),
                            last_message_at = MAX(last_message_at, excluded.last_message_at),
                            messages = MAX(messages, excluded.messages)",
                        params![
                            account.account_key,
                            row.session_id,
                            row.first_message_at,
                            row.last_message_at,
                            i64::try_from(row.messages).unwrap_or(i64::MAX)
                        ],
                    )?;
                }
            }
            if let Some(current) = person_locked(&transaction, &person_id)? {
                // A person this import created takes the file's values; an
                // existing one only when the file is newer.
                let newer: bool = !existing
                    || transaction.query_row(
                        "SELECT updated_at < ?2 FROM community_people WHERE id = ?1",
                        params![person_id, person.updated_at],
                        |row| row.get(0),
                    )?;
                let mut support = current.support.clone();
                if newer {
                    support = person.support.clone();
                }
                let mut milestones = current.milestones.clone();
                for key in &person.milestones {
                    if !milestones.contains(key) {
                        milestones.push(key.clone());
                    }
                }
                let note = if newer && !person.note.trim().is_empty() {
                    person.note.clone()
                } else {
                    current.note.clone()
                };
                transaction.execute(
                    "UPDATE community_people SET support_json = ?2, milestones_json = ?3, note = ?4,
                        best_in_a_row = MAX(best_in_a_row, ?5), updated_at = MAX(updated_at, ?6)
                     WHERE id = ?1",
                    params![
                        person_id,
                        serde_json::to_string(&support)?,
                        serde_json::to_string(&milestones)?,
                        note,
                        i64::from(person.best_in_a_row),
                        person.updated_at
                    ],
                )?;
            }
            for memory in &person.memories {
                if account_locked(&transaction, &memory.account_key)?
                    .is_some_and(|account| account.status == CommunityPersonStatus::Forgotten)
                {
                    continue;
                }
                let owner = account_locked(&transaction, &memory.account_key)?
                    .map(|account| account.person_id)
                    .unwrap_or_else(|| person_id.clone());
                transaction.execute(
                    "INSERT INTO community_memories (id, person_id, account_key, text, session_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET text = CASE WHEN updated_at < excluded.updated_at THEN excluded.text ELSE text END,
                        updated_at = MAX(updated_at, excluded.updated_at)",
                    params![
                        memory.id,
                        owner,
                        memory.account_key,
                        memory.text,
                        memory.session_id,
                        memory.created_at,
                        memory.updated_at
                    ],
                )?;
            }
            for event in &person.link_events {
                transaction.execute(
                    "INSERT OR IGNORE INTO community_link_events (id, person_id, account_key, kind, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![event.id, person_id, event.account_key, event.kind.as_str(), event.at],
                )?;
            }
            if !touched.contains(&person_id) {
                touched.push(person_id);
            }
        }
        for person_id in touched {
            refresh_person_locked(&transaction, &person_id)?;
        }
        transaction.commit()?;
        Ok((u32::try_from(file.people.len()).unwrap_or(u32::MAX), merged))
    }

    /// D15: the first-timers of one stream and how many stayed 40 minutes
    /// or more (first to last message of the stream). A first-timer is a
    /// person, not a bot or a tombstone, none of whose accounts chatted
    /// before this stream's first message from them. "Before" includes the
    /// same millisecond: timestamps are stored to the millisecond, and a
    /// quick stop and restart can land one person's two first messages in
    /// the same one (the Linux CI red of 2026-11-09); a tie with another
    /// stream means they chatted before, never that they are new. Returns
    /// `(first_timers, stayed)`.
    pub fn community_session_first_timers(&self, session_id: &str) -> Result<(u32, u32)> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "WITH here AS (
                SELECT accounts.person_id AS person_id,
                       MIN(attendance.first_message_at) AS first_at,
                       MAX(attendance.last_message_at) AS last_at
                FROM community_attendance AS attendance
                JOIN community_accounts AS accounts
                  ON accounts.account_key = attendance.account_key
                JOIN community_people AS people ON people.id = accounts.person_id
                WHERE attendance.session_id = ?1
                  AND accounts.status = 'normal'
                  AND people.status = 'normal'
                GROUP BY accounts.person_id
             )
             SELECT here.first_at, here.last_at FROM here
             WHERE NOT EXISTS (
                SELECT 1 FROM community_attendance AS before
                JOIN community_accounts AS other
                  ON other.account_key = before.account_key
                WHERE other.person_id = here.person_id
                  AND before.session_id != ?1
                  AND before.first_message_at <= here.first_at
             )",
        )?;
        let rows = statement.query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut first_timers = 0u32;
        let mut stayed = 0u32;
        for row in rows {
            let (first_at, last_at) = row?;
            first_timers = first_timers.saturating_add(1);
            if let (Some(first), Some(last)) = (parse_at(&first_at), parse_at(&last_at))
                && last.signed_duration_since(first)
                    >= chrono::Duration::minutes(crate::community::STAYED_MINUTES)
            {
                stayed = stayed.saturating_add(1);
            }
        }
        Ok((first_timers, stayed))
    }

    /// The person a live (never forgotten) account belongs to.
    pub(crate) fn community_account_person(&self, key: &str) -> Result<Option<String>> {
        let conn = self.lock()?;
        Ok(account_locked(&conn, key)?
            .filter(|account| account.status != CommunityPersonStatus::Forgotten)
            .map(|account| account.person_id))
    }

    /// Test helper: the person a key belongs to, by status.
    #[cfg(test)]
    pub(crate) fn community_account_status(
        &self,
        key: &str,
    ) -> Option<(String, CommunityPersonStatus)> {
        let conn = self.lock().ok()?;
        account_locked(&conn, key)
            .ok()
            .flatten()
            .map(|account| (account.person_id, account.status))
    }
}

/// People who are regulars right now, with their distinct recent stream
/// count and the newest attended stream's start (for "new this week").
fn regular_people_locked(
    conn: &Connection,
    now: DateTime<Utc>,
    threshold: u32,
) -> Result<HashMap<String, (usize, DateTime<Utc>)>> {
    let since = iso(now - chrono::Duration::days(REGULAR_WINDOW_DAYS));
    let mut statement = conn.prepare(
        "SELECT a.person_id, t.session_id, COALESCE(s.started_at, t.first_message_at)
         FROM community_attendance t
         JOIN community_accounts a ON a.account_key = t.account_key
         LEFT JOIN community_streams s ON s.session_id = t.session_id
         WHERE a.status != 'forgotten' AND COALESCE(s.started_at, t.first_message_at) >= ?1",
    )?;
    let rows = statement.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut per_person: HashMap<String, BTreeMap<String, DateTime<Utc>>> = HashMap::new();
    for row in rows {
        let (person_id, session_id, started_at) = row?;
        let Some(started_at) = parse_at(&started_at) else {
            continue;
        };
        per_person
            .entry(person_id)
            .or_default()
            .insert(session_id, started_at);
    }
    let threshold = threshold.max(1) as usize;
    Ok(per_person
        .into_iter()
        .filter(|(_, sessions)| sessions.len() >= threshold)
        .map(|(person_id, sessions)| {
            let newest = sessions.values().copied().max().unwrap_or(now);
            (person_id, (sessions.len(), newest))
        })
        .collect())
}

/// `!forgetme` for one account row, inside a transaction.
fn forget_account_locked(
    conn: &Connection,
    account: &AccountRow,
    now: DateTime<Utc>,
) -> Result<()> {
    conn.execute(
        "DELETE FROM community_attendance WHERE account_key = ?1",
        params![account.account_key],
    )?;
    conn.execute(
        "DELETE FROM community_memories WHERE account_key = ?1",
        params![account.account_key],
    )?;
    conn.execute(
        "DELETE FROM community_suggestions WHERE account_a = ?1 OR account_b = ?1",
        params![account.account_key],
    )?;
    // F2: who linked this account, and when, goes with it.
    conn.execute(
        "DELETE FROM community_link_events WHERE account_key = ?1",
        params![account.account_key],
    )?;
    conn.execute(
        "UPDATE community_accounts SET name = '', handle = NULL, avatar_url = NULL, status = 'forgotten', updated_at = ?2
         WHERE account_key = ?1",
        params![account.account_key, iso(now)],
    )?;
    // The person's live accounts decide whether it survives (D13).
    refresh_person_locked(conn, &account.person_id)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
