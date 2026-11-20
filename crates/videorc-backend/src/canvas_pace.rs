//! Plan 255: the canvas tick follows the SRT Camera. A new frame starts the
//! tick itself instead of waiting up to one canvas interval for the timer,
//! and the timer stays as the fallback, so the canvas keeps its rate when the
//! camera stops or never runs.
//!
//! The camera leads only when its rate is the canvas rate or twice it (a
//! 30 or 60 fps sender on a 30 fps canvas). At any other rate (24, 25 or
//! 50 fps on a 30 fps canvas) no phase can serve every frame, and leading
//! would pull the whole canvas to the camera's rate, so the timer runs alone.

use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{Instant, Interval};

/// While the camera leads, the timer waits this many intervals after the
/// last tick, so a frame that comes a little late still leads.
const LED_FALLBACK: f64 = 1.5;
/// A frame this soon after the last tick never ticks again at once. While
/// the timer leads, the timer moves instead, so the next frame leads.
const MIN_GAP: f64 = 0.25;
/// How close the camera's rate must be to the canvas rate (or twice it).
const RATE_MATCH: f64 = 0.05;

/// The newest camera frame: when it went out, its number, and the camera's
/// frame gap. The receiver measures the gap from every decoded frame, so
/// frames that never reach the compositor still count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameNews {
    pub at: Instant,
    pub sequence: u64,
    pub gap: Option<Duration>,
}

/// What a new camera frame does to the canvas tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraFrame {
    /// Tick now; the camera leads.
    Tick,
    /// No tick now; the timer moves to this instant so the next frame leads.
    MoveTimer(Instant),
    /// No tick and no change: the frame waits for its turn.
    Wait,
}

#[derive(Debug)]
pub struct CanvasPace {
    last_tick: Option<Instant>,
    camera_leads: bool,
    /// The newest frame number heard of, and the one the last tick drew.
    newest: Option<u64>,
    drawn: Option<u64>,
    /// While the camera leads: the next frame number that may tick, and the
    /// step between them (2 at twice the canvas rate). A burst that skips a
    /// frame never shifts the beat to the other half of the frames.
    due: Option<u64>,
    step: u64,
    /// Ticks since the last log line, and how many of them the camera led.
    ticks: u32,
    led: u32,
}

impl Default for CanvasPace {
    fn default() -> Self {
        Self {
            last_tick: None,
            camera_leads: false,
            newest: None,
            drawn: None,
            due: None,
            step: 1,
            ticks: 0,
            led: 0,
        }
    }
}

/// The log says how often the camera led, once per this many ticks.
const LOG_EVERY: u32 = 300;

impl CanvasPace {
    pub fn on_camera_frame(&mut self, news: FrameNews, interval: Duration) -> CameraFrame {
        if self.newest.is_some_and(|newest| news.sequence < newest) {
            // The camera started again and counts from zero.
            self.drawn = None;
            self.due = None;
        }
        self.newest = Some(news.sequence);
        let Some(multiple) = news.gap.and_then(|gap| rate_multiple(gap, interval)) else {
            return CameraFrame::Wait;
        };
        self.step = u64::from(multiple);
        let Some(last_tick) = self.last_tick else {
            return CameraFrame::Tick;
        };
        // The news goes out once the frame is in the store: news older than
        // the last tick means that tick drew the frame.
        if news.at < last_tick || self.drawn.is_some_and(|drawn| news.sequence <= drawn) {
            return CameraFrame::Wait;
        }
        let since = news.at.saturating_duration_since(last_tick);
        if since < interval.mul_f64(MIN_GAP) {
            return if self.camera_leads {
                CameraFrame::Wait
            } else {
                CameraFrame::MoveTimer(news.at + interval.mul_f64(LED_FALLBACK))
            };
        }
        // At twice the canvas rate, the camera leads on every second frame.
        let due = self
            .due
            .or(self.drawn.map(|drawn| drawn + self.step))
            .unwrap_or(news.sequence);
        if !self.camera_leads || news.sequence >= due {
            CameraFrame::Tick
        } else {
            CameraFrame::Wait
        }
    }

    fn ticked(&mut self, at: Instant, camera_leads: bool, drew: Option<u64>) {
        self.last_tick = Some(at);
        self.camera_leads = camera_leads;
        self.drawn = drew;
        // The next frame due after this one, on the same beat.
        self.due = match (camera_leads, drew) {
            (true, Some(drew)) => {
                let step = self.step;
                let due = self.due.filter(|due| *due <= drew).unwrap_or(drew);
                Some(due + step * ((drew - due) / step + 1))
            }
            _ => None,
        };
        self.ticks += 1;
        self.led += u32::from(camera_leads);
        if self.ticks >= LOG_EVERY {
            if self.led > 0 {
                tracing::info!(
                    "[canvas-pace] the SRT Camera led {} of the last {} canvas ticks",
                    self.led,
                    self.ticks
                );
            }
            self.ticks = 0;
            self.led = 0;
        }
    }

    /// Waits for the next canvas tick: the timer, or a camera frame that may
    /// lead. `camera_shown` says this compositor draws that camera, so it
    /// alone may follow it.
    pub async fn next_tick(
        &mut self,
        ticker: &mut Interval,
        frames: &mut watch::Receiver<Option<FrameNews>>,
        interval: Duration,
        camera_shown: bool,
    ) {
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // News waiting in the channel names a frame already in the store.
                    let waiting = frames.borrow().map(|news| news.sequence);
                    self.ticked(Instant::now(), false, self.newest.max(waiting));
                    return;
                }
                changed = frames.changed(), if camera_shown => {
                    if changed.is_err() {
                        // Can't happen (the sender is a static); if it does,
                        // the timer goes on alone.
                        ticker.tick().await;
                        self.ticked(Instant::now(), false, self.newest);
                        return;
                    }
                    let Some(news) = *frames.borrow_and_update() else {
                        continue;
                    };
                    match self.on_camera_frame(news, interval) {
                        CameraFrame::Tick => {
                            let now = Instant::now();
                            ticker.reset_at(now + interval.mul_f64(LED_FALLBACK));
                            self.ticked(now, true, Some(news.sequence));
                            return;
                        }
                        CameraFrame::MoveTimer(at) => ticker.reset_at(at),
                        CameraFrame::Wait => {}
                    }
                }
            }
        }
    }
}

/// 1 when the camera runs at the canvas rate, 2 at twice it, else None.
fn rate_multiple(gap: Duration, interval: Duration) -> Option<u32> {
    let ratio = interval.as_secs_f64() / gap.as_secs_f64();
    let multiple = ratio.round();
    ((1.0..=2.0).contains(&multiple) && (ratio - multiple).abs() <= RATE_MATCH * multiple)
        .then_some(multiple as u32)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const T: Duration = Duration::from_micros(33_333);

    fn pace(last_tick: Instant, camera_leads: bool, drawn: u64) -> CanvasPace {
        CanvasPace {
            last_tick: Some(last_tick),
            camera_leads,
            newest: Some(drawn),
            drawn: Some(drawn),
            ..CanvasPace::default()
        }
    }

    fn news(at: Instant, sequence: u64, fps: f64) -> FrameNews {
        FrameNews {
            at,
            sequence,
            gap: Some(Duration::from_secs_f64(1.0 / fps)),
        }
    }

    #[test]
    fn canvas_pace_waits_until_it_knows_the_camera_rate() {
        let at = Instant::now();
        let unknown = FrameNews {
            at,
            sequence: 1,
            gap: None,
        };
        assert_eq!(
            CanvasPace::default().on_camera_frame(unknown, T),
            CameraFrame::Wait
        );
    }

    #[test]
    fn canvas_pace_a_matching_frame_after_a_timer_tick_leads_unless_it_is_too_soon() {
        let t0 = Instant::now();
        assert_eq!(
            pace(t0, false, 1).on_camera_frame(news(t0 + T / 2, 2, 30.0), T),
            CameraFrame::Tick
        );
        let soon = t0 + Duration::from_millis(3);
        assert_eq!(
            pace(t0, false, 1).on_camera_frame(news(soon, 2, 30.0), T),
            CameraFrame::MoveTimer(soon + T.mul_f64(1.5))
        );
    }

    #[test]
    fn canvas_pace_a_camera_that_starts_again_can_lead_at_once() {
        let t0 = Instant::now();
        let mut restarted = pace(t0, true, 5000);
        assert_eq!(
            restarted.on_camera_frame(news(t0 + T, 1, 30.0), T),
            CameraFrame::Tick
        );
    }

    #[test]
    fn canvas_pace_a_frame_the_last_tick_drew_never_ticks() {
        let t0 = Instant::now();
        assert_eq!(
            pace(t0, true, 5).on_camera_frame(news(t0 + T, 5, 30.0), T),
            CameraFrame::Wait
        );
    }

    #[test]
    fn canvas_pace_a_camera_at_twice_the_rate_leads_every_second_frame() {
        let t0 = Instant::now();
        assert_eq!(
            pace(t0, true, 10).on_camera_frame(news(t0 + T / 2, 11, 60.0), T),
            CameraFrame::Wait
        );
        assert_eq!(
            pace(t0, true, 10).on_camera_frame(news(t0 + T, 12, 60.0), T),
            CameraFrame::Tick
        );
    }

    #[test]
    fn canvas_pace_a_camera_at_another_rate_never_leads() {
        let t0 = Instant::now();
        for fps in [24.0, 25.0, 50.0, 90.0] {
            assert_eq!(
                pace(t0, false, 1).on_camera_frame(news(t0 + T / 2, 2, fps), T),
                CameraFrame::Wait,
                "{fps} fps"
            );
        }
    }

    struct Run {
        ticks: usize,
        /// For each tick after the first second, how old the newest frame was.
        ages: Vec<Duration>,
    }

    /// A camera at `camera_fps`, each frame moved by the next of `offsets`
    /// (in ms, repeating), against a canvas at `canvas_fps`, for three
    /// seconds on the paused clock.
    async fn run(camera_fps: f64, canvas_fps: f64, offsets: &[f64]) -> Run {
        run_until(camera_fps, canvas_fps, offsets, f64::INFINITY).await
    }

    /// As `run`, with a camera that stops sending after `camera_stops` s.
    async fn run_until(
        camera_fps: f64,
        canvas_fps: f64,
        offsets: &[f64],
        camera_stops: f64,
    ) -> Run {
        run_with(camera_fps, canvas_fps, offsets, camera_stops, true).await
    }

    /// `camera_shown`: this compositor draws the camera, so it may follow it.
    async fn run_with(
        camera_fps: f64,
        canvas_fps: f64,
        offsets: &[f64],
        camera_stops: f64,
        camera_shown: bool,
    ) -> Run {
        let interval = Duration::from_secs_f64(1.0 / canvas_fps);
        let (sender, mut frames) = watch::channel(None);
        let shown: Arc<Mutex<Vec<Instant>>> = Arc::default();
        let start = Instant::now();
        let offsets = offsets.to_vec();
        let camera = {
            let shown = Arc::clone(&shown);
            tokio::spawn(async move {
                for n in 1_u64..=u64::MAX {
                    let offset = offsets[(n as usize) % offsets.len()] / 1000.0;
                    let seconds = n as f64 / camera_fps + offset;
                    if seconds > camera_stops {
                        std::future::pending::<()>().await;
                    }
                    tokio::time::sleep_until(start + Duration::from_secs_f64(seconds.max(0.0)))
                        .await;
                    let now = Instant::now();
                    shown.lock().unwrap().push(now);
                    sender.send_replace(Some(FrameNews {
                        at: now,
                        sequence: n,
                        gap: Some(Duration::from_secs_f64(1.0 / camera_fps)),
                    }));
                }
            })
        };
        let mut ticker = tokio::time::interval(interval);
        let mut pace = CanvasPace::default();
        let mut result = Run {
            ticks: 0,
            ages: Vec::new(),
        };
        while Instant::now() < start + Duration::from_secs(3) {
            pace.next_tick(&mut ticker, &mut frames, interval, camera_shown)
                .await;
            result.ticks += 1;
            let now = Instant::now();
            if now > start + Duration::from_secs(1)
                && let Some(last) = shown.lock().unwrap().iter().rev().find(|at| **at <= now)
            {
                result.ages.push(now - *last);
            }
        }
        camera.abort();
        result
    }

    /// A fixed spread of up to `ms` early or late.
    fn jitter(ms: f64) -> Vec<f64> {
        let mut seed = 0x2545_f491_u32;
        (0..97)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (f64::from(seed >> 8) / f64::from(1_u32 << 24) * 2.0 - 1.0) * ms
            })
            .collect()
    }

    fn median(mut values: Vec<Duration>) -> Duration {
        values.sort();
        values[values.len() / 2]
    }

    fn assert_canvas_rate(ticks: usize, canvas_fps: f64, what: &str) {
        let expected = 3.0 * canvas_fps;
        let ticks = ticks as f64;
        assert!(
            (ticks - expected).abs() <= expected * 0.03,
            "{what}: {ticks} ticks in 3 s, expected {expected}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn canvas_pace_keeps_the_canvas_rate_for_any_camera_rate() {
        for fps in [24.0, 25.0, 30.0, 50.0, 60.0] {
            let ticks = run(fps, 30.0, &[0.0]).await.ticks;
            assert_canvas_rate(ticks, 30.0, &format!("{fps} fps camera"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn canvas_pace_keeps_the_canvas_rate_when_the_camera_stops() {
        for fps in [30.0, 60.0] {
            let ticks = run_until(fps, 30.0, &[0.0], 1.5).await.ticks;
            assert_canvas_rate(ticks, 30.0, &format!("{fps} fps camera that stops"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn canvas_pace_never_follows_a_camera_this_compositor_does_not_draw() {
        let run = run_with(29.97, 30.0, &[0.0], f64::INFINITY, false).await;
        assert_canvas_rate(run.ticks, 30.0, "a camera not shown");
        let age = median(run.ages);
        assert!(
            age > Duration::from_millis(5),
            "the timer alone ticks, so frames wait (median {age:?})"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn canvas_pace_shows_a_matching_camera_frame_at_once() {
        for (camera, canvas) in [(30.0, 30.0), (60.0, 30.0), (60.0, 60.0), (29.97, 30.0)] {
            let age = median(run(camera, canvas, &[0.0]).await.ages);
            assert!(
                age < Duration::from_millis(1),
                "{camera} fps camera on {canvas}: frames wait {age:?}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn canvas_pace_keeps_rate_and_lead_through_jitter() {
        let cases = [
            (30.0, 30.0, jitter(8.0), "±8 ms"),
            (60.0, 60.0, jitter(4.0), "±4 ms"),
            (60.0, 30.0, jitter(4.0), "±4 ms"),
            (
                60.0,
                30.0,
                vec![6.0, 6.0, -6.0, -6.0, -6.0],
                "+6 +6 −6 −6 −6 ms",
            ),
            // Every fourth frame of five comes in one burst with the fifth.
            (
                60.0,
                30.0,
                vec![0.0, 0.0, 0.0, 1000.0 / 60.0, 0.0],
                "a burst",
            ),
        ];
        for (camera, canvas, offsets, spread) in cases {
            let what = format!("{camera} fps camera on {canvas}, {spread}");
            let result = run(camera, canvas, &offsets).await;
            assert_canvas_rate(result.ticks, canvas, &what);
            let age = median(result.ages);
            assert!(
                age < Duration::from_millis(1),
                "{what}: frames wait {age:?}"
            );
        }
    }
}
