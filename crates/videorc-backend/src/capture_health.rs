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
//! - `screen-delivery`: ScreenCaptureKit callbacks, complete-frame
//!   publications, and compositor fresh serves all collapsed for the same
//!   generation. Requiring all three preserves static-screen correctness:
//!   ScreenCaptureKit idle callbacks continue while damage-driven complete
//!   frames and fresh serves legitimately remain at zero.
//! - `compositor-render`: the snapshot loop itself fell below cadence.

use std::sync::{Arc, Mutex};

use crate::screen_capture::ScreenCaptureCallbackCadence;
use crate::source_registry::SourceKey;

/// Fraction of the target rate below which a stage counts as degraded.
pub const DEGRADED_RATE_FRACTION: f64 = 0.6;
/// Below this producer callback rate the source counts as STALLED — the only
/// state that admits an automatic restart. 2026-08-31 field capture proved a
/// slow-but-flowing producer (17fps of a 30fps target under system load,
/// UVCAssistant at 45% CPU, host load ~10/10 cores) is an UPSTREAM capacity
/// problem a source restart cannot fix: two cold restarts (epoch @1->@3)
/// changed nothing. Restarting for slowness is repair theater; slowness is
/// logged silently, stalls are healed silently.
pub const PRODUCER_STALL_FLOOR_FPS: f64 = 1.0;

/// Our own process CPU (% of one core) over the sampled window, from
/// getrusage deltas. Answers "are WE the load?" inside every capture-health
/// line — the 2026-08-31 investigation had to reconstruct this from `ps`.
#[cfg(unix)]
fn process_cpu_seconds() -> Option<f64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if rc != 0 {
        return None;
    }
    let usage = unsafe { usage.assume_init() };
    let seconds = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1_000_000.0;
    Some(seconds(usage.ru_utime) + seconds(usage.ru_stime))
}

/// Windows reports `self_cpu=n/a`; the D3-class investigations this feeds are
/// macOS-first, and the Windows lane can grow a GetProcessTimes impl when a
/// field report needs it there.
#[cfg(not(unix))]
fn process_cpu_seconds() -> Option<f64> {
    None
}
/// Consecutive degraded windows before a transition is declared (2s windows
/// → ≈6s of sustained collapse; single-window blips never flap).
pub const DEGRADED_WINDOW_THRESHOLD: u32 = 3;
/// Consecutive healthy windows before recovery is declared.
pub const RECOVERED_WINDOW_THRESHOLD: u32 = 3;

/// One diagnostics window of pipeline rates, cumulative counters included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHealthCameraEpoch {
    pub source_key: SourceKey,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureHealthCameraProducerSample {
    pub epoch: CaptureHealthCameraEpoch,
    /// Device-level delivery fps measured at the capture callback.
    pub source_fps: Option<f64>,
    /// Cumulative callbacks delivered by the native capture session.
    pub capture_callbacks: u64,
    /// Cumulative successful publications into that generation's FrameStore.
    pub frame_store_publications: u64,
    /// Cumulative AVFoundation didDrop callbacks for this generation.
    pub did_drop_callback_count: u64,
    /// Cumulative AVFoundation out-of-buffers drops for this generation.
    pub out_of_buffers: u64,
    /// Current and peak retained camera-backed surfaces.
    pub surface_backing_live_count: u64,
    pub surface_backing_peak_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHealthScreenEpoch {
    pub source_key: SourceKey,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHealthScreenProducerSample {
    pub epoch: CaptureHealthScreenEpoch,
    /// Whether callback cadence can distinguish capture decay from a static,
    /// damage-driven source.
    pub callback_cadence: ScreenCaptureCallbackCadence,
    /// Cumulative native capture callbacks. This cadence is a recovery
    /// discriminator only when `callback_cadence` is authoritative.
    pub capture_callbacks: u64,
    /// Cumulative complete-frame publications into that generation's FrameStore.
    pub frame_store_publications: u64,
}

#[derive(Debug, Clone)]
pub struct CaptureHealthSample {
    /// The session/preview target fps; a sample with a non-positive target is
    /// ignored (no cadence to judge against).
    pub target_fps: f64,
    /// Compositor snapshot production rate over this window.
    pub render_fps: f64,
    /// Whether a camera source is attached to the scene this window.
    pub camera_present: bool,
    /// Capture cadence requested from the active camera source. This is kept
    /// separate from the compositor cadence: a healthy 30fps camera feeding a
    /// 60fps compositor must not be diagnosed as a 50% delivery collapse.
    pub camera_target_fps: Option<f64>,
    /// CUMULATIVE fresh camera serves (compositor fetch counter).
    pub camera_fresh_serves: u64,
    /// Generation-bound producer truth sampled directly from the native
    /// camera runtime. A low compositor fresh-serve rate is never allowed to
    /// trigger a source restart unless these counters corroborate producer
    /// decay for this exact source generation.
    pub camera_producer: Option<CaptureHealthCameraProducerSample>,
    /// Whether a screen source is attached to the scene this window.
    pub screen_present: bool,
    /// Capture cadence requested from the active screen/window source.
    pub screen_target_fps: Option<f64>,
    /// CUMULATIVE fresh screen serves. Damage-driven zero is actionable only
    /// when exact-generation producer callbacks also collapse.
    pub screen_fresh_serves: u64,
    /// Generation-bound ScreenCaptureKit callback/publication truth.
    pub screen_producer: Option<CaptureHealthScreenProducerSample>,
    /// Window length in seconds (non-positive samples are ignored).
    pub window_secs: f64,
}

/// The stage a degradation verdict names, most-upstream first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureStage {
    CameraDelivery,
    ScreenDelivery,
    CompositorRender,
}

impl CaptureStage {
    pub fn label(self) -> &'static str {
        match self {
            CaptureStage::CameraDelivery => "camera-delivery",
            CaptureStage::ScreenDelivery => "screen-delivery",
            CaptureStage::CompositorRender => "compositor-render",
        }
    }
}

pub(crate) type CaptureHealthStageLatchesSlot = Arc<Mutex<CaptureHealthStageLatches>>;

#[derive(Debug, Default)]
pub(crate) struct CaptureHealthStageLatches {
    camera_delivery: bool,
    screen_delivery: bool,
    compositor_render: bool,
}

impl CaptureHealthStageLatches {
    pub(crate) fn set(&mut self, stage: CaptureStage, degraded: bool) {
        match stage {
            CaptureStage::CameraDelivery => self.camera_delivery = degraded,
            CaptureStage::ScreenDelivery => self.screen_delivery = degraded,
            CaptureStage::CompositorRender => self.compositor_render = degraded,
        }
    }

    pub(crate) fn current(&self) -> Option<CaptureStage> {
        if self.camera_delivery {
            Some(CaptureStage::CameraDelivery)
        } else if self.screen_delivery {
            Some(CaptureStage::ScreenDelivery)
        } else if self.compositor_render {
            Some(CaptureStage::CompositorRender)
        } else {
            None
        }
    }

    pub(crate) fn clear_all(&mut self) {
        self.camera_delivery = false;
        self.screen_delivery = false;
        self.compositor_render = false;
    }
}

pub(crate) fn new_capture_health_stage_latches_slot() -> CaptureHealthStageLatchesSlot {
    Arc::new(Mutex::new(CaptureHealthStageLatches::default()))
}

/// A state transition worth telling somebody about. Emitted once per edge —
/// steady states (healthy or degraded) stay quiet.
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureHealthTransition {
    Degraded {
        stage: CaptureStage,
        detail: String,
        camera_epoch: Option<CaptureHealthCameraEpoch>,
        screen_epoch: Option<CaptureHealthScreenEpoch>,
    },
    Recovered {
        stage: CaptureStage,
        detail: String,
        camera_epoch: Option<CaptureHealthCameraEpoch>,
        screen_epoch: Option<CaptureHealthScreenEpoch>,
    },
    /// Consumer-side starvation without matching producer decay. This is
    /// useful diagnostics, but it is deliberately not a recovery command.
    Advisory { detail: String },
}

#[derive(Debug, Default)]
pub struct CaptureHealthMonitor {
    last_camera_fresh: Option<u64>,
    last_camera_callbacks: Option<u64>,
    last_camera_publications: Option<u64>,
    last_camera_did_drop_callbacks: Option<u64>,
    last_camera_out_of_buffers: Option<u64>,
    camera_epoch: Option<CaptureHealthCameraEpoch>,
    last_screen_fresh: Option<u64>,
    last_screen_callbacks: Option<u64>,
    last_screen_publications: Option<u64>,
    screen_epoch: Option<CaptureHealthScreenEpoch>,
    degraded_streak: u32,
    healthy_streak: u32,
    /// The currently-declared degraded stage, if any.
    current: Option<CaptureStage>,
    /// The stage the running degraded streak is accumulating toward.
    pending_stage: Option<CaptureStage>,
    consumer_starvation_advisory_active: bool,
    /// Edge-latch for the slow-but-flowing delivery log so a sustained
    /// pressure episode writes one line, not one per window.
    slow_delivery_log_active: bool,
    last_process_cpu_seconds: Option<f64>,
}

impl CaptureHealthMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The stage currently declared degraded, for diagnostics publication.
    pub fn degraded_stage(&self) -> Option<CaptureStage> {
        self.current
    }

    fn reset_camera_epoch_state(&mut self, epoch: Option<CaptureHealthCameraEpoch>) {
        self.last_camera_fresh = None;
        self.last_camera_callbacks = None;
        self.last_camera_publications = None;
        self.last_camera_did_drop_callbacks = None;
        self.last_camera_out_of_buffers = None;
        self.camera_epoch = epoch;
        self.consumer_starvation_advisory_active = false;
        if self.current == Some(CaptureStage::CameraDelivery) {
            self.current = None;
            self.healthy_streak = 0;
        }
        if self.pending_stage == Some(CaptureStage::CameraDelivery) {
            self.pending_stage = None;
            self.degraded_streak = 0;
        }
    }

    /// Start camera-delivery accounting from a clean baseline when the
    /// compositor adopts a different camera generation. A verified restart is
    /// a new incident boundary: if that generation immediately decays, it must
    /// be able to emit a fresh degradation instead of remaining hidden behind
    /// the previous generation's declared state.
    ///
    /// Compositor-render incidents are deliberately preserved. Camera source
    /// churn cannot certify that the render loop recovered.
    pub fn rearm_camera_source_epoch(&mut self) {
        self.reset_camera_epoch_state(None);
    }

    fn reset_screen_epoch_state(&mut self, epoch: Option<CaptureHealthScreenEpoch>) {
        self.last_screen_fresh = None;
        self.last_screen_callbacks = None;
        self.last_screen_publications = None;
        self.screen_epoch = epoch;
        if self.current == Some(CaptureStage::ScreenDelivery) {
            self.current = None;
            self.healthy_streak = 0;
        }
        if self.pending_stage == Some(CaptureStage::ScreenDelivery) {
            self.pending_stage = None;
            self.degraded_streak = 0;
        }
    }

    /// Start screen-delivery accounting from a clean exact-generation baseline.
    pub fn rearm_screen_source_epoch(&mut self) {
        self.reset_screen_epoch_state(None);
    }

    /// Establish an exact baseline for the maintained debug producer-stall
    /// smoke. The following frozen sample counts as the first real degraded
    /// 2-second window, making the detector's three-window (<=6s) contract
    /// directly testable without fabricating a transition.
    #[cfg(debug_assertions)]
    pub fn arm_camera_producer_stall(
        &mut self,
        epoch: CaptureHealthCameraEpoch,
        camera_fresh_serves: u64,
        capture_callbacks: u64,
        frame_store_publications: u64,
    ) {
        self.reset_camera_epoch_state(Some(epoch));
        self.last_camera_fresh = Some(camera_fresh_serves);
        self.last_camera_callbacks = Some(capture_callbacks);
        self.last_camera_publications = Some(frame_store_publications);
    }

    /// Establish an exact ScreenCaptureKit baseline for the maintained debug
    /// producer-stall smoke. This is deliberately separate from the camera
    /// baseline because screen delivery requires callback, complete-frame
    /// publication, and compositor-fresh evidence to collapse together.
    #[cfg(debug_assertions)]
    pub fn arm_screen_producer_stall(
        &mut self,
        epoch: CaptureHealthScreenEpoch,
        screen_fresh_serves: u64,
        capture_callbacks: u64,
        frame_store_publications: u64,
    ) {
        self.reset_screen_epoch_state(Some(epoch));
        self.last_screen_fresh = Some(screen_fresh_serves);
        self.last_screen_callbacks = Some(capture_callbacks);
        self.last_screen_publications = Some(frame_store_publications);
    }

    /// Feed one diagnostics window; returns a transition when an edge fires.
    pub fn observe(&mut self, sample: CaptureHealthSample) -> Option<CaptureHealthTransition> {
        if !sample.window_secs.is_finite()
            || sample.window_secs <= 0.0
            || !sample.target_fps.is_finite()
            || sample.target_fps <= 0.0
        {
            return None;
        }

        let sample_camera_epoch = sample
            .camera_producer
            .as_ref()
            .map(|producer| producer.epoch.clone());
        if sample_camera_epoch != self.camera_epoch {
            // No camera-delivery verdict or streak is transferable across a
            // source generation. Preserve only an already-declared render
            // incident, which camera churn cannot certify as recovered.
            self.reset_camera_epoch_state(sample_camera_epoch.clone());
        }
        let sample_screen_epoch = sample
            .screen_producer
            .as_ref()
            .map(|producer| producer.epoch.clone());
        if sample_screen_epoch != self.screen_epoch {
            self.reset_screen_epoch_state(sample_screen_epoch.clone());
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
        let (
            camera_callback_fps,
            camera_publication_fps,
            camera_did_drop_rate,
            camera_out_of_buffers_rate,
        ) = if sample.camera_present {
            sample
                .camera_producer
                .as_ref()
                .map_or((None, None, None, None), |producer| {
                    (
                        delta_rate(
                            &mut self.last_camera_callbacks,
                            producer.capture_callbacks,
                            sample.window_secs,
                        ),
                        delta_rate(
                            &mut self.last_camera_publications,
                            producer.frame_store_publications,
                            sample.window_secs,
                        ),
                        delta_rate(
                            &mut self.last_camera_did_drop_callbacks,
                            producer.did_drop_callback_count,
                            sample.window_secs,
                        ),
                        delta_rate(
                            &mut self.last_camera_out_of_buffers,
                            producer.out_of_buffers,
                            sample.window_secs,
                        ),
                    )
                })
        } else {
            self.last_camera_callbacks = None;
            self.last_camera_publications = None;
            self.last_camera_did_drop_callbacks = None;
            self.last_camera_out_of_buffers = None;
            self.camera_epoch = None;
            (None, None, None, None)
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
        let (screen_callback_fps, screen_publication_fps) = if sample.screen_present {
            sample
                .screen_producer
                .as_ref()
                .map_or((None, None), |producer| {
                    (
                        delta_rate(
                            &mut self.last_screen_callbacks,
                            producer.capture_callbacks,
                            sample.window_secs,
                        ),
                        delta_rate(
                            &mut self.last_screen_publications,
                            producer.frame_store_publications,
                            sample.window_secs,
                        ),
                    )
                })
        } else {
            self.last_screen_callbacks = None;
            self.last_screen_publications = None;
            self.screen_epoch = None;
            (None, None)
        };

        let render_floor = sample.target_fps * DEGRADED_RATE_FRACTION;
        let camera_consumer_floor = sample
            .camera_target_fps
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .map(|fps| fps.min(sample.target_fps) * DEGRADED_RATE_FRACTION);
        let camera_producer_floor = sample
            .camera_target_fps
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .map(|fps| fps * DEGRADED_RATE_FRACTION);
        let screen_consumer_floor = sample
            .screen_target_fps
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .map(|fps| fps.min(sample.target_fps) * DEGRADED_RATE_FRACTION);
        let screen_producer_floor = sample
            .screen_target_fps
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .map(|fps| fps * DEGRADED_RATE_FRACTION);
        // Upstream before downstream: a starving camera fetch is the cause
        // even when the render loop is dutifully re-serving held frames at
        // full cadence (the exact 2026-08-27 signature).
        let consumer_camera_starved = matches!(
            (camera_fresh_fps, camera_consumer_floor),
            (Some(rate), Some(floor)) if rate < floor
        );
        // STALLED (restart-worthy): callbacks effectively stopped while a
        // generation claims to be live — the serial-queue-wedge family.
        // SLOW (log-only): flowing below the cadence floor — the system-load
        // family, where restarts are proven useless.
        let producer_camera_stalled = matches!(
            (camera_callback_fps, camera_producer_floor),
            (Some(callbacks), Some(_)) if callbacks < PRODUCER_STALL_FLOOR_FPS
        );
        let producer_camera_slow = !producer_camera_stalled
            && matches!(
                (
                    camera_callback_fps,
                    camera_publication_fps,
                    camera_producer_floor
                ),
                (Some(callbacks), Some(publications), Some(floor))
                    if callbacks < floor || publications < floor
            );
        let consumer_screen_starved = matches!(
            (screen_fresh_fps, screen_consumer_floor),
            (Some(rate), Some(floor)) if rate < floor
        );
        // A static desktop legitimately has zero complete publications and
        // fresh serves. Only a source with authoritative continuous callbacks
        // can use callback collapse to distinguish a stalled stream from
        // damage-driven idleness. Windows desktop duplication and gdigrab do
        // not provide that discriminator and must never arm source recovery.
        let producer_screen_stalled = sample.screen_producer.as_ref().is_some_and(|producer| {
            producer.callback_cadence.is_authoritative()
                && matches!(
                    (screen_callback_fps, screen_producer_floor),
                    (Some(callbacks), Some(_)) if callbacks < PRODUCER_STALL_FLOOR_FPS
                )
        });
        let producer_screen_slow = !producer_screen_stalled
            && sample.screen_producer.as_ref().is_some_and(|producer| {
                producer.callback_cadence.is_authoritative()
                    && matches!(
                        (
                            screen_callback_fps,
                            screen_publication_fps,
                            screen_producer_floor
                        ),
                        (Some(callbacks), Some(publications), Some(floor))
                            if callbacks < floor && publications < floor
                    )
            });
        let degraded_stage = if consumer_camera_starved && producer_camera_stalled {
            Some(CaptureStage::CameraDelivery)
        } else if consumer_screen_starved && producer_screen_stalled {
            Some(CaptureStage::ScreenDelivery)
        } else if sample.render_fps < render_floor {
            Some(CaptureStage::CompositorRender)
        } else {
            None
        };

        let self_cpu_pct = {
            let now = process_cpu_seconds();
            let pct = match (self.last_process_cpu_seconds, now, sample.window_secs) {
                (Some(previous), Some(current), window) if window > 0.0 && current >= previous => {
                    Some((current - previous) / window * 100.0)
                }
                _ => None,
            };
            self.last_process_cpu_seconds = now;
            pct
        };
        let detail = format!(
            "target={:.1}fps render={:.1}fps self_cpu={} camera_target={} camera_fresh={} camera_callbacks={} camera_publications={} camera_dev={} camera_did_drop={} camera_oob={} camera_pool={}/{} camera_epoch={} screen_target={} screen_fresh={} screen_callbacks={} screen_publications={} screen_epoch={}",
            sample.target_fps,
            sample.render_fps,
            self_cpu_pct.map_or_else(|| "n/a".to_string(), |pct| format!("{pct:.0}%")),
            sample
                .camera_target_fps
                .map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            camera_fresh_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            camera_callback_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            camera_publication_fps
                .map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            sample
                .camera_producer
                .as_ref()
                .and_then(|producer| producer.source_fps)
                .map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            camera_did_drop_rate.map_or_else(|| "n/a".to_string(), |rate| format!("+{rate:.1}/s")),
            camera_out_of_buffers_rate
                .map_or_else(|| "n/a".to_string(), |rate| format!("+{rate:.1}/s")),
            sample.camera_producer.as_ref().map_or_else(
                || "?".to_string(),
                |producer| producer.surface_backing_live_count.to_string(),
            ),
            sample.camera_producer.as_ref().map_or_else(
                || "?".to_string(),
                |producer| producer.surface_backing_peak_count.to_string(),
            ),
            sample_camera_epoch.as_ref().map_or_else(
                || "n/a".to_string(),
                |epoch| format!("{}@{}", epoch.source_key.id, epoch.generation),
            ),
            sample
                .screen_target_fps
                .map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            screen_fresh_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            screen_callback_fps.map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            screen_publication_fps
                .map_or_else(|| "n/a".to_string(), |rate| format!("{rate:.1}fps")),
            sample_screen_epoch.as_ref().map_or_else(
                || "n/a".to_string(),
                |epoch| format!("{}@{}", epoch.source_key.id, epoch.generation),
            ),
        );

        let slow_delivery = (producer_camera_slow && consumer_camera_starved)
            || (producer_screen_slow && consumer_screen_starved);
        if slow_delivery && !self.slow_delivery_log_active {
            self.slow_delivery_log_active = true;
            tracing::warn!(
                "[capture-health] delivery is slow but flowing (system capture pressure suspected; no restart will be attempted): {detail}"
            );
        } else if !slow_delivery {
            self.slow_delivery_log_active = false;
        }
        let advisory = if consumer_camera_starved
            && !producer_camera_stalled
            && !producer_camera_slow
            && degraded_stage.is_none()
        {
            if !self.consumer_starvation_advisory_active {
                self.consumer_starvation_advisory_active = true;
                Some(CaptureHealthTransition::Advisory {
                    detail: format!(
                        "Camera consumer starvation was not corroborated by generation-bound producer decay; no source restart was admitted. {detail}"
                    ),
                })
            } else {
                None
            }
        } else {
            self.consumer_starvation_advisory_active = false;
            None
        };

        let transition = match degraded_stage {
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
                    Some(CaptureHealthTransition::Degraded {
                        stage,
                        detail,
                        camera_epoch: (stage == CaptureStage::CameraDelivery)
                            .then_some(sample_camera_epoch)
                            .flatten(),
                        screen_epoch: (stage == CaptureStage::ScreenDelivery)
                            .then_some(sample_screen_epoch)
                            .flatten(),
                    })
                } else {
                    None
                }
            }
            None => {
                self.pending_stage = None;
                self.degraded_streak = 0;
                if self.current.is_some() {
                    self.healthy_streak = self.healthy_streak.saturating_add(1);
                    if self.healthy_streak >= RECOVERED_WINDOW_THRESHOLD {
                        let stage = self
                            .current
                            .expect("a recovery streak requires a declared degraded stage");
                        let camera_epoch = (stage == CaptureStage::CameraDelivery)
                            .then_some(sample_camera_epoch)
                            .flatten();
                        let screen_epoch = (stage == CaptureStage::ScreenDelivery)
                            .then_some(sample_screen_epoch)
                            .flatten();
                        self.current = None;
                        self.healthy_streak = 0;
                        Some(CaptureHealthTransition::Recovered {
                            stage,
                            detail,
                            camera_epoch,
                            screen_epoch,
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };
        // State transitions carry authority and take priority when the same
        // window also crosses a one-shot advisory edge. Otherwise publish the
        // advisory without interrupting degradation/recovery accounting.
        transition.or(advisory)
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

    #[test]
    fn shared_stage_latches_are_camera_first_and_stage_scoped() {
        let mut latches = CaptureHealthStageLatches::default();
        latches.set(CaptureStage::CameraDelivery, true);
        latches.set(CaptureStage::CompositorRender, true);
        assert_eq!(latches.current(), Some(CaptureStage::CameraDelivery));

        latches.set(CaptureStage::CompositorRender, false);
        assert_eq!(
            latches.current(),
            Some(CaptureStage::CameraDelivery),
            "render recovery must never clear a latched camera incident"
        );
        latches.set(CaptureStage::CameraDelivery, false);
        assert_eq!(latches.current(), None);
    }

    fn healthy_sample(camera_fresh: u64, screen_fresh: u64) -> CaptureHealthSample {
        CaptureHealthSample {
            target_fps: 30.0,
            render_fps: 30.0,
            camera_present: true,
            camera_target_fps: Some(30.0),
            camera_fresh_serves: camera_fresh,
            camera_producer: Some(CaptureHealthCameraProducerSample {
                epoch: CaptureHealthCameraEpoch {
                    source_key: SourceKey::camera("camera:test"),
                    generation: 1,
                },
                source_fps: Some(30.0),
                capture_callbacks: camera_fresh,
                frame_store_publications: camera_fresh,
                did_drop_callback_count: 0,
                out_of_buffers: 0,
                surface_backing_live_count: 1,
                surface_backing_peak_count: 1,
            }),
            screen_present: true,
            screen_target_fps: None,
            screen_fresh_serves: screen_fresh,
            screen_producer: None,
            window_secs: 2.0,
        }
    }

    #[test]
    fn degradation_detail_carries_generation_bound_camera_discriminators() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera_fresh = 60_u64;
        let mut callbacks = 60_u64;
        let mut publications = 60_u64;
        let mut did_drop = 0_u64;
        let mut out_of_buffers = 0_u64;
        let sample = |camera_fresh, callbacks, publications, did_drop, out_of_buffers| {
            let mut sample = healthy_sample(camera_fresh, 0);
            sample.screen_present = false;
            sample.camera_producer = Some(CaptureHealthCameraProducerSample {
                epoch: CaptureHealthCameraEpoch {
                    source_key: SourceKey::camera("camera:test"),
                    generation: 7,
                },
                source_fps: Some(29.9),
                capture_callbacks: callbacks,
                frame_store_publications: publications,
                did_drop_callback_count: did_drop,
                out_of_buffers,
                surface_backing_live_count: 14,
                surface_backing_peak_count: 16,
            });
            sample
        };
        assert!(
            monitor
                .observe(sample(
                    camera_fresh,
                    callbacks,
                    publications,
                    did_drop,
                    out_of_buffers,
                ))
                .is_none()
        );

        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera_fresh += 12;
            callbacks += 1;
            publications += 1;
            did_drop += 48;
            out_of_buffers += 48;
            transition = monitor.observe(sample(
                camera_fresh,
                callbacks,
                publications,
                did_drop,
                out_of_buffers,
            ));
        }
        let CaptureHealthTransition::Degraded { detail, .. } =
            transition.expect("sustained producer and consumer decay degrades")
        else {
            panic!("expected a degradation transition")
        };
        assert!(detail.contains("camera_dev=29.9fps"), "{detail}");
        assert!(detail.contains("camera_callbacks=0.5fps"), "{detail}");
        assert!(detail.contains("camera_did_drop=+24.0/s"), "{detail}");
        assert!(detail.contains("camera_oob=+24.0/s"), "{detail}");
        assert!(detail.contains("camera_pool=14/16"), "{detail}");
        assert!(detail.contains("camera_epoch=camera:test@7"), "{detail}");
    }

    /// The measured 2026-08-27/31 SLOW shape (camera flowing at ~6.5fps
    /// under system pressure): logged silently, NEVER declared degraded —
    /// restarts are proven useless against upstream capacity (owner
    /// directive 2026-08-31: no repair theater for slowness).
    #[test]
    fn slow_flowing_camera_is_never_degraded() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        for _ in 0..4 {
            camera += 60;
            assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        }
        for _ in 0..(DEGRADED_WINDOW_THRESHOLD * 2) {
            camera += 13; // ~6.5fps: starved consumer, flowing producer
            assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        }
        assert_eq!(monitor.degraded_stage(), None);
    }

    /// A STALLED camera (callbacks below the 1fps stall floor while the
    /// generation claims to be live — the 2026-08-28 wedge shape) is the one
    /// state that degrades and admits the silent restart.
    #[test]
    fn stalled_camera_names_camera_delivery() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        for _ in 0..4 {
            camera += 60;
            assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        }
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 1; // 0.5fps < PRODUCER_STALL_FLOOR_FPS
            transition = monitor.observe(healthy_sample(camera, 0));
        }
        match transition {
            Some(CaptureHealthTransition::Degraded {
                stage,
                detail,
                camera_epoch,
                ..
            }) => {
                assert_eq!(stage, CaptureStage::CameraDelivery);
                assert!(
                    detail.contains("camera_callbacks=0.5fps"),
                    "detail: {detail}"
                );
                assert_eq!(camera_epoch.unwrap().generation, 1);
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
            camera += 1;
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
            Some(CaptureHealthTransition::Recovered {
                stage: CaptureStage::CameraDelivery,
                camera_epoch: Some(_),
                ..
            })
        ));
        assert_eq!(monitor.degraded_stage(), None);
        // Steady health after recovery stays quiet.
        camera += 60;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
    }

    /// A screen-only scene (notes-mode recording) with a static desktop must
    /// never be declared degraded off complete-frame counts. ScreenCaptureKit
    /// publications are damage-driven while its idle/status callback cadence
    /// remains authoritative.
    #[test]
    fn static_screen_without_camera_is_not_a_verdict() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut sample = healthy_sample(0, 0);
        sample.camera_present = false;
        sample.camera_target_fps = None;
        sample.camera_producer = None;
        sample.screen_fresh_serves = 0;
        sample.screen_target_fps = Some(30.0);
        sample.screen_producer = Some(CaptureHealthScreenProducerSample {
            epoch: CaptureHealthScreenEpoch {
                source_key: SourceKey::screen("screen:static"),
                generation: 3,
            },
            callback_cadence: ScreenCaptureCallbackCadence::Authoritative,
            capture_callbacks: 0,
            frame_store_publications: 0,
        });
        for _ in 0..10 {
            sample
                .screen_producer
                .as_mut()
                .expect("static screen producer")
                .capture_callbacks += 60;
            assert_eq!(monitor.observe(sample.clone()), None);
        }
    }

    #[test]
    fn screen_delivery_decay_requires_generation_bound_producer_corroboration() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut screen = 60_u64;
        let mut callbacks = 60_u64;
        let mut publications = 60_u64;

        let screen_sample = |screen_fresh_serves, capture_callbacks, frame_store_publications| {
            let mut sample = healthy_sample(0, screen_fresh_serves);
            sample.camera_present = false;
            sample.camera_target_fps = None;
            sample.camera_producer = None;
            sample.screen_target_fps = Some(30.0);
            sample.screen_producer = Some(CaptureHealthScreenProducerSample {
                epoch: CaptureHealthScreenEpoch {
                    source_key: SourceKey::screen("screen:test"),
                    generation: 7,
                },
                callback_cadence: ScreenCaptureCallbackCadence::Authoritative,
                capture_callbacks,
                frame_store_publications,
            });
            sample
        };

        assert_eq!(
            monitor.observe(screen_sample(screen, callbacks, publications)),
            None
        );
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            screen += 1;
            callbacks += 1;
            publications += 1;
            transition = monitor.observe(screen_sample(screen, callbacks, publications));
        }

        assert!(matches!(
            transition,
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::ScreenDelivery,
                screen_epoch: Some(CaptureHealthScreenEpoch { generation: 7, .. }),
                ..
            })
        ));
    }

    #[test]
    fn damage_driven_screen_cadence_never_arms_screen_delivery_recovery() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut counter = 60_u64;
        let sample = |counter| {
            let mut sample = healthy_sample(0, counter);
            sample.camera_present = false;
            sample.camera_target_fps = None;
            sample.camera_producer = None;
            sample.screen_target_fps = Some(30.0);
            sample.screen_producer = Some(CaptureHealthScreenProducerSample {
                epoch: CaptureHealthScreenEpoch {
                    source_key: SourceKey::screen("screen:dxgi:00000000000003f1:0"),
                    generation: 9,
                },
                callback_cadence: ScreenCaptureCallbackCadence::DamageDriven,
                capture_callbacks: counter,
                frame_store_publications: counter,
            });
            sample
        };

        assert_eq!(monitor.observe(sample(counter)), None);
        for _ in 0..=DEGRADED_WINDOW_THRESHOLD {
            counter += 4;
            assert_eq!(monitor.observe(sample(counter)), None);
            assert_eq!(monitor.degraded_stage(), None);
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

    #[test]
    fn render_collapse_is_not_masked_by_consumer_starvation_advisory() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut consumer = 0_u64;
        let mut producer = 0_u64;
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            consumer += 4;
            producer += 60;
            let mut sample = healthy_sample(consumer, 0);
            sample.render_fps = 6.0;
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
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

    #[test]
    fn consumer_starvation_advisory_does_not_block_compositor_recovery() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut consumer = 60_u64;
        let mut producer = 60_u64;
        monitor.observe(healthy_sample(consumer, 0));

        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            consumer += 60;
            producer += 60;
            let mut sample = healthy_sample(consumer, 0);
            sample.render_fps = 6.0;
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
            monitor.observe(sample);
        }
        assert_eq!(
            monitor.degraded_stage(),
            Some(CaptureStage::CompositorRender)
        );

        let mut advisory_count = 0;
        let mut recovered = None;
        for _ in 0..RECOVERED_WINDOW_THRESHOLD {
            consumer += 4;
            producer += 60;
            let mut sample = healthy_sample(consumer, 0);
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
            match monitor.observe(sample) {
                Some(CaptureHealthTransition::Advisory { .. }) => advisory_count += 1,
                transition @ Some(CaptureHealthTransition::Recovered { .. }) => {
                    recovered = transition
                }
                None => {}
                other => panic!("unexpected recovery-window transition: {other:?}"),
            }
        }

        assert_eq!(advisory_count, 1);
        assert!(matches!(
            recovered,
            Some(CaptureHealthTransition::Recovered {
                stage: CaptureStage::CompositorRender,
                camera_epoch: None,
                ..
            })
        ));
        assert_eq!(monitor.degraded_stage(), None);
    }

    #[test]
    fn healthy_30fps_camera_under_60fps_compositor_is_not_degraded() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        for _ in 0..8 {
            camera += 60;
            let mut sample = healthy_sample(camera, 0);
            sample.target_fps = 60.0;
            sample.render_fps = 60.0;
            sample.camera_target_fps = Some(30.0);
            assert_eq!(monitor.observe(sample), None);
        }
        assert_eq!(monitor.degraded_stage(), None);
    }

    #[test]
    fn slow_producer_below_negotiated_floor_never_degrades_only_a_stall_does() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut consumer = 20_u64;
        let mut producer = 40_u64;
        let mut baseline = healthy_sample(consumer, 0);
        baseline.camera_target_fps = Some(60.0);
        let evidence = baseline.camera_producer.as_mut().unwrap();
        evidence.capture_callbacks = producer;
        evidence.frame_store_publications = producer;
        assert_eq!(monitor.observe(baseline), None);

        for _ in 0..(DEGRADED_WINDOW_THRESHOLD * 2) {
            // Consumer delivery is 10fps and the native producer is 20fps —
            // below the camera's negotiated 36fps floor but FLOWING. A slow
            // producer is upstream capacity pressure a restart cannot fix
            // (2026-08-31 field proof): logged silently, never degraded.
            consumer += 20;
            producer += 40;
            let mut sample = healthy_sample(consumer, 0);
            sample.camera_target_fps = Some(60.0);
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
            assert_eq!(monitor.observe(sample), None);
        }
        assert_eq!(monitor.degraded_stage(), None);

        // A true stall on the same 60fps-negotiated camera still degrades.
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            consumer += 1;
            producer += 1;
            let mut sample = healthy_sample(consumer, 0);
            sample.camera_target_fps = Some(60.0);
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
            transition = monitor.observe(sample);
        }
        assert!(matches!(
            transition,
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                ..
            })
        ));
    }

    #[test]
    fn camera_generation_change_discards_partial_and_declared_camera_state() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut old_counter = 60_u64;
        monitor.observe(healthy_sample(old_counter, 0));
        for _ in 0..(DEGRADED_WINDOW_THRESHOLD - 1) {
            old_counter += 1;
            assert_eq!(monitor.observe(healthy_sample(old_counter, 0)), None);
        }
        assert_eq!(monitor.pending_stage, Some(CaptureStage::CameraDelivery));
        assert_eq!(monitor.degraded_streak, DEGRADED_WINDOW_THRESHOLD - 1);

        let mut replacement = healthy_sample(5, 0);
        let replacement_epoch = CaptureHealthCameraEpoch {
            source_key: SourceKey::camera("camera:test"),
            generation: 2,
        };
        let evidence = replacement.camera_producer.as_mut().unwrap();
        evidence.epoch = replacement_epoch.clone();
        evidence.capture_callbacks = 5;
        evidence.frame_store_publications = 5;
        assert_eq!(monitor.observe(replacement), None);
        assert_eq!(monitor.pending_stage, None);
        assert_eq!(monitor.degraded_streak, 0);
        assert_eq!(monitor.healthy_streak, 0);

        // Two degraded windows on generation N plus one on N+1 must not
        // satisfy the three-window threshold for the replacement source.
        let mut first_new_degraded = healthy_sample(6, 0);
        let evidence = first_new_degraded.camera_producer.as_mut().unwrap();
        evidence.epoch = replacement_epoch.clone();
        evidence.capture_callbacks = 6;
        evidence.frame_store_publications = 6;
        assert_eq!(monitor.observe(first_new_degraded), None);
        assert_eq!(monitor.degraded_streak, 1);
        assert_eq!(monitor.degraded_stage(), None);

        // A declared old-generation camera incident is also generation-bound,
        // while an active compositor-render incident is covered separately.
        let mut declared = CaptureHealthMonitor::new();
        let mut counter = 60_u64;
        declared.observe(healthy_sample(counter, 0));
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            counter += 1;
            declared.observe(healthy_sample(counter, 0));
        }
        assert_eq!(
            declared.degraded_stage(),
            Some(CaptureStage::CameraDelivery)
        );
        let mut next_generation = healthy_sample(5, 0);
        let evidence = next_generation.camera_producer.as_mut().unwrap();
        evidence.epoch = replacement_epoch;
        evidence.capture_callbacks = 5;
        evidence.frame_store_publications = 5;
        assert_eq!(declared.observe(next_generation), None);
        assert_eq!(declared.degraded_stage(), None);
    }

    #[test]
    fn camera_generation_rearm_allows_a_second_degradation_incident() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 60_u64;
        monitor.observe(healthy_sample(camera, 0));
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 1;
            monitor.observe(healthy_sample(camera, 0));
        }
        assert_eq!(monitor.degraded_stage(), Some(CaptureStage::CameraDelivery));

        monitor.rearm_camera_source_epoch();
        assert_eq!(monitor.degraded_stage(), None);

        // The replacement generation resets its cumulative fetch counter. Its
        // first window establishes a baseline; sustained decay then produces a
        // new edge without waiting for the old generation to recover.
        camera = 5;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 1;
            transition = monitor.observe(healthy_sample(camera, 0));
        }
        assert!(matches!(
            transition,
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                ..
            })
        ));
    }

    #[test]
    fn same_generation_explicit_mutation_rearm_allows_persistent_decay_to_emit_again() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 60_u64;
        monitor.observe(healthy_sample(camera, 0));
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 1;
            monitor.observe(healthy_sample(camera, 0));
        }
        assert_eq!(monitor.degraded_stage(), Some(CaptureStage::CameraDelivery));

        monitor.rearm_camera_source_epoch();
        assert_eq!(monitor.degraded_stage(), None);

        // The explicit mutation may reuse the same native generation and its
        // cumulative counters. Rearming must still establish a new baseline
        // and allow persistent post-boundary decay to declare a new incident.
        camera += 1;
        assert_eq!(monitor.observe(healthy_sample(camera, 0)), None);
        let mut transition = None;
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 1;
            transition = monitor.observe(healthy_sample(camera, 0));
        }
        assert!(matches!(
            transition,
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                ..
            })
        ));
    }

    #[test]
    fn camera_generation_rearm_does_not_clear_compositor_render_incident() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 60_u64;
        monitor.observe(healthy_sample(camera, 0));
        for _ in 0..DEGRADED_WINDOW_THRESHOLD {
            camera += 60;
            let mut sample = healthy_sample(camera, 0);
            sample.render_fps = 6.0;
            monitor.observe(sample);
        }
        assert_eq!(
            monitor.degraded_stage(),
            Some(CaptureStage::CompositorRender)
        );

        monitor.rearm_camera_source_epoch();

        assert_eq!(
            monitor.degraded_stage(),
            Some(CaptureStage::CompositorRender)
        );
    }

    #[test]
    fn camera_generation_change_preserves_compositor_render_streaks() {
        let replacement_epoch = CaptureHealthCameraEpoch {
            source_key: SourceKey::camera("camera:test"),
            generation: 2,
        };

        let mut pending = CaptureHealthMonitor::new();
        let mut camera = 60_u64;
        pending.observe(healthy_sample(camera, 0));
        for _ in 0..(DEGRADED_WINDOW_THRESHOLD - 1) {
            camera += 60;
            let mut sample = healthy_sample(camera, 0);
            sample.render_fps = 6.0;
            assert_eq!(pending.observe(sample), None);
        }
        assert_eq!(pending.pending_stage, Some(CaptureStage::CompositorRender));
        assert_eq!(pending.degraded_streak, DEGRADED_WINDOW_THRESHOLD - 1);

        camera += 60;
        let mut replacement = healthy_sample(camera, 0);
        replacement.render_fps = 6.0;
        replacement.camera_producer.as_mut().unwrap().epoch = replacement_epoch.clone();
        assert!(matches!(
            pending.observe(replacement),
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CompositorRender,
                ..
            })
        ));

        let mut recovering = pending;
        let mut recovered = None;
        for window in 1..=RECOVERED_WINDOW_THRESHOLD {
            camera += 60;
            let mut sample = healthy_sample(camera, 0);
            sample.camera_producer.as_mut().unwrap().epoch = replacement_epoch.clone();
            if window == RECOVERED_WINDOW_THRESHOLD {
                // A camera-only generation edge cannot restart the render
                // recovery streak accumulated by the preceding windows.
                sample.camera_producer.as_mut().unwrap().epoch.generation = 3;
            }
            recovered = recovering.observe(sample);
        }
        assert!(matches!(
            recovered,
            Some(CaptureHealthTransition::Recovered {
                stage: CaptureStage::CompositorRender,
                camera_epoch: None,
                ..
            })
        ));
    }

    #[test]
    fn camera_without_a_credible_target_is_advisory_only() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut camera = 0_u64;
        for _ in 0..8 {
            camera += 2;
            let mut sample = healthy_sample(camera, 0);
            sample.camera_target_fps = None;
            assert_eq!(monitor.observe(sample), None);
        }
        assert_eq!(monitor.degraded_stage(), None);
    }

    #[test]
    fn healthy_generation_bound_producer_does_not_restart_for_consumer_starvation() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut fresh_serves = 0_u64;
        let mut producer = 0_u64;
        let mut advisory_count = 0;

        for _ in 0..6 {
            // The compositor keeps re-serving a held frame at ~2fps while the
            // exact camera generation continues callbacks/publications at
            // 30fps. This is consumer contention, not a sick capture source.
            fresh_serves += 4;
            producer += 60;
            let mut sample = healthy_sample(fresh_serves, 0);
            let evidence = sample.camera_producer.as_mut().unwrap();
            evidence.capture_callbacks = producer;
            evidence.frame_store_publications = producer;
            match monitor.observe(sample) {
                Some(CaptureHealthTransition::Advisory { detail }) => {
                    advisory_count += 1;
                    assert!(detail.contains("no source restart was admitted"));
                }
                None => {}
                other => panic!("consumer starvation must stay advisory, got {other:?}"),
            }
        }

        assert_eq!(advisory_count, 1, "the diagnostic edge must not spam");
        assert_eq!(monitor.degraded_stage(), None);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn armed_producer_stall_uses_three_real_windows_and_exact_generation() {
        let mut monitor = CaptureHealthMonitor::new();
        let sample = healthy_sample(120, 0);
        let producer = sample.camera_producer.clone().unwrap();
        monitor.arm_camera_producer_stall(
            producer.epoch.clone(),
            sample.camera_fresh_serves,
            producer.capture_callbacks,
            producer.frame_store_publications,
        );

        for window in 1..=DEGRADED_WINDOW_THRESHOLD {
            let transition = monitor.observe(sample.clone());
            if window < DEGRADED_WINDOW_THRESHOLD {
                assert_eq!(transition, None, "window {window} must not fire early");
            } else {
                assert!(matches!(
                    transition,
                    Some(CaptureHealthTransition::Degraded {
                        stage: CaptureStage::CameraDelivery,
                        camera_epoch: Some(ref epoch),
                        ..
                    }) if epoch == &producer.epoch
                ));
            }
        }
        assert_eq!(
            f64::from(DEGRADED_WINDOW_THRESHOLD) * sample.window_secs,
            6.0,
            "maintained smoke must exercise the <=6s detector contract"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn armed_screen_producer_stall_uses_three_real_windows_and_exact_generation() {
        let mut monitor = CaptureHealthMonitor::new();
        let epoch = CaptureHealthScreenEpoch {
            source_key: SourceKey::screen("screen:screencapturekit:test"),
            generation: 7,
        };
        let sample = CaptureHealthSample {
            target_fps: 30.0,
            render_fps: 30.0,
            camera_present: false,
            camera_target_fps: None,
            camera_fresh_serves: 0,
            camera_producer: None,
            screen_present: true,
            screen_target_fps: Some(30.0),
            screen_fresh_serves: 120,
            screen_producer: Some(CaptureHealthScreenProducerSample {
                epoch: epoch.clone(),
                callback_cadence: ScreenCaptureCallbackCadence::Authoritative,
                capture_callbacks: 120,
                frame_store_publications: 120,
            }),
            window_secs: 2.0,
        };
        monitor.arm_screen_producer_stall(epoch.clone(), 120, 120, 120);

        for window in 1..=DEGRADED_WINDOW_THRESHOLD {
            let transition = monitor.observe(sample.clone());
            if window < DEGRADED_WINDOW_THRESHOLD {
                assert_eq!(transition, None, "window {window} must not fire early");
            } else {
                assert!(matches!(
                    transition,
                    Some(CaptureHealthTransition::Degraded {
                        stage: CaptureStage::ScreenDelivery,
                        screen_epoch: Some(ref observed_epoch),
                        ..
                    }) if observed_epoch == &epoch
                ));
            }
        }
        assert_eq!(
            f64::from(DEGRADED_WINDOW_THRESHOLD) * sample.window_secs,
            6.0,
            "maintained screen smoke must exercise the <=6s detector contract"
        );
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

    #[test]
    fn non_finite_target_or_window_is_ignored_without_mutating_state() {
        let mut monitor = CaptureHealthMonitor::new();
        let mut counter = 60_u64;
        monitor.observe(healthy_sample(counter, 0));
        for _ in 0..(DEGRADED_WINDOW_THRESHOLD - 1) {
            counter += 1;
            assert_eq!(monitor.observe(healthy_sample(counter, 0)), None);
        }
        let before = (
            (
                monitor.last_camera_fresh,
                monitor.last_camera_callbacks,
                monitor.last_camera_publications,
                monitor.camera_epoch.clone(),
            ),
            (
                monitor.last_screen_fresh,
                monitor.last_screen_callbacks,
                monitor.last_screen_publications,
                monitor.screen_epoch.clone(),
            ),
            (
                monitor.degraded_streak,
                monitor.healthy_streak,
                monitor.current,
                monitor.pending_stage,
            ),
            monitor.consumer_starvation_advisory_active,
        );

        for (target_fps, window_secs) in [
            (f64::NAN, 2.0),
            (f64::INFINITY, 2.0),
            (30.0, f64::NAN),
            (30.0, f64::INFINITY),
        ] {
            let mut invalid = healthy_sample(10_000, 10_000);
            invalid.target_fps = target_fps;
            invalid.window_secs = window_secs;
            invalid.camera_producer.as_mut().unwrap().epoch.generation = 99;
            assert_eq!(monitor.observe(invalid), None);
        }

        let after = (
            (
                monitor.last_camera_fresh,
                monitor.last_camera_callbacks,
                monitor.last_camera_publications,
                monitor.camera_epoch.clone(),
            ),
            (
                monitor.last_screen_fresh,
                monitor.last_screen_callbacks,
                monitor.last_screen_publications,
                monitor.screen_epoch.clone(),
            ),
            (
                monitor.degraded_streak,
                monitor.healthy_streak,
                monitor.current,
                monitor.pending_stage,
            ),
            monitor.consumer_starvation_advisory_active,
        );
        assert_eq!(after, before);

        counter += 1;
        assert!(matches!(
            monitor.observe(healthy_sample(counter, 0)),
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                ..
            })
        ));
    }
}
