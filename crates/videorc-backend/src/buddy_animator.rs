//! The Golem's animator (plan 168, S-C2): what the pet does on stream, frame
//! by frame, per output leg.
//!
//! A pure state machine with an injected clock and a seeded random source.
//! Events go in ([`BuddyAnimatorEvent`]: a bubble went up or down, an answer
//! is pending, an Activity row or a manual reaction, the highlight card went
//! live or idle, chat arrived, the persona's motion changed) and, per leg and
//! frame, a [`BuddySpriteDraw`] comes out: which atlas cell, where, and how
//! the body is turned. It owns one [`BuddyMotion`] (S-C1), advanced once per
//! frame: `draw()` runs once per leg per frame with the same clock, so the
//! first leg to draw at a new time steps the state and every leg reads it.
//!
//! The rules (plan 168 D11 to D15, owner defaults: Motion 0.45, breathing
//! on, sleep after 180 s, a failed destination plays nothing):
//!
//! - **Gaze (D11)**, per leg because the pet and the card sit in different
//!   places per orientation: the viewer (`[0, 0]`) by default; an idle glance
//!   every 7 to 14 s, for 0.8 to 1.6 s, to a random cell within 0.5 of the
//!   centre, never while a bubble is up; when the highlight card shows on a
//!   leg the pet looks at it (page-pet's tracking vector from the head anchor
//!   to the card's centre over `max(1.3 * size, 120)`, clamped, nearest
//!   cell) for 1.5 s, back to the viewer, and glances once more at mid-TTL; a
//!   bubble looks at the viewer; a pending answer looks up-left `[-0.5, -1]`.
//!   Every gaze change on the lead leg turns the body a little
//!   (`gaze_turn(delta_x)`), never during a drawn reaction (page-pet).
//! - **Talk (D12)**: while a bubble is up the pack's talk frames and the
//!   neutral cell cycle at a jittered 110 to 150 ms per step for
//!   `min(bubble, 65 ms * characters)`, then the neutral cell holds. A pack
//!   without talk frames bobs (`talk_bob()`) at that cadence instead, on the
//!   cell it shows: the still pack keeps plan 164's state image (`talk`,
//!   `laugh`, `think`) for the whole bubble, as Phase B drew it.
//! - **Blink and sleep (D13)**: a 160 ms blink every 3.5 to 6 s, only on the
//!   neutral cell. Sleep after `sleepAfterSeconds` with no chat, activity,
//!   utterance or Say, never while a bubble or the card shows, only for a pack
//!   with a `sleep` cell; anything wakes it with `surprised` for 600 ms.
//! - **Reactions (D14)**: an Activity row plays its trigger's reaction (the
//!   persona's override, then D14's default chain, the first id the pack
//!   has, else a motion-only hop); a greeting's own reaction wins; `none`
//!   plays nothing. A reaction never interrupts another: at most 2 wait, for
//!   at most 6 s. A reaction holds `max(1.1 s, its motion envelope)`. A
//!   laughing utterance plays `laugh`.
//! - **Breathing (D15)**: only while the pet rests on a gaze cell.
//!
//! When no richer rule applies the plan 164 state cell shows, as Phase B's
//! static source drew it. Opacity is always 1.
//!
//! The per-frame call carries no events, so the slot keeps the animator
//! ([`BuddyAnimatorSource`]) under its own lock and hands it events through
//! `BuddySpriteSlot::notify` (S-C3); they are applied at the next frame,
//! stamped with how long ago they happened.

use std::collections::{BTreeMap, VecDeque};
use std::time::Instant;

use crate::cohost::{
    CohostActivityTemplateKind, CohostAutoChat, CohostAutoChatMode, CohostAvatarState,
    CohostPersona, CohostUtteranceState,
};
use crate::buddy_motion::{BuddyMotion, MotionConfig};
use crate::buddy_pet::{BUDDY_REACTION_NONE, BuddyMotionSettings, BuddyTrigger, PetFrameKind};
use crate::buddy_sprite::{
    BuddySpriteAtlas, BuddySpriteCell, BuddySpriteDraw, BuddySpriteLeg, BuddySpriteLegContext,
    BuddySpriteSource,
};
use crate::live_chat::{LiveChatEventType, LiveChatMessage};

// --- The numbers (D11 to D15) ---------------------------------------------------------

/// D11: an idle glance comes every 7 to 14 s ...
pub const IDLE_GLANCE_EVERY_SECONDS: (f64, f64) = (7.0, 14.0);
/// ... lasts 0.8 to 1.6 s ...
pub const IDLE_GLANCE_FOR_SECONDS: (f64, f64) = (0.8, 1.6);
/// ... and goes to a cell with |x| and |y| at most this.
pub const IDLE_GLANCE_REACH: f64 = 0.5;
/// D11: the first look at the highlight card.
pub const CARD_LOOK_SECONDS: f64 = 1.5;
/// D11: the second look at mid-TTL. The plan names no length; ours sits in
/// the middle of the idle glance range.
pub const CARD_GLANCE_SECONDS: f64 = 1.2;
/// The highlight card's lifetime when no event said otherwise
/// (`comment_highlight::COMMENT_HIGHLIGHT_TTL`).
pub const CARD_TTL_SECONDS: f64 = 10.0;
/// page-pet's tracking radius: `max(120, 1.3 * size)`.
pub const GAZE_RADIUS_PER_SIZE: f64 = 1.3;
pub const GAZE_MIN_RADIUS_PX: f64 = 120.0;
/// D11: a pending answer looks up-left.
pub const THINK_GAZE: [f64; 2] = [-0.5, -1.0];
/// The viewer.
pub const VIEWER_GAZE: [f64; 2] = [0.0, 0.0];
/// D12: one talk step lasts 110 to 150 ms ...
pub const TALK_STEP_SECONDS: (f64, f64) = (0.110, 0.150);
/// ... and the talking lasts `min(bubble, 65 ms * characters)`.
pub const TALK_SECONDS_PER_CHAR: f64 = 0.065;
/// D13: page-pet blinks 3.5 s after start, then every 3.5 to 6 s ...
pub const BLINK_FIRST_SECONDS: f64 = 3.5;
pub const BLINK_EVERY_SECONDS: (f64, f64) = (3.5, 6.0);
/// ... for 160 ms.
pub const BLINK_SECONDS: f64 = 0.16;
/// D13: waking shows `surprised` this long.
pub const WAKE_SECONDS: f64 = 0.6;
/// D14: a reaction frame holds at least page-pet's 1100 ms.
pub const REACTION_HOLD_SECONDS: f64 = 1.1;
/// D14: at most this many reactions wait behind the one playing ...
pub const REACTION_QUEUE_MAX: usize = 2;
/// ... for at most this long.
pub const REACTION_MAX_AGE_SECONDS: f64 = 6.0;

/// An Activity row older than this plays no reaction (a chat backfill on
/// connect is history, not news). Greetings keep their own 10 minute window.
pub const ACTIVITY_REACTION_FRESH_SECONDS: i64 = 60;

/// The motion-only hop (D14's last fallback): its own pose in the motion
/// table (`buddy_motion::REACTION_POSES`), stronger than page-pet's default
/// because no frame change carries it.
pub const HOP_REACTION_ID: &str = "hop";
const BLINK_ID: &str = "blink";
const SLEEP_ID: &str = "sleep";
const SURPRISED_ID: &str = "surprised";
const LAUGH_ID: &str = "laugh";
const THINK_ID: &str = "think";

/// Events waiting for the next frame; beyond this the oldest go (only a
/// long stretch with the Golem on no output piles them up, and by then they
/// are stale).
const PENDING_MAX: usize = 64;
/// The frame clock may stall this long and still count as one clock; a
/// longer gap, or a clock that went backwards (a new session, another
/// pump), continues the animator's own time from where it stopped.
const CLOCK_MAX_GAP_SECONDS: f64 = 2.0;
const CLOCK_NOMINAL_STEP_SECONDS: f64 = 1.0 / 60.0;
/// The most talk steps one frame catches up on.
const TALK_CATCH_UP_STEPS: usize = 32;

// --- Events and settings --------------------------------------------------------------

/// Something the pet may react to (S-C3 wires each one).
#[derive(Debug, Clone, PartialEq)]
pub enum BuddyAnimatorEvent {
    /// A bubble went up (`buddy_overlay::show_bubble`): its mood, its text
    /// length and how long it stays.
    UtteranceStart {
        state: CohostUtteranceState,
        chars: usize,
        bubble_seconds: f64,
    },
    /// The bubble ended or was cleared.
    UtteranceEnd,
    /// An answer is on its way to chat (`buddy_overlay::think`).
    ThinkStart,
    /// The pending answer went nowhere (`buddy_overlay::settle`).
    ThinkSettle,
    /// An Activity row or a failed destination (D14). `reaction` is the
    /// greeting's own reaction when a greeting template answers the row
    /// (`none` turns it off).
    Trigger {
        trigger: BuddyTrigger,
        reaction: Option<String>,
    },
    /// A reaction asked for by id (`cohost.pet.react`: the preview's Try
    /// buttons, the Stream Manager chips), already checked against the pack.
    React { reaction: String },
    /// The highlight card went on stream for `ttl_seconds`.
    HighlightLive { ttl_seconds: f64 },
    /// The card left.
    HighlightIdle,
    /// Chat arrived: somebody is there (D13).
    ChatSeen,
    /// The persona's motion or reaction table changed (`cohost.settings.set`).
    Settings(BuddyAnimatorSettings),
}

/// What the animator reads from the persona.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuddyAnimatorSettings {
    pub motion: BuddyMotionSettings,
    pub reactions: BTreeMap<BuddyTrigger, String>,
}

impl BuddyAnimatorSettings {
    pub fn from_persona(persona: &CohostPersona) -> Self {
        Self {
            motion: persona.motion,
            reactions: persona.reactions.clone(),
        }
    }
}

/// The reaction chain of a trigger (D14): the greeting's own reaction, else
/// the persona's override, then D14's default chain; `none` is empty. The
/// first id the pack has plays; a non-empty chain without one hops.
pub fn trigger_reaction_chain(
    trigger: BuddyTrigger,
    greeting: Option<&str>,
    overrides: &BTreeMap<BuddyTrigger, String>,
) -> Vec<String> {
    let first = greeting.or_else(|| overrides.get(&trigger).map(String::as_str));
    let mut chain = Vec::new();
    match first {
        Some(BUDDY_REACTION_NONE) => return chain,
        Some(id) => chain.push(id.to_string()),
        None => {}
    }
    for id in trigger.default_reactions() {
        if !chain.iter().any(|known| known == id) {
            chain.push((*id).to_string());
        }
    }
    chain
}

// --- The random source -----------------------------------------------------------------

/// SplitMix64: small, seedable, good enough for glance and blink timing.
#[derive(Debug, Clone)]
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1_u64 << 53) as f64
    }

    fn range(&mut self, (low, high): (f64, f64)) -> f64 {
        low + (high - low) * self.unit()
    }

    fn index(&mut self, count: usize) -> usize {
        ((self.unit() * count as f64) as usize).min(count.saturating_sub(1))
    }
}

/// A seed that differs per process run.
pub fn process_seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0x5EED);
    nanos ^ (u64::from(std::process::id()) << 32)
}

// --- The state machine -------------------------------------------------------------------

/// What the Golem is saying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Speech {
    Quiet,
    /// An answer is pending, no bubble.
    Think,
    /// A bubble is up, in this mood.
    Bubble(CohostUtteranceState),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Talk {
    until: f64,
    /// Step boundaries crossed; the cycle shows step `steps - 1`.
    steps: usize,
    next_step_at: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct HighlightShow {
    since: f64,
    ttl: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Glance {
    point: [f64; 2],
    until: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Blink {
    /// Counts blinks, so each leg decides once per blink whether it shows.
    serial: u64,
    until: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Wake {
    until: f64,
    moved: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct Playing {
    /// The drawn reaction, or `None` for a motion-only hop.
    cell: Option<String>,
    until: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct QueuedReaction {
    chain: Vec<String>,
    at: f64,
}

/// What one leg remembers between frames.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct LegMemory {
    /// The gaze point of the cell it showed last.
    gaze: Option<[f64; 2]>,
    /// When the highlight card appeared on this leg.
    card_since: Option<f64>,
    /// The blink this leg decided about, and whether it shows it: only a
    /// leg resting on the neutral cell when the blink starts blinks, and
    /// then for the whole 160 ms (page-pet holds a blink like a reaction).
    blink: Option<(u64, bool)>,
}

/// The animator. See the module docs for the rules.
#[derive(Debug, Clone)]
pub struct BuddyAnimator {
    settings: BuddyAnimatorSettings,
    motion: BuddyMotion,
    rng: SplitMix64,
    /// The clock of the last step.
    frame: Option<f64>,
    /// The leg that drew first at `frame`: its gaze changes turn the body.
    lead: Option<BuddySpriteLeg>,
    speech: Speech,
    talk: Option<Talk>,
    highlight: Option<HighlightShow>,
    glance: Option<Glance>,
    next_glance_at: Option<f64>,
    blink: Option<Blink>,
    blink_serial: u64,
    next_blink_at: Option<f64>,
    last_activity: Option<f64>,
    asleep: bool,
    wake: Option<Wake>,
    playing: Option<Playing>,
    queue: VecDeque<QueuedReaction>,
    legs: [LegMemory; 2],
}

impl BuddyAnimator {
    pub fn new(settings: BuddyAnimatorSettings, seed: u64) -> Self {
        let motion = BuddyMotion::new(MotionConfig {
            intensity: settings.motion.intensity,
            breathing: settings.motion.breathing,
            ..MotionConfig::default()
        });
        Self {
            settings,
            motion,
            rng: SplitMix64(seed),
            frame: None,
            lead: None,
            speech: Speech::Quiet,
            talk: None,
            highlight: None,
            glance: None,
            next_glance_at: None,
            blink: None,
            blink_serial: 0,
            next_blink_at: None,
            last_activity: None,
            asleep: false,
            wake: None,
            playing: None,
            queue: VecDeque::new(),
            legs: [LegMemory::default(); 2],
        }
    }

    /// The persona's motion or reactions changed; motion in flight keeps
    /// going, the new intensity applies to the next impulse.
    pub fn set_settings(&mut self, settings: BuddyAnimatorSettings) {
        if settings.motion.sleep_after_seconds == 0 {
            self.asleep = false;
        }
        let mut config = *self.motion.config();
        config.intensity = settings.motion.intensity;
        config.breathing = settings.motion.breathing;
        self.motion.set_config(config);
        self.settings = settings;
    }

    /// Whether the pet sleeps.
    #[cfg(test)]
    pub fn is_asleep(&self) -> bool {
        self.asleep
    }

    /// Apply one event that happened at `at` (the frame clock; never later
    /// than the next frame's time).
    pub fn handle(&mut self, event: BuddyAnimatorEvent, at: f64) {
        match event {
            BuddyAnimatorEvent::UtteranceStart {
                state,
                chars,
                bubble_seconds,
            } => {
                self.note_activity(at);
                self.speech = Speech::Bubble(state);
                self.glance = None;
                let bubble_seconds = if bubble_seconds.is_finite() {
                    bubble_seconds.max(0.0)
                } else {
                    0.0
                };
                let talk_seconds = (chars as f64 * TALK_SECONDS_PER_CHAR).min(bubble_seconds);
                self.talk = (talk_seconds > 0.0).then_some(Talk {
                    until: at + talk_seconds,
                    steps: 0,
                    next_step_at: at,
                });
                if state == CohostUtteranceState::Laugh {
                    self.enqueue(vec![LAUGH_ID.to_string()], at);
                }
            }
            BuddyAnimatorEvent::UtteranceEnd => {
                if matches!(self.speech, Speech::Bubble(_)) {
                    self.speech = Speech::Quiet;
                }
                self.talk = None;
            }
            BuddyAnimatorEvent::ThinkStart => {
                self.note_activity(at);
                if self.speech == Speech::Quiet {
                    self.speech = Speech::Think;
                    self.glance = None;
                }
            }
            BuddyAnimatorEvent::ThinkSettle => {
                if self.speech == Speech::Think {
                    self.speech = Speech::Quiet;
                }
            }
            BuddyAnimatorEvent::Trigger { trigger, reaction } => {
                if trigger != BuddyTrigger::DestinationFailed {
                    self.note_activity(at);
                }
                let chain =
                    trigger_reaction_chain(trigger, reaction.as_deref(), &self.settings.reactions);
                self.enqueue(chain, at);
            }
            BuddyAnimatorEvent::React { reaction } => {
                self.note_activity(at);
                self.enqueue(vec![reaction], at);
            }
            BuddyAnimatorEvent::HighlightLive { ttl_seconds } => {
                self.note_activity(at);
                let ttl = if ttl_seconds.is_finite() && ttl_seconds > 0.0 {
                    ttl_seconds
                } else {
                    CARD_TTL_SECONDS
                };
                self.highlight = Some(HighlightShow { since: at, ttl });
                self.glance = None;
            }
            BuddyAnimatorEvent::HighlightIdle => self.highlight = None,
            BuddyAnimatorEvent::ChatSeen => self.note_activity(at),
            BuddyAnimatorEvent::Settings(settings) => self.set_settings(settings),
        }
    }

    /// Chat, activity, an utterance or a Say: the pet is not alone. A
    /// sleeping pet wakes, surprised (D13).
    fn note_activity(&mut self, at: f64) {
        self.last_activity = Some(self.last_activity.map_or(at, |last| last.max(at)));
        if self.asleep {
            self.asleep = false;
            self.wake = Some(Wake {
                until: at + WAKE_SECONDS,
                moved: false,
            });
        }
    }

    /// Queue a reaction chain (D14): nothing for an empty chain; at most
    /// [`REACTION_QUEUE_MAX`] wait behind the one playing (with none playing,
    /// the head of the queue plays at the next frame), none older than
    /// [`REACTION_MAX_AGE_SECONDS`]. A reaction beyond that is dropped.
    fn enqueue(&mut self, chain: Vec<String>, at: f64) {
        if chain.is_empty() {
            return;
        }
        self.queue
            .retain(|queued| at - queued.at <= REACTION_MAX_AGE_SECONDS);
        let room = REACTION_QUEUE_MAX + usize::from(self.playing.is_none());
        if self.queue.len() >= room {
            return;
        }
        self.queue.push_back(QueuedReaction { chain, at });
    }

    /// One leg's draw at `context.now_seconds`. The first call at a new time
    /// steps the state (timers, queue, motion); later calls at the same time
    /// (the other leg, or the same leg again) only read it.
    pub fn draw(&mut self, context: &BuddySpriteLegContext<'_>) -> Option<BuddySpriteDraw> {
        let now = context.now_seconds;
        let atlas = context.atlas;
        if !now.is_finite() {
            let cell = atlas.cell_for_state(context.avatar_state)?;
            return Some(BuddySpriteDraw::at_rest(
                cell.rect,
                context.buddy_box,
                atlas.meta.pivot,
            ));
        }
        if self.frame != Some(now) {
            self.step(context);
            self.frame = Some(now);
            self.lead = Some(context.leg);
        }
        let leg = context.leg.index();
        match context.highlight_rect {
            Some(_) => {
                if self.legs[leg].card_since.is_none() {
                    self.legs[leg].card_since = Some(now);
                }
            }
            None => self.legs[leg].card_since = None,
        }
        let target = self.gaze_target(context);
        let gaze_cell = nearest_gaze(atlas, target).or_else(|| atlas.neutral());
        let override_cell = self.override_cell(now, atlas);
        let blink_cell = override_cell
            .is_none()
            .then(|| self.leg_blink(leg, now, atlas, gaze_cell))
            .flatten();
        // A blink holds the gaze still (page-pet defers tracking while a
        // reaction frame shows); otherwise a new gaze cell turns the body.
        if blink_cell.is_none()
            && let Some(point) = gaze_cell.and_then(|cell| cell.gaze)
        {
            let previous = self.legs[leg].gaze.replace(point);
            if let Some(previous) = previous
                && previous != point
                && self.lead == Some(context.leg)
                && override_cell.is_none()
            {
                self.motion.gaze_turn(point[0] - previous[0]);
            }
        }
        let cell = override_cell
            .or(blink_cell)
            .or(gaze_cell)
            .or_else(|| atlas.cell_for_state(context.avatar_state))?;
        let [_, _, box_width, box_height] = context.buddy_box;
        let mut config = *self.motion.config();
        config.size = f64::from(box_width.min(box_height));
        self.motion.set_config(config);
        let transform = self.motion.transform();
        let mut draw = BuddySpriteDraw::at_rest(cell.rect, context.buddy_box, atlas.meta.pivot);
        if !transform.is_identity() {
            let css = transform.css_matrix();
            draw.affine = [css[0] as f32, css[1] as f32, css[2] as f32, css[3] as f32];
            draw.translate = [css[4] as f32, css[5] as f32];
        }
        Some(draw)
    }

    /// Once per frame: timers, sleep, the reaction queue, talk steps, blinks,
    /// glances, breathing, then the motion model.
    fn step(&mut self, context: &BuddySpriteLegContext<'_>) {
        let now = context.now_seconds;
        let atlas = context.atlas;
        if self.last_activity.is_none() {
            self.last_activity = Some(now);
        }
        if self.next_blink_at.is_none() {
            self.next_blink_at = Some(now + BLINK_FIRST_SECONDS);
        }
        if self.next_glance_at.is_none() {
            self.next_glance_at = Some(now + self.rng.range(IDLE_GLANCE_EVERY_SECONDS));
        }
        self.reconcile(context.avatar_state);

        // What ended.
        if self
            .highlight
            .is_some_and(|show| now >= show.since + show.ttl)
        {
            self.highlight = None;
        }
        if self.glance.is_some_and(|glance| now >= glance.until) {
            self.glance = None;
        }
        if self.blink.is_some_and(|blink| now >= blink.until) {
            self.blink = None;
        }
        if self.wake.is_some_and(|wake| now >= wake.until) {
            self.wake = None;
        }
        if self
            .playing
            .as_ref()
            .is_some_and(|playing| now >= playing.until)
        {
            self.playing = None;
        }

        // Sleep (D13). A pack without a sleep cell never sleeps (it was
        // swapped for one while the pet slept: it is simply awake).
        if self.asleep && atlas.cell(SLEEP_ID).is_none() {
            self.asleep = false;
        }
        let sleep_after = f64::from(self.settings.motion.sleep_after_seconds);
        if !self.asleep
            && sleep_after > 0.0
            && atlas.cell(SLEEP_ID).is_some()
            && self.speech == Speech::Quiet
            && !self.card_up()
            && self.playing.is_none()
            && self.queue.is_empty()
            && self.wake.is_none()
            && self
                .last_activity
                .is_some_and(|last| now - last >= sleep_after)
        {
            self.asleep = true;
            self.glance = None;
            self.blink = None;
        }

        // Waking: the startle.
        if let Some(wake) = self.wake.as_mut()
            && !wake.moved
        {
            wake.moved = true;
            self.motion.react(SURPRISED_ID, now);
        }

        // The next reaction (D14): never over another one, never over the
        // wake, never asleep.
        if self.playing.is_none() && self.wake.is_none() && !self.asleep {
            while let Some(queued) = self.queue.pop_front() {
                if now - queued.at > REACTION_MAX_AGE_SECONDS {
                    continue;
                }
                let cell = queued
                    .chain
                    .iter()
                    .find(|id| reaction_cell(atlas, id).is_some())
                    .cloned();
                // Held for `max(1.1 s, the motion envelope)`, as page-pet.
                self.motion
                    .react(cell.as_deref().unwrap_or(HOP_REACTION_ID), now);
                let envelope_ends = self.motion.reaction_ends_at().unwrap_or(now);
                self.playing = Some(Playing {
                    cell,
                    until: envelope_ends.max(now + REACTION_HOLD_SECONDS),
                });
                break;
            }
        }

        // Talk steps (D12).
        let bobs = !has_talk_frames(atlas);
        if let Some(talk) = self.talk.as_mut() {
            let mut caught_up = 0;
            while now >= talk.next_step_at && talk.next_step_at < talk.until {
                talk.steps += 1;
                if bobs {
                    self.motion.talk_bob();
                }
                talk.next_step_at += self.rng.range(TALK_STEP_SECONDS);
                caught_up += 1;
                if caught_up >= TALK_CATCH_UP_STEPS {
                    talk.next_step_at = now + self.rng.range(TALK_STEP_SECONDS);
                    break;
                }
            }
            if now >= talk.until {
                self.talk = None;
            }
        }

        // Blink (D13): page-pet's timer runs always; a blink only starts at
        // rest, and only the leg on the neutral cell draws it.
        if self.next_blink_at.is_some_and(|at| now >= at) {
            if !self.asleep
                && self.wake.is_none()
                && self.playing.is_none()
                && self.talk.is_none()
                && reaction_cell(atlas, BLINK_ID).is_some()
            {
                self.blink_serial += 1;
                self.blink = Some(Blink {
                    serial: self.blink_serial,
                    until: now + BLINK_SECONDS,
                });
            }
            self.next_blink_at = Some(now + self.rng.range(BLINK_EVERY_SECONDS));
        }

        // Idle glance (D11).
        if self.next_glance_at.is_some_and(|at| now >= at) {
            if self.speech == Speech::Quiet
                && !self.asleep
                && self.wake.is_none()
                && self.highlight.is_none()
                && self.glance.is_none()
            {
                let candidates = atlas
                    .cells
                    .iter()
                    .filter(|cell| cell.kind == PetFrameKind::Gaze)
                    .filter_map(|cell| cell.gaze)
                    .filter(|[x, y]| {
                        x.abs() <= IDLE_GLANCE_REACH + 1e-9
                            && y.abs() <= IDLE_GLANCE_REACH + 1e-9
                            && [*x, *y] != VIEWER_GAZE
                    })
                    .collect::<Vec<_>>();
                if !candidates.is_empty() {
                    let point = candidates[self.rng.index(candidates.len())];
                    self.glance = Some(Glance {
                        point,
                        until: now + self.rng.range(IDLE_GLANCE_FOR_SECONDS),
                    });
                }
            }
            self.next_glance_at = Some(now + self.rng.range(IDLE_GLANCE_EVERY_SECONDS));
        }

        // Motion: the persona's settings, the pack's pivot, breathing only
        // at rest on a gaze cell (D15).
        let mut config = *self.motion.config();
        config.intensity = self.settings.motion.intensity;
        config.breathing = self.settings.motion.breathing;
        config.pivot = atlas.meta.pivot;
        self.motion.set_config(config);
        let resting = self.override_cell(now, atlas).is_none() && self.talk.is_none();
        self.motion.set_idle(resting);
        self.motion.advance(now);
    }

    /// plan 164's state is the truth about whether a bubble or a pending
    /// answer is up; the events carry the details (mood, length). A state
    /// with no matching event (a test, a missed event) is taken as it is.
    fn reconcile(&mut self, avatar: CohostAvatarState) {
        match avatar {
            CohostAvatarState::Idle => {
                if self.speech != Speech::Quiet {
                    self.speech = Speech::Quiet;
                    self.talk = None;
                }
            }
            CohostAvatarState::Think => match self.speech {
                Speech::Quiet => self.speech = Speech::Think,
                Speech::Bubble(CohostUtteranceState::Talk | CohostUtteranceState::Laugh) => {
                    self.speech = Speech::Think;
                    self.talk = None;
                }
                Speech::Think | Speech::Bubble(CohostUtteranceState::Think) => {}
            },
            CohostAvatarState::Talk | CohostAvatarState::Laugh => {
                let mood = if avatar == CohostAvatarState::Laugh {
                    CohostUtteranceState::Laugh
                } else {
                    CohostUtteranceState::Talk
                };
                if self.speech != Speech::Bubble(mood) {
                    self.speech = Speech::Bubble(mood);
                }
            }
        }
    }

    /// The blink cell when this leg blinks now: decided once per blink, from
    /// whether the leg rests on the neutral cell as it starts.
    fn leg_blink<'a>(
        &mut self,
        leg: usize,
        now: f64,
        atlas: &'a BuddySpriteAtlas,
        gaze_cell: Option<&BuddySpriteCell>,
    ) -> Option<&'a BuddySpriteCell> {
        let blink = self.blink.filter(|blink| now < blink.until)?;
        let memory = &mut self.legs[leg];
        let shows = match memory.blink {
            Some((serial, shows)) if serial == blink.serial => shows,
            _ => {
                let shows = gaze_cell.is_some_and(|cell| {
                    cell.id == atlas.meta.neutral && cell.gaze.is_some() && memory.gaze == cell.gaze
                });
                memory.blink = Some((blink.serial, shows));
                shows
            }
        };
        shows.then(|| reaction_cell(atlas, BLINK_ID)).flatten()
    }

    fn card_up(&self) -> bool {
        self.highlight.is_some() || self.legs.iter().any(|leg| leg.card_since.is_some())
    }

    /// The cell every leg shows regardless of its gaze, if any: the wake, a
    /// drawn reaction, sleep, the talk cycle, or plan 164's state cell.
    fn override_cell<'a>(
        &self,
        now: f64,
        atlas: &'a BuddySpriteAtlas,
    ) -> Option<&'a BuddySpriteCell> {
        if self.wake.is_some_and(|wake| now < wake.until)
            && let Some(cell) = reaction_cell(atlas, SURPRISED_ID)
        {
            return Some(cell);
        }
        if let Some(id) = self
            .playing
            .as_ref()
            .filter(|playing| now < playing.until)
            .and_then(|playing| playing.cell.as_deref())
            && let Some(cell) = reaction_cell(atlas, id)
        {
            return Some(cell);
        }
        if self.asleep {
            return atlas.cell(SLEEP_ID);
        }
        let talk_frames = talk_frame_ids(atlas);
        if let Some(talk) = self.talk.filter(|talk| talk.steps > 0)
            && !talk_frames.is_empty()
        {
            let step = (talk.steps - 1) % (talk_frames.len() + 1);
            return match talk_frames.get(step) {
                Some(id) => atlas.cell(id),
                None => atlas.neutral(),
            };
        }
        match self.speech {
            Speech::Bubble(mood) if talk_frames.is_empty() => {
                reaction_cell(atlas, CohostAvatarState::from(mood).as_str())
            }
            Speech::Think => reaction_cell(atlas, THINK_ID),
            _ => None,
        }
    }

    /// Where this leg looks (D11), in page-pet gaze units.
    fn gaze_target(&self, context: &BuddySpriteLegContext<'_>) -> [f64; 2] {
        let now = context.now_seconds;
        let leg = context.leg.index();
        let card = context.highlight_rect.and_then(|rect| {
            let seen = self.legs[leg].card_since?;
            let (since, ttl) = match self.highlight {
                Some(show) => (seen.max(show.since), show.ttl),
                None => (seen, CARD_TTL_SECONDS),
            };
            Some((rect, since, ttl))
        });
        if let Some((rect, since, _)) = card
            && now < since + CARD_LOOK_SECONDS
        {
            return card_gaze(context.buddy_box, context.atlas.meta.head_top, rect);
        }
        match self.speech {
            Speech::Think => return THINK_GAZE,
            Speech::Bubble(_) => return VIEWER_GAZE,
            Speech::Quiet => {}
        }
        if let Some((rect, since, ttl)) = card {
            let glance_at = since + ttl / 2.0;
            if now >= glance_at && now < glance_at + CARD_GLANCE_SECONDS {
                return card_gaze(context.buddy_box, context.atlas.meta.head_top, rect);
            }
        }
        if let Some(glance) = self.glance {
            return glance.point;
        }
        VIEWER_GAZE
    }
}

/// page-pet's tracking vector from the pet's head anchor (the top of the
/// neutral silhouette, D16) to the card's centre, over `max(1.3 * size, 120)`,
/// clamped to [-1, 1].
pub fn card_gaze(buddy_box: [f32; 4], head_top: f64, card: [f32; 4]) -> [f64; 2] {
    let [box_x, box_y, box_width, box_height] = buddy_box.map(f64::from);
    let [card_x, card_y, card_width, card_height] = card.map(f64::from);
    let size = box_width.min(box_height);
    let head = [
        box_x + box_width / 2.0,
        box_y + head_top.clamp(0.0, 1.0) * box_height,
    ];
    let centre = [card_x + card_width / 2.0, card_y + card_height / 2.0];
    let radius = (GAZE_RADIUS_PER_SIZE * size).max(GAZE_MIN_RADIUS_PX);
    [
        ((centre[0] - head[0]) / radius).clamp(-1.0, 1.0),
        ((centre[1] - head[1]) / radius).clamp(-1.0, 1.0),
    ]
}

/// page-pet's `nearestGaze`: the gaze cell closest to `(x, y)`; ties keep the
/// first.
pub fn nearest_gaze(atlas: &BuddySpriteAtlas, [x, y]: [f64; 2]) -> Option<&BuddySpriteCell> {
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for cell in &atlas.cells {
        if cell.kind != PetFrameKind::Gaze {
            continue;
        }
        let Some([gaze_x, gaze_y]) = cell.gaze else {
            continue;
        };
        let distance = (gaze_x - x).powi(2) + (gaze_y - y).powi(2);
        if distance < best_distance {
            best = Some(cell);
            best_distance = distance;
        }
    }
    best
}

fn reaction_cell<'a>(atlas: &'a BuddySpriteAtlas, id: &str) -> Option<&'a BuddySpriteCell> {
    atlas
        .cells
        .iter()
        .find(|cell| cell.kind == PetFrameKind::Reaction && cell.id == id)
}

/// The pack's talk frames that exist (its sidecar `talk`, D12).
fn talk_frame_ids(atlas: &BuddySpriteAtlas) -> Vec<&str> {
    atlas
        .meta
        .talk
        .iter()
        .map(String::as_str)
        .filter(|id| atlas.cell(id).is_some())
        .collect()
}

fn has_talk_frames(atlas: &BuddySpriteAtlas) -> bool {
    atlas.meta.talk.iter().any(|id| atlas.cell(id).is_some())
}

// --- On the slot ---------------------------------------------------------------------------

/// The animator as the sprite slot's source (installed by `AppState::new`):
/// it keeps the events the slot hands it until the next frame and maps the
/// render path's clock onto its own.
#[derive(Debug, Clone)]
pub struct BuddyAnimatorSource {
    animator: BuddyAnimator,
    pending: VecDeque<(Instant, BuddyAnimatorEvent)>,
    /// The raw clock of the last frame and the animator time it mapped to.
    last: Option<(f64, f64)>,
    offset: f64,
}

impl BuddyAnimatorSource {
    pub fn new(settings: BuddyAnimatorSettings, seed: u64) -> Self {
        Self {
            animator: BuddyAnimator::new(settings, seed),
            pending: VecDeque::new(),
            last: None,
            offset: 0.0,
        }
    }

    pub fn for_persona(persona: &CohostPersona) -> Self {
        Self::new(BuddyAnimatorSettings::from_persona(persona), process_seed())
    }

    /// The animator's time for a frame clock reading. Both render paths run
    /// their own clock (CPU and Metal: seconds since the slot was made; D3D11:
    /// the pump's `output_sequence / fps`, from 0 every session), so a clock
    /// that went backwards or jumped past [`CLOCK_MAX_GAP_SECONDS`] continues
    /// the animator's time one nominal frame on instead.
    fn animator_time(&mut self, raw: f64) -> f64 {
        if let Some((last_raw, last_time)) = self.last {
            if raw == last_raw {
                return last_time;
            }
            let delta = raw - last_raw;
            if !(0.0..=CLOCK_MAX_GAP_SECONDS).contains(&delta) {
                self.offset = last_time + CLOCK_NOMINAL_STEP_SECONDS - raw;
                // A new run of frames (a new session, the other pump): the
                // body starts it at rest.
                self.animator.motion.stop();
            }
        }
        let time = raw + self.offset;
        self.last = Some((raw, time));
        time
    }
}

impl BuddySpriteSource for BuddyAnimatorSource {
    fn draw(&mut self, context: &BuddySpriteLegContext<'_>) -> Option<BuddySpriteDraw> {
        if !context.now_seconds.is_finite() {
            return self.animator.draw(context);
        }
        let previous = self.last.map(|(_, time)| time);
        let now = self.animator_time(context.now_seconds);
        if previous != Some(now) && !self.pending.is_empty() {
            // Each event lands when it happened, by its age on the wall
            // clock: a talk that began 0.2 s ago is 0.2 s into its cycle, a
            // reaction that waited 8 s for a frame is too old to play.
            let wall = Instant::now();
            for (at, event) in std::mem::take(&mut self.pending) {
                let age = wall.saturating_duration_since(at).as_secs_f64();
                self.animator.handle(event, now - age);
            }
        }
        let context = BuddySpriteLegContext {
            now_seconds: now,
            ..*context
        };
        self.animator.draw(&context)
    }

    fn notify(&mut self, at: Instant, event: BuddyAnimatorEvent) {
        if let BuddyAnimatorEvent::Settings(settings) = event {
            self.animator.set_settings(settings);
            return;
        }
        if self.pending.len() >= PENDING_MAX {
            self.pending.pop_front();
        }
        self.pending.push_back((at, event));
    }
}

// --- Chat (S-C3) ------------------------------------------------------------------------------

/// The trigger an Activity kind fires (D14's table).
pub fn trigger_for_activity(kind: CohostActivityTemplateKind) -> BuddyTrigger {
    use CohostActivityTemplateKind as Kind;
    match kind {
        Kind::Follow => BuddyTrigger::Follow,
        Kind::Sub | Kind::Resub | Kind::Membership => BuddyTrigger::Subscription,
        Kind::SubGift | Kind::CommunitySubGift => BuddyTrigger::Gift,
        Kind::Cheer | Kind::Kicks | Kind::SuperChat | Kind::SuperSticker | Kind::PowerUp => {
            BuddyTrigger::Tip
        }
        Kind::Raid => BuddyTrigger::Raid,
        Kind::WatchStreak => BuddyTrigger::WatchStreak,
        Kind::Redemption => BuddyTrigger::Redemption,
    }
}

/// The animator's view of rows just delivered to chat: one
/// [`BuddyAnimatorEvent::Trigger`] per fresh Activity row (with the reaction
/// of the greeting template that answers it, when one sets it), and one
/// [`BuddyAnimatorEvent::ChatSeen`] when any other fresh row came. Tombstones
/// and moderation rows are private and never count.
pub fn live_chat_events(
    messages: &[LiveChatMessage],
    auto_chat: &CohostAutoChat,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<BuddyAnimatorEvent> {
    let mut events = Vec::new();
    let mut chat = false;
    for message in messages {
        if message.is_deleted
            || matches!(
                message.event_type,
                LiveChatEventType::Deleted | LiveChatEventType::Moderation
            )
            || !reaction_fresh(message, now)
        {
            continue;
        }
        match crate::cohost_greetings::activity_facts(message) {
            Some(facts) => events.push(BuddyAnimatorEvent::Trigger {
                trigger: trigger_for_activity(facts.kind),
                reaction: greeting_reaction(auto_chat, facts.kind, facts.platform),
            }),
            None => chat = true,
        }
    }
    if chat {
        events.push(BuddyAnimatorEvent::ChatSeen);
    }
    events
}

/// A row counts when it was published within
/// [`ACTIVITY_REACTION_FRESH_SECONDS`]; an unparseable time counts.
fn reaction_fresh(message: &LiveChatMessage, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(&message.published_at).map_or(true, |published| {
        now.signed_duration_since(published).num_seconds() <= ACTIVITY_REACTION_FRESH_SECONDS
    })
}

/// The reaction a greeting template sets for this kind and platform, when
/// greetings answer it (D14: the greeting's own reaction wins). Several
/// matching templates: the first that sets one.
fn greeting_reaction(
    auto_chat: &CohostAutoChat,
    kind: CohostActivityTemplateKind,
    platform: crate::streaming::StreamPlatform,
) -> Option<String> {
    if auto_chat.mode == CohostAutoChatMode::Off || !auto_chat.greetings.enabled {
        return None;
    }
    let platform = crate::cohost_greetings::greeting_platform(platform);
    auto_chat
        .greetings
        .templates
        .iter()
        .filter(|template| template.enabled && template.kind == kind)
        .filter(|template| template.platform.is_none() || template.platform == platform)
        .find_map(|template| template.reaction.clone())
}

#[cfg(test)]
pub(crate) mod tests;
