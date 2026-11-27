//! The budget guard (plan 190 "Budget guard"): a live background may never
//! make the compositor miss frames. Each 2 s window it checks the background's
//! own render time and the compositor's missed deadlines; over budget, it
//! steps Full → Half → Still. A different background starts at Full, since
//! the ten cost very different amounts.
//!
//! What it judges is the background's typical cost: the median of the
//! window's render times, and only when two windows in a row are over
//! ([`GUARD_OVER_WINDOWS`]). A single frame's time is GPU wall time
//! (`GPUEndTime - GPUStartTime`) on a GPU that clocks down between ticks and
//! is shared with the app's own windows, the encoder and the rest of the Mac:
//! one frame in ten or twenty takes 4–7 times the median (2026-11-26: Silk at
//! 1080p30, median 1.0 ms, p95 4–7 ms, no missed deadline). Judged on the p95
//! of one window, that noise put the owner's background on the poster 6–70
//! times a day; at a 60 fps Preview 20 % of a frame is only 3.3 ms. The p95
//! is still reported (status, the smoke's budget).
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
//! the takeover stays. A change of the loop's frame rate or of the size the
//! background draws at is the same kind of moment: Record or a Clips ring
//! arms the Preview's compositor in place at the take's size and rate, and
//! the release puts it back, rebuilding the background's textures each time
//! (owner report 2026-11-26). The guard settles for
//! [`GUARD_SETTLE_AFTER_CHANGE`] after one and keeps its level.

use std::time::{Duration, Instant};

use crate::protocol::LiveBackgroundId;

pub const GUARD_WINDOW: Duration = Duration::from_secs(2);
/// Over budget: the background's median above this share of the frame
/// interval.
pub const GUARD_SHARE_OF_FRAME: f64 = 0.2;
/// Missed deadlines count against the background only when it is also
/// expensive (its median above this share), so a capture stall doesn't blame
/// it.
pub const GUARD_SHARE_WITH_MISSES: f64 = 0.1;
pub const GUARD_MISSES_PER_WINDOW: u32 = 3;
/// A window needs this many timed frames before it can judge.
pub const GUARD_MIN_SAMPLES: usize = 10;
/// Windows over budget in a row before a step down: a load that passes
/// inside one window (an export, a session arming, a scene's sources coming
/// back) never steps the background; one that holds does, 4 s in.
pub const GUARD_OVER_WINDOWS: u32 = 2;
/// After a takeover screen comes off, the guard waits this long before it
/// opens a window again.
pub const GUARD_SETTLE_AFTER_TAKEOVER: Duration = GUARD_WINDOW;
/// After the frame rate or the drawn size changes, the guard waits this long
/// before it opens a window again.
pub const GUARD_SETTLE_AFTER_CHANGE: Duration = GUARD_WINDOW;
/// How long the guard watches a stepped-down background before it climbs one
/// level. A minute outlasts the loads that stepped it down in the owner's
/// log (two of them were 35 s apart: a session stopping, then its compositor
/// and camera coming back), and is short enough that the motion is back
/// about a minute after the load has gone (two from the poster to full size).
pub const GUARD_QUIET: Duration = Duration::from_secs(60);
/// The longest quiet period. Under a load that does not pass, each try costs
/// two windows at the higher level and, from Half, one "graphics card is
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

/// What one finished window measured and decided.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GuardWindowReport {
    pub level_before: GuardLevel,
    pub level_after: GuardLevel,
    pub samples: usize,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub missed: u32,
    pub frame_interval_ms: f64,
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
    /// Windows over budget in a row at this level.
    over_windows: u32,
    /// The frame interval and drawn size of the last tick, to see a change.
    drawn: Option<(Duration, (u32, u32))>,
    /// No reading before this instant: a takeover screen was up, or the
    /// frame rate or size changed.
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
    /// The window the last tick finished, if it finished one.
    last_report: Option<GuardWindowReport>,
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

    /// What one tick tells the guard: its reading for a frame drawn at
    /// `output`, or nothing while a takeover screen is up, and while the
    /// scene settles after one or after a change of frame rate or size.
    /// Returns the new level when it changes, and logs why.
    pub fn observe(
        &mut self,
        tick: &super::runtime::LiveBackgroundTick,
        render_ms: Option<f64>,
        output: (u32, u32),
    ) -> Option<GuardLevel> {
        if tick.takeover {
            self.interrupt(tick.at + GUARD_SETTLE_AFTER_TAKEOVER);
            return None;
        }
        let drawn = (tick.frame_interval, output);
        if self.drawn.replace(drawn).is_some_and(|last| last != drawn) {
            self.interrupt(tick.at + GUARD_SETTLE_AFTER_CHANGE);
            return None;
        }
        if self.settle_until.is_some_and(|until| tick.at < until) {
            self.last_reading_at = None;
            return None;
        }
        self.settle_until = None;
        let change = self.record(
            tick.at,
            render_ms,
            tick.missed_deadline,
            tick.frame_interval,
        );
        if let Some(report) = self.take_report_for_log(change) {
            tracing::info!(
                "live background {:?} at {}x{}: guard {:?} -> {:?} (median {:.2} ms, p95 {:.2} ms, {} frames, {} late, frame {:.1} ms)",
                self.background,
                output.0,
                output.1,
                report.level_before,
                report.level_after,
                report.p50_ms.unwrap_or(f64::NAN),
                report.p95_ms.unwrap_or(f64::NAN),
                report.samples,
                report.missed,
                report.frame_interval_ms,
            );
        }
        change
    }

    /// A takeover screen or a change: the open window and the run of windows
    /// over budget go (the next window holds only readings taken after it),
    /// the watch clock pauses, and no reading is taken before `until`. The
    /// level stays.
    fn interrupt(&mut self, until: Instant) {
        self.window_started = None;
        self.samples.clear();
        self.missed = 0;
        self.over_windows = 0;
        self.settle_until = Some(until);
        self.last_reading_at = None;
    }

    /// Feed one frame: its render time (`None` when the API can't time it)
    /// and whether the compositor missed this frame's deadline. Returns the
    /// new level when it changes: a step down at the end of the
    /// [`GUARD_OVER_WINDOWS`]th window over budget in a row, or a climb at
    /// the end of a quiet one.
    pub fn record(
        &mut self,
        now: Instant,
        render_ms: Option<f64>,
        missed_deadline: bool,
        frame_interval: Duration,
    ) -> Option<GuardLevel> {
        self.last_report = None;
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
        let level_before = self.level;
        let over_budget = self.level != GuardLevel::Still && self.judge(frame_interval);
        let compositor_on_time = self.missed < GUARD_MISSES_PER_WINDOW;
        let mut report = GuardWindowReport {
            level_before,
            level_after: level_before,
            samples: self.samples.len(),
            p50_ms: percentile(&self.samples, 0.5),
            p95_ms: percentile(&self.samples, 0.95),
            missed: self.missed,
            frame_interval_ms: frame_interval.as_secs_f64() * 1000.0,
        };
        self.window_started = Some(now);
        self.samples.clear();
        self.missed = 0;
        self.over_windows = if over_budget {
            self.over_windows + 1
        } else {
            0
        };
        let change = if self.over_windows >= GUARD_OVER_WINDOWS {
            self.over_windows = 0;
            Some(self.step_down())
        } else if over_budget {
            None
        } else {
            let quiet_long_enough = self.climb_at.is_some_and(|at| self.watched >= at);
            (quiet_long_enough && compositor_on_time).then(|| self.climb())
        };
        report.level_after = self.level;
        self.last_report = Some(report);
        change
    }

    /// The window that just changed the level, for the log line.
    fn take_report_for_log(&mut self, change: Option<GuardLevel>) -> Option<GuardWindowReport> {
        change.and(self.last_report.take())
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

    /// Whether this window is over budget: the background's median against
    /// the frame interval. The p95 is kept for status only.
    fn judge(&mut self, frame_interval: Duration) -> bool {
        if self.samples.len() < GUARD_MIN_SAMPLES {
            return false;
        }
        let (Some(median), Some(p95)) = (
            percentile(&self.samples, 0.5),
            percentile(&self.samples, 0.95),
        ) else {
            return false;
        };
        self.last_p95_ms = Some(p95);
        let interval_ms = frame_interval.as_secs_f64() * 1000.0;
        median > interval_ms * GUARD_SHARE_OF_FRAME
            || (self.missed >= GUARD_MISSES_PER_WINDOW
                && median > interval_ms * GUARD_SHARE_WITH_MISSES)
    }
}

/// The nearest-rank percentile `q` (0–1) of `samples`, `None` when empty.
fn percentile(samples: &[f64], q: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64) * q).ceil() as usize;
    Some(sorted[index.clamp(1, sorted.len()) - 1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_background::LiveBackgroundTick;

    const SIXTY: Duration = Duration::from_nanos(16_666_667);

    /// Feed `seconds` of 60 fps frames from `start`, every one taking `ms`
    /// (or `spike` on every 10th frame): the last level change, if any.
    fn run_frames(
        guard: &mut LiveBackgroundGuard,
        start: Instant,
        seconds: u32,
        ms: f64,
        spike: Option<f64>,
        missed: bool,
    ) -> Option<GuardLevel> {
        let mut change = None;
        for frame in 0..seconds * 60 {
            let at = start + SIXTY * frame;
            let ms = match spike {
                Some(spike) if frame % 10 == 9 => spike,
                _ => ms,
            };
            change = guard.record(at, Some(ms), missed, SIXTY).or(change);
        }
        change
    }

    #[test]
    fn a_cheap_background_stays_full() {
        let mut guard = LiveBackgroundGuard::new();
        assert_eq!(
            run_frames(&mut guard, Instant::now(), 3, 0.9, None, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
    }

    /// Owner report 2026-11-26: Silk at 1080p, median 1.0 ms, one frame in
    /// ten 4–7 ms (the GPU clocking down between ticks, other work on it),
    /// no deadline missed. Judged on the p95 that stepped it to the poster
    /// at a 60 fps Preview, where 20 % of a frame is 3.33 ms.
    #[test]
    fn idle_clock_spikes_never_step_a_cheap_background() {
        let mut guard = LiveBackgroundGuard::new();
        assert_eq!(
            run_frames(&mut guard, Instant::now(), 600, 1.0, Some(6.5), false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(guard.last_p95_ms(), Some(6.5), "the p95 is still reported");
    }

    /// A load that passes inside one window (an export, a session arming)
    /// never steps the background.
    #[test]
    fn one_slow_window_is_not_a_step() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        assert_eq!(run_frames(&mut guard, start, 2, 0.9, None, false), None);
        assert_eq!(
            run_frames(
                &mut guard,
                start + Duration::from_secs(2),
                2,
                5.0,
                None,
                false
            ),
            None
        );
        assert_eq!(
            run_frames(
                &mut guard,
                start + Duration::from_secs(4),
                20,
                0.9,
                None,
                false
            ),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
    }

    #[test]
    fn an_expensive_background_steps_down_to_half_then_the_poster() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // 20 % of a 60 fps frame is 3.33 ms: two windows over, then a step.
        assert_eq!(run_frames(&mut guard, start, 3, 4.0, None, false), None);
        assert_eq!(
            run_frames(
                &mut guard,
                start + Duration::from_secs(3),
                2,
                4.0,
                None,
                false
            ),
            Some(GuardLevel::Half)
        );
        assert_eq!(
            run_frames(
                &mut guard,
                start + Duration::from_secs(5),
                4,
                4.0,
                None,
                false
            ),
            Some(GuardLevel::Still)
        );
        assert_eq!(
            run_frames(
                &mut guard,
                start + Duration::from_secs(9),
                4,
                0.1,
                None,
                false
            ),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Still);
    }

    #[test]
    fn a_different_background_starts_again_at_full() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        guard.follow(LiveBackgroundId::PlasmaWave);
        run_frames(&mut guard, start, 9, 4.0, None, false);
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
        assert_eq!(
            run_frames(&mut guard, Instant::now(), 10, 0.5, None, true),
            None
        );
        let mut guard = LiveBackgroundGuard::new();
        // 10 % of a 60 fps frame is 1.67 ms.
        assert_eq!(
            run_frames(&mut guard, Instant::now(), 5, 2.0, None, true),
            Some(GuardLevel::Half)
        );
    }

    const HD: (u32, u32) = (1920, 1080);

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
            change = guard.observe(&tick, Some(ms), HD).or(change);
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
        // A background that is over budget behind the scene still steps
        // down, two windows in.
        assert_eq!(
            observe_frames(&mut guard, start, 242..=362, 10.0, false),
            None
        );
        assert_eq!(
            observe_frames(&mut guard, start, 363..=483, 10.0, false),
            Some(GuardLevel::Half)
        );
        assert_eq!(
            observe_frames(&mut guard, start, 484..=724, 10.0, false),
            Some(GuardLevel::Still)
        );
    }

    #[test]
    fn a_takeover_drops_the_open_window_and_keeps_the_level() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // The windows closing at frames 120 and 240 are over budget.
        assert_eq!(
            observe_frames(&mut guard, start, 0..=240, 10.0, false),
            Some(GuardLevel::Half)
        );
        // 1.9 s more of slow readings: their window would close over budget
        // at frame 360. The takeover at frame 355 drops them.
        assert_eq!(
            observe_frames(&mut guard, start, 241..=354, 10.0, false),
            None
        );
        assert_eq!(
            observe_frames(&mut guard, start, 355..=355, 10.0, true),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Half, "the level it had stays");
        // The first window after it holds only readings taken after it.
        assert_eq!(
            observe_frames(&mut guard, start, 356..=600, 0.9, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Half);
        assert_eq!(guard.last_p95_ms(), Some(0.9));
    }

    /// A slow window before a takeover and one after it are not two in a
    /// row: the takeover ends the run.
    #[test]
    fn a_takeover_ends_a_run_of_slow_windows() {
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        assert_eq!(
            observe_frames(&mut guard, start, 0..=120, 10.0, false),
            None
        );
        assert_eq!(
            observe_frames(&mut guard, start, 121..=121, 10.0, true),
            None
        );
        // Settled at frame 241; the window closing at 361 is the first.
        assert_eq!(
            observe_frames(&mut guard, start, 122..=361, 10.0, false),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        assert_eq!(
            observe_frames(&mut guard, start, 362..=481, 10.0, false),
            Some(GuardLevel::Half)
        );
    }

    /// Feed frames `frames` of a loop at `interval` drawing at `output`.
    fn feed(
        guard: &mut LiveBackgroundGuard,
        start: Instant,
        frames: std::ops::RangeInclusive<u32>,
        ms: f64,
        interval: Duration,
        output: (u32, u32),
    ) -> Option<GuardLevel> {
        let mut change = None;
        for frame in frames {
            let tick = LiveBackgroundTick::new(start + interval * frame, interval, false);
            change = guard.observe(&tick, Some(ms), output).or(change);
        }
        change
    }

    /// Owner report 2026-11-26: a Clips ring arms the Preview's compositor in
    /// place at 4K30 for every take and puts it back at the Preview's size
    /// and 60 fps after, rebuilding the background's textures each time.
    /// The frames around a change are not the background's; the level stays.
    #[test]
    fn a_change_of_frame_rate_or_size_settles_and_keeps_the_level() {
        const THIRTY: Duration = Duration::from_nanos(33_333_333);
        const PREVIEW: (u32, u32) = (1216, 684);
        let mut guard = LiveBackgroundGuard::new();
        let start = Instant::now();
        // One slow window at the Preview's 60 fps...
        assert_eq!(feed(&mut guard, start, 0..=120, 5.0, SIXTY, PREVIEW), None);
        // ...then Record arms 4K30: 2 s of slow frames are not taken, and the
        // window after them is the first of a run, not the second.
        let armed = start + SIXTY * 121;
        assert_eq!(feed(&mut guard, armed, 0..=59, 30.0, THIRTY, HD), None);
        assert_eq!(feed(&mut guard, armed, 60..=120, 7.0, THIRTY, HD), None);
        assert_eq!(guard.level(), GuardLevel::Full);
        // The release back to the Preview settles again: cheap from there.
        let released = armed + THIRTY * 121;
        assert_eq!(
            feed(&mut guard, released, 0..=60, 9.0, SIXTY, PREVIEW),
            None
        );
        assert_eq!(
            feed(&mut guard, released, 61..=600, 0.9, SIXTY, PREVIEW),
            None
        );
        assert_eq!(guard.level(), GuardLevel::Full);
        // A stepped-down level stays across a change.
        assert_eq!(
            feed(&mut guard, released, 601..=900, 5.0, SIXTY, PREVIEW),
            Some(GuardLevel::Half)
        );
        let armed = released + SIXTY * 901;
        assert_eq!(feed(&mut guard, armed, 0..=150, 0.9, THIRTY, HD), None);
        assert_eq!(guard.level(), GuardLevel::Half);
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
            if let Some(level) = self.guard.observe(&tick, Some(ms), HD) {
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
        // Two windows over budget: the step is 4 s in.
        run.run_to(4, SLOW);
        assert_eq!(run.changes, [(4.0, GuardLevel::Half)]);
        // 59.9 s of cheap frames: not yet.
        run.run_to(63, CHEAP);
        assert_eq!(run.changes.len(), 1);
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes,
            [(4.0, GuardLevel::Half), (64.0, GuardLevel::Full)],
            "one climb, a minute after the step, and it holds"
        );
    }

    /// Still → Half → Full, end to end: one level per quiet period, never
    /// two, and a time fed at Still (nothing is drawn there) is no reading.
    #[test]
    fn the_poster_climbs_to_half_then_to_full_one_level_per_quiet_period() {
        let mut run = Loop::new();
        run.run_to(8, SLOW);
        assert_eq!(
            run.changes,
            [(4.0, GuardLevel::Half), (8.0, GuardLevel::Still)]
        );
        run.run_to(68, SLOW);
        assert_eq!(run.changes.last(), Some(&(68.0, GuardLevel::Half)));
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes[2..],
            [(68.0, GuardLevel::Half), (128.0, GuardLevel::Full)]
        );
    }

    #[test]
    fn a_relapse_doubles_the_wait_up_to_ten_minutes() {
        let mut run = Loop::new();
        // Over budget the whole time: every climb to Half is back on the
        // poster two windows later.
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
        run.run_to(196, SLOW);
        assert_eq!(run.changes.last(), Some(&(196.0, GuardLevel::Still)));
        run.run_to(1400, CHEAP);
        assert_eq!(
            run.changes[6..],
            [(436.0, GuardLevel::Half), (676.0, GuardLevel::Full)],
            "four minutes a level"
        );
        // Full has held for over ten minutes. A new load steps it down...
        run.run_to(1404, SLOW);
        assert_eq!(run.changes.last(), Some(&(1404.0, GuardLevel::Half)));
        // ...and it is back a minute later, not eight.
        run.run_to(1500, CHEAP);
        assert_eq!(run.changes.last(), Some(&(1464.0, GuardLevel::Full)));
    }

    #[test]
    fn a_step_down_inside_ten_minutes_of_a_climb_is_a_relapse() {
        let mut run = Loop::new();
        run.run_to(4, SLOW);
        run.run_to(400, CHEAP);
        assert_eq!(run.changes.last(), Some(&(64.0, GuardLevel::Full)));
        // 5 min 40 s after the climb: down again, and the wait is two minutes.
        run.run_to(404, SLOW);
        assert_eq!(run.changes.last(), Some(&(404.0, GuardLevel::Half)));
        run.run_to(600, CHEAP);
        assert_eq!(run.changes.last(), Some(&(524.0, GuardLevel::Full)));
    }

    #[test]
    fn a_takeover_stops_the_quiet_clock_and_nothing_climbs_under_it() {
        let mut run = Loop::new();
        run.run_to(4, SLOW);
        run.run_to(30, CHEAP);
        // 100 s under a takeover: far past the minute, and no climb.
        run.takeover_to(130);
        assert_eq!(run.changes, [(4.0, GuardLevel::Half)]);
        // The 34 s it still owed start after the 2 s settle.
        run.run_to(165, CHEAP);
        assert_eq!(run.changes.len(), 1);
        run.run_to(300, CHEAP);
        assert_eq!(
            run.changes,
            [(4.0, GuardLevel::Half), (166.0, GuardLevel::Full)]
        );
    }

    #[test]
    fn the_poster_waits_for_a_compositor_that_keeps_its_deadlines() {
        let mut run = Loop::new();
        run.run_to(8, SLOW);
        // The minute passes, but every tick is late: no climb into that.
        run.run_late_to(100, CHEAP);
        assert_eq!(run.changes.last(), Some(&(8.0, GuardLevel::Still)));
        // The first window on time, and it climbs.
        run.run_to(110, CHEAP);
        assert_eq!(run.changes.last(), Some(&(102.0, GuardLevel::Half)));
    }

    #[test]
    fn time_nobody_fed_the_guard_is_not_quiet_time() {
        let mut run = Loop::new();
        run.run_to(4, SLOW);
        run.run_to(10, CHEAP);
        // The background is off the screen for a quarter of an hour.
        run.skip_to(1000);
        run.run_to(1053, CHEAP);
        assert_eq!(run.changes, [(4.0, GuardLevel::Half)]);
        run.run_to(1100, CHEAP);
        assert_eq!(run.changes.last(), Some(&(1054.0, GuardLevel::Full)));
    }

    #[test]
    fn another_background_starts_at_full_with_no_wait_left_over() {
        let mut run = Loop::new();
        run.guard.follow(LiveBackgroundId::PlasmaWave);
        run.run_to(196, SLOW);
        assert_eq!(run.guard.level(), GuardLevel::Still);
        run.guard.follow(LiveBackgroundId::LiquidChrome);
        assert_eq!(run.guard.level(), GuardLevel::Full);
        // Its first step waits one minute, not PlasmaWave's four.
        run.skip_to(198);
        run.run_to(202, SLOW);
        assert_eq!(run.changes.last(), Some(&(202.0, GuardLevel::Half)));
        run.run_to(300, CHEAP);
        assert_eq!(run.changes.last(), Some(&(262.0, GuardLevel::Full)));
    }
}
