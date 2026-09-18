//! Live Chat Co-host engine (plan: "2026-08-22 - Videorc Live Chat Co-host").
//!
//! One backend-owned state machine per live-chat session: it watches delivered
//! chat rows, batches the delta into periodic `POST /api/ai/cohost/tick`
//! calls (bearer-authed, Premium + consent gated), merges the server's
//! open-question set, flags, and mood, and publishes every change to renderers
//! as the non-coalescible `cohost.state` event. Raw drafts live only in memory
//! and are cleared when the session stops. The renderer never talks to the web.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::task::JoinHandle;

use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::protocol::{
    CohostFlagParams, CohostQuestionParams, CohostSettingsPatch, CohostStartParams, FeatureId,
};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::StreamPlatform;
use crate::videorc_api::{
    CohostApiError, CohostApiErrorKind, CohostTickMessage, CohostTickOpenQuestion,
    CohostTickQuestion, CohostTickRequest, CohostTickResponse, VideorcApiClient,
};

pub const COHOST_STATE_EVENT: &str = "cohost.state";
/// Pinned by the desktop; the server rejects unknown versions with 400
/// `prompt-version-unsupported`. A session that gets that answer to a v2 tick
/// drops to `COHOST_PROMPT_VERSION_FALLBACK` until it ends (server rollback).
pub const COHOST_PROMPT_VERSION: u32 = 2;
pub const COHOST_PROMPT_VERSION_FALLBACK: u32 = 1;
pub const COHOST_SETTINGS_KEY: &str = "cohostSettings";
pub const COHOST_NOTES_MAX_CHARS: usize = 4000;
/// The server rejects more or longer rules as `invalid-request`, so settings
/// are normalised to these caps before they are stored or sent.
pub const COHOST_RULES_MAX: usize = 10;
pub const COHOST_RULE_MAX_CHARS: usize = 120;
const DESKTOP_CLIENT_VERSION: &str = concat!("videorc-desktop/", env!("CARGO_PKG_VERSION"));

const TICK_MESSAGE_TEXT_MAX_CHARS: usize = 500;
/// Newest messages kept per tick; older delta rows are counted as dropped.
const TICK_DELTA_CAP: usize = 60;
const TICK_OPEN_QUESTIONS_CAP: usize = 40;
const TICK_BURST_THRESHOLD: usize = 5;
const TICK_IDLE_INTERVAL: Duration = Duration::from_secs(20);
/// Contract floor between two tick requests. Independent of the HTTP timeout:
/// ticks never overlap, so a slow tick delays the next one rather than
/// shortening the gap.
pub(crate) const TICK_MIN_GAP: Duration = Duration::from_secs(8);
/// Hard cap on the detail message carried on the wire; server envelope
/// messages are one sentence, and a proxy error page must not become a toast.
const ERROR_DETAIL_MESSAGE_MAX_CHARS: usize = 400;
const BACKOFF_STEPS_SECS: [u64; 5] = [5, 10, 20, 40, 60];
const QUOTA_DEFAULT_RETRY: Duration = Duration::from_secs(3600);
/// How often a paused precondition (signed out, Basic, no consent) is re-read.
const PRECONDITION_RECHECK: Duration = Duration::from_secs(5);
const SCHEDULER_POLL: Duration = Duration::from_secs(1);
const KNOWN_MESSAGE_IDS_CAP: usize = 5000;
const FLAGS_CAP: usize = 50;
const HIGHLIGHTS_CAP: usize = 5;
/// An alert kind is only shown once two different viewers said it within this
/// window — one confused viewer is not a broken stream.
const ALERT_CORROBORATION_WINDOW: Duration = Duration::from_secs(60);
const ALERT_MIN_AUTHORS: usize = 2;
/// A report stops counting (and its kind leaves the state) after this long.
const ALERT_EXPIRY: Duration = Duration::from_secs(120);
const ALLOWED_ROLES: [&str; 5] = ["mod", "owner", "subscriber", "member", "vip"];

// --- Wire enums --------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostTone {
    #[default]
    Friendly,
    Short,
    Professional,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostStatus {
    Off,
    Listening,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostReason {
    PremiumRequired,
    ConsentRequired,
    SessionExpired,
    SignedOut,
    QuotaExhausted,
    ServerUnconfigured,
    Network,
    GatewayError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostPriority {
    High,
    #[default]
    Normal,
    Low,
    /// Forward tolerance: a priority this build does not know. Never reaches
    /// the renderer — `apply_response` reads it as `normal`.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostMood {
    Hype,
    Calm,
    Tense,
    Mixed,
    /// Forward tolerance; read as `mixed`, never sent to the renderer.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagKind {
    Toxicity,
    Spam,
    SelfPromo,
    PersonalInfo,
    Hate,
    Harassment,
    Threat,
    Sexual,
    Scam,
    SelfHarm,
    Spoiler,
    Impersonation,
    Rule,
    /// Forward tolerance: the vocabulary will grow. An unknown kind is kept
    /// and reaches the renderer as `unknown`, which renders as "Flagged".
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagSeverity {
    High,
    Medium,
    Low,
    /// Forward tolerance; read as `medium`, never sent to the renderer.
    #[serde(other)]
    Unknown,
}

/// Who a flagged message is aimed at. Absent means nobody in particular.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagTarget {
    Streamer,
    Viewer,
    Group,
    /// Forward tolerance; read as absent.
    #[serde(other)]
    Unknown,
}

/// A moderation action the server SUGGESTS. The desktop only labels it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagAction {
    Hide,
    Timeout,
    Ban,
    /// Forward tolerance; read as absent.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostHighlightType {
    Question,
    Joke,
    Praise,
    Insight,
    Milestone,
    #[default]
    Other,
    /// Forward tolerance; read as `other`.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAlertKind {
    Audio,
    Video,
    StreamHealth,
    Game,
    Other,
    /// Forward tolerance; read as `other` ("something is wrong").
    #[serde(other)]
    Unknown,
}

// --- Settings ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSettings {
    pub enabled: bool,
    pub tone: CohostTone,
    pub notes: String,
    pub auto_highlight: bool,
    /// Plain-language chat rules the co-host flags against (wire v2). `default`
    /// so a settings row from before the field still loads.
    #[serde(default)]
    pub rules: Vec<String>,
}

impl Default for CohostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            tone: CohostTone::Friendly,
            notes: String::new(),
            auto_highlight: false,
            rules: Vec::new(),
        }
    }
}

impl CohostSettings {
    fn normalized(mut self) -> Self {
        self.notes = truncate_chars(&self.notes, COHOST_NOTES_MAX_CHARS);
        self.rules = normalize_rules(self.rules);
        self
    }

    fn apply(&mut self, patch: CohostSettingsPatch) {
        if let Some(enabled) = patch.enabled {
            self.enabled = enabled;
        }
        if let Some(tone) = patch.tone {
            self.tone = tone;
        }
        if let Some(notes) = patch.notes {
            self.notes = truncate_chars(&notes, COHOST_NOTES_MAX_CHARS);
        }
        if let Some(auto_highlight) = patch.auto_highlight {
            self.auto_highlight = auto_highlight;
        }
        if let Some(rules) = patch.rules {
            self.rules = normalize_rules(rules);
        }
    }
}

/// Trimmed, non-empty, at most `COHOST_RULES_MAX` rules of at most
/// `COHOST_RULE_MAX_CHARS` characters — exactly what the server accepts.
fn normalize_rules(rules: Vec<String>) -> Vec<String> {
    rules
        .iter()
        .map(|rule| truncate_chars(rule.trim(), COHOST_RULE_MAX_CHARS))
        .map(|rule| rule.trim_end().to_string())
        .filter(|rule| !rule.is_empty())
        .take(COHOST_RULES_MAX)
        .collect()
}

pub fn load_cohost_settings(database: &Database) -> CohostSettings {
    match database.load_setting::<CohostSettings>(COHOST_SETTINGS_KEY) {
        Ok(Some(settings)) => settings.normalized(),
        Ok(None) => CohostSettings::default(),
        Err(error) => {
            tracing::warn!("Could not read co-host settings; using defaults: {error:#}");
            CohostSettings::default()
        }
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

// --- Renderer-facing state -----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostQuestion {
    pub id: String,
    pub text: String,
    pub message_ids: Vec<String>,
    pub askers: Vec<String>,
    pub platforms: Vec<StreamPlatform>,
    pub priority: CohostPriority,
    pub suggested_reply: String,
    pub from_notes: bool,
    pub first_seen_at: String,
    pub updated_at: String,
}

/// The v2 extras are absent keys when the server did not send them — never
/// `null`: the renderer contract rejects null for optional fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostFlag {
    pub message_id: String,
    pub kind: CohostFlagKind,
    pub severity: CohostFlagSeverity,
    pub reason: String,
    pub at: String,
    /// 0..1. The renderer's Sensitivity control filters on it; a flag without
    /// one always shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CohostFlagTarget>,
    /// Suggested action — a label only, the desktop never acts on a flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<CohostFlagAction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_kinds: Vec<CohostFlagKind>,
    /// The streamer rule this message broke, resolved from the tick's
    /// `ruleIndex` against the rules that tick actually sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

/// A comment the server suggests showing on stream. Suggest-first: nothing is
/// highlighted because of this entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostHighlight {
    pub message_id: String,
    pub score: f64,
    #[serde(rename = "type")]
    pub highlight_type: CohostHighlightType,
}

/// One entry per alert kind viewers reported in the last `ALERT_EXPIRY`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAlert {
    pub kind: CohostAlertKind,
    /// Distinct authors who reported it.
    pub viewers: u32,
    pub last_seen_at: String,
    /// At least two distinct authors reported it within 60 s of each other.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostMoodScores {
    pub hype: f64,
    pub tension: f64,
    pub confusion: f64,
}

/// What the last failed tick actually said, so the toast, the chip and a bug
/// report can name the error instead of "AI returned an error". `code` is the
/// server's envelope code verbatim (or a desktop-assigned `network` /
/// `timeout` / `malformed-response`), `status` the HTTP status when one was
/// received. Cleared the moment the engine is listening again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostErrorDetail {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

impl CohostErrorDetail {
    pub fn new(code: impl Into<String>, message: impl Into<String>, status: Option<u16>) -> Self {
        let message: String = message.into();
        Self {
            code: code.into(),
            message: truncate_chars(message.trim(), ERROR_DETAIL_MESSAGE_MAX_CHARS),
            status,
        }
    }
}

/// The `cohost.state` event payload and the result of every `cohost.*` RPC.
/// Nullable fields serialize as explicit `null` (the renderer reducer keys on
/// them), never as absent keys. `detail` and the presence fields are
/// additionally `default` on read so a payload from before they existed still
/// parses. The wire-v2 fields are the exception: they are omitted while empty
/// (`skip_serializing_if`), because the renderer contract treats them as
/// optional and rejects `null`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostState {
    pub session_id: Option<String>,
    pub status: CohostStatus,
    pub reason: Option<CohostReason>,
    /// Present only while `reason` describes a failed tick (status `error`, or
    /// `paused` by the server: quota, Premium, consent).
    #[serde(default)]
    pub detail: Option<CohostErrorDetail>,
    pub questions: Vec<CohostQuestion>,
    pub flags: Vec<CohostFlag>,
    pub mood: Option<CohostMood>,
    pub last_tick_at: Option<String>,
    pub tick_seq: u64,
    pub partial: bool,
    /// A tick HTTP request is outstanding right now ("thinking").
    #[serde(default)]
    pub tick_in_flight: bool,
    /// Delta messages collected but not yet sent in a tick — "I've seen your
    /// chat and I'm on it".
    #[serde(default)]
    pub pending_messages: u32,
    /// ISO-8601 instant of the scheduler's earliest possible next pass, present
    /// only while `pending_messages > 0`: the burst rule (>= 5 pending) fires as
    /// soon as the 8 s min gap allows, the trickle rule at anchor + 20 s, and a
    /// backoff/quota window pushes both back.
    #[serde(default)]
    pub next_tick_at: Option<String>,
    /// Session total of chat messages noted to the engine (entered a delta).
    #[serde(default)]
    pub messages_seen: u64,
    /// Distinct question ids this session ever surfaced — lifetime count, not
    /// the open count.
    #[serde(default)]
    pub questions_total: u64,
    /// Latest tick's suggested comments, best first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<CohostHighlight>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<CohostAlert>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood_scores: Option<CohostMoodScores>,
}

impl CohostState {
    pub fn off() -> Self {
        Self {
            session_id: None,
            status: CohostStatus::Off,
            reason: None,
            detail: None,
            questions: Vec::new(),
            flags: Vec::new(),
            mood: None,
            last_tick_at: None,
            tick_seq: 0,
            partial: false,
            tick_in_flight: false,
            pending_messages: 0,
            next_tick_at: None,
            messages_seen: 0,
            questions_total: 0,
            highlights: Vec::new(),
            alerts: Vec::new(),
            mood_scores: None,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CohostError {
    #[error("Co-host is turned off in Settings.")]
    Disabled,
    #[error("Co-host needs the active live chat session; sessionId did not match.")]
    SessionMismatch,
    #[error("sessionId and the question or message id are required.")]
    InvalidParams,
    #[error("Could not persist co-host settings: {0}")]
    Storage(String),
}

impl CohostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "cohost-disabled",
            Self::SessionMismatch => "cohost-session-mismatch",
            Self::InvalidParams => "invalid-params",
            Self::Storage(_) => "cohost-settings-storage-failed",
        }
    }
}

// --- Engine ----------------------------------------------------------------------

pub type CohostSlot = Arc<Mutex<CohostEngine>>;

pub fn new_cohost_slot(settings: CohostSettings) -> CohostSlot {
    Arc::new(Mutex::new(CohostEngine::new(settings)))
}

/// Why the scheduler did not send a request on this pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TickGate {
    /// Scheduler must exit: its session/generation was replaced.
    Stopped,
    /// Nothing to do right now.
    Idle,
    /// A precondition is unmet; the engine is paused with the reason.
    Paused(CohostReason),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedTick {
    pub(crate) request: CohostTickRequest,
    pub(crate) generation: u64,
}

/// One viewer saying "something is broken" (`alerts[]`), kept until it expires
/// so the state can count distinct authors per kind.
#[derive(Debug, Clone)]
struct AlertReport {
    kind: CohostAlertKind,
    author: String,
    at: Instant,
    at_iso: String,
}

struct CohostSession {
    session_id: String,
    generation: u64,
    consent: bool,
    stream_title: Option<String>,
    status: CohostStatus,
    reason: Option<CohostReason>,
    detail: Option<CohostErrorDetail>,
    questions: Vec<CohostQuestion>,
    flags: Vec<CohostFlag>,
    mood: Option<CohostMood>,
    tick_seq: u64,
    partial: bool,
    started_at: Instant,
    last_tick_at: Option<Instant>,
    last_tick_iso: Option<String>,
    /// `(received_at, id)` of the newest noted message; rows at or before it
    /// are replays and never re-enter the delta.
    cursor: Option<(String, String)>,
    /// Oldest-first delta since the last tick, capped to the newest
    /// `TICK_DELTA_CAP` rows.
    pending: VecDeque<CohostTickMessage>,
    dropped: u64,
    known_ids: VecDeque<String>,
    known_set: HashSet<String>,
    dismissed_questions: HashSet<String>,
    dismissed_flags: HashSet<String>,
    backoff_index: usize,
    next_attempt_at: Option<Instant>,
    in_flight: bool,
    /// Session total of messages that entered a delta (presence indicator).
    messages_seen: u64,
    /// Every question id this session ever surfaced, so `questions_total`
    /// counts each grouped question exactly once across ticks.
    counted_question_ids: HashSet<String>,
    questions_total: u64,
    /// Wire version this session speaks: v2 until the server answers
    /// `prompt-version-unsupported`, then v1 until the session ends.
    prompt_version: u32,
    /// The version fallback just happened: the rejected batch is back in the
    /// delta and goes out again as soon as the min gap allows.
    version_retry: bool,
    /// What the outstanding tick sent: the batch (restored on a version
    /// fallback) and the rules its `ruleIndex` values point into.
    in_flight_messages: Vec<CohostTickMessage>,
    in_flight_dropped: u64,
    in_flight_rules: Vec<String>,
    /// Author identity per known message id, for distinct-author alert counts.
    authors: HashMap<String, String>,
    /// Known rows that were deleted after they were sent in a tick.
    deleted_ids: HashSet<String>,
    highlights: Vec<CohostHighlight>,
    alert_reports: Vec<AlertReport>,
    mood_scores: Option<CohostMoodScores>,
}

impl CohostSession {
    fn new(
        session_id: String,
        generation: u64,
        consent: bool,
        stream_title: Option<String>,
        now: Instant,
    ) -> Self {
        Self {
            session_id,
            generation,
            consent,
            stream_title,
            status: CohostStatus::Listening,
            reason: None,
            detail: None,
            questions: Vec::new(),
            flags: Vec::new(),
            mood: None,
            tick_seq: 0,
            partial: false,
            started_at: now,
            last_tick_at: None,
            last_tick_iso: None,
            cursor: None,
            pending: VecDeque::new(),
            dropped: 0,
            known_ids: VecDeque::new(),
            known_set: HashSet::new(),
            dismissed_questions: HashSet::new(),
            dismissed_flags: HashSet::new(),
            backoff_index: 0,
            next_attempt_at: None,
            in_flight: false,
            messages_seen: 0,
            counted_question_ids: HashSet::new(),
            questions_total: 0,
            prompt_version: COHOST_PROMPT_VERSION,
            version_retry: false,
            in_flight_messages: Vec::new(),
            in_flight_dropped: 0,
            in_flight_rules: Vec::new(),
            authors: HashMap::new(),
            deleted_ids: HashSet::new(),
            highlights: Vec::new(),
            alert_reports: Vec::new(),
            mood_scores: None,
        }
    }

    fn snapshot(&self) -> CohostState {
        self.snapshot_at(Instant::now())
    }

    fn snapshot_at(&self, now: Instant) -> CohostState {
        let next_tick_at = next_tick_due_at(
            self.cadence_pending(),
            self.last_tick_at.unwrap_or(self.started_at),
            self.last_tick_at,
            self.next_attempt_at,
            now,
        )
        .map(|due| iso_after(now, due));
        CohostState {
            session_id: Some(self.session_id.clone()),
            status: self.status,
            reason: self.reason,
            detail: self.detail.clone(),
            questions: self.questions.clone(),
            flags: self.flags.clone(),
            mood: self.mood,
            last_tick_at: self.last_tick_iso.clone(),
            tick_seq: self.tick_seq,
            partial: self.partial,
            tick_in_flight: self.in_flight,
            pending_messages: u32::try_from(self.pending.len()).unwrap_or(u32::MAX),
            next_tick_at,
            messages_seen: self.messages_seen,
            questions_total: self.questions_total,
            highlights: self.highlights.clone(),
            alerts: self.alerts_at(now),
            mood_scores: self.mood_scores,
        }
    }

    /// Pending count as the cadence rules see it. After a version fallback the
    /// restored batch counts as a burst, so it is retried as soon as the 8 s
    /// min gap allows instead of waiting out the 20 s trickle rule.
    fn cadence_pending(&self) -> usize {
        if self.version_retry && !self.pending.is_empty() {
            self.pending.len().max(TICK_BURST_THRESHOLD)
        } else {
            self.pending.len()
        }
    }

    /// One entry per alert kind with an unexpired report, in first-reported
    /// order. `active` needs two distinct authors within the corroboration
    /// window; a single viewer never raises the chip.
    fn alerts_at(&self, now: Instant) -> Vec<CohostAlert> {
        let live: Vec<&AlertReport> = self
            .alert_reports
            .iter()
            .filter(|report| now.saturating_duration_since(report.at) < ALERT_EXPIRY)
            .collect();
        let mut kinds: Vec<CohostAlertKind> = Vec::new();
        for report in &live {
            if !kinds.contains(&report.kind) {
                kinds.push(report.kind);
            }
        }
        kinds
            .into_iter()
            .filter_map(|kind| {
                let reports: Vec<&AlertReport> = live
                    .iter()
                    .copied()
                    .filter(|report| report.kind == kind)
                    .collect();
                let last = reports.iter().max_by_key(|report| report.at)?;
                let authors: HashSet<&str> = reports
                    .iter()
                    .map(|report| report.author.as_str())
                    .collect();
                let active = reports.iter().any(|anchor| {
                    let corroborating: HashSet<&str> = reports
                        .iter()
                        .filter(|report| {
                            report.at >= anchor.at
                                && report.at.duration_since(anchor.at) <= ALERT_CORROBORATION_WINDOW
                        })
                        .map(|report| report.author.as_str())
                        .collect();
                    corroborating.len() >= ALERT_MIN_AUTHORS
                });
                Some(CohostAlert {
                    kind,
                    viewers: u32::try_from(authors.len()).unwrap_or(u32::MAX),
                    last_seen_at: last.at_iso.clone(),
                    active,
                })
            })
            .collect()
    }

    fn remember_id(&mut self, id: &str, author: String) {
        if self.known_set.insert(id.to_string()) {
            self.known_ids.push_back(id.to_string());
            self.authors.insert(id.to_string(), author);
            while self.known_ids.len() > KNOWN_MESSAGE_IDS_CAP {
                if let Some(evicted) = self.known_ids.pop_front() {
                    self.known_set.remove(&evicted);
                    self.authors.remove(&evicted);
                    self.deleted_ids.remove(&evicted);
                }
            }
        }
    }

    /// Buffer eligible rows newer than the cursor. Tombstones for a pending
    /// row pull it out of the delta (deleted messages never reach the model).
    fn note_messages(&mut self, messages: &[LiveChatMessage]) -> usize {
        let mut noted = 0;
        let mut ordered: Vec<&LiveChatMessage> = messages
            .iter()
            .filter(|message| message.session_id == self.session_id)
            .collect();
        ordered.sort_by(|a, b| (&a.received_at, &a.id).cmp(&(&b.received_at, &b.id)));
        for message in ordered {
            if message.is_deleted || message.event_type == LiveChatEventType::Deleted {
                self.pending.retain(|pending| pending.id != message.id);
                // A deleted comment is never suggested for the stream.
                if self.known_set.contains(&message.id) {
                    self.deleted_ids.insert(message.id.clone());
                    self.highlights
                        .retain(|highlight| highlight.message_id != message.id);
                }
                continue;
            }
            let key = (message.received_at.clone(), message.id.clone());
            if self.cursor.as_ref().is_some_and(|cursor| key <= *cursor)
                || self.known_set.contains(&message.id)
            {
                continue;
            }
            self.cursor = Some(key);
            let Some(mapped) = tick_message_from_chat(message) else {
                continue;
            };
            self.remember_id(&message.id, alert_author_key(message));
            self.pending.push_back(mapped);
            while self.pending.len() > TICK_DELTA_CAP {
                self.pending.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }
            noted += 1;
        }
        self.messages_seen = self.messages_seen.saturating_add(noted as u64);
        noted
    }

    fn tick_due(&self, now: Instant) -> bool {
        if self.in_flight {
            return false;
        }
        if self.next_attempt_at.is_some_and(|at| now < at) {
            return false;
        }
        tick_due(
            self.cadence_pending(),
            self.last_tick_at.unwrap_or(self.started_at),
            self.last_tick_at,
            now,
        )
    }

    fn build_request(&mut self, settings: &CohostSettings, now: Instant) -> CohostTickRequest {
        self.tick_seq = self.tick_seq.saturating_add(1);
        self.last_tick_at = Some(now);
        self.in_flight = true;
        self.version_retry = false;
        let messages: Vec<CohostTickMessage> = self.pending.drain(..).collect();
        let dropped_messages = std::mem::take(&mut self.dropped);
        // v1 fallback: no `rules` key at all, so the body stays byte-identical
        // to what a v1 desktop sends.
        let rules = (self.prompt_version >= COHOST_PROMPT_VERSION).then(|| settings.rules.clone());
        self.in_flight_messages = messages.clone();
        self.in_flight_dropped = dropped_messages;
        self.in_flight_rules = rules.clone().unwrap_or_default();
        let open_questions = self
            .questions
            .iter()
            .take(TICK_OPEN_QUESTIONS_CAP)
            .map(|question| CohostTickOpenQuestion {
                id: question.id.clone(),
                text: question.text.clone(),
                count: u32::try_from(question.askers.len().max(1)).unwrap_or(u32::MAX),
            })
            .collect();
        CohostTickRequest {
            client_version: DESKTOP_CLIENT_VERSION.to_string(),
            session_client_id: self.session_id.clone(),
            tick_seq: self.tick_seq,
            prompt_version: self.prompt_version,
            consent_to_process_chat: self.consent,
            tone: settings.tone,
            notes: settings.notes.clone(),
            rules,
            stream_title: self.stream_title.clone(),
            open_questions,
            messages,
            dropped_messages,
        }
    }

    /// Merge a successful tick. `questions` is the full open set: existing ids
    /// keep `first_seen_at`, `resolved` ids leave, dismissed ids never return,
    /// and message ids are sanitized against rows this engine actually sent.
    /// With `keepQuestions` (v2) the server skipped regeneration: the open set
    /// stays as it is and only `resolved` ids leave.
    fn apply_response(
        &mut self,
        response: CohostTickResponse,
        dropped: u64,
        now: Instant,
        now_iso: &str,
    ) {
        self.in_flight = false;
        self.in_flight_messages.clear();
        self.in_flight_dropped = 0;
        let sent_rules = std::mem::take(&mut self.in_flight_rules);
        self.backoff_index = 0;
        self.next_attempt_at = None;
        self.status = CohostStatus::Listening;
        self.reason = None;
        self.detail = None;
        self.last_tick_iso = Some(now_iso.to_string());
        self.partial = dropped > 0;
        self.mood = response.mood.map(|mood| match mood {
            CohostMood::Unknown => CohostMood::Mixed,
            known => known,
        });
        self.mood_scores = response.mood_scores.map(|scores| CohostMoodScores {
            hype: unit_interval(scores.hype).unwrap_or(0.0),
            tension: unit_interval(scores.tension).unwrap_or(0.0),
            confusion: unit_interval(scores.confusion).unwrap_or(0.0),
        });

        let resolved: HashSet<String> = response.resolved.into_iter().collect();
        if response.keep_questions {
            self.questions
                .retain(|question| !resolved.contains(&question.id));
        } else {
            self.replace_questions(response.questions, &resolved, now_iso);
        }

        for flag in response.flags {
            if !self.known_set.contains(&flag.message_id)
                || self.dismissed_flags.contains(&flag.message_id)
                || self
                    .flags
                    .iter()
                    .any(|existing| existing.message_id == flag.message_id)
            {
                continue;
            }
            let mut also_kinds: Vec<CohostFlagKind> = Vec::new();
            for kind in flag.also_kinds {
                if kind != CohostFlagKind::Unknown
                    && kind != flag.kind
                    && !also_kinds.contains(&kind)
                {
                    also_kinds.push(kind);
                }
            }
            self.flags.push(CohostFlag {
                message_id: flag.message_id,
                kind: flag.kind,
                severity: match flag.severity {
                    CohostFlagSeverity::Unknown => CohostFlagSeverity::Medium,
                    known => known,
                },
                reason: flag.reason,
                at: now_iso.to_string(),
                confidence: flag.confidence.and_then(unit_interval),
                target: flag
                    .target
                    .filter(|target| *target != CohostFlagTarget::Unknown),
                action: flag
                    .action
                    .filter(|action| *action != CohostFlagAction::Unknown),
                also_kinds,
                // Resolved against the rules THIS tick sent: the streamer may
                // have edited the list while the request was in flight.
                rule: (flag.kind == CohostFlagKind::Rule)
                    .then(|| flag.rule_index.and_then(|index| sent_rules.get(index)))
                    .flatten()
                    .cloned(),
            });
        }
        while self.flags.len() > FLAGS_CAP {
            self.flags.remove(0);
        }

        // Latest set wins. A flagged (or flag-dismissed) or deleted message is
        // never suggested, whatever the server ranked.
        let mut highlights: Vec<CohostHighlight> = Vec::new();
        for highlight in response.highlights {
            let id = &highlight.message_id;
            if !self.known_set.contains(id)
                || self.deleted_ids.contains(id)
                || self.dismissed_flags.contains(id)
                || self.flags.iter().any(|flag| &flag.message_id == id)
                || highlights.iter().any(|kept| &kept.message_id == id)
            {
                continue;
            }
            highlights.push(CohostHighlight {
                message_id: highlight.message_id,
                score: unit_interval(highlight.score).unwrap_or(0.0),
                highlight_type: match highlight.highlight_type {
                    CohostHighlightType::Unknown => CohostHighlightType::Other,
                    known => known,
                },
            });
            if highlights.len() >= HIGHLIGHTS_CAP {
                break;
            }
        }
        self.highlights = highlights;

        self.alert_reports
            .retain(|report| now.saturating_duration_since(report.at) < ALERT_EXPIRY);
        for alert in response.alerts {
            let Some(author) = self.authors.get(&alert.message_id) else {
                continue;
            };
            self.alert_reports.push(AlertReport {
                kind: match alert.kind {
                    CohostAlertKind::Unknown => CohostAlertKind::Other,
                    known => known,
                },
                author: author.clone(),
                at: now,
                at_iso: now_iso.to_string(),
            });
        }
    }

    fn replace_questions(
        &mut self,
        incoming_questions: Vec<CohostTickQuestion>,
        resolved: &HashSet<String>,
        now_iso: &str,
    ) {
        let mut next_questions = Vec::with_capacity(incoming_questions.len());
        for incoming in incoming_questions {
            if incoming.id.trim().is_empty()
                || resolved.contains(&incoming.id)
                || self.dismissed_questions.contains(&incoming.id)
            {
                continue;
            }
            let existing = self
                .questions
                .iter()
                .find(|question| question.id == incoming.id);
            // The server only sees (and validates against) the current batch,
            // and openQuestions carry no ids, so a kept question must keep the
            // sources it accumulated in earlier ticks: union, never replace.
            let mut message_ids: Vec<String> = existing
                .map(|question| question.message_ids.clone())
                .unwrap_or_default();
            for id in incoming.message_ids {
                if self.known_set.contains(&id) && !message_ids.contains(&id) {
                    message_ids.push(id);
                }
            }
            if self.counted_question_ids.insert(incoming.id.clone()) {
                self.questions_total = self.questions_total.saturating_add(1);
            }
            next_questions.push(CohostQuestion {
                id: incoming.id,
                text: incoming.text,
                message_ids,
                askers: incoming.askers,
                platforms: incoming.platforms,
                priority: match incoming.priority {
                    CohostPriority::Unknown => CohostPriority::Normal,
                    known => known,
                },
                suggested_reply: incoming.suggested_reply,
                from_notes: incoming.from_notes,
                first_seen_at: existing
                    .map(|question| question.first_seen_at.clone())
                    .unwrap_or_else(|| now_iso.to_string()),
                updated_at: now_iso.to_string(),
            });
            if next_questions.len() >= TICK_OPEN_QUESTIONS_CAP {
                break;
            }
        }
        self.questions = next_questions;
    }

    fn apply_failure(&mut self, error: &CohostApiError, now: Instant) {
        self.in_flight = false;
        let batch = std::mem::take(&mut self.in_flight_messages);
        let batch_dropped = std::mem::take(&mut self.in_flight_dropped);
        self.in_flight_rules.clear();
        if error.kind == CohostApiErrorKind::PromptVersionUnsupported
            && self.prompt_version != COHOST_PROMPT_VERSION_FALLBACK
        {
            // The server rolled back to v1. Not a failure the streamer should
            // see: no pause, no error status, no backoff. Speak v1 for the rest
            // of the session and put the rejected batch back in front of
            // whatever arrived meanwhile so nothing is lost.
            self.prompt_version = COHOST_PROMPT_VERSION_FALLBACK;
            self.version_retry = true;
            self.dropped = self.dropped.saturating_add(batch_dropped);
            for message in batch.into_iter().rev() {
                self.pending.push_front(message);
            }
            while self.pending.len() > TICK_DELTA_CAP {
                self.pending.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }
            return;
        }
        let reason = error.reason();
        match error.kind {
            CohostApiErrorKind::QuotaExhausted { retry_after } => {
                self.status = CohostStatus::Paused;
                self.next_attempt_at = Some(now + retry_after.unwrap_or(QUOTA_DEFAULT_RETRY));
            }
            CohostApiErrorKind::PremiumRequired | CohostApiErrorKind::ConsentRequired => {
                self.status = CohostStatus::Paused;
                self.next_attempt_at = Some(now + PRECONDITION_RECHECK);
            }
            _ => {
                self.status = CohostStatus::Error;
                let step = BACKOFF_STEPS_SECS[self.backoff_index.min(BACKOFF_STEPS_SECS.len() - 1)];
                self.backoff_index = (self.backoff_index + 1).min(BACKOFF_STEPS_SECS.len() - 1);
                self.next_attempt_at = Some(now + Duration::from_secs(step));
            }
        }
        self.reason = Some(reason);
        // Every failed tick carries what the server (or the transport) said;
        // the renderer decides how much of it to show per reason.
        self.detail = Some(error.detail.clone());
    }

    /// A local precondition pause (signed out, Basic, no consent). Not a tick
    /// failure, so any earlier tick detail is stale and leaves with it.
    fn pause(&mut self, reason: CohostReason, now: Instant) -> bool {
        let changed = self.status != CohostStatus::Paused || self.reason != Some(reason);
        self.status = CohostStatus::Paused;
        self.reason = Some(reason);
        self.detail = None;
        self.next_attempt_at = Some(now + PRECONDITION_RECHECK);
        changed
    }

    fn mark_answered(&mut self, question_id: &str) -> bool {
        let before = self.questions.len();
        self.questions.retain(|question| question.id != question_id);
        self.dismissed_questions.insert(question_id.to_string());
        before != self.questions.len()
    }

    fn dismiss_flag(&mut self, message_id: &str) -> bool {
        let before = self.flags.len();
        self.highlights
            .retain(|highlight| highlight.message_id != message_id);
        self.flags.retain(|flag| flag.message_id != message_id);
        self.dismissed_flags.insert(message_id.to_string());
        before != self.flags.len()
    }
}

/// Cadence rule, pure for the test matrix: tick when at least five new rows
/// arrived, or at least one arrived and 20 s passed since the anchor (last
/// tick, else engine start); never within 8 s of the previous tick; never on
/// an empty delta.
pub(crate) fn tick_due(
    pending: usize,
    anchor: Instant,
    last_tick: Option<Instant>,
    now: Instant,
) -> bool {
    if pending == 0 {
        return false;
    }
    if last_tick.is_some_and(|last| now.duration_since(last) < TICK_MIN_GAP) {
        return false;
    }
    if pending >= TICK_BURST_THRESHOLD {
        return true;
    }
    now.duration_since(anchor) >= TICK_IDLE_INTERVAL
}

/// Earliest instant the scheduler could send the next tick, pure for the test
/// matrix and `None` on an empty delta. The burst rule (>= 5 pending) fires as
/// soon as the 8 s min gap allows; the trickle rule fires at anchor + 20 s; a
/// backoff/quota `next_attempt_at` pushes both back. Never in the past.
pub(crate) fn next_tick_due_at(
    pending: usize,
    anchor: Instant,
    last_tick: Option<Instant>,
    next_attempt_at: Option<Instant>,
    now: Instant,
) -> Option<Instant> {
    if pending == 0 {
        return None;
    }
    let mut due = if pending >= TICK_BURST_THRESHOLD {
        now
    } else {
        anchor + TICK_IDLE_INTERVAL
    };
    if let Some(last) = last_tick {
        due = due.max(last + TICK_MIN_GAP);
    }
    if let Some(attempt) = next_attempt_at {
        due = due.max(attempt);
    }
    Some(due.max(now))
}

/// Wall-clock ISO-8601 for a monotonic instant `due` relative to `now`.
fn iso_after(now: Instant, due: Instant) -> String {
    let delta = chrono::Duration::from_std(due.saturating_duration_since(now))
        .unwrap_or_else(|_| chrono::Duration::zero());
    (chrono::Utc::now() + delta).to_rfc3339()
}

/// Emission bucket for `pending_messages`: `cohost.state` is pushed when the
/// bucket changes (0 -> 1, then every +5), never per message.
pub(crate) fn pending_bucket(pending: usize) -> usize {
    if pending == 0 {
        0
    } else {
        1 + (pending - 1) / 5
    }
}

/// Map one chat row onto the tick wire shape. Non-`message` events (paid,
/// membership, system, moderation), tombstones, and custom RTMP rows (no chat
/// platform) are excluded.
pub(crate) fn tick_message_from_chat(message: &LiveChatMessage) -> Option<CohostTickMessage> {
    if message.is_deleted || message.event_type != LiveChatEventType::Message {
        return None;
    }
    if message.platform == StreamPlatform::Custom {
        return None;
    }
    let text = truncate_chars(message.message_text.trim(), TICK_MESSAGE_TEXT_MAX_CHARS);
    if text.is_empty() {
        return None;
    }
    let roles: Vec<String> = message
        .author_roles
        .iter()
        .filter_map(|role| normalize_role(role))
        .collect();
    Some(CohostTickMessage {
        id: message.id.clone(),
        platform: message.platform,
        author: message.author_name.clone(),
        roles: (!roles.is_empty()).then_some(roles),
        text,
        at: message.published_at.clone(),
    })
}

/// Who counts as one viewer for alert corroboration: the platform account when
/// the provider gave one, else the display name.
fn alert_author_key(message: &LiveChatMessage) -> String {
    let author = message
        .author_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| message.author_name.trim());
    format!(
        "{}:{author}",
        serde_json::to_string(&message.platform).unwrap_or_default()
    )
}

/// A wire probability clamped to 0..1; NaN/infinite reads as absent.
fn unit_interval(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, 1.0))
}

fn normalize_role(role: &str) -> Option<String> {
    let normalized = match role.trim().to_ascii_lowercase().as_str() {
        "moderator" | "mod" => "mod",
        "broadcaster" | "owner" => "owner",
        "subscriber" => "subscriber",
        "member" | "founder" => "member",
        "vip" => "vip",
        _ => return None,
    };
    ALLOWED_ROLES
        .contains(&normalized)
        .then(|| normalized.to_string())
}

pub struct CohostEngine {
    settings: CohostSettings,
    generation: u64,
    session: Option<CohostSession>,
    scheduler: Option<JoinHandle<()>>,
}

impl CohostEngine {
    pub fn new(settings: CohostSettings) -> Self {
        Self {
            settings: settings.normalized(),
            generation: 0,
            session: None,
            scheduler: None,
        }
    }

    pub fn settings(&self) -> &CohostSettings {
        &self.settings
    }

    pub fn snapshot(&self) -> CohostState {
        self.session
            .as_ref()
            .map(CohostSession::snapshot)
            .unwrap_or_else(CohostState::off)
    }

    fn is_running_for(&self, session_id: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.session_id == session_id)
    }

    /// Begin a session at `now`. Returns the new generation the scheduler must
    /// own; a late response from any earlier generation is dropped.
    fn start_session(
        &mut self,
        session_id: String,
        consent: bool,
        stream_title: Option<String>,
        now: Instant,
    ) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.session = Some(CohostSession::new(
            session_id,
            self.generation,
            consent,
            stream_title,
            now,
        ));
        self.generation
    }

    fn stop_session(&mut self) -> bool {
        if let Some(handle) = self.scheduler.take() {
            handle.abort();
        }
        self.generation = self.generation.wrapping_add(1);
        self.session.take().is_some()
    }

    pub(crate) fn note_messages(&mut self, messages: &[LiveChatMessage]) -> usize {
        self.session
            .as_mut()
            .map(|session| session.note_messages(messages))
            .unwrap_or(0)
    }

    /// Messages buffered for the next tick (0 without a session).
    pub(crate) fn pending_len(&self) -> usize {
        self.session
            .as_ref()
            .map(|session| session.pending.len())
            .unwrap_or(0)
    }

    fn highlights_len(&self) -> usize {
        self.session
            .as_ref()
            .map(|session| session.highlights.len())
            .unwrap_or(0)
    }

    /// Decide whether the scheduler owning `generation` should send a tick now.
    /// `signed_in`, `premium`, and the session's consent are the run
    /// preconditions; each maps to a paused reason rather than a request.
    pub(crate) fn prepare_tick(
        &mut self,
        generation: u64,
        signed_in: bool,
        premium: bool,
        now: Instant,
    ) -> Result<PreparedTick, TickGate> {
        if !self.settings.enabled {
            return Err(TickGate::Stopped);
        }
        let settings = self.settings.clone();
        let Some(session) = self.session.as_mut() else {
            return Err(TickGate::Stopped);
        };
        if session.generation != generation {
            return Err(TickGate::Stopped);
        }
        if session.in_flight || session.next_attempt_at.is_some_and(|at| now < at) {
            return Err(TickGate::Idle);
        }
        let precondition = if !premium {
            Some(CohostReason::PremiumRequired)
        } else if !session.consent {
            Some(CohostReason::ConsentRequired)
        } else if !signed_in {
            Some(CohostReason::SignedOut)
        } else {
            None
        };
        if let Some(reason) = precondition {
            return Err(if session.pause(reason, now) {
                TickGate::Paused(reason)
            } else {
                TickGate::Idle
            });
        }
        if !session.tick_due(now) {
            return Err(TickGate::Idle);
        }
        Ok(PreparedTick {
            request: session.build_request(&settings, now),
            generation,
        })
    }

    /// Merge a tick outcome. Returns false (and changes nothing) when the
    /// response belongs to a replaced session or generation.
    pub(crate) fn apply_tick_result(
        &mut self,
        generation: u64,
        dropped: u64,
        result: Result<CohostTickResponse, CohostApiError>,
        now: Instant,
        now_iso: &str,
    ) -> bool {
        let Some(session) = self.session.as_mut() else {
            return false;
        };
        if session.generation != generation {
            return false;
        }
        match result {
            Ok(response) => session.apply_response(response, dropped, now, now_iso),
            Err(error) => session.apply_failure(&error, now),
        }
        true
    }

    fn mark_answered(&mut self, session_id: &str, question_id: &str) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.mark_answered(question_id))
    }

    fn dismiss_flag(&mut self, session_id: &str, message_id: &str) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.dismiss_flag(message_id))
    }
}

// --- AppState integration ------------------------------------------------------------

fn emit_state(state: &AppState, snapshot: &CohostState, _lifecycle_delivery: &OwnedMutexGuard<()>) {
    state.emit_event(COHOST_STATE_EVENT, snapshot.clone());
}

pub async fn cohost_status(state: &AppState) -> CohostState {
    state.cohost.lock().await.snapshot()
}

pub async fn get_cohost_settings(state: &AppState) -> CohostSettings {
    state.cohost.lock().await.settings().clone()
}

/// Persist a settings patch and apply it to the running engine. Turning the
/// co-host off stops an active session immediately.
pub async fn set_cohost_settings(
    state: &AppState,
    patch: CohostSettingsPatch,
) -> Result<CohostSettings, CohostError> {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let mut next = engine.settings.clone();
    next.apply(patch);
    state
        .database
        .save_setting(COHOST_SETTINGS_KEY, &next)
        .map_err(|error| CohostError::Storage(error.to_string()))?;
    engine.settings = next.clone();
    let stopped = !next.enabled && engine.session.is_some() && engine.stop_session();
    let snapshot = engine.snapshot();
    drop(engine);
    if stopped {
        state.emit_log("info", "Co-host stopped: turned off in Settings.");
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(next)
}

/// Start the engine for the active live-chat session. Consent is renderer-owned
/// (the cloud-AI consent toggle lives in renderer storage), so the renderer
/// passes it explicitly; without it the engine pauses with `consent-required`
/// instead of ever sending chat to the server.
pub async fn start_cohost(
    state: &AppState,
    params: CohostStartParams,
) -> Result<CohostState, CohostError> {
    start_cohost_after_chat_validation(
        state,
        params,
        std::future::ready(()),
        std::future::ready(()),
    )
    .await
}

async fn start_cohost_after_chat_validation<F, G>(
    state: &AppState,
    params: CohostStartParams,
    after_chat_validation: F,
    before_state_emit: G,
) -> Result<CohostState, CohostError>
where
    F: std::future::Future<Output = ()>,
    G: std::future::Future<Output = ()>,
{
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(CohostError::InvalidParams);
    }
    // Chat replacement/retirement and co-host admission are one session
    // lifecycle transaction. Keep this fence from validation through the
    // authoritative state publication, but never hold the chat coordinator
    // lock while awaiting the co-host lock.
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let chat_session_id = state
        .live_chat
        .lock()
        .await
        .session_id()
        .map(str::to_string);
    if chat_session_id.as_deref() != Some(session_id.as_str()) {
        return Err(CohostError::SessionMismatch);
    }
    after_chat_validation.await;

    let mut engine = state.cohost.lock().await;
    if !engine.settings.enabled {
        return Err(CohostError::Disabled);
    }
    if engine.is_running_for(&session_id) {
        return Ok(engine.snapshot());
    }
    engine.stop_session();
    let generation = engine.start_session(
        session_id.clone(),
        params.consent_to_process_chat,
        params
            .stream_title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty()),
        Instant::now(),
    );
    engine.scheduler = Some(spawn_scheduler(state.clone(), generation));
    let snapshot = engine.snapshot();
    drop(engine);
    before_state_emit.await;
    state.emit_log(
        "info",
        format!("Co-host listening for session {session_id}."),
    );
    emit_state(state, &snapshot, &lifecycle_delivery);
    drop(lifecycle_delivery);
    Ok(snapshot)
}

pub async fn stop_cohost(state: &AppState) -> CohostState {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    stop_cohost_under_lifecycle_fence(state, &lifecycle_delivery, std::future::ready(())).await
}

async fn stop_cohost_under_lifecycle_fence<F>(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
) -> CohostState
where
    F: std::future::Future<Output = ()>,
{
    let mut engine = state.cohost.lock().await;
    let stopped = engine.stop_session();
    let snapshot = engine.snapshot();
    drop(engine);
    before_state_emit.await;
    if stopped {
        state.emit_log("info", "Co-host stopped.");
        emit_state(state, &snapshot, lifecycle_delivery);
    }
    snapshot
}

/// Live-chat session boundary (stop, or a replacing start): drop the engine
/// session so no late tick can publish into the next stream.
pub(crate) async fn stop_cohost_for_session_end_under_lifecycle_fence(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
) {
    stop_cohost_under_lifecycle_fence(state, lifecycle_delivery, std::future::ready(())).await;
}

/// Recording monitors are generation-late by construction: final media work
/// can overlap admission of a replacement session. Stop the co-host only when
/// it still belongs to the recording session that just retired.
pub(crate) async fn stop_cohost_for_session_end_if_matching_before_emit<F>(
    state: &AppState,
    expected_session_id: &str,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
) where
    F: std::future::Future<Output = ()>,
{
    stop_cohost_for_session_end_if_matching_impl(
        state,
        expected_session_id,
        lifecycle_delivery,
        before_state_emit,
    )
    .await;
}

async fn stop_cohost_for_session_end_if_matching_impl<F>(
    state: &AppState,
    expected_session_id: &str,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
) where
    F: std::future::Future<Output = ()>,
{
    let mut engine = state.cohost.lock().await;
    if !engine.is_running_for(expected_session_id) {
        return;
    }
    let stopped = engine.stop_session();
    let snapshot = engine.snapshot();
    drop(engine);
    before_state_emit.await;
    if stopped {
        state.emit_log("info", "Co-host stopped.");
        emit_state(state, &snapshot, lifecycle_delivery);
    }
}

/// Delivery-path hook: remember eligible rows for the next tick. Rows from a
/// different session are ignored by the engine's own guard. The UI learns
/// about queued chat when `pending_messages` crosses an emission bucket
/// (0 -> 1, then every +5) — a reaction per wave, never a per-message storm.
pub(crate) async fn note_messages_under_lifecycle_fence(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    messages: &[LiveChatMessage],
) {
    if messages.is_empty() {
        return;
    }
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        if engine.session.is_none() {
            return;
        }
        let bucket_before = pending_bucket(engine.pending_len());
        let highlights_before = engine.highlights_len();
        engine.note_messages(messages);
        let bucket_after = pending_bucket(engine.pending_len());
        // A tombstone that pulled a suggested comment is also news: the
        // renderer must stop offering it now, not at the next tick.
        if bucket_before == bucket_after && highlights_before == engine.highlights_len() {
            return;
        }
        engine.snapshot()
    };
    emit_state(state, &snapshot, lifecycle_delivery);
}

#[cfg(test)]
async fn note_messages(state: &AppState, messages: &[LiveChatMessage]) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    note_messages_under_lifecycle_fence(state, &lifecycle_delivery, messages).await;
}

pub async fn mark_question_answered(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.mark_answered(&params.session_id, &params.question_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// Dismiss and answered share one outcome for the engine: the question leaves
/// the open set and its id never returns from a later tick.
pub async fn dismiss_question(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    mark_question_answered(state, params).await
}

/// `liveChat.send` completion hook: a terminal sent/partial delivery that
/// carried `inReplyToQuestionId` clears that question. A mismatched session is
/// not an error here — the send already succeeded.
pub(crate) async fn mark_question_answered_after_send(
    state: &AppState,
    session_id: &str,
    question_id: &str,
) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine
        .mark_answered(session_id, question_id)
        .unwrap_or(false);
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
}

pub async fn dismiss_flag(
    state: &AppState,
    params: CohostFlagParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.message_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.dismiss_flag(&params.session_id, &params.message_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

fn premium_entitled() -> bool {
    crate::entitlements::require_feature(
        &crate::entitlements::current_entitlements(),
        FeatureId::LiveCohost,
    )
    .is_ok()
}

fn spawn_scheduler(state: AppState, generation: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_POLL).await;
            if !run_scheduler_pass(&state, generation).await {
                break;
            }
        }
    })
}

/// One scheduler pass. Returns false when the scheduler must exit.
async fn run_scheduler_pass(state: &AppState, generation: u64) -> bool {
    let token = crate::account::stored_session_token();
    let premium = premium_entitled();
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let prepared = {
        let mut engine = state.cohost.lock().await;
        let prepared = engine.prepare_tick(generation, token.is_some(), premium, Instant::now());
        match prepared {
            // The snapshot taken here carries tick_in_flight=true and the
            // drained delta; emitting it below is the "thinking..." signal.
            Ok(prepared) => Ok((prepared, engine.snapshot())),
            Err(TickGate::Stopped) => return false,
            Err(TickGate::Idle) => return true,
            Err(TickGate::Paused(reason)) => Err((reason, engine.snapshot())),
        }
    };
    let (prepared, in_flight_snapshot) = match prepared {
        Ok(prepared) => prepared,
        Err((reason, snapshot)) => {
            state.emit_log(
                "warn",
                format!(
                    "Co-host paused: {}.",
                    serde_json::to_string(&reason).unwrap_or_default()
                ),
            );
            emit_state(state, &snapshot, &lifecycle_delivery);
            return true;
        }
    };
    // tick_in_flight toggles true exactly here and false in apply_tick_result;
    // both edges reach the renderer (this emit, and the post-tick emit below).
    emit_state(state, &in_flight_snapshot, &lifecycle_delivery);
    drop(lifecycle_delivery);
    let Some(token) = token else {
        return true;
    };
    let dropped = prepared.request.dropped_messages;
    let message_count = prepared.request.messages.len();
    let result = match VideorcApiClient::new() {
        Ok(client) => client.post_cohost_tick(&token, &prepared.request).await,
        Err(error) => Err(CohostApiError::network(error.to_string())),
    };
    let log = match &result {
        Ok(response) => Some((
            "info",
            format!(
                "Co-host tick {} merged: {} message(s), {} open question(s), {} flag(s).",
                prepared.request.tick_seq,
                message_count,
                response.questions.len(),
                response.flags.len()
            ),
        )),
        Err(error)
            if error.kind == CohostApiErrorKind::PromptVersionUnsupported
                && prepared.request.prompt_version != COHOST_PROMPT_VERSION_FALLBACK =>
        {
            Some((
                "info",
                format!(
                    "Co-host tick {}: the server does not speak tick contract v{}; using v{} for the rest of this session.",
                    prepared.request.tick_seq,
                    prepared.request.prompt_version,
                    COHOST_PROMPT_VERSION_FALLBACK
                ),
            ))
        }
        Err(error) => Some((
            "warn",
            format!(
                "Co-host tick {} failed ({}, {}{}): {}",
                prepared.request.tick_seq,
                serde_json::to_string(&error.reason()).unwrap_or_default(),
                error.detail.code,
                error
                    .detail
                    .status
                    .map(|status| format!(", HTTP {status}"))
                    .unwrap_or_default(),
                error.message()
            ),
        )),
    };
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        let applied = engine.apply_tick_result(
            prepared.generation,
            dropped,
            result,
            Instant::now(),
            &chrono::Utc::now().to_rfc3339(),
        );
        if !applied {
            state.emit_log(
                "warn",
                "Co-host tick response dropped: its session was replaced.",
            );
            return false;
        }
        engine.snapshot()
    };
    if let Some((level, message)) = log {
        state.emit_log(level, message);
    }
    emit_state(state, &snapshot, &lifecycle_delivery);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_chat::live_chat_message_id;
    use crate::storage::Database;
    use crate::videorc_api::{CohostTickFlag, CohostTickQuestion};
    use tokio::sync::broadcast;

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn chat_message(session_id: &str, seq: u32, received_at: &str) -> LiveChatMessage {
        let provider_message_id = format!("m-{seq}");
        LiveChatMessage {
            id: live_chat_message_id(
                session_id,
                StreamPlatform::Twitch,
                None,
                &provider_message_id,
            ),
            provider_message_id,
            platform: StreamPlatform::Twitch,
            target_id: None,
            session_id: session_id.to_string(),
            author_id: Some(format!("viewer-{}", seq % 3)),
            author_name: format!("Viewer {}", seq % 3),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: vec!["moderator".to_string(), "unknown-role".to_string()],
            published_at: format!("2026-08-22T10:00:{:02}Z", seq % 60),
            received_at: received_at.to_string(),
            message_text: format!("What keyboard is that? #{seq}"),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("twitch".to_string()),
        }
    }

    /// A classified server failure with its envelope, as `post_cohost_tick`
    /// would return it.
    fn server_error(status: u16, code: &str, message: &str) -> CohostApiError {
        crate::videorc_api::classify_cohost_failure(status, code, message.to_string(), None)
    }

    fn enabled_settings() -> CohostSettings {
        CohostSettings {
            enabled: true,
            tone: CohostTone::Short,
            notes: "Keyboard: Keychron Q1".to_string(),
            auto_highlight: false,
            rules: Vec::new(),
        }
    }

    fn running_engine(now: Instant) -> (CohostEngine, u64) {
        let mut engine = CohostEngine::new(enabled_settings());
        let generation = engine.start_session(
            "session-1".to_string(),
            true,
            Some("Rust night".into()),
            now,
        );
        (engine, generation)
    }

    fn messages(session_id: &str, range: std::ops::Range<u32>) -> Vec<LiveChatMessage> {
        range
            .map(|seq| {
                chat_message(
                    session_id,
                    seq,
                    &format!("2026-08-22T10:{:02}:{:02}Z", 1 + seq / 60, seq % 60),
                )
            })
            .collect()
    }

    fn response(questions: Vec<CohostTickQuestion>) -> CohostTickResponse {
        CohostTickResponse {
            prompt_version: COHOST_PROMPT_VERSION,
            questions,
            resolved: Vec::new(),
            flags: Vec::new(),
            mood: Some(CohostMood::Hype),
            ..CohostTickResponse::default()
        }
    }

    fn flag(
        message_id: &str,
        kind: CohostFlagKind,
        severity: CohostFlagSeverity,
    ) -> CohostTickFlag {
        CohostTickFlag {
            message_id: message_id.to_string(),
            kind,
            severity,
            reason: "reason".to_string(),
            confidence: None,
            target: None,
            action: None,
            also_kinds: Vec::new(),
            rule_index: None,
        }
    }

    fn question(id: &str, message_ids: &[&str]) -> CohostTickQuestion {
        CohostTickQuestion {
            id: id.to_string(),
            text: "What keyboard is that?".to_string(),
            message_ids: message_ids.iter().map(|id| id.to_string()).collect(),
            askers: vec!["Viewer 0".to_string(), "Viewer 1".to_string()],
            platforms: vec![StreamPlatform::Twitch],
            priority: CohostPriority::High,
            suggested_reply: "Keychron Q1!".to_string(),
            from_notes: true,
        }
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn cadence_matrix_matches_the_contract() {
        let start = Instant::now();
        // 0 new → never.
        assert!(!tick_due(0, start, None, start + secs(60)));
        // ≥5 new → immediately (no previous tick).
        assert!(tick_due(5, start, None, start + secs(1)));
        // 1 new → only after 20 s since the anchor.
        assert!(!tick_due(1, start, None, start + secs(19)));
        assert!(tick_due(1, start, None, start + secs(20)));
        // Never < 8 s after the previous tick, even for a burst.
        let last = start + secs(30);
        assert!(!tick_due(50, last, Some(last), last + secs(7)));
        assert!(tick_due(50, last, Some(last), last + secs(8)));
        // 1 new after a tick: waits for the 20 s idle window.
        assert!(!tick_due(1, last, Some(last), last + secs(19)));
        assert!(tick_due(1, last, Some(last), last + secs(20)));
        // 4 new after a tick: still below the burst threshold.
        assert!(!tick_due(4, last, Some(last), last + secs(12)));
    }

    #[test]
    fn engine_cadence_honors_backoff_and_in_flight() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(prepared.request.tick_seq, 1);
        assert_eq!(prepared.request.messages.len(), 5);
        // In flight: no second request.
        engine.note_messages(&messages("session-1", 5..10));
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(2))
                .err(),
            Some(TickGate::Idle)
        );
        // A network failure schedules a 5 s backoff before the next attempt.
        let failure = Err(CohostApiError::network("offline"));
        assert!(engine.apply_tick_result(generation, 0, failure, start + secs(2), "now"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::Network));
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(6))
                .err(),
            Some(TickGate::Idle)
        );
        // 8 s min gap dominates here (last tick at +1 s): due from +9 s.
        assert!(
            engine
                .prepare_tick(generation, true, true, start + secs(9))
                .is_ok()
        );
    }

    #[test]
    fn backoff_ladder_is_5_10_20_40_60_capped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut now = start;
        let mut observed = Vec::new();
        for _ in 0..6 {
            engine.note_messages(&messages("session-1", 0..5));
            // Force the next attempt to be due regardless of the min gap.
            {
                let session = engine.session.as_mut().unwrap();
                session.last_tick_at = None;
                session.known_set.clear();
                session.known_ids.clear();
                session.cursor = None;
            }
            now += secs(61);
            let prepared = engine.prepare_tick(generation, true, true, now).unwrap();
            assert!(!prepared.request.messages.is_empty());
            engine.apply_tick_result(
                generation,
                0,
                Err(server_error(502, "ai-gateway-error", "boom")),
                now,
                "now",
            );
            let next = engine.session.as_ref().unwrap().next_attempt_at.unwrap();
            observed.push(next.duration_since(now).as_secs());
        }
        assert_eq!(observed, vec![5, 10, 20, 40, 60, 60]);
        assert_eq!(engine.snapshot().reason, Some(CohostReason::GatewayError));
    }

    #[test]
    fn delta_cursor_caps_to_newest_sixty_and_counts_dropped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let noted = engine.note_messages(&messages("session-1", 0..75));
        assert_eq!(noted, 75);
        // Replays at or before the cursor are ignored.
        assert_eq!(engine.note_messages(&messages("session-1", 10..20)), 0);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(prepared.request.messages.len(), TICK_DELTA_CAP);
        assert_eq!(prepared.request.dropped_messages, 15);
        assert_eq!(
            prepared.request.messages.first().unwrap().id,
            chat_message("session-1", 15, "").id
        );
        assert_eq!(
            prepared.request.messages.last().unwrap().id,
            chat_message("session-1", 74, "").id
        );
        // The delta is consumed: nothing pending afterwards.
        engine.apply_tick_result(
            generation,
            prepared.request.dropped_messages,
            Ok(response(Vec::new())),
            start + secs(2),
            "2026-08-22T10:02:00Z",
        );
        let snapshot = engine.snapshot();
        assert!(snapshot.partial);
        assert_eq!(snapshot.tick_seq, 1);
        assert_eq!(
            snapshot.last_tick_at.as_deref(),
            Some("2026-08-22T10:02:00Z")
        );
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(60))
                .err(),
            Some(TickGate::Idle)
        );
    }

    #[test]
    fn deleted_system_and_custom_rows_never_enter_a_batch() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut rows = messages("session-1", 0..6);
        rows[0].is_deleted = true;
        rows[1].event_type = LiveChatEventType::System;
        rows[2].event_type = LiveChatEventType::Moderation;
        rows[3].platform = StreamPlatform::Custom;
        rows[4].event_type = LiveChatEventType::Paid;
        rows.push(chat_message("other-session", 99, "2026-08-22T10:05:00Z"));
        engine.note_messages(&rows);
        // A tombstone for a pending row removes it.
        let mut tombstone = chat_message("session-1", 5, "2026-08-22T10:09:00Z");
        tombstone.is_deleted = true;
        tombstone.event_type = LiveChatEventType::Deleted;
        engine.note_messages(&[tombstone]);
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(30))
                .err(),
            Some(TickGate::Idle)
        );
    }

    #[test]
    fn request_json_matches_the_wire_contract() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.message_text = "x".repeat(600);
        engine.note_messages(&[row.clone()]);
        {
            let session = engine.session.as_mut().unwrap();
            session.questions.push(CohostQuestion {
                id: "q_1".to_string(),
                text: "What keyboard?".to_string(),
                message_ids: vec![row.id.clone()],
                askers: vec!["a".to_string(), "b".to_string(), "c".to_string()],
                platforms: vec![StreamPlatform::Twitch],
                priority: CohostPriority::Normal,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: "t0".to_string(),
                updated_at: "t0".to_string(),
            });
        }
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        let json = serde_json::to_value(&prepared.request).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "clientVersion",
                "consentToProcessChat",
                "droppedMessages",
                "messages",
                "notes",
                "openQuestions",
                "promptVersion",
                "rules",
                "sessionClientId",
                "streamTitle",
                "tickSeq",
                "tone",
            ]
        );
        assert_eq!(json["promptVersion"], 2);
        assert_eq!(json["rules"], serde_json::json!([]));
        assert_eq!(json["tickSeq"], 1);
        assert_eq!(json["consentToProcessChat"], true);
        assert_eq!(json["tone"], "short");
        assert_eq!(json["streamTitle"], "Rust night");
        assert_eq!(json["sessionClientId"], "session-1");
        assert_eq!(json["droppedMessages"], 0);
        assert_eq!(json["openQuestions"][0]["id"], "q_1");
        assert_eq!(json["openQuestions"][0]["count"], 3);
        let message = &json["messages"][0];
        let mut message_keys: Vec<&str> = message
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        message_keys.sort_unstable();
        assert_eq!(
            message_keys,
            vec!["at", "author", "id", "platform", "roles", "text"]
        );
        assert_eq!(message["platform"], "twitch");
        assert_eq!(message["author"], "Viewer 1");
        assert_eq!(message["roles"], serde_json::json!(["mod"]));
        assert_eq!(message["at"], "2026-08-22T10:00:01Z");
        assert_eq!(message["text"].as_str().unwrap().chars().count(), 500);
        assert!(json.get("streamTitle").is_some());
    }

    #[test]
    fn state_merge_keeps_first_seen_applies_resolved_and_honors_dismissed() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let first = response(vec![
            question("q_1", &[rows[0].id.as_str(), "unknown-id"]),
            question("q_2", &[rows[1].id.as_str()]),
            question("q_3", &[rows[2].id.as_str()]),
        ]);
        assert!(engine.apply_tick_result(prepared.generation, 0, Ok(first), start + secs(2), "t1"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.mood, Some(CohostMood::Hype));
        assert_eq!(snapshot.questions.len(), 3);
        assert_eq!(snapshot.questions[0].first_seen_at, "t1");
        // Unknown message ids are sanitized away.
        assert_eq!(snapshot.questions[0].message_ids, vec![rows[0].id.clone()]);

        // Answered + dismissed leave the open set and never return.
        assert!(engine.mark_answered("session-1", "q_2").unwrap());
        assert!(!engine.mark_answered("session-1", "q_2").unwrap());
        assert_eq!(
            engine.mark_answered("session-2", "q_1"),
            Err(CohostError::SessionMismatch)
        );

        engine.note_messages(&messages("session-1", 5..10));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert_eq!(prepared.request.open_questions.len(), 2);
        let mut second = response(vec![
            question("q_1", &[rows[1].id.as_str(), "unknown-id"]),
            question("q_2", &[rows[1].id.as_str()]),
            question("q_4", &[rows[4].id.as_str()]),
        ]);
        second.resolved = vec!["q_3".to_string()];
        second.flags = vec![
            flag(
                &rows[3].id,
                CohostFlagKind::Spam,
                CohostFlagSeverity::Medium,
            ),
            flag(
                "not-ours",
                CohostFlagKind::Toxicity,
                CohostFlagSeverity::High,
            ),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(second), start + secs(31), "t2"));
        let snapshot = engine.snapshot();
        let ids: Vec<&str> = snapshot
            .questions
            .iter()
            .map(|question| question.id.as_str())
            .collect();
        assert_eq!(ids, vec!["q_1", "q_4"]);
        assert_eq!(snapshot.questions[0].first_seen_at, "t1");
        assert_eq!(snapshot.questions[0].updated_at, "t2");
        // Kept questions union their sources across ticks (the server only
        // validates ids against the current batch).
        assert_eq!(
            snapshot.questions[0].message_ids,
            vec![rows[0].id.clone(), rows[1].id.clone()]
        );
        assert_eq!(snapshot.questions[1].first_seen_at, "t2");
        assert_eq!(snapshot.flags.len(), 1);
        assert_eq!(snapshot.flags[0].message_id, rows[3].id);
        assert_eq!(snapshot.flags[0].at, "t2");

        assert!(engine.dismiss_flag("session-1", &rows[3].id).unwrap());
        assert!(engine.snapshot().flags.is_empty());
    }

    #[test]
    fn v2_request_carries_the_normalised_rules() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec![
                "  No spoilers  ".to_string(),
                String::new(),
                "r".repeat(COHOST_RULE_MAX_CHARS + 30),
            ]
            .into_iter()
            .chain((0..20).map(|index| format!("rule {index}")))
            .collect(),
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        engine.note_messages(&messages("session-1", 0..5));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let rules = prepared.request.rules.clone().unwrap();
        assert_eq!(rules.len(), COHOST_RULES_MAX);
        assert_eq!(rules[0], "No spoilers");
        assert_eq!(rules[1].chars().count(), COHOST_RULE_MAX_CHARS);
        assert!(
            rules
                .iter()
                .all(|rule| !rule.is_empty() && rule.chars().count() <= COHOST_RULE_MAX_CHARS)
        );
    }

    #[test]
    fn prompt_version_unsupported_falls_back_to_v1_without_pausing() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec!["No spoilers".to_string()],
            ..enabled_settings()
        });
        let generation = engine.start_session(
            "session-1".to_string(),
            true,
            Some("Rust night".into()),
            start,
        );
        let rows = messages("session-1", 0..2);
        engine.note_messages(&rows);
        let v2 = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        assert_eq!(v2.request.prompt_version, 2);
        assert_eq!(v2.request.rules, Some(vec!["No spoilers".to_string()]));

        // Server rolled back: not an error the streamer sees, no backoff.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(
                400,
                "prompt-version-unsupported",
                "promptVersion 2 is not supported."
            )),
            start + secs(21),
            "t1",
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
        assert!(!snapshot.tick_in_flight);
        // The rejected batch is back in the delta.
        assert_eq!(snapshot.pending_messages, 2);

        // Retried as soon as the contract's 8 s floor allows — not after the
        // 20 s trickle wait two pending rows would normally get.
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(27)),
            Err(TickGate::Idle)
        );
        let v1 = engine
            .prepare_tick(generation, true, true, start + secs(28))
            .unwrap();
        assert_eq!(v1.request.prompt_version, 1);
        assert_eq!(v1.request.rules, None);
        assert_eq!(v1.request.messages, v2.request.messages);
        // Byte-identical to a v1 desktop's body: no `rules` key at all.
        let json = serde_json::to_value(&v1.request).unwrap();
        assert!(json.get("rules").is_none());
        assert_eq!(json["promptVersion"], 1);
        assert_eq!(json.as_object().unwrap().len(), 11);

        // v1 for the rest of the session, back on the normal cadence.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(29),
            "t2"
        ));
        engine.note_messages(&messages("session-1", 2..4));
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(40)),
            Err(TickGate::Idle)
        );
        let next = engine
            .prepare_tick(generation, true, true, start + secs(48))
            .unwrap();
        assert_eq!(next.request.prompt_version, 1);

        // A v1 rejection is a real failure, as before.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "prompt-version-unsupported", "no")),
            start + secs(49),
            "t3",
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::ServerUnconfigured));

        // A new session starts on v2 again.
        let generation = engine.start_session("session-2".to_string(), true, None, start);
        engine.note_messages(&messages("session-2", 0..5));
        let fresh = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(fresh.request.prompt_version, 2);
    }

    #[test]
    fn unknown_enum_values_and_extra_fields_still_apply() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let body = serde_json::json!({
            "promptVersion": 3,
            "somethingNew": { "nested": [1, 2, 3] },
            "questions": [{
                "id": "q_1",
                "text": "What keyboard?",
                "messageIds": [rows[0].id],
                "priority": "urgent",
                "futureField": true
            }],
            "mood": "chaotic",
            "moodScores": { "hype": 1.7, "tension": 0.4, "boredom": 0.9 },
            "flags": [
                { "messageId": rows[1].id, "kind": "brigading", "severity": "critical",
                  "reason": "new kind", "target": "bots", "action": "shadowban",
                  "alsoKinds": ["scam", "brigading"], "confidence": 0.8, "extra": 1 },
                { "messageId": rows[2].id, "kind": "hate", "severity": "high" },
                { "messageId": rows[3].id, "kind": 7, "severity": "high" },
                "not-an-object"
            ],
            "highlights": [
                { "messageId": rows[4].id, "score": 0.9, "type": "meme" },
                { "score": 0.5 }
            ],
            "alerts": [
                { "messageId": rows[0].id, "kind": "chat-bridge", "confidence": 0.7 }
            ]
        });
        let response: CohostTickResponse = serde_json::from_value(body).unwrap();
        assert!(engine.apply_tick_result(generation, 0, Ok(response), start + secs(2), "t1"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.mood, Some(CohostMood::Mixed));
        assert_eq!(snapshot.questions[0].priority, CohostPriority::Normal);
        assert_eq!(
            snapshot.mood_scores,
            Some(CohostMoodScores {
                hype: 1.0,
                tension: 0.4,
                confusion: 0.0
            })
        );
        // Unknown kind is kept for a generic render; the unreadable items
        // (non-string kind, non-object) are dropped on their own.
        assert_eq!(snapshot.flags.len(), 2);
        assert_eq!(snapshot.flags[0].kind, CohostFlagKind::Unknown);
        assert_eq!(snapshot.flags[0].severity, CohostFlagSeverity::Medium);
        assert_eq!(snapshot.flags[0].target, None);
        assert_eq!(snapshot.flags[0].action, None);
        assert_eq!(snapshot.flags[0].also_kinds, vec![CohostFlagKind::Scam]);
        assert_eq!(snapshot.flags[0].confidence, Some(0.8));
        assert_eq!(snapshot.flags[1].kind, CohostFlagKind::Hate);
        assert_eq!(snapshot.highlights.len(), 1);
        assert_eq!(
            snapshot.highlights[0].highlight_type,
            CohostHighlightType::Other
        );
        assert_eq!(snapshot.alerts.len(), 1);
        assert_eq!(snapshot.alerts[0].kind, CohostAlertKind::Other);

        // What reaches the renderer: "unknown" only as a flag kind, and no
        // nulls for the optional v2 fields.
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["flags"][0]["kind"], "unknown");
        let flag = wire["flags"][1].as_object().unwrap();
        for key in ["confidence", "target", "action", "alsoKinds", "rule"] {
            assert!(!flag.contains_key(key), "{key} must be absent, not null");
        }
    }

    #[test]
    fn keep_questions_keeps_the_open_set_and_only_removes_resolved() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let first = response(vec![
            question("q_1", &[rows[0].id.as_str()]),
            question("q_2", &[rows[1].id.as_str()]),
        ]);
        assert!(engine.apply_tick_result(generation, 0, Ok(first), start + secs(2), "t1"));

        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        let kept: CohostTickResponse = serde_json::from_value(serde_json::json!({
            "promptVersion": 2,
            "questions": [],
            "resolved": ["q_2"],
            "keepQuestions": true,
            "mood": "calm"
        }))
        .unwrap();
        assert!(engine.apply_tick_result(generation, 0, Ok(kept), start + secs(31), "t2"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 1);
        assert_eq!(snapshot.questions[0].id, "q_1");
        // Untouched, not re-stamped: the server did not regenerate it.
        assert_eq!(snapshot.questions[0].updated_at, "t1");
        assert_eq!(snapshot.questions_total, 2);

        // Without the flag an empty `questions` still means "none open" (v1).
        engine.note_messages(&messages("session-1", 10..15));
        engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(61),
            "t3"
        ));
        assert!(engine.snapshot().questions.is_empty());
    }

    #[test]
    fn flag_extras_ride_the_state_and_rule_index_resolves_to_the_sent_rule() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec!["No spoilers".to_string(), "English only".to_string()],
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        // The streamer edits the list while the tick is in flight; the index
        // still means what it meant when the request was built.
        engine.settings.rules = vec!["Be kind".to_string()];
        let mut tick = response(Vec::new());
        tick.flags = vec![
            CohostTickFlag {
                confidence: Some(0.93),
                target: Some(CohostFlagTarget::Streamer),
                action: Some(CohostFlagAction::Timeout),
                also_kinds: vec![CohostFlagKind::Scam, CohostFlagKind::Harassment],
                ..flag(
                    &rows[0].id,
                    CohostFlagKind::Harassment,
                    CohostFlagSeverity::High,
                )
            },
            CohostTickFlag {
                rule_index: Some(1),
                ..flag(&rows[1].id, CohostFlagKind::Rule, CohostFlagSeverity::Low)
            },
            CohostTickFlag {
                rule_index: Some(9),
                ..flag(&rows[2].id, CohostFlagKind::Rule, CohostFlagSeverity::Low)
            },
            // A rule index on a non-rule flag means nothing.
            CohostTickFlag {
                rule_index: Some(0),
                ..flag(&rows[3].id, CohostFlagKind::Spam, CohostFlagSeverity::Low)
            },
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let flags = engine.snapshot().flags;
        assert_eq!(flags[0].confidence, Some(0.93));
        assert_eq!(flags[0].target, Some(CohostFlagTarget::Streamer));
        assert_eq!(flags[0].action, Some(CohostFlagAction::Timeout));
        assert_eq!(flags[0].also_kinds, vec![CohostFlagKind::Scam]);
        assert_eq!(flags[1].rule.as_deref(), Some("English only"));
        assert_eq!(flags[2].rule, None);
        assert_eq!(flags[3].rule, None);
        let wire = serde_json::to_value(&flags[0]).unwrap();
        assert_eq!(wire["target"], "streamer");
        assert_eq!(wire["action"], "timeout");
        assert_eq!(wire["alsoKinds"], serde_json::json!(["scam"]));
    }

    #[test]
    fn highlights_keep_the_latest_validated_set_and_never_a_flagged_or_deleted_row() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..8);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let highlight = |id: &str, score: f64| crate::videorc_api::CohostTickHighlight {
            message_id: id.to_string(),
            score,
            highlight_type: CohostHighlightType::Joke,
        };
        let mut tick = response(Vec::new());
        tick.flags = vec![flag(
            &rows[1].id,
            CohostFlagKind::Spam,
            CohostFlagSeverity::Low,
        )];
        tick.highlights = vec![
            highlight(&rows[0].id, 0.9),
            highlight(&rows[1].id, 0.8),
            highlight("not-ours", 0.7),
            highlight(&rows[0].id, 0.6),
            highlight(&rows[2].id, 0.5),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let ids = |engine: &CohostEngine| -> Vec<String> {
            engine
                .snapshot()
                .highlights
                .into_iter()
                .map(|highlight| highlight.message_id)
                .collect()
        };
        assert_eq!(ids(&engine), vec![rows[0].id.clone(), rows[2].id.clone()]);

        // A tombstone pulls the suggestion at once, and keeps it out later.
        let mut deleted = rows[0].clone();
        deleted.is_deleted = true;
        engine.note_messages(&[deleted]);
        assert_eq!(ids(&engine), vec![rows[2].id.clone()]);

        // Dismissing a flag does not make that message suggestible.
        assert!(engine.dismiss_flag("session-1", &rows[1].id).unwrap());
        engine.note_messages(&messages("session-1", 8..13));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.highlights = (0..8)
            .map(|index| highlight(&rows[index].id, 0.5))
            .collect();
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(31), "t2"));
        let kept = ids(&engine);
        assert_eq!(kept.len(), HIGHLIGHTS_CAP);
        assert!(!kept.contains(&rows[0].id));
        assert!(!kept.contains(&rows[1].id));

        // The latest set wins: a tick without highlights clears them.
        engine.note_messages(&messages("session-1", 13..18));
        engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(61),
            "t3"
        ));
        assert!(ids(&engine).is_empty());
    }

    #[test]
    fn alerts_need_two_distinct_authors_within_a_minute_and_expire() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        // chat_message authors cycle viewer-0, viewer-1, viewer-2.
        let rows = messages("session-1", 0..6);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let alert = |id: &str, kind: CohostAlertKind| crate::videorc_api::CohostTickAlert {
            message_id: id.to_string(),
            kind,
            confidence: Some(0.9),
        };
        let mut tick = response(Vec::new());
        tick.alerts = vec![
            alert(&rows[0].id, CohostAlertKind::Audio),
            // Same author again: still one viewer.
            alert(&rows[3].id, CohostAlertKind::Audio),
            alert("not-ours", CohostAlertKind::Audio),
            alert(&rows[1].id, CohostAlertKind::Video),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(2));
        assert_eq!(alerts.len(), 2);
        assert_eq!(alerts[0].kind, CohostAlertKind::Audio);
        assert_eq!(alerts[0].viewers, 1);
        assert!(!alerts[0].active);
        assert!(!alerts[1].active);

        // A second author 70 s later is outside the corroboration window...
        engine.note_messages(&messages("session-1", 6..11));
        engine
            .prepare_tick(generation, true, true, start + secs(71))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.alerts = vec![alert(&rows[1].id, CohostAlertKind::Audio)];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(72), "t2"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(72));
        assert_eq!(alerts[0].viewers, 2);
        assert_eq!(alerts[0].last_seen_at, "t2");
        assert!(!alerts[0].active);

        // ...a third one 20 s after that is inside it.
        engine.note_messages(&messages("session-1", 11..16));
        engine
            .prepare_tick(generation, true, true, start + secs(91))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.alerts = vec![alert(&rows[2].id, CohostAlertKind::Audio)];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(92), "t3"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(92));
        let audio = alerts
            .iter()
            .find(|alert| alert.kind == CohostAlertKind::Audio)
            .unwrap();
        assert!(audio.active);
        assert_eq!(audio.viewers, 3);
        let wire = serde_json::to_value(audio).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "kind": "audio", "viewers": 3, "lastSeenAt": "t3", "active": true })
        );
        // The lone video report from t+2 is still listed, never active.
        assert!(
            alerts
                .iter()
                .any(|alert| alert.kind == CohostAlertKind::Video && !alert.active)
        );

        // Reports expire 120 s after they were seen: at t+193 only the t+92
        // report is left, so audio is one viewer again and video is gone.
        let alerts = session.alerts_at(start + secs(193));
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].viewers, 1);
        assert!(!alerts[0].active);
        assert!(session.alerts_at(start + secs(212)).is_empty());
    }

    #[test]
    fn settings_from_before_rules_still_load_and_rules_round_trip() {
        let legacy: CohostSettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "tone": "short",
            "notes": "n",
            "autoHighlight": false
        }))
        .unwrap();
        assert!(legacy.rules.is_empty());

        let database = Database::open_in_memory_for_tests();
        let mut settings = CohostSettings::default();
        settings.apply(CohostSettingsPatch {
            rules: Some(
                (0..14)
                    .map(|index| format!("  rule {index} {}", "x".repeat(200)))
                    .collect(),
            ),
            ..CohostSettingsPatch::default()
        });
        assert_eq!(settings.rules.len(), COHOST_RULES_MAX);
        assert!(
            settings
                .rules
                .iter()
                .all(|rule| rule.chars().count() == COHOST_RULE_MAX_CHARS
                    && rule.starts_with("rule"))
        );
        database
            .save_setting(COHOST_SETTINGS_KEY, &settings)
            .unwrap();
        assert_eq!(load_cohost_settings(&database), settings);
        assert_eq!(
            serde_json::to_value(CohostSettings::default()).unwrap()["rules"],
            serde_json::json!([])
        );
        // An absent patch field leaves the list alone; an empty one clears it.
        settings.apply(CohostSettingsPatch::default());
        assert_eq!(settings.rules.len(), COHOST_RULES_MAX);
        settings.apply(CohostSettingsPatch {
            rules: Some(Vec::new()),
            ..CohostSettingsPatch::default()
        });
        assert!(settings.rules.is_empty());
    }

    #[test]
    fn late_response_for_a_replaced_session_is_dropped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.stop_session());
        assert_eq!(engine.snapshot(), CohostState::off());
        // Same generation id, but no session: dropped.
        assert!(!engine.apply_tick_result(
            prepared.generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(2),
            "t1"
        ));
        // A replacement session with a newer generation also drops it.
        let next_generation = engine.start_session("session-2".to_string(), true, None, start);
        assert_ne!(next_generation, prepared.generation);
        assert!(!engine.apply_tick_result(
            prepared.generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(2),
            "t1"
        ));
        assert!(engine.snapshot().questions.is_empty());
        assert_eq!(engine.snapshot().session_id.as_deref(), Some("session-2"));
        assert_eq!(
            engine.prepare_tick(prepared.generation, true, true, start + secs(3)),
            Err(TickGate::Stopped)
        );
    }

    #[test]
    fn failure_reasons_map_to_status_and_retry_windows() {
        let start = Instant::now();
        let cases = [
            (
                server_error(401, "unauthorized", "x"),
                CohostStatus::Error,
                CohostReason::SessionExpired,
                5,
            ),
            (
                server_error(403, "premium-required", "x"),
                CohostStatus::Paused,
                CohostReason::PremiumRequired,
                5,
            ),
            (
                server_error(400, "consent-required", "x"),
                CohostStatus::Paused,
                CohostReason::ConsentRequired,
                5,
            ),
            (
                crate::videorc_api::classify_cohost_failure(
                    429,
                    "quota-exhausted",
                    "x".into(),
                    Some("120"),
                ),
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                120,
            ),
            (
                server_error(429, "quota-exhausted", "x"),
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                3600,
            ),
            (
                server_error(503, "cohost-disabled", "x"),
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                server_error(400, "prompt-version-unsupported", "x"),
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                server_error(502, "ai-gateway-error", "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                server_error(400, "invalid-request", "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::malformed_response(200, "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::network("x"),
                CohostStatus::Error,
                CohostReason::Network,
                5,
            ),
            (
                CohostApiError::timeout("x"),
                CohostStatus::Error,
                CohostReason::Network,
                5,
            ),
        ];
        for (error, status, reason, retry_secs) in cases {
            let (mut engine, generation) = running_engine(start);
            if error.kind == CohostApiErrorKind::PromptVersionUnsupported {
                // Only a rejected v1 tick is a failure; a rejected v2 tick is
                // the silent fallback (covered by its own test).
                engine.session.as_mut().unwrap().prompt_version = COHOST_PROMPT_VERSION_FALLBACK;
            }
            engine.note_messages(&messages("session-1", 0..5));
            engine
                .prepare_tick(generation, true, true, start + secs(1))
                .unwrap();
            assert!(engine.apply_tick_result(generation, 0, Err(error.clone()), start, "t"));
            let snapshot = engine.snapshot();
            assert_eq!(snapshot.status, status, "{error:?}");
            assert_eq!(snapshot.reason, Some(reason), "{error:?}");
            // Every failed tick exposes what was actually said.
            assert_eq!(snapshot.detail, Some(error.detail.clone()), "{error:?}");
            let next = engine.session.as_ref().unwrap().next_attempt_at.unwrap();
            assert_eq!(
                next.duration_since(start).as_secs(),
                retry_secs,
                "{error:?}"
            );
        }
    }

    #[test]
    fn failed_tick_detail_is_captured_and_cleared_on_recovery() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        assert_eq!(engine.snapshot().detail, None);

        // 502 from the 2026-08-23 incident: code + message + status all ride
        // the snapshot.
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(
                502,
                "ai-gateway-error",
                "The co-host tick failed on every configured model."
            )),
            start + secs(2),
            "t1"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::GatewayError));
        assert_eq!(
            snapshot.detail,
            Some(CohostErrorDetail {
                code: "ai-gateway-error".to_string(),
                message: "The co-host tick failed on every configured model.".to_string(),
                status: Some(502),
            })
        );

        // A later 400 replaces it wholesale (no stale status from the 502).
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(10))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "invalid-request", "messages: too long")),
            start + secs(11),
            "t2"
        ));
        assert_eq!(
            engine.snapshot().detail,
            Some(CohostErrorDetail {
                code: "invalid-request".to_string(),
                message: "messages: too long".to_string(),
                status: Some(400),
            })
        );

        // A timeout has no HTTP status and the desktop's own code.
        engine.note_messages(&messages("session-1", 10..15));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(CohostApiError::timeout(
                "The co-host service did not answer within 12 s."
            )),
            start + secs(42),
            "t3"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.reason, Some(CohostReason::Network));
        assert_eq!(
            snapshot.detail,
            Some(CohostErrorDetail {
                code: "timeout".to_string(),
                message: "The co-host service did not answer within 12 s.".to_string(),
                status: None,
            })
        );

        // Recovery: a merged tick clears reason and detail together.
        engine.note_messages(&messages("session-1", 15..20));
        engine
            .prepare_tick(generation, true, true, start + secs(80))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(81),
            "t4"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
    }

    #[test]
    fn precondition_pause_drops_stale_tick_detail() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(502, "ai-gateway-error", "boom")),
            start + secs(2),
            "t1"
        ));
        assert!(engine.snapshot().detail.is_some());
        // Signed out while backing off: the pause is local, not a tick result.
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(10)),
            Err(TickGate::Paused(CohostReason::SignedOut))
        );
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Paused);
        assert_eq!(snapshot.detail, None);
    }

    #[test]
    fn error_detail_message_is_trimmed_and_capped() {
        let long = "x".repeat(1000);
        let detail = CohostErrorDetail::new("ai-gateway-error", format!("  {long}  "), Some(502));
        assert_eq!(
            detail.message.chars().count(),
            ERROR_DETAIL_MESSAGE_MAX_CHARS
        );
        assert_eq!(detail.code, "ai-gateway-error");
        assert_eq!(detail.status, Some(502));
    }

    #[test]
    fn state_without_detail_key_still_parses_and_serializes_explicit_null() {
        let legacy: CohostState = serde_json::from_value(serde_json::json!({
            "sessionId": null,
            "status": "off",
            "reason": null,
            "questions": [],
            "flags": [],
            "mood": null,
            "lastTickAt": null,
            "tickSeq": 0,
            "partial": false
        }))
        .unwrap();
        assert_eq!(legacy, CohostState::off());
        let wire = serde_json::to_value(CohostState::off()).unwrap();
        assert_eq!(wire["detail"], serde_json::Value::Null);
        let errored = CohostState {
            status: CohostStatus::Error,
            reason: Some(CohostReason::GatewayError),
            detail: Some(CohostErrorDetail::new(
                "ai-gateway-error",
                "boom",
                Some(502),
            )),
            ..CohostState::off()
        };
        assert_eq!(
            serde_json::to_value(&errored).unwrap()["detail"],
            serde_json::json!({ "code": "ai-gateway-error", "message": "boom", "status": 502 })
        );
        let timed_out = CohostState {
            detail: Some(CohostErrorDetail::new("timeout", "slow", None)),
            ..CohostState::off()
        };
        assert_eq!(
            serde_json::to_value(&timed_out).unwrap()["detail"]["status"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn tick_timeout_exceeds_min_gap_and_an_in_flight_tick_only_delays_the_next() {
        // The HTTP timeout (12 s) is headroom; the cadence floor stays 8 s.
        assert!(crate::videorc_api::COHOST_TICK_TIMEOUT > TICK_MIN_GAP);
        assert_eq!(TICK_MIN_GAP.as_secs(), 8);

        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        let sent_at = start + secs(1);
        engine
            .prepare_tick(generation, true, true, sent_at)
            .unwrap();
        // A burst arrives while the request is still out: never a second
        // request in flight, even once the 8 s gap has passed.
        engine.note_messages(&messages("session-1", 5..10));
        for offset in [2, 8, 9, 12] {
            assert_eq!(
                engine
                    .prepare_tick(generation, true, true, sent_at + secs(offset))
                    .err(),
                Some(TickGate::Idle),
                "+{offset}s"
            );
        }
        // The slow tick lands at +12 s: the gap since it was SENT is already
        // ≥ 8 s, so the delayed next tick goes out right away.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            sent_at + secs(12),
            "t1"
        ));
        let next = engine
            .prepare_tick(generation, true, true, sent_at + secs(12))
            .unwrap();
        assert_eq!(next.request.tick_seq, 2);
        assert_eq!(next.request.messages.len(), 5);
    }

    #[test]
    fn preconditions_pause_with_reasons_and_success_resumes_without_losing_state() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        assert_eq!(
            engine.prepare_tick(generation, true, false, start + secs(1)),
            Err(TickGate::Paused(CohostReason::PremiumRequired))
        );
        // Same pause again: no repeated emission.
        assert_eq!(
            engine.prepare_tick(generation, true, false, start + secs(7)),
            Err(TickGate::Idle)
        );
        // The 5 s precondition re-check window is honored.
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(8)),
            Err(TickGate::Idle)
        );
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(13)),
            Err(TickGate::Paused(CohostReason::SignedOut))
        );
        engine.session.as_mut().unwrap().consent = false;
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(19)),
            Err(TickGate::Paused(CohostReason::ConsentRequired))
        );
        engine.session.as_mut().unwrap().consent = true;
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(25))
            .unwrap();
        assert_eq!(
            prepared.request.messages.len(),
            5,
            "pending delta survived the pauses"
        );
        engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(26),
            "t1",
        );
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        assert_eq!(engine.snapshot().reason, None);

        // Disabled settings stop the scheduler on its next pass.
        engine.settings.enabled = false;
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(40)),
            Err(TickGate::Stopped)
        );
    }

    #[test]
    fn role_normalization_matches_the_server_enum() {
        assert_eq!(normalize_role("moderator").as_deref(), Some("mod"));
        assert_eq!(normalize_role("broadcaster").as_deref(), Some("owner"));
        assert_eq!(normalize_role("founder").as_deref(), Some("member"));
        assert_eq!(normalize_role("VIP").as_deref(), Some("vip"));
        assert_eq!(normalize_role("subscriber").as_deref(), Some("subscriber"));
        assert_eq!(normalize_role("verified"), None);
    }

    #[test]
    fn settings_round_trip_through_storage_and_cap_notes() {
        let database = Database::open_in_memory_for_tests();
        assert_eq!(load_cohost_settings(&database), CohostSettings::default());
        let mut settings = CohostSettings::default();
        settings.apply(CohostSettingsPatch {
            enabled: Some(true),
            tone: Some(CohostTone::Professional),
            notes: Some("n".repeat(COHOST_NOTES_MAX_CHARS + 25)),
            auto_highlight: Some(true),
            rules: Some(vec!["  No spoilers ".to_string(), "   ".to_string()]),
        });
        assert_eq!(settings.notes.chars().count(), COHOST_NOTES_MAX_CHARS);
        assert_eq!(settings.rules, vec!["No spoilers".to_string()]);
        database
            .save_setting(COHOST_SETTINGS_KEY, &settings)
            .unwrap();
        assert_eq!(load_cohost_settings(&database), settings);
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["tone"], "professional");
        assert_eq!(json["autoHighlight"], true);
        assert_eq!(json["enabled"], true);
    }

    #[test]
    fn state_wire_shape_uses_explicit_nulls() {
        let json = serde_json::to_value(CohostState::off()).unwrap();
        assert_eq!(json["sessionId"], serde_json::Value::Null);
        assert_eq!(json["status"], "off");
        assert_eq!(json["reason"], serde_json::Value::Null);
        assert_eq!(json["mood"], serde_json::Value::Null);
        assert_eq!(json["lastTickAt"], serde_json::Value::Null);
        assert_eq!(json["tickSeq"], 0);
        assert_eq!(json["partial"], false);
        assert_eq!(json["questions"], serde_json::json!([]));
        assert_eq!(json["flags"], serde_json::json!([]));
        // Presence fields always ride the wire, defaults included.
        assert_eq!(json["tickInFlight"], false);
        assert_eq!(json["pendingMessages"], 0);
        assert_eq!(json["nextTickAt"], serde_json::Value::Null);
        assert_eq!(json["messagesSeen"], 0);
        assert_eq!(json["questionsTotal"], 0);
        // Wire-v2 fields are omitted while empty — never null (the renderer
        // contract rejects null for optional fields).
        for key in ["highlights", "alerts", "moodScores"] {
            assert!(json.get(key).is_none(), "{key} must be absent while empty");
        }
    }

    #[test]
    fn state_without_presence_fields_still_parses_to_defaults() {
        // A payload from before the presence fields existed (<= 0.9.70).
        let legacy: CohostState = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "status": "listening",
            "reason": null,
            "detail": null,
            "questions": [],
            "flags": [],
            "mood": null,
            "lastTickAt": "2026-08-22T10:00:20Z",
            "tickSeq": 2,
            "partial": false
        }))
        .unwrap();
        assert!(!legacy.tick_in_flight);
        assert_eq!(legacy.pending_messages, 0);
        assert_eq!(legacy.next_tick_at, None);
        assert_eq!(legacy.messages_seen, 0);
        assert_eq!(legacy.questions_total, 0);
    }

    #[test]
    fn pending_bucket_emits_at_one_then_every_five() {
        let cases = [
            (0, 0),
            (1, 1),
            (2, 1),
            (5, 1),
            (6, 2),
            (10, 2),
            (11, 3),
            (60, 12),
        ];
        for (pending, bucket) in cases {
            assert_eq!(pending_bucket(pending), bucket, "pending={pending}");
        }
    }

    #[test]
    fn next_tick_due_at_matches_both_scheduler_rules() {
        let start = Instant::now();
        let now = start + secs(2);
        // Empty delta: no next pass to announce.
        assert_eq!(next_tick_due_at(0, start, None, None, now), None);
        // Trickle rule: 1..4 pending fire at anchor + 20 s.
        assert_eq!(
            next_tick_due_at(1, start, None, None, now),
            Some(start + secs(20))
        );
        assert_eq!(
            next_tick_due_at(4, start, None, None, now),
            Some(start + secs(20))
        );
        // Burst rule: >= 5 pending fire immediately without a previous tick...
        assert_eq!(next_tick_due_at(5, start, None, None, now), Some(now));
        // ...and as soon as the 8 s min gap allows after one.
        let last = start + secs(1);
        assert_eq!(
            next_tick_due_at(9, last, Some(last), None, now),
            Some(last + secs(8))
        );
        // Trickle after a tick: the 20 s rule dominates the 8 s floor.
        assert_eq!(
            next_tick_due_at(1, last, Some(last), None, now),
            Some(last + secs(20))
        );
        // A backoff/quota window pushes both rules back.
        let attempt = start + secs(40);
        assert_eq!(
            next_tick_due_at(5, last, Some(last), Some(attempt), now),
            Some(attempt)
        );
        // The announced pass is never in the past.
        let late = start + secs(90);
        assert_eq!(
            next_tick_due_at(1, last, Some(last), Some(attempt), late),
            Some(late)
        );
    }

    #[test]
    fn tick_in_flight_toggles_around_the_request_on_success_and_failure() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        assert!(!engine.snapshot().tick_in_flight);
        engine.note_messages(&messages("session-1", 0..7));
        let queued = engine
            .session
            .as_ref()
            .unwrap()
            .snapshot_at(start + secs(1));
        assert_eq!(queued.pending_messages, 7);
        assert!(!queued.tick_in_flight);
        assert!(
            queued.next_tick_at.is_some(),
            "pending messages must announce the next pass"
        );

        // Sending drains the delta and raises tick_in_flight until the result.
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let in_flight = engine.snapshot();
        assert!(in_flight.tick_in_flight);
        assert_eq!(in_flight.pending_messages, 0);
        assert_eq!(in_flight.next_tick_at, None);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q_1", &[])])),
            start + secs(2),
            "t1"
        ));
        let merged = engine.snapshot();
        assert!(!merged.tick_in_flight);
        assert_eq!(merged.pending_messages, 0);
        assert_eq!(merged.messages_seen, 7);
        assert_eq!(merged.questions_total, 1);

        // Failure path clears the flag too.
        engine.note_messages(&messages("session-1", 7..14));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.snapshot().tick_in_flight);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(CohostApiError::network("offline")),
            start + secs(31),
            "t2"
        ));
        let failed = engine.snapshot();
        assert!(!failed.tick_in_flight);
        assert_eq!(failed.pending_messages, 0);
        assert_eq!(failed.messages_seen, 14);
    }

    #[test]
    fn questions_total_counts_each_grouped_id_once_for_the_session() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q_1", &[rows[0].id.as_str()]),
                question("q_2", &[rows[1].id.as_str()]),
            ])),
            start + secs(2),
            "t1"
        ));
        assert_eq!(engine.snapshot().questions_total, 2);

        // A kept id does not re-count; a dismissed id keeps its count; a new
        // id adds one.
        assert!(engine.mark_answered("session-1", "q_2").unwrap());
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q_1", &[rows[2].id.as_str()]),
                question("q_3", &[rows[3].id.as_str()]),
            ])),
            start + secs(31),
            "t2"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions_total, 3);
        assert_eq!(snapshot.questions.len(), 2, "open count stays distinct");
        assert_eq!(snapshot.messages_seen, 10);
    }

    #[tokio::test]
    async fn note_messages_emits_only_on_bucket_crossings() {
        let state = test_state();
        {
            let mut engine = state.cohost.lock().await;
            engine.settings.enabled = true;
            engine.start_session("session-1".to_string(), true, None, Instant::now());
        }
        let mut events = state.events.subscribe();
        let drain_states = |events: &mut broadcast::Receiver<crate::protocol::ServerEvent>| {
            let mut states = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.event == COHOST_STATE_EVENT {
                    states.push(event.payload);
                }
            }
            states
        };

        // 0 -> 1 crosses into the first bucket: one emit.
        note_messages(&state, &messages("session-1", 0..1)).await;
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["pendingMessages"], 1);
        assert!(states[0]["nextTickAt"].is_string());
        assert_eq!(states[0]["tickInFlight"], false);

        // 1 -> 4 stays inside the bucket: silent.
        note_messages(&state, &messages("session-1", 1..4)).await;
        assert!(drain_states(&mut events).is_empty());

        // 4 -> 7 crosses into the second bucket: one emit.
        note_messages(&state, &messages("session-1", 4..7)).await;
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["pendingMessages"], 7);

        // No engine session: never an emit.
        state.cohost.lock().await.stop_session();
        note_messages(&state, &messages("session-1", 7..9)).await;
        assert!(drain_states(&mut events).is_empty());
    }

    #[tokio::test]
    async fn start_requires_enabled_settings_and_the_active_chat_session() {
        let state = test_state();
        let params = CohostStartParams {
            session_id: "session-1".to_string(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        assert_eq!(
            start_cohost(&state, params.clone()).await,
            Err(CohostError::SessionMismatch)
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        assert_eq!(
            start_cohost(&state, params.clone()).await,
            Err(CohostError::Disabled)
        );
        assert_eq!(CohostError::Disabled.code(), "cohost-disabled");

        let settings = set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                tone: None,
                notes: Some("hello".to_string()),
                auto_highlight: None,
                rules: None,
            },
        )
        .await
        .unwrap();
        assert!(settings.enabled);
        assert_eq!(load_cohost_settings(&state.database), settings);

        let mut events = state.events.subscribe();
        let started = start_cohost(&state, params.clone()).await.unwrap();
        assert_eq!(started.status, CohostStatus::Listening);
        assert_eq!(started.session_id.as_deref(), Some("session-1"));
        let mut saw_state_event = false;
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                saw_state_event = true;
            }
        }
        assert!(saw_state_event, "cohost.start must emit cohost.state");
        // No-op when already running for that session.
        let again = start_cohost(&state, params).await.unwrap();
        assert_eq!(again, started);

        // Delivered rows are noted; answered-after-send clears the question.
        note_messages(&state, &messages("session-1", 0..3)).await;
        assert_eq!(
            state
                .cohost
                .lock()
                .await
                .session
                .as_ref()
                .unwrap()
                .pending
                .len(),
            3
        );
        state
            .cohost
            .lock()
            .await
            .session
            .as_mut()
            .unwrap()
            .questions
            .push(CohostQuestion {
                id: "q_1".to_string(),
                text: "?".to_string(),
                message_ids: Vec::new(),
                askers: Vec::new(),
                platforms: Vec::new(),
                priority: CohostPriority::Normal,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: "t".to_string(),
                updated_at: "t".to_string(),
            });
        mark_question_answered_after_send(&state, "session-1", "q_1").await;
        assert!(cohost_status(&state).await.questions.is_empty());

        // Turning the setting off stops the session.
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(false),
                tone: None,
                notes: None,
                auto_highlight: None,
                rules: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cohost_status(&state).await, CohostState::off());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_replacement_cannot_overtake_a_validated_cohost_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;

        let (validated_tx, validated_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
                async move {
                    let _ = validated_tx.send(());
                    let _ = resume_rx.await;
                },
                std::future::ready(()),
            )
            .await
        });
        validated_rx
            .await
            .expect("co-host start validates the original chat session");

        let replacement_params: crate::live_chat::LiveChatStartParams =
            serde_json::from_value(serde_json::json!({
                "sessionId": "session-b",
                "platforms": []
            }))
            .expect("replacement live-chat params");
        let mut replacement = Box::pin(crate::live_chat::start_live_chat(
            &state,
            replacement_params,
        ));
        let completed_during_gap = std::future::poll_fn(|context| {
            Poll::Ready(match replacement.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;
        assert!(
            completed_during_gap.is_none(),
            "chat replacement must wait for the validated co-host start lifecycle transaction"
        );

        resume_tx.send(()).expect("resume co-host start");
        let started = start
            .await
            .expect("co-host start task")
            .expect("start co-host for original session");
        assert_eq!(started.session_id.as_deref(), Some("session-a"));

        let replacement = replacement.await;
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(cohost_status(&state).await, CohostState::off());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_cohost_emission_order_survives_chat_replacement() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();

        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
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
            .expect("co-host start captures the original session state");

        let replacement_params: crate::live_chat::LiveChatStartParams =
            serde_json::from_value(serde_json::json!({
                "sessionId": "session-b",
                "platforms": []
            }))
            .expect("replacement live-chat params");
        let mut replacement = Box::pin(crate::live_chat::start_live_chat(
            &state,
            replacement_params,
        ));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match replacement.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;

        resume_tx.send(()).expect("resume co-host state emit");
        let started = start
            .await
            .expect("co-host start task")
            .expect("start original co-host");
        assert_eq!(started.session_id.as_deref(), Some("session-a"));
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn public_stop_cohost_emission_order_survives_fenced_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
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
            .expect("co-host start captures listening state");

        let mut stop = Box::pin(stop_cohost(&state));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match stop.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;
        resume_tx.send(()).expect("resume co-host start emit");
        start
            .await
            .expect("co-host start task")
            .expect("co-host start result");
        let stopped = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => stop.await,
        };
        assert_eq!(stopped, CohostState::off());
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settings_stop_emission_order_survives_fenced_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
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
            .expect("co-host start captures listening state");

        let mut disable = Box::pin(set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(false),
                ..Default::default()
            },
        ));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match disable.as_mut().poll(context) {
                Poll::Ready(result) => Some(result),
                Poll::Pending => None,
            })
        })
        .await;
        resume_tx.send(()).expect("resume co-host start emit");
        start
            .await
            .expect("co-host start task")
            .expect("co-host start result");
        let settings = match completed_during_emit_gap {
            Some(result) => result,
            None => disable.await,
        }
        .expect("disable co-host settings");
        assert!(!settings.enabled);
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn live_chat_stop_clears_the_engine_session() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                tone: None,
                notes: None,
                auto_highlight: None,
                rules: None,
            },
        )
        .await
        .unwrap();
        start_cohost(
            &state,
            CohostStartParams {
                session_id: "session-1".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        crate::live_chat::stop_live_chat(&state).await;
        assert_eq!(cohost_status(&state).await, CohostState::off());
        assert!(state.cohost.lock().await.scheduler.is_none());
    }
}
