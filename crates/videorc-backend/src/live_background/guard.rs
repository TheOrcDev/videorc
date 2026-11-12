//! The budget guard (plan 190 "Budget guard"): a live background may never
//! make the compositor miss frames. Each 2 s window it checks the background's
//! own render time and the compositor's missed deadlines; over budget, it
//! steps Full → Half → Still. It never climbs back for the same background
//! (a new look or motion included); a different background starts at Full,
//! since the five cost very different amounts.
//!
//! Because a step is for good, the guard judges only what the background
//! costs behind the scene. It takes no reading while a takeover screen is up,
//! nor for [`GUARD_SETTLE_AFTER_TAKEOVER`] after one comes off. A takeover
//! going up uploads its picture on every leg and takes the scene's sources
//! out of the frame; coming off, it brings them back. The late ticks around
//! that are not the background's, and judged on them a background stayed on
//! its poster after the takeover until another one was picked (owner report,
//! 2026-11-12). The level it had before the takeover stays.

use std::time::{Duration, Instant};

use crate::protocol::LiveBackgroundId;

pub const GUARD_WINDOW: Duration = Duration::from_secs(2);
/// Over budget: the background's p95 above this share of the frame interval.
pub const GUARD_SHARE_OF_FRAME: f64 = 0.2;
/// Missed deadlines count against the background only when it is also
/// expensive (above this share), so a capture stall doesn't blame it.
pub const GUARD_SHARE_WITH_MISSES: f64 = 0.1;
pub const GUARD_MISSES_PER_WINDOW: u32 = 3;
/// A window needs this many timed frames before it can judge.
pub const GUARD_MIN_SAMPLES: usize = 10;
/// After a takeover screen comes off, the guard waits this long before it
/// opens a window again.
pub const GUARD_SETTLE_AFTER_TAKEOVER: Duration = GUARD_WINDOW;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GuardLevel {
    #[default]
    Full,
    Half,
    Still,
}

#[derive(Debug, Clone, Default)]
pub struct LiveBackgroundGuard {
    /// The background this level was judged on.
    background: Option<LiveBackgroundId>,
    level: GuardLevel,
    window_started: Option<Instant>,
    samples: Vec<f64>,
    missed: u32,
    last_p95_ms: Option<f64>,
    /// No reading before this instant: a takeover screen was up.
    settle_until: Option<Instant>,
}

impl LiveBackgroundGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn level(&self) -> GuardLevel {
        self.level
    }

    /// Judge `id` from now on: a different background than the last one
    /// starts again at Full with an empty window.
    pub fn follow(&mut self, id: LiveBackgroundId) {
        if self.background != Some(id) {
            *self = Self {
                background: Some(id),
                ..Self::default()
            };
        }
    }

    /// The p95 of the last finished window, for status.
    pub fn last_p95_ms(&self) -> Option<f64> {
        self.last_p95_ms
    }

    /// What one tick tells the guard: its reading, or nothing while a
    /// takeover screen is up and while the scene settles after one. Returns
    /// the new level when it changes.
    pub fn observe(
        &mut self,
        tick: &super::runtime::LiveBackgroundTick,
        render_ms: Option<f64>,
    ) -> Option<GuardLevel> {
        if tick.takeover {
            // The open window goes too: the next one holds only readings
            // taken behind the scene.
            self.window_started = None;
            self.samples.clear();
            self.missed = 0;
            self.settle_until = Some(tick.at + GUARD_SETTLE_AFTER_TAKEOVER);
            return None;
        }
        if self.settle_until.is_some_and(|until| tick.at < until) {
            return None;
        }
        self.settle_until = None;
        self.record(
            tick.at,
            render_ms,
            tick.missed_deadline,
            tick.frame_interval,
        )
    }

    /// Feed one frame: its render time (`None` when the API can't time it)
    /// and whether the compositor missed this frame's deadline. Returns the
    /// new level when it changes.
    pub fn record(
        &mut self,
        now: Instant,
        render_ms: Option<f64>,
        missed_deadline: bool,
        frame_interval: Duration,
    ) -> Option<GuardLevel> {
        if self.level == GuardLevel::Still {
            return None;
        }
        let started = *self.window_started.get_or_insert(now);
        if let Some(ms) = render_ms.filter(|ms| ms.is_finite() && *ms >= 0.0) {
            self.samples.push(ms);
        }
        if missed_deadline {
            self.missed += 1;
        }
        if now.saturating_duration_since(started) < GUARD_WINDOW {
            return None;
        }
        let verdict = self.judge(frame_interval);
        self.window_started = Some(now);
        self.samples.clear();
        self.missed = 0;
        if !verdict {
            return None;
        }
        self.level = match self.level {
            GuardLevel::Full => GuardLevel::Half,
            GuardLevel::Half | GuardLevel::Still => GuardLevel::Still,
        };
        Some(self.level)
    }

    fn judge(&mut self, frame_interval: Duration) -> bool {
        if self.samples.len() < GUARD_MIN_SAMPLES {
            return false;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let index = ((sorted.len() as f64) * 0.95).ceil() as usize;
        let p95 = sorted[index.clamp(1, sorted.len()) - 1];
        self.last_p95_ms = Some(p95);
        let interval_ms = frame_interval.as_secs_f64() * 1000.0;
        p95 > interval_ms * GUARD_SHARE_OF_FRAME
            || (self.missed >= GUARD_MISSES_PER_WINDOW
                && p95 > interval_ms * GUARD_SHARE_WITH_MISSES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_background::LiveBackgroundTick;

    const SIXTY: Duration = Duration::from_nanos(16_666_667);

    fn run_window(
        guard: &mut LiveBackgroundGuard,
        start: Instant,
        ms: f64,
        missed: bool,
    ) -> Option<GuardLevel> {
        let mut change = None;
        for frame in 0..=121 {
            let at = start + SIXTY * frame;
            if let Some(level) = guard.record(at, Some(ms), missed, SIXTY) {
                change = Some(level);
            }
        }
        change
    }

    #[test]
    fn a_cheap_background_stays_full() {
        let mut guard = LiveBackgroundGuard::new();
        assert_eq!(run_window(&mut guard, Instant::now(), 0.9, false), None);
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
    }

    #[test]
    fn an_expensive_background_steps_down_and_never_climbs_back() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // 20 % of a 60 fps frame is 3.33 ms.
        assert_eq!(
            run_window(&mut guard, start, 4.0, false),
            Some(GuardLevel::Half)
        );
        let next = start + Duration::from_secs(3);
        assert_eq!(
            run_window(&mut guard, next, 4.0, false),
            Some(GuardLevel::Still)
        );
        let later = start + Duration::from_secs(6);
        assert_eq!(run_window(&mut guard, later, 0.1, false), None);
        assert_eq!(guard.level(), GuardLevel::Still);
    }

    #[test]
    fn a_different_background_starts_again_at_full() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        guard.follow(LiveBackgroundId::PlasmaWave);
        run_window(&mut guard, start, 4.0, false);
        run_window(&mut guard, start + Duration::from_secs(3), 4.0, false);
        assert_eq!(guard.level(), GuardLevel::Still);
        // The same background (any look or motion) stays on its poster.
        guard.follow(LiveBackgroundId::PlasmaWave);
        assert_eq!(guard.level(), GuardLevel::Still);
        guard.follow(LiveBackgroundId::LiquidChrome);
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), None);
    }

    #[test]
    fn missed_deadlines_only_count_when_the_background_is_also_costly() {
        let mut guard = LiveBackgroundGuard::new();
        assert_eq!(run_window(&mut guard, Instant::now(), 0.5, true), None);
        let mut guard = LiveBackgroundGuard::new();
        // 10 % of a 60 fps frame is 1.67 ms.
        assert_eq!(
            run_window(&mut guard, Instant::now(), 2.0, true),
            Some(GuardLevel::Half)
        );
    }

    /// A tick of a 60 fps loop, `frame` frames after `start`.
    fn tick(start: Instant, frame: u32) -> LiveBackgroundTick {
        LiveBackgroundTick::new(start + SIXTY * frame, SIXTY, true)
    }

    /// Feed `frames` through `observe`, every deadline missed: the last
    /// level change, if any.
    fn observe_frames(
        guard: &mut LiveBackgroundGuard,
        start: Instant,
        frames: std::ops::RangeInclusive<u32>,
        ms: f64,
        takeover: bool,
    ) -> Option<GuardLevel> {
        let mut change = None;
        for frame in frames {
            let tick = tick(start, frame).under_takeover(takeover);
            change = guard.observe(&tick, Some(ms)).or(change);
        }
        change
    }

    /// Owner report 2026-11-12: slow readings and missed deadlines while a
    /// takeover screen was up left the background on its poster for good.
    #[test]
    fn readings_under_a_takeover_never_step_the_guard() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // 8 s at 60 % of the frame, every deadline missed: four windows.
        assert_eq!(observe_frames(&mut guard, start, 0..=480, 10.0, true), None);
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), None, "no window was judged");
        // The takeover comes off: the background is judged again, and passes.
        assert_eq!(
            observe_frames(&mut guard, start, 481..=800, 0.9, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
    }

    #[test]
    fn the_scene_settles_after_a_takeover_before_the_guard_judges_again() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        assert_eq!(observe_frames(&mut guard, start, 0..=0, 10.0, true), None);
        // 1.98 s of slow readings and missed deadlines as the scene's sources
        // come back: none is taken.
        assert_eq!(
            observe_frames(&mut guard, start, 1..=119, 10.0, false),
            None
        );
        // Then cheap ones for a window: only those are judged.
        assert_eq!(
            observe_frames(&mut guard, start, 120..=241, 0.9, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
        // A background that is over budget behind the scene still steps down.
        assert_eq!(
            observe_frames(&mut guard, start, 242..=362, 10.0, false),
            Some(GuardLevel::Half)
        );
        assert_eq!(
            observe_frames(&mut guard, start, 363..=483, 10.0, false),
            Some(GuardLevel::Still)
        );
    }

    #[test]
    fn a_takeover_drops_the_open_window_and_keeps_the_level() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // The first window closes at frame 120, over budget.
        assert_eq!(
            observe_frames(&mut guard, start, 0..=120, 10.0, false),
            Some(GuardLevel::Half)
        );
        // 1.9 s more of slow readings: their window would close over budget
        // at frame 240. The takeover at frame 235 drops them.
        assert_eq!(
            observe_frames(&mut guard, start, 121..=234, 10.0, false),
            None
        );
        assert_eq!(
            observe_frames(&mut guard, start, 235..=235, 10.0, true),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Half, "the level it had stays");
        // The first window after it holds only readings taken after it.
        assert_eq!(
            observe_frames(&mut guard, start, 236..=480, 0.9, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Half);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
    }

    #[test]
    fn untimed_frames_never_judge() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        for frame in 0..=200 {
            assert_eq!(guard.record(start + SIXTY * frame, None, true, SIXTY), None);
        }
        assert_eq!(guard.level(), GuardLevel::Full);
    }
}
