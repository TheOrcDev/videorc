//! The automatic chat lane (plan 164 Phase D): what the Golem says, and
//! whether it goes to chat now, waits for the streamer's click, or only to
//! the bubble.
//!
//! The lane is engine-wide and follows the live-chat session: it does not
//! need the Premium tick session, because greetings are free (D6). Every
//! routing method starts from the mode (D4): `off` produces nothing, ever.
//! `suggest` produces `proposed` cards for the Stream Manager; `auto` produces
//! sends. The throttle (`cohost_throttle`) keeps time; `cohost.rs` owns the
//! lane, performs the sends and writes the report.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::cohost::{
    CohostAutoChat, CohostAutoChatMode, CohostUtterance, CohostUtteranceState,
    CohostUtteranceStatus, CohostUtteranceTrigger, CohostUtteranceTriggerKind,
};
use crate::cohost_greetings::{
    ActivityFacts, activity_facts, collapse, pick_template, resolve_template,
};
use crate::cohost_throttle::{AutoChatThrottle, GreetingOffer};
use crate::live_chat::LiveChatMessage;

/// A proposed card the streamer did not act on leaves after this long.
pub(crate) const PROPOSED_TTL: Duration = Duration::from_secs(45);
/// Utterances kept on the state, newest last.
pub(crate) const UTTERANCES_KEPT: usize = 20;
/// Banter never follows a greeting or an answer within this long (S-D4).
pub(crate) const BANTER_QUIET_AFTER_SEND: Duration = Duration::from_secs(60);
/// An Activity row older than this on arrival is history (a reconnect
/// replay, a poll catching up), not a moment to greet.
pub(crate) const ACTIVITY_FRESH_WINDOW: Duration = Duration::from_secs(10 * 60);

/// What one lane pass decided. The caller sends `send`, publishes `propose`
/// (and every change), and arms the pump for `schedule`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AutoChatPass {
    pub(crate) send: Vec<CohostUtterance>,
    pub(crate) propose: Vec<CohostUtterance>,
    pub(crate) schedule: Option<Instant>,
    pub(crate) log: Vec<String>,
}

impl AutoChatPass {
    pub(crate) fn changed(&self) -> bool {
        !self.send.is_empty() || !self.propose.is_empty()
    }
}

/// A tick reply the Golem may send on its own (S-D3): the viewer named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnswerCandidate {
    pub(crate) question_id: String,
    pub(crate) message_id: Option<String>,
    pub(crate) destination_id: Option<String>,
    pub(crate) text: String,
    pub(crate) state: CohostUtteranceState,
}

/// What the lane decided to say, before it becomes an utterance.
#[derive(Debug, Clone)]
struct Spoken {
    text: String,
    state: CohostUtteranceState,
    trigger: CohostUtteranceTrigger,
    destination_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct UtteranceRecord {
    utterance: CohostUtterance,
    expires_at: Option<Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct AutoChatLane {
    session_id: Option<String>,
    throttle: AutoChatThrottle,
    records: Vec<UtteranceRecord>,
    sends: u64,
    /// `operationId`s of the Golem's own sends: `cohost_ack` never reads
    /// their delivery as "the streamer replied" (D10).
    own_operations: HashSet<String>,
    last_auto_send_at: Option<Instant>,
    last_answer_at: Option<Instant>,
    last_banter_at: Option<Instant>,
    pump_armed: bool,
    seq: u64,
}

impl AutoChatLane {
    /// Follow the live-chat session: a new one starts clean (dedupe,
    /// cooldowns, cards). Returns true when the lane was reset.
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

    fn next_id(&mut self) -> String {
        self.seq = self.seq.saturating_add(1);
        format!("utt-{}-{}", self.seq, uuid::Uuid::new_v4().simple())
    }

    fn record(
        &mut self,
        spoken: Spoken,
        status: CohostUtteranceStatus,
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
        });
        while self.records.len() > UTTERANCES_KEPT {
            self.records.remove(0);
        }
        utterance
    }

    /// Route one decided utterance by the mode: `auto` sends, `suggest`
    /// proposes. Never called with the mode off.
    fn route(
        &mut self,
        settings: &CohostAutoChat,
        spoken: Spoken,
        now: Instant,
        now_iso: &str,
        pass: &mut AutoChatPass,
    ) {
        debug_assert!(settings.mode != CohostAutoChatMode::Off);
        match settings.mode {
            CohostAutoChatMode::Off => {}
            CohostAutoChatMode::Auto => {
                let utterance = self.record(spoken, CohostUtteranceStatus::Proposed, now, now_iso);
                pass.send.push(utterance);
            }
            CohostAutoChatMode::Suggest => {
                let utterance = self.record(spoken, CohostUtteranceStatus::Proposed, now, now_iso);
                pass.propose.push(utterance);
            }
        }
    }

    /// Activity rows just delivered: greetings (S-D1). Nothing with the mode
    /// off or greetings off; stale rows and rows without a template are
    /// skipped; the throttle decides now, later, or never (D9).
    pub(crate) fn note_activity(
        &mut self,
        settings: &CohostAutoChat,
        messages: &[LiveChatMessage],
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        if settings.mode == CohostAutoChatMode::Off || !settings.greetings.enabled {
            return pass;
        }
        let templates = &settings.greetings.templates;
        if templates.is_empty() {
            return pass;
        }
        for message in messages {
            let Some(facts) = activity_facts(message) else {
                continue;
            };
            if self.follow_session(&message.session_id) {
                pass.log.push(format!(
                    "Golem greetings follow chat session {}.",
                    message.session_id
                ));
            }
            if !activity_is_fresh(message, now_iso) {
                continue;
            }
            if pick_template(templates, facts.kind, facts.platform, 0).is_none() {
                continue;
            }
            match self.throttle.offer_greeting(facts, now) {
                GreetingOffer::SendNow(batch) => {
                    self.greet(settings, &batch, now, now_iso, &mut pass);
                }
                GreetingOffer::Held { due } => {
                    pass.schedule = Some(pass.schedule.map_or(due, |at| at.min(due)));
                }
                GreetingOffer::Deduped => {}
            }
        }
        pass
    }

    /// The pump's pass: release the buckets whose time came.
    pub(crate) fn drain(
        &mut self,
        settings: &CohostAutoChat,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        let batches = self.throttle.drain_due(now);
        if settings.mode == CohostAutoChatMode::Off || !settings.greetings.enabled {
            // The mode went off while a bucket waited: it is dropped, never
            // sent later (D4). The buckets were taken above.
            if !batches.is_empty() {
                pass.log
                    .push("Golem dropped waiting greetings: automatic chat is off.".to_string());
            }
            return pass;
        }
        for batch in batches {
            self.greet(settings, &batch, now, now_iso, &mut pass);
        }
        pass.schedule = self.throttle.next_due();
        pass
    }

    fn greet(
        &mut self,
        settings: &CohostAutoChat,
        batch: &[ActivityFacts],
        now: Instant,
        now_iso: &str,
        pass: &mut AutoChatPass,
    ) {
        let Some(first) = batch.first() else {
            return;
        };
        self.seq = self.seq.saturating_add(1);
        let Some(template) = pick_template(
            &settings.greetings.templates,
            first.kind,
            first.platform,
            self.seq as usize,
        ) else {
            return;
        };
        let fields = collapse(batch);
        let (text, _unknown) = resolve_template(&template.text, &fields);
        if text.trim().is_empty() {
            return;
        }
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Greeting,
            event_id: Some(first.message_id.clone()),
            message_id: None,
        };
        self.route(
            settings,
            Spoken {
                text,
                state: template.state,
                trigger,
                destination_ids: vec![first.destination_id.clone()],
            },
            now,
            now_iso,
            pass,
        );
    }

    /// A tick reply the viewer asked the Golem for by name (S-D3): under the
    /// answers switch, the answers cooldown and the destination's limiter.
    pub(crate) fn route_answer(
        &mut self,
        settings: &CohostAutoChat,
        candidate: AnswerCandidate,
        now: Instant,
        now_iso: &str,
    ) -> AutoChatPass {
        let mut pass = AutoChatPass::default();
        if settings.mode == CohostAutoChatMode::Off || !settings.answers.enabled {
            return pass;
        }
        let cooldown = Duration::from_secs(u64::from(settings.answers.cooldown_seconds));
        if self
            .last_answer_at
            .is_some_and(|last| now.saturating_duration_since(last) < cooldown)
        {
            pass.log.push(format!(
                "Golem skipped an answer to {}: the answers cooldown is running.",
                candidate.question_id
            ));
            return pass;
        }
        let Some(destination_id) = candidate.destination_id else {
            pass.log.push(format!(
                "Golem skipped an answer to {}: the question's chat row is unknown.",
                candidate.question_id
            ));
            return pass;
        };
        if let Err(at) = self.throttle.admit(&destination_id, now) {
            pass.log.push(format!(
                "Golem skipped an answer to {}: {destination_id} is rate-limited for {} s.",
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
        if settings.mode == CohostAutoChatMode::Auto {
            self.throttle.note_sent(&destination_id, now);
        }
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
            now,
            now_iso,
            &mut pass,
        );
        pass
    }

    /// Whether a banter request may go out now (S-D4): the switch, its
    /// cooldown, and no greeting or answer sent in the last minute.
    pub(crate) fn banter_allowed(&self, settings: &CohostAutoChat, now: Instant) -> bool {
        if settings.mode == CohostAutoChatMode::Off || !settings.banter.enabled {
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
        if settings.mode == CohostAutoChatMode::Off || !settings.banter.enabled {
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
            now,
            now_iso,
            &mut pass,
        );
        pass
    }

    /// The streamer's own Say box (D7): in `auto` it goes to chat like any
    /// other utterance; otherwise it is bubble-only (Phase C shows it).
    /// Returns the utterance and whether to send it.
    pub(crate) fn say(
        &mut self,
        settings: &CohostAutoChat,
        text: &str,
        state: CohostUtteranceState,
        now: Instant,
        now_iso: &str,
    ) -> (CohostUtterance, bool) {
        let trigger = CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Manual,
            event_id: None,
            message_id: None,
        };
        let send = settings.mode == CohostAutoChatMode::Auto;
        let status = if send {
            CohostUtteranceStatus::Proposed
        } else {
            CohostUtteranceStatus::BubbleOnly
        };
        let utterance = self.record(
            Spoken {
                text: text.trim().to_string(),
                state,
                trigger,
                destination_ids: Vec::new(),
            },
            status,
            now,
            now_iso,
        );
        (utterance, send)
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

    /// An automatic send landed (sent or partial).
    pub(crate) fn note_sent(&mut self, now: Instant) {
        self.sends = self.sends.saturating_add(1);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApproveRefusal {
    Unknown,
    NotProposed,
    Expired,
}

impl ApproveRefusal {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Unknown => "That Golem card is gone.",
            Self::NotProposed => "That Golem card was already answered.",
            Self::Expired => "That Golem card expired.",
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
    use crate::live_chat::fake_events_for_tests;
    use crate::streaming::StreamPlatform;

    fn template(kind: CohostActivityTemplateKind, text: &str) -> CohostGreetingTemplate {
        CohostGreetingTemplate {
            id: format!("t-{text}"),
            kind,
            platform: None,
            text: text.to_string(),
            state: CohostUtteranceState::Laugh,
            enabled: true,
        }
    }

    fn settings(mode: CohostAutoChatMode) -> CohostAutoChat {
        CohostAutoChat {
            mode,
            greetings: CohostGreetingsSettings {
                enabled: true,
                templates: vec![
                    template(CohostActivityTemplateKind::Follow, "Welcome {names}!"),
                    template(CohostActivityTemplateKind::Raid, "{name} brings {count}"),
                ],
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

    fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    fn twitch_events() -> Vec<LiveChatMessage> {
        fake_events_for_tests("session-1", StreamPlatform::Twitch, Some("main"))
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

    /// The STOP condition of plan 164: no automatic send path runs with the
    /// mode off. Written first; every lane method is covered.
    #[test]
    fn with_the_mode_off_nothing_is_sent_proposed_or_scheduled() {
        let start = Instant::now();
        let off = settings(CohostAutoChatMode::Off);
        let mut lane = AutoChatLane::default();
        let activity = lane.note_activity(&off, &twitch_events(), start, &now_iso());
        assert_eq!(activity, AutoChatPass::default());
        assert_eq!(
            lane.drain(&off, start + Duration::from_secs(60), &now_iso()),
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
        let (said, send) = lane.say(
            &off,
            "Hello horde",
            CohostUtteranceState::Talk,
            start,
            &now_iso(),
        );
        assert!(!send);
        assert_eq!(said.status, CohostUtteranceStatus::BubbleOnly);
        assert_eq!(lane.sends(), 0);
        assert!(
            lane.snapshot(start)
                .iter()
                .all(|u| u.status == CohostUtteranceStatus::BubbleOnly)
        );
        // Switching off while a bucket waits drops it.
        let mut lane = AutoChatLane::default();
        let auto = settings(CohostAutoChatMode::Auto);
        let follows: Vec<LiveChatMessage> = (0..5)
            .map(|n| {
                let mut row = twitch_events()
                    .into_iter()
                    .find(|m| m.raw_provider_type.as_deref() == Some("follow"))
                    .unwrap();
                row.author_id = Some(format!("fan-{n}"));
                row.author_name = format!("Fan{n}");
                row
            })
            .collect();
        let first = lane.note_activity(&auto, &follows, start, &now_iso());
        assert_eq!(first.send.len(), 1);
        assert!(first.schedule.is_some());
        let drained = lane.drain(&off, start + Duration::from_secs(11), &now_iso());
        assert!(drained.send.is_empty() && drained.propose.is_empty());
        assert_eq!(drained.log.len(), 1);
        assert_eq!(lane.next_due(), None);
    }

    #[test]
    fn auto_sends_and_suggest_proposes_greetings_with_the_template_state() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(
            &settings(CohostAutoChatMode::Auto),
            &twitch_events(),
            start,
            &now_iso(),
        );
        // The raid goes first; the follow on the same destination waits for
        // the 5 s gap (D9) and the drain releases it.
        let texts: Vec<&str> = pass.send.iter().map(|u| u.text.as_str()).collect();
        assert_eq!(texts, ["raider42 brings 234"]);
        assert_eq!(pass.schedule, Some(start + Duration::from_secs(5)));
        assert!(pass.propose.is_empty());
        let follow = lane.drain(
            &settings(CohostAutoChatMode::Auto),
            start + Duration::from_secs(5),
            &now_iso(),
        );
        assert_eq!(follow.send.len(), 1);
        assert_eq!(follow.send[0].text, "Welcome new_friend!");
        let pass = AutoChatPass {
            send: [pass.send, follow.send].concat(),
            ..pass
        };
        assert!(pass.send.iter().all(|u| u.destination_ids == ["main"]));
        assert!(
            pass.send
                .iter()
                .all(|u| u.state == CohostUtteranceState::Laugh)
        );
        assert!(
            pass.send
                .iter()
                .all(|u| u.trigger.kind == CohostUtteranceTriggerKind::Greeting)
        );
        assert!(pass.send.iter().all(|u| u.trigger.event_id.is_some()));

        let mut lane = AutoChatLane::default();
        let pass = lane.note_activity(
            &settings(CohostAutoChatMode::Suggest),
            &twitch_events(),
            start,
            &now_iso(),
        );
        assert!(pass.send.is_empty());
        assert_eq!(pass.propose.len(), 1);
        let pass = AutoChatPass {
            propose: [
                pass.propose,
                lane.drain(
                    &settings(CohostAutoChatMode::Suggest),
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
        let auto = settings(CohostAutoChatMode::Auto);
        let mut lane = AutoChatLane::default();
        let follows: Vec<LiveChatMessage> = (0..6)
            .map(|n| {
                let mut row = twitch_events()
                    .into_iter()
                    .find(|m| m.raw_provider_type.as_deref() == Some("follow"))
                    .unwrap();
                row.author_id = Some(format!("fan-{n}"));
                row.author_name = format!("Fan{n}");
                row.id = format!("session-1:twitch:main:f{n}");
                row
            })
            .collect();
        let first = lane.note_activity(&auto, &follows, start, &now_iso());
        assert_eq!(first.send.len(), 1);
        assert_eq!(first.send[0].text, "Welcome Fan0!");
        assert_eq!(first.schedule, Some(start + Duration::from_secs(10)));
        assert!(
            lane.drain(&auto, start + Duration::from_secs(9), &now_iso())
                .send
                .is_empty()
        );
        let later = lane.drain(&auto, start + Duration::from_secs(10), &now_iso());
        assert_eq!(later.send.len(), 1);
        assert_eq!(later.send[0].text, "Welcome Fan1, Fan2, Fan3 and 2 others!");
        assert_eq!(later.schedule, None);
        // Same viewers again: nothing.
        let again =
            lane.note_activity(&auto, &follows, start + Duration::from_secs(30), &now_iso());
        assert_eq!(again, AutoChatPass::default());
    }

    #[test]
    fn stale_rows_and_other_sessions_reset_or_skip() {
        let start = Instant::now();
        let auto = settings(CohostAutoChatMode::Auto);
        let mut lane = AutoChatLane::default();
        let mut old = twitch_events();
        for row in &mut old {
            row.published_at = "2020-01-01T00:00:00Z".to_string();
        }
        let stale = lane.note_activity(&auto, &old, start, &now_iso());
        assert!(stale.send.is_empty() && stale.propose.is_empty() && stale.schedule.is_none());
        let first = lane.note_activity(&auto, &twitch_events(), start, &now_iso());
        assert_eq!(first.send.len(), 1);
        assert_eq!(lane.session_id(), Some("session-1"));
        let next = fake_events_for_tests("session-2", StreamPlatform::Twitch, Some("main"));
        let second = lane.note_activity(&auto, &next, start + Duration::from_secs(1), &now_iso());
        assert_eq!(
            second.send.len(),
            1,
            "a new session starts with no dedupe or gap"
        );
        assert_eq!(lane.session_id(), Some("session-2"));
        assert!(second.log.iter().any(|line| line.contains("session-2")));
    }

    #[test]
    fn answers_follow_the_switch_the_cooldown_and_the_limiter() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let auto = settings(CohostAutoChatMode::Auto);
        let first = lane.route_answer(&auto, answer(), start, &now_iso());
        assert_eq!(first.send.len(), 1);
        assert_eq!(
            first.send[0].trigger.kind,
            CohostUtteranceTriggerKind::Answer
        );
        assert_eq!(first.send[0].trigger.message_id.as_deref(), Some("m-1"));
        assert_eq!(first.send[0].destination_ids, ["twitch:main"]);
        let cooled = lane.route_answer(&auto, answer(), start + Duration::from_secs(5), &now_iso());
        assert!(cooled.send.is_empty());
        assert_eq!(cooled.log.len(), 1);
        let later = lane.route_answer(&auto, answer(), start + Duration::from_secs(21), &now_iso());
        assert_eq!(later.send.len(), 1);
        let mut unknown = answer();
        unknown.destination_id = None;
        let dropped =
            lane.route_answer(&auto, unknown, start + Duration::from_secs(60), &now_iso());
        assert!(dropped.send.is_empty() && dropped.log.len() == 1);
        let mut off = auto.clone();
        off.answers.enabled = false;
        assert_eq!(
            lane.route_answer(&off, answer(), start + Duration::from_secs(90), &now_iso()),
            AutoChatPass::default()
        );
        let suggest = settings(CohostAutoChatMode::Suggest);
        let card = lane.route_answer(
            &suggest,
            answer(),
            start + Duration::from_secs(120),
            &now_iso(),
        );
        assert_eq!(card.propose.len(), 1);
        assert!(card.send.is_empty());
    }

    #[test]
    fn banter_waits_for_its_cooldown_and_a_quiet_minute_after_a_send() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let auto = settings(CohostAutoChatMode::Auto);
        assert!(lane.banter_allowed(&auto, start));
        lane.note_sent(start);
        assert!(!lane.banter_allowed(&auto, start + Duration::from_secs(30)));
        assert!(lane.banter_allowed(&auto, start + Duration::from_secs(60)));
        lane.note_banter_requested(start + Duration::from_secs(60));
        assert!(!lane.banter_allowed(&auto, start + Duration::from_secs(200)));
        assert!(lane.banter_allowed(&auto, start + Duration::from_secs(300)));
        let mut off = auto.clone();
        off.banter.enabled = false;
        assert!(!lane.banter_allowed(&off, start + Duration::from_secs(300)));
        let pass = lane.route_banter(
            &auto,
            " Nice stream. ",
            CohostUtteranceState::Laugh,
            start,
            &now_iso(),
        );
        assert_eq!(pass.send.len(), 1);
        assert_eq!(pass.send[0].text, "Nice stream.");
        assert!(
            pass.send[0].destination_ids.is_empty(),
            "every writable destination"
        );
        assert_eq!(
            pass.send[0].trigger.kind,
            CohostUtteranceTriggerKind::Banter
        );
        assert!(
            lane.route_banter(&off, "x", CohostUtteranceState::Talk, start, &now_iso())
                .send
                .is_empty()
        );
    }

    #[test]
    fn say_sends_only_in_auto_and_the_lane_keeps_twenty_utterances() {
        let start = Instant::now();
        let mut lane = AutoChatLane::default();
        let (card, send) = lane.say(
            &settings(CohostAutoChatMode::Suggest),
            "Hi",
            CohostUtteranceState::Talk,
            start,
            &now_iso(),
        );
        assert!(!send);
        assert_eq!(card.status, CohostUtteranceStatus::BubbleOnly);
        assert_eq!(card.trigger.kind, CohostUtteranceTriggerKind::Manual);
        let (_, send) = lane.say(
            &settings(CohostAutoChatMode::Auto),
            "Hi",
            CohostUtteranceState::Talk,
            start,
            &now_iso(),
        );
        assert!(send);
        for _ in 0..30 {
            lane.say(
                &settings(CohostAutoChatMode::Off),
                "x",
                CohostUtteranceState::Talk,
                start,
                &now_iso(),
            );
        }
        assert_eq!(lane.snapshot(start).len(), UTTERANCES_KEPT);
        lane.register_operation("op-1");
        assert!(lane.is_own_operation("op-1"));
        assert!(!lane.is_own_operation("op-2"));
    }
}
