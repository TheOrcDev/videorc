//! Rate-collapse detection for the always-on capture → compositor pipeline.
//!
//! 2026-08-27 field incident: after minutes-to-hours of app uptime (no
//! sessions required), the shared snapshot path settles into a stable
//! degraded equilibrium — ~6 fresh frames/second served at a healthy 30fps
//! encoder cadence — and every existing watchdog stays silent, because they
//! all detect *liveness* (is presentation advancing at all), not *rate*. The
//! owner's 33-minute idle decay produced zero log lines.
//!
//! This monitor watches the per-window numbers the compositor already
//! computes and names the first degraded stage upstream→downstream:
//!
//! - `camera-delivery`: the camera fetch stopped yielding fresh frames at
//!   rate. Webcams stream continuously, so a collapsed fresh-serve rate is
//!   decay, full stop.
//! - `compositor-render`: the snapshot loop itself fell below cadence.
//!
//! The screen source is deliberately NOT a verdict stage: ScreenCaptureKit
//! delivers frames on display damage, so a static desktop legitimately
//! produces ~0 fresh screen frames. Screen numbers ride along in the detail
//! string as evidence, never as a judgment.

/// Fraction of the target rate below which a stage counts as degraded.
pub const DEGRADED_RATE_FRACTION: f64 = 0.6;
/// Consecutive degraded windows before a transition is declared (2s windows
/// → ≈6s of sustained collapse; single-window blips never flap).
pub const DEGRADED_WINDOW_THRESHOLD: u32 = 3;
/// Consecutive healthy windows before recovery is declared.
pub const RECOVERED_WINDOW_THRESHOLD: u32 = 3;

/// One diagnostics window of pipeline rates, cumulative counters included.
#[derive(Debug, Clone, Copy)]
pub struct CaptureHealthSample {
    /// The session/preview target fps; a sample with a non-positive target is
    /// ignored (no cadence to judge against).
    pub target_fps: f64,
    /// Compositor snapshot production rate over this window.
    pub render_fps: f64,
    /// Whether a camera source is attached to the scene this window.
    pub camera_present: bool,
    /// CUMULATIVE fresh camera serves (compositor fetch counter).
    pub camera_fresh_serves: u64,
    /// Whether a screen source is attached to the scene this window.
    pub screen_present: bool,
    /// CUMULATIVE fresh screen serves (advisory only — see module docs).
    pub screen_fresh_serves: u64,
    /// Window length in seconds (non-positive samples are ignored).
    pub window_secs: f64,
}

/// The stage a degradation verdict names, most-upstream first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureStage {
    CameraDelivery,
    CompositorRender,
}

impl CaptureStage {
    pub fn label(self) -> &'static str {
        match self {
            CaptureStage::CameraDelivery => "camera-delivery",
            CaptureStage::CompositorRender => "compositor-render",
        }
    }
}

/// A state transition worth telling somebody about. Emitted once per edge —
/// steady states (healthy or degraded) stay quiet.
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureHealthTransition {
    Degraded { stage: CaptureStage, detail: String },
    Recovered { detail: String },
}

#[derive(Debug, Default)]
pub struct CaptureHealthMonitor {
    last_camera_fresh: Option<u64>,
    last_screen_fresh: Option<u64>,
    degraded_streak: u32,
    healthy_streak: u32,
    /// The currently-declared degraded stage, if any.
    current: Option<CaptureStage>,
    /// The stage the running degraded streak is accumulating toward.
    pending_stage: Option<CaptureStage>,
}

impl CaptureHealthMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The stage currently declared degraded, for diagnostics publication.
    pub fn degraded_stage(&self) -> Option<CaptureStage> {
        self.current
    }

    /// Feed one diagnostics window; returns a transition when an edge fires.
    pub fn observe(&mut self, sample: CaptureHealthSample) -> Option<CaptureHealthTransition> {
        if sample.window_secs <= 0.0 || sample.target_fps <= 0.0 {
            return None;
        }

        let camera_fresh_fps = if sample.camera_present {
            delta_rate(
                &mut self.last_camera_fresh,
                sample.camera_fresh_serves,
                sample.window_secs,
            )
        } else {
            self.last_camera_fresh = None;
            None
        };
        let screen_fresh_fps = if sample.screen_present {
            delta_rate(
                &mut self.last_screen_fresh,
                sample.screen_fresh_serves,
                sample.window_secs,
            )
        } else {
            self.last_screen_fresh = None;
            None
        };

        let floor = sample.target_fps * DEGRADED_RATE_FRACTION;
        // Upstream before downstream: a starving camera fetch is the cause
        // even when the render loop is dutifully re-serving held frames at
        // full cadence (the exact 2026-08-27 signature).
        let degraded_stage = match camera_fresh_fps {
            Some(rate) if rate < floor => Some(CaptureStage::CameraDelivery),
            _ if sample.render_fps < floor => Some(CaptureStage::CompositorRender),
            _ => None,
        };

        let detail = format!(
            "target={:.1}fps render={:.1}fps camera_fresh={} screen_fresh={}",
            sample.target_fps,
            sample.render_fps,
            camera_fresh_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            screen_fresh_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
        );

        match degraded_stage {
            Some(stage) => {
                self.healthy_streak = 0;
                if self.pending_stage == Some(stage) {
                    self.degraded_streak = self.degraded_streak.saturating_add(1);
                } else {
                    self.pending_stage = Some(stage);
                    self.degraded_streak = 1;
                }
                if self.degraded_streak >= DEGRADED_WINDOW_THRESHOLD && self.current != Some(stage)
                {
                    self.current = Some(stage);
                    return Some(CaptureHealthTransition::Degraded { stage, detail });
                }
                None
            }
            None => {
                self.pending_stage = None;
                self.degraded_streak = 0;
                if self.current.is_some() {
                    self.healthy_streak = self.healthy_streak.saturating_add(1);
                    if self.healthy_streak >= RECOVERED_WINDOW_THRESHOLD {
                        self.current = None;
                        self.healthy_streak = 0;
                        return Some(CaptureHealthTransition::Recovered { detail });
                    }
                }
                None
            }
        }
    }
}

/// Fresh-serve rate from a cumulative counter. A counter that moved BACKWARD
/// (compositor instance swap resets it to zero) invalidates the window: the
/// baseline is re-armed and no rate is reported rather than a bogus one.
fn delta_rate(last: &mut Option<u64>, current: u64, window_secs: f64) -> Option<f64> {
    let rate = match *last {
        Some(previous) if current >= previous => Some((current - previous) as f64 / window_secs),
        _ => None,
    };
    *last = Some(current);
    rate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy_sample(camera_fresh: u64, screen_fresh: u64) -> CaptureHealthSample {
        CaptureHealthSample {
            target_fps: 30.0,
            render_fps: 30.0,
            camera_present: true,
            camera_fresh_serves: camera_fresh,
            screen_present: true,
            screen_fresh_serves: screen_fresh,
            window_secs: 2.0,
        }
    }

    /// Replays the measured 2026-08-27 decay shape: healthy windows, then the
    /// camera fetch collapses to ~6.4 fresh fps while render cadence stays at
    /// target (held frames re-served) — the monitor must name camera-delivery.
    #[test]
    fn names_camera_delivery_on_the_field_decay_signature() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        let mut screen = 0_u64;
        // Baseline + healthy windows: 30fps × 2s = 60 fresh serves per window.
        for _ in 0..4 {
            camera += 60;
            screen += 60;
            assert_eq!(monitor.observe(healthy_sample(camera, screen)), None);
        }
        // Decay: ~6.4 fresh fps → ~13 fresh serves per 2s window.
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 13;
            screen += 13;
            let mut sample = healthy_sample(camera, screen);
            sample.render_fps = 30.0; // render cadence stays healthy
            transition = monitor.observe(sample);
        }
        match transition {
            Some(CaptureHealthTransition::Degraded { stage, detail }) => {
                assert_eq!(stage, CaptureStage::CameraDelivery);
                assert!(detail.contains("camera_fresh=6.5fps"), "detail: {detail}");
            }
            other => panic!("expected a camera-delivery degradation, got {other:?}"),
        }
        assert_eq!(monitor.degraded_stage(), Some(CaptureStage::CameraDelivery));
    }

    #[test]
    fn a_single_bad_window_never_flaps() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        camera += 60;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        camera += 60;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        // One collapsed window…
        camera += 5;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        // …followed by recovery: nothing was ever declared.
        camera += 60;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        assert_eq!(monitor.degraded_stage(), None);
    }

    #[test]
    fn recovery_needs_sustained_health_and_fires_once() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        camera += 60;
        monitor.observe(healthy_sample(camera, 0));
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 5;
            monitor.observe(healthy_sample(camera, 0));
        }
        assert_eq!(monitor.degraded_stage(), Some(CaptureStage::CameraDelivery));
        let mut recovered = None;
        for _ in 0..RECOVERED_WINDOW_THRESHOLD {
            camera += 60;
            recovered = monitor.observe(healthy_sample(camera, 0));
        }
        assert!(matches!(
            recovered,
            Some(CaptureHealthTransition::Recovered { .. })
        ));
        assert_eq!(monitor.degraded_stage(), None);
        // Steady health after recovery stays quiet.
        camera += 60;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
    }

    /// A screen-only scene (notes-mode recording) with a static desktop must
    /// never be declared degraded off screen numbers — SCK is damage-driven.
    #[test]
    fn static_screen_without_camera_is_not_a_verdict() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut sample = healthy_sample(0, 0);
        sample.camera_present = false;
        sample.screen_fresh_serves = 0;
        for _ in 0..10 {
            assert_eq!(monitor.observe(sample), None);
        }
    }

    #[test]
    fn render_collapse_is_named_when_sources_are_fine() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        camera += 60;
        monitor.observe(healthy_sample(camera, 0));
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 60;
            let mut sample = healthy_sample(camera, 0);
            sample.render_fps = 6.0;
            transition = monitor.observe(sample);
        }
        assert!(matches!(
            transition,
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CompositorRender,
                ..
            })
        ));
    }

    /// A cumulative counter that moves backward (compositor swap) re-arms the
    /// baseline instead of producing a bogus negative-delta verdict.
    #[test]
    fn counter_resets_invalidate_the_window() {
        let mut monitor = CaptureHealthMonitor::new();
        monitor.observe(healthy_sample(1000, 1000));
        monitor.observe(healthy_sample(1060, 1060));
        // Reset to a small value: window skipped, no verdict accumulates.
        for _ in 0..5 {
            assert_eq!(monitor.observe(healthy_sample(3, 3)), None);
            assert_eq!(monitor.degraded_stage(), None);
            break;
        }
        // The window after the reset has a valid baseline again.
        assert_eq!(monitor.observe(healthy_sample(63, 63)), None);
    }

    #[test]
    fn zero_target_or_zero_window_is_ignored() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut sample = healthy_sample(0, 0);
        sample.target_fps = 0.0;
        assert_eq!(monitor.observe(sample), None);
        let mut sample = healthy_sample(0, 0);
        sample.window_secs = 0.0;
        assert_eq!(monitor.observe(sample), None);
    }
}
