//! The budget guard (plan 190 "Budget guard"): a live background may never
//! make the compositor miss frames. Each 2 s window it checks the background's
//! own render time and the compositor's missed deadlines; over budget, it
//! steps Full → Half → Still. A different background starts at Full, since
//! the ten cost very different amounts.
//!
//! A step down is not for good (owner decision, 2026-11-12, reversing plan
//! 190's "never climbs back"). The owner's health log showed the poster 15
//! times in three weeks, each after a passing load: an update download, a
//! session stopping and its camera restarting, a takeover going up. So after
//! a step the guard watches for a quiet period ([`GUARD_QUIET`]), climbs ONE
//! level and judges the background again as if it had just been picked. If
//! it steps down again soon after a climb the load is still there, and the
//! next wait is twice as long, up to [`GUARD_QUIET_MAX`]; once a climb has
//! held for [`GUARD_HELD`] the wait is short again.
//!
//! "Quiet" is watched time, not wall time. The guard's clock only runs
//! between consecutive readings: a takeover screen, the settle after one and
//! a gap in the ticks add nothing. At Still nothing is drawn, so there is no
//! render time to read and the quiet period is that clock alone. At either
//! level the climb also waits for a window in which the compositor kept its
//! deadlines, so it never climbs into a compositor that is already late.
//!
//! The guard judges only what the background costs behind the scene. It
//! takes no reading while a takeover screen is up, nor for
//! [`GUARD_SETTLE_AFTER_TAKEOVER`] after one comes off. A takeover going up
//! uploads its picture on every leg and takes the scene's sources out of the
//! frame; coming off, it brings them back. The late ticks around that are
//! not the background's (owner report, 2026-11-12). The level it had before
//! the takeover stays.

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
/// How long the guard watches a stepped-down background before it climbs one
/// level. A minute outlasts the loads that stepped it down in the owner's
/// log (two of them were 35 s apart: a session stopping, then its compositor
/// and camera coming back), and is short enough that the motion is back
/// about a minute after the load has gone (two from the poster to full size).
pub const GUARD_QUIET: Duration = Duration::from_secs(60);
/// The longest quiet period. Under a load that does not pass, each try costs
/// one window at the higher level and, from Half, one "graphics card is
/// busy" notice: at most six an hour.
pub const GUARD_QUIET_MAX: Duration = Duration::from_secs(600);
/// A step down this long after the last climb is not a relapse: the climb
/// was right, the load is new, and the wait starts at [`GUARD_QUIET`] again.
/// Ten minutes is the longest wait itself, so a climb is always judged over
/// at least the time it took to earn.
pub const GUARD_HELD: Duration = Duration::from_secs(600);
/// Relapses past this many change nothing ([`GUARD_QUIET`] × 2⁴ is already
/// over [`GUARD_QUIET_MAX`]); the count stops there.
const GUARD_MAX_DOUBLINGS: u32 = 4;

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
    /// How long the guard has watched this background: the time between
    /// consecutive readings.
    watched: Duration,
    /// The last reading, while nothing has interrupted the watch since.
    last_reading_at: Option<Instant>,
    /// The watched time at which a stepped-down background may climb.
    climb_at: Option<Duration>,
    /// The watched time of the last climb, until a step down has judged it.
    climbed_at: Option<Duration>,
    /// Relapses in a row; each doubles the quiet period.
    relapses: u32,
}

impl LiveBackgroundGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn level(&self) -> GuardLevel {
        self.level
    }

    /// Judge `id` from now on: a different background than the last one
    /// starts again at Full with an empty window and no wait.
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
            self.last_reading_at = None;
            return None;
        }
        if self.settle_until.is_some_and(|until| tick.at < until) {
            self.last_reading_at = None;
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
    /// new level when it changes: a step down at the end of a window over
    /// budget, or a climb at the end of a quiet one.
    pub fn record(
        &mut self,
        now: Instant,
        render_ms: Option<f64>,
        missed_deadline: bool,
        frame_interval: Duration,
    ) -> Option<GuardLevel> {
        // The watch clock: a gap longer than a window is time nobody watched.
        if let Some(previous) = self.last_reading_at.replace(now) {
            let gap = now.saturating_duration_since(previous);
            if gap <= GUARD_WINDOW {
                self.watched += gap;
            }
        }
        let started = *self.window_started.get_or_insert(now);
        // At Still nothing is drawn: a time fed there is no reading.
        if self.level != GuardLevel::Still
            && let Some(ms) = render_ms.filter(|ms| ms.is_finite() && *ms >= 0.0)
        {
            self.samples.push(ms);
        }
        if missed_deadline {
            self.missed += 1;
        }
        if now.saturating_duration_since(started) < GUARD_WINDOW {
            return None;
        }
        let over_budget = self.level != GuardLevel::Still && self.judge(frame_interval);
        let compositor_on_time = self.missed < GUARD_MISSES_PER_WINDOW;
        self.window_started = Some(now);
        self.samples.clear();
        self.missed = 0;
        if over_budget {
            return Some(self.step_down());
        }
        let quiet_long_enough = self.climb_at.is_some_and(|at| self.watched >= at);
        (quiet_long_enough && compositor_on_time).then(|| self.climb())
    }

    /// One level down, and the quiet period before the next climb.
    fn step_down(&mut self) -> GuardLevel {
        match self.climbed_at.take() {
            // Down again soon after a climb: the load is still there.
            Some(climbed_at) if self.watched.saturating_sub(climbed_at) < GUARD_HELD => {
                self.relapses = (self.relapses + 1).min(GUARD_MAX_DOUBLINGS);
            }
            // The climb held: this is a new load, and the wait is short again.
            Some(_) => self.relapses = 0,
            // A second step with no climb between (Full, Half, Still in a
            // row) is the same load: the wait it has stays.
            None => {}
        }
        self.level = match self.level {
            GuardLevel::Full => GuardLevel::Half,
            GuardLevel::Half | GuardLevel::Still => GuardLevel::Still,
        };
        self.climb_at = Some(self.watched + self.quiet_period());
        self.level
    }

    /// One level up. The next level, if there is one, takes another quiet
    /// period: never two levels in one.
    fn climb(&mut self) -> GuardLevel {
        self.level = match self.level {
            GuardLevel::Still => GuardLevel::Half,
            GuardLevel::Half | GuardLevel::Full => GuardLevel::Full,
        };
        self.climbed_at = Some(self.watched);
        self.climb_at =
            (self.level != GuardLevel::Full).then(|| self.watched + self.quiet_period());
        self.level
    }

    /// The wait before the next climb: [`GUARD_QUIET`], doubled per relapse.
    fn quiet_period(&self) -> Duration {
        GUARD_QUIET
            .saturating_mul(1 << self.relapses.min(GUARD_MAX_DOUBLINGS))
            .min(GUARD_QUIET_MAX)
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
    fn an_expensive_background_steps_down_to_half_then_the_poster() {
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
        // The same background (any look or motion) keeps the level it has.
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

    // Recovery (owner decision 2026-11-12): the tests below drive the guard
    // on a 10 fps loop, where over budget is above 20 ms a frame.

    const TEN_FPS: Duration = Duration::from_millis(100);
    const SLOW: f64 = 30.0;
    const CHEAP: f64 = 5.0;

    /// A guard on a 10 fps loop and every level change it made, by the
    /// second it happened at.
    struct Loop {
        guard: LiveBackgroundGuard,
        start: Instant,
        ticks: u32,
        changes: Vec<(f64, GuardLevel)>,
    }

    impl Loop {
        fn new() -> Self {
            Self {
                guard: LiveBackgroundGuard::new(),
                start: Instant::now(),
                ticks: 0,
                changes: Vec::new(),
            }
        }

        fn seconds(&self) -> f64 {
            f64::from(self.ticks) / 10.0
        }

        fn tick(&mut self, ms: f64, missed: bool, takeover: bool) {
            let at = self.start + TEN_FPS * self.ticks;
            let tick = LiveBackgroundTick::new(at, TEN_FPS, missed).under_takeover(takeover);
            if let Some(level) = self.guard.observe(&tick, Some(ms)) {
                self.changes.push((self.seconds(), level));
            }
            self.ticks += 1;
        }

        /// Run until the loop's clock reads `second`.
        fn run_to(&mut self, second: u32, ms: f64) {
            while self.ticks <= second * 10 {
                self.tick(ms, false, false);
            }
        }

        /// The same with every deadline missed.
        fn run_late_to(&mut self, second: u32, ms: f64) {
            while self.ticks <= second * 10 {
                self.tick(ms, true, false);
            }
        }

        fn takeover_to(&mut self, second: u32) {
            while self.ticks <= second * 10 {
                self.tick(SLOW, true, true);
            }
        }

        /// Nobody feeds the guard until `second`.
        fn skip_to(&mut self, second: u32) {
            self.ticks = second * 10;
        }
    }

    #[test]
    fn a_stepped_down_background_climbs_one_level_after_a_quiet_minute() {
        let mut run = Loop::new();
        run.run_to(2, SLOW);
        assert_eq!(run.changes, [(2.0, GuardLevel::Half)]);
        // 59.9 s of cheap frames: not yet.
        run.run_to(61, CHEAP);
        assert_eq!(run.changes.len(), 1);
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes,
            [(2.0, GuardLevel::Half), (62.0, GuardLevel::Full)],
            "one climb, a minute after the step, and it holds"
        );
    }

    /// Still → Half → Full, end to end: one level per quiet period, never
    /// two, and a time fed at Still (nothing is drawn there) is no reading.
    #[test]
    fn the_poster_climbs_to_half_then_to_full_one_level_per_quiet_period() {
        let mut run = Loop::new();
        run.run_to(4, SLOW);
        assert_eq!(
            run.changes,
            [(2.0, GuardLevel::Half), (4.0, GuardLevel::Still)]
        );
        run.run_to(64, SLOW);
        assert_eq!(run.changes.last(), Some(&(64.0, GuardLevel::Half)));
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes[2..],
            [(64.0, GuardLevel::Half), (124.0, GuardLevel::Full)]
        );
    }

    #[test]
    fn a_relapse_doubles_the_wait_up_to_ten_minutes() {
        let mut run = Loop::new();
        // Over budget the whole time: every climb to Half is back on the
        // poster one window later.
        run.run_to(2200, SLOW);
        let posters: Vec<f64> = run
            .changes
            .iter()
            .filter(|(_, level)| *level == GuardLevel::Still)
            .map(|(at, _)| *at)
            .collect();
        let climbs: Vec<f64> = run
            .changes
            .iter()
            .filter(|(_, level)| *level == GuardLevel::Half)
            .map(|(at, _)| *at)
            .skip(1) // the first Half is the step down from Full
            .collect();
        let waits: Vec<f64> = posters
            .iter()
            .zip(&climbs)
            .map(|(poster, climb)| climb - poster)
            .collect();
        assert_eq!(waits, [60.0, 120.0, 240.0, 480.0, 600.0, 600.0]);
        assert!(
            run.changes
                .iter()
                .all(|(_, level)| *level != GuardLevel::Full),
            "it never reached Full: {:?}",
            run.changes
        );
    }

    #[test]
    fn a_climb_that_held_ten_minutes_makes_the_wait_short_again() {
        let mut run = Loop::new();
        // Two relapses: the wait is four minutes.
        run.run_to(188, SLOW);
        assert_eq!(run.changes.last(), Some(&(188.0, GuardLevel::Still)));
        run.run_to(1400, CHEAP);
        assert_eq!(
            run.changes[6..],
            [(428.0, GuardLevel::Half), (668.0, GuardLevel::Full)],
            "four minutes a level"
        );
        // Full has held for over ten minutes. A new load steps it down...
        run.run_to(1402, SLOW);
        assert_eq!(run.changes.last(), Some(&(1402.0, GuardLevel::Half)));
        // ...and it is back a minute later, not eight.
        run.run_to(1500, CHEAP);
        assert_eq!(run.changes.last(), Some(&(1462.0, GuardLevel::Full)));
    }

    #[test]
    fn a_step_down_inside_ten_minutes_of_a_climb_is_a_relapse() {
        let mut run = Loop::new();
        run.run_to(2, SLOW);
        run.run_to(400, CHEAP);
        assert_eq!(run.changes.last(), Some(&(62.0, GuardLevel::Full)));
        // 5 min 40 s after the climb: down again, and the wait is two minutes.
        run.run_to(402, SLOW);
        assert_eq!(run.changes.last(), Some(&(402.0, GuardLevel::Half)));
        run.run_to(600, CHEAP);
        assert_eq!(run.changes.last(), Some(&(522.0, GuardLevel::Full)));
    }

    #[test]
    fn a_takeover_stops_the_quiet_clock_and_nothing_climbs_under_it() {
        let mut run = Loop::new();
        run.run_to(2, SLOW);
        run.run_to(30, CHEAP);
        // 100 s under a takeover: far past the minute, and no climb.
        run.takeover_to(130);
        assert_eq!(run.changes, [(2.0, GuardLevel::Half)]);
        // The 32 s it still owed start after the 2 s settle.
        run.run_to(163, CHEAP);
        assert_eq!(run.changes.len(), 1);
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes,
            [(2.0, GuardLevel::Half), (164.0, GuardLevel::Full)]
        );
    }

    #[test]
    fn the_poster_waits_for_a_compositor_that_keeps_its_deadlines() {
        let mut run = Loop::new();
        run.run_to(4, SLOW);
        // The minute passes, but every tick is late: no climb into that.
        run.run_late_to(100, CHEAP);
        assert_eq!(run.changes.last(), Some(&(4.0, GuardLevel::Still)));
        // The first window on time, and it climbs.
        run.run_to(110, CHEAP);
        assert_eq!(run.changes.last(), Some(&(102.0, GuardLevel::Half)));
    }

    #[test]
    fn time_nobody_fed_the_guard_is_not_quiet_time() {
        let mut run = Loop::new();
        run.run_to(2, SLOW);
        run.run_to(10, CHEAP);
        // The background is off the screen for a quarter of an hour.
        run.skip_to(1000);
        run.run_to(1051, CHEAP);
        assert_eq!(run.changes, [(2.0, GuardLevel::Half)]);
        run.run_to(1100, CHEAP);
        assert_eq!(run.changes.last(), Some(&(1052.0, GuardLevel::Full)));
    }

    #[test]
    fn another_background_starts_at_full_with_no_wait_left_over() {
        let mut run = Loop::new();
        run.guard.follow(LiveBackgroundId::PlasmaWave);
        run.run_to(188, SLOW);
        assert_eq!(run.guard.level(), GuardLevel::Still);
        run.guard.follow(LiveBackgroundId::LiquidChrome);
        assert_eq!(run.guard.level(), GuardLevel::Full);
        // Its first step waits one minute, not PlasmaWave's four.
        run.skip_to(190);
        run.run_to(192, SLOW);
        assert_eq!(run.changes.last(), Some(&(192.0, GuardLevel::Half)));
        run.run_to(300, CHEAP);
        assert_eq!(run.changes.last(), Some(&(252.0, GuardLevel::Full)));
    }
}
