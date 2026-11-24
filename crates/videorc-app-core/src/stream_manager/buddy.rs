//! S3.2d: Sidekick (and the avatar it speaks through) in the Stream Manager
//! as plain data. The backend owns the engine (`cohost.state`: its
//! questions, flags, mood, promises, recaps, voice commands and proposed
//! posts); this is the pure derivation every surface renders from it:
//! `lib/cohost-view.ts`, `lib/cohost-presence.ts`, `lib/cohost-marks.ts`,
//! `lib/cohost-state.ts`, `lib/buddy-command-view.ts`,
//! `lib/buddy-output-notice.ts`, the pane's half of
//! `lib/buddy-auto-chat-view.ts`, `lib/buddy-tab-view.ts`'s `CLOUD_AI_USES`,
//! `lib/buddy-pet-view.ts`'s reaction chips, the chips and labels of
//! `components/comment-row.tsx`, `components/cohost-pane.tsx` and
//! `components/stream-manager/stream-manager.tsx`, and the card helpers of
//! `components/stream-manager/buddy-utterance-cards.tsx`.
//!
//! Since Electron PR #1356 and #1372 the AI co-host is "Sidekick" and the
//! character drawn on stream is "the avatar" (default name
//! [`DEFAULT_AVATAR_NAME`]). Sidekick never posts on its own: nothing here
//! sends, and the only automatic thing on stream is the bubble.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use videorc_protocol::cohost::{CohostAutoChat, CohostPersona, CohostTalkMode};

use super::format::plural;

// --- The wire: `cohost.state` --------------------------------------------

/// The backend's `CohostState`, as far as the window reads it. Every field
/// has a default so a state from an older or newer backend still reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostState {
    pub session_id: Option<String>,
    /// `off`, `listening`, `paused` or `error`.
    pub status: String,
    pub reason: Option<String>,
    pub detail: Option<CohostErrorDetail>,
    pub questions: Vec<CohostQuestion>,
    pub flags: Vec<CohostFlag>,
    /// `hype`, `calm`, `tense` or `mixed`.
    pub mood: Option<String>,
    pub last_tick_at: Option<String>,
    pub tick_seq: u64,
    pub partial: bool,
    pub tick_in_flight: bool,
    pub pending_messages: u64,
    pub next_tick_at: Option<String>,
    pub retry_at: Option<String>,
    pub messages_seen: u64,
    pub questions_total: u64,
    pub highlights: Vec<CohostHighlight>,
    pub alerts: Vec<CohostAlert>,
    pub spotlight: Option<CohostSpotlight>,
    pub recently_resolved: Vec<CohostRecentlyResolved>,
    pub listening: Option<CohostListening>,
    pub topic: Option<String>,
    pub promises: Vec<CohostPromise>,
    pub promise_reminder: Option<CohostPromiseReminder>,
    pub recap: Option<CohostRecap>,
    pub say_hi: Vec<CohostSayHi>,
    pub dead_air_nudge: Option<CohostDeadAirNudge>,
    pub command: Option<CohostCommand>,
    pub command_availability: Option<CohostCommandAvailability>,
    pub utterances: Vec<CohostUtterance>,
}

impl Default for CohostState {
    /// `offCohostState()`: what the window shows before the engine reports.
    fn default() -> Self {
        Self {
            session_id: None,
            status: "off".into(),
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
            retry_at: None,
            messages_seen: 0,
            questions_total: 0,
            highlights: Vec::new(),
            alerts: Vec::new(),
            spotlight: None,
            recently_resolved: Vec::new(),
            listening: None,
            topic: None,
            promises: Vec::new(),
            promise_reminder: None,
            recap: None,
            say_hi: Vec::new(),
            dead_air_nudge: None,
            command: None,
            command_availability: None,
            utterances: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostErrorDetail {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostQuestion {
    pub id: String,
    pub text: String,
    pub message_ids: Vec<String>,
    pub askers: Vec<String>,
    pub platforms: Vec<String>,
    /// `high`, `normal` or `low`.
    pub priority: String,
    pub suggested_reply: String,
    pub from_notes: bool,
    pub first_seen_at: String,
    pub updated_at: String,
    pub on_topic: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostFlag {
    pub message_id: String,
    pub kind: String,
    /// `high`, `medium` or `low`.
    pub severity: String,
    pub reason: String,
    pub at: String,
    pub confidence: Option<f64>,
    pub target: Option<String>,
    pub action: Option<String>,
    pub also_kinds: Vec<String>,
    pub rule: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostHighlight {
    pub message_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostAlert {
    pub kind: String,
    pub viewers: u32,
    pub last_seen_at: String,
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostSpotlight {
    pub message_id: String,
    pub question_id: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostRecentlyResolved {
    pub question: CohostQuestion,
    pub resolved_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostListening {
    /// `off`, `starting`, `on` or `blocked`.
    pub state: String,
    pub reason_code: Option<String>,
    pub message: Option<String>,
    pub remaining_seconds: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostPromise {
    pub id: String,
    pub text: String,
    pub trigger: CohostPromiseTrigger,
    pub first_seen_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostPromiseTrigger {
    /// `viewers`, `minutes` or `none`.
    pub kind: String,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostPromiseReminder {
    pub promise_id: String,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostRecap {
    pub text: String,
    pub at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostSayHi {
    pub author_key: String,
    pub name: String,
    pub platform: String,
    pub first_seen_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostDeadAirNudge {
    pub key: String,
    pub text: String,
    pub at: String,
}

/// A voice command Buddy heard (plan 140 S3).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostCommand {
    pub id: String,
    pub heard: String,
    /// `highlight`, `remove`, `act`, …
    pub kind: String,
    /// `ambiguous`, `confirm`, `done`, `not-found`, `refused`, `unavailable`, …
    pub status: String,
    pub message: String,
    pub target: Option<CohostCommandTarget>,
    pub candidates: Vec<CohostCommandTarget>,
    pub operation_id: Option<String>,
    pub at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostCommandTarget {
    pub message_id: String,
    pub author_name: String,
    pub platform: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostCommandAvailability {
    /// `on` or `paused`.
    pub voice_commands: String,
    pub remove: String,
}

/// One thing the Buddy said or wants to say (plan 164 D7).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostUtterance {
    pub id: String,
    pub text: String,
    pub state: String,
    pub trigger: CohostUtteranceTrigger,
    pub destination_ids: Vec<String>,
    /// `proposed`, `sent`, `dismissed`, `bubble-only` or `failed`.
    pub status: String,
    pub at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CohostUtteranceTrigger {
    /// `greeting`, `answer`, `banter` or `manual`.
    pub kind: String,
}

/// `cohost.buddy.status` / `cohost.buddy.state`: the Buddy on stream as the
/// backend runs it; the bubble while a line is up.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuddyOverlaySnapshot {
    pub persona_id: String,
    /// `idle`, `talk`, `laugh` or `think`.
    pub state: String,
    pub bubble: Option<BuddyBubble>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuddyBubble {
    pub text: String,
    pub until: String,
}

/// `cohost.settings.get`, as far as the window reads it. Each part reads on
/// its own, so a persona this build does not know still leaves the switches.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CohostSettingsView {
    pub enabled: bool,
    pub listen: bool,
    pub persona: Option<CohostPersona>,
    pub auto_chat: Option<CohostAutoChat>,
    /// S3.10a: "About you", the facts Buddy answers from (`notes`).
    pub notes: String,
    /// S3.10b: the whole answer, for the Buddy page's Chat and Voice
    /// (tone, rules, the highlights, the wake word, the removal's ask).
    pub raw: Value,
}

impl CohostSettingsView {
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        Some(Self {
            enabled: object.get("enabled").and_then(Value::as_bool) == Some(true),
            listen: object.get("listen").and_then(Value::as_bool) == Some(true),
            persona: object
                .get("persona")
                .and_then(|persona| serde_json::from_value(persona.clone()).ok()),
            auto_chat: object
                .get("autoChat")
                .and_then(|auto| serde_json::from_value(auto.clone()).ok()),
            notes: object
                .get("notes")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            raw: value.clone(),
        })
    }
}

// --- The window's one value (`CohostWindowState`) ------------------------

/// What the Stream Manager renders the Buddy pane from: the Studio resolves
/// Premium, consent and the settings once, and the window never re-derives
/// them (`CohostWindowState`).
#[derive(Debug, Clone, PartialEq)]
pub struct CohostWindowState {
    pub state: CohostState,
    /// Fail-closed: false until the account says otherwise.
    pub entitled: bool,
    pub entitlement_reason: Option<String>,
    pub upgrade_url: Option<String>,
    pub consented: bool,
    pub enabled: bool,
    /// Unknown (a seed without it) never offers the listening card.
    pub listen: Option<bool>,
    pub auto_chat: Option<CohostAutoChat>,
    pub buddy: Option<CohostWindowBuddy>,
}

impl Default for CohostWindowState {
    /// `offCohostWindowState()`.
    fn default() -> Self {
        Self {
            state: CohostState::default(),
            entitled: false,
            entitlement_reason: None,
            upgrade_url: None,
            consented: false,
            enabled: false,
            listen: Some(false),
            auto_chat: None,
            buddy: None,
        }
    }
}

/// The Buddy as the Stream Manager operates it (plan 164 S-C4).
#[derive(Debug, Clone, PartialEq)]
pub struct CohostWindowBuddy {
    pub persona: CohostPersona,
    /// `idle`, `talk`, `laugh` or `think`.
    pub state: String,
    pub bubble: Option<String>,
    pub show_on_stream: bool,
    pub show_in_recording: bool,
}

impl CohostWindowState {
    /// A smoke's seed (`comments-window-seed-cohost`): Electron's
    /// `CohostWindowState` JSON. `None` when it isn't one.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let state = serde_json::from_value(object.get("state")?.clone()).ok()?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
        let buddy = object.get("buddy").and_then(|buddy| {
            Some(CohostWindowBuddy {
                persona: serde_json::from_value(buddy.get("persona")?.clone()).ok()?,
                state: buddy
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("idle")
                    .to_string(),
                bubble: buddy
                    .get("bubble")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                show_on_stream: buddy.get("showOnStream").and_then(Value::as_bool) == Some(true),
                show_in_recording: buddy.get("showInRecording").and_then(Value::as_bool)
                    == Some(true),
            })
        });
        Some(Self {
            state,
            entitled: object.get("entitled").and_then(Value::as_bool) == Some(true),
            entitlement_reason: text("entitlementReason"),
            upgrade_url: text("upgradeUrl"),
            consented: object.get("consented").and_then(Value::as_bool) == Some(true),
            enabled: object.get("enabled").and_then(Value::as_bool) == Some(true),
            listen: object.get("listen").and_then(Value::as_bool),
            auto_chat: object
                .get("autoChat")
                .and_then(|auto| serde_json::from_value(auto.clone()).ok()),
            buddy,
        })
    }

    /// The Premium gate as the pane reads it.
    pub fn gate(&self) -> PaneGate<'_> {
        PaneGate {
            allowed: self.entitled,
            reason: self.entitlement_reason.as_deref().unwrap_or(""),
            upgrade_url: self.upgrade_url.as_deref(),
        }
    }

    /// The Buddy's name, when the window knows it.
    pub fn name(&self) -> Option<&str> {
        self.buddy.as_ref().map(|buddy| buddy.persona.name.as_str())
    }

    /// How Buddy talks on its own (`autoChat.talk`; Bubble by default).
    pub fn talk(&self) -> CohostTalkMode {
        self.auto_chat
            .as_ref()
            .and_then(|auto| auto.talk)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneGate<'a> {
    pub allowed: bool,
    pub reason: &'a str,
    pub upgrade_url: Option<&'a str>,
}

// --- Time -------------------------------------------------------------

fn parse(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn millis(iso: &str) -> Option<i64> {
    parse(iso).map(|at| at.timestamp_millis())
}

/// `secondsUntil`: whole seconds left, rounded up; `None` without a time.
pub fn seconds_until(iso: Option<&str>, now: DateTime<Utc>) -> Option<i64> {
    let at = millis(iso?)?;
    Some(((at - now.timestamp_millis()).max(0) as f64 / 1000.0).ceil() as i64)
}

// --- `cohost-state.ts` ------------------------------------------------

/// `applyCohostState`: an older tick of the same session never replaces a
/// newer one, and a voice command outlives a state that dropped it.
pub fn apply_cohost_state(current: Option<&CohostState>, next: CohostState) -> CohostState {
    let Some(current) = current else {
        return next;
    };
    if current.session_id != next.session_id {
        return next;
    }
    if next.tick_seq < current.tick_seq {
        return current.clone();
    }
    if let Some(kept) = &current.command {
        let older = next
            .command
            .as_ref()
            .is_none_or(|command| millis(&command.at) < millis(&kept.at));
        if older {
            return CohostState {
                command: Some(kept.clone()),
                ..next
            };
        }
    }
    next
}

/// `cohostHighlightMessageId`: the question's first message.
pub fn highlight_message_id(question: &CohostQuestion) -> Option<&str> {
    question.message_ids.first().map(String::as_str)
}

/// `cohostErrorDetailText`: one line for a bug report.
pub fn error_detail_text(detail: Option<&CohostErrorDetail>) -> Option<String> {
    let detail = detail?;
    let code = detail.code.trim();
    if code.is_empty() {
        return None;
    }
    let head = match detail.status {
        Some(status) => format!("{code} (HTTP {status})"),
        None => code.to_string(),
    };
    let message = detail.message.trim();
    Some(if message.is_empty() {
        head
    } else {
        format!("{head}: {message}")
    })
}

/// The settings a Buddy Live command saves (`cohostEnableRelayPatch`):
/// `enabled` only when it changes, `listen` only when turning on or asked.
pub fn enable_patch(
    current_enabled: Option<bool>,
    enabled: bool,
    listen: Option<bool>,
    grant_listen: bool,
) -> serde_json::Map<String, Value> {
    let mut patch = serde_json::Map::new();
    if current_enabled != Some(enabled) {
        patch.insert("enabled".into(), Value::Bool(enabled));
    }
    let turning_on = enabled && current_enabled != Some(true);
    if enabled && listen == Some(true) && (turning_on || grant_listen) {
        patch.insert("listen".into(), Value::Bool(true));
    }
    patch
}

// --- Reasons --------------------------------------------------------------

/// Why Sidekick paused or stopped, as the words after "Paused:" or "Stopped:".
pub fn reason_label(reason: Option<&str>) -> Option<&'static str> {
    Some(match reason? {
        "premium-required" => "Premium needed",
        "consent-required" => "cloud AI is off",
        "session-expired" => "sign-in expired",
        "signed-out" => "signed out",
        "quota-exhausted" => "daily AI allowance used up",
        "server-unconfigured" => "Videorc AI is unavailable",
        "network" => "no connection",
        "gateway-error" => "Videorc AI error",
        _ => return None,
    })
}

/// The words after "Retrying:".
pub fn retry_reason_label(reason: Option<&str>) -> Option<&'static str> {
    if reason == Some("gateway-error") {
        return Some("Videorc AI didn't answer");
    }
    reason_label(reason)
}

// --- The pane's mode ------------------------------------------------------

/// What the Sidekick pane shows under its header (`cohostPaneMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneMode {
    /// The Premium lock, with its reason and link.
    Upsell {
        reason: String,
        upgrade_url: Option<String>,
    },
    /// The cloud-AI disclosure.
    Consent,
    /// Sidekick Live off: the header's switch says so.
    Disabled,
    Live,
}

pub fn pane_mode(gate: PaneGate<'_>, consented: bool, enabled: bool) -> PaneMode {
    if !gate.allowed {
        return PaneMode::Upsell {
            reason: gate.reason.to_string(),
            upgrade_url: gate.upgrade_url.map(str::to_string),
        };
    }
    if !consented {
        return PaneMode::Consent;
    }
    if !enabled {
        return PaneMode::Disabled;
    }
    PaneMode::Live
}

// --- Questions and flags ----------------------------------------------------

fn priority_rank(priority: &str) -> u8 {
    match priority {
        "high" => 0,
        "low" => 2,
        _ => 1,
    }
}

/// Highest priority first, on-topic first within a priority, then oldest.
pub fn sorted_questions(questions: &[CohostQuestion]) -> Vec<CohostQuestion> {
    let mut sorted = questions.to_vec();
    sorted.sort_by(|left, right| {
        priority_rank(&left.priority)
            .cmp(&priority_rank(&right.priority))
            .then(right.on_topic.cmp(&left.on_topic))
            .then_with(
                || match (millis(&left.first_seen_at), millis(&right.first_seen_at)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => std::cmp::Ordering::Equal,
                },
            )
            .then_with(|| left.id.cmp(&right.id))
    });
    sorted
}

/// Newest flag first.
pub fn sorted_flags(flags: &[CohostFlag]) -> Vec<CohostFlag> {
    let mut sorted = flags.to_vec();
    sorted.sort_by(|left, right| {
        match (millis(&right.at), millis(&left.at)) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.message_id.cmp(&right.message_id))
    });
    sorted
}

/// One row of the triage list: a question or a flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRow {
    pub key: String,
    pub question: bool,
    /// The question's id, or the flagged message's.
    pub id: String,
}

pub fn question_row_key(id: &str) -> String {
    format!("q:{id}")
}

pub fn flag_row_key(message_id: &str) -> String {
    format!("f:{message_id}")
}

/// `cohostRows`: questions then flags, so ↑ ↓ walk the whole pane.
pub fn pane_rows(state: &CohostState) -> Vec<PaneRow> {
    sorted_questions(&state.questions)
        .into_iter()
        .map(|question| PaneRow {
            key: question_row_key(&question.id),
            question: true,
            id: question.id,
        })
        .chain(sorted_flags(&state.flags).into_iter().map(|flag| PaneRow {
            key: flag_row_key(&flag.message_id),
            question: false,
            id: flag.message_id,
        }))
        .collect()
}

/// The selection stays on its row across ticks; else the top row.
pub fn resolve_selection(rows: &[PaneRow], selected: Option<&str>) -> Option<String> {
    let first = rows.first()?;
    if let Some(key) = selected
        && rows.iter().any(|row| row.key == key)
    {
        return Some(key.to_string());
    }
    Some(first.key.clone())
}

/// ↑ ↓: clamped, never wrapping.
pub fn move_selection(rows: &[PaneRow], selected: Option<&str>, delta: i64) -> Option<String> {
    if rows.is_empty() {
        return None;
    }
    let current = resolve_selection(rows, selected);
    let index = rows
        .iter()
        .position(|row| Some(&row.key) == current.as_ref())
        .unwrap_or(0) as i64;
    let next = (index + delta).clamp(0, rows.len() as i64 - 1) as usize;
    Some(rows[next].key.clone())
}

/// `trimDraftToCap`: the cap without cutting a word near the end.
pub fn trim_draft_to_cap(text: &str, cap: usize) -> String {
    let trimmed = text.trim();
    if cap == 0 {
        return String::new();
    }
    if trimmed.chars().count() <= cap {
        return trimmed.to_string();
    }
    let sliced: String = trimmed.chars().take(cap).collect();
    let word_safe = match sliced.rfind(' ') {
        Some(space) if sliced[..space].chars().count() as f64 > cap as f64 * 0.6 => {
            sliced[..space].to_string()
        }
        _ => sliced,
    };
    word_safe.trim_end().to_string()
}

/// Reply's draft in the composer, at the strictest destination's cap.
pub fn draft_for_question(question: &CohostQuestion, targets: &[String]) -> String {
    trim_draft_to_cap(
        &question.suggested_reply,
        super::send::chat_draft_max_chars(targets),
    )
}

/// "Ada +3".
pub fn askers_label(askers: &[String]) -> String {
    match askers {
        [] => String::new(),
        [only] => only.clone(),
        [first, rest @ ..] => format!("{first} +{}", rest.len()),
    }
}

/// The priority's chip (none for Normal).
pub fn priority_label(priority: &str) -> Option<&'static str> {
    match priority {
        "high" => Some("High"),
        "low" => Some("Low"),
        _ => None,
    }
}

/// The flag kind's name; a kind this build doesn't know is "Flagged".
pub fn flag_kind_label(kind: &str) -> &'static str {
    match kind {
        "toxicity" => "Toxicity",
        "spam" => "Spam",
        "self-promo" => "Self-promo",
        "personal-info" => "Personal info",
        "hate" => "Hate",
        "harassment" => "Harassment",
        "threat" => "Threat",
        "sexual" => "Sexual",
        "scam" => "Scam",
        "self-harm" => "Self-harm",
        "spoiler" => "Spoiler",
        "impersonation" => "Impersonation",
        "rule" => "Chat rule",
        _ => "Flagged",
    }
}

/// "Harassment · at you", "Chat rule · No spoilers", "Flagged".
pub fn flag_chip_label(flag: &CohostFlag) -> String {
    let mut parts = vec![flag_kind_label(&flag.kind).to_string()];
    if flag.kind == "rule"
        && let Some(rule) = flag.rule.as_deref().filter(|rule| !rule.is_empty())
    {
        parts.push(rule.to_string());
    }
    let target = match flag.target.as_deref() {
        Some("streamer") => Some("at you"),
        Some("viewer") => Some("at a viewer"),
        Some("group") => Some("at a group"),
        _ => None,
    };
    if let Some(target) = target {
        parts.push(target.to_string());
    }
    parts.join(" · ")
}

/// A suggestion only: Videorc can only remove a message.
pub fn flag_action_label(flag: &CohostFlag) -> Option<&'static str> {
    match flag.action.as_deref()? {
        "hide" | "timeout" | "ban" => Some("Suggests removing"),
        _ => None,
    }
}

/// The flag's reason, and what else scored high.
pub fn flag_detail(flag: &CohostFlag) -> String {
    let also: Vec<&str> = flag
        .also_kinds
        .iter()
        .map(|kind| flag_kind_label(kind))
        .collect();
    let mut lines = vec![flag.reason.trim().to_string()];
    if !also.is_empty() {
        lines.push(format!("Also: {}", also.join(", ")));
    }
    lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn min_confidence(sensitivity: &str) -> f64 {
    match sensitivity {
        "relaxed" => 0.85,
        "strict" => 0.0,
        _ => 0.6,
    }
}

/// `cohostStateForSensitivity`: the flags this sensitivity shows.
pub fn state_for_sensitivity(state: &CohostState, sensitivity: &str) -> CohostState {
    let floor = min_confidence(sensitivity);
    let flags: Vec<CohostFlag> = state
        .flags
        .iter()
        .filter(|flag| flag.confidence.is_none_or(|confidence| confidence >= floor))
        .cloned()
        .collect();
    if flags.len() == state.flags.len() {
        return state.clone();
    }
    CohostState {
        flags,
        ..state.clone()
    }
}

// --- Alerts, mood, promises, recaps -------------------------------------

/// The backend's alert expiry, mirrored.
pub const ALERT_EXPIRY_MS: i64 = 120_000;

/// Alerts worth a chip now: corroborated and not expired.
pub fn active_alerts(state: &CohostState, now: DateTime<Utc>) -> Vec<CohostAlert> {
    if state.status == "off" {
        return Vec::new();
    }
    state
        .alerts
        .iter()
        .filter(|alert| {
            alert.active
                && millis(&alert.last_seen_at)
                    .is_none_or(|seen| now.timestamp_millis() - seen < ALERT_EXPIRY_MS)
        })
        .cloned()
        .collect()
}

/// "Chat says: no audio · 3 viewers".
pub fn alert_label(alert: &CohostAlert) -> String {
    let what = match alert.kind.as_str() {
        "audio" => "no audio",
        "video" => "video problem",
        "stream-health" => "stream is lagging",
        "game" => "game problem",
        _ => "something is wrong",
    };
    let viewers = if alert.viewers == 1 {
        "viewer"
    } else {
        "viewers"
    };
    format!("Chat says: {what} · {} {viewers}", alert.viewers)
}

/// The mood's words.
pub fn mood_label(mood: &str) -> Option<&'static str> {
    Some(match mood {
        "hype" => "Chat is hyped",
        "calm" => "Chat is calm",
        "tense" => "Chat is tense",
        "mixed" => "Chat is mixed",
        _ => return None,
    })
}

/// The chat's weather, one quiet line: its mood and a partial pass
/// (`components/cohost-pane.tsx`).
pub fn weather(state: &CohostState) -> Vec<&'static str> {
    let mut parts = Vec::new();
    if let Some(mood) = state.mood.as_deref().and_then(mood_label) {
        parts.push(mood);
    }
    if state.partial {
        parts.push("Partial pass, newest messages used");
    }
    parts
}

/// "at 100 viewers", "in 10 min".
pub fn promise_trigger_label(trigger: &CohostPromiseTrigger) -> Option<String> {
    let value = trigger.value.filter(|value| value.is_finite())?;
    let value = value.round().max(0.0) as i64;
    match trigger.kind.as_str() {
        "viewers" => Some(format!("at {}", plural(value, "viewer", "viewers"))),
        "minutes" => Some(format!("in {value} min")),
        _ => None,
    }
}

/// The recap while it's current.
pub fn active_recap(state: &CohostState, now: DateTime<Utc>) -> Option<&CohostRecap> {
    let recap = state.recap.as_ref()?;
    match millis(&recap.expires_at) {
        Some(expires) if expires <= now.timestamp_millis() => None,
        _ => Some(recap),
    }
}

/// The backend's 60 s for "Answered on air", mirrored.
pub const RECENTLY_RESOLVED_TTL_MS: i64 = 60_000;

/// "Answered on air": newest first, at most three, inside the 60 s.
pub fn answered_on_air(state: &CohostState, now: DateTime<Utc>) -> Vec<CohostRecentlyResolved> {
    state
        .recently_resolved
        .iter()
        .filter(|entry| {
            millis(&entry.resolved_at)
                .is_some_and(|at| at + RECENTLY_RESOLVED_TTL_MS > now.timestamp_millis())
        })
        .rev()
        .take(3)
        .cloned()
        .collect()
}

// --- Toasts ----------------------------------------------------------------

/// The question toast's slot; at most one a minute.
pub const QUESTION_TOAST_ID: &str = "cohost-question";
pub const QUESTION_TOAST_THROTTLE_MS: i64 = 60_000;
pub const PROMISE_TOAST_ID: &str = "cohost-promise";
pub const DEAD_AIR_TOAST_ID: &str = "cohost-dead-air";

/// The question toast's speaker: catching a question is Sidekick's, so the
/// toast never speaks as the avatar (plan 239 D1).
pub const QUESTION_TOAST_SPEAKER: &str = "Sidekick";

/// "Sidekick: 5 people asking: What keyboard is that? · ⌘J"
/// (`cohostQuestionToastMessage`).
pub fn question_toast_message(question: &CohostQuestion, shortcut: &str) -> String {
    let speaker = QUESTION_TOAST_SPEAKER;
    let askers = question.askers.len();
    let who = if askers > 1 {
        format!("{askers} people asking")
    } else if askers == 1 {
        format!("{} is asking", question.askers[0])
    } else {
        "a new question".to_string()
    };
    let text = trim_draft_to_cap(&question.text, 64);
    if text.is_empty() {
        format!("{speaker}: {who} · {shortcut}")
    } else {
        format!("{speaker}: {who}: {text} · {shortcut}")
    }
}

/// A toast only when the pane is hidden and a new high-priority question
/// arrived, at most one a minute.
pub fn question_toast(
    previous: Option<&CohostState>,
    next: &CohostState,
    pane_open: bool,
    last_toast_ms: Option<i64>,
    now: DateTime<Utc>,
    shortcut: &str,
) -> Option<String> {
    if pane_open || next.status != "listening" {
        return None;
    }
    if last_toast_ms.is_some_and(|at| now.timestamp_millis() - at < QUESTION_TOAST_THROTTLE_MS) {
        return None;
    }
    let known: Vec<&str> = previous
        .filter(|previous| previous.session_id == next.session_id)
        .map(|previous| previous.questions.iter().map(|q| q.id.as_str()).collect())
        .unwrap_or_default();
    let candidate = sorted_questions(&next.questions)
        .into_iter()
        .find(|question| question.priority == "high" && !known.contains(&question.id.as_str()))?;
    Some(question_toast_message(&candidate, shortcut))
}

/// "You promised: …", once per reminder.
pub fn promise_reminder_toast(
    previous: Option<&CohostState>,
    next: &CohostState,
) -> Option<String> {
    let reminder = next.promise_reminder.as_ref()?;
    let before = previous
        .filter(|previous| previous.session_id == next.session_id)
        .and_then(|previous| previous.promise_reminder.as_ref());
    if before
        .is_some_and(|before| before.promise_id == reminder.promise_id && before.at == reminder.at)
    {
        return None;
    }
    let trimmed = trim_draft_to_cap(&reminder.text, 80);
    Some(if trimmed.is_empty() {
        "You made a promise on stream.".to_string()
    } else {
        format!("You promised: {trimmed}")
    })
}

/// The dead-air nudge to toast once per key.
pub fn dead_air_toast(state: &CohostState, last_key: Option<&str>) -> Option<(String, String)> {
    let nudge = state.dead_air_nudge.as_ref()?;
    if Some(nudge.key.as_str()) == last_key || nudge.text.trim().is_empty() {
        return None;
    }
    Some((nudge.key.clone(), nudge.text.clone()))
}

// --- The nudge and the listening card --------------------------------------

/// `cohostNudgeVisible`: live, allowed, consented, and simply off.
pub fn nudge_visible(
    session_id: Option<&str>,
    gate_allowed: bool,
    consented: bool,
    enabled: bool,
    dismissed_forever: bool,
    dismissed_session_id: Option<&str>,
) -> bool {
    let Some(session_id) = session_id else {
        return false;
    };
    if enabled || !gate_allowed || !consented || dismissed_forever {
        return false;
    }
    dismissed_session_id != Some(session_id)
}

/// `cohostListenPromptVisible`.
pub fn listen_prompt_visible(enabled: bool, listen: Option<bool>, dismissed: bool) -> bool {
    enabled && listen == Some(false) && !dismissed
}

const MIC_TO_TEXT: &str =
    "your microphone audio goes to Videorc's cloud speech-to-text and comes back as text";
const MIC_KEPT: &str =
    "Videorc servers don't keep it. The transcript is saved with your recording on this computer.";

/// The listening card's sentence, under its title.
pub fn listen_disclosure() -> String {
    let mut first = MIC_TO_TEXT.chars();
    let head = first
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default();
    format!("{head}{}. {MIC_KEPT}", first.as_str())
}

/// The listening line of the one list of cloud uses (`BUDDY_HEARS_YOU_USE`).
pub fn hears_you_use() -> String {
    format!("Sidekick hears you while you're live: {MIC_TO_TEXT}.")
}

/// What Sidekick does with chat, the half every Sidekick user consents to
/// (`COHOST_CHAT_CONSENT_SENTENCE`).
pub const CHAT_CONSENT_SENTENCE: &str = "Sidekick reads your live chat with Videorc's cloud AI.";

/// The one list of cloud uses consent covers (`CLOUD_AI_USES`, the Sidekick
/// page's `lib/buddy-tab-view.ts`), which the pane's disclosure draws.
pub fn cloud_ai_uses() -> [String; 6] {
    [
        CHAT_CONSENT_SENTENCE.to_string(),
        hears_you_use(),
        "Creating an avatar: your description and any picture you add go to Videorc's cloud AI, and the picture is used once and not kept. The avatars you create (their pictures, name, personality and About you) are kept in your Videorc account so you can use them on any computer, until you delete them or your account.".to_string(),
        "Creating an Alive avatar: your reference picture and its description go to Videorc's cloud AI. Its moves are kept on this computer and, for an avatar you made that's in your library, in your Videorc account too, so it moves on any computer, until you remove them or delete the avatar or your account.".to_string(),
        "Sidekick's lines: with Answers, Banter or AI greetings on, they are drafted by Videorc's cloud AI. Your avatar says them in its bubble, and one is posted on your own account only when you click its card in Suggest.".to_string(),
        "Clean cut uploads a recording's audio, never the video, in short chunks for a word-by-word transcript, and sends its sentences to Videorc's cloud AI to find retakes. Neither is kept on Videorc servers after the job finishes.".to_string(),
    ]
}

/// What is kept, and where, after the list of uses.
pub const CLOUD_AI_KEEPS: &str = "Videorc servers don't keep your chat or your audio. A short report of each stream is saved on this computer.";

// --- Listening ---------------------------------------------------------------

/// Whether Sidekick hears the streamer: one label, one sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListeningView {
    /// `starting`, `on` or `blocked`.
    pub state: &'static str,
    pub label: String,
    pub detail: String,
}

fn listen_blocked_reason(code: &str) -> Option<&'static str> {
    Some(match code {
        "no-capture" => "not live",
        "no-microphone" => "no microphone selected",
        "signed-out" | "unauthorized" => "sign in",
        "signing-out" => "signing out",
        "shutting-down" => "Videorc is closing",
        "service-unavailable" => "Videorc AI is unavailable",
        "consent-required" => "allow cloud AI",
        "cloud-ai-premium-required" => "needs Premium",
        "listen-monthly-quota-exhausted" => "monthly listening time used up",
        "captions-monthly-quota-exhausted" => "monthly caption time used up",
        "listen-disabled" => "unavailable right now",
        _ => return None,
    })
}

/// "98 h 20 min", "12 min", "under a minute".
pub fn listen_time_label(seconds: Option<u64>) -> Option<String> {
    let seconds = seconds?;
    if seconds < 60 {
        return Some("under a minute".into());
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes} min"));
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    Some(if rest > 0 {
        format!("{hours} h {rest} min")
    } else {
        format!("{hours} h")
    })
}

/// The monthly listening allowance in one line.
pub fn listen_allowance_label(listening: &CohostListening) -> Option<String> {
    if listening.state == "blocked"
        && listening.reason_code.as_deref() == Some("listen-monthly-quota-exhausted")
    {
        return Some("Your listening time for this month is used up.".into());
    }
    if listening.remaining_seconds == Some(0) {
        return Some("No listening time left this month.".into());
    }
    let time = listen_time_label(listening.remaining_seconds)?;
    let mut chars = time.chars();
    let head = chars
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default();
    Some(format!(
        "{head}{} of listening left this month.",
        chars.as_str()
    ))
}

pub fn listening_view(listening: Option<&CohostListening>) -> Option<ListeningView> {
    let listening = listening?;
    match listening.state.as_str() {
        "starting" => Some(ListeningView {
            state: "starting",
            label: "Starting to listen".into(),
            detail: "Sidekick is starting to hear your microphone.".into(),
        }),
        "on" => {
            let heard = "Sidekick hears your microphone as text.";
            Some(ListeningView {
                state: "on",
                label: "Listening".into(),
                detail: match listen_allowance_label(listening) {
                    Some(allowance) => format!("{heard} {allowance}"),
                    None => heard.to_string(),
                },
            })
        }
        "blocked" => {
            let reason = listening
                .reason_code
                .as_deref()
                .and_then(listen_blocked_reason);
            let message = listening
                .message
                .as_deref()
                .map(str::trim)
                .filter(|message| !message.is_empty());
            Some(ListeningView {
                state: "blocked",
                label: match reason {
                    Some(reason) => format!("Not listening: {reason}"),
                    None => "Not listening".into(),
                },
                detail: message
                    .map(str::to_string)
                    .unwrap_or_else(|| "Sidekick can't hear you right now.".into()),
            })
        }
        _ => None,
    }
}

// --- Presence (`cohost-presence.ts`) ---------------------------------------

/// The one status vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceKind {
    Off,
    Starting,
    Listening,
    Reading,
    Thinking,
    Paused,
    Retrying,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceView {
    pub kind: PresenceKind,
    pub label: String,
    /// `muted`, `live` or `destructive`.
    pub dot_tone: &'static str,
    pub pulse: bool,
    pub dots: bool,
    pub tooltip_lines: Vec<String>,
    pub open_count: usize,
}

/// "12s ago", "4m ago", "2h ago".
pub fn ago_label(iso: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let at = millis(iso?)?;
    let seconds = (((now.timestamp_millis() - at) as f64) / 1000.0)
        .round()
        .max(0.0) as i64;
    if seconds < 1 {
        return Some("just now".into());
    }
    if seconds < 60 {
        return Some(format!("{seconds}s ago"));
    }
    let minutes = (seconds as f64 / 60.0).round() as i64;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    Some(format!("{}h ago", (minutes as f64 / 60.0).round() as i64))
}

/// "~7s", "~2m", "any moment".
pub fn next_pass_label(iso: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let at = millis(iso?)?;
    let seconds = (((at - now.timestamp_millis()) as f64) / 1000.0).round() as i64;
    if seconds <= 0 {
        return Some("any moment".into());
    }
    if seconds < 60 {
        return Some(format!("~{seconds}s"));
    }
    Some(format!("~{}m", (seconds as f64 / 60.0).round() as i64))
}

fn presence_kind(state: Option<&CohostState>, starting: bool) -> PresenceKind {
    let Some(state) = state.filter(|state| state.status != "off") else {
        return if starting {
            PresenceKind::Starting
        } else {
            PresenceKind::Off
        };
    };
    match state.status.as_str() {
        "error" if state.retry_at.is_some() => PresenceKind::Retrying,
        "error" => PresenceKind::Error,
        "paused" => PresenceKind::Paused,
        _ if state.tick_in_flight => PresenceKind::Thinking,
        _ if state.pending_messages > 0 => PresenceKind::Reading,
        _ => PresenceKind::Listening,
    }
}

fn presence_label(kind: PresenceKind, state: Option<&CohostState>, open: usize) -> String {
    let reason = state.and_then(|state| state.reason.as_deref());
    match kind {
        PresenceKind::Off => "Off".into(),
        PresenceKind::Starting => "Starting…".into(),
        PresenceKind::Reading => format!(
            "Reading {} new…",
            state.map_or(0, |state| state.pending_messages)
        ),
        PresenceKind::Thinking => "Thinking…".into(),
        PresenceKind::Listening if open > 0 => plural(open as i64, "question", "questions"),
        PresenceKind::Listening => "Reading chat".into(),
        PresenceKind::Paused => match reason_label(reason) {
            Some(reason) => format!("Paused: {reason}"),
            None => "Paused".into(),
        },
        PresenceKind::Retrying => match retry_reason_label(reason) {
            Some(reason) => format!("Retrying: {reason}"),
            None => "Retrying".into(),
        },
        PresenceKind::Error => match reason_label(reason) {
            Some(reason) => format!("Stopped: {reason}"),
            None => "Stopped".into(),
        },
    }
}

fn presence_tooltip(
    kind: PresenceKind,
    state: Option<&CohostState>,
    open: usize,
    now: DateTime<Utc>,
) -> Vec<String> {
    let mut lines = Vec::new();
    if kind == PresenceKind::Off {
        lines.push(
            "Sidekick is off. It reads live chat, groups questions and drafts replies.".into(),
        );
    }
    if kind == PresenceKind::Starting {
        lines.push("Sidekick is starting. Waiting for the first pass.".into());
    }
    if let Some(last) = ago_label(state.and_then(|state| state.last_tick_at.as_deref()), now) {
        lines.push(format!("last pass {last}"));
    }
    let seen = state.map_or(0, |state| state.messages_seen);
    if seen > 0 {
        lines.push(format!(
            "{} read",
            plural(seen as i64, "message", "messages")
        ));
    }
    let total = state.map_or(0, |state| state.questions_total);
    if total > 0 {
        lines.push(format!(
            "{} found ({open} open)",
            plural(total as i64, "question", "questions")
        ));
    } else if open > 0 {
        lines.push(format!(
            "{} open",
            plural(open as i64, "question", "questions")
        ));
    }
    if let Some(next) = next_pass_label(state.and_then(|state| state.next_tick_at.as_deref()), now)
    {
        lines.push(format!("next pass in {next}"));
    }
    if kind == PresenceKind::Retrying
        && let Some(next) = next_pass_label(state.and_then(|state| state.retry_at.as_deref()), now)
    {
        lines.push(format!("next try in {next}"));
    }
    if state.is_some_and(|state| state.partial) {
        lines.push("Chat outran one AI pass; the newest messages were used.".into());
    }
    if let Some(listening) = listening_view(state.and_then(|state| state.listening.as_ref())) {
        lines.push(listening.detail);
    }
    if matches!(
        kind,
        PresenceKind::Error | PresenceKind::Retrying | PresenceKind::Paused
    ) && let Some(detail) = error_detail_text(state.and_then(|state| state.detail.as_ref()))
    {
        lines.push(detail);
    }
    lines
}

/// `cohostPresenceView`.
pub fn presence_view(
    state: Option<&CohostState>,
    now: DateTime<Utc>,
    starting: bool,
) -> PresenceView {
    let kind = presence_kind(state, starting);
    let open = state.map_or(0, |state| state.questions.len());
    PresenceView {
        kind,
        label: presence_label(kind, state, open),
        dot_tone: match kind {
            PresenceKind::Error => "destructive",
            PresenceKind::Listening | PresenceKind::Reading | PresenceKind::Thinking => "live",
            _ => "muted",
        },
        pulse: matches!(
            kind,
            PresenceKind::Starting | PresenceKind::Thinking | PresenceKind::Retrying
        ),
        dots: matches!(kind, PresenceKind::Reading | PresenceKind::Thinking),
        tooltip_lines: presence_tooltip(kind, state, open, now),
        open_count: open,
    }
}

/// The pane's empty-state words, following what the engine does now.
pub fn empty_state_copy(view: &PresenceView, state: Option<&CohostState>) -> String {
    match view.kind {
        PresenceKind::Reading => format!(
            "Reading {}…",
            plural(
                state.map_or(0, |state| state.pending_messages) as i64,
                "new message",
                "new messages"
            )
        ),
        PresenceKind::Thinking => "Thinking about the last batch…".into(),
        PresenceKind::Listening => "Reading chat. Questions will appear here.".into(),
        PresenceKind::Starting => "Starting. Questions from chat will appear here.".into(),
        PresenceKind::Retrying => {
            "Videorc AI didn't answer. Sidekick is trying again; questions will appear here.".into()
        }
        _ => "Questions from chat will appear here once Sidekick is reading chat again.".into(),
    }
}

/// "grouped 2 questions", shown for 2 s after a newer pass added some.
pub fn grouped_delta_flash(previous: Option<&CohostState>, next: &CohostState) -> Option<String> {
    let previous = previous?;
    if previous.session_id != next.session_id || next.tick_seq <= previous.tick_seq {
        return None;
    }
    let added = next
        .questions
        .iter()
        .filter(|question| {
            !previous
                .questions
                .iter()
                .any(|known| known.id == question.id)
        })
        .count();
    (added > 0).then(|| format!("grouped {}", plural(added as i64, "question", "questions")))
}

/// The Sidekick tab's dot: viewers reporting a problem outrank a healthy green.
pub fn tab_tone(state: Option<&CohostState>, alerts: usize) -> &'static str {
    if alerts > 0 {
        return "warn";
    }
    match state.map(|state| state.status.as_str()) {
        Some("listening") => "good",
        Some("paused") => "warn",
        Some("error") => "error",
        _ => "neutral",
    }
}

/// The Sidekick tab's dot in words, for a screen reader (`cohostDotLabel`,
/// `components/stream-manager/stream-manager.tsx`).
pub fn tab_dot_label(state: Option<&CohostState>) -> &'static str {
    match state.map(|state| state.status.as_str()) {
        Some("listening") => "Sidekick is listening",
        Some("paused") => "Sidekick is paused",
        Some("error") => "Sidekick has a problem",
        _ => "",
    }
}

// --- Marks on chat rows (`cohost-marks.ts`) ---------------------------------

/// The unexpired spotlight.
pub fn active_spotlight(state: &CohostState, now: DateTime<Utc>) -> Option<&CohostSpotlight> {
    if state.status == "off" {
        return None;
    }
    let spotlight = state.spotlight.as_ref()?;
    millis(&spotlight.expires_at)
        .is_some_and(|expires| expires > now.timestamp_millis())
        .then_some(spotlight)
}

/// What the message list needs from `cohost.state`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommentMarks {
    pub flags: Vec<(String, CohostFlag)>,
    pub suggested: Vec<String>,
    pub spotlight: Option<String>,
}

impl CommentMarks {
    pub fn flag(&self, message_id: &str) -> Option<&CohostFlag> {
        self.flags
            .iter()
            .find(|(id, _)| id == message_id)
            .map(|(_, flag)| flag)
    }
}

pub fn comment_marks(state: &CohostState, now: DateTime<Utc>) -> CommentMarks {
    if state.status == "off" {
        return CommentMarks::default();
    }
    let flags: Vec<(String, CohostFlag)> = state
        .flags
        .iter()
        .map(|flag| (flag.message_id.clone(), flag.clone()))
        .collect();
    let flagged = |id: &str| flags.iter().any(|(flag, _)| flag == id);
    let suggested = state
        .highlights
        .iter()
        .map(|highlight| highlight.message_id.clone())
        .filter(|id| !flagged(id))
        .collect();
    let spotlight = active_spotlight(state, now)
        .map(|spotlight| spotlight.message_id.clone())
        .filter(|id| !flagged(id));
    CommentMarks {
        flags,
        suggested,
        spotlight,
    }
}

/// The chat row's mark (`CohostMarks`, `components/comment-row.tsx`): a flag
/// outranks Talking about this, which outranks Suggested.
pub fn row_mark(marks: &CommentMarks, message_id: &str) -> Option<super::rows::RowMark> {
    if let Some(flag) = marks.flag(message_id) {
        return Some(super::rows::RowMark {
            kind: "flag",
            text: flag_chip_label(flag),
            high: flag.severity == "high",
            action: flag_action_label(flag).unwrap_or_default().to_string(),
            hint: flag_detail(flag),
        });
    }
    if marks.spotlight.as_deref() == Some(message_id) {
        return Some(super::rows::RowMark {
            kind: "spotlight",
            text: "Talking about this".into(),
            hint: "Sidekick heard you talking about this message".into(),
            ..super::rows::RowMark::default()
        });
    }
    marks
        .suggested
        .iter()
        .any(|id| id == message_id)
        .then(|| super::rows::RowMark {
            kind: "suggested",
            text: "Suggested".into(),
            hint: "Sidekick suggests showing this message on the stream".into(),
            ..super::rows::RowMark::default()
        })
}

/// The messages behind Sidekick's open questions (the Questions filter).
pub fn question_message_ids(state: &CohostState) -> Vec<String> {
    state
        .questions
        .iter()
        .flat_map(|question| question.message_ids.iter().cloned())
        .collect()
}

// --- Sidekick's and the avatar's words (`buddy-auto-chat-view.ts`) --------

/// `DEFAULT_AVATAR_NAME` (`shared/avatar-name.ts`): the default avatar's name,
/// and the name any surface falls back to when a persona has none.
pub const DEFAULT_AVATAR_NAME: &str = "Flint";

/// `buddyDisplayName`: the streamer's name for the avatar, else
/// [`DEFAULT_AVATAR_NAME`].
pub fn display_name(name: Option<&str>) -> String {
    name.map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(DEFAULT_AVATAR_NAME)
        .to_string()
}

/// `BUDDY_POSTS_PROMISE`. Also `buddy::copy::POSTS_PROMISE` on the Sidekick
/// page's branch; kept here until the two meet.
pub const POSTS_PROMISE: &str = "Sidekick never posts in your chat on its own.";

/// The full sentence behind the action bar's hint (`COHOST_ACTS_ON_ASK_COPY`).
pub fn acts_on_ask_copy() -> String {
    format!("{POSTS_PROMISE} It removes a comment only when you tell it to.")
}

pub const ACTS_ON_ASK_HINT: &str = "Never posts on its own.";

/// The flag row's Remove from chat key.
pub const REMOVE_FLAGGED_KEY: &str = "Shift+Backspace";

pub const TALK_MODES: [CohostTalkMode; 3] = [
    CohostTalkMode::Off,
    CohostTalkMode::Bubble,
    CohostTalkMode::Suggest,
];

pub fn talk_mode_label(talk: CohostTalkMode) -> &'static str {
    match talk {
        CohostTalkMode::Off => "Off",
        CohostTalkMode::Bubble => "Bubble",
        CohostTalkMode::Suggest => "Suggest",
    }
}

/// "Grum talks".
pub fn talk_label(name: Option<&str>) -> String {
    format!("{} talks", display_name(name))
}

/// What each talk mode does, in words.
pub fn talk_hint(talk: CohostTalkMode, name: Option<&str>) -> String {
    let who = display_name(name);
    match talk {
        CohostTalkMode::Off => format!("{who} says nothing on its own."),
        CohostTalkMode::Bubble => format!(
            "{who} says greetings and Sidekick's lines in its bubble on stream. Nothing goes to chat."
        ),
        CohostTalkMode::Suggest => format!(
            "Each line is a card here; one click posts it to chat as you, and {who} says it on stream."
        ),
    }
}

/// Each behaviour's one home (`BUDDY_BEHAVIOUR_HOMES`): the greeting lines
/// are the avatar's, Answers and Banter are Sidekick's writing.
pub fn behaviour_home(id: &str) -> &'static str {
    match id {
        "greetings" => "Avatar → Greetings",
        _ => "Sidekick → Chat",
    }
}

/// A read-only behaviour chip: its words, and its name for a screen reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BehaviourChip {
    pub id: &'static str,
    pub on: bool,
    pub text: String,
    pub name: String,
}

pub fn behaviour_chips(auto_chat: &CohostAutoChat, ai_greetings: bool) -> Vec<BehaviourChip> {
    [
        ("greetings", "Greetings", auto_chat.greetings.enabled),
        ("answers", "Answers", auto_chat.answers.enabled),
        ("banter", "Banter", auto_chat.banter.enabled),
    ]
    .into_iter()
    .map(|(id, label, on)| {
        let ai = id == "greetings" && on && ai_greetings && auto_chat.greetings.ai;
        let text = format!(
            "{label} {}{}",
            if on { "on" } else { "off" },
            if ai { " · AI" } else { "" }
        );
        BehaviourChip {
            id,
            on,
            name: format!("{text}. Change it in {}.", behaviour_home(id)),
            text,
        }
    })
    .collect()
}

/// "Let Grum post as you?"
pub fn posting_consent_title(name: Option<&str>) -> String {
    format!("Let {} post as you?", display_name(name))
}

pub fn posting_consent_sentence(name: Option<&str>) -> String {
    format!(
        "{} posts to your chats as you, on the platforms you stream to, only when you click its card. You can read every message later in Sidekick → Reports.",
        display_name(name)
    )
}

/// Suggest asks first, once.
pub fn mode_change_needs_consent(next: CohostTalkMode, consented: bool) -> bool {
    next == CohostTalkMode::Suggest && !consented
}

pub fn utterance_trigger_label(kind: &str) -> &'static str {
    match kind {
        "greeting" => "Greeting",
        "answer" => "Answer",
        "banter" => "Banter",
        "community" => "Community",
        _ => "Say",
    }
}

// --- The Say footer --------------------------------------------------------

/// On air with the avatar on no output while it would talk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputNotice {
    pub title: String,
    pub detail: String,
    pub action: String,
    /// The other way out (plan 239 D3), only while Sidekick writes in
    /// Bubble: "Use Suggest", through the talk control's own consent.
    pub secondary_action: Option<String>,
}

/// `buddyOffOutputsNotice`: the notice to show, or none while it would say
/// nothing (Sidekick Live off and not on Bubble), nothing is on air, the
/// relay has no avatar yet, or an output already carries it. In Bubble the
/// detail says the cost; while Sidekick also writes lines on its own
/// (`sidekick_writes`, plan 239 D3) it offers Suggest as the second way out.
pub fn off_outputs_notice(
    enabled: bool,
    talk: CohostTalkMode,
    on_air: bool,
    show_on_stream: Option<bool>,
    show_in_recording: bool,
    name: Option<&str>,
    sidekick_writes: bool,
) -> Option<OutputNotice> {
    let bubble = talk == CohostTalkMode::Bubble;
    if !(enabled || bubble) || !on_air {
        return None;
    }
    let show_on_stream = show_on_stream?;
    if show_on_stream || show_in_recording {
        return None;
    }
    let name = display_name(name);
    if bubble && enabled && sidekick_writes {
        return Some(OutputNotice {
            title: format!("{name} isn't on stream."),
            detail: "Viewers can't see its bubble, so Sidekick's lines have nowhere to show. Show it, or use Suggest to post them as cards.".into(),
            action: "Show on stream".into(),
            secondary_action: Some("Use Suggest".into()),
        });
    }
    Some(OutputNotice {
        title: format!("{name} isn't on stream."),
        detail: if bubble {
            "Viewers can't see its bubble, so Bubble says nothing.".into()
        } else {
            "Viewers can't see it, its bubbles or its reactions.".into()
        },
        action: "Show on stream".into(),
        secondary_action: None,
    })
}

/// `sidekickWritesLines` (plan 239 D3): Sidekick writes lines on its own
/// while Answers, Banter, or greetings written with AI is on. The greeting
/// lines alone (`greetings_ai` false) are the avatar's.
pub fn sidekick_writes_lines(
    answers: bool,
    banter: bool,
    greetings: bool,
    greetings_ai: Option<bool>,
) -> bool {
    answers || banter || (greetings && greetings_ai != Some(false))
}

/// The reaction chips the footer offers (`BUDDY_REACTION_CHIPS`).
pub const REACTION_CHIPS: [(&str, &str); 4] = [
    ("laugh", "Laugh"),
    ("wave", "Wave"),
    ("surprised", "Surprised"),
    ("proud", "Proud"),
];

/// Why a reaction chip is off (`buddyReactionDisabledReason`,
/// `lib/buddy-pet-view.ts`), or `None` while it plays. `pack` is the worn pack's reactions, `None` until known.
pub fn reaction_disabled_reason(
    relay: bool,
    alive: bool,
    pack: Option<&[String]>,
    chip: (&str, &str),
) -> Option<String> {
    if !relay || pack.is_some_and(|pack| pack.iter().any(|id| id == chip.0)) {
        return None;
    }
    if !alive {
        return Some("Only an Alive avatar reacts. Make it Alive on the Avatar page.".into());
    }
    let Some(_) = pack else {
        return Some("Reactions aren't ready yet.".into());
    };
    Some(format!(
        "This avatar has no {} reaction.",
        chip.1.to_lowercase()
    ))
}

// --- The proposed posts ------------------------------------------------------

/// `openProposedUtterances`: proposed and not expired.
pub fn open_proposed(utterances: &[CohostUtterance], now: DateTime<Utc>) -> Vec<CohostUtterance> {
    utterances
        .iter()
        .filter(|utterance| {
            utterance.status == "proposed"
                && utterance
                    .expires_at
                    .as_deref()
                    .is_none_or(|at| millis(at).is_some_and(|at| at > now.timestamp_millis()))
        })
        .cloned()
        .collect()
}

/// The last four said or tried, newest first.
pub fn recent_utterances(utterances: &[CohostUtterance]) -> Vec<CohostUtterance> {
    let said: Vec<&CohostUtterance> = utterances
        .iter()
        .filter(|utterance| utterance.status != "proposed" && utterance.status != "dismissed")
        .collect();
    said.iter()
        .skip(said.len().saturating_sub(4))
        .rev()
        .map(|utterance| (*utterance).clone())
        .collect()
}

/// "Posted", "Failed", "On stream".
pub fn utterance_status_label(status: &str) -> &'static str {
    match status {
        "sent" => "Posted",
        "failed" => "Failed",
        "bubble-only" => "On stream",
        _ => "",
    }
}

/// " · to YouTube and Twitch": where a proposed post goes.
pub fn utterance_destinations_line(
    utterance: &CohostUtterance,
    destinations: &[(String, String)],
) -> String {
    let picked: Vec<&(String, String)> = if utterance.destination_ids.is_empty() {
        destinations.iter().collect()
    } else {
        destinations
            .iter()
            .filter(|(id, _)| utterance.destination_ids.contains(id))
            .collect()
    };
    let mut labels: Vec<&'static str> = Vec::new();
    for (_, platform) in picked {
        let label = crate::chat::view::platform_label(platform);
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    match labels.as_slice() {
        [] => String::new(),
        [one] => format!(" · to {one}"),
        [rest @ .., last] => format!(" · to {} and {last}", rest.join(", ")),
    }
}

/// The card's title: "Greeting · posts as you · to YouTube".
pub fn utterance_title(utterance: &CohostUtterance, destinations: &[(String, String)]) -> String {
    format!(
        "{} · posts as you{}",
        utterance_trigger_label(&utterance.trigger.kind),
        utterance_destinations_line(utterance, destinations)
    )
}

/// "12s".
pub fn seconds_left(expires_at: &str, now: DateTime<Utc>) -> String {
    let left = millis(expires_at).map_or(0, |at| {
        (((at - now.timestamp_millis()) as f64) / 1000.0)
            .ceil()
            .max(0.0) as i64
    });
    format!("{left}s")
}

// --- Voice commands (`buddy-command-view.ts`) -------------------------------

pub const COMMAND_STRIP_VISIBLE_MS: i64 = 6_000;
pub const COMMAND_STRIP_FADE_MS: i64 = 1_000;

/// What Sidekick heard, and what it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandStrip {
    pub command_id: String,
    pub heard: String,
    pub message: String,
    pub quiet: bool,
    pub fading: bool,
}

fn command_open(status: &str) -> bool {
    matches!(status, "ambiguous" | "confirm")
}

pub fn command_strip(command: Option<&CohostCommand>, now: DateTime<Utc>) -> Option<CommandStrip> {
    let command = command?;
    let heard = command.heard.trim();
    let message = command.message.trim();
    if heard.is_empty() && message.is_empty() {
        return None;
    }
    let mut fading = false;
    if !command_open(&command.status) {
        let at = millis(&command.at)?;
        let age = now.timestamp_millis() - at;
        if age.abs() >= COMMAND_STRIP_VISIBLE_MS {
            return None;
        }
        fading = age >= COMMAND_STRIP_VISIBLE_MS - COMMAND_STRIP_FADE_MS;
    }
    Some(CommandStrip {
        command_id: command.id.clone(),
        heard: if heard.is_empty() {
            String::new()
        } else {
            format!("Heard: “{heard}”")
        },
        message: message.to_string(),
        quiet: matches!(
            command.status.as_str(),
            "not-found" | "refused" | "unavailable"
        ),
        fading,
    })
}

fn timer_label(expires_at: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let left = seconds_until(expires_at, now)?;
    Some(if left > 0 {
        format!("Expires in {left}s")
    } else {
        "Expiring…".into()
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCandidate {
    pub index: usize,
    pub key: String,
    pub author_name: String,
    pub platform: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandChooser {
    pub command_id: String,
    pub title: String,
    pub candidates: Vec<CommandCandidate>,
    pub timer: Option<String>,
}

pub const COMMAND_CHOOSER_TITLE: &str = "Which comment?";

pub fn command_chooser(
    command: Option<&CohostCommand>,
    now: DateTime<Utc>,
) -> Option<CommandChooser> {
    let command = command.filter(|command| command.status == "ambiguous")?;
    let candidates: Vec<CommandCandidate> = command
        .candidates
        .iter()
        .take(3)
        .enumerate()
        .map(|(index, candidate)| CommandCandidate {
            index,
            key: (index + 1).to_string(),
            author_name: candidate.author_name.clone(),
            platform: candidate.platform.clone(),
            excerpt: candidate.excerpt.trim().to_string(),
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let title = command.message.trim();
    Some(CommandChooser {
        command_id: command.id.clone(),
        title: if title.is_empty() {
            COMMAND_CHOOSER_TITLE.to_string()
        } else {
            title.to_string()
        },
        candidates,
        timer: timer_label(command.expires_at.as_deref(), now),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandConfirm {
    pub command_id: String,
    /// `highlight` or `act`.
    pub kind: String,
    pub title: String,
    pub target: Option<CohostCommandTarget>,
    pub timer: Option<String>,
    pub busy: bool,
}

pub fn command_confirm(
    command: Option<&CohostCommand>,
    now: DateTime<Utc>,
    answering: bool,
) -> Option<CommandConfirm> {
    let command = command.filter(|command| command.status == "confirm")?;
    // `remember` (plan 225: "remember that…" asks before it saves) joins the
    // highlight and act cards.
    if !matches!(command.kind.as_str(), "highlight" | "act" | "remember") {
        return None;
    }
    if command.operation_id.is_some() {
        return None;
    }
    Some(CommandConfirm {
        command_id: command.id.clone(),
        kind: command.kind.clone(),
        title: command.message.trim().to_string(),
        target: command.target.clone(),
        timer: timer_label(command.expires_at.as_deref(), now),
        busy: answering || command.expires_at.is_none(),
    })
}

/// The open card's command, when one asks.
pub fn open_command_card_id(command: Option<&CohostCommand>, now: DateTime<Utc>) -> Option<String> {
    (command_chooser(command, now).is_some() || command_confirm(command, now, false).is_some())
        .then(|| command.map(|command| command.id.clone()))
        .flatten()
}

pub const VOICE_COMMANDS_PAUSED: &str = "Voice commands are paused by Videorc.";
pub const REMOVING_MESSAGES_PAUSED: &str = "Removing messages is paused by Videorc.";

/// The kill switches, in words.
pub fn command_availability_lines(
    availability: Option<&CohostCommandAvailability>,
) -> Vec<&'static str> {
    let Some(availability) = availability else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    if availability.voice_commands == "paused" {
        lines.push(VOICE_COMMANDS_PAUSED);
    }
    if availability.remove == "paused" {
        lines.push(REMOVING_MESSAGES_PAUSED);
    }
    lines
}

// --- The cards' announcements -----------------------------------------------

/// What a card says when it arrives, for a screen reader (`cardNotices`,
/// `components/stream-manager/stream-manager.tsx`).
pub fn command_card_label(chooser: bool) -> &'static str {
    if chooser {
        "Sidekick asks which comment you meant"
    } else {
        "Sidekick asks whether to show a flagged comment"
    }
}

pub fn removal_card_label(author: &str, timer: Option<&str>) -> String {
    let timer = timer.map(|timer| format!(", {timer}")).unwrap_or_default();
    format!("Sidekick asks before removing {author}'s message{timer}")
}

pub fn utterance_card_label(name: Option<&str>) -> String {
    format!("{} wants to post, it expires soon", display_name(name))
}

/// "2 waiting".
pub fn cards_waiting(count: usize) -> Option<String> {
    (count > 1).then(|| format!("{count} waiting"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Electron's plan 239 D3 case: Bubble, Sidekick Live on, and Sidekick
    /// writing lines: the notice offers Suggest too.
    #[test]
    fn a_hidden_bubble_while_sidekick_writes_offers_suggest() {
        let notice = off_outputs_notice(
            true,
            CohostTalkMode::Bubble,
            true,
            Some(false),
            false,
            None,
            true,
        )
        .unwrap();
        assert_eq!(notice.title, "Flint isn't on stream.");
        assert!(
            notice
                .detail
                .starts_with("Viewers can't see its bubble, so Sidekick's lines")
        );
        assert_eq!(notice.secondary_action.as_deref(), Some("Use Suggest"));
        let quiet = off_outputs_notice(
            true,
            CohostTalkMode::Bubble,
            true,
            Some(false),
            false,
            None,
            false,
        )
        .unwrap();
        assert_eq!(quiet.secondary_action, None);
        assert!(sidekick_writes_lines(false, false, true, None));
        assert!(!sidekick_writes_lines(false, false, true, Some(false)));
        assert!(!sidekick_writes_lines(false, false, false, None));
        let source =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-output-notice.ts");
        assert!(source.contains("Viewers can't see its bubble, so Sidekick's lines have nowhere to show. Show it, or use Suggest to post them as cards."));
        assert!(source.contains("secondaryAction: 'Use Suggest'"));
    }
    use serde_json::json;

    fn at(iso: &str) -> DateTime<Utc> {
        parse(iso).expect("a time")
    }

    fn question(id: &str, priority: &str, seen: &str) -> CohostQuestion {
        CohostQuestion {
            id: id.into(),
            text: format!("question {id}"),
            message_ids: vec![format!("m-{id}")],
            askers: vec!["Ada".into()],
            platforms: vec!["youtube".into()],
            priority: priority.into(),
            suggested_reply: "A Shure SM7B.".into(),
            first_seen_at: seen.into(),
            updated_at: seen.into(),
            ..CohostQuestion::default()
        }
    }

    #[test]
    fn a_state_reads_from_the_wire_and_an_older_tick_never_wins() {
        let state: CohostState = serde_json::from_value(json!({
            "sessionId": "s1",
            "status": "listening",
            "questions": [{"id": "q1", "text": "Which mic?", "messageIds": ["m1"],
                "askers": ["Ada", "Bo", "Cy"], "platforms": ["youtube"], "priority": "high",
                "suggestedReply": "A Shure.", "fromNotes": false,
                "firstSeenAt": "2026-11-11T10:00:00Z", "updatedAt": "2026-11-11T10:00:00Z"}],
            "flags": [], "mood": "hype", "lastTickAt": null, "tickSeq": 4, "partial": true,
            "somethingNew": {"ignored": true}
        }))
        .expect("reads");
        assert_eq!(state.questions[0].askers.len(), 3);
        assert_eq!(askers_label(&state.questions[0].askers), "Ada +2");
        let older = CohostState {
            tick_seq: 3,
            ..state.clone()
        };
        assert_eq!(apply_cohost_state(Some(&state), older), state);
        let other = CohostState {
            session_id: Some("s2".into()),
            tick_seq: 0,
            ..CohostState::default()
        };
        assert_eq!(apply_cohost_state(Some(&state), other.clone()), other);
    }

    #[test]
    fn questions_sort_by_priority_topic_then_age_and_rows_follow() {
        let mut low = question("a", "low", "2026-11-11T10:00:00Z");
        low.on_topic = true;
        let high = question("b", "high", "2026-11-11T10:05:00Z");
        let mut on_topic = question("c", "normal", "2026-11-11T10:09:00Z");
        on_topic.on_topic = true;
        let normal = question("d", "normal", "2026-11-11T10:01:00Z");
        let state = CohostState {
            status: "listening".into(),
            questions: vec![low, high, on_topic, normal],
            flags: vec![CohostFlag {
                message_id: "x".into(),
                at: "2026-11-11T10:00:00Z".into(),
                ..CohostFlag::default()
            }],
            ..CohostState::default()
        };
        let keys: Vec<String> = pane_rows(&state).into_iter().map(|row| row.key).collect();
        assert_eq!(keys, ["q:b", "q:c", "q:d", "q:a", "f:x"]);
        let rows = pane_rows(&state);
        assert_eq!(
            resolve_selection(&rows, Some("gone")).as_deref(),
            Some("q:b")
        );
        assert_eq!(
            move_selection(&rows, Some("f:x"), 1).as_deref(),
            Some("f:x")
        );
        assert_eq!(move_selection(&rows, None, 2).as_deref(), Some("q:d"));
    }

    #[test]
    fn the_pane_mode_checks_premium_then_consent_then_the_switch() {
        let locked = PaneGate {
            allowed: false,
            reason: "Sidekick is a Premium feature.",
            upgrade_url: Some("https://videorc.com/premium"),
        };
        assert!(matches!(
            pane_mode(locked, true, true),
            PaneMode::Upsell { .. }
        ));
        let open = PaneGate {
            allowed: true,
            reason: "",
            upgrade_url: None,
        };
        assert_eq!(pane_mode(open, false, true), PaneMode::Consent);
        assert_eq!(pane_mode(open, true, false), PaneMode::Disabled);
        assert_eq!(pane_mode(open, true, true), PaneMode::Live);
    }

    #[test]
    fn presence_says_the_one_vocabulary() {
        let now = at("2026-11-11T10:00:30Z");
        assert_eq!(presence_view(None, now, false).label, "Off");
        assert_eq!(presence_view(None, now, true).label, "Starting…");
        let reading = CohostState {
            status: "listening".into(),
            pending_messages: 3,
            ..CohostState::default()
        };
        let view = presence_view(Some(&reading), now, false);
        assert_eq!(view.label, "Reading 3 new…");
        assert!(view.dots);
        assert_eq!(
            empty_state_copy(&view, Some(&reading)),
            "Reading 3 new messages…"
        );
        let retrying = CohostState {
            status: "error".into(),
            reason: Some("gateway-error".into()),
            retry_at: Some("2026-11-11T10:00:37Z".into()),
            detail: Some(CohostErrorDetail {
                code: "upstream_timeout".into(),
                message: "The model took too long.".into(),
                status: Some(504),
            }),
            ..CohostState::default()
        };
        let view = presence_view(Some(&retrying), now, false);
        assert_eq!(view.label, "Retrying: Videorc AI didn't answer");
        assert!(view.tooltip_lines.contains(&"next try in ~7s".to_string()));
        assert!(
            view.tooltip_lines
                .contains(&"upstream_timeout (HTTP 504): The model took too long.".to_string())
        );
        let listening = CohostState {
            status: "listening".into(),
            questions: vec![question("a", "high", "2026-11-11T10:00:00Z")],
            ..CohostState::default()
        };
        assert_eq!(
            presence_view(Some(&listening), now, false).label,
            "1 question"
        );
    }

    #[test]
    fn flags_alerts_and_promises_say_their_words() {
        let flag = CohostFlag {
            kind: "rule".into(),
            rule: Some("No spoilers".into()),
            target: Some("streamer".into()),
            action: Some("ban".into()),
            reason: "Spoils the ending".into(),
            also_kinds: vec!["spoiler".into(), "made-up".into()],
            ..CohostFlag::default()
        };
        assert_eq!(flag_chip_label(&flag), "Chat rule · No spoilers · at you");
        assert_eq!(flag_action_label(&flag), Some("Suggests removing"));
        assert_eq!(
            flag_detail(&flag),
            "Spoils the ending\nAlso: Spoiler, Flagged"
        );
        assert_eq!(
            alert_label(&CohostAlert {
                kind: "audio".into(),
                viewers: 3,
                ..CohostAlert::default()
            }),
            "Chat says: no audio · 3 viewers"
        );
        assert_eq!(
            promise_trigger_label(&CohostPromiseTrigger {
                kind: "viewers".into(),
                value: Some(100.0)
            })
            .as_deref(),
            Some("at 100 viewers")
        );
        assert_eq!(
            listen_disclosure(),
            "Your microphone audio goes to Videorc's cloud speech-to-text and comes back as text. Videorc servers don't keep it. The transcript is saved with your recording on this computer."
        );
    }

    #[test]
    fn the_question_toast_waits_for_a_hidden_pane_and_a_new_high_question() {
        let now = at("2026-11-11T10:00:00Z");
        let previous = CohostState {
            session_id: Some("s".into()),
            status: "listening".into(),
            ..CohostState::default()
        };
        let mut high = question("a", "high", "2026-11-11T09:59:00Z");
        high.askers = vec!["Ada".into(), "Bo".into()];
        high.text = "What keyboard is that?".into();
        let next = CohostState {
            questions: vec![high],
            ..previous.clone()
        };
        assert_eq!(
            question_toast(Some(&previous), &next, true, None, now, "⌘J"),
            None
        );
        assert_eq!(
            question_toast(Some(&previous), &next, false, None, now, "⌘J").as_deref(),
            Some("Sidekick: 2 people asking: What keyboard is that? · ⌘J")
        );
        assert_eq!(
            question_toast(
                Some(&previous),
                &next,
                false,
                Some(now.timestamp_millis() - 10_000),
                now,
                "⌘J"
            ),
            None
        );
    }

    #[test]
    fn the_talk_controls_and_chips_say_what_sidekick_and_the_avatar_do() {
        let auto: CohostAutoChat = serde_json::from_value(json!({
            "talk": "bubble",
            "mode": "off",
            "greetings": {"enabled": true, "templates": [], "ai": true},
            "answers": {"enabled": true, "cooldownSeconds": 20},
            "banter": {"enabled": false, "cooldownSeconds": 240}
        }))
        .expect("reads");
        let chips = behaviour_chips(&auto, true);
        assert_eq!(chips[0].text, "Greetings on · AI");
        assert_eq!(chips[2].text, "Banter off");
        assert_eq!(
            chips[0].name,
            "Greetings on · AI. Change it in Avatar → Greetings."
        );
        assert_eq!(chips[2].name, "Banter off. Change it in Sidekick → Chat.");
        assert_eq!(
            talk_hint(CohostTalkMode::Bubble, Some("Grum")),
            "Grum says greetings and Sidekick's lines in its bubble on stream. Nothing goes to chat."
        );
        assert!(mode_change_needs_consent(CohostTalkMode::Suggest, false));
        assert!(!mode_change_needs_consent(CohostTalkMode::Off, false));
        let notice = off_outputs_notice(
            true,
            CohostTalkMode::Bubble,
            true,
            Some(false),
            false,
            None,
            false,
        )
        .expect("a notice");
        assert_eq!(notice.title, "Flint isn't on stream.");
    }

    #[test]
    fn proposed_posts_and_voice_commands_read_as_cards() {
        let now = at("2026-11-11T10:00:00Z");
        let utterance = CohostUtterance {
            id: "u1".into(),
            text: "Welcome, Ada!".into(),
            trigger: CohostUtteranceTrigger {
                kind: "greeting".into(),
            },
            status: "proposed".into(),
            expires_at: Some("2026-11-11T10:00:12Z".into()),
            ..CohostUtterance::default()
        };
        assert_eq!(
            open_proposed(std::slice::from_ref(&utterance), now).len(),
            1
        );
        let destinations = vec![
            ("d1".to_string(), "youtube".to_string()),
            ("d2".to_string(), "twitch".to_string()),
        ];
        assert_eq!(
            utterance_title(&utterance, &destinations),
            "Greeting · posts as you · to YouTube and Twitch"
        );
        assert_eq!(seconds_left("2026-11-11T10:00:12Z", now), "12s");
        let command = CohostCommand {
            id: "c1".into(),
            heard: "show the comment from ada".into(),
            kind: "highlight".into(),
            status: "ambiguous".into(),
            candidates: vec![CohostCommandTarget {
                author_name: "Ada".into(),
                platform: "youtube".into(),
                excerpt: " hi ".into(),
                ..CohostCommandTarget::default()
            }],
            at: "2026-11-11T09:59:58Z".into(),
            expires_at: Some("2026-11-11T10:00:09Z".into()),
            ..CohostCommand::default()
        };
        let chooser = command_chooser(Some(&command), now).expect("a chooser");
        assert_eq!(chooser.title, "Which comment?");
        assert_eq!(chooser.timer.as_deref(), Some("Expires in 9s"));
        assert_eq!(chooser.candidates[0].excerpt, "hi");
        let strip = command_strip(Some(&command), now).expect("a strip");
        assert_eq!(strip.heard, "Heard: “show the comment from ada”");
        assert_eq!(
            open_command_card_id(Some(&command), now).as_deref(),
            Some("c1")
        );
        // "Remember that…" asks on a card, like a highlight (Electron's
        // `commandConfirmView` takes `remember` too); an unknown kind does not.
        let remember = CohostCommand {
            kind: "remember".into(),
            status: "confirm".into(),
            message: " Remember that Ada likes ramen? ".into(),
            candidates: Vec::new(),
            ..command.clone()
        };
        let card = command_confirm(Some(&remember), now, false).expect("a card");
        assert_eq!(
            (card.kind.as_str(), card.title.as_str()),
            ("remember", "Remember that Ada likes ramen?")
        );
        let other = CohostCommand {
            kind: "dance".into(),
            ..remember
        };
        assert!(command_confirm(Some(&other), now, false).is_none());
    }

    #[test]
    fn a_seed_reads_as_the_window_state() {
        let seed = json!({
            "state": {"sessionId": null, "status": "off", "questions": [], "flags": [],
                "mood": null, "lastTickAt": null, "tickSeq": 0, "partial": false},
            "entitled": false, "entitlementReason": null, "upgradeUrl": null,
            "consented": false, "enabled": false
        });
        let state = CohostWindowState::from_json(&seed).expect("a window state");
        assert!(!state.entitled && state.listen.is_none() && state.buddy.is_none());
        assert_eq!(
            CohostWindowState::from_json(&json!({"entitled": true})),
            None
        );
    }

    // --- Electron's words, read from its sources ---------------------------

    const COHOST_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/cohost-view.ts");
    const COHOST_PRESENCE: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/cohost-presence.ts");
    const AUTO_CHAT_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts");
    const TAB_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-tab-view.ts");
    const PET_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-pet-view.ts");
    const OUTPUT_NOTICE: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-output-notice.ts");
    const COMMAND_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-command-view.ts");
    const AVATAR_NAME: &str = include_str!("../../../../apps/desktop/src/shared/avatar-name.ts");
    const STREAM_MANAGER: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx"
    );
    const UTTERANCE_CARDS: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/buddy-utterance-cards.tsx"
    );
    const COMMENT_ROW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/comment-row.tsx");
    const COHOST_PANE: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/cohost-pane.tsx");

    #[track_caller]
    fn says(file: &str, name: &str, words: &str) {
        assert!(
            file.contains(words),
            "Electron's {name} no longer says {words:?}"
        );
    }

    #[test]
    fn the_cloud_ai_words_match_electron() {
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!("\"{CHAT_CONSENT_SENTENCE}\""),
        );
        says(COHOST_VIEW, "cohost-view.ts", &format!("\"{MIC_TO_TEXT}\""));
        says(COHOST_VIEW, "cohost-view.ts", &format!("\"{MIC_KEPT}\""));
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!(
                "`{}`",
                hears_you_use().replace(MIC_TO_TEXT, "${MIC_TO_TEXT}")
            ),
        );
        let uses = cloud_ai_uses();
        assert_eq!(uses[0], CHAT_CONSENT_SENTENCE);
        assert_eq!(uses[1], hears_you_use());
        for line in &uses[2..5] {
            says(TAB_VIEW, "buddy-tab-view.ts", &format!("\"{line}\""));
        }
        says(TAB_VIEW, "buddy-tab-view.ts", &format!("\"{}\"", uses[5]));
        says(
            TAB_VIEW,
            "buddy-tab-view.ts",
            &format!("\"{CLOUD_AI_KEEPS}\""),
        );
    }

    #[test]
    fn the_listening_and_presence_words_match_electron() {
        let view = |state: &str, code: Option<&str>| {
            listening_view(Some(&CohostListening {
                state: state.into(),
                reason_code: code.map(str::to_string),
                ..CohostListening::default()
            }))
            .expect("a view")
        };
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!("'{}'", view("starting", None).detail),
        );
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!("'{}'", view("on", None).detail),
        );
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!("\"{}\"", view("blocked", None).detail),
        );
        assert_eq!(
            view("blocked", Some("service-unavailable")).label,
            "Not listening: Videorc AI is unavailable"
        );
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            "['service-unavailable', 'Videorc AI is unavailable']",
        );
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!("const speaker = '{QUESTION_TOAST_SPEAKER}'"),
        );
        let now = at("2026-11-11T10:00:00Z");
        let off = presence_view(None, now, false);
        says(
            COHOST_PRESENCE,
            "cohost-presence.ts",
            &format!("'{}'", off.tooltip_lines[0]),
        );
        says(
            COHOST_PRESENCE,
            "cohost-presence.ts",
            &format!("'{}'", empty_state_copy(&off, None)),
        );
        let starting = presence_view(None, now, true);
        says(
            COHOST_PRESENCE,
            "cohost-presence.ts",
            &format!("'{}'", starting.tooltip_lines[0]),
        );
        let retrying = CohostState {
            status: "error".into(),
            retry_at: Some("2026-11-11T10:00:07Z".into()),
            ..CohostState::default()
        };
        let view = presence_view(Some(&retrying), now, false);
        says(
            COHOST_PRESENCE,
            "cohost-presence.ts",
            &format!("\"{}\"", empty_state_copy(&view, Some(&retrying))),
        );
        for status in ["listening", "paused", "error"] {
            let state = CohostState {
                status: status.into(),
                ..CohostState::default()
            };
            says(
                STREAM_MANAGER,
                "stream-manager.tsx",
                &format!("return '{}'", tab_dot_label(Some(&state))),
            );
        }
        says(
            COHOST_PANE,
            "cohost-pane.tsx",
            &format!(
                "'{}'",
                weather(&CohostState {
                    partial: true,
                    ..CohostState::default()
                })[0]
            ),
        );
    }

    #[test]
    fn the_avatar_and_talk_words_match_electron() {
        says(
            AVATAR_NAME,
            "avatar-name.ts",
            &format!("DEFAULT_AVATAR_NAME = '{DEFAULT_AVATAR_NAME}'"),
        );
        assert_eq!(display_name(Some("  ")), "Flint");
        says(
            AUTO_CHAT_VIEW,
            "buddy-auto-chat-view.ts",
            &format!("'{POSTS_PROMISE}'"),
        );
        says(
            COHOST_VIEW,
            "cohost-view.ts",
            &format!(
                "`{}`",
                acts_on_ask_copy().replace(POSTS_PROMISE, "${BUDDY_POSTS_PROMISE}")
            ),
        );
        // Templates: the name stands in as Electron's own placeholder.
        let who = Some("${who}");
        for talk in TALK_MODES {
            says(
                AUTO_CHAT_VIEW,
                "buddy-auto-chat-view.ts",
                &format!("`{}`", talk_hint(talk, who)),
            );
        }
        for id in ["greetings", "answers", "banter"] {
            says(
                AUTO_CHAT_VIEW,
                "buddy-auto-chat-view.ts",
                &format!("{id}: '{}'", behaviour_home(id)),
            );
        }
        says(
            AUTO_CHAT_VIEW,
            "buddy-auto-chat-view.ts",
            &format!(
                "`{}`",
                posting_consent_sentence(Some("${buddyDisplayName(name)}"))
            ),
        );
        says(
            AUTO_CHAT_VIEW,
            "buddy-auto-chat-view.ts",
            "community: 'Community'",
        );
        assert_eq!(utterance_trigger_label("community"), "Community");
        says(
            STREAM_MANAGER,
            "stream-manager.tsx",
            &format!("'{}'", command_card_label(true)),
        );
        says(
            STREAM_MANAGER,
            "stream-manager.tsx",
            &format!("'{}'", command_card_label(false)),
        );
        says(
            STREAM_MANAGER,
            "stream-manager.tsx",
            &format!("`{}", removal_card_label("${card.authorName}", None)),
        );
        says(
            STREAM_MANAGER,
            "stream-manager.tsx",
            &utterance_card_label(Some("${buddyDisplayName(buddyName)}")),
        );
        let marks = CommentMarks {
            suggested: vec!["s".into()],
            spotlight: Some("t".into()),
            ..CommentMarks::default()
        };
        for id in ["s", "t"] {
            let mark = row_mark(&marks, id).expect("a mark");
            says(
                COMMENT_ROW,
                "comment-row.tsx",
                &format!("hint=\"{}\"", mark.hint),
            );
        }
    }

    #[test]
    fn the_reaction_and_notice_words_match_electron() {
        for (id, label) in REACTION_CHIPS {
            says(
                PET_VIEW,
                "buddy-pet-view.ts",
                &format!("{{ id: '{id}', label: '{label}' }}"),
            );
        }
        let pack = vec!["wave".to_string()];
        let still = reaction_disabled_reason(true, false, Some(&pack), REACTION_CHIPS[0])
            .expect("a reason");
        says(PET_VIEW, "buddy-pet-view.ts", &format!("'{still}'"));
        let loading =
            reaction_disabled_reason(true, true, None, REACTION_CHIPS[0]).expect("a reason");
        says(PET_VIEW, "buddy-pet-view.ts", &format!("\"{loading}\""));
        let missing =
            reaction_disabled_reason(true, true, Some(&pack), REACTION_CHIPS[0]).expect("a reason");
        assert_eq!(missing, "This avatar has no laugh reaction.");
        says(
            PET_VIEW,
            "buddy-pet-view.ts",
            "`This avatar has no ${chip.label.toLowerCase()} reaction.`",
        );
        let notice = |talk| {
            off_outputs_notice(true, talk, true, Some(false), false, Some("${name}"), false)
                .expect("a notice")
        };
        let bubble = notice(CohostTalkMode::Bubble);
        says(
            OUTPUT_NOTICE,
            "buddy-output-notice.ts",
            &format!("`{}`", bubble.title),
        );
        says(
            OUTPUT_NOTICE,
            "buddy-output-notice.ts",
            &format!("\"{}\"", bubble.detail),
        );
        says(
            OUTPUT_NOTICE,
            "buddy-output-notice.ts",
            &format!("'{}'", bubble.action),
        );
        let off = notice(CohostTalkMode::Off);
        says(
            OUTPUT_NOTICE,
            "buddy-output-notice.ts",
            &format!("\"{}\"", off.detail),
        );
        says(
            COMMAND_VIEW,
            "buddy-command-view.ts",
            &format!("'{VOICE_COMMANDS_PAUSED}'"),
        );
        says(
            COMMAND_VIEW,
            "buddy-command-view.ts",
            &format!("'{REMOVING_MESSAGES_PAUSED}'"),
        );
        says(
            COMMAND_VIEW,
            "buddy-command-view.ts",
            &format!("'{COMMAND_CHOOSER_TITLE}'"),
        );
        for status in ["sent", "failed", "bubble-only"] {
            says(
                UTTERANCE_CARDS,
                "buddy-utterance-cards.tsx",
                &format!("return '{}'", utterance_status_label(status)),
            );
        }
    }
}
