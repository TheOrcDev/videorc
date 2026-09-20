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

use crate::protocol::{
    DiagnosticStats, OutputSettings, PerformanceCheckProgress, PerformanceCheckResult,
    PerformanceCheckRunParams, PerformanceCheckRung, PerformanceCheckRungVerdict,
    PerformanceCheckState, RecordingState, RtmpPreset, RtmpSettings, SessionPurpose,
    SourceSelection, StartSessionParams, VideoPreset, VideoSettings,
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

/// What one benchmark session measured. `None` means the pipeline never
/// published that signal, which is itself a failure for the mandatory ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RungMeasurement {
    pub started: bool,
    pub start_error: Option<String>,
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
pub(crate) fn score_rung(measurement: &RungMeasurement) -> Vec<String> {
    let mut reasons = Vec::new();
    if !measurement.started {
        reasons.push("did-not-start".to_string());
        return reasons;
    }
    let frame_budget_ms = 1_000.0 / f64::from(measurement.target_fps.max(1));
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

/// A failing rung this far below realtime also rules out the next one down.
pub(crate) fn should_fast_skip_next(measurement: &RungMeasurement) -> bool {
    measurement.started
        && measurement
            .encoder_speed
            .is_some_and(|speed| speed < FAST_SKIP_ENCODER_SPEED)
}

/// First passing rung wins; with none, the floor is recommended and flagged.
pub(crate) fn recommend(rungs: &[PerformanceCheckRung]) -> Option<(VideoSettings, bool)> {
    if let Some(passed) = rungs
        .iter()
        .find(|rung| rung.verdict == PerformanceCheckRungVerdict::Passed)
    {
        return Some((passed.video.clone(), false));
    }
    rungs.last().map(|floor| (floor.video.clone(), true))
}

const RESULT_SETTING_KEY: &str = "performance_check_result";
const CAPABILITY_KEY_VERSION: &str = "performance-check-v1";
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
const SUPPRESSED_EVENTS: [&str; 5] = [
    "recording.status",
    "recording.finalization",
    "health.event",
    "session.log",
    "diagnostics.stats",
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

/// Names the machine a verdict belongs to. A new GPU, driver or app version
/// makes the stored result stale instead of silently trusting it.
pub(crate) fn capability_key() -> String {
    let mut hasher = Sha256::new();
    hasher.update(CAPABILITY_KEY_VERSION);
    hasher.update(std::env::consts::OS);
    hasher.update(std::env::consts::ARCH);
    hasher.update(crate::recording::graphics_adapter_driver_identity());
    hasher.update(env!("CARGO_PKG_VERSION"));
    format!("{CAPABILITY_KEY_VERSION}:{:x}", hasher.finalize())
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
    let stale = result
        .as_ref()
        .is_some_and(|result| result.capability_key != capability_key());
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
    for (index, video) in ladder.into_iter().enumerate() {
        if state.performance_check.cancelled() {
            discard_benchmark_sessions(state, &directory).await;
            bail!("cancelled");
        }
        let is_floor = index as u32 + 1 == rung_count;
        if passed || (skip_next && !is_floor) || started.elapsed() > TOTAL_BUDGET {
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
        let mut reasons = score_rung(&measurement);
        if forced_failure_above_height().is_some_and(|height| video.height > height) {
            reasons.push("forced-by-test-seam".to_string());
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
        rungs.push(PerformanceCheckRung {
            video,
            verdict: if passed {
                PerformanceCheckRungVerdict::Passed
            } else {
                PerformanceCheckRungVerdict::Failed
            },
            encode_backend: stats.as_ref().and_then(|stats| stats.encode_backend),
            compositor_backend: stats.as_ref().and_then(|stats| stats.compositor_backend),
            encoder_speed: measurement.encoder_speed,
            delivered_fps: measurement.delivered_fps,
            drain_after_stop_ms: measurement.drain_after_stop_ms,
            reasons,
        });
    }

    let Some((recommended, below_floor)) = recommend(&rungs) else {
        bail!("the ladder produced no rungs");
    };
    let result = PerformanceCheckResult {
        capability_key: capability_key(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
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
            measurement.start_error = Some(format!("{error:#}"));
            return (measurement, None);
        }
        Err(_) => {
            measurement.start_error = Some("start timed out".to_string());
            let _ = crate::recording::stop_recording(state.clone()).await;
            return (measurement, None);
        }
    }

    sleep_unless_cancelled(state, RUNG_WARMUP).await;
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

    fn healthy(target_fps: u32) -> RungMeasurement {
        RungMeasurement {
            started: true,
            start_error: None,
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
    fn healthy_rung_passes_and_each_signal_fails_alone() {
        assert!(score_rung(&healthy(30)).is_empty());

        let cases: Vec<(&str, Box<dyn Fn(&mut RungMeasurement)>)> = vec![
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
        assert!(should_fast_skip_next(&measurement));
        assert!(!should_fast_skip_next(&healthy(30)));
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
            vec![(2160, 30), (1440, 30), (1080, 60), (1080, 30), (720, 30)]
        );
        // The UHD 600 tester: 1440p30 selected on a 1080p display.
        assert_eq!(
            labels(ladder_under_ceiling(2560, 1440, 30)),
            vec![(1440, 30), (1080, 30), (720, 30)]
        );
        assert_eq!(
            labels(ladder_under_ceiling(1920, 1080, 60)),
            vec![(1080, 60), (1080, 30), (720, 30)]
        );
        // Portrait 1080x1920 has the pixel count of 1080p.
        assert_eq!(
            labels(ladder_under_ceiling(1080, 1920, 30)),
            vec![(1080, 30), (720, 30)]
        );
        assert_eq!(labels(ladder_under_ceiling(640, 360, 24)), vec![(720, 30)]);
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
        assert_eq!((video.width, video.height, below_floor), (1280, 720, true));
        assert!(recommend(&[]).is_none());
    }
}
