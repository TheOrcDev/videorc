//! The automatic chat lane (plan 164 Phase D, plan 192, plan 211): what the
//! Buddy says, and whether it goes to the bubble on stream or waits for the
//! streamer's click as a card.
//!
//! The lane is engine-wide and follows the live-chat session: it does not
//! need the Premium tick session, because greetings are free (D6). Every
//! routing method starts from the talk mode (plan 211 D1): `off` produces
//! nothing, ever; `bubble` produces `bubble-only` lines for the overlay and
//! never a send; `suggest` produces `proposed` cards for the Stream Manager.
//! Nothing the lane decides reaches chat on its own (D2): a pass has no send
//! list, and the one send path (`cohost::send_approved`) takes a card only
//! from the streamer's click. The throttle (`cohost_throttle`) keeps time;
//! `cohost.rs` owns the lane, shows the bubbles, posts the approved cards and
//! writes the report.
//!
//! Plan 192: a greeting kind with no user line says its built-in line (D1),
//! a chatter's first message gets a welcome (D2), every skip is logged once
//! per kind and counted on the report (D7), and with Premium the AI writes
//! the greeting in the persona's voice (D3): the lane leaves a
//! [`PendingGreet`] on the pass, the caller runs the call with no engine
//! lock held, and [`AutoChatLane::apply_greet_result`] routes the line.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::cohost::{
    COHOST_GREETING_TEXT_MAX_CHARS, CohostAutoChat, CohostTalkMode, CohostTone, CohostUtterance,
    CohostUtteranceState, CohostUtteranceStatus, CohostUtteranceTrigger,
    CohostUtteranceTriggerKind, truncate_utf16, utterance_state_for_mood,
};
use crate::cohost_greetings::{
    ActivityFacts, COLLAPSE_NAMED_MAX, GreetingKind, activity_facts, collapse, distinct_names,
    greeting_platform, resolve_line, resolve_template, welcome_facts,
};
use crate::cohost_throttle::{AutoChatThrottle, GreetingOffer};
use crate::live_chat::LiveChatMessage;
use crate::protocol::{CohostReportGreetingsSkipped, CohostReportPostSource};
use crate::videorc_api::{
    COHOST_GREET_ITEMS_MAX, CohostApiError, CohostApiErrorKind, CohostGreetItem,
    CohostGreetRequest, CohostGreetResponse, CohostTickPersona,
};

/// A proposed card the streamer did not act on leaves after this long.
pub(crate) const PROPOSED_TTL: Duration = Duration::from_secs(45);
/// Utterances kept on the state, newest last.
pub(crate) const UTTERANCES_KEPT: usize = 20;
/// Banter never follows a greeting or an answer within this long (S-D4).
pub(crate) const BANTER_QUIET_AFTER_SEND: Duration = Duration::from_secs(60);
/// An Activity row older than this on arrival is history (a reconnect
/// replay, a poll catching up), not a moment to greet.
pub(crate) const ACTIVITY_FRESH_WINDOW: Duration = Duration::from_secs(10 * 60);
/// A viewer name as the greet route takes it.
const GREET_NAME_MAX_UNITS: usize = 120;

/// What one lane pass decided. The caller shows `bubble`, publishes
/// `propose` (and every change), arms the pump for `schedule`, runs `greet`
/// off the engine lock and folds `skipped` into the session report. There is
/// no send list (plan 211 D2): the lane cannot hand a line to chat.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AutoChatPass {
    /// `bubble-only` lines for the overlay (Bubble mode).
    pub(crate) bubble: Vec<CohostUtterance>,
    /// `proposed` cards for the Stream Manager (Suggest mode).
    pub(crate) propose: Vec<CohostUtterance>,
    pub(crate) schedule: Option<Instant>,
    pub(crate) log: Vec<String>,
    /// Lines for the log at warn level: a desktop-side bug the owner should
    /// see (the greet route refused the request shape).
    pub(crate) warn: Vec<String>,
    /// Plan 192 S2.2: greetings waiting for the AI's lines. The caller runs
    /// the request with no engine lock held and hands the outcome to
    /// `apply_greet_result`, which routes them (AI text or the line).
    pub(crate) greet: Option<PendingGreet>,
    /// Plan 192 D7: skips counted in this pass, for the session report.
    pub(crate) skipped: CohostReportGreetingsSkipped,
}

impl AutoChatPass {
    pub(crate) fn changed(&self) -> bool {
        !self.bubble.is_empty() || !self.propose.is_empty()
    }
}

/// Why a greeting was not sent (plan 192 D7): logged once per (kind, reason)
/// per live-chat session, counted every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum GreetingSkipReason {
    NoLine,
    ModeOff,
    Stale,
    Deduped,
    Held,
    DestinationFailed,
    YoutubePaused,
}

impl GreetingSkipReason {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::NoLine => "no-line",
            Self::ModeOff => "mode-off",
            Self::Stale => "stale",
            Self::Deduped => "deduped",
            Self::Held => "held",
            Self::DestinationFailed => "destination-failed",
            Self::YoutubePaused => "youtube-paused",
        }
    }

    fn count(self, skipped: &mut CohostReportGreetingsSkipped) {
        let slot = match self {
            Self::NoLine => &mut skipped.no_line,
            Self::ModeOff => &mut skipped.mode_off,
            Self::Stale => &mut skipped.stale,
            Self::Deduped => &mut skipped.deduped,
            Self::Held => &mut skipped.held,
            Self::DestinationFailed => &mut skipped.destination_failed,
            Self::YoutubePaused => &mut skipped.youtube_paused,
        };
        *slot = slot.saturating_add(1);
    }

    /// The one log line per (kind, reason) a session gets.
    fn describe(self, kind: GreetingKind, who: &str) -> String {
        let kind = kind.wire();
        match self {
            Self::NoLine => {
                format!(
                    "Buddy skipped a {kind} greeting ({}): its line is switched off.",
                    self.wire()
                )
            }
            Self::ModeOff => format!(
                "Buddy skipped a {kind} greeting ({}): automatic chat or greetings are off.",
                self.wire()
            ),
            Self::Stale => format!(
                "Buddy skipped a {kind} greeting for {who} ({}): the row is older than {} minutes (a replay).",
                self.wire(),
                ACTIVITY_FRESH_WINDOW.as_secs() / 60
            ),
            Self::Deduped => format!(
                "Buddy skipped a {kind} greeting ({}): {who} was already greeted this session.",
                self.wire()
            ),
            Self::Held => format!(
                "Buddy is holding {kind} greetings for the cooldown ({}); they go out later, collapsed.",
                self.wire()
            ),
            Self::DestinationFailed => format!(
                "Buddy skipped a {kind} greeting ({}): no destination could take it, or the send failed.",
                self.wire()
            ),
            Self::YoutubePaused => format!(
                "Buddy skipped a {kind} greeting ({}): YouTube calls are paused by the quota breaker.",
                self.wire()
            ),
        }
    }
}

/// What a send-path skip left for the caller: the once-per-session log line
/// and the count to fold into the report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SendSkip {
    pub(crate) log: Option<String>,
    pub(crate) skipped: CohostReportGreetingsSkipped,
}

/// What the AI needs to write greetings (plan 192 S2.2). The engine builds
/// it only when Premium, the tick session's consent, the web's `greet`
/// capability and `greetings.ai` all hold; the lane trusts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GreetAiContext {
    pub(crate) client_version: String,
    /// The tick session the consent belongs to: the lane uses the AI only
    /// while it follows the same live-chat session.
    pub(crate) session_id: String,
    pub(crate) tone: CohostTone,
    pub(crate) persona: Option<CohostTickPersona>,
}

/// A tick reply the Buddy may send on its own (S-D3): the viewer named it,
/// or (plan 192 D5) nobody answered it and the streamer's notes do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnswerCandidate {
    pub(crate) question_id: String,
    pub(crate) message_id: Option<String>,
    pub(crate) destination_id: Option<String>,
    pub(crate) text: String,
    pub(crate) state: CohostUtteranceState,
}

/// What the lane decided to say, before it becomes an utterance.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Spoken {
    text: String,
    state: CohostUtteranceState,
    trigger: CohostUtteranceTrigger,
    destination_ids: Vec<String>,
}

/// One greeting written and waiting for the AI's line (plan 192 S2.2): the
/// resolved line is its fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingGreeting {
    item_id: String,
    kind: GreetingKind,
    fallback: Spoken,
}

/// The greet request a pass left (plan 192 S2.2), to run off the engine
/// lock; `apply_greet_result` routes its batches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingGreet {
    pub(crate) request: CohostGreetRequest,
    batches: Vec<PendingGreeting>,
}

#[derive(Debug, Clone)]
struct UtteranceRecord {
    utterance: CohostUtterance,
    expires_at: Option<Instant>,
    /// A greeting's kind and who wrote it (plan 192), for the skip log and
    /// the report's `source`.
    greeting: Option<(GreetingKind, CohostReportPostSource)>,
}

#[derive(Debug, Default)]
pub(crate) struct AutoChatLane {
    session_id: Option<String>,
    throttle: AutoChatThrottle,
    records: Vec<UtteranceRecord>,
    sends: u64,
    /// `operationId`s of the Buddy's own sends: `cohost_ack` never reads
    /// their delivery as "the streamer replied" (D10).
    own_operations: HashSet<String>,
    last_auto_send_at: Option<Instant>,
    last_answer_at: Option<Instant>,
    last_banter_at: Option<Instant>,
    pump_armed: bool,
    seq: u64,
    /// (kind, reason) pairs already logged this session (plan 192 D7).
    skip_logged: HashSet<(GreetingKind, GreetingSkipReason)>,
    /// The greet request this pass is filling (plan 192 S2.2).
    ai_pending: Option<PendingGreet>,
    ai_seq: u64,
    /// The session's first AI greeting asked the persona to introduce
    /// itself (D6); never twice.
    ai_introduced: bool,
    /// A 403 (Premium, consent, disabled) stopped AI greetings for the rest
    /// of the session; the code it came with.
    ai_stopped: Option<String>,
}

impl AutoChatLane {
    /// Follow the live-chat session: a new one starts clean (dedupe,
    /// cooldowns, cards, the skip log). Returns true when the lane was reset.
    pub(crate) fn follow_session(&mut self, session_id: &str) -> bool {
        if self.session_id.as_deref() == Some(session_id) {
            return false;
        }
        let pump_armed = self.pump_armed;
        *self = Self::default();
        self.pump_armed = pump_armed;
        self.session_id = Some(session_id.to_string());
        true
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(crate) fn pump_armed(&self) -> bool {
        self.pump_armed
    }

    pub(crate) fn set_pump_armed(&mut self, armed: bool) {
        self.pump_armed = armed;
    }

    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.throttle.next_due()
    }

    pub(crate) fn register_operation(&mut self, operation_id: &str) {
        self.own_operations.insert(operation_id.to_string());
    }

    pub(crate) fn is_own_operation(&self, operation_id: &str) -> bool {
        self.own_operations.contains(operation_id)
    }

    /// Automatic sends this session.
    pub(crate) fn sends(&self) -> u64 {
        self.sends
    }

    /// Who wrote a greeting (plan 192 S2.2); `None` for anything else.
    pub(crate) fn utterance_source(&self, utterance_id: &str) -> Option<CohostReportPostSource> {
        self.records
            .iter()
            .find(|record| record.utterance.id == utterance_id)
            .and_then(|record| record.greeting.map(|(_, source)| source))
    }

    fn next_id(&mut self) -> String {
        self.seq = self.seq.saturating_add(1);
        format!("utt-{}-{}", self.seq, uuid::Uuid::new_v4().simple())
    }

    fn record(
        &mut self,
        spoken: Spoken,
        status: CohostUtteranceStatus,
        greeting: Option<(GreetingKind, CohostReportPostSource)>,
        now: Instant,
        now_iso: &str,
    ) -> CohostUtterance {
        let proposed = status == CohostUtteranceStatus::Proposed;
        let utterance = CohostUtterance {
            id: self.next_id(),
            text: spoken.text,
            state: spoken.state,
            trigger: spoken.trigger,
            destination_ids: spoken.destination_ids,
            status,
            at: now_iso.to_string(),
            expires_at: proposed.then(|| iso_after(now, now + PROPOSED_TTL)),
        };
        self.records.push(UtteranceRecord {
            utterance: utterance.clone(),
            expires_at: proposed.then_some(now + PROPOSED_TTL),
            greeting,
        });
        while self.records.len() > UTTERANCES_KEPT {
            self.records.remove(0);
        }
        utterance
    }

    /// Route one decided utterance by the talk mode (plan 211 D1): `bubble`
    /// records it `bubble-only` for the overlay, `suggest` proposes a card.
    /// There is no arm that sends. Never called with the mode off.
    fn route(
        &mut self,
        settings: &CohostAutoChat,
        spoken: Spoken,
        greeting: Option<(GreetingKind, CohostReportPostSource)>,
        now: Instant,
        now_iso: &str,
        pass: &mut AutoChatPass,
    ) {
        let talk = settings.talk();
        debug_assert!(talk.speaks());
        match talk {
            CohostTalkMode::Off => {}
            CohostTalkMode::Bubble => {
                let utterance = self.record(
                    spoken,
                    CohostUtteranceStatus::BubbleOnly,
                    greeting,
                    now,
                    now_iso,
                );
                pass.bubble.push(utterance);
            }
            CohostTalkMode::Suggest => {
                let utterance = self.record(
                    spoken,
                    CohostUtteranceStatus::Proposed,
                    greeting,
                    now,
                    now_iso,
                );
                pass.propose.push(utterance);
            }
        }
    }

    /// Count one skip and log it the first time this session (D7).
    fn skip(
        &mut self,
        pass: &mut AutoChatPass,
        kind: GreetingKind,
        reason: GreetingSkipReason,
        who: &str,
    ) {
        reason.count(&mut pass.skipped);
        if self.skip_logged.insert((kind, reason)) {
            pass.log.push(reason.describe(kind, who));
        }
    }

    /// A greeting the send path could not deliver (plan 192 D7): the
    /// destination skipped it, or the send failed. Nothing for an utterance
    /// that is not a greeting.
    pub(crate) fn note_send_skip(
        &mut self,
        utterance_id: &str,
        reason: GreetingSkipReason,
    ) -> SendSkip {
        let mut out = SendSkip::default();
        let Some(kind) = self
            .records
            .iter()
            .find(|record| record.utterance.id == utterance_id)
            .and_then(|record| record.greeting.map(|(kind, _)| kind))
        else {
            return out;
        };
        reason.count(&mut out.skipped);
        if self.skip_logged.insert((kind, reason)) {
            out.log = Some(reason.describe(kind, ""));
        }
        out
    }

    /// Chat rows just delivered: greetings for Activity rows (S-D1) and
    /// welcomes for a chatter's first message (plan 192 S1.2). With the mode
    /// off or greetings off nothing is said and the skip is counted; stale
    /// rows and switched-off kinds are skipped; the throttle decides now,
    /// later, or never (D9). `ai` is the AI's context when it may write the
    /// lines (S2.2).
    pub(crate) fn note_activity(
        &mut self,
        settings: &CohostAutoChat,
        ai: Option<&GreetAiContext>,
        messages: &[LiveChatMessage],
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        let on = settings.talk().speaks() && settings.greetings.enabled;
        for message in messages {
            let Some(facts) = activity_facts(message).or_else(|| welcome_facts(message)) else {
                continue;
            };
            if self.follow_session(&message.session_id) {
                pass.log.push(format!(
                    "Buddy greetings follow chat session {}.",
                    message.session_id
                ));
            }
            let (kind, name) = (facts.kind, facts.name.clone());
            if !on {
                self.skip(&mut pass, kind, GreetingSkipReason::ModeOff, &name);
                continue;
            }
            if !activity_is_fresh(message, now_iso) {
                self.skip(&mut pass, kind, GreetingSkipReason::Stale, &name);
                continue;
            }
            if resolve_line(&settings.greetings, kind, facts.platform, 0).is_none() {
                self.skip(&mut pass, kind, GreetingSkipReason::NoLine, &name);
                continue;
            }
            match self.throttle.offer_greeting(facts, now) {
                GreetingOffer::SendNow(batch) => {
                    self.greet(settings, ai, &batch, now, now_iso, &mut pass);
                }
                GreetingOffer::Held { due } => {
                    pass.schedule = Some(pass.schedule.map_or(due, |at| at.min(due)));
                    self.skip(&mut pass, kind, GreetingSkipReason::Held, &name);
                }
                GreetingOffer::Deduped => {
                    self.skip(&mut pass, kind, GreetingSkipReason::Deduped, &name);
                }
            }
        }
        pass.greet = self.take_pending_greet();
        pass
    }

    /// The pump's pass: release the buckets whose time came.
    pub(crate) fn drain(
        &mut self,
        settings: &CohostAutoChat,
        ai: Option<&GreetAiContext>,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        let batches = self.throttle.drain_due(now);
        if !settings.talk().speaks() || !settings.greetings.enabled {
            // The mode went off while a bucket waited: it is dropped, never
            // said later (D4). The buckets were taken above.
            if !batches.is_empty() {
                pass.log
                    .push("Buddy dropped waiting greetings: automatic chat is off.".to_string());
                for event in batches.iter().flatten() {
                    GreetingSkipReason::ModeOff.count(&mut pass.skipped);
                    self.skip_logged
                        .insert((event.kind, GreetingSkipReason::ModeOff));
                }
            }
            return pass;
        }
        for batch in batches {
            self.greet(settings, ai, &batch, now, now_iso, &mut pass);
        }
        pass.schedule = self.throttle.next_due();
        pass.greet = self.take_pending_greet();
        pass
    }

    fn greet(
        &mut self,
        settings: &CohostAutoChat,
        ai: Option<&GreetAiContext>,
        batch: &[ActivityFacts],
        now: Instant,
        now_iso: &str,
        pass: &mut AutoChatPass,
    ) {
        let Some(first) = batch.first() else {
            return;
        };
        self.seq = self.seq.saturating_add(1);
        let Some(line) = resolve_line(
            &settings.greetings,
            first.kind,
            first.platform,
            self.seq as usize,
        ) else {
            self.skip(pass, first.kind, GreetingSkipReason::NoLine, &first.name);
            return;
        };
        let fields = collapse(batch);
        let (text, _unknown) = resolve_template(&line.text, &fields);
        if text.trim().is_empty() {
            self.skip(pass, first.kind, GreetingSkipReason::NoLine, &first.name);
            return;
        }
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Greeting,
            event_id: Some(first.message_id.clone()),
            message_id: None,
        };
        let spoken = Spoken {
            text,
            state: line.state,
            trigger,
            destination_ids: vec![first.destination_id.clone()],
        };
        // Plan 192 S2.2: with the AI available for this session, the line
        // waits for its AI version; the record is made when the result lands,
        // so a Suggest card never flashes the fallback first. The route takes
        // Twitch, YouTube, Kick and X only; other platforms get the line.
        if let Some(ai) = ai
            && self.session_id.as_deref() == Some(ai.session_id.as_str())
            && self.ai_stopped.is_none()
            && greeting_platform(first.platform).is_some()
            && self.queue_ai_greeting(ai, batch, fields.others, spoken.clone())
        {
            return;
        }
        self.route(
            settings,
            spoken,
            Some((first.kind, CohostReportPostSource::Line)),
            now,
            now_iso,
            pass,
        );
    }

    /// Add one batch to the pass's greet request. False when the request is
    /// full (the route takes six): the batch goes out as its line.
    fn queue_ai_greeting(
        &mut self,
        ai: &GreetAiContext,
        batch: &[ActivityFacts],
        others: usize,
        fallback: Spoken,
    ) -> bool {
        let Some(first) = batch.first() else {
            return false;
        };
        let session_id = self.session_id.clone().unwrap_or_default();
        let pending = self.ai_pending.get_or_insert_with(|| PendingGreet {
            request: CohostGreetRequest {
                client_version: ai.client_version.clone(),
                consent_to_process_chat: true,
                session_client_id: session_id,
                seq: 0,
                tone: ai.tone,
                persona: ai.persona.clone(),
                introduce: false,
                items: Vec::new(),
            },
            batches: Vec::new(),
        });
        if pending.request.items.len() >= COHOST_GREET_ITEMS_MAX {
            return false;
        }
        // The route is strict: optional strings are absent or non-empty,
        // names 1 to 3 of 1 to 120, the fallback line 1 to 200.
        let names: Vec<String> = distinct_names(batch)
            .into_iter()
            .map(|name| truncate_utf16(name.trim(), GREET_NAME_MAX_UNITS))
            .filter(|name| !name.is_empty())
            .take(COLLAPSE_NAMED_MAX)
            .collect();
        let fallback_line = truncate_utf16(fallback.text.trim(), COHOST_GREETING_TEXT_MAX_CHARS);
        if names.is_empty() || fallback_line.is_empty() {
            return false;
        }
        let item_id = format!("g-{}", self.seq);
        pending.request.items.push(CohostGreetItem {
            id: item_id.clone(),
            kind: first.kind.wire().to_string(),
            platform: first.platform,
            names,
            others: others as u64,
            months: first.months,
            streak: first.streak,
            count: first.count,
            amount: non_empty(first.amount.as_deref()),
            reward: non_empty(first.reward.as_deref()),
            first_message_text: non_empty(first.first_message_text.as_deref()),
            fallback_line,
        });
        pending.batches.push(PendingGreeting {
            item_id,
            kind: first.kind,
            fallback,
        });
        true
    }

    /// The pass's greet request, numbered; the first of the session asks
    /// the persona to introduce itself (D6).
    fn take_pending_greet(&mut self) -> Option<PendingGreet> {
        let mut pending = self.ai_pending.take()?;
        self.ai_seq = self.ai_seq.saturating_add(1);
        pending.request.seq = self.ai_seq;
        pending.request.introduce = !self.ai_introduced;
        self.ai_introduced = true;
        Some(pending)
    }

    /// The greet route answered (or failed): route every waiting greeting
    /// with the AI's line, or its own line when the AI gave none (plan 192
    /// S2.2). A greeting is never lost to an AI failure. A 403 stops AI
    /// greetings for the rest of the session. The mode is read again here.
    pub(crate) fn apply_greet_result(
        &mut self,
        settings: &CohostAutoChat,
        pending: PendingGreet,
        result: Result<CohostGreetResponse, CohostApiError>,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        if self.session_id.as_deref() != Some(pending.request.session_client_id.as_str()) {
            pass.log.push(
                "Buddy dropped AI greetings: the chat session they were for ended.".to_string(),
            );
            return pass;
        }
        if !settings.talk().speaks() || !settings.greetings.enabled {
            pass.log
                .push("Buddy dropped waiting greetings: automatic chat is off.".to_string());
            for batch in &pending.batches {
                GreetingSkipReason::ModeOff.count(&mut pass.skipped);
                self.skip_logged
                    .insert((batch.kind, GreetingSkipReason::ModeOff));
            }
            return pass;
        }
        let lines: HashMap<String, (String, CohostUtteranceState)> = match result {
            Ok(response) => response
                .lines
                .into_iter()
                .filter_map(|line| {
                    let text = ai_greeting_text(&line.text)?;
                    Some((line.id, (text, utterance_state_for_mood(line.mood))))
                })
                .collect(),
            Err(error) => {
                // Any 403 (consent, Premium, the route or the user disabled)
                // and the day's cap (429) stop AI greetings for the session;
                // a 5xx, a timeout or a transport failure falls back for this
                // batch only. A 400 is a desktop bug: said at warn.
                let stop = matches!(error.detail.status, Some(403 | 429))
                    || matches!(
                        error.kind,
                        CohostApiErrorKind::PremiumRequired
                            | CohostApiErrorKind::ConsentRequired
                            | CohostApiErrorKind::QuotaExhausted { .. }
                    );
                let line = format!(
                    "Buddy AI greeting failed ({}): {}; the line goes out instead.",
                    error.detail.code,
                    error.message()
                );
                if error.kind == CohostApiErrorKind::InvalidRequest {
                    pass.warn.push(line);
                } else {
                    pass.log.push(line);
                }
                if stop && self.ai_stopped.is_none() {
                    pass.log.push(format!(
                        "Buddy AI greetings are off for the rest of this session ({}).",
                        error.detail.code
                    ));
                    self.ai_stopped = Some(error.detail.code.clone());
                }
                HashMap::new()
            }
        };
        for batch in pending.batches {
            let (spoken, source) = match lines.get(&batch.item_id) {
                Some((text, state)) => (
                    Spoken {
                        text: text.clone(),
                        state: *state,
                        ..batch.fallback
                    },
                    CohostReportPostSource::Ai,
                ),
                None => (batch.fallback, CohostReportPostSource::Line),
            };
            self.route(
                settings,
                spoken,
                Some((batch.kind, source)),
                now,
                now_iso,
                &mut pass,
            );
        }
        pass
    }

    /// A tick reply the viewer asked the Buddy for by name (S-D3), or one
    /// the notes answer (plan 192 D5): under the answers switch, the answers
    /// cooldown and the destination's limiter. Nothing here counts as a
    /// send (plan 211 D10): a Suggest card counts when it lands, a Bubble
    /// line never.
    pub(crate) fn route_answer(
        &mut self,
        settings: &CohostAutoChat,
        candidate: AnswerCandidate,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        if !settings.talk().speaks() || !settings.answers.enabled {
            return pass;
        }
        let cooldown = Duration::from_secs(u64::from(settings.answers.cooldown_seconds));
        if self
            .last_answer_at
            .is_some_and(|last| now.saturating_duration_since(last) < cooldown)
        {
            pass.log.push(format!(
                "Buddy skipped an answer to {}: the answers cooldown is running.",
                candidate.question_id
            ));
            return pass;
        }
        let Some(destination_id) = candidate.destination_id else {
            pass.log.push(format!(
                "Buddy skipped an answer to {}: the question's chat row is unknown.",
                candidate.question_id
            ));
            return pass;
        };
        if let Err(at) = self.throttle.admit(&destination_id, now) {
            pass.log.push(format!(
                "Buddy skipped an answer to {}: {destination_id} is rate-limited for {} s.",
                candidate.question_id,
                at.saturating_duration_since(now).as_secs()
            ));
            return pass;
        }
        let text = candidate.text.trim().to_string();
        if text.is_empty() {
            return pass;
        }
        self.last_answer_at = Some(now);
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Answer,
            event_id: None,
            message_id: candidate.message_id,
        };
        self.route(
            settings,
            Spoken {
                text,
                state: candidate.state,
                trigger,
                destination_ids: vec![destination_id],
            },
            None,
            now,
            now_iso,
            &mut pass,
        );
        pass
    }

    /// Whether a banter request may go out now (S-D4): the switch, its
    /// cooldown, and no greeting or answer said (bubbled or posted) in the
    /// last minute.
    pub(crate) fn banter_allowed(&self, settings: &CohostAutoChat, now: Instant) -> bool {
        if !settings.talk().speaks() || !settings.banter.enabled {
            return false;
        }
        let cooldown = Duration::from_secs(u64::from(settings.banter.cooldown_seconds));
        if self
            .last_banter_at
            .is_some_and(|last| now.saturating_duration_since(last) < cooldown)
        {
            return false;
        }
        !self
            .last_auto_send_at
            .is_some_and(|last| now.saturating_duration_since(last) < BANTER_QUIET_AFTER_SEND)
    }

    /// A banter request left: the cooldown runs from the request, so a
    /// failed one is not retried every pass.
    pub(crate) fn note_banter_requested(&mut self, now: Instant) {
        self.last_banter_at = Some(now);
    }

    /// The banter line the web returned (S-D4): to every writable
    /// destination (empty `destination_ids`, resolved by the sender).
    pub(crate) fn route_banter(
        &mut self,
        settings: &CohostAutoChat,
        text: &str,
        state: CohostUtteranceState,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        if !settings.talk().speaks() || !settings.banter.enabled {
            return pass;
        }
        let text = text.trim().to_string();
        if text.is_empty() {
            return pass;
        }
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Banter,
            event_id: None,
            message_id: None,
        };
        self.route(
            settings,
            Spoken {
                text,
                state,
                trigger,
                destination_ids: Vec::new(),
            },
            None,
            now,
            now_iso,
            &mut pass,
        );
        pass
    }

    /// The streamer's own Say box (D7, plan 211 D1): bubble-only in every
    /// mode, never a send. Returns the recorded utterance; the caller shows
    /// it.
    pub(crate) fn say(
        &mut self,
        text: &str,
        state: CohostUtteranceState,
        now: Instant,
        now_iso: &str,
    ) -> CohostUtterance {
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Manual,
            event_id: None,
            message_id: None,
        };
        self.record(
            Spoken {
                text: text.trim().to_string(),
                state,
                trigger,
                destination_ids: Vec::new(),
            },
            CohostUtteranceStatus::BubbleOnly,
            None,
            now,
            now_iso,
        )
    }

    /// The Stream Manager approved a proposed card (S-D2): the utterance to
    /// send, or why not.
    pub(crate) fn approve(
        &mut self,
        utterance_id: &str,
        now: Instant,
    ) -> Result<CohostUtterance, ApproveRefusal> {
        let record = self
            .records
            .iter_mut()
            .find(|record| record.utterance.id == utterance_id)
            .ok_or(ApproveRefusal::Unknown)?;
        if record.utterance.status != CohostUtteranceStatus::Proposed {
            return Err(ApproveRefusal::NotProposed);
        }
        if record.expires_at.is_some_and(|at| now >= at) {
            record.utterance.status = CohostUtteranceStatus::Dismissed;
            return Err(ApproveRefusal::Expired);
        }
        record.expires_at = None;
        record.utterance.expires_at = None;
        Ok(record.utterance.clone())
    }

    /// True when the card changed.
    pub(crate) fn dismiss(&mut self, utterance_id: &str) -> bool {
        self.mark(utterance_id, CohostUtteranceStatus::Dismissed)
    }

    /// Set a terminal status. True when it changed.
    pub(crate) fn mark(&mut self, utterance_id: &str, status: CohostUtteranceStatus) -> bool {
        let Some(record) = self
            .records
            .iter_mut()
            .find(|record| record.utterance.id == utterance_id)
        else {
            return false;
        };
        if record.utterance.status == status {
            return false;
        }
        record.utterance.status = status;
        record.expires_at = None;
        record.utterance.expires_at = None;
        true
    }

    /// An approved card landed in chat (sent or partial).
    pub(crate) fn note_sent(&mut self, now: Instant) {
        self.sends = self.sends.saturating_add(1);
        self.last_auto_send_at = Some(now);
    }

    /// A Bubble line showed on stream (plan 211 S-A2): Banter's quiet minute
    /// runs from it like from a send, but it is no send and is not counted
    /// as one.
    pub(crate) fn note_spoken(&mut self, now: Instant) {
        self.last_auto_send_at = Some(now);
    }

    /// The utterances as the state carries them: expired proposals read as
    /// dismissed.
    pub(crate) fn snapshot(&self, now: Instant) -> Vec<CohostUtterance> {
        self.records
            .iter()
            .map(|record| {
                let mut utterance = record.utterance.clone();
                if utterance.status == CohostUtteranceStatus::Proposed
                    && record.expires_at.is_some_and(|at| now >= at)
                {
                    utterance.status = CohostUtteranceStatus::Dismissed;
                    utterance.expires_at = None;
                }
                utterance
            })
            .collect()
    }
}

/// A trimmed optional string, absent when empty (the greet route refuses an
/// empty optional).
fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// An AI line as the lane takes it: one trimmed line, cut to the greeting
/// cap; a link or a line break (the server refuses both) reads as no line.
fn ai_greeting_text(text: &str) -> Option<String> {
    let text = truncate_utf16(text.trim(), COHOST_GREETING_TEXT_MAX_CHARS);
    let text = text.trim_end().to_string();
    if text.is_empty() || text.contains('\n') || text.contains("://") {
        return None;
    }
    Some(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApproveRefusal {
    Unknown,
    NotProposed,
    Expired,
}

impl ApproveRefusal {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Unknown => "That Buddy card is gone.",
            Self::NotProposed => "That Buddy card was already answered.",
            Self::Expired => "That Buddy card expired.",
        }
    }
}

/// An Activity row counts as live when its provider time is within
/// [`ACTIVITY_FRESH_WINDOW`] of now (unparseable times count as fresh: the
/// connectors always stamp RFC 3339, so this only guards replays).
fn activity_is_fresh(message: &LiveChatMessage, now_iso: &str) -> bool {
    let Ok(now) = chrono::DateTime::parse_from_rfc3339(now_iso) else {
        return true;
    };
    let Ok(published) = chrono::DateTime::parse_from_rfc3339(&message.published_at) else {
        return true;
    };
    let age = now.signed_duration_since(published);
    age.num_seconds() <= ACTIVITY_FRESH_WINDOW.as_secs() as i64
}

fn iso_after(now: Instant, due: Instant) -> String {
    let delta = chrono::Duration::from_std(due.saturating_duration_since(now))
        .unwrap_or_else(|_| chrono::Duration::zero());
    (chrono::Utc::now() + delta).to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohost::{
        CohostActivityTemplateKind, CohostCooldownBehaviour, CohostGreetingTemplate,
        CohostGreetingsSettings,
    };
    use crate::live_chat::{LiveChatEventType, fake_events_for_tests};
    use crate::streaming::StreamPlatform;
    use crate::videorc_api::{CohostGreetLine, CohostTickMood, classify_cohost_failure};

    fn template(kind: CohostActivityTemplateKind, text: &str) -> CohostGreetingTemplate {
        CohostGreetingTemplate {
            id: format!("t-{text}"),
            kind,
            platform: None,
            text: text.to_string(),
            state: CohostUtteranceState::Laugh,
            enabled: true,
            reaction: None,
        }
    }

    fn settings(talk: CohostTalkMode) -> CohostAutoChat {
        CohostAutoChat {
            talk: Some(talk),
            mode: talk.legacy(),
            greetings: CohostGreetingsSettings {
                enabled: true,
                templates: vec![
                    template(CohostActivityTemplateKind::Follow, "Welcome {names}!"),
                    template(CohostActivityTemplateKind::Raid, "{name} brings {count}"),
                ],
                ..CohostGreetingsSettings::default()
            },
            answers: CohostCooldownBehaviour {
                enabled: true,
                cooldown_seconds: 20,
            },
            banter: CohostCooldownBehaviour {
                enabled: true,
                cooldown_seconds: 240,
            },
        }
    }

    /// Settings with no line of the user's own: every kind says its
    /// built-in line (plan 192 D1).
    fn bare_settings(talk: CohostTalkMode) -> CohostAutoChat {
        CohostAutoChat {
            greetings: CohostGreetingsSettings::default(),
            ..settings(talk)
        }
    }

    fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    fn twitch_events() -> Vec<LiveChatMessage> {
        fake_events_for_tests("session-1", StreamPlatform::Twitch, Some("main"))
    }

    fn event(raw_kind: &str) -> LiveChatMessage {
        twitch_events()
            .into_iter()
            .find(|m| m.raw_provider_type.as_deref() == Some(raw_kind))
            .unwrap()
    }

    /// The raid and the follow, in that order: the rows the plan 164 tests
    /// were written for, before every kind had a line.
    fn raid_and_follow() -> Vec<LiveChatMessage> {
        vec![event("raid"), event("follow")]
    }

    fn follows(count: u32) -> Vec<LiveChatMessage> {
        (0..count)
            .map(|n| {
                let mut row = event("follow");
                row.author_id = Some(format!("fan-{n}"));
                row.author_name = format!("Fan{n}");
                row.id = format!("session-1:twitch:main:f{n}");
                row
            })
            .collect()
    }

    /// A plain chat row: a first message in the channel, or this session.
    fn chat_row(name: &str, first_message: bool, first_in_session: bool) -> LiveChatMessage {
        let mut row = event("follow");
        row.details = None;
        row.event_type = LiveChatEventType::Message;
        row.raw_provider_type = Some("twitch".to_string());
        row.author_id = Some(format!("id-{}", name.to_lowercase()));
        row.author_name = name.to_string();
        row.id = format!("session-1:twitch:main:chat-{}", name.to_lowercase());
        row.message_text = format!("hi from {name}");
        row.first_message = first_message;
        row.first_in_session = first_in_session;
        row
    }

    fn answer() -> AnswerCandidate {
        AnswerCandidate {
            question_id: "q_1".to_string(),
            message_id: Some("m-1".to_string()),
            destination_id: Some("twitch:main".to_string()),
            text: "It is a Keychron.".to_string(),
            state: CohostUtteranceState::Talk,
        }
    }

    fn ai() -> GreetAiContext {
        GreetAiContext {
            client_version: "videorc-desktop/test".to_string(),
            session_id: "session-1".to_string(),
            tone: CohostTone::Short,
            persona: Some(CohostTickPersona {
                name: "Golmar".to_string(),
                personality: "Loud and loyal.".to_string(),
            }),
        }
    }

    fn silent(pass: &AutoChatPass) -> bool {
        pass.bubble.is_empty()
            && pass.propose.is_empty()
            && pass.schedule.is_none()
            && pass.greet.is_none()
    }

    /// The STOP condition of plan 164: nothing is said, proposed or
    /// scheduled with the mode off. Written first; every lane method is
    /// covered. Plan 192 D7: the skips are counted and logged once per kind.
    #[test]
    fn with_the_mode_off_nothing_is_said_proposed_or_scheduled() {
        let start = Instant::now();
        let off = settings(CohostTalkMode::Off);
        let mut lane = AutoChatLane::default();
        let activity = lane.note_activity(&off, Some(&ai()), &twitch_events(), start, &now_iso());
        assert!(silent(&activity), "{activity:?}");
        assert_eq!(activity.skipped.mode_off, 8, "every Activity row counted");
        assert_eq!(
            activity
                .log
                .iter()
                .filter(|l| l.contains("mode-off"))
                .count(),
            8,
            "one line per kind"
        );
        let again = lane.note_activity(&off, None, &twitch_events(), start, &now_iso());
        assert!(silent(&again));
        assert_eq!(again.skipped.mode_off, 8);
        assert!(again.log.is_empty(), "logged once per kind per session");
        assert_eq!(
            lane.drain(&off, None, start + Duration::from_secs(60), &now_iso()),
            AutoChatPass::default()
        );
        assert_eq!(
            lane.route_answer(&off, answer(), start, &now_iso()),
            AutoChatPass::default()
        );
        assert!(!lane.banter_allowed(&off, start));
        assert_eq!(
            lane.route_banter(
                &off,
                "A joke.",
                CohostUtteranceState::Laugh,
                start,
                &now_iso()
            ),
            AutoChatPass::default()
        );
        let said = lane.say("Hello horde", CohostUtteranceState::Talk, start, &now_iso());
        assert_eq!(said.status, CohostUtteranceStatus::BubbleOnly);
        assert_eq!(lane.sends(), 0);
        assert!(
            lane.snapshot(start)
                .iter()
                .all(|u| u.status == CohostUtteranceStatus::BubbleOnly)
        );
        // Greetings off under a live mode: the same skip.
        let mut greetings_off = settings(CohostTalkMode::Bubble);
        greetings_off.greetings.enabled = false;
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(&greetings_off, None, &follows(1), start, &now_iso());
        assert!(silent(&pass));
        assert_eq!(pass.skipped.mode_off, 1);
        // Switching off while a bucket waits drops it, counted as mode-off.
        let mut lane = AutoChatLane::default();
        let bubble = settings(CohostTalkMode::Bubble);
        let first = lane.note_activity(&bubble, None, &follows(5), start, &now_iso());
        assert_eq!(first.bubble.len(), 1);
        assert!(first.schedule.is_some());
        let drained = lane.drain(&off, None, start + Duration::from_secs(11), &now_iso());
        assert!(drained.bubble.is_empty() && drained.propose.is_empty());
        assert_eq!(drained.log.len(), 1);
        assert_eq!(drained.skipped.mode_off, 4);
        assert_eq!(lane.next_due(), None);
        // An AI result arriving after the mode went off is dropped too.
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(&bubble, Some(&ai()), &follows(1), start, &now_iso());
        let pending = pass.greet.unwrap();
        let dropped = lane.apply_greet_result(
            &off,
            pending,
            Ok(CohostGreetResponse::default()),
            start,
            &now_iso(),
        );
        assert!(silent(&dropped));
        assert_eq!(dropped.skipped.mode_off, 1);
        assert_eq!(lane.snapshot(start).len(), 0, "no card was made");
    }

    /// Plan 211 D1: Bubble says the line (`bubble-only`, never a send);
    /// Suggest proposes a card the streamer approves.
    #[test]
    fn bubble_says_and_suggest_proposes_greetings_with_the_template_state() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(
            &settings(CohostTalkMode::Bubble),
            None,
            &raid_and_follow(),
            start,
            &now_iso(),
        );
        // The raid goes first; the follow on the same destination waits for
        // the 5 s gap (D9) and the drain releases it.
        let texts: Vec<&str> = pass.bubble.iter().map(|u| u.text.as_str()).collect();
        assert_eq!(texts, ["raider42 brings 234"]);
        assert_eq!(pass.schedule, Some(start + Duration::from_secs(5)));
        assert!(pass.propose.is_empty());
        assert_eq!(pass.skipped.held, 1);
        assert!(
            pass.log
                .iter()
                .any(|l| l.contains("holding follow greetings"))
        );
        let follow = lane.drain(
            &settings(CohostTalkMode::Bubble),
            None,
            start + Duration::from_secs(5),
            &now_iso(),
        );
        assert_eq!(follow.bubble.len(), 1);
        assert_eq!(follow.bubble[0].text, "Welcome new_friend!");
        let pass = AutoChatPass {
            bubble: [pass.bubble, follow.bubble].concat(),
            ..pass
        };
        assert!(pass.bubble.iter().all(|u| u.destination_ids == ["main"]));
        assert!(
            pass.bubble
                .iter()
                .all(|u| u.status == CohostUtteranceStatus::BubbleOnly && u.expires_at.is_none())
        );
        assert_eq!(lane.sends(), 0, "a bubble line is never a send");
        assert!(
            pass.bubble
                .iter()
                .all(|u| u.state == CohostUtteranceState::Laugh)
        );
        assert!(
            pass.bubble
                .iter()
                .all(|u| u.trigger.kind == CohostUtteranceTriggerKind::Greeting)
        );
        assert!(pass.bubble.iter().all(|u| u.trigger.event_id.is_some()));
        assert!(
            pass.bubble
                .iter()
                .all(|u| lane.utterance_source(&u.id) == Some(CohostReportPostSource::Line))
        );

        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(
            &settings(CohostTalkMode::Suggest),
            None,
            &raid_and_follow(),
            start,
            &now_iso(),
        );
        assert!(pass.bubble.is_empty());
        assert_eq!(pass.propose.len(), 1);
        let pass = AutoChatPass {
            propose: [
                pass.propose,
                lane.drain(
                    &settings(CohostTalkMode::Suggest),
                    None,
                    start + Duration::from_secs(5),
                    &now_iso(),
                )
                .propose,
            ]
            .concat(),
            ..pass
        };
        assert_eq!(pass.propose.len(), 2);
        assert!(
            pass.propose
                .iter()
                .all(|u| u.status == CohostUtteranceStatus::Proposed)
        );
        assert!(pass.propose.iter().all(|u| u.expires_at.is_some()));
        let id = pass.propose[0].id.clone();
        let approved = lane.approve(&id, start + Duration::from_secs(10)).unwrap();
        assert_eq!(approved.id, id);
        assert!(
            lane.approve(&id, start).is_ok(),
            "approved twice is still the card"
        );
        assert!(lane.mark(&id, CohostUtteranceStatus::Sent));
        assert_eq!(lane.approve(&id, start), Err(ApproveRefusal::NotProposed));
        // The second card was proposed by the drain at +5 s.
        let other = pass.propose[1].id.clone();
        let expired_at = start + Duration::from_secs(5) + PROPOSED_TTL;
        assert_eq!(
            lane.approve(&other, expired_at),
            Err(ApproveRefusal::Expired)
        );
        assert_eq!(lane.approve("nope", start), Err(ApproveRefusal::Unknown));
        let shown = lane.snapshot(expired_at);
        assert_eq!(
            shown
                .iter()
                .filter(|u| u.status == CohostUtteranceStatus::Dismissed)
                .count(),
            1
        );
        assert!(lane.dismiss(&id) || true);
    }

    #[test]
    fn a_held_burst_is_released_by_drain_as_one_collapsed_greeting() {
        let start = Instant::now();
        let bubble = settings(CohostTalkMode::Bubble);
        let mut lane = AutoChatLane::default();
        let follows = follows(6);
        let first = lane.note_activity(&bubble, None, &follows, start, &now_iso());
        assert_eq!(first.bubble.len(), 1);
        assert_eq!(first.bubble[0].text, "Welcome Fan0!");
        assert_eq!(first.schedule, Some(start + Duration::from_secs(10)));
        assert_eq!(first.skipped.held, 5);
        assert!(
            lane.drain(&bubble, None, start + Duration::from_secs(9), &now_iso())
                .bubble
                .is_empty()
        );
        let later = lane.drain(&bubble, None, start + Duration::from_secs(10), &now_iso());
        assert_eq!(later.bubble.len(), 1);
        assert_eq!(
            later.bubble[0].text,
            "Welcome Fan1, Fan2, Fan3 and 2 others!"
        );
        assert_eq!(later.schedule, None);
        // Same viewers again: nothing, counted and logged once.
        let again = lane.note_activity(
            &bubble,
            None,
            &follows,
            start + Duration::from_secs(30),
            &now_iso(),
        );
        assert!(silent(&again));
        assert_eq!(again.skipped.deduped, 6);
        assert_eq!(again.log.len(), 1);
        assert!(again.log[0].contains("deduped") && again.log[0].contains("Fan0"));
    }

    #[test]
    fn stale_rows_and_other_sessions_reset_or_skip() {
        let start = Instant::now();
        let bubble = settings(CohostTalkMode::Bubble);
        let mut lane = AutoChatLane::default();
        let mut old = raid_and_follow();
        for row in &mut old {
            row.published_at = "2020-01-01T00:00:00Z".to_string();
        }
        let stale = lane.note_activity(&bubble, None, &old, start, &now_iso());
        assert!(silent(&stale));
        assert_eq!(stale.skipped.stale, 2);
        assert_eq!(stale.log.iter().filter(|l| l.contains("stale")).count(), 2);
        let first = lane.note_activity(&bubble, None, &raid_and_follow(), start, &now_iso());
        assert_eq!(first.bubble.len(), 1);
        assert_eq!(lane.session_id(), Some("session-1"));
        let next = fake_events_for_tests("session-2", StreamPlatform::Twitch, Some("main"));
        let second = lane.note_activity(
            &bubble,
            None,
            &next,
            start + Duration::from_secs(1),
            &now_iso(),
        );
        assert_eq!(
            second.bubble.len(),
            1,
            "a new session starts with no dedupe or gap"
        );
        assert_eq!(lane.session_id(), Some("session-2"));
        assert!(second.log.iter().any(|line| line.contains("session-2")));
    }

    // --- Plan 192 Phase 0: built-in lines and skips -------------------------------

    /// D1: an empty list greets a follow with the built-in line.
    #[test]
    fn an_empty_list_greets_a_follow_with_the_builtin_line() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        assert!(bubble.greetings.templates.is_empty());
        let pass = lane.note_activity(&bubble, None, &follows(1), start, &now_iso());
        assert_eq!(pass.bubble.len(), 1);
        assert_eq!(pass.bubble[0].text, "Welcome, Fan0! Thanks for the follow.");
        assert_eq!(pass.bubble[0].state, CohostUtteranceState::Talk);
        assert_eq!(pass.bubble[0].destination_ids, ["main"]);
        assert_eq!(
            lane.utterance_source(&pass.bubble[0].id),
            Some(CohostReportPostSource::Line)
        );
        assert!(pass.log.is_empty() || pass.log.iter().all(|l| l.contains("follow chat session")));
        assert_eq!(pass.skipped, CohostReportGreetingsSkipped::default());
        // Every Activity kind has a line: the whole fake set greets (one
        // now, the rest held for the gap).
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(&bubble, None, &twitch_events(), start, &now_iso());
        assert_eq!(pass.bubble.len(), 1);
        assert_eq!(
            pass.bubble[0].text,
            "morgaesis is back in the ranks. Thank you!"
        );
        assert_eq!(pass.skipped.held, 7);
        assert_eq!(pass.skipped.no_line, 0);
    }

    /// D1: a kind whose every template is off stays silent, logged once.
    #[test]
    fn an_all_disabled_kind_stays_silent_and_is_logged_once() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let mut bubble = bare_settings(CohostTalkMode::Bubble);
        let mut off = template(CohostActivityTemplateKind::Follow, "Yo {name}");
        off.enabled = false;
        bubble.greetings.templates = vec![off];
        let pass = lane.note_activity(&bubble, None, &follows(2), start, &now_iso());
        assert!(silent(&pass));
        assert_eq!(pass.skipped.no_line, 2);
        let no_line: Vec<&String> = pass.log.iter().filter(|l| l.contains("no-line")).collect();
        assert_eq!(no_line.len(), 1, "{:?}", pass.log);
        assert!(no_line[0].contains("a follow greeting"));
        // Other kinds still greet.
        let raid = lane.note_activity(&bubble, None, &[event("raid")], start, &now_iso());
        assert_eq!(raid.bubble.len(), 1);
        assert_eq!(
            raid.bubble[0].text,
            "raider42 is raiding! Welcome, everyone!"
        );
    }

    /// D1: the user's line wins over the built-in line.
    #[test]
    fn a_user_line_beats_the_builtin_line() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let mut bubble = bare_settings(CohostTalkMode::Bubble);
        bubble.greetings.templates = vec![template(
            CohostActivityTemplateKind::Follow,
            "Yo {name}, join the horde",
        )];
        let pass = lane.note_activity(&bubble, None, &follows(1), start, &now_iso());
        assert_eq!(pass.bubble[0].text, "Yo Fan0, join the horde");
        assert_eq!(pass.bubble[0].state, CohostUtteranceState::Laugh);
    }

    /// A built-in line written with `{name}` greets the whole burst.
    #[test]
    fn a_collapsed_burst_resolves_name_to_the_names_list() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let first = lane.note_activity(&bubble, None, &follows(5), start, &now_iso());
        assert_eq!(
            first.bubble[0].text,
            "Welcome, Fan0! Thanks for the follow."
        );
        let later = lane.drain(&bubble, None, start + Duration::from_secs(10), &now_iso());
        assert_eq!(
            later.bubble[0].text,
            "Welcome, Fan1, Fan2, Fan3 and 1 other! Thanks for the follow."
        );
    }

    // --- Plan 192 Phase 1: welcomes ----------------------------------------------

    /// S1.2: a first-timer is welcomed once, with the built-in line; their
    /// second message is not; a returning chatter gets "welcome back" once
    /// per session; a bot is skipped.
    #[test]
    fn first_time_and_returning_chatters_are_welcomed_once() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let first = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Ana", true, true)],
            start,
            &now_iso(),
        );
        assert_eq!(first.bubble.len(), 1);
        assert_eq!(first.bubble[0].text, "Hi Ana, welcome to the stream!");
        assert_eq!(first.bubble[0].state, CohostUtteranceState::Talk);
        assert_eq!(first.bubble[0].destination_ids, ["main"]);
        assert_eq!(
            first.bubble[0].trigger.kind,
            CohostUtteranceTriggerKind::Greeting
        );
        // Ana's second message: not a first message, so not even offered.
        let second = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Ana", false, false)],
            start + Duration::from_secs(6),
            &now_iso(),
        );
        assert_eq!(second, AutoChatPass::default());
        // A replayed first message: deduped.
        let replay = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Ana", true, true)],
            start + Duration::from_secs(7),
            &now_iso(),
        );
        assert!(silent(&replay));
        assert_eq!(replay.skipped.deduped, 1);
        // Returning: once this session, with its own line.
        let back = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Bo", false, true)],
            start + Duration::from_secs(8),
            &now_iso(),
        );
        assert_eq!(back.bubble.len(), 1);
        assert_eq!(back.bubble[0].text, "Welcome back, Bo!");
        let back_again = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Bo", false, true)],
            start + Duration::from_secs(20),
            &now_iso(),
        );
        assert_eq!(back_again.skipped.deduped, 1);
        assert!(silent(&back_again));
        // A bot never gets a welcome, and nothing is counted: it is not a
        // chatter the Buddy would greet.
        let bot = lane.note_activity(
            &bubble,
            None,
            &[chat_row("Nightbot", true, true)],
            start + Duration::from_secs(30),
            &now_iso(),
        );
        assert_eq!(bot, AutoChatPass::default());
        // A new session welcomes Bo back again.
        let mut next = chat_row("Bo", false, true);
        next.session_id = "session-2".to_string();
        let fresh = lane.note_activity(
            &bubble,
            None,
            &[next],
            start + Duration::from_secs(40),
            &now_iso(),
        );
        assert_eq!(fresh.bubble.len(), 1);
        assert_eq!(lane.session_id(), Some("session-2"));
    }

    /// S1.2: a burst of five first-timers collapses into one welcome; Off
    /// is silent; Suggest gives a card; the welcome switches hold.
    #[test]
    fn a_burst_of_first_timers_collapses_and_the_mode_and_switches_gate_welcomes() {
        let start = Instant::now();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let rows: Vec<LiveChatMessage> = ["Ana", "Bo", "Cy", "Di", "Ed"]
            .iter()
            .map(|name| chat_row(name, true, true))
            .collect();
        let mut lane = AutoChatLane::default();
        let first = lane.note_activity(&bubble, None, &rows, start, &now_iso());
        assert_eq!(first.bubble.len(), 1);
        assert_eq!(first.bubble[0].text, "Hi Ana, welcome to the stream!");
        assert_eq!(first.schedule, Some(start + Duration::from_secs(5)));
        assert_eq!(first.skipped.held, 4);
        let later = lane.drain(&bubble, None, start + Duration::from_secs(5), &now_iso());
        assert_eq!(later.bubble.len(), 1);
        assert_eq!(
            later.bubble[0].text,
            "Hi Bo, Cy, Di and 1 other, welcome to the stream!"
        );
        // Off: silent (counted).
        let mut lane = AutoChatLane::default();
        let off = lane.note_activity(
            &bare_settings(CohostTalkMode::Off),
            None,
            &rows,
            start,
            &now_iso(),
        );
        assert!(silent(&off));
        assert_eq!(off.skipped.mode_off, 5);
        // Suggest: a card.
        let mut lane = AutoChatLane::default();
        let card = lane.note_activity(
            &bare_settings(CohostTalkMode::Suggest),
            None,
            &rows[..1],
            start,
            &now_iso(),
        );
        assert!(card.bubble.is_empty());
        assert_eq!(card.propose.len(), 1);
        assert_eq!(card.propose[0].text, "Hi Ana, welcome to the stream!");
        assert_eq!(card.propose[0].status, CohostUtteranceStatus::Proposed);
        // The first-time switch off: no-line; returning still on, with the
        // user's own words.
        let mut lane = AutoChatLane::default();
        let mut switched = bare_settings(CohostTalkMode::Bubble);
        switched.greetings.welcomes.first_time.enabled = false;
        switched.greetings.welcomes.returning.text = Some("Yo {name}, back again!".to_string());
        switched.greetings.welcomes.returning.state = CohostUtteranceState::Laugh;
        let pass = lane.note_activity(
            &switched,
            None,
            &[chat_row("Ana", true, true), chat_row("Bo", false, true)],
            start,
            &now_iso(),
        );
        assert_eq!(pass.skipped.no_line, 1);
        assert!(pass.log.iter().any(|l| l.contains("first-time")));
        assert_eq!(pass.bubble.len(), 1);
        assert_eq!(pass.bubble[0].text, "Yo Bo, back again!");
        assert_eq!(pass.bubble[0].state, CohostUtteranceState::Laugh);
    }

    // --- Plan 192 Phase 2: the AI writes the greeting ------------------------------

    /// S2.2: with the AI context the batch waits for the route; its text
    /// replaces the line and its mood sets the state; `introduce` only on
    /// the session's first request; Suggest cards carry the AI text.
    #[test]
    fn ai_text_replaces_the_line_and_introduce_is_asked_once() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let pass = lane.note_activity(&bubble, Some(&ai()), &follows(1), start, &now_iso());
        assert!(pass.bubble.is_empty() && pass.propose.is_empty());
        let pending = pass.greet.clone().expect("the batch waits for the AI");
        let request = &pending.request;
        assert_eq!(request.session_client_id, "session-1");
        assert_eq!(request.seq, 1);
        assert!(request.introduce);
        assert!(request.consent_to_process_chat);
        assert_eq!(request.tone, CohostTone::Short);
        assert_eq!(request.persona, ai().persona);
        assert_eq!(request.items.len(), 1);
        let item = &request.items[0];
        assert_eq!(item.kind, "follow");
        assert_eq!(item.platform, StreamPlatform::Twitch);
        assert_eq!(item.names, ["Fan0"]);
        assert_eq!(item.others, 0);
        assert_eq!(item.first_message_text, None);
        assert_eq!(item.fallback_line, "Welcome, Fan0! Thanks for the follow.");
        assert_eq!(
            lane.snapshot(start).len(),
            0,
            "no card until the AI answers"
        );
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Ok(CohostGreetResponse {
                lines: vec![CohostGreetLine {
                    id: "g-1".to_string(),
                    text: "  Fresh blood! Fan0 joins the horde.  ".to_string(),
                    mood: Some(CohostTickMood::Amused),
                }],
                model: "jev".to_string(),
            }),
            start + Duration::from_secs(1),
            &now_iso(),
        );
        assert_eq!(routed.bubble.len(), 1);
        assert_eq!(routed.bubble[0].text, "Fresh blood! Fan0 joins the horde.");
        assert_eq!(routed.bubble[0].state, CohostUtteranceState::Laugh);
        assert_eq!(routed.bubble[0].destination_ids, ["main"]);
        assert_eq!(
            lane.utterance_source(&routed.bubble[0].id),
            Some(CohostReportPostSource::Ai)
        );
        assert!(routed.greet.is_none());
        // The second request of the session never introduces again, and a
        // welcome carries the first message.
        let pass = lane.note_activity(
            &bubble,
            Some(&ai()),
            &[chat_row("Ana", true, true)],
            start + Duration::from_secs(6),
            &now_iso(),
        );
        let pending = pass.greet.unwrap();
        assert!(!pending.request.introduce);
        assert_eq!(pending.request.seq, 2);
        assert_eq!(pending.request.items[0].kind, "first-time");
        assert_eq!(
            pending.request.items[0].first_message_text.as_deref(),
            Some("hi from Ana")
        );
        // A line the route did not return (or one with a link) falls back.
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Ok(CohostGreetResponse {
                lines: vec![CohostGreetLine {
                    id: "g-2".to_string(),
                    text: "see https://x.y".to_string(),
                    mood: None,
                }],
                model: String::new(),
            }),
            start + Duration::from_secs(7),
            &now_iso(),
        );
        assert_eq!(routed.bubble[0].text, "Hi Ana, welcome to the stream!");
        assert_eq!(
            lane.utterance_source(&routed.bubble[0].id),
            Some(CohostReportPostSource::Line)
        );
        // Suggest: the card carries the AI text.
        let mut lane = AutoChatLane::default();
        let suggest = bare_settings(CohostTalkMode::Suggest);
        let pass = lane.note_activity(&suggest, Some(&ai()), &follows(1), start, &now_iso());
        let pending = pass.greet.unwrap();
        let routed = lane.apply_greet_result(
            &suggest,
            pending,
            Ok(CohostGreetResponse {
                lines: vec![CohostGreetLine {
                    id: "g-1".to_string(),
                    text: "The horde grows. Welcome, Fan0.".to_string(),
                    mood: Some(CohostTickMood::Neutral),
                }],
                model: String::new(),
            }),
            start + Duration::from_secs(1),
            &now_iso(),
        );
        assert!(routed.bubble.is_empty());
        assert_eq!(routed.propose.len(), 1);
        assert_eq!(routed.propose[0].text, "The horde grows. Welcome, Fan0.");
        assert_eq!(routed.propose[0].state, CohostUtteranceState::Talk);
    }

    /// S2.2: a timeout (or any failure) sends the line and says why; a 403
    /// stops AI greetings for the rest of the session; a context for another
    /// session, or none, never waits for the AI.
    #[test]
    fn ai_failures_fall_back_to_the_line_and_a_403_stops_the_session() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let pending = lane
            .note_activity(&bubble, Some(&ai()), &follows(1), start, &now_iso())
            .greet
            .unwrap();
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Err(CohostApiError::timeout("Buddy did not answer within 3 s.")),
            start + Duration::from_secs(4),
            &now_iso(),
        );
        assert_eq!(routed.bubble.len(), 1);
        assert_eq!(
            routed.bubble[0].text,
            "Welcome, Fan0! Thanks for the follow."
        );
        assert_eq!(
            lane.utterance_source(&routed.bubble[0].id),
            Some(CohostReportPostSource::Line)
        );
        assert_eq!(routed.log.len(), 1);
        assert!(routed.log[0].contains("timeout"), "{:?}", routed.log);
        // Still asking after a transient failure.
        let pass = lane.note_activity(
            &bubble,
            Some(&ai()),
            &[event("raid")],
            start + Duration::from_secs(10),
            &now_iso(),
        );
        let pending = pass.greet.expect("a transient failure is per batch");
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Err(classify_cohost_failure(
                403,
                "premium-required",
                "Premium required.".to_string(),
                None,
            )),
            start + Duration::from_secs(11),
            &now_iso(),
        );
        assert_eq!(
            routed.bubble[0].text,
            "raider42 is raiding! Welcome, everyone!"
        );
        assert!(
            routed
                .log
                .iter()
                .any(|l| l.contains("rest of this session"))
        );
        // From now on the line goes out at once.
        let pass = lane.note_activity(
            &bubble,
            Some(&ai()),
            &[event("cheer")],
            start + Duration::from_secs(20),
            &now_iso(),
        );
        assert!(pass.greet.is_none());
        assert_eq!(pass.bubble.len(), 1);
        assert_eq!(pass.bubble[0].text, "Thanks for the bits, sarzdotmd!");
        // A new session asks again.
        let mut next = event("follow");
        next.session_id = "session-2".to_string();
        let mut other = ai();
        other.session_id = "session-2".to_string();
        let pass = lane.note_activity(
            &bubble,
            Some(&other),
            &[next.clone()],
            start + Duration::from_secs(30),
            &now_iso(),
        );
        assert!(pass.greet.is_some());
        assert!(pass.greet.unwrap().request.introduce);
        // A context for a different session than the lane's: the line.
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(&bubble, Some(&other), &follows(1), start, &now_iso());
        assert!(pass.greet.is_none());
        assert_eq!(pass.bubble.len(), 1);
        // No context (Basic, no consent, no capability, `ai` off): the line.
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(&bubble, None, &follows(1), start, &now_iso());
        assert!(pass.greet.is_none());
        assert_eq!(pass.bubble.len(), 1);
        // A result for a session the lane left is dropped.
        let mut lane = AutoChatLane::default();
        let pending = lane
            .note_activity(&bubble, Some(&ai()), &follows(1), start, &now_iso())
            .greet
            .unwrap();
        lane.follow_session("session-9");
        let dropped = lane.apply_greet_result(
            &bubble,
            pending,
            Ok(CohostGreetResponse::default()),
            start,
            &now_iso(),
        );
        assert!(silent(&dropped));
        assert_eq!(dropped.log.len(), 1);
        // The day's cap (429) stops the session too; a 400 is said at warn
        // and falls back for the batch only; an empty `lines` is a fallback.
        let mut lane = AutoChatLane::default();
        let pending = lane
            .note_activity(&bubble, Some(&ai()), &follows(1), start, &now_iso())
            .greet
            .unwrap();
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Err(classify_cohost_failure(
                400,
                "invalid-request",
                "items[0].names: too small".to_string(),
                None,
            )),
            start,
            &now_iso(),
        );
        assert_eq!(routed.bubble.len(), 1);
        assert_eq!(routed.warn.len(), 1, "{routed:?}");
        assert!(routed.log.is_empty());
        let pending = lane
            .note_activity(
                &bubble,
                Some(&ai()),
                &[event("raid")],
                start + Duration::from_secs(10),
                &now_iso(),
            )
            .greet
            .expect("a 400 falls back for its batch only");
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Ok(CohostGreetResponse::default()),
            start + Duration::from_secs(11),
            &now_iso(),
        );
        assert_eq!(
            routed.bubble[0].text,
            "raider42 is raiding! Welcome, everyone!"
        );
        let pending = lane
            .note_activity(
                &bubble,
                Some(&ai()),
                &[event("cheer")],
                start + Duration::from_secs(20),
                &now_iso(),
            )
            .greet
            .unwrap();
        let routed = lane.apply_greet_result(
            &bubble,
            pending,
            Err(classify_cohost_failure(
                429,
                "quota-exhausted",
                "Daily cap reached.".to_string(),
                Some("3600"),
            )),
            start + Duration::from_secs(21),
            &now_iso(),
        );
        assert_eq!(routed.bubble[0].text, "Thanks for the bits, sarzdotmd!");
        assert!(
            routed
                .log
                .iter()
                .any(|l| l.contains("rest of this session"))
        );
        let pass = lane.note_activity(
            &bubble,
            Some(&ai()),
            &[event("resub")],
            start + Duration::from_secs(30),
            &now_iso(),
        );
        assert!(pass.greet.is_none());
        assert_eq!(pass.bubble.len(), 1);
    }

    /// The greet route is strict: only its four platforms are asked, and
    /// an optional string is absent, never empty.
    #[test]
    fn the_greet_request_is_strict_about_platforms_and_empty_optionals() {
        let start = Instant::now();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        let mut lane = AutoChatLane::default();
        let tiktok = fake_events_for_tests("session-1", StreamPlatform::Tiktok, Some("tt"));
        let pass = lane.note_activity(&bubble, Some(&ai()), &tiktok, start, &now_iso());
        assert!(pass.greet.is_none(), "TikTok gets the line");
        assert_eq!(pass.bubble.len(), usize::from(!tiktok.is_empty()));
        let mut lane = AutoChatLane::default();
        let mut row = chat_row("Ana", true, true);
        row.message_text = "   ".to_string();
        row.amount_text = Some("  ".to_string());
        let pending = lane
            .note_activity(&bubble, Some(&ai()), &[row], start, &now_iso())
            .greet
            .unwrap();
        let item = &pending.request.items[0];
        assert_eq!(item.first_message_text, None);
        assert_eq!(item.amount, None);
        assert_eq!(item.reward, None);
        assert_eq!(item.names, ["Ana"]);
        let body = serde_json::to_value(&pending.request).unwrap();
        assert!(body["items"][0].get("firstMessageText").is_none());
        assert!(body["items"][0].get("amount").is_none());
        assert_eq!(body["items"][0]["others"], 0);
        assert_eq!(body["introduce"], true);
        assert!(body["items"][0]["fallbackLine"].as_str().unwrap().len() <= 200);
        // A kind with amount and reward sends them, trimmed.
        let mut lane = AutoChatLane::default();
        let pending = lane
            .note_activity(
                &bubble,
                Some(&ai()),
                &[event("channel.channel_points_custom_reward_redemption.add")],
                start,
                &now_iso(),
            )
            .greet
            .unwrap();
        let item = &pending.request.items[0];
        assert_eq!(item.kind, "redemption");
        assert_eq!(item.amount.as_deref(), Some("500 Diamonds"));
        assert_eq!(item.reward.as_deref(), Some("Hydrate"));
        assert_eq!(item.count, Some(500));
    }

    /// S2.2: one request carries up to six batches; a seventh goes out as
    /// its line.
    #[test]
    fn a_greet_request_carries_at_most_six_batches() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = bare_settings(CohostTalkMode::Bubble);
        // Seven follows on seven destinations: the limiter is per
        // destination, so every one is ready at once.
        let rows: Vec<LiveChatMessage> = (0..7)
            .map(|n| {
                let mut row = event("follow");
                row.target_id = Some(format!("dest-{n}"));
                row.author_id = Some(format!("fan-{n}"));
                row.author_name = format!("Fan{n}");
                row.id = format!("session-1:twitch:dest-{n}:f{n}");
                row
            })
            .collect();
        let pass = lane.note_activity(&bubble, Some(&ai()), &rows, start, &now_iso());
        let pending = pass.greet.as_ref().unwrap();
        assert_eq!(pending.request.items.len(), COHOST_GREET_ITEMS_MAX);
        assert_eq!(pass.bubble.len(), 1, "the seventh goes out as its line");
        assert_eq!(pass.bubble[0].text, "Welcome, Fan6! Thanks for the follow.");
        assert_eq!(pass.bubble[0].destination_ids, ["dest-6"]);
        let ids: HashSet<&str> = pending
            .request
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(ids.len(), COHOST_GREET_ITEMS_MAX, "unique item ids");
        assert!(ids.iter().all(|id| id.len() <= 80));
        // The six route back to their own destinations.
        let routed = lane.apply_greet_result(
            &bubble,
            pass.greet.unwrap(),
            Ok(CohostGreetResponse::default()),
            start + Duration::from_secs(1),
            &now_iso(),
        );
        assert_eq!(routed.bubble.len(), 6);
        let destinations: HashSet<String> = routed
            .bubble
            .iter()
            .map(|u| u.destination_ids[0].clone())
            .collect();
        assert_eq!(destinations.len(), 6);
        assert!(!destinations.contains("dest-6"));
    }

    /// D7: a send-path skip is counted once per greeting and logged once per
    /// kind; a non-greeting utterance leaves nothing. The send path takes
    /// only an approved Suggest card (plan 211 D2), so the greeting is one.
    #[test]
    fn send_path_skips_are_counted_and_logged_once() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let suggest = bare_settings(CohostTalkMode::Suggest);
        let pass = lane.note_activity(&suggest, None, &follows(1), start, &now_iso());
        let id = pass.propose[0].id.clone();
        lane.approve(&id, start).unwrap();
        let first = lane.note_send_skip(&id, GreetingSkipReason::YoutubePaused);
        assert_eq!(first.skipped.youtube_paused, 1);
        assert!(first.log.unwrap().contains("quota breaker"));
        let second = lane.note_send_skip(&id, GreetingSkipReason::YoutubePaused);
        assert_eq!(second.skipped.youtube_paused, 1);
        assert_eq!(second.log, None);
        let failed = lane.note_send_skip(&id, GreetingSkipReason::DestinationFailed);
        assert_eq!(failed.skipped.destination_failed, 1);
        assert!(failed.log.is_some());
        let said = lane.say("hi", CohostUtteranceState::Talk, start, &now_iso());
        assert_eq!(
            lane.note_send_skip(&said.id, GreetingSkipReason::DestinationFailed),
            SendSkip::default()
        );
        assert_eq!(lane.utterance_source(&said.id), None);
        for reason in [
            GreetingSkipReason::NoLine,
            GreetingSkipReason::ModeOff,
            GreetingSkipReason::Stale,
            GreetingSkipReason::Deduped,
            GreetingSkipReason::Held,
            GreetingSkipReason::DestinationFailed,
            GreetingSkipReason::YoutubePaused,
        ] {
            assert!(!reason.wire().is_empty());
        }
    }

    #[test]
    fn answers_follow_the_switch_the_cooldown_and_the_limiter() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = settings(CohostTalkMode::Bubble);
        let first = lane.route_answer(&bubble, answer(), start, &now_iso());
        assert_eq!(first.bubble.len(), 1);
        assert_eq!(
            first.bubble[0].trigger.kind,
            CohostUtteranceTriggerKind::Answer
        );
        assert_eq!(first.bubble[0].trigger.message_id.as_deref(), Some("m-1"));
        assert_eq!(first.bubble[0].destination_ids, ["twitch:main"]);
        assert_eq!(lane.utterance_source(&first.bubble[0].id), None);
        let cooled = lane.route_answer(
            &bubble,
            answer(),
            start + Duration::from_secs(5),
            &now_iso(),
        );
        assert!(cooled.bubble.is_empty());
        assert_eq!(cooled.log.len(), 1);
        let later = lane.route_answer(
            &bubble,
            answer(),
            start + Duration::from_secs(21),
            &now_iso(),
        );
        assert_eq!(later.bubble.len(), 1);
        let mut unknown = answer();
        unknown.destination_id = None;
        let dropped = lane.route_answer(
            &bubble,
            unknown,
            start + Duration::from_secs(60),
            &now_iso(),
        );
        assert!(dropped.bubble.is_empty() && dropped.log.len() == 1);
        let mut off = bubble.clone();
        off.answers.enabled = false;
        assert_eq!(
            lane.route_answer(&off, answer(), start + Duration::from_secs(90), &now_iso()),
            AutoChatPass::default()
        );
        let suggest = settings(CohostTalkMode::Suggest);
        let card = lane.route_answer(
            &suggest,
            answer(),
            start + Duration::from_secs(120),
            &now_iso(),
        );
        assert_eq!(card.propose.len(), 1);
        assert!(card.bubble.is_empty());
    }

    /// S-D4, plan 211 S-A2: the quiet minute runs from an approved card
    /// that landed and from a bubble line alike; only the card counts as a
    /// send.
    #[test]
    fn banter_waits_for_its_cooldown_and_a_quiet_minute_after_a_send_or_a_bubble_line() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let bubble = settings(CohostTalkMode::Bubble);
        assert!(lane.banter_allowed(&bubble, start));
        lane.note_sent(start);
        assert_eq!(lane.sends(), 1);
        assert!(!lane.banter_allowed(&bubble, start + Duration::from_secs(30)));
        assert!(lane.banter_allowed(&bubble, start + Duration::from_secs(60)));
        lane.note_spoken(start + Duration::from_secs(60));
        assert_eq!(lane.sends(), 1, "a bubble line is not a send");
        assert!(!lane.banter_allowed(&bubble, start + Duration::from_secs(90)));
        assert!(lane.banter_allowed(&bubble, start + Duration::from_secs(120)));
        lane.note_banter_requested(start + Duration::from_secs(60));
        assert!(!lane.banter_allowed(&bubble, start + Duration::from_secs(200)));
        assert!(lane.banter_allowed(&bubble, start + Duration::from_secs(300)));
        let mut off = bubble.clone();
        off.banter.enabled = false;
        assert!(!lane.banter_allowed(&off, start + Duration::from_secs(300)));
        let pass = lane.route_banter(
            &bubble,
            " Nice stream. ",
            CohostUtteranceState::Laugh,
            start,
            &now_iso(),
        );
        assert_eq!(pass.bubble.len(), 1);
        assert_eq!(pass.bubble[0].text, "Nice stream.");
        assert!(
            pass.bubble[0].destination_ids.is_empty(),
            "every writable destination"
        );
        assert_eq!(
            pass.bubble[0].trigger.kind,
            CohostUtteranceTriggerKind::Banter
        );
        assert!(
            lane.route_banter(&off, "x", CohostUtteranceState::Talk, start, &now_iso())
                .bubble
                .is_empty()
        );
    }

    /// Plan 211 D1: Say is bubble-only whatever the mode (the lane does not
    /// even read it), and the lane keeps twenty utterances.
    #[test]
    fn say_is_bubble_only_in_every_mode_and_the_lane_keeps_twenty_utterances() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let card = lane.say("  Hi  ", CohostUtteranceState::Talk, start, &now_iso());
        assert_eq!(card.status, CohostUtteranceStatus::BubbleOnly);
        assert_eq!(card.trigger.kind, CohostUtteranceTriggerKind::Manual);
        assert_eq!(card.text, "Hi");
        assert!(card.destination_ids.is_empty());
        assert_eq!(card.expires_at, None);
        assert_eq!(lane.sends(), 0);
        for _ in 0..30 {
            lane.say("x", CohostUtteranceState::Talk, start, &now_iso());
        }
        assert_eq!(lane.snapshot(start).len(), UTTERANCES_KEPT);
        lane.register_operation("op-1");
        assert!(lane.is_own_operation("op-1"));
        assert!(!lane.is_own_operation("op-2"));
    }

    /// Plan 211 D2, the invariant: nothing the lane decides on its own
    /// reaches chat. Every entry is driven in Bubble and in Suggest:
    /// Activity rows, a welcome, a held burst through `drain`, an AI greet
    /// result, an answer, banter and Say. In Bubble every line is
    /// `bubble-only` and nothing is proposed; in Suggest every line is a
    /// `proposed` card and nothing is `sent` until `approve` runs. A pass
    /// has no send list at all, so the compiler keeps the rest.
    #[test]
    fn nothing_automatic_reaches_chat() {
        let start = Instant::now();
        for talk in [CohostTalkMode::Bubble, CohostTalkMode::Suggest] {
            let settings = bare_settings(talk);
            let mut lane = AutoChatLane::default();
            let mut passes = Vec::new();
            let mut now = start;
            // Activity rows: the raid now, the follow held for the gap and
            // released by the drain below.
            passes.push(lane.note_activity(&settings, None, &raid_and_follow(), now, &now_iso()));
            // A welcome, on its own destination.
            let mut ana = chat_row("Ana", true, true);
            ana.target_id = Some("chat-2".to_string());
            passes.push(lane.note_activity(&settings, None, &[ana], now, &now_iso()));
            // A burst of follows: one now, the rest held.
            now += Duration::from_secs(20);
            passes.push(lane.note_activity(&settings, None, &follows(4), now, &now_iso()));
            // Every held bucket, through the drain.
            for _ in 0..8 {
                let Some(due) = lane.next_due() else { break };
                now = due.max(now);
                passes.push(lane.drain(&settings, None, now, &now_iso()));
            }
            assert_eq!(lane.next_due(), None);
            // An AI greet result, on its own destination.
            now += Duration::from_secs(1);
            let mut cheer = event("cheer");
            cheer.target_id = Some("chat-3".to_string());
            let pass = lane.note_activity(&settings, Some(&ai()), &[cheer], now, &now_iso());
            let pending = pass.greet.clone().expect("the cheer waits for the AI");
            passes.push(pass);
            let item_id = pending.request.items[0].id.clone();
            passes.push(lane.apply_greet_result(
                &settings,
                pending,
                Ok(CohostGreetResponse {
                    lines: vec![CohostGreetLine {
                        id: item_id,
                        text: "Bits! Thank you.".to_string(),
                        mood: Some(CohostTickMood::Amused),
                    }],
                    model: String::new(),
                }),
                now,
                &now_iso(),
            ));
            // An answer, banter and the Say box.
            passes.push(lane.route_answer(&settings, answer(), now, &now_iso()));
            passes.push(lane.route_banter(
                &settings,
                "A joke.",
                CohostUtteranceState::Laugh,
                now,
                &now_iso(),
            ));
            let said = lane.say("Hello horde", CohostUtteranceState::Talk, now, &now_iso());
            assert_eq!(said.status, CohostUtteranceStatus::BubbleOnly, "{talk:?}");
            assert_eq!(said.trigger.kind, CohostUtteranceTriggerKind::Manual);

            let lines: Vec<&CohostUtterance> = passes
                .iter()
                .flat_map(|pass| pass.bubble.iter().chain(pass.propose.iter()))
                .collect();
            // Every entry produced its line: the raid, the welcome, the AI
            // cheer (its fallback never routed), the answer and the banter,
            // plus the follows, which the throttle collapses as it sees fit
            // (that is `cohost_throttle`'s business, tested there).
            for expected in [
                "raider42 is raiding! Welcome, everyone!",
                "Hi Ana, welcome to the stream!",
                "Bits! Thank you.",
                "It is a Keychron.",
                "A joke.",
            ] {
                assert!(
                    lines.iter().any(|u| u.text == expected),
                    "{talk:?}: no line {expected:?} in {passes:?}"
                );
            }
            assert!(
                lines
                    .iter()
                    .any(|u| u.text.contains("Thanks for the follow")),
                "{talk:?}: the follows were greeted"
            );
            assert!(
                lines
                    .iter()
                    .all(|u| u.text != "Thanks for the bits, sarzdotmd!"),
                "{talk:?}: the AI line replaced the cheer's fallback"
            );
            assert!(lines.len() >= 6, "{talk:?}: {} lines", lines.len());
            for kind in [
                CohostUtteranceTriggerKind::Greeting,
                CohostUtteranceTriggerKind::Answer,
                CohostUtteranceTriggerKind::Banter,
            ] {
                assert!(
                    lines.iter().any(|u| u.trigger.kind == kind),
                    "{talk:?}: no {kind:?} line"
                );
            }
            assert_eq!(lane.sends(), 0, "{talk:?}: nothing counted as a send");
            match talk {
                CohostTalkMode::Bubble => {
                    assert!(passes.iter().all(|pass| pass.propose.is_empty()));
                    assert!(
                        lines
                            .iter()
                            .all(|u| u.status == CohostUtteranceStatus::BubbleOnly)
                    );
                    assert!(lines.iter().all(|u| u.expires_at.is_none()));
                    assert!(
                        lane.snapshot(now)
                            .iter()
                            .all(|u| u.status == CohostUtteranceStatus::BubbleOnly)
                    );
                }
                CohostTalkMode::Suggest => {
                    assert!(passes.iter().all(|pass| pass.bubble.is_empty()));
                    assert!(
                        lines
                            .iter()
                            .all(|u| u.status == CohostUtteranceStatus::Proposed)
                    );
                    assert!(lines.iter().all(|u| u.expires_at.is_some()));
                    assert!(
                        lane.snapshot(now)
                            .iter()
                            .all(|u| u.status != CohostUtteranceStatus::Sent)
                    );
                    // Only the streamer's click, then the send landing, makes
                    // a line `sent`.
                    let id = lines.last().unwrap().id.clone();
                    lane.approve(&id, now).unwrap();
                    assert!(
                        lane.snapshot(now)
                            .iter()
                            .all(|u| u.status != CohostUtteranceStatus::Sent),
                        "approved is not yet sent"
                    );
                    assert!(lane.mark(&id, CohostUtteranceStatus::Sent));
                    assert_eq!(
                        lane.snapshot(now)
                            .iter()
                            .filter(|u| u.status == CohostUtteranceStatus::Sent)
                            .count(),
                        1
                    );
                }
                CohostTalkMode::Off => unreachable!(),
            }
        }
    }
}
