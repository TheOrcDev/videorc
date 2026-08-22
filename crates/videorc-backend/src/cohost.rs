//! Live Chat Co-host engine (plan: "2026-08-22 - Videorc Live Chat Co-host").
//!
//! One backend-owned state machine per live-chat session: it watches delivered
//! chat rows, batches the delta into periodic `POST /api/ai/cohost/tick`
//! calls (bearer-authed, Premium + consent gated), merges the server's
//! open-question set, flags, and mood, and publishes every change to renderers
//! as the non-coalescible `cohost.state` event. Raw drafts live only in memory
//! and are cleared when the session stops. The renderer never talks to the web.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::protocol::{
    CohostFlagParams, CohostQuestionParams, CohostSettingsPatch, CohostStartParams, FeatureId,
};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::StreamPlatform;
use crate::videorc_api::{
    CohostApiError, CohostTickMessage, CohostTickOpenQuestion, CohostTickRequest,
    CohostTickResponse, VideorcApiClient,
};

pub const COHOST_STATE_EVENT: &str = "cohost.state";
/// Pinned by the desktop; the server rejects unknown versions with 400
/// `prompt-version-unsupported`.
pub const COHOST_PROMPT_VERSION: u32 = 1;
pub const COHOST_SETTINGS_KEY: &str = "cohostSettings";
pub const COHOST_NOTES_MAX_CHARS: usize = 4000;
const DESKTOP_CLIENT_VERSION: &str = concat!("videorc-desktop/", env!("CARGO_PKG_VERSION"));

const TICK_MESSAGE_TEXT_MAX_CHARS: usize = 500;
/// Newest messages kept per tick; older delta rows are counted as dropped.
const TICK_DELTA_CAP: usize = 60;
const TICK_OPEN_QUESTIONS_CAP: usize = 40;
const TICK_BURST_THRESHOLD: usize = 5;
const TICK_IDLE_INTERVAL: Duration = Duration::from_secs(20);
const TICK_MIN_GAP: Duration = Duration::from_secs(8);
const BACKOFF_STEPS_SECS: [u64; 5] = [5, 10, 20, 40, 60];
const QUOTA_DEFAULT_RETRY: Duration = Duration::from_secs(3600);
/// How often a paused precondition (signed out, Basic, no consent) is re-read.
const PRECONDITION_RECHECK: Duration = Duration::from_secs(5);
const SCHEDULER_POLL: Duration = Duration::from_secs(1);
const KNOWN_MESSAGE_IDS_CAP: usize = 5000;
const FLAGS_CAP: usize = 50;
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostMood {
    Hype,
    Calm,
    Tense,
    Mixed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagKind {
    Toxicity,
    Spam,
    SelfPromo,
    PersonalInfo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagSeverity {
    High,
    Medium,
    Low,
}

// --- Settings ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSettings {
    pub enabled: bool,
    pub tone: CohostTone,
    pub notes: String,
    pub auto_highlight: bool,
}

impl Default for CohostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            tone: CohostTone::Friendly,
            notes: String::new(),
            auto_highlight: false,
        }
    }
}

impl CohostSettings {
    fn normalized(mut self) -> Self {
        self.notes = truncate_chars(&self.notes, COHOST_NOTES_MAX_CHARS);
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
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostFlag {
    pub message_id: String,
    pub kind: CohostFlagKind,
    pub severity: CohostFlagSeverity,
    pub reason: String,
    pub at: String,
}

/// The `cohost.state` event payload and the result of every `cohost.*` RPC.
/// Nullable fields serialize as explicit `null` (the renderer reducer keys on
/// them), never as absent keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostState {
    pub session_id: Option<String>,
    pub status: CohostStatus,
    pub reason: Option<CohostReason>,
    pub questions: Vec<CohostQuestion>,
    pub flags: Vec<CohostFlag>,
    pub mood: Option<CohostMood>,
    pub last_tick_at: Option<String>,
    pub tick_seq: u64,
    pub partial: bool,
}

impl CohostState {
    pub fn off() -> Self {
        Self {
            session_id: None,
            status: CohostStatus::Off,
            reason: None,
            questions: Vec::new(),
            flags: Vec::new(),
            mood: None,
            last_tick_at: None,
            tick_seq: 0,
            partial: false,
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

struct CohostSession {
    session_id: String,
    generation: u64,
    consent: bool,
    stream_title: Option<String>,
    status: CohostStatus,
    reason: Option<CohostReason>,
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
        }
    }

    fn snapshot(&self) -> CohostState {
        CohostState {
            session_id: Some(self.session_id.clone()),
            status: self.status,
            reason: self.reason,
            questions: self.questions.clone(),
            flags: self.flags.clone(),
            mood: self.mood,
            last_tick_at: self.last_tick_iso.clone(),
            tick_seq: self.tick_seq,
            partial: self.partial,
        }
    }

    fn remember_id(&mut self, id: &str) {
        if self.known_set.insert(id.to_string()) {
            self.known_ids.push_back(id.to_string());
            while self.known_ids.len() > KNOWN_MESSAGE_IDS_CAP {
                if let Some(evicted) = self.known_ids.pop_front() {
                    self.known_set.remove(&evicted);
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
            self.remember_id(&message.id);
            self.pending.push_back(mapped);
            while self.pending.len() > TICK_DELTA_CAP {
                self.pending.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }
            noted += 1;
        }
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
            self.pending.len(),
            self.last_tick_at.unwrap_or(self.started_at),
            self.last_tick_at,
            now,
        )
    }

    fn build_request(&mut self, settings: &CohostSettings, now: Instant) -> CohostTickRequest {
        self.tick_seq = self.tick_seq.saturating_add(1);
        self.last_tick_at = Some(now);
        self.in_flight = true;
        let messages: Vec<CohostTickMessage> = self.pending.drain(..).collect();
        let dropped_messages = std::mem::take(&mut self.dropped);
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
            prompt_version: COHOST_PROMPT_VERSION,
            consent_to_process_chat: self.consent,
            tone: settings.tone,
            notes: settings.notes.clone(),
            stream_title: self.stream_title.clone(),
            open_questions,
            messages,
            dropped_messages,
        }
    }

    /// Merge a successful tick. `questions` is the full open set: existing ids
    /// keep `first_seen_at`, `resolved` ids leave, dismissed ids never return,
    /// and message ids are sanitized against rows this engine actually sent.
    fn apply_response(&mut self, response: CohostTickResponse, dropped: u64, now_iso: &str) {
        self.in_flight = false;
        self.backoff_index = 0;
        self.next_attempt_at = None;
        self.status = CohostStatus::Listening;
        self.reason = None;
        self.last_tick_iso = Some(now_iso.to_string());
        self.partial = dropped > 0;
        self.mood = response.mood;

        let resolved: HashSet<String> = response.resolved.into_iter().collect();
        let mut next_questions = Vec::with_capacity(response.questions.len());
        for incoming in response.questions {
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
            next_questions.push(CohostQuestion {
                id: incoming.id,
                text: incoming.text,
                message_ids,
                askers: incoming.askers,
                platforms: incoming.platforms,
                priority: incoming.priority,
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
            self.flags.push(CohostFlag {
                message_id: flag.message_id,
                kind: flag.kind,
                severity: flag.severity,
                reason: flag.reason,
                at: now_iso.to_string(),
            });
        }
        while self.flags.len() > FLAGS_CAP {
            self.flags.remove(0);
        }
    }

    fn apply_failure(&mut self, error: &CohostApiError, now: Instant) {
        self.in_flight = false;
        let reason = error.reason();
        match error {
            CohostApiError::QuotaExhausted { retry_after, .. } => {
                self.status = CohostStatus::Paused;
                self.next_attempt_at = Some(now + retry_after.unwrap_or(QUOTA_DEFAULT_RETRY));
            }
            CohostApiError::PremiumRequired { .. } | CohostApiError::ConsentRequired { .. } => {
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
    }

    fn pause(&mut self, reason: CohostReason, now: Instant) -> bool {
        let changed = self.status != CohostStatus::Paused || self.reason != Some(reason);
        self.status = CohostStatus::Paused;
        self.reason = Some(reason);
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
            Ok(response) => session.apply_response(response, dropped, now_iso),
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

fn emit_state(state: &AppState, snapshot: &CohostState) {
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
        emit_state(state, &snapshot);
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
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let chat_session_id = state
        .live_chat
        .lock()
        .await
        .session_id()
        .map(str::to_string);
    if chat_session_id.as_deref() != Some(session_id.as_str()) {
        return Err(CohostError::SessionMismatch);
    }

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
    state.emit_log(
        "info",
        format!("Co-host listening for session {session_id}."),
    );
    emit_state(state, &snapshot);
    Ok(snapshot)
}

pub async fn stop_cohost(state: &AppState) -> CohostState {
    let mut engine = state.cohost.lock().await;
    let stopped = engine.stop_session();
    let snapshot = engine.snapshot();
    drop(engine);
    if stopped {
        state.emit_log("info", "Co-host stopped.");
        emit_state(state, &snapshot);
    }
    snapshot
}

/// Live-chat session boundary (stop, or a replacing start): drop the engine
/// session so no late tick can publish into the next stream.
pub(crate) async fn stop_cohost_for_session_end(state: &AppState) {
    stop_cohost(state).await;
}

/// Delivery-path hook: remember eligible rows for the next tick. Rows from a
/// different session are ignored by the engine's own guard.
pub(crate) async fn note_messages(state: &AppState, messages: &[LiveChatMessage]) {
    if messages.is_empty() {
        return;
    }
    let mut engine = state.cohost.lock().await;
    if engine.session.is_none() {
        return;
    }
    engine.note_messages(messages);
}

pub async fn mark_question_answered(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let mut engine = state.cohost.lock().await;
    let changed = engine.mark_answered(&params.session_id, &params.question_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot);
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
    let mut engine = state.cohost.lock().await;
    let changed = engine
        .mark_answered(session_id, question_id)
        .unwrap_or(false);
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot);
    }
}

pub async fn dismiss_flag(
    state: &AppState,
    params: CohostFlagParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.message_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let mut engine = state.cohost.lock().await;
    let changed = engine.dismiss_flag(&params.session_id, &params.message_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot);
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
    let prepared = {
        let mut engine = state.cohost.lock().await;
        let prepared = engine.prepare_tick(generation, token.is_some(), premium, Instant::now());
        match prepared {
            Ok(prepared) => Ok(prepared),
            Err(TickGate::Stopped) => return false,
            Err(TickGate::Idle) => return true,
            Err(TickGate::Paused(reason)) => Err((reason, engine.snapshot())),
        }
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err((reason, snapshot)) => {
            state.emit_log(
                "warn",
                format!(
                    "Co-host paused: {}.",
                    serde_json::to_string(&reason).unwrap_or_default()
                ),
            );
            emit_state(state, &snapshot);
            return true;
        }
    };
    let Some(token) = token else {
        return true;
    };
    let dropped = prepared.request.dropped_messages;
    let message_count = prepared.request.messages.len();
    let result = match VideorcApiClient::new() {
        Ok(client) => client.post_cohost_tick(&token, &prepared.request).await,
        Err(error) => Err(CohostApiError::Network {
            message: error.to_string(),
        }),
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
        Err(error) => Some((
            "warn",
            format!(
                "Co-host tick {} failed ({}): {}",
                prepared.request.tick_seq,
                serde_json::to_string(&error.reason()).unwrap_or_default(),
                error.message()
            ),
        )),
    };
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
    emit_state(state, &snapshot);
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

    fn enabled_settings() -> CohostSettings {
        CohostSettings {
            enabled: true,
            tone: CohostTone::Short,
            notes: "Keyboard: Keychron Q1".to_string(),
            auto_highlight: false,
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
            usage: None,
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
        let failure = Err(CohostApiError::Network {
            message: "offline".to_string(),
        });
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
                Err(CohostApiError::GatewayError {
                    code: "ai-gateway-error".to_string(),
                    message: "boom".to_string(),
                }),
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
                "sessionClientId",
                "streamTitle",
                "tickSeq",
                "tone",
            ]
        );
        assert_eq!(json["promptVersion"], 1);
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
            CohostTickFlag {
                message_id: rows[3].id.clone(),
                kind: CohostFlagKind::Spam,
                severity: CohostFlagSeverity::Medium,
                reason: "link spam".to_string(),
            },
            CohostTickFlag {
                message_id: "not-ours".to_string(),
                kind: CohostFlagKind::Toxicity,
                severity: CohostFlagSeverity::High,
                reason: "ignored".to_string(),
            },
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
                CohostApiError::Unauthorized {
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::SessionExpired,
                5,
            ),
            (
                CohostApiError::PremiumRequired {
                    message: "x".into(),
                },
                CohostStatus::Paused,
                CohostReason::PremiumRequired,
                5,
            ),
            (
                CohostApiError::ConsentRequired {
                    message: "x".into(),
                },
                CohostStatus::Paused,
                CohostReason::ConsentRequired,
                5,
            ),
            (
                CohostApiError::QuotaExhausted {
                    retry_after: Some(secs(120)),
                    message: "x".into(),
                },
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                120,
            ),
            (
                CohostApiError::QuotaExhausted {
                    retry_after: None,
                    message: "x".into(),
                },
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                3600,
            ),
            (
                CohostApiError::ServerUnconfigured {
                    code: "cohost-disabled".into(),
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                CohostApiError::PromptVersionUnsupported {
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                CohostApiError::GatewayError {
                    code: "ai-gateway-error".into(),
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::InvalidRequest {
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::MalformedResponse {
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::Network {
                    message: "x".into(),
                },
                CohostStatus::Error,
                CohostReason::Network,
                5,
            ),
        ];
        for (error, status, reason, retry_secs) in cases {
            let (mut engine, generation) = running_engine(start);
            engine.note_messages(&messages("session-1", 0..5));
            engine
                .prepare_tick(generation, true, true, start + secs(1))
                .unwrap();
            assert!(engine.apply_tick_result(generation, 0, Err(error.clone()), start, "t"));
            let snapshot = engine.snapshot();
            assert_eq!(snapshot.status, status, "{error:?}");
            assert_eq!(snapshot.reason, Some(reason), "{error:?}");
            let next = engine.session.as_ref().unwrap().next_attempt_at.unwrap();
            assert_eq!(
                next.duration_since(start).as_secs(),
                retry_secs,
                "{error:?}"
            );
        }
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
        });
        assert_eq!(settings.notes.chars().count(), COHOST_NOTES_MAX_CHARS);
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
            },
        )
        .await
        .unwrap();
        assert_eq!(cohost_status(&state).await, CohostState::off());
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
