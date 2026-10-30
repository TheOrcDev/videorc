//! Performance check: short synthetic recordings through the real recording
//! pipeline, walked down a resolution ladder until one holds with headroom.
//! The first rung that passes becomes the recommended output for this machine.
//!
//! Origin: support bundle 20260920-160103Z — an Intel UHD 600 was handed the
//! 2560x1440 default, encoded at 0.28x realtime and lost every recording. The
//! backend knew the machine was failing only once the take was already ruined;
//! this measures it before the first real recording.
//!
//! This file holds the pure parts (ladder, scoring, recommendation). The
//! runner that drives real sessions lives below them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

use crate::capture_interruption::CaptureAdmissionBlocker;
use crate::protocol::{
    DiagnosticStats, EncodeBackend, OutputSettings, PerformanceCheckProgress,
    PerformanceCheckResult, PerformanceCheckRunParams, PerformanceCheckRung,
    PerformanceCheckRungVerdict, PerformanceCheckState, RecordingState, RtmpPreset, RtmpSettings,
    SessionPurpose, SourceSelection, StartSessionParams, VideoPreset, VideoSettings,
};
use crate::state::AppState;

/// Frozen scoring budgets. The benchmark has no screen/camera capture cost, so
/// "barely realtime" must fail: a real session on the same machine is heavier.
/// Calibration record: docs/acceptance/performance-check-calibration.md.
/// FFmpeg reports speed since process start, so over a ~5 s rung the startup
/// latency alone reads as 0.99 on a machine with ample headroom (measured:
/// 0.992 on Apple silicon + VideoToolbox). 0.95 keeps that from flaking;
/// delivered fps, pipe backpressure and drain time catch real slowness.
pub(crate) const MIN_ENCODER_SPEED: f64 = 0.95;
pub(crate) const MIN_DELIVERED_FPS_RATIO: f64 = 0.95;
pub(crate) const MAX_STALLED_FRAME_RATIO: f64 = 0.02;
/// Oldest frame waiting for the encoder. Healthy: ~50 ms. UHD 600 bundle: 12 s.
pub(crate) const MAX_QUEUE_FRAME_AGE_MS: u64 = 500;
pub(crate) const MAX_WRITER_ACTIVE_FRAME_BUDGET_RATIO: f64 = 0.60;
pub(crate) const MAX_TICK_GAP_FRAME_BUDGET_RATIO: f64 = 1.5;
pub(crate) const MAX_FIFO_WRITE_FRAME_BUDGET_RATIO: f64 = 1.0;
pub(crate) const MAX_DRAIN_AFTER_STOP_MS: u64 = 2_000;
/// Below this the machine is so far off that the next rung down is not worth
/// six seconds of the user's time either.
pub(crate) const FAST_SKIP_ENCODER_SPEED: f64 = 0.5;

/// Top-down candidates. Bitrates match the renderer's `videoPresets` table.
/// 4K60 is absent on purpose: it is experimental and records through the
/// legacy FFmpeg capture path, which this benchmark cannot measure — the check
/// never recommends it and the renderer shows it as unverified.
pub(crate) fn full_ladder() -> Vec<VideoSettings> {
    fn rung(preset: VideoPreset, width: u32, height: u32, fps: u32, kbps: u32) -> VideoSettings {
        VideoSettings {
            preset,
            width,
            height,
            fps,
            bitrate_kbps: kbps,
        }
    }
    vec![
        rung(VideoPreset::Record4k30, 3840, 2160, 30, 30_000),
        rung(VideoPreset::Tutorial1440p30, 2560, 1440, 30, 8_000),
        rung(VideoPreset::StreamSafe1080p60, 1920, 1080, 60, 6_000),
        rung(VideoPreset::Tutorial1080p30, 1920, 1080, 30, 6_000),
        rung(VideoPreset::Tutorial720p30, 1280, 720, 30, 4_000),
        // The floor (plan 090 D1). A UHD 600 class PC encoded 720p30 at 0.69x
        // real time in software; a quarter fewer pixels than that gives it
        // something it can hold, and the check a truthful recommendation.
        rung(VideoPreset::Tutorial540p30, 960, 540, 30, 2_500),
    ]
}

/// Rungs at or below the ceiling (pixels and fps). The floor rung is always
/// kept so the check can never come back without a recommendation.
pub(crate) fn ladder_under_ceiling(width: u32, height: u32, fps: u32) -> Vec<VideoSettings> {
    let ceiling_pixels = u64::from(width) * u64::from(height);
    let ladder = full_ladder();
    let floor = ladder.last().cloned();
    let mut rungs: Vec<VideoSettings> = ladder
        .into_iter()
        .filter(|rung| pixels(rung) <= ceiling_pixels && rung.fps <= fps.max(30))
        .collect();
    if rungs.is_empty()
        && let Some(floor) = floor
    {
        rungs.push(floor);
    }
    rungs
}

fn pixels(video: &VideoSettings) -> u64 {
    u64::from(video.width) * u64::from(video.height)
}

/// Plan 200 D4: the encoder work one take asks for. Hardware encoder
/// throughput divides by pixel rate (plan 158: one 4K30 session reached
/// 62 fps on an M4, three reached about 21 fps each), so the budget is the
/// sum over every encoder the take runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EncoderBudget {
    pub encoders: u32,
    pub pixels_per_second: u64,
}

impl EncoderBudget {
    /// How many single encodes of `video` this budget is worth.
    pub fn load_factor(&self, video: &VideoSettings) -> f64 {
        let single = pixels(video) * u64::from(video.fps.max(1));
        self.pixels_per_second as f64 / single.max(1) as f64
    }
}

/// The camera a check assumes for the Camera file when it knows none: a
/// 1080p webcam, fitted inside the canvas like a real take (plan 200 D2).
const ASSUMED_SEPARATE_FILE_CAMERA: (u32, u32) = (1920, 1080);

/// Plan 200 D4: Combined, plus Screen (the canvas) and Camera (its own size
/// inside the canvas) when separate files are on, plus a dedicated stream
/// encoder when one runs.
pub(crate) fn encoder_budget(
    video: &VideoSettings,
    separate_files: bool,
    camera: Option<(u32, u32)>,
    stream: Option<&VideoSettings>,
) -> EncoderBudget {
    let rate = |width: u32, height: u32, fps: u32| {
        u64::from(width) * u64::from(height) * u64::from(fps.max(1))
    };
    let canvas = rate(video.width, video.height, video.fps);
    let mut budget = EncoderBudget {
        encoders: 1,
        pixels_per_second: canvas,
    };
    if separate_files {
        let (camera_width, camera_height) = crate::source_iso::camera_leg_size(
            Some(camera.unwrap_or(ASSUMED_SEPARATE_FILE_CAMERA)),
            (video.width, video.height),
        );
        budget.encoders += 2;
        budget.pixels_per_second += canvas + rate(camera_width, camera_height, video.fps);
    }
    if let Some(stream) = stream {
        budget.encoders += 1;
        budget.pixels_per_second += rate(stream.width, stream.height, stream.fps);
    }
    budget
}

/// Plan 200 D4: a rung that passed alone but whose separate-files take would
/// ask more of the encoder than this machine has shown it can do.
pub(crate) const SEPARATE_FILES_OVER_BUDGET: &str = "separate-files-over-encoder-budget";

fn pixel_rate(video: &VideoSettings) -> u64 {
    pixels(video) * u64::from(video.fps.max(1))
}

/// Plan 200 D4: may a take at `video` with the separate files on pass? A
/// benchmark take records one encode paced to real time, so its own speed
/// never shows headroom (FFmpeg reports ~1.0x). The evidence is the ladder:
/// the highest single-encode pixel rate the machine passed is its measured
/// encoder throughput, and encoder fps at this rung is that rate divided by
/// the rung's pixels. The rung fails when that fps divided by the take's load
/// factor (Combined + Screen + Camera) is below the rung's fps.
pub(crate) fn separate_files_over_encoder_budget(
    video: &VideoSettings,
    best_single_rate: Option<u64>,
) -> bool {
    let Some(best) = best_single_rate else {
        return true;
    };
    let measured_encoder_fps = best as f64 / pixels(video).max(1) as f64;
    let load = encoder_budget(video, true, None, None).load_factor(video);
    measured_encoder_fps / load < f64::from(video.fps.max(1))
}

/// What one benchmark session measured. `None` means the pipeline never
/// published that signal, which is itself a failure for the mandatory ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RungMeasurement {
    pub started: bool,
    pub start_error: Option<String>,
    /// The start was refused because another capture session held the
    /// slot. That measures the studio, not the machine.
    pub studio_busy: bool,
    pub target_fps: u32,
    pub encoder_speed: Option<f64>,
    pub delivered_fps: Option<f64>,
    /// Frames the bridge skipped before encode, dropped, or had to repeat
    /// because no fresh frame arrived, during the measured window.
    pub stalled_frames: u64,
    pub queue_oldest_frame_age_ms: Option<u64>,
    pub writer_active_p95_ms: Option<f64>,
    pub tick_gap_p95_ms: Option<f64>,
    pub fifo_write_p95_ms: Option<f64>,
    pub drain_after_stop_ms: Option<u64>,
    pub finalized_cleanly: bool,
}

/// Bounded, renderer-safe reason codes; empty means the rung passed.
/// Test helper — production scoring goes through `score_rung_for_backend`.
#[cfg(test)]
pub(crate) fn score_rung(measurement: &RungMeasurement) -> Vec<String> {
    score_rung_for_backend(measurement, None)
}

/// OpenH264 on hard synthetic content reports far-below-realtime `speed=`
/// (ogre Omarchy 2026-09-28: ~0.08 at 720p30) while the same machine already
/// records 1080p through the real Record path. FFmpeg speed, delivered fps
/// and skip-frames are therefore not capability evidence for that backend;
/// start, finalize, queue, pipe and drain still catch the UHD 600 shape.
pub(crate) fn score_rung_for_backend(
    measurement: &RungMeasurement,
    encode_backend: Option<EncodeBackend>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if !measurement.started {
        reasons.push("did-not-start".to_string());
        return reasons;
    }
    let openh264_synthetic = encode_backend == Some(EncodeBackend::SoftwareOpenH264);
    let frame_budget_ms = 1_000.0 / f64::from(measurement.target_fps.max(1));
    if !openh264_synthetic {
        match measurement.encoder_speed {
            Some(speed) if speed >= MIN_ENCODER_SPEED => {}
            Some(_) => reasons.push("encoder-below-realtime".to_string()),
            None => reasons.push("encoder-speed-unmeasured".to_string()),
        }
        match measurement.delivered_fps {
            Some(fps) if fps >= f64::from(measurement.target_fps) * MIN_DELIVERED_FPS_RATIO => {}
            Some(_) => reasons.push("frame-rate-below-target".to_string()),
            None => reasons.push("frame-rate-unmeasured".to_string()),
        }
        let expected_frames = f64::from(measurement.target_fps) * RUNG_MEASURE.as_secs_f64();
        if measurement.stalled_frames as f64 > expected_frames * MAX_STALLED_FRAME_RATIO {
            reasons.push("frames-skipped-or-repeated".to_string());
        }
    }
    if measurement
        .queue_oldest_frame_age_ms
        .is_some_and(|ms| ms > MAX_QUEUE_FRAME_AGE_MS)
    {
        reasons.push("encoder-queue-backlog".to_string());
    }
    if measurement
        .writer_active_p95_ms
        .is_some_and(|ms| ms > frame_budget_ms * MAX_WRITER_ACTIVE_FRAME_BUDGET_RATIO)
    {
        reasons.push("encoder-input-no-headroom".to_string());
    }
    if measurement
        .tick_gap_p95_ms
        .is_some_and(|ms| ms > frame_budget_ms * MAX_TICK_GAP_FRAME_BUDGET_RATIO)
    {
        reasons.push("compositor-cadence-unsteady".to_string());
    }
    if measurement
        .fifo_write_p95_ms
        .is_some_and(|ms| ms > frame_budget_ms * MAX_FIFO_WRITE_FRAME_BUDGET_RATIO)
    {
        reasons.push("encoder-pipe-backpressure".to_string());
    }
    if measurement
        .drain_after_stop_ms
        .is_some_and(|ms| ms > MAX_DRAIN_AFTER_STOP_MS)
    {
        reasons.push("slow-drain-after-stop".to_string());
    }
    if !measurement.finalized_cleanly {
        reasons.push("did-not-finalize".to_string());
    }
    reasons
}

/// FFmpeg reports its output clock every `-stats_period` (0.5 s). Waiting for
/// the value to change pins it to a wall time within one poll.
const MEDIA_TICK_POLL: Duration = Duration::from_millis(20);
/// Longer than any progress period. A clock that does not move in this long
/// is a stalled encoder; its last value is returned so the pace reads low.
const MEDIA_TICK_WAIT: Duration = Duration::from_millis(1_500);
/// Shorter windows are not worth a verdict; the cumulative speed is kept.
const MIN_MEDIA_PACE_WINDOW: Duration = Duration::from_secs(2);

/// The wall time at which the session's FFmpeg output clock next advances,
/// with its value in microseconds. `None` when FFmpeg reports no clock.
async fn next_media_tick(
    state: &AppState,
    clock: &crate::recording::FfmpegProgressBeacon,
) -> Option<(Instant, u64)> {
    let previous = clock.media_micros();
    let deadline = Instant::now() + MEDIA_TICK_WAIT;
    while Instant::now() < deadline && !state.performance_check.cancelled() {
        tokio::time::sleep(MEDIA_TICK_POLL).await;
        let current = clock.media_micros();
        if current != previous {
            return Some((Instant::now(), current));
        }
    }
    (previous > 0).then(|| (Instant::now(), previous))
}

/// Media seconds the encoder produced per wall second between two progress
/// reports.
///
/// The performance check scored FFmpeg's cumulative `speed=`, which carries
/// the encoder's start into every reading: ogre's VAAPI encoder starts ~0.3 s
/// behind, so 720p30 and 540p30 read 0.933-0.941 at the end of a 5.5 s rung
/// while 30.0 fps went through with no stalls (Omarchy 2026-10-26) and the
/// check said nothing held steady. Over a window after the warm-up the start
/// drops out.
pub(crate) fn encoder_media_pace(
    window: Duration,
    start_micros: u64,
    end_micros: u64,
) -> Option<f64> {
    if window < MIN_MEDIA_PACE_WINDOW || start_micros == 0 {
        return None;
    }
    Some(end_micros.saturating_sub(start_micros) as f64 / 1_000_000.0 / window.as_secs_f64())
}

/// A failing rung this far below realtime also rules out the next one down.
pub(crate) fn should_fast_skip_next(measurement: &RungMeasurement) -> bool {
    should_fast_skip_next_on(measurement, cfg!(target_os = "linux"))
}

/// Linux never fast-skips: ogre's VAAPI D128 soft-failed 1440p and skipped
/// 1080p, while acceptance Record→file at 1080p already passed on that box.
pub(crate) fn should_fast_skip_next_on(measurement: &RungMeasurement, linux: bool) -> bool {
    !linux
        && measurement.started
        && measurement
            .encoder_speed
            .is_some_and(|speed| speed < FAST_SKIP_ENCODER_SPEED)
}

/// Start refusals that mean another session owns the capture slot. The
/// check was started from an idle studio, so this is a collision (a Record
/// click, a renderer preview start), never a property of the machine.
pub(crate) fn start_error_means_busy_studio(message: &str) -> bool {
    [
        CaptureAdmissionBlocker::SessionStarting.to_string(),
        CaptureAdmissionBlocker::CaptureActive.to_string(),
        CaptureAdmissionBlocker::InterruptionInProgress.to_string(),
        "A capture session is already running".to_string(),
    ]
    .iter()
    .any(|busy| message.contains(busy.as_str()))
}

/// First passing rung wins; with none, the floor is recommended. `below_floor`
/// is only true when that floor was actually measured and failed — a skipped
/// floor (budget ran out, cancelled mid-ladder) must not be reported as
/// "this computer cannot hold 720p". Linux first-rung VAAPI probing can eat
/// most of `TOTAL_BUDGET` before 720p is reached.
pub(crate) fn recommend(rungs: &[PerformanceCheckRung]) -> Option<(VideoSettings, bool)> {
    if let Some(passed) = rungs
        .iter()
        .find(|rung| rung.verdict == PerformanceCheckRungVerdict::Passed)
    {
        return Some((passed.video.clone(), false));
    }
    rungs.last().map(|floor| {
        (
            floor.video.clone(),
            floor.verdict == PerformanceCheckRungVerdict::Failed,
        )
    })
}

/// Remaining rungs after a pass are omitted. Fast-skip and the total wall
/// budget may drop mid-ladder rungs, but never a protected one: the check
/// must measure 720p before it is allowed to say the machine cannot hold it.
pub(crate) fn should_skip_rung(
    already_passed: bool,
    skip_next: bool,
    over_budget: bool,
    is_protected: bool,
) -> bool {
    already_passed || ((skip_next || over_budget) && !is_protected)
}

/// The floor, and 720p. Since the 540p rung (plan 090) 720p is no longer the
/// floor, and slow failing 1440p/1080p rungs on a software encoder spent the
/// whole budget, so the check said "Use 540p" about a 720p it never measured
/// (Linux plan 0013).
pub(crate) fn is_protected_rung(video: &VideoSettings, is_floor: bool) -> bool {
    is_floor || (video.width == 1280 && video.height == 720)
}

const RESULT_SETTING_KEY: &str = "performance_check_result";
const CAPABILITY_KEY_VERSION: &str = "performance-check-v2";
const DESKTOP_APP_VERSION_ENV: &str = "VIDEORC_APP_VERSION";
const RUNG_WARMUP: Duration = Duration::from_millis(1_500);
const RUNG_MEASURE: Duration = Duration::from_secs(4);
const RUNG_START_TIMEOUT: Duration = Duration::from_secs(15);
const CANCEL_POLL: Duration = Duration::from_millis(200);
const SAMPLE_INTERVAL: Duration = Duration::from_millis(500);
const TOTAL_BUDGET: Duration = Duration::from_secs(45);
const YIELD_TO_CAPTURE_TIMEOUT: Duration = Duration::from_secs(8);

/// Events a benchmark session emits that must never reach a client: the
/// renderer would flip to "Recording", toast health warnings and patch Library
/// rows for a session the user never started. Filtered at the WebSocket relay,
/// not at `emit_event` — `stop_recording` itself waits on `recording.status`.
const SUPPRESSED_EVENTS: [&str; 6] = [
    "recording.status",
    "recording.finalization",
    "health.event",
    "session.log",
    "diagnostics.stats",
    "audio.levels",
];

#[derive(Debug, Default)]
pub struct PerformanceCheckRuntime {
    running: AtomicBool,
    cancel: AtomicBool,
}

impl PerformanceCheckRuntime {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn suppresses_event(&self, event: &str) -> bool {
        self.is_running() && SUPPRESSED_EVENTS.contains(&event)
    }

    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
}

struct RunningGuard<'a>(&'a PerformanceCheckRuntime);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::Release);
        self.0.cancel.store(false, Ordering::Release);
    }
}

/// Desktop version when Electron set it; otherwise the backend crate version.
/// The crate stays at 0.9.0 across desktop releases, so hashing only that
/// left Linux `belowFloor` poison sticky (ogre, 2026-09-28).
pub(crate) fn desktop_app_version() -> String {
    app_version_or_crate(std::env::var(DESKTOP_APP_VERSION_ENV).ok().as_deref())
}

/// The `User-Agent` every backend HTTP client sends: the desktop app's own
/// version, not the backend crate's (release test 146, plan 0008: every
/// request said `Videorc-Desktop/0.9.0` on 0.9.146).
pub(crate) fn desktop_user_agent() -> String {
    desktop_user_agent_for(std::env::var(DESKTOP_APP_VERSION_ENV).ok().as_deref())
}

fn desktop_user_agent_for(app_version: Option<&str>) -> String {
    format!("Videorc-Desktop/{}", app_version_or_crate(app_version))
}

fn app_version_or_crate(app_version: Option<&str>) -> String {
    app_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

/// Names the machine a verdict belongs to. A new GPU, driver or app version
/// makes the stored result stale instead of silently trusting it.
pub(crate) fn capability_key() -> String {
    capability_key_from(
        std::env::consts::OS,
        std::env::consts::ARCH,
        &graphics_identity_for_encoder_preference(
            &crate::recording::graphics_adapter_driver_identity(),
            crate::recording::windows_h264_encoder_preference().0,
        ),
        &desktop_app_version(),
        env!("CARGO_PKG_VERSION"),
    )
}

/// A result measured on one raw-path encoder must not answer for another
/// (plan 090 C6): choosing Quick Sync or software re-measures the machine.
/// The default leaves the material untouched, so no existing result goes
/// stale just because this build knows about the preference.
pub(crate) fn graphics_identity_for_encoder_preference(
    identity: &str,
    preference: crate::protocol::WindowsH264EncoderPreference,
) -> String {
    match preference {
        crate::protocol::WindowsH264EncoderPreference::Auto => identity.to_string(),
        chosen => format!(
            "{identity};h264-encoder={}",
            crate::recording::windows_h264_encoder_preference_label(chosen)
        ),
    }
}

pub(crate) fn capability_key_from(
    os: &str,
    arch: &str,
    graphics_identity: &str,
    app_version: &str,
    backend_crate_version: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CAPABILITY_KEY_VERSION);
    hasher.update(os);
    hasher.update(arch);
    hasher.update(graphics_identity);
    hasher.update(app_version);
    hasher.update(backend_crate_version);
    format!("{CAPABILITY_KEY_VERSION}:{:x}", hasher.finalize())
}

/// v1 keys never match the v2 hasher, and Linux `belowFloor` rows whose
/// every measured rung is `did-not-start` are a failed ladder, not a
/// machine class. `run_ladder` no longer saves a ladder where nothing
/// started, so only rows written before that rule can match.
pub(crate) fn stored_result_is_stale(result: &PerformanceCheckResult) -> bool {
    result.capability_key != capability_key() || linux_did_not_start_below_floor(result)
}

pub(crate) fn linux_did_not_start_below_floor(result: &PerformanceCheckResult) -> bool {
    if std::env::consts::OS != "linux"
        || !result.below_floor
        || !result.capability_key.starts_with("performance-check-v1:")
    {
        return false;
    }
    let measured: Vec<_> = result
        .rungs
        .iter()
        .filter(|rung| rung.verdict != PerformanceCheckRungVerdict::Skipped)
        .collect();
    !measured.is_empty()
        && measured.iter().all(|rung| {
            rung.verdict == PerformanceCheckRungVerdict::Failed
                && rung.reasons.iter().any(|reason| reason == "did-not-start")
        })
}

fn benchmark_directory() -> PathBuf {
    crate::storage::default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("PerformanceChecks")
}

/// A real session start cancels a running check and waits for its benchmark
/// session to leave the capture slot. Bounded: a wedged check must never hold
/// a recording hostage — past the deadline the start proceeds and reports the
/// conflict itself.
pub async fn yield_to_capture(state: &AppState) {
    if !state.performance_check.is_running() {
        return;
    }
    state.performance_check.request_cancel();
    let deadline = Instant::now() + YIELD_TO_CAPTURE_TIMEOUT;
    while state.performance_check.is_running() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub async fn current_state(state: &AppState) -> PerformanceCheckState {
    let result = state
        .database
        .load_setting::<PerformanceCheckResult>(RESULT_SETTING_KEY)
        .ok()
        .flatten();
    let stale = result.as_ref().is_some_and(stored_result_is_stale);
    PerformanceCheckState {
        running: state.performance_check.is_running(),
        result,
        stale,
    }
}

/// Starts the check in the background; progress and the result arrive as
/// `performance.check.progress` / `performance.check.completed` events.
pub async fn start(state: AppState, params: PerformanceCheckRunParams) -> Result<()> {
    if state.recording.lock().await.is_some() {
        bail!("A capture session is running; the performance check needs an idle studio");
    }
    if state
        .performance_check
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        bail!("A performance check is already running");
    }
    tokio::spawn(async move {
        let outcome = {
            let _running = RunningGuard(&state.performance_check);
            run_ladder(&state, &params).await
        };
        // Emitted after the guard dropped so `get` never reports running
        // alongside a completed event. The payload is always the `get` shape;
        // a cancelled or failed run simply carries the previous verdict.
        if let Err(error) = outcome {
            state.emit_log(
                "warn",
                format!("Performance check did not finish: {error:#}"),
            );
        }
        state.emit_event("performance.check.completed", current_state(&state).await);
    });
    Ok(())
}

async fn run_ladder(
    state: &AppState,
    params: &PerformanceCheckRunParams,
) -> Result<PerformanceCheckResult> {
    let started = Instant::now();
    let directory = benchmark_directory();
    tokio::fs::create_dir_all(&directory).await?;
    discard_benchmark_sessions(state, &directory).await;
    let _hard_content = crate::compositor::SyntheticHardContentGuard::engage();

    let ladder = ladder_under_ceiling(
        params.ceiling_width,
        params.ceiling_height,
        params.ceiling_fps,
    );
    let rung_count = ladder.len() as u32;
    let mut rungs = Vec::with_capacity(ladder.len());
    let mut skip_next = false;
    let mut passed = false;
    let mut any_started = false;
    let mut last_start_error = None;
    // Plan 200 D4: the highest single-encode pixel rate this machine passed.
    let mut best_single_rate = None;
    for (index, video) in ladder.into_iter().enumerate() {
        if state.performance_check.cancelled() {
            discard_benchmark_sessions(state, &directory).await;
            bail!("cancelled");
        }
        let is_floor = index as u32 + 1 == rung_count;
        if should_skip_rung(
            passed,
            skip_next,
            started.elapsed() > TOTAL_BUDGET,
            is_protected_rung(&video, is_floor),
        ) {
            if !passed {
                rungs.push(PerformanceCheckRung {
                    video,
                    verdict: PerformanceCheckRungVerdict::Skipped,
                    encode_backend: None,
                    compositor_backend: None,
                    encoder_speed: None,
                    delivered_fps: None,
                    drain_after_stop_ms: None,
                    reasons: Vec::new(),
                });
            }
            skip_next = false;
            continue;
        }
        state.emit_event(
            "performance.check.progress",
            PerformanceCheckProgress {
                rung_index: index as u32,
                rung_count,
                video: video.clone(),
            },
        );
        let (measurement, stats) = measure_rung(state, &video, &directory).await;
        discard_benchmark_sessions(state, &directory).await;
        if measurement.studio_busy {
            // ogre 2026-09-30: the check ran while a session was starting,
            // every rung was refused in 100 ms, and the refusals were saved
            // as "this computer cannot hold 720p". Keep the previous verdict.
            bail!(
                "the studio became busy ({}); no verdict recorded",
                measurement
                    .start_error
                    .as_deref()
                    .unwrap_or("capture active")
            );
        }
        any_started |= measurement.started;
        last_start_error = measurement.start_error.clone().or(last_start_error);
        let encode_backend = stats.as_ref().and_then(|stats| stats.encode_backend);
        let mut reasons = score_rung_for_backend(&measurement, encode_backend);
        if forced_failure_above_height().is_some_and(|height| video.height > height) {
            reasons.push("forced-by-test-seam".to_string());
        }
        if reasons.is_empty() {
            let rate = pixel_rate(&video);
            best_single_rate = Some(best_single_rate.map_or(rate, |best: u64| best.max(rate)));
        }
        if reasons.is_empty()
            && params.separate_source_recordings
            && separate_files_over_encoder_budget(&video, best_single_rate)
        {
            reasons.push(SEPARATE_FILES_OVER_BUDGET.to_string());
        }
        skip_next = !reasons.is_empty() && should_fast_skip_next(&measurement);
        passed = reasons.is_empty();
        // One line per rung in the backend log: the support bundle then shows
        // what this machine measured, not only the verdict.
        state.emit_log(
            "info",
            format!(
                "Performance check {}x{}@{}: {} {measurement:?}",
                video.width,
                video.height,
                video.fps,
                if passed { "passed" } else { "failed" }
            ),
        );
        if let Some(error) = measurement.start_error.as_deref() {
            state.emit_log(
                "info",
                format!(
                    "Performance check {}x{}@{} did not start: {error}",
                    video.width, video.height, video.fps
                ),
            );
        }
        if params.separate_source_recordings {
            // Plan 200 D4: a benchmark take has no camera or screen, so it
            // cannot arm the separate files. The verdict above held the rung
            // to its budget against the best single encode measured; the
            // support bundle shows both.
            let budget = encoder_budget(&video, true, None, None);
            state.emit_log(
                "info",
                format!(
                    "Performance check {}x{}@{} with separate files: {} encoders, {:.0} Mpx/s ({:.2}x one encode); best single encode passed {:.0} Mpx/s.",
                    video.width,
                    video.height,
                    video.fps,
                    budget.encoders,
                    budget.pixels_per_second as f64 / 1e6,
                    budget.load_factor(&video),
                    best_single_rate.unwrap_or(0) as f64 / 1e6
                ),
            );
        }
        rungs.push(PerformanceCheckRung {
            video,
            verdict: if passed {
                PerformanceCheckRungVerdict::Passed
            } else {
                PerformanceCheckRungVerdict::Failed
            },
            encode_backend,
            compositor_backend: stats.as_ref().and_then(|stats| stats.compositor_backend),
            encoder_speed: measurement.encoder_speed,
            delivered_fps: measurement.delivered_fps,
            drain_after_stop_ms: measurement.drain_after_stop_ms,
            reasons,
        });
    }

    if !any_started {
        // Nothing was measured, so there is no verdict to keep. Saving one
        // would brand the floor "too heavy" until the key changes.
        bail!(
            "no benchmark session started ({}); no verdict recorded",
            last_start_error.as_deref().unwrap_or("no rung measured")
        );
    }
    let Some((recommended, below_floor)) = recommend(&rungs) else {
        bail!("the ladder produced no rungs");
    };
    let result = PerformanceCheckResult {
        capability_key: capability_key(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        app_version: desktop_app_version(),
        duration_ms: started.elapsed().as_millis() as u64,
        recommended,
        below_floor,
        rungs,
    };
    state.database.save_setting(RESULT_SETTING_KEY, &result)?;
    Ok(result)
}

/// Test seam for `smoke:performance-check`: fail every rung taller than this
/// so the step-down path runs on hardware that would pass the top rung.
fn forced_failure_above_height() -> Option<u32> {
    std::env::var("VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT")
        .ok()?
        .parse()
        .ok()
}

fn benchmark_session_params(video: &VideoSettings, directory: &Path) -> StartSessionParams {
    StartSessionParams {
        sources: SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: true,
        },
        layout: crate::protocol::default_layout_settings(),
        scene: None,
        output: OutputSettings {
            record_enabled: true,
            stream_enabled: false,
            output_directory: Some(directory.display().to_string()),
            ffmpeg_path: None,
            keep_original_mkv: false,
            // A benchmark take records a test pattern: with no camera and no
            // screen, start validation would refuse the separate files. The
            // run params carry the switch, and the ladder holds each rung to
            // the separate files' encoder budget
            // (`separate_files_over_encoder_budget`).
            separate_source_recordings: None,
            video: video.clone(),
            rtmp: RtmpSettings {
                preset: RtmpPreset::Custom,
                server_url: String::new(),
                stream_key: String::new(),
            },
        },
        audio: Default::default(),
        streaming: None,
        captions: None,
        simulcast: None,
        requested_at_ms: None,
        replay: None,
        purpose: SessionPurpose::PerformanceCheck,
    }
}

async fn measure_rung(
    state: &AppState,
    video: &VideoSettings,
    directory: &Path,
) -> (RungMeasurement, Option<DiagnosticStats>) {
    let mut measurement = RungMeasurement {
        target_fps: video.fps,
        ..RungMeasurement::default()
    };
    let start = tokio::time::timeout(
        RUNG_START_TIMEOUT,
        crate::recording::start_session(state.clone(), benchmark_session_params(video, directory)),
    )
    .await;
    match start {
        Ok(Ok(_)) => measurement.started = true,
        Ok(Err(error)) => {
            let message = format!("{error:#}");
            measurement.studio_busy = start_error_means_busy_studio(&message);
            measurement.start_error = Some(message);
            return (measurement, None);
        }
        Err(_) => {
            measurement.start_error = Some("start timed out".to_string());
            let _ = crate::recording::stop_recording(state.clone()).await;
            return (measurement, None);
        }
    }

    let media_clock = crate::recording::active_ffmpeg_progress(state).await;
    sleep_unless_cancelled(state, RUNG_WARMUP).await;
    let pace_start = match &media_clock {
        Some(clock) => next_media_tick(state, clock).await,
        None => None,
    };
    let baseline = state.diagnostics.lock().await.clone();
    // Bridge windows publish on their own cadence; a single read at the end
    // can land between two windows and see nothing. Keep the latest reading
    // of each signal across the measured window.
    let measure_deadline = Instant::now() + RUNG_MEASURE;
    let mut stats = baseline.clone();
    while Instant::now() < measure_deadline && !state.performance_check.cancelled() {
        sleep_unless_cancelled(
            state,
            SAMPLE_INTERVAL.min(measure_deadline - Instant::now()),
        )
        .await;
        let sample = state.diagnostics.lock().await.clone();
        measurement.encoder_speed = sample
            .encoder_bridge_recording_encoder_speed
            .or(sample.encoder_speed)
            .or(measurement.encoder_speed);
        measurement.delivered_fps = sample
            .encoder_bridge_input_fps
            .or(sample.render_fps)
            .or(measurement.delivered_fps);
        stats = sample;
    }

    // FFmpeg's own `speed=` counts from process start, so the encoder's start
    // is in every reading of a 5.5 s rung; the pace between two fresh
    // progress reports is not.
    let pace_end = match (&media_clock, pace_start) {
        (Some(clock), Some(_)) => next_media_tick(state, clock).await,
        _ => None,
    };
    if let (Some((started, start_micros)), Some((ended, end_micros))) = (pace_start, pace_end)
        && let Some(pace) = encoder_media_pace(ended - started, start_micros, end_micros)
    {
        measurement.encoder_speed = Some(pace);
    }

    // The time FFmpeg needs to flush after `q` is a first-class signal: a
    // below-realtime encoder holds seconds of backlog, which is exactly what
    // cost the UHD 600 tester every recording.
    let stop_started = Instant::now();
    let stopped = crate::recording::stop_recording(state.clone()).await;
    measurement.drain_after_stop_ms = Some(stop_started.elapsed().as_millis() as u64);
    measurement.finalized_cleanly =
        matches!(&stopped, Ok(status) if matches!(status.state, RecordingState::Idle));

    measurement.stalled_frames = stalled_frames(&stats).saturating_sub(stalled_frames(&baseline));
    measurement.queue_oldest_frame_age_ms =
        stats.encoder_bridge_output_queue_oldest_frame_age_high_water_ms;
    measurement.writer_active_p95_ms = stats
        .encoder_bridge_recording_writer_active_p95_ms
        .or(stats.encoder_bridge_writer_active_p95_ms);
    measurement.tick_gap_p95_ms = stats.compositor_tick_gap_p95_ms;
    measurement.fifo_write_p95_ms = stats
        .encoder_bridge_raw_video_fifo_write_p95_ms
        .or(stats.encoder_bridge_encoded_fifo_write_p95_ms);
    // Calibration aid: logs every populated timing/drop signal for the rung so
    // a new machine class can be added to performance-check-calibration.md.
    if std::env::var("VIDEORC_PERFORMANCE_CHECK_DUMP").is_ok()
        && let Ok(serde_json::Value::Object(map)) = serde_json::to_value(&stats)
    {
        let interesting: Vec<String> = map
            .iter()
            .filter(|(key, value)| {
                let key = key.to_ascii_lowercase();
                !value.is_null()
                    && [
                        "skip",
                        "drop",
                        "repeat",
                        "synthetic",
                        "fps",
                        "p95",
                        "queue",
                        "tick",
                    ]
                    .iter()
                    .any(|needle| key.contains(needle))
            })
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        state.emit_log(
            "info",
            format!("Performance check stats: {}", interesting.join(" ")),
        );
    }
    (measurement, Some(stats))
}

fn stalled_frames(stats: &DiagnosticStats) -> u64 {
    stats.encoder_bridge_output_pre_encode_skipped_frames
        + stats.encoder_bridge_dropped_frames
        + stats.encoder_bridge_repeated_frames
}

async fn sleep_unless_cancelled(state: &AppState, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !state.performance_check.cancelled() {
        tokio::time::sleep(CANCEL_POLL.min(deadline - Instant::now())).await;
    }
}

/// Deletes every benchmark row and the media it points at. Only files inside
/// the app-owned benchmark directory are unlinked.
async fn discard_benchmark_sessions(state: &AppState, directory: &Path) {
    let paths = state
        .database
        .take_performance_check_sessions()
        .unwrap_or_default();
    for path in paths.into_iter().map(PathBuf::from) {
        if path.starts_with(directory) {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_user_agent_names_the_desktop_app_version_not_the_crate() {
        assert_eq!(
            desktop_user_agent_for(Some("0.9.146")),
            "Videorc-Desktop/0.9.146"
        );
        assert_eq!(
            desktop_user_agent_for(Some(" 0.9.146 ")),
            "Videorc-Desktop/0.9.146"
        );
        let crate_fallback = format!("Videorc-Desktop/{}", env!("CARGO_PKG_VERSION"));
        assert_eq!(desktop_user_agent_for(None), crate_fallback);
        assert_eq!(desktop_user_agent_for(Some("  ")), crate_fallback);
        assert!(
            reqwest::header::HeaderValue::from_str(&desktop_user_agent_for(Some("0.9.146")))
                .is_ok()
        );
    }

    fn healthy(target_fps: u32) -> RungMeasurement {
        RungMeasurement {
            started: true,
            start_error: None,
            studio_busy: false,
            target_fps,
            encoder_speed: Some(1.0),
            delivered_fps: Some(f64::from(target_fps)),
            stalled_frames: 0,
            queue_oldest_frame_age_ms: Some(50),
            writer_active_p95_ms: Some(6.0),
            tick_gap_p95_ms: Some(34.0),
            fifo_write_p95_ms: Some(3.0),
            drain_after_stop_ms: Some(300),
            finalized_cleanly: true,
        }
    }

    fn rung(video: VideoSettings, verdict: PerformanceCheckRungVerdict) -> PerformanceCheckRung {
        PerformanceCheckRung {
            video,
            verdict,
            encode_backend: None,
            compositor_backend: None,
            encoder_speed: None,
            delivered_fps: None,
            drain_after_stop_ms: None,
            reasons: Vec::new(),
        }
    }

    #[test]
    fn run_params_carry_the_separate_source_recordings_switch() {
        // Plan 200 D4: the renderer sends the switch the next take would use.
        let on: PerformanceCheckRunParams = serde_json::from_value(serde_json::json!({
            "ceilingWidth": 3840, "ceilingHeight": 2160, "ceilingFps": 30,
            "separateSourceRecordings": true
        }))
        .unwrap();
        assert!(on.separate_source_recordings);
        // Older renderers omit it: off, and it is never written when off.
        let off: PerformanceCheckRunParams = serde_json::from_value(serde_json::json!({
            "ceilingWidth": 1920, "ceilingHeight": 1080, "ceilingFps": 30
        }))
        .unwrap();
        assert!(!off.separate_source_recordings);
        assert_eq!(
            serde_json::to_value(&off).unwrap(),
            serde_json::json!({ "ceilingWidth": 1920, "ceilingHeight": 1080, "ceilingFps": 30 })
        );
        assert_eq!(
            serde_json::to_value(&on).unwrap()["separateSourceRecordings"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn a_rung_with_separate_files_passes_only_inside_the_measured_encoder_budget() {
        // Plan 200 D4: encoder fps at a rung = the best single-encode pixel
        // rate passed / the rung's pixels; it must cover fps x load factor.
        let rung = |width, height, fps| VideoSettings {
            preset: VideoPreset::Custom,
            width,
            height,
            fps,
            bitrate_kbps: 8_000,
        };
        let uhd30 = rung(3840, 2160, 30);
        let best_uhd30 = Some(pixel_rate(&uhd30));
        // 4K30 passing alone proves 30 fps at 4K, not the 2.25x a separate-
        // files take needs (plan 158: three 4K30 encodes ran at ~21 fps).
        assert!(separate_files_over_encoder_budget(&uhd30, best_uhd30));
        // The same evidence covers 1080p30: 120 fps of 1080p / 3x = 40 >= 30.
        assert!(!separate_files_over_encoder_budget(
            &rung(1920, 1080, 30),
            best_uhd30
        ));
        // 1440p30: 67.5 fps / 2.5625x = 26.3 < 30.
        assert!(separate_files_over_encoder_budget(
            &rung(2560, 1440, 30),
            best_uhd30
        ));
        // 1080p60: 120 fps / 3x = 40 < 60.
        assert!(separate_files_over_encoder_budget(
            &rung(1920, 1080, 60),
            best_uhd30
        ));
        // No single encode passed: nothing proves the budget.
        assert!(separate_files_over_encoder_budget(
            &rung(1280, 720, 30),
            None
        ));
        assert_eq!(
            SEPARATE_FILES_OVER_BUDGET,
            "separate-files-over-encoder-budget"
        );
    }

    #[test]
    fn the_encoder_budget_counts_every_encoder_a_take_runs() {
        let rung = |width, height, fps| VideoSettings {
            preset: VideoPreset::Custom,
            width,
            height,
            fps,
            bitrate_kbps: 8_000,
        };
        let uhd = rung(3840, 2160, 30);
        let single = encoder_budget(&uhd, false, None, None);
        assert_eq!(single.encoders, 1);
        assert_eq!(single.pixels_per_second, 3840 * 2160 * 30);
        // Combined + Screen at 4K, Camera at its own 1080p (plan 200 D2).
        let separate = encoder_budget(&uhd, true, None, None);
        assert_eq!(separate.encoders, 3);
        assert_eq!(
            separate.pixels_per_second,
            2 * 3840 * 2160 * 30 + 1920 * 1080 * 30
        );
        assert!((separate.load_factor(&uhd) - 2.25).abs() < 1e-9);
        // A camera larger than the canvas is capped at it: three full encodes.
        let fhd = rung(1920, 1080, 60);
        let capped = encoder_budget(&fhd, true, Some((3840, 2160)), None);
        assert!((capped.load_factor(&fhd) - 3.0).abs() < 1e-9);
        // A dedicated stream encoder adds its own leg.
        let stream = rung(1280, 720, 30);
        let live = encoder_budget(&fhd, true, Some((1280, 720)), Some(&stream));
        assert_eq!(live.encoders, 4);
        assert_eq!(
            live.pixels_per_second,
            2 * 1920 * 1080 * 60 + 1280 * 720 * 60 + 1280 * 720 * 30
        );
    }

    #[test]
    fn a_busy_studio_refusal_is_not_a_machine_verdict() {
        // ogre 2026-09-30 support log, verbatim start errors.
        assert!(start_error_means_busy_studio(
            "A capture session is starting"
        ));
        assert!(start_error_means_busy_studio(
            "A capture session is active or finalizing"
        ));
        assert!(start_error_means_busy_studio(
            "A capture session is already running"
        ));
        assert!(!start_error_means_busy_studio("start timed out"));
        assert!(!start_error_means_busy_studio(
            "FFmpeg is unavailable: No such file or directory"
        ));
    }

    #[test]
    fn healthy_rung_passes_and_each_signal_fails_alone() {
        assert!(score_rung(&healthy(30)).is_empty());

        type Breaks = Box<dyn Fn(&mut RungMeasurement)>;
        let cases: Vec<(&str, Breaks)> = vec![
            (
                "encoder-below-realtime",
                Box::new(|m| m.encoder_speed = Some(0.9)),
            ),
            (
                "encoder-speed-unmeasured",
                Box::new(|m| m.encoder_speed = None),
            ),
            (
                "frame-rate-below-target",
                Box::new(|m| m.delivered_fps = Some(27.0)),
            ),
            (
                "frames-skipped-or-repeated",
                Box::new(|m| m.stalled_frames = 10),
            ),
            (
                "encoder-queue-backlog",
                Box::new(|m| m.queue_oldest_frame_age_ms = Some(900)),
            ),
            (
                "encoder-input-no-headroom",
                Box::new(|m| m.writer_active_p95_ms = Some(25.0)),
            ),
            (
                "compositor-cadence-unsteady",
                Box::new(|m| m.tick_gap_p95_ms = Some(80.0)),
            ),
            (
                "encoder-pipe-backpressure",
                Box::new(|m| m.fifo_write_p95_ms = Some(40.0)),
            ),
            (
                "slow-drain-after-stop",
                Box::new(|m| m.drain_after_stop_ms = Some(3_000)),
            ),
            (
                "did-not-finalize",
                Box::new(|m| m.finalized_cleanly = false),
            ),
        ];
        for (expected, mutate) in cases {
            let mut measurement = healthy(30);
            mutate(&mut measurement);
            assert_eq!(score_rung(&measurement), vec![expected.to_string()]);
        }
    }

    #[test]
    fn uhd_600_bundle_shape_fails_loudly_and_fast_skips() {
        // Numbers from support bundle 20260920-160103Z at 2560x1440@30.
        let measurement = RungMeasurement {
            encoder_speed: Some(0.277),
            delivered_fps: Some(2.5),
            stalled_frames: 343,
            queue_oldest_frame_age_ms: Some(12_000),
            fifo_write_p95_ms: Some(9_700.0),
            drain_after_stop_ms: Some(12_000),
            finalized_cleanly: false,
            ..healthy(30)
        };
        let reasons = score_rung(&measurement);
        for expected in [
            "encoder-below-realtime",
            "frame-rate-below-target",
            "frames-skipped-or-repeated",
            "encoder-queue-backlog",
            "encoder-pipe-backpressure",
            "slow-drain-after-stop",
            "did-not-finalize",
        ] {
            assert!(
                reasons.iter().any(|reason| reason == expected),
                "{expected}"
            );
        }
        assert!(should_fast_skip_next_on(&measurement, false));
        assert!(!should_fast_skip_next_on(&measurement, true));
        assert!(!should_fast_skip_next_on(&healthy(30), false));
    }

    #[test]
    fn linux_never_fast_skips_a_soft_fail() {
        let soft = RungMeasurement {
            encoder_speed: Some(0.4),
            ..healthy(30)
        };
        assert!(should_fast_skip_next_on(&soft, false));
        assert!(!should_fast_skip_next_on(&soft, true));
    }

    #[test]
    fn a_realtime_encoder_with_a_slow_start_passes_on_its_pace() {
        // Omarchy 2026-10-26, VAAPI 720p30: cumulative 0.94 after 5.5 s with a
        // ~0.33 s start; between two reports 4 s apart it made 4 s of media.
        let pace = encoder_media_pace(Duration::from_millis(4_000), 1_170_000, 5_170_000).unwrap();
        assert!((pace - 1.0).abs() < 1e-9);
        let measurement = RungMeasurement {
            encoder_speed: Some(pace),
            ..healthy(30)
        };
        assert!(
            score_rung_for_backend(&measurement, Some(EncodeBackend::HardwareVaapi)).is_empty()
        );
        // Report timing within one poll moves the pace by well under the margin.
        let late = encoder_media_pace(Duration::from_millis(4_020), 1_170_000, 5_170_000).unwrap();
        assert!(late >= MIN_ENCODER_SPEED, "{late}");
    }

    #[test]
    fn a_slow_or_stalled_encoder_fails_on_its_pace() {
        let slow = encoder_media_pace(Duration::from_secs(4), 1_000_000, 4_600_000).unwrap();
        assert!((slow - 0.9).abs() < 1e-9);
        let stalled = encoder_media_pace(Duration::from_secs(4), 2_000_000, 2_000_000).unwrap();
        assert_eq!(stalled, 0.0);
        for pace in [slow, stalled] {
            let measurement = RungMeasurement {
                encoder_speed: Some(pace),
                ..healthy(30)
            };
            assert_eq!(
                score_rung_for_backend(&measurement, Some(EncodeBackend::HardwareVaapi)),
                vec!["encoder-below-realtime".to_string()]
            );
        }
    }

    #[test]
    fn a_short_or_clockless_window_keeps_the_cumulative_speed() {
        assert_eq!(
            encoder_media_pace(Duration::from_millis(1_900), 1_000_000, 2_900_000),
            None
        );
        assert_eq!(
            encoder_media_pace(Duration::from_secs(4), 0, 4_000_000),
            None
        );
    }

    #[test]
    fn openh264_ogre_speed_does_not_fail_a_healthy_720p_rung() {
        // Omarchy 2026-09-28: OpenH264 synthetic speed ≈ 0.08 at 720p30 while
        // acceptance Record→file at 1080p already passed on the same box.
        let measurement = RungMeasurement {
            encoder_speed: Some(0.08),
            delivered_fps: Some(2.4),
            stalled_frames: 20,
            ..healthy(30)
        };
        assert!(
            score_rung_for_backend(&measurement, Some(EncodeBackend::SoftwareOpenH264)).is_empty()
        );
        assert_eq!(
            score_rung_for_backend(&measurement, Some(EncodeBackend::HardwareVaapi)),
            vec![
                "encoder-below-realtime".to_string(),
                "frame-rate-below-target".to_string(),
                "frames-skipped-or-repeated".to_string(),
            ]
        );
        assert_eq!(
            score_rung(&measurement),
            vec![
                "encoder-below-realtime".to_string(),
                "frame-rate-below-target".to_string(),
                "frames-skipped-or-repeated".to_string(),
            ]
        );
    }

    #[test]
    fn openh264_still_fails_the_uhd_600_queue_and_drain_shape() {
        let measurement = RungMeasurement {
            encoder_speed: Some(0.277),
            delivered_fps: Some(2.5),
            stalled_frames: 343,
            queue_oldest_frame_age_ms: Some(12_000),
            fifo_write_p95_ms: Some(9_700.0),
            drain_after_stop_ms: Some(12_000),
            finalized_cleanly: false,
            ..healthy(30)
        };
        let reasons = score_rung_for_backend(&measurement, Some(EncodeBackend::SoftwareOpenH264));
        for expected in [
            "encoder-queue-backlog",
            "encoder-pipe-backpressure",
            "slow-drain-after-stop",
            "did-not-finalize",
        ] {
            assert!(
                reasons.iter().any(|reason| reason == expected),
                "{expected} in {reasons:?}"
            );
        }
        for unexpected in [
            "encoder-below-realtime",
            "frame-rate-below-target",
            "frames-skipped-or-repeated",
        ] {
            assert!(
                !reasons.iter().any(|reason| reason == unexpected),
                "{unexpected} in {reasons:?}"
            );
        }
    }

    #[test]
    fn choosing_an_encoder_re_measures_but_the_default_keeps_existing_results() {
        use crate::protocol::WindowsH264EncoderPreference as Preference;
        let identity = "luid=1;pci=8086:3185:00000000:03;d3d11-driver=1";
        let key = |preference| {
            capability_key_from(
                "windows",
                "x86_64",
                &graphics_identity_for_encoder_preference(identity, preference),
                "0.9.126",
                "0.9.0",
            )
        };
        assert_eq!(
            key(Preference::Auto),
            capability_key_from("windows", "x86_64", identity, "0.9.126", "0.9.0")
        );
        assert_ne!(key(Preference::Auto), key(Preference::QuickSync));
        assert_ne!(key(Preference::QuickSync), key(Preference::Software));
    }

    #[test]
    fn capability_key_changes_with_gpu_identity_and_app_version() {
        let a = capability_key_from(
            "linux",
            "x86_64",
            "linux-render-nodes=renderD128=i915",
            "0.9.119",
            "0.9.0",
        );
        let same = capability_key_from(
            "linux",
            "x86_64",
            "linux-render-nodes=renderD128=i915",
            "0.9.119",
            "0.9.0",
        );
        let gpu = capability_key_from(
            "linux",
            "x86_64",
            "linux-render-nodes=renderD129=amdgpu",
            "0.9.119",
            "0.9.0",
        );
        let app = capability_key_from(
            "linux",
            "x86_64",
            "linux-render-nodes=renderD128=i915",
            "0.9.120",
            "0.9.0",
        );
        let crate_version = capability_key_from(
            "linux",
            "x86_64",
            "linux-render-nodes=renderD128=i915",
            "0.9.119",
            "0.9.1",
        );
        assert!(a.starts_with("performance-check-v2:"));
        assert_eq!(a, same);
        assert_ne!(a, gpu);
        assert_ne!(a, app);
        assert_ne!(a, crate_version);
    }

    fn sample_result(
        capability_key: &str,
        below_floor: bool,
        rungs: Vec<PerformanceCheckRung>,
    ) -> PerformanceCheckResult {
        PerformanceCheckResult {
            capability_key: capability_key.to_string(),
            checked_at: "2026-09-28T00:00:00Z".to_string(),
            app_version: "0.9.0".to_string(),
            duration_ms: 1_000,
            recommended: full_ladder().last().cloned().expect("floor"),
            below_floor,
            rungs,
        }
    }

    fn did_not_start(video: VideoSettings) -> PerformanceCheckRung {
        PerformanceCheckRung {
            reasons: vec!["did-not-start".to_string()],
            ..rung(video, PerformanceCheckRungVerdict::Failed)
        }
    }

    #[test]
    fn linux_v1_did_not_start_below_floor_is_poison_v2_is_not() {
        let floor = did_not_start(full_ladder().last().cloned().expect("floor"));
        let v1 = sample_result("performance-check-v1:deadbeef", true, vec![floor.clone()]);
        let v2 = sample_result("performance-check-v2:abc", true, vec![floor.clone()]);
        let passed = sample_result(
            "performance-check-v1:deadbeef",
            false,
            vec![rung(
                full_ladder().last().cloned().expect("floor"),
                PerformanceCheckRungVerdict::Passed,
            )],
        );
        if cfg!(target_os = "linux") {
            assert!(linux_did_not_start_below_floor(&v1));
        } else {
            assert!(!linux_did_not_start_below_floor(&v1));
        }
        assert!(!linux_did_not_start_below_floor(&v2));
        assert!(!linux_did_not_start_below_floor(&passed));
    }

    #[test]
    fn a_session_that_never_started_reports_only_that() {
        let measurement = RungMeasurement {
            started: false,
            ..RungMeasurement::default()
        };
        assert_eq!(score_rung(&measurement), vec!["did-not-start".to_string()]);
        assert!(!should_fast_skip_next(&measurement));
    }

    #[test]
    fn ladder_respects_the_ceiling_and_always_keeps_a_floor() {
        let labels = |rungs: Vec<VideoSettings>| -> Vec<(u32, u32)> {
            rungs.iter().map(|rung| (rung.height, rung.fps)).collect()
        };
        assert_eq!(
            labels(ladder_under_ceiling(3840, 2160, 60)),
            vec![
                (2160, 30),
                (1440, 30),
                (1080, 60),
                (1080, 30),
                (720, 30),
                (540, 30)
            ]
        );
        // The UHD 600 tester: 1440p30 selected on a 1080p display.
        assert_eq!(
            labels(ladder_under_ceiling(2560, 1440, 30)),
            vec![(1440, 30), (1080, 30), (720, 30), (540, 30)]
        );
        assert_eq!(
            labels(ladder_under_ceiling(1920, 1080, 60)),
            vec![(1080, 60), (1080, 30), (720, 30), (540, 30)]
        );
        // Portrait 1080x1920 has the pixel count of 1080p.
        assert_eq!(
            labels(ladder_under_ceiling(1080, 1920, 30)),
            vec![(1080, 30), (720, 30), (540, 30)]
        );
        // The floor is kept even under a smaller ceiling: the check never
        // comes back without a recommendation.
        assert_eq!(labels(ladder_under_ceiling(640, 360, 24)), vec![(540, 30)]);
        // 540p30 is the floor (plan 090 D1): a PC that cannot hold 720p30 in
        // software still gets something it measurably can.
        let floor = full_ladder().pop().expect("floor rung");
        assert_eq!(
            (
                floor.preset,
                floor.width,
                floor.height,
                floor.fps,
                floor.bitrate_kbps
            ),
            (VideoPreset::Tutorial540p30, 960, 540, 30, 2_500)
        );
    }

    #[test]
    fn recommendation_is_the_first_pass_or_a_flagged_floor() {
        let ladder = ladder_under_ceiling(3840, 2160, 30);
        let walked = vec![
            rung(ladder[0].clone(), PerformanceCheckRungVerdict::Failed),
            rung(ladder[1].clone(), PerformanceCheckRungVerdict::Failed),
            rung(ladder[2].clone(), PerformanceCheckRungVerdict::Passed),
        ];
        let (video, below_floor) = recommend(&walked).expect("recommendation");
        assert_eq!(
            (video.width, video.height, below_floor),
            (1920, 1080, false)
        );

        let all_failed: Vec<_> = ladder
            .iter()
            .cloned()
            .map(|video| rung(video, PerformanceCheckRungVerdict::Failed))
            .collect();
        let (video, below_floor) = recommend(&all_failed).expect("floor");
        assert_eq!((video.width, video.height, below_floor), (960, 540, true));
        assert!(recommend(&[]).is_none());

        // 720p30 too heavy, 540p30 holds: a real recommendation, not a flag.
        let held_at_the_floor: Vec<_> = ladder
            .iter()
            .cloned()
            .map(|video| {
                let verdict = if video.height == 540 {
                    PerformanceCheckRungVerdict::Passed
                } else {
                    PerformanceCheckRungVerdict::Failed
                };
                rung(video, verdict)
            })
            .collect();
        let (video, below_floor) = recommend(&held_at_the_floor).expect("floor held");
        assert_eq!((video.width, video.height, below_floor), (960, 540, false));
    }

    #[test]
    fn a_skipped_floor_is_not_reported_as_below_the_machine() {
        let ladder = ladder_under_ceiling(1920, 1080, 30);
        let unfinished = vec![
            rung(ladder[0].clone(), PerformanceCheckRungVerdict::Failed),
            rung(ladder[1].clone(), PerformanceCheckRungVerdict::Skipped),
        ];
        let (video, below_floor) = recommend(&unfinished).expect("floor");
        assert_eq!((video.width, video.height, below_floor), (1280, 720, false));
    }

    #[test]
    fn budget_and_fast_skip_never_drop_the_floor() {
        assert!(!should_skip_rung(false, true, true, true));
        assert!(should_skip_rung(false, true, false, false));
        assert!(should_skip_rung(false, false, true, false));
        assert!(should_skip_rung(true, false, false, true));
        assert!(!should_skip_rung(false, false, false, true));
    }

    #[test]
    fn budget_and_fast_skip_never_drop_720p() {
        // Plan 0013: [1440, 1080, 720, 540] with slow failing top rungs ran
        // out of budget and skipped 720p, then recommended 540p.
        let ladder = ladder_under_ceiling(2560, 1440, 30);
        let floor = ladder.len() - 1;
        let p720 = ladder
            .iter()
            .position(|video| video.width == 1280 && video.height == 720)
            .expect("the ladder measures 720p");
        assert_ne!(p720, floor, "720p is not the floor since the 540p rung");
        assert!(is_protected_rung(&ladder[p720], false));
        assert!(is_protected_rung(&ladder[floor], true));
        assert!(!is_protected_rung(&ladder[0], false));
        for (index, video) in ladder.iter().enumerate() {
            let protected = is_protected_rung(video, index == floor);
            assert_eq!(
                should_skip_rung(false, true, true, protected),
                !protected,
                "{}x{}",
                video.width,
                video.height
            );
        }
    }
}
