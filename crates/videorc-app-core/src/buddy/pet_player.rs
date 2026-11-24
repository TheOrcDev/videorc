//! The living preview's brain (plan 220 S3.10d, `lib/buddy-pet-player.ts`):
//! page-pet's runtime without the window, driven by an injected clock so
//! tests can step it. The page feeds it the pointer, the clicks and the
//! frame clock and draws [`PetPlayer::frame`] with [`PetPlayer::advance`].
//!
//! Kept number for number: the 160 ms idle tick, the nearest gaze cell to
//! the pointer (16 px dead zone, radius `max(120, 1.3 × size)`), the click
//! cycle over every reaction but blink and sleep (250 ms cooldown, a hold of
//! `max(1.1 s, the motion envelope)`), the blink every 3.5 to 6 s only on the
//! neutral cell (160 ms), sleep after the persona's quiet spell, and reduced
//! motion (no tracking, no idle, no transforms; a click still shows its
//! drawn reaction). The motion is the stream's own ([`super::motion`]).
//! Times are milliseconds.

use super::motion::{BuddyMotion, DEFAULT_PIVOT, MotionConfig, MotionTransform};
use videorc_protocol::buddy_pet::BuddyMotionSettings;

/// The motion pose of a motion-only hop (the animator's `HOP_REACTION_ID`).
pub const HOP_REACTION_ID: &str = "hop";
/// The talk frames a pack may have (D12).
pub const TALK_IDS: [&str; 2] = ["talk-a", "talk-b"];
/// D12: one talk step lasts 110 to 150 ms.
pub const TALK_STEP_MS: f64 = 110.0;
pub const TALK_STEP_JITTER_MS: f64 = 40.0;
const TALK_CATCH_UP_STEPS: usize = 4;
/// page-pet's idle clock.
pub const TICK_MS: f64 = 160.0;
pub const DEAD_ZONE_PX: f64 = 16.0;
pub const MIN_RADIUS_PX: f64 = 120.0;
pub const RADIUS_PER_SIZE: f64 = 1.3;
pub const CLICK_COOLDOWN_MS: f64 = 250.0;
/// A reaction frame holds at least this long (page-pet's 1100 ms).
pub const REACTION_HOLD_MS: f64 = 1100.0;
pub const BLINK_MS: f64 = 160.0;
pub const BLINK_EVERY_MS: f64 = 3500.0;
pub const BLINK_JITTER_MS: f64 = 2500.0;
/// Reactions a click never cycles to.
pub const IDLE_REACTIONS: [&str; 2] = ["blink", "sleep"];
/// The spring settles well inside this after an impulse.
const SPRING_SETTLE_MS: f64 = 1500.0;

/// One frame of a pack: a gaze cell (with its page-pet coordinates in
/// [-1, 1]²) or a reaction.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub id: String,
    pub reaction: bool,
    pub gaze: Option<[f64; 2]>,
}

/// What the player plays.
#[derive(Debug, Clone, PartialEq)]
pub struct Pack {
    pub neutral: String,
    pub pivot: Option<[f64; 2]>,
    pub frames: Vec<Frame>,
}

/// The pet's box in the window, for the gaze.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// How often the page must run: every frame, at breathing pace, or only the
/// idle tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cadence {
    Frame,
    Breath,
    Tick,
}

/// page-pet's `nearestGaze`: the gaze frame closest to `(x, y)`; ties keep
/// the first.
pub fn nearest_gaze(frames: &[Frame], x: f64, y: f64) -> Option<usize> {
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for (index, frame) in frames.iter().enumerate() {
        let Some([gx, gy]) = frame.gaze else {
            continue;
        };
        let distance = (gx - x).powi(2) + (gy - y).powi(2);
        if distance < best_distance {
            best = Some(index);
            best_distance = distance;
        }
    }
    best
}

/// page-pet's `track()` geometry: the pointer as a gaze point from the box's
/// centre; inside 16 px on an axis that axis is 0, beyond it the offset over
/// the radius, clamped to [-1, 1].
pub fn pointer_gaze(pointer_x: f64, pointer_y: f64, rect: Rect) -> [f64; 2] {
    let radius = MIN_RADIUS_PX.max(rect.width * RADIUS_PER_SIZE);
    let dx = pointer_x - rect.left - rect.width / 2.0;
    let dy = pointer_y - rect.top - rect.height / 2.0;
    let axis = |delta: f64| {
        if delta.abs() < DEAD_ZONE_PX {
            0.0
        } else {
            (delta / radius).clamp(-1.0, 1.0)
        }
    };
    [axis(dx), axis(dy)]
}

/// The player (`BuddyPetPlayer`).
pub struct PetPlayer {
    frames: Vec<Frame>,
    gazes: Vec<usize>,
    talk_frames: Vec<usize>,
    neutral: usize,
    motion: BuddyMotion,
    random: Box<dyn FnMut() -> f64>,
    pivot: [f64; 2],
    settings: BuddyMotionSettings,
    reduced: bool,
    gaze: usize,
    current: usize,
    reaction_until: f64,
    last_activity: f64,
    next_blink: f64,
    held: Option<usize>,
    talking: bool,
    talk_steps: usize,
    next_talk_step: f64,
    click_index: usize,
    last_click: f64,
    live_until: f64,
}

impl std::fmt::Debug for PetPlayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PetPlayer")
            .field("current", &self.frames[self.current].id)
            .field("gaze", &self.frames[self.gaze].id)
            .finish_non_exhaustive()
    }
}

impl PetPlayer {
    /// A player on `pack` at `now`; None when the pack has no neutral gaze
    /// frame.
    pub fn new(
        pack: Pack,
        size: f64,
        settings: BuddyMotionSettings,
        reduced: bool,
        now: f64,
        random: Box<dyn FnMut() -> f64>,
    ) -> Option<Self> {
        let neutral = pack
            .frames
            .iter()
            .position(|frame| frame.id == pack.neutral && !frame.reaction)?;
        let gazes = (0..pack.frames.len())
            .filter(|&i| !pack.frames[i].reaction && pack.frames[i].gaze.is_some())
            .collect();
        let talk_frames = TALK_IDS
            .iter()
            .filter_map(|id| {
                pack.frames
                    .iter()
                    .position(|frame| frame.id == *id && frame.reaction)
            })
            .collect();
        let pivot = pack.pivot.unwrap_or(DEFAULT_PIVOT);
        let motion = BuddyMotion::new(MotionConfig {
            intensity: settings.intensity,
            size,
            breathing: settings.breathing,
            pivot,
            ..MotionConfig::default()
        });
        Some(Self {
            frames: pack.frames,
            gazes,
            talk_frames,
            neutral,
            motion,
            random,
            pivot,
            settings,
            reduced,
            gaze: neutral,
            current: neutral,
            reaction_until: 0.0,
            last_activity: now,
            next_blink: now + BLINK_EVERY_MS,
            held: None,
            talking: false,
            talk_steps: 0,
            next_talk_step: 0.0,
            click_index: 0,
            last_click: f64::NEG_INFINITY,
            live_until: 0.0,
        })
    }

    /// The frame to draw now.
    pub fn frame(&self) -> &str {
        &self.frames[self.current].id
    }

    pub fn is_talking(&self) -> bool {
        self.talking
    }

    /// The pack's reaction ids, in manifest order.
    pub fn reactions(&self) -> Vec<String> {
        self.frames
            .iter()
            .filter(|frame| frame.reaction)
            .map(|frame| frame.id.clone())
            .collect()
    }

    pub fn has_reaction(&self, id: &str) -> bool {
        self.reaction_frame(id).is_some()
    }

    /// The neutral gaze frame's id.
    pub fn neutral(&self) -> &str {
        &self.frames[self.neutral].id
    }

    /// The gaze frames with their page-pet coordinates (the Test dialog's
    /// think fallback).
    pub fn gazes(&self) -> Vec<(String, [f64; 2])> {
        self.gazes
            .iter()
            .filter_map(|&i| {
                self.frames[i]
                    .gaze
                    .map(|gaze| (self.frames[i].id.clone(), gaze))
            })
            .collect()
    }

    pub fn set_motion_settings(&mut self, settings: BuddyMotionSettings) {
        self.settings = settings;
        let config = MotionConfig {
            intensity: settings.intensity,
            breathing: settings.breathing,
            ..*self.motion.config()
        };
        self.motion.set_config(config);
    }

    pub fn set_size(&mut self, size: f64) {
        let config = MotionConfig {
            size,
            ..*self.motion.config()
        };
        self.motion.set_config(config);
    }

    /// Reduced motion changed: back to the neutral cell, motion off.
    pub fn set_reduced_motion(&mut self, reduced: bool) -> bool {
        if reduced == self.reduced {
            return false;
        }
        self.reduced = reduced;
        if reduced {
            self.motion.stop();
        }
        self.center()
    }

    /// The preview went hidden.
    pub fn stop(&mut self) {
        self.motion.stop();
        self.live_until = 0.0;
    }

    /// page-pet's `track()`: the gaze follows the pointer; a turn nudges the
    /// body unless a reaction holds. Whether the drawn frame changed.
    pub fn track(&mut self, pointer_x: f64, pointer_y: f64, rect: Rect, now: f64) -> bool {
        if self.held.is_some() || self.reduced {
            return false;
        }
        self.last_activity = now;
        let [x, y] = pointer_gaze(pointer_x, pointer_y, rect);
        let previous = self.gaze;
        let gaze_frames: Vec<Frame> = self.gazes.iter().map(|&i| self.frames[i].clone()).collect();
        self.gaze = nearest_gaze(&gaze_frames, x, y)
            .map(|index| self.gazes[index])
            .unwrap_or(self.neutral);
        if previous != self.gaze && self.reaction_until == 0.0 {
            let to = self.frames[self.gaze].gaze.map_or(0.0, |g| g[0]);
            let from = self.frames[previous].gaze.map_or(0.0, |g| g[0]);
            self.motion.gaze_turn(to - from);
            self.live_until = self.live_until.max(now + SPRING_SETTLE_MS);
        }
        if self.reaction_until == 0.0 && self.current != self.gaze {
            self.current = self.gaze;
            return true;
        }
        false
    }

    /// page-pet's `center()`: the pointer left.
    pub fn center(&mut self) -> bool {
        if self.held.is_some() {
            return false;
        }
        self.gaze = self.neutral;
        if self.reaction_until == 0.0 && self.current != self.gaze {
            self.current = self.gaze;
            return true;
        }
        false
    }

    /// page-pet's click cycle: the next reaction but blink and sleep, at
    /// most one per 250 ms. The id played.
    pub fn click(&mut self, now: f64) -> Option<String> {
        if now - self.last_click < CLICK_COOLDOWN_MS {
            return None;
        }
        self.last_click = now;
        let cycle: Vec<String> = self
            .frames
            .iter()
            .filter(|frame| frame.reaction && !IDLE_REACTIONS.contains(&frame.id.as_str()))
            .map(|frame| frame.id.clone())
            .collect();
        if cycle.is_empty() {
            return None;
        }
        let id = cycle[self.click_index % cycle.len()].clone();
        self.click_index += 1;
        self.react(&id, now, REACTION_HOLD_MS, true).then_some(id)
    }

    /// page-pet's `react`: the reaction frame for `duration_ms` (160 ms to
    /// 30 s) or the motion envelope, whichever is longer. False when the
    /// pack has no such reaction.
    pub fn react(&mut self, id: &str, now: f64, duration_ms: f64, activity: bool) -> bool {
        let Some(frame) = self.reaction_frame(id) else {
            return false;
        };
        if activity {
            self.last_activity = now;
        }
        let hold = if duration_ms.is_finite() && duration_ms > 0.0 {
            duration_ms
        } else {
            REACTION_HOLD_MS
        };
        self.reaction_until = now + hold.clamp(160.0, 30_000.0);
        self.current = frame;
        if activity && id != "blink" && !self.reduced {
            let seconds = self.motion.react(id, now / 1000.0);
            self.reaction_until = self.reaction_until.max(now + seconds * 1000.0);
        }
        true
    }

    /// D14's last fallback: a reaction the pack has no frame for hops on the
    /// current frame. False under reduced motion or at Motion 0.
    pub fn hop(&mut self, now: f64) -> bool {
        if self.reduced {
            return false;
        }
        self.last_activity = now;
        self.motion.react(HOP_REACTION_ID, now / 1000.0) > 0.0
    }

    /// page-pet's `pose(id)` / `unlock()`: hold one frame until released
    /// with None. Whether the drawn frame changed.
    pub fn pose(&mut self, id: Option<&str>, now: f64) -> bool {
        let Some(id) = id else {
            if self.held.is_none() {
                return false;
            }
            self.held = None;
            self.reaction_until = 0.0;
            self.last_activity = now;
            let before = self.current;
            self.center();
            self.current = self.gaze;
            return before != self.current;
        };
        let Some(frame) = self.frames.iter().position(|frame| frame.id == id) else {
            return false;
        };
        let entering = self.held.is_none();
        self.held = Some(frame);
        if entering {
            self.motion.stop();
            self.reaction_until = 0.0;
        } else if self.reaction_until != 0.0 && now < self.reaction_until {
            return false;
        }
        let changed = self.current != frame;
        self.current = frame;
        changed
    }

    /// D12's talk cycle until stopped. Whether the drawn frame changed.
    pub fn set_talking(&mut self, talking: bool, now: f64) -> bool {
        if talking == self.talking {
            return false;
        }
        self.talking = talking;
        self.talk_steps = 0;
        self.next_talk_step = now;
        self.last_activity = now;
        if talking || self.reaction_until != 0.0 {
            return false;
        }
        let rest = self.held.unwrap_or(self.gaze);
        let changed = self.current != rest;
        self.current = rest;
        changed
    }

    /// page-pet's `tick()`, every 160 ms. Whether the drawn frame changed.
    pub fn tick(&mut self, now: f64) -> bool {
        let before = self.current;
        if self.reaction_until != 0.0 {
            if now < self.reaction_until {
                return false;
            }
            self.reaction_until = 0.0;
            self.current = self.held.unwrap_or(self.gaze);
        }
        if self.held.is_some() {
            return self.current != before;
        }
        if self.talking {
            self.last_activity = now;
            return self.current != before;
        }
        if self.reduced {
            return self.current != before;
        }
        let sleep = self.frames.iter().position(|frame| frame.id == "sleep");
        let sleep_after_ms = f64::from(self.settings.sleep_after_seconds) * 1000.0;
        if let Some(sleep) = sleep
            && sleep_after_ms > 0.0
            && now - self.last_activity > sleep_after_ms
        {
            self.current = sleep;
        } else if now > self.next_blink {
            // The blink is front-facing: a turned head never snaps forward.
            if self.gaze == self.neutral {
                self.react("blink", now, BLINK_MS, false);
            }
            self.next_blink = now + BLINK_EVERY_MS + (self.random)() * BLINK_JITTER_MS;
        }
        self.current != before
    }

    /// The transform to draw the frame with at `now`; the identity under
    /// reduced motion.
    pub fn advance(&mut self, now: f64) -> MotionTransform {
        self.step_talk(now);
        if self.reduced {
            return MotionTransform::identity(self.pivot);
        }
        // D15: breathing only while resting on a gaze cell.
        let resting = !self.frames[self.current].reaction
            && self.reaction_until == 0.0
            && self.held.is_none()
            && !self.talking;
        self.motion.set_idle(resting);
        self.motion.advance(now / 1000.0)
    }

    /// How soon the page must run again.
    pub fn cadence(&self, now: f64) -> Cadence {
        let still = self.reduced || self.settings.intensity <= 0.0;
        if self.talking {
            return if still {
                Cadence::Breath
            } else {
                Cadence::Frame
            };
        }
        if still {
            return Cadence::Tick;
        }
        if now < self.live_until || self.motion.reaction_ends_at().is_some() {
            return Cadence::Frame;
        }
        if self.motion.is_resting() {
            Cadence::Tick
        } else {
            Cadence::Breath
        }
    }

    fn step_talk(&mut self, now: f64) {
        if !self.talking {
            return;
        }
        let mut steps = 0;
        while now >= self.next_talk_step && steps < TALK_CATCH_UP_STEPS {
            steps += 1;
            self.talk_steps += 1;
            self.next_talk_step += TALK_STEP_MS + (self.random)() * TALK_STEP_JITTER_MS;
            if self.reaction_until != 0.0 && now < self.reaction_until {
                continue;
            }
            if self.talk_frames.is_empty() {
                if !self.reduced {
                    self.motion.talk_bob();
                }
            } else {
                let step = (self.talk_steps - 1) % (self.talk_frames.len() + 1);
                self.current = self.talk_frames.get(step).copied().unwrap_or(self.neutral);
            }
        }
        if now >= self.next_talk_step {
            self.next_talk_step = now + TALK_STEP_MS + (self.random)() * TALK_STEP_JITTER_MS;
        }
    }

    fn reaction_frame(&self, id: &str) -> Option<usize> {
        self.frames
            .iter()
            .position(|frame| frame.id == id && frame.reaction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack() -> Pack {
        let gaze = |id: &str, x: f64, y: f64| Frame {
            id: id.into(),
            reaction: false,
            gaze: Some([x, y]),
        };
        let reaction = |id: &str| Frame {
            id: id.into(),
            reaction: true,
            gaze: None,
        };
        Pack {
            neutral: "c".into(),
            pivot: None,
            frames: vec![
                gaze("c", 0.0, 0.0),
                gaze("l", -1.0, 0.0),
                gaze("r", 1.0, 0.0),
                reaction("blink"),
                reaction("wave"),
                reaction("laugh"),
                reaction("sleep"),
                reaction("talk-a"),
            ],
        }
    }

    fn settings() -> BuddyMotionSettings {
        BuddyMotionSettings {
            intensity: 0.45,
            sleep_after_seconds: 30,
            breathing: true,
        }
    }

    fn player(reduced: bool) -> PetPlayer {
        PetPlayer::new(pack(), 180.0, settings(), reduced, 0.0, Box::new(|| 0.5)).unwrap()
    }

    const RECT: Rect = Rect {
        left: 0.0,
        top: 0.0,
        width: 180.0,
        height: 180.0,
    };

    #[test]
    fn the_gaze_follows_the_pointer_past_the_dead_zone() {
        assert_eq!(pointer_gaze(95.0, 90.0, RECT), [0.0, 0.0]);
        assert_eq!(pointer_gaze(0.0, 90.0, RECT), [-90.0 / 234.0, 0.0]);
        let mut pet = player(false);
        assert!(pet.track(-500.0, 90.0, RECT, 10.0));
        assert_eq!(pet.frame(), "l");
        assert!(pet.center());
        assert_eq!(pet.frame(), "c");
    }

    #[test]
    fn a_click_cycles_the_reactions_but_blink_and_sleep() {
        let mut pet = player(false);
        assert_eq!(pet.click(1000.0).as_deref(), Some("wave"));
        // Inside the cooldown nothing plays.
        assert_eq!(pet.click(1100.0), None);
        assert_eq!(pet.click(1300.0).as_deref(), Some("laugh"));
        assert_eq!(pet.click(1600.0).as_deref(), Some("talk-a"));
        assert_eq!(pet.click(1900.0).as_deref(), Some("wave"));
        // The reaction holds, then the tick returns to the gaze (before the
        // quiet spell puts it to sleep).
        // (A blink may be due by then: it shows on the neutral cell.)
        assert!(pet.tick(6_000.0));
        assert!(matches!(pet.frame(), "c" | "blink"), "{}", pet.frame());
    }

    #[test]
    fn a_quiet_pet_sleeps_and_reduced_motion_never_moves() {
        let mut pet = player(false);
        pet.tick(31_000.0);
        assert_eq!(pet.frame(), "sleep");
        let mut still = player(true);
        assert!(!still.track(-500.0, 90.0, RECT, 10.0));
        assert!(still.advance(500.0).is_identity());
        assert_eq!(still.cadence(500.0), Cadence::Tick);
        // A click still shows its drawn reaction.
        assert_eq!(still.click(1000.0).as_deref(), Some("wave"));
    }

    #[test]
    fn talking_cycles_the_talk_frames_and_a_pose_holds() {
        let mut pet = player(false);
        pet.set_talking(true, 0.0);
        pet.advance(1.0);
        assert_eq!(pet.frame(), "talk-a");
        pet.set_talking(false, 200.0);
        assert!(pet.pose(Some("wave"), 300.0));
        assert!(!pet.track(-500.0, 90.0, RECT, 310.0));
        assert!(pet.pose(None, 400.0));
        assert_eq!(pet.frame(), "c");
        assert!(
            PetPlayer::new(
                Pack {
                    neutral: "missing".into(),
                    ..pack()
                },
                180.0,
                settings(),
                false,
                0.0,
                Box::new(|| 0.0)
            )
            .is_none()
        );
    }
}
