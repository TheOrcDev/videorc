//! The Buddy on stream (plan 164, Phase C): the avatar's state machine and its
//! comic bubble, and the per-target bubble slot the compositor blits.
//!
//! Since plan 168 Phase B the backend draws the pet itself (`buddy_sprite`);
//! the renderer rasterizes the bubble only, per output canvas, and pushes it
//! through `buddy.overlay.set` (`buddy.overlay.clear` when it ends). The
//! compositor anchors the bubble above the pet's head (D16). The backend owns
//! WHICH state shows and for how long. Every bubble, manual (the Say box through
//! `cohost.utterance.say`) or automatic (Phase D's greetings, answers and
//! banter), enters through [`show_bubble`], which is the one way a bubble
//! appears; [`show_for_utterance`] is the gate in front of it (which statuses
//! bubble, and nothing while the Buddy is on no output). The state travels to
//! every window as the `cohost.buddy.state` event.
//!
//! Transitions (D18): `idle` → (`think` while an answer is pending, optional)
//! → `talk` / `laugh` / `think` while a bubble is up → `idle` when it ends. A
//! new bubble replaces the current one (a laugh overrides a talk); the expiry
//! of a replaced bubble is a no-op.
//!
//! Plan 211 D7: Buddy's own lines (greetings, answers, banter, a Suggest card
//! that landed) enter through [`queue_for_utterance`], a bounded queue in
//! front of `show_bubble`: a line waits for the bubble that is up to end plus
//! [`BUDDY_BUBBLE_GAP`], at most [`BUDDY_BUBBLE_QUEUE_MAX`] wait, and a line
//! that waited [`BUDDY_BUBBLE_QUEUE_MAX_WAIT`] is dropped. The streamer's own
//! Say line ([`show_for_utterance`]) still shows at once and replaces
//! whatever is up; the queue resumes after it. The queue is state in the same
//! machine, pure and clock-injected; the render-side snapshot is untouched.
//! Every text is clipped to [`BUDDY_SAY_MAX_CHARS`] at a word boundary
//! ([`clip_bubble_text`]) before it shows, so a long answer shows instead of
//! vanishing.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::buddy_animator::BuddyAnimatorEvent;
use crate::captions::{
    CaptionOverlaySlots, CaptionOverlayTarget, CaptionOverlayTargetsInfo, OverlayFallbackPlacement,
    OverlayPlacement,
};
use crate::cohost::{
    CohostAvatarState, CohostUtterance, CohostUtteranceState, CohostUtteranceStatus,
    CohostUtteranceTriggerKind,
};
use crate::overlay_layout::{OverlayItem, OverlayRect, OverlaySnap, load_overlay_layout};
use crate::protocol::CohostReportPostSource;
use crate::state::AppState;

/// Event every renderer receives when the Buddy's state or bubble changes.
pub const BUDDY_STATE_EVENT: &str = "cohost.buddy.state";
/// A bubble stays at least this long (D17).
pub const BUDDY_BUBBLE_MIN: Duration = Duration::from_millis(2500);
/// ... plus this much per character ...
pub const BUDDY_BUBBLE_PER_CHAR: Duration = Duration::from_millis(60);
/// ... and never longer than this.
pub const BUDDY_BUBBLE_MAX: Duration = Duration::from_secs(10);
/// Plan 211 D7: a queued line waits for the current bubble's end plus this.
pub const BUDDY_BUBBLE_GAP: Duration = Duration::from_millis(500);
/// At most this many of Buddy's lines wait; a further one is dropped.
pub const BUDDY_BUBBLE_QUEUE_MAX: usize = 3;
/// A line that waited this long is dropped: the moment has passed.
pub const BUDDY_BUBBLE_QUEUE_MAX_WAIT: Duration = Duration::from_secs(20);

/// `max(2.5 s, 0.06 s × characters)`, capped at 10 s (D17).
pub fn buddy_bubble_duration(text: &str) -> Duration {
    let per_text = BUDDY_BUBBLE_PER_CHAR.saturating_mul(text.chars().count() as u32);
    per_text.max(BUDDY_BUBBLE_MIN).min(BUDDY_BUBBLE_MAX)
}

impl From<CohostUtteranceState> for CohostAvatarState {
    fn from(state: CohostUtteranceState) -> Self {
        match state {
            CohostUtteranceState::Talk => CohostAvatarState::Talk,
            CohostUtteranceState::Laugh => CohostAvatarState::Laugh,
            CohostUtteranceState::Think => CohostAvatarState::Think,
        }
    }
}

/// The bubble on the wire: its text and when it ends (RFC 3339).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyBubble {
    pub text: String,
    pub until: String,
}

/// `cohost.buddy.state`: `{ personaId, state, bubble: { text, until } | null }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyOverlaySnapshot {
    pub persona_id: String,
    pub state: CohostAvatarState,
    pub bubble: Option<BuddyBubble>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuddyBubbleRecord {
    text: String,
    until: DateTime<Utc>,
    generation: u64,
}

/// One of Buddy's own lines waiting for the bubble (plan 211 D7). The text
/// is already clipped and validated; `source` is who wrote a greeting, for
/// the report when the line shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedBubble {
    pub utterance: CohostUtterance,
    pub source: Option<CohostReportPostSource>,
    pub queued_at: DateTime<Utc>,
}

/// What the queue said to an offered line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BubbleOffer {
    /// Nothing is up and nothing waits: show it now.
    ShowNow,
    /// It waits. `arm` is when the pump must run, or `None` when a pump is
    /// already armed for an earlier line.
    Queued { arm: Option<DateTime<Utc>> },
    /// The queue is full: the line is dropped (counted stale). `log` carries
    /// the one line a session says so.
    Dropped { log: Option<String> },
}

/// What one pump pass decided: the line to show now (none while a bubble is
/// up), when to run again, and the lines that waited too long.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BubblePump {
    pub show: Option<QueuedBubble>,
    pub arm: Option<DateTime<Utc>>,
    pub dropped: Vec<QueuedBubble>,
    pub log: Option<String>,
}

/// The state machine. Pure and clock-injected; the runtime below owns the
/// lock, the event and the expiry timer. Since plan 211 D7 it also keeps
/// the queue of Buddy's own lines waiting for the bubble; the snapshot the
/// renderers and the compositor read is unchanged by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuddyOverlayState {
    persona_id: String,
    state: CohostAvatarState,
    bubble: Option<BuddyBubbleRecord>,
    generation: u64,
    /// Buddy's lines waiting for the bubble, oldest first (plan 211 D7).
    waiting: VecDeque<QueuedBubble>,
    /// When the armed pump wakes; `None` while none is armed.
    pump_due: Option<DateTime<Utc>>,
    /// Lines dropped this session (full queue, or waited too long), and
    /// whether that was logged yet (once a session).
    dropped: u64,
    drop_logged: bool,
}

impl BuddyOverlayState {
    pub fn new(persona_id: impl Into<String>) -> Self {
        Self {
            persona_id: persona_id.into(),
            state: CohostAvatarState::Idle,
            bubble: None,
            generation: 0,
            waiting: VecDeque::new(),
            pump_due: None,
            dropped: 0,
            drop_logged: false,
        }
    }

    /// When the bubble that is up ends, or `None` when none is (a bubble
    /// whose time passed counts as gone, even before its expiry ran).
    fn busy_until(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.bubble
            .as_ref()
            .map(|bubble| bubble.until)
            .filter(|until| *until > now)
    }

    /// Lines waiting for the bubble.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }

    /// Lines dropped this session.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    fn drop_log(&mut self, what: &str) -> Option<String> {
        if self.drop_logged {
            return None;
        }
        self.drop_logged = true;
        Some(format!(
            "Buddy dropped a waiting bubble line ({what}). A line waits for the bubble at most {} s and at most {} wait; this is logged once a session.",
            BUDDY_BUBBLE_QUEUE_MAX_WAIT.as_secs(),
            BUDDY_BUBBLE_QUEUE_MAX
        ))
    }

    /// Offer one of Buddy's own lines (plan 211 D7): shown now when nothing
    /// is up and nothing waits, else queued behind the current bubble (its
    /// end plus [`BUDDY_BUBBLE_GAP`]), else dropped when
    /// [`BUDDY_BUBBLE_QUEUE_MAX`] already wait. `ShowNow` leaves the show to
    /// the caller, under the same lock, so nothing slips in between.
    pub fn offer(&mut self, line: QueuedBubble, now: DateTime<Utc>) -> BubbleOffer {
        let busy_until = self.busy_until(now);
        if busy_until.is_none() && self.waiting.is_empty() {
            return BubbleOffer::ShowNow;
        }
        if self.waiting.len() >= BUDDY_BUBBLE_QUEUE_MAX {
            self.dropped = self.dropped.saturating_add(1);
            let log = self.drop_log("the queue is full");
            return BubbleOffer::Dropped { log };
        }
        self.waiting.push_back(line);
        let due = busy_until.map_or(now, |until| until + gap());
        let arm = match self.pump_due {
            Some(_) => None,
            None => {
                self.pump_due = Some(due);
                Some(due)
            }
        };
        BubbleOffer::Queued { arm }
    }

    /// The pump woke: drop the lines that waited [`BUDDY_BUBBLE_QUEUE_MAX_WAIT`]
    /// (the moment has passed), then the oldest line shows when nothing is
    /// up, or the pump re-arms for the current bubble's end plus the gap (a
    /// Say line pre-empted it). The caller shows `show` under the same lock
    /// and then asks [`arm_for_next`](Self::arm_for_next).
    pub fn pump(&mut self, now: DateTime<Utc>) -> BubblePump {
        self.pump_due = None;
        let mut out = BubblePump::default();
        let max_wait = chrono::Duration::from_std(BUDDY_BUBBLE_QUEUE_MAX_WAIT)
            .unwrap_or_else(|_| chrono::Duration::seconds(20));
        while self
            .waiting
            .front()
            .is_some_and(|line| now.signed_duration_since(line.queued_at) >= max_wait)
        {
            if let Some(line) = self.waiting.pop_front() {
                out.dropped.push(line);
            }
        }
        if !out.dropped.is_empty() {
            self.dropped = self.dropped.saturating_add(out.dropped.len() as u64);
            out.log = self.drop_log("it waited too long");
        }
        if self.waiting.is_empty() {
            return out;
        }
        if let Some(until) = self.busy_until(now) {
            let due = until + gap();
            self.pump_due = Some(due);
            out.arm = Some(due);
            return out;
        }
        out.show = self.waiting.pop_front();
        out
    }

    /// After a queued line showed: when the pump must run for the next one,
    /// or `None` when nothing waits (or a pump is already armed).
    pub fn arm_for_next(&mut self) -> Option<DateTime<Utc>> {
        if self.waiting.is_empty() || self.pump_due.is_some() {
            return None;
        }
        let due = self.bubble.as_ref()?.until + gap();
        self.pump_due = Some(due);
        Some(due)
    }

    /// The live-chat session changed (plan 211 D7): the lines waiting were
    /// for the last one. Returns how many were dropped, uncounted and unsaid.
    pub fn clear_queue(&mut self) -> usize {
        let dropped = self.waiting.len();
        self.waiting.clear();
        self.dropped = 0;
        self.drop_logged = false;
        dropped
    }

    #[cfg(test)]
    pub fn state(&self) -> CohostAvatarState {
        self.state
    }

    #[cfg(test)]
    pub fn persona_id(&self) -> &str {
        &self.persona_id
    }

    /// The persona whose images the renderer should draw.
    pub fn set_persona(&mut self, persona_id: impl Into<String>) {
        self.persona_id = persona_id.into();
    }

    /// `idle` → `think` while an answer is pending (D18). Nothing changes while
    /// a bubble is up: a bubble's state wins until it ends. Returns whether
    /// the state changed.
    pub fn think(&mut self) -> bool {
        if self.bubble.is_some() || self.state != CohostAvatarState::Idle {
            return false;
        }
        self.state = CohostAvatarState::Think;
        true
    }

    /// The one way a bubble appears: the text, the state it shows with and
    /// how long it stays. Replaces any bubble that is up (a laugh overrides a
    /// talk, a talk pre-empts a pending think). Returns the bubble's
    /// generation, which [`expire`](Self::expire) needs.
    pub fn show_bubble(
        &mut self,
        text: impl Into<String>,
        state: CohostUtteranceState,
        duration: Duration,
        now: DateTime<Utc>,
    ) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        let until = now
            + chrono::Duration::from_std(duration)
                .unwrap_or_else(|_| chrono::Duration::seconds(10));
        self.bubble = Some(BuddyBubbleRecord {
            text: text.into(),
            until,
            generation: self.generation,
        });
        self.state = state.into();
        self.generation
    }

    /// Drop the bubble of `generation` once its time is up; `idle` follows.
    /// A replaced or already-gone bubble, or one still running, is a no-op.
    pub fn expire(&mut self, generation: u64, now: DateTime<Utc>) -> bool {
        let Some(bubble) = self.bubble.as_ref() else {
            return false;
        };
        if bubble.generation != generation || bubble.until > now {
            return false;
        }
        self.bubble = None;
        self.state = CohostAvatarState::Idle;
        true
    }

    /// A pending answer went nowhere: `think` → `idle`, unless a bubble is
    /// up (its state wins until it ends). Returns whether the state changed.
    pub fn settle(&mut self) -> bool {
        if self.bubble.is_some() || self.state != CohostAvatarState::Think {
            return false;
        }
        self.state = CohostAvatarState::Idle;
        true
    }

    /// Back to `idle` at once (a session boundary, a cleared pending answer).
    /// The lines waiting for the bubble go with it.
    pub fn clear(&mut self) -> bool {
        let changed = self.bubble.is_some() || self.state != CohostAvatarState::Idle;
        self.bubble = None;
        self.state = CohostAvatarState::Idle;
        self.generation = self.generation.wrapping_add(1);
        self.clear_queue();
        changed
    }

    pub fn snapshot(&self) -> BuddyOverlaySnapshot {
        BuddyOverlaySnapshot {
            persona_id: self.persona_id.clone(),
            state: self.state,
            bubble: self.bubble.as_ref().map(|bubble| BuddyBubble {
                text: bubble.text.clone(),
                until: bubble.until.to_rfc3339(),
            }),
        }
    }
}

/// [`BUDDY_BUBBLE_GAP`] as chrono counts it.
fn gap() -> chrono::Duration {
    chrono::Duration::from_std(BUDDY_BUBBLE_GAP)
        .unwrap_or_else(|_| chrono::Duration::milliseconds(500))
}

pub type BuddyOverlayStateSlot = Arc<tokio::sync::Mutex<BuddyOverlayState>>;

pub fn new_buddy_overlay_state_slot(persona_id: impl Into<String>) -> BuddyOverlayStateSlot {
    Arc::new(tokio::sync::Mutex::new(BuddyOverlayState::new(persona_id)))
}

// --- Runtime ---------------------------------------------------------------------

/// A manual line is clipped like a chat message (1 to 200 characters).
pub const BUDDY_SAY_MAX_CHARS: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum BuddySayError {
    #[error("Say something first.")]
    Empty,
    #[error("Keep it under {BUDDY_SAY_MAX_CHARS} characters.")]
    TooLong,
}

/// The text a bubble shows: trimmed, inner whitespace collapsed, 1 to
/// [`BUDDY_SAY_MAX_CHARS`] characters.
pub fn validate_say_text(text: &str) -> Result<String, BuddySayError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(BuddySayError::Empty);
    }
    if text.chars().count() > BUDDY_SAY_MAX_CHARS {
        return Err(BuddySayError::TooLong);
    }
    Ok(text)
}

/// Plan 211 D7: text over [`BUDDY_SAY_MAX_CHARS`] is clipped, not dropped:
/// whitespace collapsed, cut at the last word boundary that leaves room for
/// "…", and "…" appended. A single word longer than the cap is cut inside
/// the word. Characters are counted as [`validate_say_text`] counts them, so
/// the result always passes it.
pub fn clip_bubble_text(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= BUDDY_SAY_MAX_CHARS {
        return text;
    }
    let head: String = text.chars().take(BUDDY_SAY_MAX_CHARS - 1).collect();
    let at_word = head
        .rfind(' ')
        .map(|index| head[..index].trim_end())
        .filter(|cut| !cut.is_empty());
    format!("{}…", at_word.unwrap_or_else(|| head.trim_end()))
}

/// Every bubble's text: clipped, then validated.
fn bubble_text(text: &str) -> Result<String, BuddySayError> {
    validate_say_text(&clip_bubble_text(text))
}

/// The current state for a renderer that just connected (`cohost.buddy.status`).
pub async fn status(app: &AppState) -> BuddyOverlaySnapshot {
    app.buddy_overlay_state.lock().await.snapshot()
}

/// Whether the Buddy is on any output: `overlayLayout.buddy.showOnStream` or
/// `showInRecording`. With both off nothing is shown (the compositor flags
/// are untouched; the bubble and the think are simply skipped, D7).
pub fn overlay_enabled(app: &AppState) -> bool {
    let buddy = load_overlay_layout(&app.database).buddy;
    buddy.show_on_stream || buddy.show_in_recording
}

/// Whether anyone can see Buddy right now (plan 211 D9): today, whether it
/// is on an output ([`overlay_enabled`]). In Bubble mode the lane greets,
/// answers and asks for banter only while this holds, so no AI call is spent
/// on a line nobody sees. Plan 202 Phase A adds the takeover rule here
/// ("hidden by a takeover"); keep that rule in this one place. Reads the
/// overlay layout from the database: call it before taking the engine lock.
pub fn buddy_visible(app: &AppState) -> bool {
    overlay_enabled(app)
}

/// Whether an utterance's words belong in the bubble: a line that reached
/// chat (`sent`), one that was never meant for chat (`bubble-only`), or the
/// streamer's own line from the Say box, which bubbles the moment it is
/// typed, whatever its send does later.
pub fn utterance_bubbles(utterance: &CohostUtterance) -> bool {
    matches!(
        utterance.status,
        CohostUtteranceStatus::Sent | CohostUtteranceStatus::BubbleOnly
    ) || utterance.trigger.kind == CohostUtteranceTriggerKind::Manual
}

/// The streamer's own line meets the bubble here (plan 164 D7/D18, plan 211
/// D7): it shows at once when [`utterance_bubbles`] says so and the Buddy is
/// on some output, replacing whatever is up; the queue of Buddy's own lines
/// resumes after it. Returns the state as shown, or `None` when nothing was
/// shown. Buddy's own lines take [`queue_for_utterance`] instead.
pub async fn show_for_utterance(
    app: &AppState,
    utterance: &CohostUtterance,
) -> Option<BuddyOverlaySnapshot> {
    if !utterance_bubbles(utterance) || !overlay_enabled(app) {
        return None;
    }
    match show_bubble(app, &utterance.text, utterance.state).await {
        Ok(snapshot) => {
            crate::cohost::note_bubble_shown(app, utterance, None).await;
            Some(snapshot)
        }
        Err(error) => {
            app.emit_log(
                "warn",
                format!(
                    "Buddy bubble skipped for utterance {}: {error}",
                    utterance.id
                ),
            );
            None
        }
    }
}

/// What became of one of Buddy's own lines at the queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueOutcome {
    /// Nothing was up: it shows now.
    Shown(BuddyOverlaySnapshot),
    /// It waits for the bubble that is up.
    Waiting,
    /// The queue was full: dropped, counted stale.
    Dropped,
    /// Not a line that bubbles, or the Buddy is on no output.
    Skipped,
}

/// Buddy's own lines meet the bubble here (plan 211 D7): a greeting, an
/// answer, banter or a Suggest card that landed. The line is clipped and
/// validated, then offered to the queue: shown now when nothing is up,
/// queued behind the current bubble, or dropped when three already wait.
/// `source` is who wrote a greeting, for the report when the line shows.
/// Nothing is shown with the Buddy on no output.
pub async fn queue_for_utterance(
    app: &AppState,
    utterance: &CohostUtterance,
    source: Option<CohostReportPostSource>,
) -> QueueOutcome {
    if !utterance_bubbles(utterance) || !overlay_enabled(app) {
        return QueueOutcome::Skipped;
    }
    let text = match bubble_text(&utterance.text) {
        Ok(text) => text,
        Err(error) => {
            app.emit_log(
                "warn",
                format!(
                    "Buddy bubble skipped for utterance {}: {error}",
                    utterance.id
                ),
            );
            return QueueOutcome::Skipped;
        }
    };
    let persona_id = crate::cohost::get_cohost_settings(app).await.persona.id;
    let now = Utc::now();
    let line = QueuedBubble {
        utterance: CohostUtterance {
            text,
            ..utterance.clone()
        },
        source,
        queued_at: now,
    };
    let offered = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        match buddy.offer(line.clone(), now) {
            BubbleOffer::ShowNow => {
                buddy.set_persona(persona_id);
                Offered::Shown(present(
                    &mut buddy,
                    line.utterance.text.clone(),
                    line.utterance.state,
                    now,
                ))
            }
            BubbleOffer::Queued { arm } => Offered::Queued(arm),
            BubbleOffer::Dropped { log } => Offered::Dropped(log),
        }
    };
    match offered {
        Offered::Shown(shown) => {
            publish_shown(app, &shown);
            crate::cohost::note_bubble_shown(app, &line.utterance, line.source).await;
            QueueOutcome::Shown(shown.snapshot)
        }
        Offered::Queued(arm) => {
            if let Some(due) = arm {
                arm_pump(app, due);
            }
            QueueOutcome::Waiting
        }
        Offered::Dropped(log) => {
            if let Some(log) = log {
                app.emit_log("info", log);
            }
            crate::cohost::note_bubble_dropped(app, &line.utterance).await;
            QueueOutcome::Dropped
        }
    }
}

/// The queue's answer with the show already run under the lock.
enum Offered {
    Shown(Shown),
    Queued(Option<DateTime<Utc>>),
    Dropped(Option<String>),
}

/// Lines waiting for the bubble (the queue's length).
pub async fn waiting_lines(app: &AppState) -> usize {
    app.buddy_overlay_state.lock().await.waiting()
}

/// The live-chat session changed (plan 211 D7): the lines waiting for the
/// bubble were for the last one.
pub async fn clear_queue(app: &AppState) {
    let dropped = app.buddy_overlay_state.lock().await.clear_queue();
    if dropped > 0 {
        app.emit_log(
            "info",
            format!("Buddy dropped {dropped} waiting line(s): the chat session changed."),
        );
    }
}

/// Wake the pump at `due` (one task per arming; the state hands out at most
/// one arming per wait).
fn arm_pump(app: &AppState, due: DateTime<Utc>) {
    let app = app.clone();
    tokio::spawn(async move {
        let wait = due
            .signed_duration_since(Utc::now())
            .to_std()
            .unwrap_or_default();
        tokio::time::sleep(wait).await;
        pump_queue(&app).await;
    });
}

/// The pump: show the oldest waiting line when nothing is up, else re-arm
/// for the current bubble's end plus the gap. Lines that waited too long
/// are dropped and counted.
async fn pump_queue(app: &AppState) {
    let persona_id = crate::cohost::get_cohost_settings(app).await.persona.id;
    let now = Utc::now();
    let (pump, shown) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let mut pump = buddy.pump(now);
        let shown = pump.show.as_ref().map(|line| {
            buddy.set_persona(persona_id.clone());
            present(
                &mut buddy,
                line.utterance.text.clone(),
                line.utterance.state,
                now,
            )
        });
        if shown.is_some() {
            pump.arm = buddy.arm_for_next();
        }
        (pump, shown)
    };
    if let Some(log) = pump.log {
        app.emit_log("info", log);
    }
    for line in &pump.dropped {
        crate::cohost::note_bubble_dropped(app, &line.utterance).await;
    }
    if let (Some(line), Some(shown)) = (pump.show, shown) {
        publish_shown(app, &shown);
        crate::cohost::note_bubble_shown(app, &line.utterance, line.source).await;
    }
    if let Some(due) = pump.arm {
        arm_pump(app, due);
    }
}

/// A bubble as it was just put up, for [`publish_shown`].
struct Shown {
    snapshot: BuddyOverlaySnapshot,
    generation: u64,
    duration: Duration,
    chars: usize,
    state: CohostUtteranceState,
}

/// Run the state machine for one validated text, under the caller's lock.
fn present(
    buddy: &mut BuddyOverlayState,
    text: String,
    state: CohostUtteranceState,
    now: DateTime<Utc>,
) -> Shown {
    let duration = buddy_bubble_duration(&text);
    let chars = text.chars().count();
    let generation = buddy.show_bubble(text, state, duration, now);
    Shown {
        snapshot: buddy.snapshot(),
        generation,
        duration,
        chars,
        state,
    }
}

/// Tell every window and schedule the bubble's end.
fn publish_shown(app: &AppState, shown: &Shown) {
    publish_state(
        app,
        shown.snapshot.clone(),
        Some(BuddyAnimatorEvent::UtteranceStart {
            state: shown.state,
            chars: shown.chars,
            bubble_seconds: shown.duration.as_secs_f64(),
        }),
    );
    let app = app.clone();
    let (duration, generation) = (shown.duration, shown.generation);
    tokio::spawn(async move {
        tokio::time::sleep(duration).await;
        expire_bubble(&app, generation).await;
    });
}

/// Show a bubble at once: the entry point for the streamer's own line and
/// for the queue when a line's turn comes. Clips and validates the text,
/// stamps the current persona, runs the state machine, tells every window
/// and schedules the bubble's end. Replaces whatever is up. Returns the
/// state as shown.
pub async fn show_bubble(
    app: &AppState,
    text: &str,
    state: CohostUtteranceState,
) -> Result<BuddyOverlaySnapshot, BuddySayError> {
    let text = bubble_text(text)?;
    let persona_id = crate::cohost::get_cohost_settings(app).await.persona.id;
    let shown = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        buddy.set_persona(persona_id);
        present(&mut buddy, text, state, Utc::now())
    };
    publish_shown(app, &shown);
    Ok(shown.snapshot)
}

/// Tell every window, and the pet on stream: the state and the event that
/// changed it reach the animator together (plan 168 S-C3).
fn publish_state(
    app: &AppState,
    snapshot: BuddyOverlaySnapshot,
    animator_event: Option<BuddyAnimatorEvent>,
) {
    app.buddy_sprite
        .set_avatar_state_and_notify(snapshot.state, animator_event);
    app.emit_event(BUDDY_STATE_EVENT, snapshot);
}

async fn expire_bubble(app: &AppState, generation: u64) {
    let snapshot = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        if !buddy.expire(generation, Utc::now()) {
            return;
        }
        buddy.snapshot()
    };
    publish_state(app, snapshot, Some(BuddyAnimatorEvent::UtteranceEnd));
}

/// `idle` → `think` while an answer is pending (D18): the send path calls
/// this while an answer is on its way to chat, when the Buddy is on some
/// output. Emits only on change.
pub async fn think(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.think();
        (buddy.snapshot(), changed)
    };
    if changed {
        publish_state(app, snapshot.clone(), Some(BuddyAnimatorEvent::ThinkStart));
    }
    snapshot
}

/// A pending answer went nowhere: `think` → `idle` unless a bubble is up.
/// Emits only on change.
pub async fn settle(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.settle();
        (buddy.snapshot(), changed)
    };
    if changed {
        publish_state(app, snapshot.clone(), Some(BuddyAnimatorEvent::ThinkSettle));
    }
    snapshot
}

/// Back to `idle` at once (a session boundary: a bubble from before the
/// session never rides into the new video). Emits only on change.
pub async fn clear(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.clear();
        (buddy.snapshot(), changed)
    };
    if changed {
        // Idle at once: the animator drops the bubble and the pending answer.
        publish_state(
            app,
            snapshot.clone(),
            Some(BuddyAnimatorEvent::UtteranceEnd),
        );
    }
    snapshot
}

// --- The bubble slot ----------------------------------------------------------------

/// `buddy.overlay.set { target, pngBase64, rect }`: the renderer's raster of
/// the bubble for one output canvas (plan 168 D16: the bubble only, its tail
/// tip on the bitmap's bottom-centre). `rect` is the Buddy's rect the bubble
/// was wrapped for; the compositor anchors the bitmap above the pet's head,
/// or, where no pet frame exists (tests, older callers), inside `rect` (a push
/// without one lands on the Buddy's default corner).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBuddyOverlayParams {
    pub png_base64: String,
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
    #[serde(default)]
    pub rect: Option<OverlayRect>,
}

/// `buddy.overlay.clear { target? }`: the bubble ended; both targets without
/// one.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearBuddyOverlayParams {
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
}

pub fn buddy_overlay_placement(rect: Option<OverlayRect>) -> OverlayPlacement {
    OverlayPlacement::new(
        rect,
        OverlayFallbackPlacement {
            item: OverlayItem::Buddy,
            snap: OverlaySnap::BottomRight,
        },
    )
}

#[cfg(test)]
pub fn install_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: SetBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    crate::captions::install_overlay_targets(
        slots,
        &params.png_base64,
        params.target,
        buddy_overlay_placement(params.rect),
    )
}

/// `buddy.overlay.set`: decode the bubble off the async runtime (like the
/// highlight card), then one bounded swap into the slot.
pub async fn set_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: SetBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    let SetBuddyOverlayParams {
        png_base64,
        target,
        rect,
    } = params;
    let prepared =
        tokio::task::spawn_blocking(move || crate::captions::prepare_caption_overlay(&png_base64))
            .await
            .map_err(|error| anyhow::anyhow!("Buddy bubble preparation stopped: {error}"))??;
    Ok(crate::captions::install_prepared_overlay_targets(
        slots,
        prepared,
        target,
        buddy_overlay_placement(rect),
    ))
}

/// `buddy.overlay.clear`: drop the bubble raster of one target, or both.
pub fn clear_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: ClearBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    crate::captions::clear_caption_overlays(
        slots,
        crate::captions::ClearCaptionOverlayParams {
            target: params.target,
            style_revision: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    #[test]
    fn bubble_duration_scales_with_text_between_the_floor_and_the_cap() {
        assert_eq!(buddy_bubble_duration(""), BUDDY_BUBBLE_MIN);
        assert_eq!(buddy_bubble_duration("hi"), BUDDY_BUBBLE_MIN);
        // 50 characters × 60 ms = 3 s.
        assert_eq!(
            buddy_bubble_duration(&"x".repeat(50)),
            Duration::from_secs(3)
        );
        assert_eq!(buddy_bubble_duration(&"x".repeat(200)), BUDDY_BUBBLE_MAX);
    }

    #[test]
    fn idle_talk_idle() {
        let mut buddy = BuddyOverlayState::new("default");
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        let generation = buddy.show_bubble(
            "Welcome to the horde",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        let snapshot = buddy.snapshot();
        assert_eq!(
            snapshot.bubble.as_ref().unwrap().text,
            "Welcome to the horde"
        );
        assert_eq!(snapshot.bubble.as_ref().unwrap().until, at(3).to_rfc3339());
        // Not yet.
        assert!(!buddy.expire(generation, at(2)));
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(buddy.expire(generation, at(3)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert_eq!(buddy.snapshot().bubble, None);
        // A second expiry is a no-op.
        assert!(!buddy.expire(generation, at(4)));
    }

    #[test]
    fn think_is_pre_empted_by_talk_and_never_interrupts_a_bubble() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(buddy.think());
        assert_eq!(buddy.state(), CohostAvatarState::Think);
        assert!(!buddy.think(), "already thinking");
        assert_eq!(buddy.snapshot().bubble, None);
        let generation = buddy.show_bubble(
            "Yes.",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(!buddy.think(), "a bubble's state wins until it ends");
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(buddy.expire(generation, at(3)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert!(buddy.think());
    }

    #[test]
    fn laugh_overrides_talk_and_the_old_expiry_is_a_no_op() {
        let mut buddy = BuddyOverlayState::new("default");
        let talk = buddy.show_bubble(
            "one",
            CohostUtteranceState::Talk,
            Duration::from_secs(5),
            at(0),
        );
        let laugh = buddy.show_bubble(
            "ha",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(1),
        );
        assert_ne!(talk, laugh);
        assert_eq!(buddy.state(), CohostAvatarState::Laugh);
        assert_eq!(buddy.snapshot().bubble.unwrap().text, "ha");
        // The replaced talk bubble's timer fires: nothing happens.
        assert!(!buddy.expire(talk, at(5)));
        assert_eq!(buddy.state(), CohostAvatarState::Laugh);
        assert!(buddy.expire(laugh, at(4)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
    }

    #[test]
    fn clear_drops_everything_and_invalidates_the_running_expiry() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(!buddy.clear(), "nothing to clear");
        let generation = buddy.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Think);
        assert!(buddy.clear());
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert!(!buddy.expire(generation, at(3)));
        buddy.set_persona("p2");
        assert_eq!(buddy.persona_id(), "p2");
    }

    #[test]
    fn wire_shape_is_camel_case_with_a_null_bubble() {
        let buddy = BuddyOverlayState::new("default");
        let value = serde_json::to_value(buddy.snapshot()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "personaId": "default", "state": "idle", "bubble": null })
        );
        let mut buddy = buddy;
        buddy.show_bubble(
            "Hello horde",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(0),
        );
        let value = serde_json::to_value(buddy.snapshot()).unwrap();
        assert_eq!(value["state"], "laugh");
        assert_eq!(value["bubble"]["text"], "Hello horde");
        assert!(value["bubble"]["until"].is_string());
        let round_trip: BuddyOverlaySnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, buddy.snapshot());
    }

    #[test]
    fn say_text_is_trimmed_collapsed_and_bounded() {
        assert_eq!(
            validate_say_text("  hello   horde  ").unwrap(),
            "hello horde"
        );
        assert!(matches!(
            validate_say_text("   "),
            Err(BuddySayError::Empty)
        ));
        assert!(matches!(
            validate_say_text(&"x".repeat(201)),
            Err(BuddySayError::TooLong)
        ));
        assert_eq!(validate_say_text(&"x".repeat(200)).unwrap().len(), 200);
    }

    #[test]
    fn settle_ends_a_think_but_never_a_bubble() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(!buddy.settle(), "idle stays idle");
        assert!(buddy.think());
        assert!(buddy.settle());
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        buddy.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert!(!buddy.settle(), "a bubble's think is the bubble's");
        assert_eq!(buddy.state(), CohostAvatarState::Think);
    }

    #[test]
    fn overlay_params_default_to_the_buddy_corner_and_keep_a_placed_rect() {
        let params: SetBuddyOverlayParams =
            serde_json::from_value(serde_json::json!({ "pngBase64": "AAAA" })).unwrap();
        assert_eq!(params.target, None);
        let placement = buddy_overlay_placement(params.rect);
        assert_eq!(
            placement.rect_for_canvas(1920, 1080),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Buddy,
                crate::overlay_layout::OverlayOrientation::Horizontal,
                OverlaySnap::BottomRight
            )
        );
        assert_eq!(
            placement.rect_for_canvas(1080, 1920),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Buddy,
                crate::overlay_layout::OverlayOrientation::Vertical,
                OverlaySnap::BottomRight
            )
        );
        let params: SetBuddyOverlayParams = serde_json::from_value(serde_json::json!({
            "pngBase64": "AAAA",
            "target": "auxiliary",
            "rect": { "x": 0.1, "y": 0.2, "w": 0.25, "h": 0.2 }
        }))
        .unwrap();
        assert_eq!(params.target, Some(CaptionOverlayTarget::Auxiliary));
        assert_eq!(
            buddy_overlay_placement(params.rect).rect_for_canvas(1280, 720),
            OverlayRect::new(0.1, 0.2, 0.25, 0.2)
        );
        // A bad payload is refused; nothing is installed.
        let slots = crate::captions::new_caption_overlay_slots();
        assert!(install_buddy_overlay(&slots, params).is_err());
        assert!(!crate::captions::caption_overlay_targets_metadata(&slots).active);
    }

    fn bubble_png(width: u32, height: u32) -> String {
        use base64::Engine as _;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([250, 250, 251, 255]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("test png encodes");
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    /// Plan 168 S-B1: the bubble decodes off the async runtime, lands in its
    /// target, and `buddy.overlay.clear` drops it (one target or both).
    #[tokio::test]
    async fn the_bubble_is_set_off_the_runtime_and_cleared_per_target() {
        let slots = crate::captions::new_caption_overlay_slots();
        let info = set_buddy_overlay(
            &slots,
            SetBuddyOverlayParams {
                png_base64: bubble_png(40, 20),
                target: None,
                rect: Some(OverlayRect::new(0.7, 0.6, 0.2, 0.3)),
            },
        )
        .await
        .unwrap();
        assert!(info.primary.active && info.auxiliary.active);
        assert_eq!((info.primary.width, info.primary.height), (40, 20));
        assert!(
            set_buddy_overlay(
                &slots,
                SetBuddyOverlayParams {
                    png_base64: "AAAA".to_string(),
                    target: None,
                    rect: None,
                },
            )
            .await
            .is_err(),
            "a bad payload is refused and the bubble stays"
        );
        let cleared = clear_buddy_overlay(
            &slots,
            ClearBuddyOverlayParams {
                target: Some(CaptionOverlayTarget::Auxiliary),
            },
        )
        .unwrap();
        assert!(cleared.primary.active && !cleared.auxiliary.active);
        let cleared = clear_buddy_overlay(&slots, ClearBuddyOverlayParams::default()).unwrap();
        assert!(!cleared.active);
        let params: ClearBuddyOverlayParams =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(params.target, None);
        assert!(
            serde_json::from_value::<ClearBuddyOverlayParams>(serde_json::json!({ "x": 1 }))
                .is_err()
        );
    }

    fn test_app() -> (
        AppState,
        tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) {
        let (events, rx) = tokio::sync::broadcast::channel(16);
        let app = AppState::new(
            "fixture".into(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        (app, rx)
    }

    fn buddy_output_switches(app: &AppState, show_on_stream: bool, show_in_recording: bool) {
        let mut layout = load_overlay_layout(&app.database);
        layout.buddy.show_on_stream = show_on_stream;
        layout.buddy.show_in_recording = show_in_recording;
        crate::overlay_layout::save_overlay_layout(&app.database, &layout).unwrap();
    }

    fn utterance(
        trigger: CohostUtteranceTriggerKind,
        status: CohostUtteranceStatus,
        text: &str,
    ) -> CohostUtterance {
        CohostUtterance {
            id: format!("utt-{text}"),
            text: text.to_string(),
            state: CohostUtteranceState::Laugh,
            trigger: crate::cohost::CohostUtteranceTrigger {
                kind: trigger,
                event_id: None,
                message_id: None,
            },
            destination_ids: Vec::new(),
            status,
            at: "2026-10-08T12:00:00Z".to_string(),
            expires_at: None,
        }
    }

    #[tokio::test]
    async fn show_bubble_tells_every_window_and_ends_it() {
        let (app, mut rx) = test_app();
        assert_eq!(status(&app).await.state, CohostAvatarState::Idle);
        assert!(
            show_bubble(&app, "   ", CohostUtteranceState::Talk)
                .await
                .is_err()
        );
        let shown = show_bubble(&app, "Hello horde", CohostUtteranceState::Laugh)
            .await
            .unwrap();
        assert_eq!(shown.state, CohostAvatarState::Laugh);
        assert_eq!(shown.persona_id, crate::cohost::COHOST_DEFAULT_PERSONA_ID);
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Hello horde");
        let event = rx.recv().await.unwrap();
        assert_eq!(event.event, BUDDY_STATE_EVENT);
        assert_eq!(event.payload["state"], "laugh");
        assert_eq!(status(&app).await, shown);
        // think never interrupts a bubble; clear ends it at once and says so.
        assert_eq!(think(&app).await.state, CohostAvatarState::Laugh);
        assert_eq!(clear(&app).await.state, CohostAvatarState::Idle);
        let event = rx.recv().await.unwrap();
        assert_eq!(event.payload["bubble"], serde_json::Value::Null);
        assert_eq!(think(&app).await.state, CohostAvatarState::Think);
        assert_eq!(settle(&app).await.state, CohostAvatarState::Idle);
    }

    /// Plan 164 D7/D18: a sent utterance and a bubble-only one bubble; a
    /// proposed, dismissed or failed one does not.
    #[tokio::test]
    async fn sent_and_bubble_only_utterances_bubble_the_rest_do_not() {
        let (app, mut rx) = test_app();
        buddy_output_switches(&app, true, false);
        let sent = utterance(
            CohostUtteranceTriggerKind::Greeting,
            CohostUtteranceStatus::Sent,
            "Welcome Fan0!",
        );
        let shown = show_for_utterance(&app, &sent).await.unwrap();
        assert_eq!(shown.state, CohostAvatarState::Laugh);
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Welcome Fan0!");
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "Welcome Fan0!"
        );
        let bubble_only = utterance(
            CohostUtteranceTriggerKind::Manual,
            CohostUtteranceStatus::BubbleOnly,
            "Just the bubble",
        );
        let shown = show_for_utterance(&app, &bubble_only).await.unwrap();
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Just the bubble");
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "Just the bubble"
        );
        for status in [
            CohostUtteranceStatus::Proposed,
            CohostUtteranceStatus::Dismissed,
            CohostUtteranceStatus::Failed,
        ] {
            let silent = utterance(CohostUtteranceTriggerKind::Answer, status, "never shown");
            assert!(!utterance_bubbles(&silent));
            assert_eq!(show_for_utterance(&app, &silent).await, None);
        }
        assert_eq!(status(&app).await.bubble.unwrap().text, "Just the bubble");
        assert!(rx.try_recv().is_err(), "nothing else was emitted");
    }

    /// Plan 164 D7: with `showOnStream` and `showInRecording` both off the
    /// bubble is skipped; either switch on brings it back.
    #[tokio::test]
    async fn both_output_switches_off_means_no_bubble() {
        let (app, mut rx) = test_app();
        assert!(!overlay_enabled(&app), "the Buddy ships off/off");
        let sent = utterance(
            CohostUtteranceTriggerKind::Answer,
            CohostUtteranceStatus::Sent,
            "It is a Keychron.",
        );
        assert!(utterance_bubbles(&sent));
        assert_eq!(show_for_utterance(&app, &sent).await, None);
        assert_eq!(status(&app).await.bubble, None);
        assert!(rx.try_recv().is_err(), "no event with the Buddy off");
        buddy_output_switches(&app, false, true);
        assert!(overlay_enabled(&app));
        assert!(show_for_utterance(&app, &sent).await.is_some());
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "It is a Keychron."
        );
    }

    // --- Plan 211 D7: the bubble queue and clipping ---------------------------------

    fn queued(text: &str, queued_at: DateTime<Utc>) -> QueuedBubble {
        QueuedBubble {
            utterance: utterance(
                CohostUtteranceTriggerKind::Greeting,
                CohostUtteranceStatus::BubbleOnly,
                text,
            ),
            source: None,
            queued_at,
        }
    }

    /// A 10 s bubble is not replaced by a line that arrives 5 s in: the line
    /// waits for the bubble's end plus the gap, a second line waits behind
    /// it without a new arming, and the pump shows them in order.
    #[test]
    fn a_line_that_arrives_while_a_bubble_is_up_waits_for_its_end_plus_the_gap() {
        let mut buddy = BuddyOverlayState::new("default");
        assert_eq!(
            buddy.offer(queued("first", at(0)), at(0)),
            BubbleOffer::ShowNow,
            "nothing up, nothing waiting"
        );
        buddy.show_bubble(
            "a long answer",
            CohostUtteranceState::Talk,
            Duration::from_secs(10),
            at(0),
        );
        assert_eq!(
            buddy.offer(queued("Welcome, Ada!", at(5)), at(5)),
            BubbleOffer::Queued {
                arm: Some(at(10) + gap())
            }
        );
        assert_eq!(
            buddy.snapshot().bubble.unwrap().text,
            "a long answer",
            "not replaced"
        );
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert_eq!(buddy.waiting(), 1);
        assert_eq!(
            buddy.offer(queued("Welcome, Bo!", at(6)), at(6)),
            BubbleOffer::Queued { arm: None },
            "a pump is already armed"
        );
        // Woken early (the bubble is still up): re-armed, nothing shown.
        let early = buddy.pump(at(9));
        assert_eq!(early.show, None);
        assert_eq!(early.arm, Some(at(10) + gap()));
        assert!(early.dropped.is_empty());
        // Its time: the oldest line shows, and the next is armed for its
        // end plus the gap.
        let due = buddy.pump(at(10) + gap());
        let line = due.show.expect("Ada shows");
        assert_eq!(line.utterance.text, "Welcome, Ada!");
        assert_eq!(due.arm, None, "the caller shows, then arms");
        buddy.show_bubble(
            line.utterance.text,
            line.utterance.state,
            Duration::from_secs(3),
            at(10) + gap(),
        );
        assert_eq!(buddy.snapshot().bubble.unwrap().text, "Welcome, Ada!");
        assert_eq!(buddy.arm_for_next(), Some(at(14)));
        assert_eq!(buddy.arm_for_next(), None, "armed once");
        assert_eq!(buddy.waiting(), 1);
        assert_eq!(
            buddy.pump(at(14)).show.unwrap().utterance.text,
            "Welcome, Bo!"
        );
        assert_eq!(buddy.waiting(), 0);
        assert_eq!(buddy.dropped(), 0);
    }

    /// At most three lines wait: a fourth is dropped (logged once), and a
    /// line that waited 20 s is dropped when the pump wakes. `clear` empties
    /// the queue and resets the once-a-session log.
    #[test]
    fn the_queue_holds_three_and_drops_a_fourth_and_a_line_that_waited_twenty_seconds() {
        let mut buddy = BuddyOverlayState::new("default");
        buddy.show_bubble(
            "up",
            CohostUtteranceState::Talk,
            Duration::from_secs(10),
            at(0),
        );
        for second in [1, 2, 3] {
            assert!(matches!(
                buddy.offer(queued(&format!("line {second}"), at(second)), at(second)),
                BubbleOffer::Queued { .. }
            ));
            assert_eq!(buddy.waiting(), second as usize);
        }
        let fourth = buddy.offer(queued("line 4", at(4)), at(4));
        assert!(
            matches!(fourth, BubbleOffer::Dropped { log: Some(_) }),
            "{fourth:?}"
        );
        assert!(
            matches!(
                buddy.offer(queued("line 5", at(5)), at(5)),
                BubbleOffer::Dropped { log: None }
            ),
            "logged once a session"
        );
        assert_eq!(buddy.waiting(), 3);
        assert_eq!(buddy.dropped(), 2);
        // Say lines kept the bubble busy until 22 s: lines 1 and 2 waited
        // 20 s or more and are dropped; line 3 (19 s) shows.
        buddy.show_bubble(
            "say",
            CohostUtteranceState::Laugh,
            Duration::from_secs(10),
            at(12),
        );
        let pump = buddy.pump(at(22));
        assert_eq!(
            pump.dropped
                .iter()
                .map(|line| line.utterance.text.as_str())
                .collect::<Vec<_>>(),
            ["line 1", "line 2"]
        );
        assert!(pump.log.is_none(), "the once-a-session log was spent");
        assert_eq!(pump.show.unwrap().utterance.text, "line 3");
        assert_eq!(buddy.dropped(), 4);
        assert_eq!(buddy.waiting(), 0);
        // clear: the queue goes with the bubble, and the log is fresh.
        buddy.show_bubble(
            "x",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(30),
        );
        assert!(matches!(
            buddy.offer(queued("later", at(31)), at(31)),
            BubbleOffer::Queued { .. }
        ));
        assert!(buddy.clear());
        assert_eq!(buddy.waiting(), 0);
        assert_eq!(buddy.dropped(), 0);
        buddy.show_bubble(
            "y",
            CohostUtteranceState::Talk,
            Duration::from_secs(10),
            at(40),
        );
        for second in [41, 42, 43] {
            buddy.offer(queued("w", at(second)), at(second));
        }
        assert!(matches!(
            buddy.offer(queued("w", at(44)), at(44)),
            BubbleOffer::Dropped { log: Some(_) }
        ));
    }

    /// The streamer's own Say line shows at once and replaces what is up;
    /// the waiting line is not lost: the pump re-arms for the Say line's
    /// end and shows it after.
    #[test]
    fn a_say_line_pre_empts_and_the_queue_resumes_after_it() {
        let mut buddy = BuddyOverlayState::new("default");
        buddy.show_bubble(
            "greeting",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(
            buddy.offer(queued("answer", at(1)), at(1)),
            BubbleOffer::Queued {
                arm: Some(at(3) + gap())
            }
        );
        // The runtime shows a Say line through `show_bubble` directly.
        buddy.show_bubble(
            "Hello horde",
            CohostUtteranceState::Laugh,
            Duration::from_secs(5),
            at(2),
        );
        assert_eq!(buddy.snapshot().bubble.unwrap().text, "Hello horde");
        assert_eq!(buddy.waiting(), 1, "the answer still waits");
        let woke = buddy.pump(at(3) + gap());
        assert_eq!(woke.show, None);
        assert_eq!(woke.arm, Some(at(7) + gap()));
        let resumed = buddy.pump(at(7) + gap());
        assert_eq!(resumed.show.unwrap().utterance.text, "answer");
        assert_eq!(resumed.arm, None);
        assert_eq!(buddy.waiting(), 0);
    }

    #[test]
    fn bubble_text_is_clipped_at_a_word_boundary_with_an_ellipsis() {
        assert_eq!(clip_bubble_text("  short   line "), "short line");
        let exact = "x".repeat(BUDDY_SAY_MAX_CHARS);
        assert_eq!(clip_bubble_text(&exact), exact);
        // 50 words: cut at a word boundary, under the cap, ending with "…".
        let long = ["word"; 50].join(" ");
        assert_eq!(long.chars().count(), 249);
        let clipped = clip_bubble_text(&long);
        assert!(clipped.ends_with('…'), "{clipped:?}");
        assert!(clipped.chars().count() <= BUDDY_SAY_MAX_CHARS);
        let body = clipped.trim_end_matches('…');
        assert!(!body.ends_with(' '));
        assert!(
            body.split(' ').all(|word| word == "word"),
            "no word cut in half: {body:?}"
        );
        assert_eq!(validate_say_text(&clipped).unwrap(), clipped);
        // One word longer than the cap is cut inside the word.
        let clipped = clip_bubble_text(&"y".repeat(300));
        assert_eq!(clipped, format!("{}…", "y".repeat(BUDDY_SAY_MAX_CHARS - 1)));
        assert_eq!(clipped.chars().count(), BUDDY_SAY_MAX_CHARS);
        // A long first word with more after it: the boundary rule would
        // leave nothing, so it cuts inside the word too.
        let clipped = clip_bubble_text(&format!("{} tail", "z".repeat(250)));
        assert_eq!(clipped, format!("{}…", "z".repeat(BUDDY_SAY_MAX_CHARS - 1)));
        // Characters, not bytes.
        let clipped = clip_bubble_text(&"😀 ".repeat(150));
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= BUDDY_SAY_MAX_CHARS);
        assert!(validate_say_text(&clipped).is_ok());
        assert!(matches!(bubble_text("   "), Err(BuddySayError::Empty)));
    }

    /// Plan 211 D7 at the runtime: Buddy's own lines queue behind the bubble
    /// that is up (three at most), nothing replaces it, the pump shows the
    /// next after it ends plus the gap, and the queue empties with the chat
    /// session.
    #[tokio::test]
    async fn buddy_lines_wait_behind_the_bubble_and_the_pump_shows_the_next() {
        let (app, mut rx) = test_app();
        buddy_output_switches(&app, true, false);
        let line = |n: u32| {
            utterance(
                CohostUtteranceTriggerKind::Greeting,
                CohostUtteranceStatus::BubbleOnly,
                &format!("Hi {n}"),
            )
        };
        match queue_for_utterance(&app, &line(0), None).await {
            QueueOutcome::Shown(shown) => assert_eq!(shown.bubble.unwrap().text, "Hi 0"),
            other => panic!("{other:?}"),
        }
        assert_eq!(rx.recv().await.unwrap().payload["bubble"]["text"], "Hi 0");
        for n in 1..=3 {
            assert_eq!(
                queue_for_utterance(&app, &line(n), None).await,
                QueueOutcome::Waiting,
                "line {n}"
            );
        }
        assert_eq!(
            queue_for_utterance(&app, &line(4), None).await,
            QueueOutcome::Dropped
        );
        assert_eq!(waiting_lines(&app).await, 3);
        assert_eq!(
            status(&app).await.bubble.unwrap().text,
            "Hi 0",
            "a waiting line never replaces the bubble"
        );
        while let Ok(event) = rx.try_recv() {
            assert_ne!(event.event, BUDDY_STATE_EVENT, "nothing else showed");
        }
        // A card is not a bubbling line: skipped, never queued.
        assert_eq!(
            queue_for_utterance(
                &app,
                &utterance(
                    CohostUtteranceTriggerKind::Answer,
                    CohostUtteranceStatus::Proposed,
                    "card"
                ),
                None
            )
            .await,
            QueueOutcome::Skipped
        );
        // "Hi 0" stays its 2.5 s minimum, then the gap, then "Hi 1" shows.
        tokio::time::sleep(Duration::from_millis(3400)).await;
        assert_eq!(status(&app).await.bubble.unwrap().text, "Hi 1");
        assert_eq!(waiting_lines(&app).await, 2);
        // The chat session changed: the rest goes.
        clear_queue(&app).await;
        assert_eq!(waiting_lines(&app).await, 0);
        // The Buddy on no output: skipped before the queue.
        buddy_output_switches(&app, false, false);
        assert_eq!(
            queue_for_utterance(&app, &line(9), None).await,
            QueueOutcome::Skipped
        );
    }

    /// A long answer shows clipped instead of vanishing.
    #[tokio::test]
    async fn a_long_line_is_clipped_not_dropped() {
        let (app, _rx) = test_app();
        buddy_output_switches(&app, true, false);
        let long = ["Rust"; 80].join(" ");
        let shown = show_for_utterance(
            &app,
            &utterance(
                CohostUtteranceTriggerKind::Manual,
                CohostUtteranceStatus::BubbleOnly,
                &long,
            ),
        )
        .await
        .expect("shown, clipped");
        let text = shown.bubble.unwrap().text;
        assert!(text.ends_with('…'));
        assert!(text.chars().count() <= BUDDY_SAY_MAX_CHARS);
        assert!(text.starts_with("Rust Rust"));
    }
}
