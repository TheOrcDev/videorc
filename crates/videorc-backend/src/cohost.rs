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

use crate::captions::{CaptionUpdateKind, CaptionsUpdate};
use crate::comment_highlight::{CommentHighlightPhase, CommentHighlightState};
use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::protocol::{
    CohostFlagParams, CohostQuestionParams, CohostSettingsPatch, CohostStartParams, FeatureId,
};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::StreamPlatform;
use crate::videorc_api::{
    COHOST_SPOTLIGHT_MAX_BODY_BYTES, CohostApiError, CohostApiErrorKind, CohostSpotlightCandidate,
    CohostSpotlightRequest, CohostSpotlightResponse, CohostTickMessage, CohostTickOpenQuestion,
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
/// Automatic on-stream cards (plan 060, D4-D6, D10). The engine decides, the
/// renderer only renders and sets the card. At most one automatic card every
/// `AUTO_HIGHLIGHT_COOLDOWN`, measured from the end of the previous card
/// (whoever set it); never a message older than `AUTO_HIGHLIGHT_MAX_AGE`;
/// never while chat tension is at or above the ceiling.
pub(crate) const AUTO_HIGHLIGHT_COOLDOWN: Duration = Duration::from_secs(45);
pub(crate) const AUTO_HIGHLIGHT_MAX_AGE: Duration = Duration::from_secs(120);
const AUTO_HIGHLIGHT_TENSION_CEILING: f64 = 0.7;
/// An open high-priority question has no server score; it competes at this
/// baseline plus the asker's role bonus.
const AUTO_HIGHLIGHT_QUESTION_SCORE: f64 = 0.5;
/// Not the same highlight type this many times in a row when another exists.
const AUTO_HIGHLIGHT_TYPE_RUN: usize = 3;
const AUTO_HIGHLIGHT_ROLE_BONUS_MEMBER: f64 = 0.15;
const AUTO_HIGHLIGHT_ROLE_BONUS_MOD: f64 = 0.10;
/// A voice card may be re-set once while the match persists; the refresh is
/// due when this little of the first lifetime is left (10 s + 10 s = 20 s max).
const AUTO_HIGHLIGHT_VOICE_REFRESH_WINDOW: Duration = Duration::from_secs(2);
/// A decision the renderer never turned into a live card stops counting as
/// "applying" after this long (the message may have left the snapshot).
const AUTO_HIGHLIGHT_APPLY_TIMEOUT: Duration = Duration::from_secs(8);
/// The spotlight lane (plan 060 S3, D7, D12): what the streamer says, from the
/// live-caption finals, against the comments they might be talking about. A
/// fast lane with its own cadence and breaker; it never touches the tick.
pub(crate) const SPOTLIGHT_TRANSCRIPT_WINDOW: Duration = Duration::from_secs(20);
pub(crate) const SPOTLIGHT_TRANSCRIPT_MAX_CHARS: usize = 800;
/// A call waits this long after the latest final (the next final is usually
/// on its way) and never comes closer than the min gap to the previous call.
pub(crate) const SPOTLIGHT_DEBOUNCE: Duration = Duration::from_secs(1);
pub(crate) const SPOTLIGHT_MIN_GAP: Duration = Duration::from_millis(2500);
const SPOTLIGHT_QUESTION_CANDIDATES_CAP: usize = 10;
const SPOTLIGHT_CANDIDATES_CAP: usize = 20;
/// Server caps on one candidate (`cohost-spotlight.ts`); a candidate that
/// cannot fit is left out rather than failing the whole call.
const SPOTLIGHT_CANDIDATE_ID_MAX_CHARS: usize = 200;
const SPOTLIGHT_AUTHOR_MAX_CHARS: usize = 120;
const SPOTLIGHT_QUESTION_ID_MAX_CHARS: usize = 80;
pub(crate) const SPOTLIGHT_MESSAGE_MAX_AGE: Duration = Duration::from_secs(120);
/// A match stays the spotlight this long unless a later call refreshes it.
pub(crate) const SPOTLIGHT_EXPIRY: Duration = Duration::from_secs(15);
/// Desktop-owned thresholds on the server's raw probabilities. UNVALIDATED
/// starting values (plan 060 P7): mirror `SPOTLIGHT_REFERENCE_THRESHOLDS`.
const SPOTLIGHT_ABOUT_THRESHOLD: f64 = 0.75;
const SPOTLIGHT_ANSWERED_THRESHOLD: f64 = 0.8;
/// Consecutive calls that must say "answered" before a question is resolved.
const SPOTLIGHT_ANSWERED_STREAK: u32 = 2;
/// Breaker: this many failures in a row close the lane for `SPOTLIGHT_BREAKER_OFF`;
/// "not on this server" answers (404, disabled, unconfigured, no Premium)
/// close it for `SPOTLIGHT_UNAVAILABLE_OFF`; a quota answer for Retry-After.
const SPOTLIGHT_BREAKER_FAILURES: usize = 3;
const SPOTLIGHT_BREAKER_OFF: Duration = Duration::from_secs(60);
const SPOTLIGHT_UNAVAILABLE_OFF: Duration = Duration::from_secs(300);
/// Voice-resolved questions the streamer can still put back (D9).
const RECENTLY_RESOLVED_CAP: usize = 3;
const RECENTLY_RESOLVED_TTL: Duration = Duration::from_secs(60);

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

/// Where an automatic on-stream card came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAutoHighlightSource {
    /// The server's safety-gated `highlights[]`.
    Pick,
    /// An open question with priority `high`.
    Question,
    /// The comment the streamer is talking about (voice spotlight, plan 060 S3).
    Voice,
}

/// One automatic "put this on stream" command. The renderer keys on
/// `generation` and sets the card with always-set semantics; it keeps no
/// history and makes no decision of its own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAutoHighlight {
    pub generation: u64,
    pub message_id: String,
    pub source: CohostAutoHighlightSource,
    /// The same message is re-set while still live (voice only, once).
    pub refresh: bool,
}

/// The comment the streamer is talking about right now (plan 060 S3): the
/// best spotlight match at or above the `about` threshold, refreshed while it
/// persists, gone after `SPOTLIGHT_EXPIRY`. The renderer pins and marks it
/// (pull-up); with `voiceHighlight` the engine also puts it on stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlight {
    pub message_id: String,
    /// The open question this message asked, when it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    /// The server's `about` probability (0..1).
    pub score: f64,
    /// When this message became the spotlight (ISO-8601).
    pub at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostResolveReason {
    /// The streamer answered it on air (two spotlight calls in a row agreed).
    Voice,
}

/// A question the engine resolved by itself, kept for a minute so the streamer
/// can put it back with `cohost.question.restore` (D9).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostRecentlyResolved {
    pub question: CohostQuestion,
    pub reason: CohostResolveReason,
    pub resolved_at: String,
}

// --- Settings ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSettings {
    pub enabled: bool,
    pub tone: CohostTone,
    pub notes: String,
    /// Orcle's picks go on stream by themselves (server highlights and
    /// high-priority questions, with the engine's cadence rules).
    pub auto_highlight: bool,
    /// The comment the streamer is talking about goes on stream by itself.
    /// `default` so a settings row from before the field still loads.
    #[serde(default)]
    pub voice_highlight: bool,
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
            voice_highlight: false,
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
        if let Some(voice_highlight) = patch.voice_highlight {
            self.voice_highlight = voice_highlight;
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
            tracing::warn!("Could not read Orcle settings; using defaults: {error:#}");
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
    /// The engine's latest automatic on-stream command (plan 060 S1). Omitted
    /// until the engine made one this session; the renderer acts on a new
    /// `generation` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_highlight: Option<CohostAutoHighlight>,
    /// The comment the streamer is talking about (plan 060 S3). Omitted
    /// while there is none, or once it expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spotlight: Option<CohostSpotlight>,
    /// Questions the engine resolved on its own in the last minute, oldest
    /// first, at most three. Omitted while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recently_resolved: Vec<CohostRecentlyResolved>,
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
            auto_highlight: None,
            spotlight: None,
            recently_resolved: Vec::new(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CohostError {
    #[error("Orcle is turned off in Settings.")]
    Disabled,
    #[error("Orcle needs the active live chat session; sessionId did not match.")]
    SessionMismatch,
    #[error("sessionId and the question or message id are required.")]
    InvalidParams,
    #[error("Could not persist Orcle settings: {0}")]
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

// --- Transcript window (plan 060 S3) -------------------------------------------

/// The last seconds of the streamer's live captions, as the spotlight lane
/// sends them: finals only, at most `SPOTLIGHT_TRANSCRIPT_WINDOW` old and
/// `SPOTLIGHT_TRANSCRIPT_MAX_CHARS` long (oldest finals leave first). Behind a
/// std mutex on `AppState`, never the engine's async lock: the caption
/// coordinator appends and returns, and never waits on a tick.
#[derive(Debug, Default)]
pub struct TranscriptWindow {
    finals: VecDeque<TranscriptFinal>,
    chars: usize,
    /// Bumped per appended final; the lane calls once per change.
    version: u64,
    last_final_at: Option<Instant>,
}

#[derive(Debug, Clone)]
struct TranscriptFinal {
    at: Instant,
    text: String,
    chars: usize,
}

/// What the lane reads on a pass: the joined window text and its identity.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TranscriptSnapshot {
    pub(crate) text: String,
    pub(crate) version: u64,
    pub(crate) last_final_at: Option<Instant>,
}

impl TranscriptWindow {
    /// Append one final. Whitespace is collapsed; an empty final is ignored;
    /// a single final longer than the cap keeps its tail. Amortised constant
    /// time: every final is trimmed out at most once.
    pub(crate) fn push(&mut self, text: &str, now: Instant) {
        let mut text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return;
        }
        let mut chars = text.chars().count();
        if chars > SPOTLIGHT_TRANSCRIPT_MAX_CHARS {
            text = text
                .chars()
                .skip(chars - SPOTLIGHT_TRANSCRIPT_MAX_CHARS)
                .collect();
            chars = SPOTLIGHT_TRANSCRIPT_MAX_CHARS;
        }
        self.trim_older_than(now);
        self.finals.push_back(TranscriptFinal {
            at: now,
            text,
            chars,
        });
        self.chars += chars;
        // The cap is on the joined text the server sees: the separators count.
        while self.joined_chars() > SPOTLIGHT_TRANSCRIPT_MAX_CHARS {
            if let Some(oldest) = self.finals.pop_front() {
                self.chars -= oldest.chars;
            }
        }
        self.version = self.version.wrapping_add(1);
        self.last_final_at = Some(now);
    }

    fn joined_chars(&self) -> usize {
        self.chars + self.finals.len().saturating_sub(1)
    }

    fn trim_older_than(&mut self, now: Instant) {
        while self.finals.front().is_some_and(|oldest| {
            now.saturating_duration_since(oldest.at) >= SPOTLIGHT_TRANSCRIPT_WINDOW
        }) {
            if let Some(oldest) = self.finals.pop_front() {
                self.chars -= oldest.chars;
            }
        }
    }

    pub(crate) fn snapshot(&self, now: Instant) -> TranscriptSnapshot {
        let text = self
            .finals
            .iter()
            .filter(|final_| now.saturating_duration_since(final_.at) < SPOTLIGHT_TRANSCRIPT_WINDOW)
            .map(|final_| final_.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        TranscriptSnapshot {
            text,
            version: self.version,
            last_final_at: self.last_final_at,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.finals.clear();
        self.chars = 0;
        self.last_final_at = None;
        self.version = self.version.wrapping_add(1);
    }
}

pub type CohostTranscriptSlot = Arc<std::sync::Mutex<TranscriptWindow>>;

pub fn new_cohost_transcript_slot() -> CohostTranscriptSlot {
    Arc::new(std::sync::Mutex::new(TranscriptWindow::default()))
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

/// What the spotlight lane does on this pass.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SpotlightPass {
    /// Its session/generation was replaced or the co-host was turned off.
    Stopped,
    Idle,
    Send(PreparedSpotlight),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedSpotlight {
    pub(crate) request: CohostSpotlightRequest,
    pub(crate) generation: u64,
}

/// What one spotlight answer (or failure) changed, for the emit and the log.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SpotlightOutcome {
    /// The state snapshot differs: spotlight set, refreshed or cleared, or a
    /// question resolved.
    pub(crate) changed: bool,
    /// A new message became the spotlight: `(message_id, about)`.
    pub(crate) spotlight_set: Option<(String, f64)>,
    /// Question ids resolved by voice on this answer.
    pub(crate) resolved: Vec<String>,
    /// The breaker closed the lane for this long.
    pub(crate) lane_off_for: Option<Duration>,
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
    /// Author identity, roles and note time per known message id: distinct-author
    /// alert counts and the automatic-card rules read it.
    known: HashMap<String, KnownMessage>,
    /// Known rows that were deleted after they were sent in a tick.
    deleted_ids: HashSet<String>,
    highlights: Vec<CohostHighlight>,
    alert_reports: Vec<AlertReport>,
    mood_scores: Option<CohostMoodScores>,
    /// Automatic on-stream cards (plan 060 S1). All of it is per session: a
    /// new session starts with no history, like the dismissed sets.
    auto: AutoHighlightLedger,
    /// The spotlight lane (plan 060 S3), per session like the tick state.
    spotlight: SpotlightLane,
    /// Voice-resolved questions the streamer can put back, oldest first.
    recently_resolved: Vec<ResolvedRecord>,
}

/// What the engine remembers about one chat row it noted.
#[derive(Debug, Clone)]
struct KnownMessage {
    /// Platform-qualified author key (`alert_author_key`).
    author: String,
    /// Display name, as the tick sent it.
    author_name: String,
    /// Normalised roles (`normalize_role`).
    roles: Vec<String>,
    /// Text as the tick sent it (trimmed, capped), for spotlight candidates.
    text: String,
    /// Provider timestamp as the tick sent it.
    at: String,
    noted_at: Instant,
}

/// The spotlight lane's per-session memory: cadence, breaker, the current
/// spotlight and the "answered" streaks behind a voice resolve.
#[derive(Debug, Default)]
struct SpotlightLane {
    seq: u64,
    in_flight: bool,
    last_call_at: Option<Instant>,
    /// Transcript version the last call sent; `None` before the first call.
    last_version: Option<u64>,
    failures: usize,
    off_until: Option<Instant>,
    /// Calls in a row that said "answered" per open question id.
    answered_streak: HashMap<String, u32>,
    current: Option<SpotlightRecord>,
}

#[derive(Debug, Clone)]
struct SpotlightRecord {
    message_id: String,
    question_id: Option<String>,
    score: f64,
    at_iso: String,
    expires_at: Instant,
    expires_at_iso: String,
}

#[derive(Debug, Clone)]
struct ResolvedRecord {
    entry: CohostRecentlyResolved,
    at: Instant,
}

/// A card the engine saw live on the overlay.
#[derive(Debug, Clone)]
struct ObservedCard {
    message_id: String,
    /// The engine asked for this card (else the streamer set it by hand).
    engine_set: bool,
    expires_at: Instant,
}

/// An automatic command the renderer has not turned into a live card yet.
#[derive(Debug, Clone)]
struct PendingAutoRequest {
    message_id: String,
    asked_at: Instant,
    /// A voice refresh re-sets a card that is still live: it is fulfilled
    /// only once the observed card's expiry moves forward, never by the old
    /// card still being there.
    refresh: bool,
}

/// Session-scoped memory behind the automatic-card rules.
#[derive(Debug, Default)]
struct AutoHighlightLedger {
    /// The latest command, as published in `cohost.state`.
    latest: Option<CohostAutoHighlight>,
    /// Outstanding command (cleared when its card shows up live, or times out).
    requested: Option<PendingAutoRequest>,
    /// The card currently live on the overlay, as last observed.
    card: Option<ObservedCard>,
    /// When the previous card left the stream (its expiry, or an earlier clear).
    last_card_end: Option<Instant>,
    /// Message ids that were on stream this session, automatically or by hand.
    shown: HashSet<String>,
    /// Author key of the previous automatic card.
    last_author: Option<String>,
    /// Types of the recent automatic cards, oldest first (bounded).
    recent_types: Vec<CohostHighlightType>,
    /// The voice card that already got its one refresh.
    voice_refreshed: Option<String>,
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
            known: HashMap::new(),
            deleted_ids: HashSet::new(),
            highlights: Vec::new(),
            alert_reports: Vec::new(),
            mood_scores: None,
            auto: AutoHighlightLedger::default(),
            spotlight: SpotlightLane::default(),
            recently_resolved: Vec::new(),
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
            auto_highlight: self.auto.latest.clone(),
            spotlight: self.spotlight_at(now),
            recently_resolved: self.recently_resolved_at(now),
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

    fn remember_id(&mut self, id: &str, known: KnownMessage) {
        if self.known_set.insert(id.to_string()) {
            self.known_ids.push_back(id.to_string());
            self.known.insert(id.to_string(), known);
            while self.known_ids.len() > KNOWN_MESSAGE_IDS_CAP {
                if let Some(evicted) = self.known_ids.pop_front() {
                    self.known_set.remove(&evicted);
                    self.known.remove(&evicted);
                    self.deleted_ids.remove(&evicted);
                }
            }
        }
    }

    /// Buffer eligible rows newer than the cursor. Tombstones for a pending
    /// row pull it out of the delta (deleted messages never reach the model).
    /// `now` is when the engine saw the rows: the automatic-card age rule
    /// counts from it, never from a provider timestamp.
    fn note_messages(&mut self, messages: &[LiveChatMessage], now: Instant) -> usize {
        let mut noted = 0;
        let mut ordered: Vec<&LiveChatMessage> = messages
            .iter()
            .filter(|message| message.session_id == self.session_id)
            .collect();
        ordered.sort_by(|a, b| (&a.received_at, &a.id).cmp(&(&b.received_at, &b.id)));
        for message in ordered {
            if message.is_deleted || message.event_type == LiveChatEventType::Deleted {
                self.pending.retain(|pending| pending.id != message.id);
                // A deleted comment is never suggested for the stream, and
                // never stays the spotlight.
                if self.known_set.contains(&message.id) {
                    self.deleted_ids.insert(message.id.clone());
                    self.highlights
                        .retain(|highlight| highlight.message_id != message.id);
                    self.drop_spotlight_for(&message.id);
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
            self.remember_id(
                &message.id,
                KnownMessage {
                    author: alert_author_key(message),
                    author_name: mapped.author.clone(),
                    roles: mapped.roles.clone().unwrap_or_default(),
                    text: mapped.text.clone(),
                    at: mapped.at.clone(),
                    noted_at: now,
                },
            );
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
        // A tick may flag what the spotlight lane matched a moment ago.
        if let Some(flagged) = self
            .spotlight
            .current
            .as_ref()
            .map(|current| current.message_id.clone())
            .filter(|id| self.flags.iter().any(|flag| &flag.message_id == id))
        {
            self.drop_spotlight_for(&flagged);
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
            let Some(author) = self.known.get(&alert.message_id) else {
                continue;
            };
            self.alert_reports.push(AlertReport {
                kind: match alert.kind {
                    CohostAlertKind::Unknown => CohostAlertKind::Other,
                    known => known,
                },
                author: author.author.clone(),
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
        self.drop_spotlight_for(message_id);
        before != self.flags.len()
    }

    // --- Spotlight lane (plan 060 S3) ----------------------------------------

    /// The spotlight as the wire sees it: `None` once it expired.
    fn spotlight_at(&self, now: Instant) -> Option<CohostSpotlight> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| now < current.expires_at)
            .map(|current| CohostSpotlight {
                message_id: current.message_id.clone(),
                question_id: current.question_id.clone(),
                score: current.score,
                at: current.at_iso.clone(),
                expires_at: current.expires_at_iso.clone(),
            })
    }

    /// The message the Voice source may put on stream right now.
    fn spotlight_message_id(&self, now: Instant) -> Option<&str> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| now < current.expires_at)
            .map(|current| current.message_id.as_str())
    }

    fn drop_spotlight_for(&mut self, message_id: &str) {
        if self
            .spotlight
            .current
            .as_ref()
            .is_some_and(|current| current.message_id == message_id)
        {
            self.spotlight.current = None;
        }
    }

    /// Clear an expired spotlight. True when one just left (news for the
    /// renderer: the pull-up must go).
    fn expire_spotlight(&mut self, now: Instant) -> bool {
        if self
            .spotlight
            .current
            .as_ref()
            .is_some_and(|current| now >= current.expires_at)
        {
            self.spotlight.current = None;
            return true;
        }
        false
    }

    fn recently_resolved_at(&self, now: Instant) -> Vec<CohostRecentlyResolved> {
        self.recently_resolved
            .iter()
            .filter(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL)
            .map(|record| record.entry.clone())
            .collect()
    }

    /// Resolve an open question because the streamer answered it on air:
    /// it leaves the open set like `mark_answered`, and is kept for a minute
    /// so the streamer can put it back.
    fn resolve_by_voice(&mut self, question_id: &str, now: Instant, now_iso: &str) -> bool {
        let Some(question) = self
            .questions
            .iter()
            .find(|question| question.id == question_id)
            .cloned()
        else {
            return false;
        };
        self.mark_answered(question_id);
        self.recently_resolved
            .retain(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL);
        self.recently_resolved.push(ResolvedRecord {
            entry: CohostRecentlyResolved {
                question,
                reason: CohostResolveReason::Voice,
                resolved_at: now_iso.to_string(),
            },
            at: now,
        });
        while self.recently_resolved.len() > RECENTLY_RESOLVED_CAP {
            self.recently_resolved.remove(0);
        }
        true
    }

    /// `cohost.question.restore`: a recently voice-resolved question goes back
    /// to the open set, may return from later ticks again, and leaves the
    /// recently-resolved list. False when it is not there (or too old).
    fn restore_question(&mut self, question_id: &str, now: Instant) -> bool {
        self.recently_resolved
            .retain(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL);
        let Some(index) = self
            .recently_resolved
            .iter()
            .position(|record| record.entry.question.id == question_id)
        else {
            return false;
        };
        let record = self.recently_resolved.remove(index);
        self.dismissed_questions.remove(question_id);
        self.spotlight.answered_streak.remove(question_id);
        if !self
            .questions
            .iter()
            .any(|question| question.id == question_id)
        {
            self.questions.push(record.entry.question);
        }
        true
    }

    /// Safety at send time and at receipt: known, not deleted, not flagged or
    /// flag-dismissed, never the broadcaster.
    fn spotlight_eligible(&self, message_id: &str) -> Option<&KnownMessage> {
        let known = self.known.get(message_id)?;
        if self.deleted_ids.contains(message_id)
            || self.dismissed_flags.contains(message_id)
            || self.flags.iter().any(|flag| flag.message_id == message_id)
            || known.roles.iter().any(|role| role == "owner")
        {
            return None;
        }
        Some(known)
    }

    fn spotlight_candidate(
        &self,
        message_id: &str,
        question: Option<&CohostQuestion>,
    ) -> Option<CohostSpotlightCandidate> {
        if message_id.chars().count() > SPOTLIGHT_CANDIDATE_ID_MAX_CHARS {
            return None;
        }
        let known = self.spotlight_eligible(message_id)?;
        let author = truncate_chars(known.author_name.trim(), SPOTLIGHT_AUTHOR_MAX_CHARS);
        // A question id the server would reject makes the row a plain
        // candidate: still "about", no "answered".
        let question = question
            .filter(|question| question.id.chars().count() <= SPOTLIGHT_QUESTION_ID_MAX_CHARS);
        Some(CohostSpotlightCandidate {
            id: message_id.to_string(),
            text: known.text.clone(),
            author: if author.is_empty() {
                "Viewer".to_string()
            } else {
                author
            },
            roles: (!known.roles.is_empty()).then(|| known.roles.clone()),
            at: known.at.clone(),
            question_id: question.map(|question| question.id.clone()),
            question_text: question
                .map(|question| truncate_chars(question.text.trim(), TICK_MESSAGE_TEXT_MAX_CHARS))
                .filter(|text| !text.is_empty()),
        })
    }

    /// Open questions first (the first `SPOTLIGHT_QUESTION_CANDIDATES_CAP`
    /// eligible ones by priority, then recency; the first message carries
    /// the question), then
    /// the newest eligible messages of the last `SPOTLIGHT_MESSAGE_MAX_AGE`,
    /// `SPOTLIGHT_CANDIDATES_CAP` in total. Ids are unique.
    fn spotlight_candidates(&self, now: Instant) -> Vec<CohostSpotlightCandidate> {
        let mut candidates: Vec<CohostSpotlightCandidate> = Vec::new();
        let mut ids: HashSet<&str> = HashSet::new();
        let mut questions: Vec<&CohostQuestion> = self.questions.iter().collect();
        questions.sort_by(|a, b| {
            priority_rank(a.priority)
                .cmp(&priority_rank(b.priority))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        for question in questions {
            if candidates.len() >= SPOTLIGHT_QUESTION_CANDIDATES_CAP {
                break;
            }
            let Some(message_id) = question.message_ids.first() else {
                continue;
            };
            if ids.contains(message_id.as_str()) {
                continue;
            }
            if let Some(candidate) = self.spotlight_candidate(message_id, Some(question)) {
                ids.insert(message_id.as_str());
                candidates.push(candidate);
            }
        }
        // `known_ids` is note order, so the tail is the newest.
        for message_id in self.known_ids.iter().rev() {
            if candidates.len() >= SPOTLIGHT_CANDIDATES_CAP {
                break;
            }
            let Some(known) = self.known.get(message_id) else {
                continue;
            };
            if now.saturating_duration_since(known.noted_at) > SPOTLIGHT_MESSAGE_MAX_AGE {
                break;
            }
            if ids.contains(message_id.as_str()) {
                continue;
            }
            if let Some(candidate) = self.spotlight_candidate(message_id, None) {
                ids.insert(message_id.as_str());
                candidates.push(candidate);
            }
        }
        candidates
    }

    fn build_spotlight_request(
        &mut self,
        transcript: &TranscriptSnapshot,
        candidates: Vec<CohostSpotlightCandidate>,
        now: Instant,
    ) -> CohostSpotlightRequest {
        self.spotlight.seq = self.spotlight.seq.saturating_add(1);
        self.spotlight.in_flight = true;
        self.spotlight.last_call_at = Some(now);
        self.spotlight.last_version = Some(transcript.version);
        let mut request = CohostSpotlightRequest {
            client_version: DESKTOP_CLIENT_VERSION.to_string(),
            session_client_id: self.session_id.clone(),
            consent_to_process_chat: self.consent,
            transcript: transcript.text.clone(),
            seq: self.spotlight.seq,
            candidates,
        };
        trim_spotlight_request_to_budget(&mut request, COHOST_SPOTLIGHT_MAX_BODY_BYTES);
        request
    }

    /// Merge one spotlight answer. The best `about` at or above the threshold
    /// becomes (or refreshes) the spotlight — highest score, tie to the
    /// earliest message; a match on a message that is flagged, deleted or
    /// unknown by now is dropped. `answered` at or above its threshold on
    /// `SPOTLIGHT_ANSWERED_STREAK` calls in a row resolves the question.
    fn apply_spotlight_response(
        &mut self,
        response: CohostSpotlightResponse,
        now: Instant,
        now_iso: &str,
    ) -> SpotlightOutcome {
        self.spotlight.in_flight = false;
        self.spotlight.failures = 0;
        self.spotlight.off_until = None;
        let mut outcome = SpotlightOutcome::default();

        let mut best: Option<(String, Option<String>, f64, String)> = None;
        let mut hits: HashSet<String> = HashSet::new();
        for matched in &response.matches {
            let Some(known) = self.spotlight_eligible(&matched.message_id) else {
                continue;
            };
            let about = unit_interval(matched.about).unwrap_or(0.0);
            if about >= SPOTLIGHT_ABOUT_THRESHOLD {
                let better = match &best {
                    None => true,
                    Some((_, _, best_about, best_at)) => {
                        about > *best_about || (about == *best_about && known.at < *best_at)
                    }
                };
                if better {
                    best = Some((
                        matched.message_id.clone(),
                        matched.question_id.clone(),
                        about,
                        known.at.clone(),
                    ));
                }
            }
            if let (Some(question_id), Some(answered)) = (
                &matched.question_id,
                matched.answered.and_then(unit_interval),
            ) && answered >= SPOTLIGHT_ANSWERED_THRESHOLD
                && self
                    .questions
                    .iter()
                    .any(|question| &question.id == question_id)
            {
                hits.insert(question_id.clone());
            }
        }

        if self.expire_spotlight(now) {
            outcome.changed = true;
        }
        if let Some((message_id, question_id, about, _)) = best {
            let expires_at = now + SPOTLIGHT_EXPIRY;
            let expires_at_iso = iso_after(now, expires_at);
            match self.spotlight.current.as_mut() {
                Some(current) if current.message_id == message_id => {
                    current.score = about;
                    current.question_id = question_id;
                    current.expires_at = expires_at;
                    current.expires_at_iso = expires_at_iso;
                }
                _ => {
                    self.spotlight.current = Some(SpotlightRecord {
                        message_id: message_id.clone(),
                        question_id,
                        score: about,
                        at_iso: now_iso.to_string(),
                        expires_at,
                        expires_at_iso,
                    });
                    outcome.spotlight_set = Some((message_id, about));
                }
            }
            outcome.changed = true;
        }

        // A call that does not say "answered" breaks the streak.
        self.spotlight
            .answered_streak
            .retain(|question_id, _| hits.contains(question_id));
        let mut resolve: Vec<String> = Vec::new();
        for question_id in hits {
            let streak = self
                .spotlight
                .answered_streak
                .entry(question_id.clone())
                .or_insert(0);
            *streak += 1;
            if *streak >= SPOTLIGHT_ANSWERED_STREAK {
                resolve.push(question_id);
            }
        }
        resolve.sort();
        for question_id in resolve {
            self.spotlight.answered_streak.remove(&question_id);
            if self.resolve_by_voice(&question_id, now, now_iso) {
                outcome.changed = true;
                outcome.resolved.push(question_id);
            }
        }
        outcome
    }

    /// The lane's breaker (D12: degrade to nothing). Nothing here touches the
    /// tick's status, reason, detail or backoff.
    fn apply_spotlight_failure(
        &mut self,
        error: &CohostApiError,
        now: Instant,
    ) -> SpotlightOutcome {
        self.spotlight.in_flight = false;
        // "Two consecutive calls" means consecutive answers: a hit, a failed
        // call, then a hit is not a streak.
        self.spotlight.answered_streak.clear();
        let unavailable = error.detail.status == Some(404)
            || error.kind == CohostApiErrorKind::PremiumRequired
            || matches!(
                error.detail.code.as_str(),
                "spotlight-disabled" | "judge-unconfigured" | "premium-required"
            );
        let off = if unavailable {
            Some(SPOTLIGHT_UNAVAILABLE_OFF)
        } else if let CohostApiErrorKind::QuotaExhausted { retry_after } = error.kind {
            Some(retry_after.unwrap_or(SPOTLIGHT_UNAVAILABLE_OFF))
        } else {
            self.spotlight.failures += 1;
            (self.spotlight.failures >= SPOTLIGHT_BREAKER_FAILURES).then_some(SPOTLIGHT_BREAKER_OFF)
        };
        if let Some(off) = off {
            self.spotlight.failures = 0;
            self.spotlight.off_until = Some(now + off);
        }
        SpotlightOutcome {
            lane_off_for: off,
            ..SpotlightOutcome::default()
        }
    }

    // --- Automatic on-stream cards (plan 060 S1) -----------------------------

    /// Record what the comment-highlight overlay shows right now. A live card
    /// the engine asked for settles its request; any live card counts as shown
    /// this session (never re-shown automatically); a card leaving the stream
    /// fixes the cooldown anchor at its expiry or its earlier clear.
    fn observe_overlay(&mut self, overlay: &OverlayObservation, now: Instant) {
        match overlay.live_message_id.as_deref() {
            Some(message_id) => {
                let observed_expiry = now + overlay.remaining;
                let requested = self.auto.requested.as_ref().is_some_and(|request| {
                    request.message_id == message_id
                        && (!request.refresh
                            || !self.auto.card.as_ref().is_some_and(|card| {
                                observed_expiry <= card.expires_at + Duration::from_secs(1)
                            }))
                });
                if requested {
                    // Fulfilled: the wire command leaves the snapshot so a
                    // renderer that (re)connects later never replays it.
                    self.auto.requested = None;
                    self.auto.latest = None;
                }
                let engine_set = requested
                    || self
                        .auto
                        .card
                        .as_ref()
                        .is_some_and(|card| card.message_id == message_id && card.engine_set);
                self.auto.card = Some(ObservedCard {
                    message_id: message_id.to_string(),
                    engine_set,
                    expires_at: observed_expiry,
                });
                self.auto.shown.insert(message_id.to_string());
            }
            None => {
                if let Some(card) = self.auto.card.take() {
                    self.auto.last_card_end = Some(card.expires_at.min(now));
                }
            }
        }
        // A command the renderer never fulfilled (message gone from its
        // snapshot, card ineligible) must not block the policy for ever.
        if self.auto.requested.as_ref().is_some_and(|request| {
            now.saturating_duration_since(request.asked_at) > AUTO_HIGHLIGHT_APPLY_TIMEOUT
        }) {
            self.auto.requested = None;
            self.auto.latest = None;
        }
    }

    /// One candidate with the safety facts read at fire time, or `None` for a
    /// message the engine never noted (or evicted).
    fn auto_candidate(
        &self,
        message_id: &str,
        source: CohostAutoHighlightSource,
        highlight_type: CohostHighlightType,
        score: f64,
        now: Instant,
    ) -> Option<AutoHighlightCandidate> {
        let known = self.known.get(message_id)?;
        Some(AutoHighlightCandidate {
            message_id: message_id.to_string(),
            author: known.author.clone(),
            roles: known.roles.clone(),
            source,
            highlight_type,
            score,
            age: now.saturating_duration_since(known.noted_at),
            flagged: self.flags.iter().any(|flag| flag.message_id == message_id),
            flag_dismissed: self.dismissed_flags.contains(message_id),
            deleted: self.deleted_ids.contains(message_id),
        })
    }

    fn auto_highlight_input(
        &self,
        picks_enabled: bool,
        voice_enabled: bool,
        voice: Option<AutoHighlightCandidate>,
        now: Instant,
    ) -> AutoHighlightInput {
        let card = match (&self.auto.card, &self.auto.requested) {
            (Some(card), _) => AutoHighlightCard::Live {
                message_id: card.message_id.clone(),
                engine_set: card.engine_set,
                remaining: card.expires_at.saturating_duration_since(now),
            },
            (None, Some(_)) => AutoHighlightCard::Applying,
            (None, None) => AutoHighlightCard::None,
        };
        let mut candidates: Vec<AutoHighlightCandidate> = Vec::new();
        for highlight in &self.highlights {
            if let Some(candidate) = self.auto_candidate(
                &highlight.message_id,
                CohostAutoHighlightSource::Pick,
                highlight.highlight_type,
                highlight.score,
                now,
            ) {
                candidates.push(candidate);
            }
        }
        for question in &self.questions {
            if question.priority != CohostPriority::High {
                continue;
            }
            let Some(message_id) = question.message_ids.first() else {
                continue;
            };
            // A server pick of the same message already carries a real score.
            if candidates
                .iter()
                .any(|candidate| &candidate.message_id == message_id)
            {
                continue;
            }
            if let Some(candidate) = self.auto_candidate(
                message_id,
                CohostAutoHighlightSource::Question,
                CohostHighlightType::Question,
                AUTO_HIGHLIGHT_QUESTION_SCORE,
                now,
            ) {
                candidates.push(candidate);
            }
        }
        AutoHighlightInput {
            picks_enabled,
            voice_enabled,
            card,
            since_last_card_end: self
                .auto
                .last_card_end
                .map(|end| now.saturating_duration_since(end)),
            last_author: self.auto.last_author.clone(),
            recent_types: self.auto.recent_types.clone(),
            tension: self.mood_scores.map(|scores| scores.tension),
            candidates,
            voice_refreshed: voice.as_ref().is_some_and(|voice| {
                self.auto.voice_refreshed.as_deref() == Some(voice.message_id.as_str())
            }),
            voice,
            shown: self.auto.shown.clone(),
        }
    }

    /// Record a decision and turn it into the command the renderer executes.
    fn apply_auto_decision(
        &mut self,
        decision: AutoHighlightDecision,
        generation: u64,
        now: Instant,
    ) -> CohostAutoHighlight {
        if decision.refresh {
            self.auto.voice_refreshed = Some(decision.message_id.clone());
        }
        self.auto.requested = Some(PendingAutoRequest {
            message_id: decision.message_id.clone(),
            asked_at: now,
            refresh: decision.refresh,
        });
        self.auto.shown.insert(decision.message_id.clone());
        self.auto.last_author = Some(decision.author);
        if let Some(highlight_type) = decision.highlight_type {
            self.auto.recent_types.push(highlight_type);
            while self.auto.recent_types.len() > AUTO_HIGHLIGHT_TYPE_RUN {
                self.auto.recent_types.remove(0);
            }
        }
        let command = CohostAutoHighlight {
            generation,
            message_id: decision.message_id,
            source: decision.source,
            refresh: decision.refresh,
        };
        self.auto.latest = Some(command.clone());
        command
    }
}

/// The comment-highlight overlay as the automatic-card rules see it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OverlayObservation {
    /// The message on stream right now (`phase == live`), else `None`.
    pub(crate) live_message_id: Option<String>,
    /// Time left on that card; zero when unknown.
    pub(crate) remaining: Duration,
}

impl OverlayObservation {
    pub(crate) fn from_highlight(highlight: &CommentHighlightState) -> Self {
        if highlight.phase != CommentHighlightPhase::Live {
            return Self::default();
        }
        let remaining = highlight
            .expires_at
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .and_then(|at| {
                (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
                    .to_std()
                    .ok()
            })
            .unwrap_or_default();
        Self {
            live_message_id: highlight.message_id.clone(),
            remaining,
        }
    }
}

/// One message the automatic-card policy may put on stream, with every
/// safety fact read at fire time (a later tick can flag what an earlier one
/// suggested).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AutoHighlightCandidate {
    pub(crate) message_id: String,
    /// Platform-qualified author key.
    pub(crate) author: String,
    /// Normalised roles (`mod`, `owner`, `subscriber`, `member`, `vip`).
    pub(crate) roles: Vec<String>,
    pub(crate) source: CohostAutoHighlightSource,
    pub(crate) highlight_type: CohostHighlightType,
    /// Server score (Pick) or the question baseline; unused for Voice.
    pub(crate) score: f64,
    /// Since the engine noted the message.
    pub(crate) age: Duration,
    pub(crate) flagged: bool,
    pub(crate) flag_dismissed: bool,
    pub(crate) deleted: bool,
}

/// What is on stream when the policy runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AutoHighlightCard {
    None,
    /// The engine asked for a card the renderer has not set yet.
    Applying,
    Live {
        message_id: String,
        /// The engine asked for it (false: the streamer set it by hand).
        engine_set: bool,
        remaining: Duration,
    },
}

/// Plain input of `auto_highlight_pick`: everything the rules need, nothing
/// they must look up.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AutoHighlightInput {
    /// `settings.auto_highlight`: Pick and Question sources.
    pub(crate) picks_enabled: bool,
    /// `settings.voice_highlight`: the Voice source.
    pub(crate) voice_enabled: bool,
    pub(crate) card: AutoHighlightCard,
    /// Since the previous card (whoever set it) left the stream; `None` when
    /// no card has been on stream this session.
    pub(crate) since_last_card_end: Option<Duration>,
    /// Author key of the previous automatic card.
    pub(crate) last_author: Option<String>,
    /// Types of the recent automatic cards, oldest first.
    pub(crate) recent_types: Vec<CohostHighlightType>,
    /// `mood_scores.tension` from the latest tick.
    pub(crate) tension: Option<f64>,
    /// Pick and Question candidates.
    pub(crate) candidates: Vec<AutoHighlightCandidate>,
    /// The comment the streamer is talking about right now (source Voice).
    pub(crate) voice: Option<AutoHighlightCandidate>,
    /// The voice card already had its one refresh.
    pub(crate) voice_refreshed: bool,
    /// Message ids that were on stream this session.
    pub(crate) shown: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutoHighlightDecision {
    pub(crate) message_id: String,
    pub(crate) author: String,
    pub(crate) source: CohostAutoHighlightSource,
    /// `None` for a voice card: it takes no part in the type-run rule.
    pub(crate) highlight_type: Option<CohostHighlightType>,
    pub(crate) refresh: bool,
}

impl AutoHighlightDecision {
    fn show(candidate: &AutoHighlightCandidate, refresh: bool) -> Self {
        Self {
            message_id: candidate.message_id.clone(),
            author: candidate.author.clone(),
            source: candidate.source,
            highlight_type: (candidate.source != CohostAutoHighlightSource::Voice)
                .then_some(candidate.highlight_type),
            refresh,
        }
    }
}

/// D5: a small additive bonus, never a filter. The best role counts once.
fn auto_highlight_role_bonus(roles: &[String]) -> f64 {
    roles
        .iter()
        .map(|role| match role.as_str() {
            "member" | "subscriber" | "vip" => AUTO_HIGHLIGHT_ROLE_BONUS_MEMBER,
            "mod" => AUTO_HIGHLIGHT_ROLE_BONUS_MOD,
            _ => 0.0,
        })
        .fold(0.0, f64::max)
}

/// D6 at fire time: not flagged now, not flag-dismissed, not deleted, and
/// never the broadcaster's own message.
fn auto_highlight_safe(candidate: &AutoHighlightCandidate) -> bool {
    !candidate.flagged
        && !candidate.flag_dismissed
        && !candidate.deleted
        && !candidate.roles.iter().any(|role| role == "owner")
}

/// The type the last `AUTO_HIGHLIGHT_TYPE_RUN - 1` automatic cards all had.
fn auto_highlight_run_type(recent: &[CohostHighlightType]) -> Option<CohostHighlightType> {
    let run = AUTO_HIGHLIGHT_TYPE_RUN - 1;
    if recent.len() < run {
        return None;
    }
    let tail = &recent[recent.len() - run..];
    let last = *tail.last()?;
    tail.iter().all(|kind| *kind == last).then_some(last)
}

/// The automatic on-stream card policy, pure for the test matrix (plan 060,
/// D4, D5, D6, D10). At most one automatic card per `AUTO_HIGHLIGHT_COOLDOWN`
/// from the previous card's end; never while a card is live or applying;
/// never the previous automatic author; never older than
/// `AUTO_HIGHLIGHT_MAX_AGE`; not the same type three times in a row when an
/// alternative exists; never at tension >= 0.7; never the broadcaster; the
/// safety gate re-checked now; never a message already shown this session.
/// Voice bypasses the cooldown and the age rule, may refresh its own card
/// once while the match persists, and never replaces a card the streamer set
/// by hand. Ties: score desc, then oldest, then id.
pub(crate) fn auto_highlight_pick(input: &AutoHighlightInput) -> Option<AutoHighlightDecision> {
    if input
        .tension
        .is_some_and(|tension| tension >= AUTO_HIGHLIGHT_TENSION_CEILING)
    {
        return None;
    }
    let voice = input
        .voice
        .as_ref()
        .filter(|voice| input.voice_enabled && voice.source == CohostAutoHighlightSource::Voice);
    match &input.card {
        AutoHighlightCard::Applying => return None,
        AutoHighlightCard::Live {
            message_id,
            engine_set,
            remaining,
        } => {
            // The only thing allowed over a live card: one refresh of the
            // engine's own voice card while the same match persists.
            let voice = voice?;
            if !engine_set
                || voice.message_id != *message_id
                || input.voice_refreshed
                || *remaining > AUTO_HIGHLIGHT_VOICE_REFRESH_WINDOW
                || !auto_highlight_safe(voice)
            {
                return None;
            }
            return Some(AutoHighlightDecision::show(voice, true));
        }
        AutoHighlightCard::None => {}
    }
    let not_previous_author = |candidate: &AutoHighlightCandidate| {
        input.last_author.as_deref() != Some(candidate.author.as_str())
    };
    if let Some(voice) = voice.filter(|voice| {
        auto_highlight_safe(voice)
            && not_previous_author(voice)
            && !input.shown.contains(&voice.message_id)
    }) {
        return Some(AutoHighlightDecision::show(voice, false));
    }
    if !input.picks_enabled {
        return None;
    }
    if input
        .since_last_card_end
        .is_some_and(|since| since < AUTO_HIGHLIGHT_COOLDOWN)
    {
        return None;
    }
    let eligible: Vec<&AutoHighlightCandidate> = input
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.source != CohostAutoHighlightSource::Voice
                && auto_highlight_safe(candidate)
                && not_previous_author(candidate)
                && candidate.age <= AUTO_HIGHLIGHT_MAX_AGE
                && !input.shown.contains(&candidate.message_id)
        })
        .collect();
    let pool: Vec<&AutoHighlightCandidate> = match auto_highlight_run_type(&input.recent_types) {
        Some(run)
            if eligible
                .iter()
                .any(|candidate| candidate.highlight_type != run) =>
        {
            eligible
                .into_iter()
                .filter(|candidate| candidate.highlight_type != run)
                .collect()
        }
        _ => eligible,
    };
    let effective = |candidate: &AutoHighlightCandidate| {
        candidate.score + auto_highlight_role_bonus(&candidate.roles)
    };
    pool.into_iter()
        .min_by(|a, b| {
            effective(b)
                .partial_cmp(&effective(a))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.age.cmp(&a.age))
                .then_with(|| a.message_id.cmp(&b.message_id))
        })
        .map(|candidate| AutoHighlightDecision::show(candidate, false))
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

/// Spotlight cadence, pure for the test matrix (D7): a call goes out when the
/// transcript window changed since the last call, at least
/// `SPOTLIGHT_DEBOUNCE` after the latest final, at least `SPOTLIGHT_MIN_GAP`
/// after the previous call, never while one is outstanding, never while the
/// breaker holds the lane, never on an empty window.
pub(crate) fn spotlight_due(
    window: &TranscriptSnapshot,
    last_version: Option<u64>,
    last_call_at: Option<Instant>,
    in_flight: bool,
    off_until: Option<Instant>,
    now: Instant,
) -> bool {
    if in_flight || window.text.is_empty() {
        return false;
    }
    if off_until.is_some_and(|until| now < until) {
        return false;
    }
    if last_version == Some(window.version) {
        return false;
    }
    let Some(last_final) = window.last_final_at else {
        return false;
    };
    if now.saturating_duration_since(last_final) < SPOTLIGHT_DEBOUNCE {
        return false;
    }
    if last_call_at.is_some_and(|last| now.saturating_duration_since(last) < SPOTLIGHT_MIN_GAP) {
        return false;
    }
    true
}

/// Drop candidates from the end (the oldest plain messages go first, the
/// questions last) until the JSON body fits the server's byte budget. At
/// least one candidate always stays.
pub(crate) fn trim_spotlight_request_to_budget(
    request: &mut CohostSpotlightRequest,
    max_bytes: usize,
) {
    while request.candidates.len() > 1
        && serde_json::to_vec(request)
            .map(|body| body.len())
            .unwrap_or(0)
            > max_bytes
    {
        request.candidates.pop();
    }
}

fn priority_rank(priority: CohostPriority) -> u8 {
    match priority {
        CohostPriority::High => 0,
        CohostPriority::Normal => 1,
        CohostPriority::Low => 2,
        CohostPriority::Unknown => 3,
    }
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
    /// The spotlight lane's own poll loop (plan 060 S3): it shares the engine
    /// lock but never the tick's await, so a slow tick cannot delay it.
    spotlight_scheduler: Option<JoinHandle<()>>,
    /// Engine-wide counter for automatic-card commands: never repeats across
    /// sessions, so the renderer can key on it alone.
    auto_highlight_generation: u64,
}

impl CohostEngine {
    pub fn new(settings: CohostSettings) -> Self {
        Self {
            settings: settings.normalized(),
            generation: 0,
            session: None,
            scheduler: None,
            spotlight_scheduler: None,
            auto_highlight_generation: 0,
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
        if let Some(handle) = self.spotlight_scheduler.take() {
            handle.abort();
        }
        self.generation = self.generation.wrapping_add(1);
        self.session.take().is_some()
    }

    pub(crate) fn note_messages(&mut self, messages: &[LiveChatMessage]) -> usize {
        self.note_messages_at(messages, Instant::now())
    }

    fn note_messages_at(&mut self, messages: &[LiveChatMessage], now: Instant) -> usize {
        self.session
            .as_mut()
            .map(|session| session.note_messages(messages, now))
            .unwrap_or(0)
    }

    /// One scheduler pass of the automatic-card policy (plan 060 S1). The
    /// overlay is observed on every pass (so the ledger stays true while the
    /// setting is off); the pick runs only while listening with picks or
    /// voice enabled. The Voice source is the session's live spotlight (S3).
    /// Returns the new command when the engine decided.
    pub(crate) fn evaluate_auto_highlight(
        &mut self,
        generation: u64,
        overlay: &OverlayObservation,
        now: Instant,
    ) -> Option<CohostAutoHighlight> {
        let picks_enabled = self.settings.auto_highlight;
        let voice_enabled = self.settings.voice_highlight;
        let session = self.session.as_mut()?;
        if session.generation != generation {
            return None;
        }
        session.observe_overlay(overlay, now);
        if session.status != CohostStatus::Listening || !(picks_enabled || voice_enabled) {
            return None;
        }
        let voice = session
            .spotlight_message_id(now)
            .map(str::to_string)
            .and_then(|message_id| {
                session.auto_candidate(
                    &message_id,
                    CohostAutoHighlightSource::Voice,
                    CohostHighlightType::Other,
                    0.0,
                    now,
                )
            });
        let input = session.auto_highlight_input(picks_enabled, voice_enabled, voice, now);
        let decision = auto_highlight_pick(&input)?;
        self.auto_highlight_generation = self.auto_highlight_generation.wrapping_add(1).max(1);
        Some(session.apply_auto_decision(decision, self.auto_highlight_generation, now))
    }

    #[cfg(test)]
    fn snapshot_at_for_test(&self, now: Instant) -> CohostState {
        self.session
            .as_ref()
            .map(|session| session.snapshot_at(now))
            .unwrap_or_else(CohostState::off)
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

    fn has_spotlight(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.spotlight.current.is_some())
    }

    /// One pass of the spotlight lane (plan 060 S3, D7). Same run
    /// preconditions as the tick (enabled, Premium, consent, signed in) but a
    /// silent `Idle` instead of a paused reason: the tick owns the pause and
    /// its copy. Sends only while listening, on the lane's own cadence, with
    /// at least one candidate.
    pub(crate) fn prepare_spotlight(
        &mut self,
        generation: u64,
        signed_in: bool,
        premium: bool,
        transcript: &TranscriptSnapshot,
        now: Instant,
    ) -> SpotlightPass {
        if !self.settings.enabled {
            return SpotlightPass::Stopped;
        }
        let Some(session) = self.session.as_mut() else {
            return SpotlightPass::Stopped;
        };
        if session.generation != generation {
            return SpotlightPass::Stopped;
        }
        if session.status != CohostStatus::Listening || !premium || !session.consent || !signed_in {
            return SpotlightPass::Idle;
        }
        if !spotlight_due(
            transcript,
            session.spotlight.last_version,
            session.spotlight.last_call_at,
            session.spotlight.in_flight,
            session.spotlight.off_until,
            now,
        ) {
            return SpotlightPass::Idle;
        }
        let candidates = session.spotlight_candidates(now);
        if candidates.is_empty() {
            return SpotlightPass::Idle;
        }
        SpotlightPass::Send(PreparedSpotlight {
            request: session.build_spotlight_request(transcript, candidates, now),
            generation,
        })
    }

    /// Merge a spotlight outcome. `None` (and nothing changes) when the
    /// answer belongs to a replaced session or generation.
    pub(crate) fn apply_spotlight_result(
        &mut self,
        generation: u64,
        result: Result<CohostSpotlightResponse, CohostApiError>,
        now: Instant,
        now_iso: &str,
    ) -> Option<SpotlightOutcome> {
        let session = self.session.as_mut()?;
        if session.generation != generation {
            return None;
        }
        Some(match result {
            Ok(response) => session.apply_spotlight_response(response, now, now_iso),
            Err(error) => session.apply_spotlight_failure(&error, now),
        })
    }

    /// Drop an expired spotlight; true when the state just changed.
    pub(crate) fn expire_spotlight(&mut self, generation: u64, now: Instant) -> bool {
        self.session
            .as_mut()
            .filter(|session| session.generation == generation)
            .is_some_and(|session| session.expire_spotlight(now))
    }

    fn restore_question(
        &mut self,
        session_id: &str,
        question_id: &str,
        now: Instant,
    ) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.restore_question(question_id, now))
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

/// Caption-coordinator hook (plan 060 S3): a settled caption joins the
/// transcript window. Finals only — a partial is replaced by its final. Lock,
/// append, return: no await, no engine lock, nothing the audio path waits on.
pub(crate) fn note_caption_final(state: &AppState, update: &CaptionsUpdate) {
    if update.kind != CaptionUpdateKind::Final {
        return;
    }
    if let Ok(mut window) = state.cohost_transcript.lock() {
        window.push(&update.text, Instant::now());
    }
}

/// A session boundary forgets what was said: the next session's spotlight
/// never sees the previous stream's words.
fn clear_transcript(state: &AppState) {
    if let Ok(mut window) = state.cohost_transcript.lock() {
        window.clear();
    }
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
        clear_transcript(state);
        state.emit_log("info", "Orcle stopped: turned off in Settings.");
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
    engine.spotlight_scheduler = Some(spawn_spotlight_scheduler(state.clone(), generation));
    let snapshot = engine.snapshot();
    drop(engine);
    clear_transcript(state);
    before_state_emit.await;
    state.emit_log("info", format!("Orcle listening for session {session_id}."));
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
    if stopped {
        clear_transcript(state);
    }
    before_state_emit.await;
    if stopped {
        state.emit_log("info", "Orcle stopped.");
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
    if stopped {
        clear_transcript(state);
    }
    before_state_emit.await;
    if stopped {
        state.emit_log("info", "Orcle stopped.");
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
        let spotlight_before = engine.has_spotlight();
        engine.note_messages(messages);
        let bucket_after = pending_bucket(engine.pending_len());
        // A tombstone that pulled a suggested comment (or the spotlight) is
        // also news: the renderer must stop offering it now, not at the
        // next tick.
        if bucket_before == bucket_after
            && highlights_before == engine.highlights_len()
            && spotlight_before == engine.has_spotlight()
        {
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

/// `cohost.question.restore` (D9): put a voice-resolved question back. The
/// open set gets it, the dismissed set forgets it, the recently-resolved list
/// drops it; a question that is not there (or older than a minute) is a
/// no-op with the current state.
pub async fn restore_question(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed =
        engine.restore_question(&params.session_id, &params.question_id, Instant::now())?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
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
    // Automatic on-stream cards: read the overlay first (its own lock, never
    // nested with the engine's), then let the engine decide. The Voice
    // source is the session's live spotlight (plan 060 S3).
    let overlay = OverlayObservation::from_highlight(&*state.comment_highlight.lock().await);
    let auto_command = {
        let mut engine = state.cohost.lock().await;
        engine
            .evaluate_auto_highlight(generation, &overlay, Instant::now())
            .map(|command| (command, engine.snapshot()))
    };
    if let Some((command, snapshot)) = auto_command {
        state.emit_log(
            "info",
            format!(
                "Orcle puts {} on stream ({}{}).",
                command.message_id,
                serde_json::to_string(&command.source).unwrap_or_default(),
                if command.refresh { ", refresh" } else { "" }
            ),
        );
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
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
                    "Orcle paused: {}.",
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
                "Orcle tick {} merged: {} message(s), {} open question(s), {} flag(s).",
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
                    "Orcle tick {}: the server does not speak tick contract v{}; using v{} for the rest of this session.",
                    prepared.request.tick_seq,
                    prepared.request.prompt_version,
                    COHOST_PROMPT_VERSION_FALLBACK
                ),
            ))
        }
        Err(error) => Some((
            "warn",
            format!(
                "Orcle tick {} failed ({}, {}{}): {}",
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
                "Orcle tick response dropped: its session was replaced.",
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

fn spawn_spotlight_scheduler(state: AppState, generation: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_POLL).await;
            if !run_spotlight_pass(&state, generation).await {
                break;
            }
        }
    })
}

/// One pass of the spotlight lane (plan 060 S3). Its own loop, not the tick
/// scheduler's: that pass awaits the tick request inline (up to 12 s) and
/// D7 says the lane never waits on the tick. Both share the engine lock, so
/// a tick and a spotlight answer merge in whichever order they land.
/// Returns false when the lane must exit.
async fn run_spotlight_pass(state: &AppState, generation: u64) -> bool {
    let token = crate::account::stored_session_token();
    let premium = premium_entitled();
    let now = Instant::now();
    let transcript = state
        .cohost_transcript
        .lock()
        .map(|window| window.snapshot(now))
        .unwrap_or_default();
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (expired, pass) = {
        let mut engine = state.cohost.lock().await;
        // The pull-up leaves the state the second it is stale, whether or
        // not a call goes out.
        let expired = engine
            .expire_spotlight(generation, now)
            .then(|| engine.snapshot());
        let pass = engine.prepare_spotlight(generation, token.is_some(), premium, &transcript, now);
        (expired, pass)
    };
    if let Some(snapshot) = expired {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    let prepared = match pass {
        SpotlightPass::Stopped => return false,
        SpotlightPass::Idle => return true,
        SpotlightPass::Send(prepared) => prepared,
    };
    drop(lifecycle_delivery);
    let result = match (token, VideorcApiClient::new()) {
        (Some(token), Ok(client)) => {
            client
                .post_cohost_spotlight(&token, &prepared.request)
                .await
        }
        (None, _) => Err(CohostApiError::network(
            "Signed out before the spotlight call.",
        )),
        (_, Err(error)) => Err(CohostApiError::network(error.to_string())),
    };
    let failure = result.as_ref().err().map(|error| {
        format!(
            "{}{}",
            error.detail.code,
            error
                .detail
                .status
                .map(|status| format!(", HTTP {status}"))
                .unwrap_or_default()
        )
    });
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (outcome, snapshot) = {
        let mut engine = state.cohost.lock().await;
        let Some(outcome) = engine.apply_spotlight_result(
            prepared.generation,
            result,
            Instant::now(),
            &chrono::Utc::now().to_rfc3339(),
        ) else {
            return false;
        };
        let snapshot = outcome.changed.then(|| engine.snapshot());
        (outcome, snapshot)
    };
    if let Some((message_id, about)) = &outcome.spotlight_set {
        state.emit_log(
            "info",
            format!(
                "Orcle spotlight: the streamer is talking about {message_id} (about {about:.2})."
            ),
        );
    }
    for question_id in &outcome.resolved {
        state.emit_log(
            "info",
            format!("Orcle marks question {question_id} answered on air."),
        );
    }
    if let (Some(off), Some(failure)) = (outcome.lane_off_for, failure) {
        // Quiet by design (D12): a log line, never a toast, never the tick.
        state.emit_log(
            "info",
            format!(
                "Orcle spotlight lane paused for {} s after {failure}.",
                off.as_secs()
            ),
        );
    }
    if let Some(snapshot) = snapshot {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
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
            details: None,
            reply: None,
            first_message: false,
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
            voice_highlight: false,
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

    // --- Automatic on-stream cards (plan 060 S1) -----------------------------

    fn auto_candidate(
        id: &str,
        author: &str,
        score: f64,
        highlight_type: CohostHighlightType,
    ) -> AutoHighlightCandidate {
        AutoHighlightCandidate {
            message_id: id.to_string(),
            author: author.to_string(),
            roles: Vec::new(),
            source: CohostAutoHighlightSource::Pick,
            highlight_type,
            score,
            age: secs(10),
            flagged: false,
            flag_dismissed: false,
            deleted: false,
        }
    }

    fn auto_input(candidates: Vec<AutoHighlightCandidate>) -> AutoHighlightInput {
        AutoHighlightInput {
            picks_enabled: true,
            voice_enabled: true,
            card: AutoHighlightCard::None,
            since_last_card_end: None,
            last_author: None,
            recent_types: Vec::new(),
            tension: Some(0.2),
            candidates,
            voice: None,
            voice_refreshed: false,
            shown: HashSet::new(),
        }
    }

    fn picked(input: &AutoHighlightInput) -> Option<String> {
        auto_highlight_pick(input).map(|decision| decision.message_id)
    }

    #[test]
    fn auto_highlight_matrix_matches_the_contract() {
        use CohostHighlightType::{Joke, Praise};
        let joke = auto_candidate("m-joke", "twitch:alice", 0.8, Joke);
        let praise = auto_candidate("m-praise", "twitch:bob", 0.6, Praise);
        let base = auto_input(vec![joke.clone(), praise.clone()]);

        // Best score wins; no card yet this session means no cooldown.
        let decision = auto_highlight_pick(&base).unwrap();
        assert_eq!(
            decision,
            AutoHighlightDecision {
                message_id: "m-joke".into(),
                author: "twitch:alice".into(),
                source: CohostAutoHighlightSource::Pick,
                highlight_type: Some(Joke),
                refresh: false,
            }
        );

        // Cooldown: 45 s from the previous card's end, whoever set it.
        let mut input = base.clone();
        input.since_last_card_end = Some(secs(44));
        assert_eq!(picked(&input), None);
        input.since_last_card_end = Some(secs(45));
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never while a card is live or applying.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-other".into(),
            engine_set: true,
            remaining: secs(5),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Applying;
        assert_eq!(picked(&input), None);

        // Never the previous automatic author.
        input = base.clone();
        input.last_author = Some("twitch:alice".into());
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Not the same type three times in a row when an alternative exists.
        input = base.clone();
        input.recent_types = vec![Joke, Joke];
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.candidates = vec![joke.clone()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.candidates = vec![joke.clone(), praise.clone()];
        input.recent_types = vec![Praise, Joke];
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never a message older than 120 s.
        input = base.clone();
        input.candidates[0].age = secs(120);
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.candidates[0].age = secs(121);
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Never while tension is 0.7 or higher.
        input = base.clone();
        input.tension = Some(0.7);
        assert_eq!(picked(&input), None);
        input.tension = Some(0.69);
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.tension = None;
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never the broadcaster.
        input = base.clone();
        input.candidates[0].roles = vec!["owner".into(), "mod".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Safety gate at fire time: flagged since, flag-dismissed, deleted.
        input = base.clone();
        input.candidates[0].flagged = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input = base.clone();
        input.candidates[0].flag_dismissed = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input = base.clone();
        input.candidates[0].deleted = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Shown once per session.
        input = base.clone();
        input.shown.insert("m-joke".into());
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.shown.insert("m-praise".into());
        assert_eq!(picked(&input), None);

        // Role bonus on top of the server score: +0.15 member/subscriber/vip,
        // +0.10 mod, best role once.
        input = base.clone();
        input.candidates[1].roles = vec!["subscriber".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke")); // 0.75 < 0.8
        input.candidates[1].score = 0.7;
        assert_eq!(picked(&input).as_deref(), Some("m-praise")); // 0.85 > 0.8
        input.candidates[1].roles = vec!["mod".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke")); // 0.80 does not beat 0.8
        input.candidates[1].roles = vec!["mod".into(), "vip".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-praise")); // best role once: 0.85

        // A high-priority question competes at 0.5 plus the role bonus.
        let mut question = auto_candidate("m-q", "twitch:dave", 0.5, CohostHighlightType::Question);
        question.source = CohostAutoHighlightSource::Question;
        input = auto_input(vec![praise.clone(), question.clone()]);
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.candidates[1].roles = vec!["vip".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-q")); // 0.65 > 0.6
        assert_eq!(
            auto_highlight_pick(&input).unwrap().source,
            CohostAutoHighlightSource::Question
        );

        // Deterministic ties: equal score and age fall back to the id.
        let mut a = auto_candidate("m-b", "twitch:x", 0.5, Joke);
        let b = auto_candidate("m-a", "twitch:y", 0.5, Joke);
        input = auto_input(vec![a.clone(), b.clone()]);
        assert_eq!(picked(&input).as_deref(), Some("m-a"));
        a.age = secs(20);
        input = auto_input(vec![a, b]);
        assert_eq!(picked(&input).as_deref(), Some("m-b"));

        // Picks need the setting.
        input = base.clone();
        input.picks_enabled = false;
        assert_eq!(picked(&input), None);
    }

    #[test]
    fn auto_highlight_voice_rules() {
        use CohostHighlightType::{Joke, Other};
        let joke = auto_candidate("m-joke", "twitch:alice", 0.8, Joke);
        let mut voice = auto_candidate("m-voice", "twitch:carol", 0.0, Other);
        voice.source = CohostAutoHighlightSource::Voice;
        voice.age = secs(600);
        let mut base = auto_input(vec![joke]);
        base.voice = Some(voice.clone());
        base.since_last_card_end = Some(secs(3));

        // Voice bypasses the cooldown and the age rule.
        assert_eq!(
            auto_highlight_pick(&base).unwrap(),
            AutoHighlightDecision {
                message_id: "m-voice".into(),
                author: "twitch:carol".into(),
                source: CohostAutoHighlightSource::Voice,
                highlight_type: None,
                refresh: false,
            }
        );

        // Voice needs its own setting; picks stay under the cooldown.
        let mut input = base.clone();
        input.voice_enabled = false;
        assert_eq!(picked(&input), None);
        input.since_last_card_end = Some(secs(45));
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // A pick candidate never rides in through the voice slot, and a voice
        // candidate never rides in through the pick list.
        input = base.clone();
        input.voice.as_mut().unwrap().source = CohostAutoHighlightSource::Pick;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice = None;
        input.candidates.push(voice.clone());
        input.since_last_card_end = None;
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Voice never replaces a card the streamer set by hand, nor another
        // engine card.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-manual".into(),
            engine_set: false,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Live {
            message_id: "m-joke".into(),
            engine_set: true,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Applying;
        assert_eq!(picked(&input), None);

        // One refresh of its own card, when the match persists into the last
        // seconds of the first lifetime.
        let own_card = |remaining: Duration| AutoHighlightCard::Live {
            message_id: "m-voice".into(),
            engine_set: true,
            remaining,
        };
        input = base.clone();
        input.card = own_card(secs(2));
        let refresh = auto_highlight_pick(&input).unwrap();
        assert!(refresh.refresh);
        assert_eq!(refresh.message_id, "m-voice");
        input.card = own_card(secs(3));
        assert_eq!(picked(&input), None);
        input.card = own_card(secs(2));
        input.voice_refreshed = true;
        assert_eq!(picked(&input), None);
        input.voice_refreshed = false;
        input.voice.as_mut().unwrap().flagged = true;
        assert_eq!(picked(&input), None);
        // A card set by hand is never refreshed, even for the same message.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-voice".into(),
            engine_set: false,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);

        // Everything else still applies: the safety gate, the broadcaster,
        // the previous author, tension, and shown-once after the card ended.
        input = base.clone();
        input.voice.as_mut().unwrap().flagged = true;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice.as_mut().unwrap().deleted = true;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice.as_mut().unwrap().roles = vec!["owner".into()];
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.last_author = Some("twitch:carol".into());
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.tension = Some(0.7);
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.shown.insert("m-voice".into());
        assert_eq!(picked(&input), None);
    }

    fn tick_highlight(
        message_id: &str,
        score: f64,
        highlight_type: CohostHighlightType,
    ) -> crate::videorc_api::CohostTickHighlight {
        crate::videorc_api::CohostTickHighlight {
            message_id: message_id.to_string(),
            score,
            highlight_type,
        }
    }

    fn live_card(message_id: &str, remaining: Duration) -> OverlayObservation {
        OverlayObservation {
            live_message_id: Some(message_id.to_string()),
            remaining,
        }
    }

    #[test]
    fn engine_auto_highlight_reads_engine_state_and_the_overlay() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[1].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[0].id, 0.7, CohostHighlightType::Praise),
        ];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();

        // The best pick fires once and rides the snapshot.
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t)
            .unwrap();
        assert_eq!(
            command,
            CohostAutoHighlight {
                generation: 1,
                message_id: rows[1].id.clone(),
                source: CohostAutoHighlightSource::Pick,
                refresh: false,
            }
        );
        assert_eq!(engine.snapshot().auto_highlight, Some(command.clone()));
        let json = serde_json::to_value(engine.snapshot()).unwrap();
        assert_eq!(json["autoHighlight"]["source"], "pick");
        assert_eq!(json["autoHighlight"]["generation"], 1);

        // Applying: nothing else fires until the card shows up.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(1))
                .is_none()
        );
        // Live: nothing fires while it is on stream, and the fulfilled
        // command leaves the snapshot (a reconnecting renderer must never
        // replay it).
        let live = live_card(&rows[1].id, secs(10));
        assert!(
            engine
                .evaluate_auto_highlight(generation, &live, t + secs(2))
                .is_none()
        );
        assert_eq!(engine.snapshot().auto_highlight, None);
        // It expires at t+12; the next pick waits 45 s from then and skips
        // the previous author's row if it were the same person (it is not).
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(13))
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(56))
                .is_none()
        );
        let second = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(57))
            .unwrap();
        assert_eq!(second.message_id, rows[0].id);
        assert_eq!(second.generation, 2);
        assert_eq!(engine.snapshot().auto_highlight, Some(second));

        // A replaced generation never decides.
        assert!(
            engine
                .evaluate_auto_highlight(generation + 1, &idle, t + secs(120))
                .is_none()
        );
    }

    #[test]
    fn engine_auto_highlight_command_is_dropped_when_the_renderer_never_serves_it() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..2);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke)];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t)
            .unwrap();
        assert_eq!(engine.snapshot().auto_highlight, Some(command));

        // The card never shows up (message gone from the renderer's list):
        // after the apply timeout the command leaves the snapshot, and the
        // message is not asked for again.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + AUTO_HIGHLIGHT_APPLY_TIMEOUT)
                .is_none()
        );
        assert!(engine.snapshot().auto_highlight.is_some());
        assert!(
            engine
                .evaluate_auto_highlight(
                    generation,
                    &idle,
                    t + AUTO_HIGHLIGHT_APPLY_TIMEOUT + secs(1)
                )
                .is_none()
        );
        assert_eq!(engine.snapshot().auto_highlight, None);
        // Still the only suggestion, still not asked for again.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(60))
                .is_none()
        );
    }

    #[test]
    fn engine_auto_highlight_counts_manual_cards_and_forgets_on_restart() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[1].id, 0.8, CohostHighlightType::Praise),
            tick_highlight(&rows[2].id, 0.5, CohostHighlightType::Insight),
        ];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();

        // The streamer shows the best row by hand (H): it is shown for the
        // session and the cooldown runs from its expiry.
        let manual = live_card(&rows[0].id, secs(4));
        assert!(
            engine
                .evaluate_auto_highlight(generation, &manual, t)
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(5))
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(48))
                .is_none()
        );
        let first = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(49))
            .unwrap();
        assert_eq!(first.message_id, rows[1].id);

        // The renderer never sets it (message gone): the request times out
        // and the policy moves on without re-asking for the same message.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(50))
                .is_none()
        );
        let next = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(58))
            .unwrap();
        assert_eq!(next.message_id, rows[2].id);
        assert_eq!(next.generation, 2);

        // A tombstone for a pending pick drops it at fire time.
        let generation = engine.start_session("session-2".to_string(), true, None, start);
        let rows = messages("session-2", 0..2);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[1].id, 0.4, CohostHighlightType::Praise),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let mut tombstone = rows[0].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], t);
        // No history carried over: the new session fires at once, with the
        // engine-wide generation still counting up.
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(1))
            .unwrap();
        assert_eq!(command.message_id, rows[1].id);
        assert_eq!(command.generation, 3);

        // The setting off: the overlay is still observed, nothing fires.
        let mut off = CohostEngine::new(enabled_settings());
        let generation = off.start_session("session-3".to_string(), true, None, start);
        let rows = messages("session-3", 0..1);
        off.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke)];
        assert!(off.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        assert!(off.evaluate_auto_highlight(generation, &idle, t).is_none());
        assert_eq!(off.snapshot().auto_highlight, None);
        assert!(
            serde_json::to_value(off.snapshot())
                .unwrap()
                .get("autoHighlight")
                .is_none()
        );
    }

    // --- Spotlight lane (plan 060 S3) ------------------------------------------

    const ISO: &str = "2026-08-22T10:00:20Z";

    fn transcript(text: &str, version: u64, last_final_at: Instant) -> TranscriptSnapshot {
        TranscriptSnapshot {
            text: text.to_string(),
            version,
            last_final_at: Some(last_final_at),
        }
    }

    fn spotlight_match(
        message_id: &str,
        about: f64,
        question: Option<(&str, f64)>,
    ) -> crate::videorc_api::CohostSpotlightMatch {
        crate::videorc_api::CohostSpotlightMatch {
            message_id: message_id.to_string(),
            question_id: question.map(|(id, _)| id.to_string()),
            about,
            answered: question.map(|(_, answered)| answered),
        }
    }

    fn spotlight_response(
        matches: Vec<crate::videorc_api::CohostSpotlightMatch>,
    ) -> CohostSpotlightResponse {
        CohostSpotlightResponse {
            seq: 1,
            matches,
            usage: None,
        }
    }

    /// Drive one spotlight call through `prepare_spotlight`; the transcript
    /// changed (`version`) and its last final landed one second ago. A fresh
    /// chat row lands first so the 120 s candidate window is never empty
    /// however far the test clock has moved.
    fn send_spotlight(
        engine: &mut CohostEngine,
        generation: u64,
        version: u64,
        now: Instant,
    ) -> Option<PreparedSpotlight> {
        let seq = 1000 + u32::try_from(version).unwrap_or(0);
        let fresh = chat_message(
            "session-1",
            seq,
            &format!("2026-08-22T12:{:02}:{:02}Z", (seq / 60) % 60, seq % 60),
        );
        engine.note_messages_at(&[fresh], now);
        match engine.prepare_spotlight(
            generation,
            true,
            true,
            &transcript("so about the keyboard", version, now - secs(1)),
            now,
        ) {
            SpotlightPass::Send(prepared) => Some(prepared),
            _ => None,
        }
    }

    #[test]
    fn transcript_window_trims_by_time_and_chars() {
        let start = Instant::now();
        let mut window = TranscriptWindow::default();
        window.push("  hello   world ", start);
        assert_eq!(window.snapshot(start).text, "hello world");
        assert_eq!(window.snapshot(start).version, 1);
        // An empty final is not news.
        window.push("   ", start + secs(1));
        assert_eq!(window.snapshot(start + secs(1)).version, 1);
        window.push("second", start + secs(5));
        let snapshot = window.snapshot(start + secs(5));
        assert_eq!(snapshot.text, "hello world second");
        assert_eq!(snapshot.version, 2);
        assert_eq!(snapshot.last_final_at, Some(start + secs(5)));
        // Time: a final leaves the snapshot 20 s after it landed, and is
        // trimmed for real on the next push.
        assert_eq!(window.snapshot(start + secs(19)).text, "hello world second");
        assert_eq!(window.snapshot(start + secs(20)).text, "second");
        window.push("third", start + secs(21));
        assert_eq!(window.finals.len(), 2);
        assert_eq!(window.snapshot(start + secs(21)).text, "second third");
        assert_eq!(window.snapshot(start + secs(60)).text, "");
        window.clear();
        assert_eq!(window.snapshot(start + secs(21)).text, "");
        assert_eq!(window.snapshot(start + secs(21)).last_final_at, None);
        assert_eq!(window.finals.len(), 0);

        // Chars: the joined text never exceeds 800; the oldest finals go.
        let mut window = TranscriptWindow::default();
        for step in 0..10u64 {
            window.push(&"a".repeat(100), start + Duration::from_millis(step));
        }
        let text = window.snapshot(start + secs(1)).text;
        assert!(text.chars().count() <= SPOTLIGHT_TRANSCRIPT_MAX_CHARS);
        assert_eq!(window.finals.len(), 7);
        assert_eq!(text.chars().count(), 7 * 100 + 6);
        // One oversized final keeps its tail.
        let mut window = TranscriptWindow::default();
        window.push(&format!("{}TAIL", "b".repeat(900)), start);
        let text = window.snapshot(start).text;
        assert_eq!(text.chars().count(), SPOTLIGHT_TRANSCRIPT_MAX_CHARS);
        assert!(text.ends_with("TAIL"));
    }

    #[test]
    fn spotlight_cadence_matrix_matches_the_contract() {
        let start = Instant::now();
        let empty = TranscriptSnapshot {
            text: String::new(),
            version: 3,
            last_final_at: Some(start),
        };
        // Nothing said: never.
        assert!(!spotlight_due(
            &empty,
            None,
            None,
            false,
            None,
            start + secs(5)
        ));
        // First call: one second after the final.
        let first = transcript("words", 1, start);
        assert!(!spotlight_due(
            &first,
            None,
            None,
            false,
            None,
            start + Duration::from_millis(999)
        ));
        assert!(spotlight_due(
            &first,
            None,
            None,
            false,
            None,
            start + secs(1)
        ));
        // Never while one is outstanding.
        assert!(!spotlight_due(
            &first,
            None,
            None,
            true,
            None,
            start + secs(5)
        ));
        // The window did not change since the last call: never.
        assert!(!spotlight_due(
            &first,
            Some(1),
            Some(start + secs(1)),
            false,
            None,
            start + secs(30)
        ));
        // Changed, but within 2.5 s of the previous call: wait.
        let second = transcript("more words", 2, start + secs(1));
        let last_call = Some(start + secs(1));
        assert!(!spotlight_due(
            &second,
            Some(1),
            last_call,
            false,
            None,
            start + secs(3)
        ));
        assert!(spotlight_due(
            &second,
            Some(1),
            last_call,
            false,
            None,
            start + Duration::from_millis(3500)
        ));
        // Breaker: closed until `off_until`, then open.
        let off = Some(start + secs(60));
        assert!(!spotlight_due(
            &second,
            Some(1),
            None,
            false,
            off,
            start + secs(59)
        ));
        assert!(spotlight_due(
            &second,
            Some(1),
            None,
            false,
            off,
            start + secs(60)
        ));
    }

    #[test]
    fn spotlight_breaker_transitions_including_retry_after() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut t = start + secs(2);
        let mut version = 1;
        let mut fail =
            |engine: &mut CohostEngine, t: Instant, version: u64, error: CohostApiError| {
                let prepared = send_spotlight(engine, generation, version, t).expect("lane open");
                assert_eq!(prepared.generation, generation);
                engine
                    .apply_spotlight_result(generation, Err(error), t, ISO)
                    .unwrap()
            };

        // Two failures in a row: the lane stays open.
        for _ in 0..2 {
            let outcome = fail(
                &mut engine,
                t,
                version,
                server_error(502, "ai-gateway-error", "boom"),
            );
            assert_eq!(outcome.lane_off_for, None);
            assert!(!outcome.changed);
            t += secs(3);
            version += 1;
        }
        // The third closes it for 60 s.
        let outcome = fail(
            &mut engine,
            t,
            version,
            server_error(502, "ai-gateway-error", "boom"),
        );
        assert_eq!(outcome.lane_off_for, Some(secs(60)));
        t += secs(3);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_none());
        t += secs(60);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_some());
        // A success resets the count: two more failures keep it open.
        assert!(
            engine
                .apply_spotlight_result(generation, Ok(spotlight_response(Vec::new())), t, ISO)
                .unwrap()
                .lane_off_for
                .is_none()
        );
        t += secs(3);
        version += 1;
        for _ in 0..2 {
            let outcome = fail(
                &mut engine,
                t,
                version,
                CohostApiError::timeout("Orcle did not answer within 3 s."),
            );
            assert_eq!(outcome.lane_off_for, None);
            t += secs(3);
            version += 1;
        }
        // The tick's state never moved: still listening, no reason, no detail.
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
        assert!(!snapshot.tick_in_flight);

        // "Not on this server" answers close the lane for five minutes.
        for error in [
            server_error(404, "not-found", "no route"),
            server_error(503, "spotlight-disabled", "off"),
            server_error(503, "judge-unconfigured", "no model"),
            server_error(403, "premium-required", "upgrade"),
        ] {
            let outcome = fail(&mut engine, t, version, error);
            assert_eq!(outcome.lane_off_for, Some(secs(300)));
            t += secs(3);
            version += 1;
            assert!(send_spotlight(&mut engine, generation, version, t).is_none());
            t += secs(300);
            version += 1;
            assert!(send_spotlight(&mut engine, generation, version, t).is_some());
            engine.apply_spotlight_result(generation, Ok(spotlight_response(Vec::new())), t, ISO);
            t += secs(3);
            version += 1;
        }
        // Quota: off until Retry-After; without one, the unavailable window.
        let quota = crate::videorc_api::classify_cohost_failure(
            429,
            "quota-exhausted",
            "later".to_string(),
            Some("42"),
        );
        let outcome = fail(&mut engine, t, version, quota);
        assert_eq!(outcome.lane_off_for, Some(secs(42)));
        t += secs(3);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_none());
        t += secs(40);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_some());
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Err(server_error(429, "quota-exhausted", "later")),
                t,
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.lane_off_for, Some(secs(300)));
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        assert_eq!(engine.snapshot().reason, None);
    }

    #[test]
    fn spotlight_preconditions_and_stop_conditions() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..2);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let window = transcript("words", 1, t - secs(1));
        // Not Premium / signed out: idle, never a pause of its own.
        assert_eq!(
            engine.prepare_spotlight(generation, true, false, &window, t),
            SpotlightPass::Idle
        );
        assert_eq!(
            engine.prepare_spotlight(generation, false, true, &window, t),
            SpotlightPass::Idle
        );
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        // A replaced generation stops the lane.
        assert_eq!(
            engine.prepare_spotlight(generation + 1, true, true, &window, t),
            SpotlightPass::Stopped
        );
        // Paused engine (tick precondition): idle.
        engine
            .session
            .as_mut()
            .unwrap()
            .pause(CohostReason::SignedOut, t);
        assert_eq!(
            engine.prepare_spotlight(generation, true, true, &window, t),
            SpotlightPass::Idle
        );
        engine.session.as_mut().unwrap().status = CohostStatus::Listening;
        // No candidates (nothing noted in the last 120 s): idle.
        let mut empty = CohostEngine::new(enabled_settings());
        let empty_generation = empty.start_session("session-2".to_string(), true, None, start);
        assert_eq!(
            empty.prepare_spotlight(empty_generation, true, true, &window, t),
            SpotlightPass::Idle
        );
        // All good: the request carries the transcript, the seq and consent.
        let SpotlightPass::Send(prepared) =
            engine.prepare_spotlight(generation, true, true, &window, t)
        else {
            panic!("expected a spotlight call");
        };
        assert_eq!(prepared.request.seq, 1);
        assert_eq!(prepared.request.transcript, "words");
        assert!(prepared.request.consent_to_process_chat);
        assert_eq!(prepared.request.session_client_id, "session-1");
        assert_eq!(prepared.request.candidates.len(), 2);
        let json = serde_json::to_value(&prepared.request).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "candidates",
                "clientVersion",
                "consentToProcessChat",
                "seq",
                "sessionClientId",
                "transcript"
            ]
        );
        assert_eq!(json["candidates"][0]["roles"], serde_json::json!(["mod"]));
        assert!(json["candidates"][0].get("questionId").is_none());
        // Turned off: stopped.
        engine.settings.enabled = false;
        assert_eq!(
            engine.prepare_spotlight(generation, true, true, &window, t),
            SpotlightPass::Stopped
        );
    }

    #[test]
    fn spotlight_merges_with_a_concurrent_tick() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..6);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        // The spotlight call goes out first...
        let prepared = send_spotlight(&mut engine, generation, 1, t).unwrap();
        // ...then a burst tick goes out and lands while it is outstanding.
        let tick = engine.prepare_tick(generation, true, true, t).unwrap();
        assert!(engine.snapshot().tick_in_flight);
        assert!(engine.apply_tick_result(
            tick.generation,
            0,
            Ok(response(vec![question("q-1", &[&rows[0].id])])),
            t + secs(1),
            ISO
        ));
        // The spotlight answer lands last: both merge by message id.
        let outcome = engine
            .apply_spotlight_result(
                prepared.generation,
                Ok(spotlight_response(vec![
                    spotlight_match(&rows[0].id, 0.9, Some(("q-1", 0.85))),
                    spotlight_match(&rows[1].id, 0.7, None),
                ])),
                t + secs(2),
                ISO,
            )
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.spotlight_set, Some((rows[0].id.clone(), 0.9)));
        assert!(outcome.resolved.is_empty());
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 1);
        assert_eq!(snapshot.tick_seq, 1);
        assert!(!snapshot.tick_in_flight);
        assert_eq!(snapshot.status, CohostStatus::Listening);
        let spotlight = snapshot.spotlight.unwrap();
        assert_eq!(spotlight.message_id, rows[0].id);
        assert_eq!(spotlight.question_id.as_deref(), Some("q-1"));
        assert_eq!(spotlight.score, 0.9);
        assert_eq!(spotlight.at, ISO);
        assert!(chrono::DateTime::parse_from_rfc3339(&spotlight.expires_at).is_ok());

        // The other order: a tick that flags the spotlit message while the
        // next spotlight call is outstanding clears the spotlight, and the
        // spotlight answer for that message is dropped on receipt.
        let t2 = t + secs(5);
        let prepared = send_spotlight(&mut engine, generation, 2, t2).unwrap();
        let tick = engine
            .prepare_tick(generation, true, true, t2 + secs(10))
            .unwrap_err();
        assert_eq!(tick, TickGate::Idle);
        let mut flagged = response(Vec::new());
        flagged.keep_questions = true;
        flagged.flags = vec![flag(
            &rows[0].id,
            CohostFlagKind::Harassment,
            CohostFlagSeverity::High,
        )];
        engine.session.as_mut().unwrap().in_flight = true;
        assert!(engine.apply_tick_result(generation, 0, Ok(flagged), t2 + secs(1), ISO));
        assert_eq!(engine.snapshot().spotlight, None);
        let outcome = engine
            .apply_spotlight_result(
                prepared.generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[0].id,
                    0.99,
                    None,
                )])),
                t2 + secs(2),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, None);
        assert_eq!(engine.snapshot().spotlight, None);
        assert_eq!(engine.snapshot().questions.len(), 1);
        // A late answer for a replaced session changes nothing.
        assert!(
            engine
                .apply_spotlight_result(
                    generation + 1,
                    Ok(spotlight_response(vec![spotlight_match(
                        &rows[1].id,
                        0.99,
                        None
                    )])),
                    t2 + secs(3),
                    ISO,
                )
                .is_none()
        );
        assert_eq!(engine.snapshot().spotlight, None);
    }

    #[test]
    fn spotlight_candidates_cap_exclude_owner_flagged_deleted_old_and_fit_the_budget() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        // An old row (noted 121 s ago), the broadcaster, a row that gets
        // flagged, a row that gets deleted, then 30 fresh rows.
        let old = messages("session-1", 0..1);
        engine.note_messages_at(&old, start - secs(121));
        let mut owner = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        owner.author_roles = vec!["broadcaster".to_string()];
        engine.note_messages_at(&[owner.clone()], start - secs(60));
        let rows = messages("session-1", 2..34);
        engine.note_messages_at(&rows, start - secs(30));
        let flagged_id = rows[0].id.clone();
        let deleted_id = rows[1].id.clone();
        // Twelve open questions with mixed priorities; each first message is a
        // fresh row. The tick also flags one row.
        let mut tick = response(
            (0..12)
                .map(|index| {
                    let mut item = question(&format!("q-{index:02}"), &[&rows[2 + index].id]);
                    item.priority = if index % 3 == 0 {
                        CohostPriority::High
                    } else if index % 3 == 1 {
                        CohostPriority::Normal
                    } else {
                        CohostPriority::Low
                    };
                    item
                })
                .collect(),
        );
        tick.flags = vec![flag(
            &flagged_id,
            CohostFlagKind::Spam,
            CohostFlagSeverity::Medium,
        )];
        // A question whose first message is the flagged row: no candidate.
        tick.questions.push(question("q-flagged", &[&flagged_id]));
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start - secs(20), ISO));
        let mut tombstone = rows[1].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], start - secs(10));

        let now = start;
        let candidates = engine.session.as_ref().unwrap().spotlight_candidates(now);
        assert_eq!(candidates.len(), SPOTLIGHT_CANDIDATES_CAP);
        let ids: HashSet<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids.len(), candidates.len(), "ids are unique");
        assert!(!ids.contains(old[0].id.as_str()), "older than 120 s");
        assert!(!ids.contains(owner.id.as_str()), "the broadcaster");
        assert!(!ids.contains(flagged_id.as_str()), "flagged");
        assert!(!ids.contains(deleted_id.as_str()), "deleted");
        // Questions first: ten of them, high priority first, then normal.
        let with_question: Vec<&CohostSpotlightCandidate> = candidates
            .iter()
            .filter(|c| c.question_id.is_some())
            .collect();
        assert_eq!(with_question.len(), SPOTLIGHT_QUESTION_CANDIDATES_CAP);
        assert!(
            candidates[..SPOTLIGHT_QUESTION_CANDIDATES_CAP]
                .iter()
                .all(|c| c.question_id.is_some())
        );
        let question_ids: Vec<&str> = with_question
            .iter()
            .map(|c| c.question_id.as_deref().unwrap())
            .collect();
        assert_eq!(
            question_ids,
            [
                "q-00", "q-03", "q-06", "q-09", "q-01", "q-04", "q-07", "q-10", "q-02", "q-05"
            ]
        );
        assert_eq!(
            with_question[0].question_text.as_deref(),
            Some("What keyboard is that?")
        );
        assert_eq!(with_question[0].text, rows[2].message_text.trim());
        // Then the newest plain messages, newest first.
        let plain: Vec<&str> = candidates[SPOTLIGHT_QUESTION_CANDIDATES_CAP..]
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(plain.len(), 10);
        assert_eq!(plain[0], rows[31].id);
        let mut sorted = plain.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(plain, sorted, "newest first");
        assert!(plain.iter().all(|id| !question_ids.contains(id)));

        // Byte budget: candidates leave from the end until the body fits;
        // at least one always stays.
        let mut request = CohostSpotlightRequest {
            client_version: "videorc-desktop/test".to_string(),
            session_client_id: "session-1".to_string(),
            consent_to_process_chat: true,
            transcript: "t".repeat(800),
            seq: 1,
            candidates: (0..20)
                .map(|index| CohostSpotlightCandidate {
                    id: format!("m-{index}"),
                    text: "x".repeat(500),
                    author: "y".repeat(120),
                    roles: None,
                    at: ISO.to_string(),
                    question_id: None,
                    question_text: None,
                })
                .collect(),
        };
        let full = serde_json::to_vec(&request).unwrap().len();
        assert!(
            full <= COHOST_SPOTLIGHT_MAX_BODY_BYTES,
            "20 max candidates fit: {full}"
        );
        trim_spotlight_request_to_budget(&mut request, COHOST_SPOTLIGHT_MAX_BODY_BYTES);
        assert_eq!(request.candidates.len(), 20);
        trim_spotlight_request_to_budget(&mut request, 4000);
        assert!(request.candidates.len() < 20 && !request.candidates.is_empty());
        assert!(serde_json::to_vec(&request).unwrap().len() <= 4000);
        assert_eq!(request.candidates[0].id, "m-0");
        trim_spotlight_request_to_budget(&mut request, 10);
        assert_eq!(request.candidates.len(), 1);
    }

    #[test]
    fn voice_resolve_needs_two_consecutive_hits_and_restore_puts_it_back() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q-1", &[&rows[0].id]),
                question("q-2", &[&rows[1].id]),
            ])),
            t,
            ISO
        ));
        let template = engine.snapshot().questions[0].clone();
        let answered = |engine: &mut CohostEngine, at: Instant, hits: &[(&str, &str, f64)]| {
            engine
                .apply_spotlight_result(
                    generation,
                    Ok(spotlight_response(
                        hits.iter()
                            .map(|(id, question_id, answered)| {
                                spotlight_match(id, 0.9, Some((question_id, *answered)))
                            })
                            .collect(),
                    )),
                    at,
                    ISO,
                )
                .unwrap()
        };
        // One hit does nothing.
        let outcome = answered(&mut engine, t + secs(3), &[(&rows[0].id, "q-1", 0.9)]);
        assert!(outcome.resolved.is_empty());
        assert_eq!(engine.snapshot().questions.len(), 2);
        assert!(engine.snapshot().recently_resolved.is_empty());
        // A call without the hit breaks the streak; the next hit starts over.
        answered(&mut engine, t + secs(6), &[(&rows[0].id, "q-1", 0.3)]);
        let outcome = answered(&mut engine, t + secs(9), &[(&rows[0].id, "q-1", 0.95)]);
        assert!(outcome.resolved.is_empty());
        assert_eq!(engine.snapshot().questions.len(), 2);
        // Two in a row: resolved with reason voice, kept for a minute.
        let outcome = answered(
            &mut engine,
            t + secs(12),
            &[(&rows[0].id, "q-1", 0.8), (&rows[1].id, "q-2", 0.79)],
        );
        assert_eq!(outcome.resolved, vec!["q-1".to_string()]);
        assert!(outcome.changed);
        let snapshot = engine.snapshot();
        assert_eq!(
            snapshot
                .questions
                .iter()
                .map(|q| q.id.as_str())
                .collect::<Vec<_>>(),
            ["q-2"]
        );
        assert_eq!(snapshot.recently_resolved.len(), 1);
        assert_eq!(snapshot.recently_resolved[0].question.id, "q-1");
        assert_eq!(
            snapshot.recently_resolved[0].reason,
            CohostResolveReason::Voice
        );
        assert_eq!(snapshot.recently_resolved[0].resolved_at, ISO);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["recentlyResolved"][0]["reason"], "voice");
        assert_eq!(json["recentlyResolved"][0]["resolvedAt"], ISO);
        assert!(json["recentlyResolved"][0]["question"]["messageIds"].is_array());
        // A later tick cannot bring it back: it is dismissed.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q-1", &[&rows[0].id]),
                question("q-2", &[&rows[1].id]),
            ])),
            t + secs(20),
            ISO
        ));
        assert_eq!(engine.snapshot().questions.len(), 1);

        // Restore: back in the open set, out of the dismissed set and the
        // recently-resolved list; a second restore is a no-op.
        assert_eq!(
            engine.restore_question("session-x", "q-1", t + secs(21)),
            Err(CohostError::SessionMismatch)
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(21)),
            Ok(true)
        );
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 2);
        assert!(snapshot.questions.iter().any(|q| q.id == "q-1"));
        assert!(snapshot.recently_resolved.is_empty());
        assert!(
            !engine
                .session
                .as_ref()
                .unwrap()
                .dismissed_questions
                .contains("q-1")
        );
        assert!(
            serde_json::to_value(&snapshot)
                .unwrap()
                .get("recentlyResolved")
                .is_none()
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(22)),
            Ok(false)
        );
        // The next tick keeps it (not dismissed any more).
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q-1", &[&rows[0].id])])),
            t + secs(30),
            ISO
        ));
        assert_eq!(engine.snapshot().questions.len(), 1);
        assert_eq!(engine.snapshot().questions[0].id, "q-1");

        // Resolve again; after the minute it can no longer be restored and
        // leaves the state; at most three are kept.
        answered(&mut engine, t + secs(33), &[(&rows[0].id, "q-1", 0.9)]);
        answered(&mut engine, t + secs(36), &[(&rows[0].id, "q-1", 0.9)]);
        assert_eq!(
            engine
                .snapshot_at_for_test(t + secs(36))
                .recently_resolved
                .len(),
            1
        );
        assert!(
            engine
                .snapshot_at_for_test(t + secs(96))
                .recently_resolved
                .is_empty()
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(96)),
            Ok(false)
        );
        let session = engine.session.as_mut().unwrap();
        for index in 0..5 {
            session.questions.push(CohostQuestion {
                id: format!("q-many-{index}"),
                ..template.clone()
            });
            assert!(session.resolve_by_voice(&format!("q-many-{index}"), t + secs(100), ISO));
        }
        assert_eq!(session.recently_resolved.len(), RECENTLY_RESOLVED_CAP);
        assert_eq!(session.recently_resolved[0].entry.question.id, "q-many-2");
    }

    #[test]
    fn spotlight_expiry_refresh_tombstone_and_dismissed_flag() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![
                    // Same score: the earliest message wins the tie.
                    spotlight_match(&rows[1].id, 0.8, None),
                    spotlight_match(&rows[0].id, 0.8, None),
                    spotlight_match(&rows[2].id, 0.74, None),
                    spotlight_match("unknown-id", 1.0, None),
                ])),
                t,
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, Some((rows[0].id.clone(), 0.8)));
        let json = serde_json::to_value(engine.snapshot_at_for_test(t)).unwrap();
        assert_eq!(json["spotlight"]["messageId"], rows[0].id);
        assert!(json["spotlight"].get("questionId").is_none());
        assert_eq!(json["spotlight"]["score"], 0.8);
        // Below the threshold: nothing changes, the spotlight stays.
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[2].id,
                    0.5,
                    None,
                )])),
                t + secs(3),
                ISO,
            )
            .unwrap();
        assert!(!outcome.changed);
        assert_eq!(
            engine
                .snapshot_at_for_test(t + secs(3))
                .spotlight
                .unwrap()
                .message_id,
            rows[0].id
        );
        // A repeat match refreshes: still the same id, later expiry, no "set".
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[0].id,
                    0.95,
                    None,
                )])),
                t + secs(10),
                ISO,
            )
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.spotlight_set, None);
        assert!(!engine.expire_spotlight(generation, t + secs(24)));
        let spotlight = engine.snapshot_at_for_test(t + secs(24)).spotlight.unwrap();
        assert_eq!(spotlight.message_id, rows[0].id);
        assert_eq!(spotlight.score, 0.95);
        assert_eq!(spotlight.at, ISO);
        // Expiry: gone 15 s after the last refresh, reported exactly once.
        assert!(
            engine
                .expire_spotlight(generation + 1, t + secs(25))
                .eq(&false)
        );
        assert_eq!(
            engine.snapshot_at_for_test(t + secs(25)).spotlight,
            None,
            "the snapshot never shows an expired spotlight"
        );
        assert!(engine.expire_spotlight(generation, t + secs(25)));
        assert!(!engine.expire_spotlight(generation, t + secs(26)));
        assert!(!engine.has_spotlight());

        // Tombstone: the spotlit message is deleted → the spotlight leaves.
        engine.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[1].id,
                0.9,
                None,
            )])),
            t + secs(30),
            ISO,
        );
        assert!(engine.has_spotlight());
        let mut tombstone = rows[1].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], t + secs(31));
        assert!(!engine.has_spotlight());
        assert_eq!(engine.snapshot_at_for_test(t + secs(31)).spotlight, None);
        // A deleted message never matches again.
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[1].id,
                    0.9,
                    None,
                )])),
                t + secs(34),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, None);
        assert!(!engine.has_spotlight());

        // Dismissing a flag on the spotlit message clears it too.
        engine.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[2].id,
                0.9,
                None,
            )])),
            t + secs(37),
            ISO,
        );
        assert!(engine.has_spotlight());
        engine.dismiss_flag("session-1", &rows[2].id).unwrap();
        assert!(!engine.has_spotlight());
    }

    #[test]
    fn spotlight_match_on_a_flagged_message_is_dropped_and_voice_feeds_the_pick() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            voice_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let mut tick = response(Vec::new());
        tick.flags = vec![flag(
            &rows[1].id,
            CohostFlagKind::Harassment,
            CohostFlagSeverity::High,
        )];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, ISO));
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![
                    spotlight_match(&rows[1].id, 0.99, None),
                    spotlight_match(&rows[2].id, 0.8, None),
                ])),
                t + secs(1),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, Some((rows[2].id.clone(), 0.8)));

        // The Voice source reads the live spotlight: with `voiceHighlight`
        // the engine puts it on stream at once (no cooldown, no age rule).
        let idle = OverlayObservation::default();
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(2))
            .unwrap();
        assert_eq!(command.message_id, rows[2].id);
        assert_eq!(command.source, CohostAutoHighlightSource::Voice);
        assert!(!command.refresh);
        // Once expired, nothing more fires.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(40))
                .is_none()
        );
        // The setting off: the spotlight still rides the state (pull-up is
        // always on), but never goes on stream.
        let mut quiet = CohostEngine::new(enabled_settings());
        let generation = quiet.start_session("session-2".to_string(), true, None, start);
        let rows = messages("session-2", 0..1);
        quiet.note_messages_at(&rows, start);
        quiet.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[0].id,
                0.9,
                None,
            )])),
            t,
            ISO,
        );
        assert!(quiet.snapshot_at_for_test(t).spotlight.is_some());
        assert!(
            quiet
                .evaluate_auto_highlight(generation, &idle, t + secs(1))
                .is_none()
        );
    }

    #[test]
    fn overlay_observation_reads_the_highlight_state() {
        let idle = CommentHighlightState::default();
        assert_eq!(
            OverlayObservation::from_highlight(&idle),
            OverlayObservation::default()
        );
        let live = CommentHighlightState {
            session_id: Some("session-1".into()),
            message_id: Some("m-1".into()),
            generation: 3,
            phase: CommentHighlightPhase::Live,
            expires_at: Some((chrono::Utc::now() + chrono::Duration::seconds(9)).to_rfc3339()),
            reason: None,
        };
        let observed = OverlayObservation::from_highlight(&live);
        assert_eq!(observed.live_message_id.as_deref(), Some("m-1"));
        assert!(observed.remaining > secs(7) && observed.remaining <= secs(9));
        let expired = CommentHighlightState {
            expires_at: Some((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()),
            ..live.clone()
        };
        assert_eq!(
            OverlayObservation::from_highlight(&expired).remaining,
            Duration::ZERO
        );
        let failed = CommentHighlightState {
            phase: CommentHighlightPhase::Failed,
            ..live
        };
        assert_eq!(
            OverlayObservation::from_highlight(&failed).live_message_id,
            None
        );
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
                "The Orcle tick failed on every configured model."
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
                message: "The Orcle tick failed on every configured model.".to_string(),
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
            Err(CohostApiError::timeout("Orcle did not answer within 12 s.")),
            start + secs(42),
            "t3"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.reason, Some(CohostReason::Network));
        assert_eq!(
            snapshot.detail,
            Some(CohostErrorDetail {
                code: "timeout".to_string(),
                message: "Orcle did not answer within 12 s.".to_string(),
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
            voice_highlight: None,
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
                voice_highlight: None,
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
                voice_highlight: None,
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
                voice_highlight: None,
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
