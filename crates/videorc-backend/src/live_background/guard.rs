//! The budget guard (plan 190 "Budget guard"): a live background may never
//! make the compositor miss frames. Each 2 s window it checks the background's
//! own render time and the compositor's missed deadlines; over budget, it
//! steps Full → Half → Still. It never climbs back for the same background
//! (a new look or motion included); a different background starts at Full,
//! since the five cost very different amounts.

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
