#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Write as StdWrite};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Condvar, Mutex as StdMutex, OnceLock};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, oneshot, watch};
use tokio::task::JoinHandle as TokioJoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::compositor::{CompositorFrameExportHandle, CompositorFrameStore, CompositorPixelFormat};
use crate::compositor_synthetic::{SyntheticCompositorFrame, SyntheticMovingSource};
use crate::diagnostics::{
    EncoderBridgeDiagnosticSnapshot, apply_encoder_bridge_stats,
    apply_runtime_diagnostics_snapshot, starting_diagnostics,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::frame_store::FrameHandle;
use crate::mpeg_ts::{MpegTsH264Writer, timing_to_90khz};
use crate::process_job::spawn_owned_tokio;
use crate::protocol::{EncoderBridgeSyntheticParams, EncoderBridgeSyntheticResult};
use crate::state::AppState;
#[cfg(target_os = "macos")]
use crate::video_toolbox_encoder::{
    VideoToolboxFrameTiming, VideoToolboxH264AnnexBFrame, VideoToolboxH264AsyncAnnexBFrame,
    VideoToolboxH264Session,
};

const ENCODER_BRIDGE_DIAGNOSTIC_WINDOW: Duration = Duration::from_secs(2);
const ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD: Duration = Duration::from_millis(1);
/// Diagnostics are emitted at most once per two-second window plus terminal
/// events. A capacity-one watch channel keeps only the latest snapshot so a
/// stalled diagnostics consumer cannot retain memory or block the media writer.
const VIDEOTOOLBOX_FRESH_FRAME_HEADROOM: Duration = Duration::from_millis(4);
/// VideoToolbox is configured with one frame of encoder delay and this queue is
/// drained on every bridge tick. Two drain windows absorb callback bursts while
/// keeping encoded access-unit memory bounded. Overflow explicitly fails the
/// affected output because dropping an encoded H.264 access unit can corrupt
/// its dependent reference chain.
const VIDEOTOOLBOX_CALLBACK_OUTPUT_QUEUE_FRAMES: usize =
    VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK * 2;
// Calibrated from the 2026-07-10 real-device baselines. The 4K recording leg
// peaked at depth 4 / 99ms and the companion 1080p stream leg at depth 2 /
// 35ms. These ceilings leave transient headroom without restoring the old
// generic 240-frame (eight-second at 30fps) hidden backlog.
const RECORDING_OUTPUT_QUEUE_MAX_FRAMES: usize = 16;
const RECORDING_OUTPUT_QUEUE_MAX_AGE: Duration = Duration::from_millis(250);
const STREAM_OUTPUT_QUEUE_COALESCE_FRAMES: usize = 4;
const STREAM_OUTPUT_QUEUE_COALESCE_AGE: Duration = Duration::from_millis(100);
const STREAM_OUTPUT_QUEUE_MAX_FRAMES: usize = 8;
const STREAM_OUTPUT_QUEUE_MAX_AGE: Duration = Duration::from_millis(150);
// Raw frames receive wall-clock PTS at FFmpeg demux. Keep no stale waiting
// frames: the writer accepts the latest scheduler frame only when it is ready
// for another complete write; busy ticks are explicitly coalesced and the
// decoder holds the last VFR frame across the wall-time gap.
const RAW_VIDEO_FIFO_QUEUE_MAX_FRAMES: usize = 0;
#[cfg(not(target_os = "windows"))]
const FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = Duration::from_secs(2);
// Media Foundation can stop draining the raw-video pipe for several seconds
// while its MFT catches up. A raw YUV frame is indivisible once writing starts:
// timing it out truncates a plane, kills FFmpeg, strands the recovery MKV, and
// loses the remainder of the user's recording. Keep a bounded shutdown escape
// hatch, but give a progressing Windows recording enough time to recover.
#[cfg(target_os = "windows")]
const RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(target_os = "windows"))]
const RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = FIFO_FRAME_WRITE_HARD_TIMEOUT;
const RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT: Duration = Duration::from_millis(2500);
const FIFO_WRITE_PROGRESS_YIELD_BUDGET: u32 = 64;
const FIFO_WRITE_STALL_BACKOFF: Duration = Duration::from_micros(250);
const VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK: usize = 8;
const VIDEOTOOLBOX_PROBE_ENV: &str = "VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE";

type CompositorFrameHandle = FrameHandle<CompositorPixelFormat, CompositorFrameExportHandle>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBridgeVideoOutput {
    RawYuv420p,
    VideoToolboxH264AnnexB,
    VideoToolboxH264MpegTs,
}

impl EncoderBridgeVideoOutput {
    const fn uses_video_toolbox(self) -> bool {
        matches!(
            self,
            Self::VideoToolboxH264AnnexB | Self::VideoToolboxH264MpegTs
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBridgeOutputRole {
    Shared,
    Recording,
    Stream,
}

/// Production admission decision made before a compositor frame enters
/// VideoToolbox. Encoded H.264 access units are never dropped because doing so
/// can break their dependent reference chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncoderBridgePreEncodeAdmission {
    Submit,
    /// Streaming prioritizes bounded live latency. The compositor store is
    /// itself latest-wins, so skipping this submission coalesces superseded
    /// work and the next admitted tick reads the newest available frame.
    CoalesceLatestStreamFrame,
    /// Recording/shared output fails before a long hidden backlog. Streaming
    /// also fails at its hard ceiling because dropping already-encoded access
    /// units would corrupt the stream until the next independently decodable
    /// frame.
    FailOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EncoderBridgeOutputQueuePolicy {
    role: EncoderBridgeOutputRole,
    coalesce_at_frames: Option<usize>,
    coalesce_at_age: Option<Duration>,
    max_frames: usize,
    max_age: Duration,
}

fn effective_encoder_bridge_output_role(
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeOutputRole {
    if diagnostics_context.role == EncoderBridgeOutputRole::Shared
        && diagnostics_context.recording_output.is_none()
        && diagnostics_context.stream_output.is_some()
    {
        EncoderBridgeOutputRole::Stream
    } else {
        diagnostics_context.role
    }
}

fn encoder_bridge_output_queue_policy(
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeOutputQueuePolicy {
    let role = effective_encoder_bridge_output_role(diagnostics_context);
    match role {
        EncoderBridgeOutputRole::Stream => EncoderBridgeOutputQueuePolicy {
            role,
            coalesce_at_frames: Some(STREAM_OUTPUT_QUEUE_COALESCE_FRAMES),
            coalesce_at_age: Some(STREAM_OUTPUT_QUEUE_COALESCE_AGE),
            max_frames: STREAM_OUTPUT_QUEUE_MAX_FRAMES,
            max_age: STREAM_OUTPUT_QUEUE_MAX_AGE,
        },
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared => {
            EncoderBridgeOutputQueuePolicy {
                role,
                coalesce_at_frames: None,
                coalesce_at_age: None,
                max_frames: RECORDING_OUTPUT_QUEUE_MAX_FRAMES,
                max_age: RECORDING_OUTPUT_QUEUE_MAX_AGE,
            }
        }
    }
}

fn encoder_bridge_pre_encode_admission(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    oldest_frame_age: Option<Duration>,
) -> EncoderBridgePreEncodeAdmission {
    if queue_depth >= policy.max_frames as u64
        || oldest_frame_age.is_some_and(|age| age >= policy.max_age)
    {
        return EncoderBridgePreEncodeAdmission::FailOutput;
    }
    if policy.role == EncoderBridgeOutputRole::Stream
        && (policy
            .coalesce_at_frames
            .is_some_and(|depth| queue_depth >= depth as u64)
            || policy
                .coalesce_at_age
                .is_some_and(|limit| oldest_frame_age.is_some_and(|age| age >= limit)))
    {
        return EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame;
    }
    EncoderBridgePreEncodeAdmission::Submit
}

fn encoder_bridge_output_pressure_error(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    oldest_frame_age: Option<Duration>,
) -> io::Error {
    let age_ms = oldest_frame_age.map(|age| age.as_millis()).unwrap_or(0);
    let role = encoder_bridge_output_role_label(policy.role);
    let integrity = if policy.role == EncoderBridgeOutputRole::Stream {
        "encoded H.264 access units were preserved; the stream stopped instead of corrupting its reference chain"
    } else {
        "recording frames were preserved; the output stopped instead of silently dropping or buffering them"
    };
    io::Error::other(format!(
        "{role} encoder output exceeded its bounded latency contract (depth {queue_depth}/{}, oldest {age_ms}/{}ms); {integrity}",
        policy.max_frames,
        policy.max_age.as_millis(),
    ))
}

const fn encoder_bridge_output_role_label(role: EncoderBridgeOutputRole) -> &'static str {
    match role {
        EncoderBridgeOutputRole::Recording => "recording",
        EncoderBridgeOutputRole::Stream => "stream",
        EncoderBridgeOutputRole::Shared => "shared recording/stream",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderBridgeOutputProfile {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderBridgeDiagnosticsContext {
    pub role: EncoderBridgeOutputRole,
    pub recording_output: Option<EncoderBridgeOutputProfile>,
    pub stream_output: Option<EncoderBridgeOutputProfile>,
    pub active_video_toolbox_output_encoders: u64,
    pub separate_output_encoders_active: bool,
}

impl EncoderBridgeDiagnosticsContext {
    pub const fn shared() -> Self {
        Self {
            role: EncoderBridgeOutputRole::Shared,
            recording_output: None,
            stream_output: None,
            active_video_toolbox_output_encoders: 0,
            separate_output_encoders_active: false,
        }
    }
}

impl Default for EncoderBridgeDiagnosticsContext {
    fn default() -> Self {
        Self::shared()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EncoderBridgeSettings {
    ffmpeg_path: String,
    output_path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    duration_ms: u64,
    bitrate_kbps: u32,
}

#[derive(Debug, Default, Clone)]
struct EncoderBridgeProgress {
    encoded_fps: Option<f64>,
    encoder_speed: Option<f64>,
    dropped_frames: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct EncoderBridgeRuntimeStats {
    queue_depth: u64,
    /// Age of the oldest frame awaiting VideoToolbox completion or FIFO write.
    output_queue_oldest_frame_age_ms: Option<u64>,
    /// Number of ticks where a role-specific soft or hard output limit applied.
    output_queue_capacity_pressure_events: u64,
    /// Frames coalesced before encoding by the stream latest-wins policy.
    /// Recording/shared output must always remain zero.
    output_queue_dropped_frames: u64,
    input_fps: Option<f64>,
    dropped_frames: u64,
    encoder_speed: Option<f64>,
    /// Compositor frames re-fed to the encoder because no newer frame was ready by the
    /// CFR deadline — these become duplicate frames in the final file (the classic
    /// "frozen capture, ffmpeg duplicates the last frame" failure, now counted).
    repeated_fed_frames: u64,
    /// Number of distinct runs where the bridge re-fed one or more duplicate frames.
    repeated_frame_bursts: u64,
    /// Longest consecutive duplicate re-feed run observed by the bridge.
    max_repeated_frame_run: u64,
    /// Ticks where no usable compositor frame existed and synthetic filler was fed.
    synthetic_fallback_frames: u64,
    /// Max age (ms) of a compositor frame at the moment it was fed to the encoder.
    source_to_encode_age_ms: Option<u64>,
    /// P95 age (ms) of compositor frames at the moment they were fed to the encoder.
    source_to_encode_age_p95_ms: Option<f64>,
    /// P95 age (ms) of compositor frames that were re-fed as duplicate bridge frames.
    repeated_frame_age_p95_ms: Option<f64>,
    /// Max age (ms) of a compositor frame that was re-fed as a duplicate bridge frame.
    repeated_frame_age_max_ms: Option<u64>,
    /// Ticks where the bridge still copied YUV into FFmpeg, but the compositor frame also
    /// exposed an IOSurface-backed Metal target that a future VideoToolbox path can adopt.
    metal_target_frames: u64,
    /// Frames written through the raw-video FFmpeg bridge. Today this is the recording
    /// export hot path; zero-copy VideoToolbox export should drive it to zero.
    raw_video_copied_frames: u64,
    /// Raw-video FFmpeg writes whose source frame also exposed a Metal IOSurface target.
    metal_target_copied_frames: u64,
    /// Raw-video FFmpeg writes whose source frame carried the retained CoreVideo handle.
    metal_target_handle_frames: u64,
    /// Frames submitted to the encoder without a CPU raw-video copy.
    zero_copy_frames: u64,
    /// Retained Metal target frames encoded by the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_frames: u64,
    /// Encoded bytes copied from the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_bytes: u64,
    /// Failed attempts by the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_errors: u64,
    /// Retained Metal target frames written through the VideoToolbox H.264 output path.
    video_toolbox_output_frames: u64,
    /// Encoded bytes written through the VideoToolbox H.264 output path.
    video_toolbox_output_bytes: u64,
    /// Max inline VideoToolbox encode latency observed by the bridge writer.
    video_toolbox_output_encode_ms: Option<u64>,
    compositor_wait_p95_ms: Option<f64>,
    video_toolbox_submit_p95_ms: Option<f64>,
    /// P95 time the raw-video FIFO worker spent writing one frame into FFmpeg.
    raw_video_fifo_write_p95_ms: Option<f64>,
    video_toolbox_fifo_write_p95_ms: Option<f64>,
    video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    writer_loop_p95_ms: Option<f64>,
    writer_sleep_p95_ms: Option<f64>,
    writer_active_p95_ms: Option<f64>,
    deadline_lag_p95_ms: Option<f64>,
    deadline_lag_max_ms: Option<f64>,
    late_deadline_ticks: u64,
    schedule_skipped_ms: u64,
}

/// A compositor frame fed into the encoder FIFO on one tick.
#[derive(Clone)]
struct FedCompositorFrame {
    /// Retains the compositor's immutable allocation through FIFO delivery. Raw
    /// output writes these bytes directly instead of copying them into a second
    /// full-frame bridge buffer.
    frame: CompositorFrameHandle,
    sequence: u64,
    captured_at: Instant,
    age_ms: u64,
    has_metal_iosurface_target: bool,
    has_metal_export_handle: bool,
    #[cfg(target_os = "macos")]
    metal_target: Option<Arc<crate::metal_compositor::MetalCompositorTargetPixelBuffer>>,
}

/// How one encoder-bridge tick consumed a compositor frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeFrameSource {
    /// A fresh compositor frame whose sequence advanced past the last fed one.
    Fresh,
    /// The same compositor frame as the previous tick — re-encoded as a CFR duplicate.
    Repeated,
    /// No usable compositor frame; synthetic filler was fed.
    SyntheticFallback,
}

/// Classify a tick from the sequence of the frame it fed versus the last fed sequence.
/// A repeat means the compositor did not publish a new frame before the encoder's CFR
/// deadline, so the previous frame's bytes are encoded again as a duplicate.
fn classify_bridge_frame(last_fed: Option<u64>, fed: Option<u64>) -> BridgeFrameSource {
    match fed {
        None => BridgeFrameSource::SyntheticFallback,
        Some(sequence) => match last_fed {
            Some(previous) if previous == sequence => BridgeFrameSource::Repeated,
            _ => BridgeFrameSource::Fresh,
        },
    }
}

/// Lag past which the schedule stops trying to catch up frame-by-frame and
/// re-anchors with an explicit counted wall-time gap (app nap, display sleep).
/// Raw FIFO frames are demuxed with wall-clock PTS, so they can use the same
/// honest re-anchor as timestamped encoded outputs.
const ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD: Duration = Duration::from_secs(2);

/// Per-tick schedule decision (plan 026). The writer schedule is ABSOLUTE
/// (`next_frame_at += interval`); wall time is never silently dropped. The old
/// re-anchor (`next_frame_at = now + interval` whenever a tick overran) deleted
/// the overshoot from the video timeline every iteration — the encoder emitted
/// fewer than fps frames per wall second while stamping exact-CFR PTS, so video
/// ran fast and audio drifted late (~0.6-0.8s/min on macOS; ~8% timeline
/// compression on the first real Windows artifact, 2026-07-09).
#[derive(Debug, PartialEq, Eq)]
struct BridgeTickPlan {
    /// The loop is at/past its deadline: skip the fresh-frame wait and feed the
    /// latest available frame immediately (a repeat if unchanged) so the
    /// schedule converges instead of compressing.
    skip_fresh_wait: bool,
    /// Whole intervals dropped from the schedule as an explicit stall gap.
    /// Zero in every healthy tick.
    reanchor_skipped_intervals: u64,
}

fn plan_bridge_tick(lag: Duration, frame_interval: Duration) -> BridgeTickPlan {
    if frame_interval.is_zero() {
        return BridgeTickPlan {
            skip_fresh_wait: false,
            reanchor_skipped_intervals: 0,
        };
    }
    if lag >= ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD {
        let skipped = (lag.as_nanos() / frame_interval.as_nanos()) as u64;
        return BridgeTickPlan {
            skip_fresh_wait: true,
            reanchor_skipped_intervals: skipped,
        };
    }
    BridgeTickPlan {
        skip_fresh_wait: lag > Duration::ZERO,
        reanchor_skipped_intervals: 0,
    }
}

fn compositor_frame_wait_budget(
    video_output: EncoderBridgeVideoOutput,
    consecutive_repeated_frames: u64,
    frame_interval: Duration,
) -> Duration {
    if video_output.uses_video_toolbox() {
        // Wait for a fresh compositor target, but never spend the whole CFR interval.
        // VideoToolbox encoding and FIFO writes must keep a little headroom or the bridge
        // falls behind real time and starts feeding visible duplicates.
        return videotoolbox_fresh_frame_grace(frame_interval);
    }
    if consecutive_repeated_frames > 0 {
        frame_interval + frame_interval
    } else {
        frame_interval
    }
}

fn videotoolbox_fresh_frame_grace(frame_interval: Duration) -> Duration {
    frame_interval.saturating_sub(VIDEOTOOLBOX_FRESH_FRAME_HEADROOM)
}

fn record_encoder_bridge_terminal_failure(
    signal: &Arc<StdMutex<Option<String>>>,
    message: impl Into<String>,
) -> String {
    let mut failure = signal
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    failure.get_or_insert_with(|| message.into()).clone()
}

fn read_encoder_bridge_terminal_failure(signal: &Arc<StdMutex<Option<String>>>) -> Option<String> {
    signal
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn signal_encoder_bridge_startup(
    sender: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    result: std::result::Result<(), String>,
) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}

#[derive(Debug)]
pub struct EncoderBridgeRecordingSession {
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    startup_ready: Option<oneshot::Receiver<std::result::Result<(), String>>>,
    fifo_path: PathBuf,
    writer: Option<thread::JoinHandle<()>>,
    diagnostics_task: Option<TokioJoinHandle<()>>,
}

impl EncoderBridgeRecordingSession {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Returns the first terminal media-path failure reported by the bridge.
    ///
    /// FFmpeg can exit successfully after the bridge closes its FIFO at a
    /// complete raw-video frame boundary. Recording finalization must inspect
    /// this signal so that a shortened file is not published as successful.
    pub fn terminal_failure(&self) -> Option<String> {
        read_encoder_bridge_terminal_failure(&self.terminal_failure)
    }

    pub async fn wait_until_ready(&mut self) -> Result<()> {
        let Some(startup_ready) = self.startup_ready.take() else {
            return Ok(());
        };
        match tokio::time::timeout(Duration::from_secs(4), startup_ready).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(message))) => bail!(message),
            Ok(Err(_)) => bail!("Encoder bridge stopped before its first frame was ready"),
            Err(_) => bail!("Encoder bridge first-frame priming timed out"),
        }
    }
}

impl Drop for EncoderBridgeRecordingSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.writer.take();
        if let Some(task) = self.diagnostics_task.take() {
            task.abort();
        }
        let _ = crate::fifo::cleanup(&self.fifo_path);
    }
}

pub async fn run_synthetic_encoder_bridge(
    state: AppState,
    params: EncoderBridgeSyntheticParams,
) -> Result<EncoderBridgeSyntheticResult> {
    let settings = EncoderBridgeSettings::from_params(params)?;
    if let Some(parent) = settings.output_path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }

    let session_id = format!("encoder-bridge-{}", Uuid::new_v4());
    let _capture_permit = state.ffmpeg_work.begin_capture_when_available().await;
    emit_encoder_bridge_diagnostics(
        &state,
        &session_id,
        settings.fps,
        EncoderBridgeRuntimeStats {
            queue_depth: 0,
            input_fps: None,
            dropped_frames: 0,
            encoder_speed: None,
            ..Default::default()
        },
        EncoderBridgeDiagnosticsContext::default(),
        None,
    )
    .await;

    let progress = Arc::new(Mutex::new(EncoderBridgeProgress::default()));
    let mut command = Command::new(&settings.ffmpeg_path);
    command
        .args(encoder_bridge_ffmpeg_args(&settings))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_tokio(&mut command)
        .with_context(|| format!("Could not start {}", settings.ffmpeg_path))?;

    let mut stdin = child
        .stdin
        .take()
        .context("FFmpeg encoder bridge stdin was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("FFmpeg encoder bridge stderr was unavailable")?;
    let progress_task = tokio::spawn(read_encoder_progress(stderr, progress.clone()));

    let write_started_at = Instant::now();
    let mut window_started_at = Instant::now();
    let mut frames_in_window = 0_u64;
    let mut frames_written = 0_u64;
    let dropped_frames = 0_u64;
    let mut queue_depth = 0_u64;
    let mut max_queue_depth = 0_u64;
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(settings.fps));
    let frame_count = frame_count(settings.duration_ms, settings.fps);
    let source = SyntheticMovingSource;
    let mut bytes = vec![0; raw_rgba_len(settings.width, settings.height)?];
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    for sequence in 1..=frame_count {
        ticker.tick().await;
        let frame = source.render(sequence, settings.width, settings.height);
        render_synthetic_rgba_frame(&frame, &mut bytes);

        queue_depth = 1;
        max_queue_depth = max_queue_depth.max(queue_depth);
        stdin
            .write_all(&bytes)
            .await
            .context("Could not write compositor frame into FFmpeg")?;
        queue_depth = 0;
        frames_written = frames_written.saturating_add(1);
        frames_in_window = frames_in_window.saturating_add(1);

        if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
            let input_fps = Some(
                frames_in_window as f64 / window_started_at.elapsed().as_secs_f64().max(0.001),
            );
            let encoder_progress = progress.lock().await.clone();
            emit_encoder_bridge_diagnostics(
                &state,
                &session_id,
                settings.fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    input_fps,
                    dropped_frames: dropped_frames.saturating_add(encoder_progress.dropped_frames),
                    encoder_speed: encoder_progress.encoder_speed,
                    raw_video_copied_frames: frames_written,
                    ..Default::default()
                },
                EncoderBridgeDiagnosticsContext::default(),
                encoder_progress.last_error,
            )
            .await;
            window_started_at = Instant::now();
            frames_in_window = 0;
        }
    }

    stdin
        .shutdown()
        .await
        .context("Could not close FFmpeg encoder bridge stdin")?;
    drop(stdin);

    let status = child
        .wait()
        .await
        .context("Could not wait for encoder bridge FFmpeg")?;
    let final_progress = progress_task
        .await
        .context("Could not join encoder progress reader")?;
    if !status.success() {
        let error = final_progress
            .last_error
            .unwrap_or_else(|| format!("FFmpeg exited with {status}"));
        emit_encoder_bridge_diagnostics(
            &state,
            &session_id,
            settings.fps,
            EncoderBridgeRuntimeStats {
                queue_depth,
                input_fps: measured_input_fps(frames_written, write_started_at),
                dropped_frames: dropped_frames.saturating_add(final_progress.dropped_frames),
                encoder_speed: final_progress.encoder_speed,
                raw_video_copied_frames: frames_written,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            Some(error.clone()),
        )
        .await;
        bail!("{error}");
    }

    let input_fps = measured_input_fps(frames_written, write_started_at);
    let dropped_frames = dropped_frames.saturating_add(final_progress.dropped_frames);
    emit_encoder_bridge_diagnostics(
        &state,
        &session_id,
        settings.fps,
        EncoderBridgeRuntimeStats {
            queue_depth,
            input_fps,
            dropped_frames,
            encoder_speed: final_progress.encoder_speed,
            raw_video_copied_frames: frames_written,
            ..Default::default()
        },
        EncoderBridgeDiagnosticsContext::default(),
        final_progress.last_error,
    )
    .await;

    let file_bytes = tokio::fs::metadata(&settings.output_path)
        .await
        .with_context(|| format!("Could not inspect {}", settings.output_path.display()))?
        .len();

    Ok(EncoderBridgeSyntheticResult {
        output_path: settings.output_path.display().to_string(),
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        duration_ms: settings.duration_ms,
        frames_written,
        queue_depth_max: max_queue_depth,
        input_fps,
        dropped_frames,
        encoder_speed: final_progress.encoder_speed,
        file_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn start_synthetic_recording_bridge(
    state: AppState,
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    fifo_path: PathBuf,
    frame_store: Option<CompositorFrameStore>,
    video_output: EncoderBridgeVideoOutput,
    bitrate_kbps: Option<u32>,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    // Set once at the bridge's first delivered frame: the shared session epoch the
    // audio FIFO writer aligns to (Studio Shell And Live Control Plan, slice A2).
    video_epoch: Arc<OnceLock<Instant>>,
) -> Result<EncoderBridgeRecordingSession> {
    let byte_len = raw_yuv420p_len(width, height)?;
    let stop = Arc::new(AtomicBool::new(false));
    let terminal_failure = Arc::new(StdMutex::new(None));
    let (startup_ready_tx, startup_ready_rx) = oneshot::channel();
    let writer_stop = stop.clone();
    let writer_terminal_failure = terminal_failure.clone();
    let writer_fifo_path = fifo_path.clone();
    let (diagnostics_tx, mut diagnostics_rx) =
        watch::channel::<Option<EncoderBridgeWriterEvent>>(None);
    let diagnostics_state = state.clone();
    let diagnostics_task = tokio::spawn(async move {
        while diagnostics_rx.changed().await.is_ok() {
            let Some(event) = diagnostics_rx.borrow_and_update().clone() else {
                continue;
            };
            emit_encoder_bridge_diagnostics(
                &diagnostics_state,
                &event.session_id,
                event.target_fps,
                event.stats,
                event.diagnostics_context,
                event.error,
            )
            .await;
        }
    });
    let writer = thread::Builder::new()
        .name("videorc-recording-encoder-bridge".to_string())
        .spawn(move || {
            let params = SyntheticRecordingWriterParams {
                session_id,
                target_fps: target_fps.max(1),
                width: width.max(1),
                height: height.max(1),
                byte_len,
                fifo_path: writer_fifo_path,
                frame_store,
                video_output,
                bitrate_kbps,
                diagnostics_context,
                stop: writer_stop,
                terminal_failure: writer_terminal_failure,
                startup_ready_tx: Some(startup_ready_tx),
                diagnostics_tx,
                video_epoch,
            };
            write_synthetic_recording_frames(params);
        })
        .context("Could not start recording encoder bridge writer thread")?;

    Ok(EncoderBridgeRecordingSession {
        stop,
        terminal_failure,
        startup_ready: Some(startup_ready_rx),
        fifo_path,
        writer: Some(writer),
        diagnostics_task: Some(diagnostics_task),
    })
}

impl EncoderBridgeSettings {
    fn from_params(params: EncoderBridgeSyntheticParams) -> Result<Self> {
        let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path);
        let output_path = params
            .output_path
            .map(|path| PathBuf::from(path.trim()))
            .filter(|path| !path.as_os_str().is_empty())
            .context("outputPath is required")?;
        let width = params.width.unwrap_or(640);
        let height = params.height.unwrap_or(360);
        let fps = params.fps.unwrap_or(30);
        let duration_ms = params.duration_ms.unwrap_or(2_000);
        let bitrate_kbps = params.bitrate_kbps.unwrap_or(2_000);

        if !(16..=3840).contains(&width) || !(16..=2160).contains(&height) {
            bail!("Encoder bridge resolution must be between 16x16 and 3840x2160");
        }
        if !(1..=120).contains(&fps) {
            bail!("Encoder bridge FPS must be between 1 and 120");
        }
        if !(100..=60_000).contains(&duration_ms) {
            bail!("Encoder bridge duration must be between 100ms and 60000ms");
        }
        if !(100..=50_000).contains(&bitrate_kbps) {
            bail!("Encoder bridge bitrate must be between 100 and 50000 kbps");
        }

        Ok(Self {
            ffmpeg_path,
            output_path,
            width,
            height,
            fps,
            duration_ms,
            bitrate_kbps,
        })
    }
}

fn encoder_bridge_ffmpeg_args(settings: &EncoderBridgeSettings) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-stats".to_string(),
        "-stats_period".to_string(),
        "1".to_string(),
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgba".to_string(),
        "-video_size".to_string(),
        format!("{}x{}", settings.width, settings.height),
        "-framerate".to_string(),
        settings.fps.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
        "-an".to_string(),
        "-vf".to_string(),
        "format=yuv420p".to_string(),
        "-r".to_string(),
        settings.fps.to_string(),
        "-c:v".to_string(),
        "mpeg4".to_string(),
        "-b:v".to_string(),
        format!("{}k", settings.bitrate_kbps),
        "-movflags".to_string(),
        "+faststart".to_string(),
        settings.output_path.display().to_string(),
    ]
}

fn render_synthetic_rgba_frame(frame: &SyntheticCompositorFrame, bytes: &mut [u8]) {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let marker_size = (width.min(height) / 10).clamp(8, 48);
    let marker_x = frame.marker_x as usize;
    let marker_y = frame.marker_y as usize;

    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) * 4;
            let in_marker =
                x.abs_diff(marker_x) < marker_size && y.abs_diff(marker_y) < marker_size;
            if in_marker {
                bytes[index] = 255;
                bytes[index + 1] = 240;
                bytes[index + 2] = 32;
                bytes[index + 3] = 255;
                continue;
            }

            bytes[index] = ((x * 255) / width.max(1)) as u8;
            bytes[index + 1] = ((y * 255) / height.max(1)) as u8;
            bytes[index + 2] = frame.sequence.wrapping_mul(3) as u8;
            bytes[index + 3] = 255;
        }
    }
}

fn render_synthetic_yuv420p_frame(frame: &SyntheticCompositorFrame, bytes: &mut [u8]) {
    let width = frame.width.max(1) as usize;
    let height = frame.height.max(1) as usize;
    let y_len = width * height;
    let uv_width = width.div_ceil(2);
    let uv_height = height.div_ceil(2);
    let u_start = y_len;
    let v_start = y_len + uv_width * uv_height;
    let marker_size = (width.min(height) / 10).clamp(8, 48);
    let marker_x = (frame.marker_x as usize).min(width.saturating_sub(1));
    let marker_y = (frame.marker_y as usize).min(height.saturating_sub(1));
    let marker_left = marker_x.saturating_sub(marker_size);
    let marker_top = marker_y.saturating_sub(marker_size);
    let marker_right = marker_x.saturating_add(marker_size).min(width);
    let marker_bottom = marker_y.saturating_add(marker_size).min(height);

    bytes[..y_len].fill(48_u8.saturating_add((frame.sequence % 96) as u8));
    bytes[u_start..v_start].fill(128);
    bytes[v_start..].fill(128);

    for y in marker_top..marker_bottom {
        let row_start = y * width + marker_left;
        let row_end = y * width + marker_right;
        bytes[row_start..row_end].fill(235);
    }

    let uv_left = marker_left / 2;
    let uv_top = marker_top / 2;
    let uv_right = marker_right.div_ceil(2).min(uv_width);
    let uv_bottom = marker_bottom.div_ceil(2).min(uv_height);
    for y in uv_top..uv_bottom {
        let row_start = y * uv_width + uv_left;
        let row_end = y * uv_width + uv_right;
        bytes[u_start + row_start..u_start + row_end].fill(60);
        bytes[v_start + row_start..v_start + row_end].fill(190);
    }
}

fn raw_rgba_len(width: u32, height: u32) -> Result<usize> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .context("Raw RGBA frame size overflowed")?;
    usize::try_from(pixels).context("Raw RGBA frame size did not fit in memory")
}

fn raw_yuv420p_len(width: u32, height: u32) -> Result<usize> {
    let width = u64::from(width.max(1));
    let height = u64::from(height.max(1));
    let y = width
        .checked_mul(height)
        .context("Raw YUV frame size overflowed")?;
    let uv = width
        .div_ceil(2)
        .checked_mul(height.div_ceil(2))
        .and_then(|plane| plane.checked_mul(2))
        .context("Raw YUV frame size overflowed")?;
    usize::try_from(y.saturating_add(uv)).context("Raw YUV frame size did not fit in memory")
}

struct SyntheticRecordingWriterParams {
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    byte_len: usize,
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    startup_ready_tx: Option<oneshot::Sender<std::result::Result<(), String>>>,
    fifo_path: PathBuf,
    frame_store: Option<CompositorFrameStore>,
    video_output: EncoderBridgeVideoOutput,
    bitrate_kbps: Option<u32>,
    diagnostics_tx: watch::Sender<Option<EncoderBridgeWriterEvent>>,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    video_epoch: Arc<OnceLock<Instant>>,
}

#[derive(Debug, Clone)]
struct EncoderBridgeWriterEvent {
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
}

fn write_synthetic_recording_frames(params: SyntheticRecordingWriterParams) {
    let SyntheticRecordingWriterParams {
        session_id,
        target_fps,
        width,
        height,
        byte_len,
        stop,
        terminal_failure,
        mut startup_ready_tx,
        fifo_path,
        frame_store,
        video_output,
        bitrate_kbps,
        diagnostics_tx,
        diagnostics_context,
        video_epoch,
    } = params;
    let output_queue_policy = encoder_bridge_output_queue_policy(diagnostics_context);
    let fifo = match open_recording_fifo_writer(&fifo_path, &stop, true) {
        Ok(fifo) => fifo,
        Err(error) => {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "Could not open recording encoder bridge FIFO {}: {error}",
                    fifo_path.display()
                ),
            );
            signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth: 0,
                    input_fps: None,
                    dropped_frames: 0,
                    encoder_speed: None,
                    ..Default::default()
                },
                diagnostics_context,
                Some(error),
            );
            return;
        }
    };
    #[cfg(target_os = "macos")]
    let (mut raw_fifo_writer, mut video_toolbox_fifo_writer) = if video_output.uses_video_toolbox()
    {
        (
            None,
            Some(VideoToolboxFifoWriter::start(
                fifo,
                video_output,
                output_queue_policy,
                stop.clone(),
            )),
        )
    } else {
        (
            Some(RawVideoFifoWriter::start(
                fifo,
                output_queue_policy,
                stop.clone(),
                terminal_failure.clone(),
            )),
            None,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let mut raw_fifo_writer = Some(RawVideoFifoWriter::start(
        fifo,
        output_queue_policy,
        stop.clone(),
        terminal_failure.clone(),
    ));
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let source = SyntheticMovingSource;
    let mut sequence = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut raw_frames_delivered_in_window = 0_u64;
    let mut queue_depth = 0_u64;
    let mut repeated_fed_frames = 0_u64;
    let mut repeated_frame_bursts = 0_u64;
    let mut max_repeated_frame_run = 0_u64;
    let mut synthetic_fallback_frames = 0_u64;
    let mut max_source_to_encode_age_ms: Option<u64> = None;
    let mut source_to_encode_age_times_ms = Vec::with_capacity(128);
    let mut repeated_frame_age_times_ms = Vec::with_capacity(128);
    let mut max_repeated_frame_age_ms: Option<u64> = None;
    let mut metal_target_frames = 0_u64;
    let mut raw_video_copied_frames = 0_u64;
    let mut metal_target_copied_frames = 0_u64;
    let mut metal_target_handle_frames = 0_u64;
    let mut zero_copy_frames = 0_u64;
    let mut video_toolbox_probe_frames = 0_u64;
    let mut video_toolbox_probe_bytes = 0_u64;
    let mut video_toolbox_probe_errors = 0_u64;
    let mut video_toolbox_output_frames = 0_u64;
    let mut video_toolbox_output_bytes = 0_u64;
    let mut max_video_toolbox_output_encode_ms: Option<u64> = None;
    let mut pending_video_toolbox_output_frames = 0_u64;
    let mut pending_video_toolbox_fifo_frames = 0_u64;
    let mut pending_raw_fifo_frames = 0_u64;
    let mut pending_raw_fifo_started_at = VecDeque::<Instant>::new();
    // The raw queue is a zero-capacity rendezvous, so at most one synthetic
    // frame can be in flight. Retain at most one returned fallback allocation.
    let mut recycled_synthetic_buffer = None::<Vec<u8>>;
    #[cfg(target_os = "macos")]
    let mut pending_video_toolbox_output_started_at = HashMap::<u64, Instant>::new();
    #[cfg(target_os = "macos")]
    let mut pending_video_toolbox_fifo_started_at = VecDeque::<Instant>::new();
    let mut output_queue_capacity_pressure_events = 0_u64;
    let mut output_queue_dropped_frames = 0_u64;
    #[cfg(target_os = "macos")]
    macro_rules! oldest_output_queue_age {
        () => {
            if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
                pending_raw_fifo_started_at
                    .front()
                    .copied()
                    .map(|started_at| started_at.elapsed())
            } else {
                oldest_pending_video_toolbox_frame_age(
                    &pending_video_toolbox_output_started_at,
                    &pending_video_toolbox_fifo_started_at,
                )
            }
        };
    }
    #[cfg(not(target_os = "macos"))]
    macro_rules! oldest_output_queue_age {
        () => {
            pending_raw_fifo_started_at
                .front()
                .copied()
                .map(|started_at| started_at.elapsed())
        };
    }
    #[cfg(target_os = "macos")]
    macro_rules! oldest_output_queue_age_ms {
        () => {
            oldest_output_queue_age!().map(|age| age.as_millis() as u64)
        };
    }
    #[cfg(not(target_os = "macos"))]
    macro_rules! oldest_output_queue_age_ms {
        () => {
            oldest_output_queue_age!().map(|age| age.as_millis() as u64)
        };
    }
    let mut compositor_wait_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_submit_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_fifo_write_times_ms = Vec::with_capacity(128);
    let mut raw_video_fifo_write_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_fifo_enqueue_times_ms = Vec::with_capacity(128);
    let mut max_video_toolbox_fifo_enqueue_ms: Option<f64> = None;
    let mut writer_loop_times_ms = Vec::with_capacity(128);
    let mut writer_sleep_times_ms = Vec::with_capacity(128);
    let mut writer_active_times_ms = Vec::with_capacity(128);
    let mut deadline_lag_times_ms = Vec::with_capacity(128);
    let mut max_deadline_lag_ms: Option<f64> = None;
    let mut late_deadline_ticks = 0_u64;
    let mut schedule_skipped_ms = 0_u64;
    #[cfg(target_os = "macos")]
    let mut video_toolbox_probe = EncoderBridgeVideoToolboxProbe::new(
        video_output.uses_video_toolbox() || encoder_bridge_video_toolbox_probe_enabled(),
        width,
        height,
        target_fps,
        bitrate_kbps,
    );
    #[cfg(target_os = "macos")]
    if video_output.uses_video_toolbox()
        && let Err(error) = video_toolbox_probe.prepare_session()
    {
        let error = record_encoder_bridge_terminal_failure(
            &terminal_failure,
            format!("Could not prepare VideoToolbox encoder bridge output: {error}"),
        );
        signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
        emit_encoder_bridge_diagnostics_from_thread(
            &diagnostics_tx,
            session_id.clone(),
            target_fps,
            EncoderBridgeRuntimeStats {
                queue_depth: 0,
                input_fps: None,
                dropped_frames: 0,
                encoder_speed: None,
                ..Default::default()
            },
            diagnostics_context,
            Some(error),
        );
        return;
    }
    // VideoToolbox session creation can take several frame intervals. Start
    // the absolute CFR clock only after that one-time setup; otherwise the
    // first loop tries to catch up the setup delay by immediately re-feeding
    // one compositor frame, creating a visible startup freeze.
    let mut window_started_at = Instant::now();
    let mut next_frame_at = Instant::now();
    let mut last_fed_sequence: Option<u64> = None;
    let mut first_frame_wait_sequence =
        initial_bridge_wait_sequence(video_output, frame_store.as_ref());
    let mut consecutive_repeated_frames = 0_u64;
    let mut terminal_writer_error = None;

    macro_rules! current_input_fps {
        () => {
            measured_input_fps(
                encoder_bridge_input_frame_count(
                    video_output,
                    frames_in_window,
                    raw_frames_delivered_in_window,
                ),
                window_started_at,
            )
        };
    }

    macro_rules! current_runtime_stats {
        ($depth:expr) => {
            EncoderBridgeRuntimeStats {
                queue_depth: $depth,
                output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                output_queue_capacity_pressure_events,
                output_queue_dropped_frames,
                input_fps: current_input_fps!(),
                dropped_frames: 0,
                encoder_speed: None,
                repeated_fed_frames,
                repeated_frame_bursts,
                max_repeated_frame_run,
                synthetic_fallback_frames,
                source_to_encode_age_ms: max_source_to_encode_age_ms,
                source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                metal_target_frames,
                raw_video_copied_frames,
                metal_target_copied_frames,
                metal_target_handle_frames,
                zero_copy_frames,
                video_toolbox_probe_frames,
                video_toolbox_probe_bytes,
                video_toolbox_probe_errors,
                video_toolbox_output_frames,
                video_toolbox_output_bytes,
                video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                deadline_lag_max_ms: max_deadline_lag_ms,
                late_deadline_ticks,
                schedule_skipped_ms,
            }
        };
    }

    if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
        // FFmpeg can take hundreds of milliseconds to initialise its input
        // graph and hardware encoder after opening the raw FIFO. Advancing the
        // 30fps clock during that one-time warmup creates avoidable pressure
        // before the wall-clock-stamped input has delivered any usable video.
        // Deliver exactly one complete priming frame first; only then start the
        // wall-clock input schedule and publish the recording as ready.
        let prime_wait_started_at = Instant::now();
        let prime_frame = next_raw_compositor_frame(
            frame_store.as_ref(),
            first_frame_wait_sequence,
            frame_interval + frame_interval,
            byte_len,
        );
        compositor_wait_times_ms.push(prime_wait_started_at.elapsed().as_secs_f64() * 1000.0);
        let submitted_at = Instant::now();
        let queued_prime = match prime_frame.as_ref() {
            Some(frame) => QueuedRawVideoFrame::compositor(frame, submitted_at),
            None => {
                synthetic_fallback_frames = synthetic_fallback_frames.saturating_add(1);
                let frame = source.render(1, width, height);
                let mut bytes =
                    take_recycled_synthetic_buffer(&mut recycled_synthetic_buffer, byte_len);
                render_synthetic_yuv420p_frame(&frame, &mut bytes);
                QueuedRawVideoFrame::synthetic(bytes, submitted_at)
            }
        };
        let prime_enqueue = raw_fifo_writer
            .as_ref()
            .expect("raw encoder bridge FIFO writer must be running")
            .enqueue_startup(queued_prime);
        if let Err(error) = prime_enqueue {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder startup prime failed: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(0),
                diagnostics_context,
                Some(error),
            );
            return;
        }
        pending_raw_fifo_frames = 1;
        pending_raw_fifo_started_at.push_back(submitted_at);
        let prime_deadline = Instant::now() + RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT;
        while pending_raw_fifo_frames > 0 && !stop.load(Ordering::Relaxed) {
            let writer = raw_fifo_writer
                .as_mut()
                .expect("raw encoder bridge FIFO writer must be running");
            if let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            ) {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder startup prime stopped: {error}",
                        encoder_bridge_output_role_label(output_queue_policy.role)
                    ),
                );
                signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
                emit_encoder_bridge_diagnostics_from_thread(
                    &diagnostics_tx,
                    session_id.clone(),
                    target_fps,
                    current_runtime_stats!(pending_raw_fifo_frames),
                    diagnostics_context,
                    Some(error),
                );
                return;
            }
            if pending_raw_fifo_frames == 0 {
                break;
            }
            if Instant::now() >= prime_deadline {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder did not accept a complete startup frame within {}ms",
                        encoder_bridge_output_role_label(output_queue_policy.role),
                        RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT.as_millis()
                    ),
                );
                signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
                emit_encoder_bridge_diagnostics_from_thread(
                    &diagnostics_tx,
                    session_id.clone(),
                    target_fps,
                    current_runtime_stats!(pending_raw_fifo_frames),
                    diagnostics_context,
                    Some(error),
                );
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
        if stop.load(Ordering::Relaxed) {
            signal_encoder_bridge_startup(
                &mut startup_ready_tx,
                Err("Encoder bridge stopped during raw-video startup priming".to_string()),
            );
            return;
        }
        if let Some(frame) = prime_frame {
            last_fed_sequence = Some(frame.sequence);
            let source_age_ms = frame.captured_at.elapsed().as_millis() as u64;
            max_source_to_encode_age_ms = Some(source_age_ms);
            source_to_encode_age_times_ms.push(source_age_ms as f64);
        }
        // Audio captured while FFmpeg was initialising is pre-roll. Start its
        // shared epoch only after the complete video prime reached the reader.
        let _ = video_epoch.set(Instant::now());
        sequence = 1;
        frames_in_window = 1;
        window_started_at = Instant::now();
        next_frame_at = window_started_at + frame_interval;
        first_frame_wait_sequence = None;
        signal_encoder_bridge_startup(&mut startup_ready_tx, Ok(()));
    } else {
        signal_encoder_bridge_startup(&mut startup_ready_tx, Ok(()));
    }

    while !stop.load(Ordering::Relaxed) {
        if let Some(writer) = raw_fifo_writer.as_mut()
            && let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            )
        {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(pending_raw_fifo_frames),
                diagnostics_context,
                Some(error),
            );
            break;
        }
        let loop_started_at = Instant::now();
        let now = Instant::now();
        let tick_lag = now.saturating_duration_since(next_frame_at);
        if now > next_frame_at && tick_lag >= ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD {
            let lag_ms = tick_lag.as_secs_f64() * 1000.0;
            deadline_lag_times_ms.push(lag_ms);
            max_deadline_lag_ms =
                Some(max_deadline_lag_ms.map_or(lag_ms, |current| current.max(lag_ms)));
            late_deadline_ticks = late_deadline_ticks.saturating_add(1);
        }
        let tick_plan = plan_bridge_tick(tick_lag, frame_interval);
        if tick_plan.reanchor_skipped_intervals > 0 {
            // Pathological stall: drop whole intervals as an EXPLICIT gap. The
            // schedule stays wall-true (sequence advances by the same count,
            // keeping synthetic PTS honest on the encoded path) and the loss is
            // counted, never silent.
            next_frame_at += frame_interval * tick_plan.reanchor_skipped_intervals as u32;
            sequence = sequence.saturating_add(tick_plan.reanchor_skipped_intervals);
            let skipped_ms = (frame_interval.as_secs_f64()
                * tick_plan.reanchor_skipped_intervals as f64
                * 1000.0) as u64;
            schedule_skipped_ms = schedule_skipped_ms.saturating_add(skipped_ms);
            tracing::warn!(
                skipped_intervals = tick_plan.reanchor_skipped_intervals,
                skipped_ms,
                "encoder bridge schedule stalled; dropped intervals as an explicit gap"
            );
        }
        let sleep_started_at = Instant::now();
        if now < next_frame_at {
            thread::sleep(next_frame_at - now);
        }
        let active_started_at = Instant::now();
        writer_sleep_times_ms.push(
            active_started_at
                .duration_since(sleep_started_at)
                .as_secs_f64()
                * 1000.0,
        );
        next_frame_at += frame_interval;
        sequence = sequence.saturating_add(1);

        // Drain completions before admitting another compositor frame. The old
        // path submitted first and only observed pressure afterwards, allowing
        // a 240-frame blocking FIFO to turn a slow sink into seconds of hidden
        // latency.
        #[cfg(target_os = "macos")]
        let mut pipeline_error = if video_output.uses_video_toolbox() {
            let writer = video_toolbox_fifo_writer
                .as_mut()
                .expect("VideoToolbox FIFO writer must be running");
            drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                writer,
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                Some(VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK),
            )
            .and_then(|()| {
                drain_video_toolbox_fifo_writer_results(
                    writer,
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
            })
            .err()
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let mut pipeline_error: Option<io::Error> = None;

        queue_depth = if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        let admission = if pipeline_error.is_some() || !video_output.uses_video_toolbox() {
            EncoderBridgePreEncodeAdmission::Submit
        } else {
            encoder_bridge_pre_encode_admission(
                output_queue_policy,
                queue_depth,
                oldest_output_queue_age!(),
            )
        };
        match admission {
            EncoderBridgePreEncodeAdmission::Submit => {}
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame => {
                output_queue_capacity_pressure_events =
                    output_queue_capacity_pressure_events.saturating_add(1);
                output_queue_dropped_frames = output_queue_dropped_frames.saturating_add(1);
                writer_active_times_ms.push(active_started_at.elapsed().as_secs_f64() * 1000.0);
                writer_loop_times_ms.push(loop_started_at.elapsed().as_secs_f64() * 1000.0);
                if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
                    emit_encoder_bridge_diagnostics_from_thread(
                        &diagnostics_tx,
                        session_id.clone(),
                        target_fps,
                        current_runtime_stats!(queue_depth),
                        diagnostics_context,
                        None,
                    );
                    window_started_at = Instant::now();
                    frames_in_window = 0;
                    raw_frames_delivered_in_window = 0;
                    compositor_wait_times_ms.clear();
                    video_toolbox_submit_times_ms.clear();
                    video_toolbox_fifo_write_times_ms.clear();
                    raw_video_fifo_write_times_ms.clear();
                    video_toolbox_fifo_enqueue_times_ms.clear();
                    writer_loop_times_ms.clear();
                    writer_sleep_times_ms.clear();
                    writer_active_times_ms.clear();
                    source_to_encode_age_times_ms.clear();
                    repeated_frame_age_times_ms.clear();
                }
                // `last_fed_sequence` intentionally does not advance. The next
                // admitted tick asks the latest-wins compositor store for the
                // newest frame and skips every superseded frame before encode.
                // The bridge timing sequence did advance above, so the next
                // MPEG-TS PTS carries an explicit wall-time gap; the maintained
                // final-artifact cadence/freeze gate checks that this remains
                // honest rather than compressing the stream timeline.
                continue;
            }
            EncoderBridgePreEncodeAdmission::FailOutput => {
                output_queue_capacity_pressure_events =
                    output_queue_capacity_pressure_events.saturating_add(1);
                pipeline_error = Some(encoder_bridge_output_pressure_error(
                    output_queue_policy,
                    queue_depth,
                    oldest_output_queue_age!(),
                ));
            }
        }
        let startup_wait_sequence = if last_fed_sequence.is_none() {
            first_frame_wait_sequence
        } else {
            None
        };
        let wait_budget = if startup_wait_sequence.is_some() {
            frame_interval + frame_interval
        } else if tick_plan.skip_fresh_wait {
            // Behind schedule: feed the latest available frame immediately (a
            // repeat if unchanged) so the absolute schedule converges by
            // emitting honest repeats instead of compressing the timeline.
            Duration::ZERO
        } else {
            compositor_frame_wait_budget(video_output, consecutive_repeated_frames, frame_interval)
        };
        let previous_sequence = last_fed_sequence.or(startup_wait_sequence);
        let compositor_wait_started_at = Instant::now();
        let fed = match video_output {
            EncoderBridgeVideoOutput::RawYuv420p => next_raw_compositor_frame(
                frame_store.as_ref(),
                previous_sequence,
                wait_budget,
                byte_len,
            ),
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
                next_compositor_frame(frame_store.as_ref(), previous_sequence, wait_budget)
            }
        };
        compositor_wait_times_ms.push(compositor_wait_started_at.elapsed().as_secs_f64() * 1000.0);
        let frame_source =
            classify_bridge_frame(last_fed_sequence, fed.as_ref().map(|frame| frame.sequence));
        match frame_source {
            BridgeFrameSource::SyntheticFallback => {
                synthetic_fallback_frames = synthetic_fallback_frames.saturating_add(1);
                consecutive_repeated_frames = 0;
                if video_output.uses_video_toolbox() {
                    emit_encoder_bridge_diagnostics_from_thread(
                        &diagnostics_tx,
                        session_id.clone(),
                        target_fps,
                        EncoderBridgeRuntimeStats {
                            queue_depth,
                            output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                            output_queue_capacity_pressure_events,
                            output_queue_dropped_frames,
                            input_fps: current_input_fps!(),
                            dropped_frames: 0,
                            encoder_speed: None,
                            repeated_fed_frames,
                            repeated_frame_bursts,
                            max_repeated_frame_run,
                            synthetic_fallback_frames,
                            source_to_encode_age_ms: max_source_to_encode_age_ms,
                            source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                            repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                            repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                            metal_target_frames,
                            raw_video_copied_frames,
                            metal_target_copied_frames,
                            metal_target_handle_frames,
                            zero_copy_frames,
                            video_toolbox_probe_frames,
                            video_toolbox_probe_bytes,
                            video_toolbox_probe_errors,
                            video_toolbox_output_frames,
                            video_toolbox_output_bytes,
                            video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                            compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                            video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                            raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                            video_toolbox_fifo_write_p95_ms: p95_ms(
                                &video_toolbox_fifo_write_times_ms,
                            ),
                            video_toolbox_fifo_enqueue_p95_ms: p95_ms(
                                &video_toolbox_fifo_enqueue_times_ms,
                            ),
                            video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                            deadline_lag_max_ms: max_deadline_lag_ms,
                            late_deadline_ticks,
                            schedule_skipped_ms,
                        },
                        diagnostics_context,
                        Some(
                            "VideoToolbox encoder bridge had no compositor frame to encode"
                                .to_string(),
                        ),
                    );
                    break;
                }
            }
            BridgeFrameSource::Repeated => {
                if consecutive_repeated_frames == 0 {
                    repeated_frame_bursts = repeated_frame_bursts.saturating_add(1);
                }
                repeated_fed_frames = repeated_fed_frames.saturating_add(1);
                consecutive_repeated_frames = consecutive_repeated_frames.saturating_add(1);
                max_repeated_frame_run = max_repeated_frame_run.max(consecutive_repeated_frames);
            }
            BridgeFrameSource::Fresh => {
                consecutive_repeated_frames = 0;
            }
        }
        if let Some(frame) = fed.as_ref() {
            if last_fed_sequence.is_none() {
                // First video content of the session: everything the audio writer
                // captured before the composited frame's timestamp is pre-roll and
                // must be trimmed. Using the encoder-observed instant here would
                // bake source-to-encode latency into the finished recording.
                let _ = video_epoch.set(frame.captured_at);
            }
            last_fed_sequence = Some(frame.sequence);
            max_source_to_encode_age_ms =
                Some(max_source_to_encode_age_ms.map_or(frame.age_ms, |age| age.max(frame.age_ms)));
            source_to_encode_age_times_ms.push(frame.age_ms as f64);
            if frame_source == BridgeFrameSource::Repeated {
                repeated_frame_age_times_ms.push(frame.age_ms as f64);
                max_repeated_frame_age_ms = Some(
                    max_repeated_frame_age_ms.map_or(frame.age_ms, |age| age.max(frame.age_ms)),
                );
            }
        }
        #[cfg(target_os = "macos")]
        let wrote_metal_target_frame = fed
            .as_ref()
            .is_some_and(|frame| frame.has_metal_iosurface_target);
        #[cfg(target_os = "macos")]
        let wrote_metal_target_handle = fed
            .as_ref()
            .is_some_and(|frame| frame.has_metal_export_handle);
        #[cfg(target_os = "macos")]
        if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p)
            && let Some(frame) = fed.as_ref()
        {
            match video_toolbox_probe.encode_frame(frame, sequence.saturating_sub(1)) {
                VideoToolboxProbeOutcome::Encoded { frame } => {
                    video_toolbox_probe_frames = video_toolbox_probe_frames.saturating_add(1);
                    video_toolbox_probe_bytes =
                        video_toolbox_probe_bytes.saturating_add(frame.bytes.len() as u64);
                }
                VideoToolboxProbeOutcome::Failed => {
                    video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
                }
                VideoToolboxProbeOutcome::Disabled
                | VideoToolboxProbeOutcome::NoTarget
                | VideoToolboxProbeOutcome::Submitted => {}
            }
        }

        queue_depth = if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        let write_result = if let Some(error) = pipeline_error {
            Err(error)
        } else {
            match video_output {
                EncoderBridgeVideoOutput::RawYuv420p => {
                    let submitted_at = Instant::now();
                    let queued_frame = match fed.as_ref() {
                        Some(frame) => QueuedRawVideoFrame::compositor(frame, submitted_at),
                        None => {
                            let frame = source.render(sequence, width, height);
                            let mut bytes = take_recycled_synthetic_buffer(
                                &mut recycled_synthetic_buffer,
                                byte_len,
                            );
                            render_synthetic_yuv420p_frame(&frame, &mut bytes);
                            QueuedRawVideoFrame::synthetic(bytes, submitted_at)
                        }
                    };
                    match raw_fifo_writer
                        .as_ref()
                        .expect("raw encoder bridge FIFO writer must be running")
                        .enqueue(queued_frame, &mut output_queue_capacity_pressure_events)
                    {
                        Ok(RawVideoFifoEnqueueOutcome::Enqueued) => {
                            pending_raw_fifo_frames = pending_raw_fifo_frames.saturating_add(1);
                            pending_raw_fifo_started_at.push_back(submitted_at);
                            Ok(())
                        }
                        Ok(RawVideoFifoEnqueueOutcome::Coalesced(frame)) => {
                            output_queue_dropped_frames =
                                output_queue_dropped_frames.saturating_add(1);
                            // The one-slot mailbox retained the new latest frame
                            // and returned the superseded pending frame. Keep the
                            // age queue aligned with that replacement so health
                            // reports the frame the writer will actually consume.
                            if let Some(pending_started_at) = pending_raw_fifo_started_at.back_mut()
                            {
                                *pending_started_at = submitted_at;
                            }
                            retain_recycled_synthetic_buffer(
                                &mut recycled_synthetic_buffer,
                                frame.into_synthetic_buffer(),
                            );
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
                | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
                    #[cfg(target_os = "macos")]
                    {
                        match fed.as_ref() {
                            Some(frame) => {
                                let encode_started_at = Instant::now();
                                match video_toolbox_probe
                                    .submit_output_frame(frame, sequence.saturating_sub(1))
                                {
                                    VideoToolboxProbeOutcome::Submitted => {
                                        let encode_ms =
                                            encode_started_at.elapsed().as_millis() as u64;
                                        video_toolbox_submit_times_ms.push(
                                            encode_started_at.elapsed().as_secs_f64() * 1000.0,
                                        );
                                        max_video_toolbox_output_encode_ms = Some(
                                            max_video_toolbox_output_encode_ms
                                                .map_or(encode_ms, |current| {
                                                    current.max(encode_ms)
                                                }),
                                        );
                                        pending_video_toolbox_output_frames =
                                            pending_video_toolbox_output_frames.saturating_add(1);
                                        pending_video_toolbox_output_started_at
                                            .insert(sequence.saturating_sub(1), encode_started_at);
                                        if wrote_metal_target_frame {
                                            metal_target_frames =
                                                metal_target_frames.saturating_add(1);
                                        }
                                        if wrote_metal_target_handle {
                                            metal_target_handle_frames =
                                                metal_target_handle_frames.saturating_add(1);
                                        }
                                        Ok(())
                                    }
                                    VideoToolboxProbeOutcome::Failed => {
                                        video_toolbox_probe_errors =
                                            video_toolbox_probe_errors.saturating_add(1);
                                        Err(io::Error::other(
                                            "VideoToolbox encoder bridge failed to encode retained target",
                                        ))
                                    }
                                    VideoToolboxProbeOutcome::Disabled
                                    | VideoToolboxProbeOutcome::NoTarget
                                    | VideoToolboxProbeOutcome::Encoded { .. } => {
                                        Err(io::Error::other(
                                            "VideoToolbox encoder bridge had no retained target",
                                        ))
                                    }
                                }
                            }
                            None => Err(io::Error::other(
                                "VideoToolbox encoder bridge had no compositor frame",
                            )),
                        }
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        Err(io::Error::other(
                            "VideoToolbox encoder bridge output is only available on macOS",
                        ))
                    }
                }
            }
        };
        if let Err(error) = write_result {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} encoder output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_capacity_pressure_events,
                    output_queue_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                Some(error),
            );
            break;
        }
        #[cfg(target_os = "macos")]
        if video_output.uses_video_toolbox()
            && let Err(error) = drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                video_toolbox_fifo_writer
                    .as_mut()
                    .expect("VideoToolbox FIFO writer must be running"),
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                Some(VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK),
            )
            .and_then(|()| {
                drain_video_toolbox_fifo_writer_results(
                    video_toolbox_fifo_writer
                        .as_mut()
                        .expect("VideoToolbox FIFO writer must be running"),
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
            })
        {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} VideoToolbox output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth: pending_video_toolbox_output_frames
                        .saturating_add(pending_video_toolbox_fifo_frames),
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_capacity_pressure_events,
                    output_queue_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                Some(error),
            );
            break;
        }
        if let Some(writer) = raw_fifo_writer.as_mut()
            && let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            )
        {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(pending_raw_fifo_frames),
                diagnostics_context,
                Some(error),
            );
            break;
        }
        queue_depth = if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        writer_active_times_ms.push(active_started_at.elapsed().as_secs_f64() * 1000.0);
        writer_loop_times_ms.push(loop_started_at.elapsed().as_secs_f64() * 1000.0);
        // Plan 026: the schedule is absolute — no re-anchor. A tick that
        // overruns starts the next iteration behind, which zeroes the
        // fresh-frame wait (above) and converges with repeats; wall time is
        // never silently dropped from the video timeline.
        frames_in_window = frames_in_window.saturating_add(1);
        if startup_wait_sequence.is_some() {
            next_frame_at = Instant::now() + frame_interval;
            first_frame_wait_sequence = None;
        }

        if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_capacity_pressure_events,
                    output_queue_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                None,
            );
            window_started_at = Instant::now();
            frames_in_window = 0;
            raw_frames_delivered_in_window = 0;
            compositor_wait_times_ms.clear();
            video_toolbox_submit_times_ms.clear();
            video_toolbox_fifo_write_times_ms.clear();
            raw_video_fifo_write_times_ms.clear();
            video_toolbox_fifo_enqueue_times_ms.clear();
            writer_loop_times_ms.clear();
            writer_sleep_times_ms.clear();
            writer_active_times_ms.clear();
            source_to_encode_age_times_ms.clear();
            repeated_frame_age_times_ms.clear();
        }
    }

    #[cfg(target_os = "macos")]
    if video_output.uses_video_toolbox() {
        if video_toolbox_probe.complete_pending().is_err() {
            video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
        }
        let drain_started_at = Instant::now();
        while (pending_video_toolbox_output_frames > 0 || pending_video_toolbox_fifo_frames > 0)
            && drain_started_at.elapsed() < Duration::from_secs(2)
        {
            let writer = video_toolbox_fifo_writer
                .as_mut()
                .expect("VideoToolbox FIFO writer must be running");
            if drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                writer,
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                None,
            )
            .and_then(|()| {
                drain_video_toolbox_fifo_writer_results(
                    writer,
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
            })
            .is_err()
            {
                break;
            }
            if pending_video_toolbox_output_frames > 0 || pending_video_toolbox_fifo_frames > 0 {
                thread::sleep(Duration::from_millis(2));
            }
        }
        if let Some(writer) = video_toolbox_fifo_writer.as_mut() {
            writer.close_and_join();
            let _ = drain_video_toolbox_fifo_writer_results(
                writer,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_fifo_started_at,
                &mut zero_copy_frames,
                &mut video_toolbox_output_frames,
                &mut video_toolbox_output_bytes,
                &mut video_toolbox_fifo_write_times_ms,
            );
        }
        queue_depth =
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames);
    }

    if let Some(writer) = raw_fifo_writer.as_mut() {
        writer.close_and_join();
        if let Err(error) = drain_raw_video_fifo_writer_results(
            writer,
            &mut pending_raw_fifo_frames,
            &mut pending_raw_fifo_started_at,
            &mut recycled_synthetic_buffer,
            &mut raw_video_copied_frames,
            &mut raw_frames_delivered_in_window,
            &mut metal_target_frames,
            &mut metal_target_copied_frames,
            &mut metal_target_handle_frames,
            &mut raw_video_fifo_write_times_ms,
        ) {
            terminal_writer_error.get_or_insert_with(|| {
                format!(
                    "{} raw-video encoder output stopped while draining: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                )
            });
        }
        queue_depth = pending_raw_fifo_frames;
    }
    emit_encoder_bridge_diagnostics_from_thread(
        &diagnostics_tx,
        session_id,
        target_fps,
        EncoderBridgeRuntimeStats {
            queue_depth,
            output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
            output_queue_capacity_pressure_events,
            output_queue_dropped_frames,
            input_fps: current_input_fps!(),
            dropped_frames: 0,
            encoder_speed: None,
            repeated_fed_frames,
            repeated_frame_bursts,
            max_repeated_frame_run,
            synthetic_fallback_frames,
            source_to_encode_age_ms: max_source_to_encode_age_ms,
            source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
            repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
            repeated_frame_age_max_ms: max_repeated_frame_age_ms,
            metal_target_frames,
            raw_video_copied_frames,
            metal_target_copied_frames,
            metal_target_handle_frames,
            zero_copy_frames,
            video_toolbox_probe_frames,
            video_toolbox_probe_bytes,
            video_toolbox_probe_errors,
            video_toolbox_output_frames,
            video_toolbox_output_bytes,
            video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
            compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
            video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
            raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
            video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
            video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
            video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
            deadline_lag_max_ms: max_deadline_lag_ms,
            late_deadline_ticks,
            schedule_skipped_ms,
        },
        diagnostics_context,
        terminal_writer_error,
    );
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct VideoToolboxBridgeEncoderConfig {
    width: usize,
    height: usize,
    expected_frame_rate: i32,
    max_key_frame_interval: i32,
    average_bit_rate_bps: Option<i64>,
}

#[cfg(target_os = "macos")]
impl VideoToolboxBridgeEncoderConfig {
    fn from_recording_profile(
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: Option<u32>,
    ) -> Self {
        let expected_frame_rate = i32::try_from(fps.max(1)).unwrap_or(i32::MAX);
        Self {
            width: width.max(1) as usize,
            height: height.max(1) as usize,
            expected_frame_rate,
            max_key_frame_interval: expected_frame_rate.saturating_mul(2).max(1),
            average_bit_rate_bps: bitrate_kbps
                .map(|bitrate_kbps| i64::from(bitrate_kbps).saturating_mul(1_000)),
        }
    }
}

#[cfg(target_os = "macos")]
struct EncoderBridgeVideoToolboxProbe {
    enabled: bool,
    config: VideoToolboxBridgeEncoderConfig,
    session: Option<VideoToolboxH264Session>,
    output_tx: std_mpsc::SyncSender<VideoToolboxH264AsyncAnnexBFrame>,
    output_rx: std_mpsc::Receiver<VideoToolboxH264AsyncAnnexBFrame>,
    rejected_output_frames: Arc<std::sync::atomic::AtomicU64>,
    disabled_after_error: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
enum VideoToolboxProbeOutcome {
    Disabled,
    NoTarget,
    Submitted,
    Encoded { frame: VideoToolboxH264AnnexBFrame },
    Failed,
}

#[cfg(target_os = "macos")]
impl EncoderBridgeVideoToolboxProbe {
    fn new(enabled: bool, width: u32, height: u32, fps: u32, bitrate_kbps: Option<u32>) -> Self {
        let (output_tx, output_rx) =
            std_mpsc::sync_channel(VIDEOTOOLBOX_CALLBACK_OUTPUT_QUEUE_FRAMES);
        let rejected_output_frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
        Self {
            enabled,
            config: VideoToolboxBridgeEncoderConfig::from_recording_profile(
                width,
                height,
                fps,
                bitrate_kbps,
            ),
            session: None,
            output_tx,
            output_rx,
            rejected_output_frames,
            disabled_after_error: false,
        }
    }

    fn encode_frame(
        &mut self,
        frame: &FedCompositorFrame,
        frame_index: u64,
    ) -> VideoToolboxProbeOutcome {
        if !self.enabled || self.disabled_after_error {
            return VideoToolboxProbeOutcome::Disabled;
        }
        let Some(target) = frame.metal_target.as_ref() else {
            return VideoToolboxProbeOutcome::NoTarget;
        };
        if self.session.is_none() && self.prepare_session().is_err() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        let Some(session) = self.session.as_ref() else {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        };
        let frame_index = match i64::try_from(frame_index) {
            Ok(frame_index) => frame_index,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let timing = match VideoToolboxFrameTiming::frame_index(
            frame_index,
            self.config.expected_frame_rate,
        ) {
            Ok(timing) => timing,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let frame =
            match session.encode_retained_target_annex_b_with_timing(target.as_ref(), timing) {
                Ok(frame) => frame,
                Err(_) => {
                    self.disabled_after_error = true;
                    return VideoToolboxProbeOutcome::Failed;
                }
            };
        if frame.bytes.is_empty() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        VideoToolboxProbeOutcome::Encoded { frame }
    }

    fn submit_output_frame(
        &mut self,
        frame: &FedCompositorFrame,
        frame_index: u64,
    ) -> VideoToolboxProbeOutcome {
        if !self.enabled || self.disabled_after_error {
            return VideoToolboxProbeOutcome::Disabled;
        }
        let Some(target) = frame.metal_target.as_ref() else {
            return VideoToolboxProbeOutcome::NoTarget;
        };
        if self.session.is_none() && self.prepare_session().is_err() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        let Some(session) = self.session.as_ref() else {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        };
        let frame_index_i64 = match i64::try_from(frame_index) {
            Ok(frame_index) => frame_index,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let timing = match VideoToolboxFrameTiming::frame_index(
            frame_index_i64,
            self.config.expected_frame_rate,
        ) {
            Ok(timing) => timing,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        if session
            .submit_retained_target_annex_b_with_timing(
                target.clone(),
                timing,
                frame_index,
                self.output_tx.clone(),
                self.rejected_output_frames.clone(),
            )
            .is_err()
        {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        VideoToolboxProbeOutcome::Submitted
    }

    fn try_recv_output(&mut self) -> Option<VideoToolboxH264AsyncAnnexBFrame> {
        self.output_rx.try_recv().ok()
    }

    fn take_rejected_output_frames(&self) -> u64 {
        self.rejected_output_frames.swap(0, Ordering::AcqRel)
    }

    fn complete_pending(&self) -> Result<()> {
        if let Some(session) = self.session.as_ref() {
            session.complete_pending_frames()?;
        }
        Ok(())
    }

    fn prepare_session(&mut self) -> Result<()> {
        let session = match self.config.average_bit_rate_bps {
            Some(average_bit_rate_bps) => VideoToolboxH264Session::new_realtime_with_bitrate(
                self.config.width,
                self.config.height,
                self.config.expected_frame_rate,
                self.config.max_key_frame_interval,
                average_bit_rate_bps,
            )?,
            None => VideoToolboxH264Session::new_realtime(
                self.config.width,
                self.config.height,
                self.config.expected_frame_rate,
                self.config.max_key_frame_interval,
            )?,
        };
        session.prepare()?;
        self.session = Some(session);
        Ok(())
    }
}

struct RawVideoFifoWriter {
    frame_mailbox: Arc<LatestRawVideoFrameMailbox>,
    result_rx: std_mpsc::Receiver<RawVideoFifoWriterResult>,
    join: Option<thread::JoinHandle<()>>,
}

#[derive(Default)]
struct LatestRawVideoFrameMailbox {
    state: StdMutex<LatestRawVideoFrameMailboxState>,
    ready: Condvar,
}

#[derive(Default)]
struct LatestRawVideoFrameMailboxState {
    pending: Option<QueuedRawVideoFrame>,
    closed: bool,
}

enum LatestRawVideoFrameOffer {
    Enqueued,
    Replaced(QueuedRawVideoFrame),
}

impl LatestRawVideoFrameMailbox {
    fn offer(
        &self,
        frame: QueuedRawVideoFrame,
    ) -> std::result::Result<LatestRawVideoFrameOffer, QueuedRawVideoFrame> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return Err(frame);
        }
        let replaced = state.pending.replace(frame);
        self.ready.notify_one();
        Ok(match replaced {
            Some(frame) => LatestRawVideoFrameOffer::Replaced(frame),
            None => LatestRawVideoFrameOffer::Enqueued,
        })
    }

    fn receive(&self) -> Option<QueuedRawVideoFrame> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(frame) = state.pending.take() {
                return Some(frame);
            }
            if state.closed {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.closed = true;
        self.ready.notify_all();
    }
}

enum RawVideoFramePayload {
    /// Immutable compositor allocation retained until the FIFO write finishes.
    Compositor(CompositorFrameHandle),
    /// Only synthetic fallback frames need bridge-owned storage.
    Synthetic(Vec<u8>),
}

impl RawVideoFramePayload {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Compositor(frame) => &frame.bytes,
            Self::Synthetic(bytes) => bytes,
        }
    }

    fn into_synthetic_buffer(self) -> Option<Vec<u8>> {
        match self {
            Self::Compositor(_) => None,
            Self::Synthetic(bytes) => Some(bytes),
        }
    }
}

struct QueuedRawVideoFrame {
    payload: RawVideoFramePayload,
    submitted_at: Instant,
    had_metal_target: bool,
    had_metal_export_handle: bool,
}

impl QueuedRawVideoFrame {
    fn compositor(frame: &FedCompositorFrame, submitted_at: Instant) -> Self {
        Self {
            payload: RawVideoFramePayload::Compositor(Arc::clone(&frame.frame)),
            submitted_at,
            had_metal_target: frame.has_metal_iosurface_target,
            had_metal_export_handle: frame.has_metal_export_handle,
        }
    }

    fn synthetic(bytes: Vec<u8>, submitted_at: Instant) -> Self {
        Self {
            payload: RawVideoFramePayload::Synthetic(bytes),
            submitted_at,
            had_metal_target: false,
            had_metal_export_handle: false,
        }
    }

    fn bytes(&self) -> &[u8] {
        self.payload.bytes()
    }

    fn into_synthetic_buffer(self) -> Option<Vec<u8>> {
        self.payload.into_synthetic_buffer()
    }
}

enum RawVideoFifoEnqueueOutcome {
    Enqueued,
    Coalesced(QueuedRawVideoFrame),
}

#[derive(Debug)]
enum RawVideoFifoWriterResult {
    FrameWritten {
        synthetic_buffer: Option<Vec<u8>>,
        write_ms: f64,
        had_metal_target: bool,
        had_metal_export_handle: bool,
    },
    Error {
        synthetic_buffer: Option<Vec<u8>>,
        message: String,
    },
}

impl RawVideoFifoWriter {
    fn start(
        fifo: File,
        policy: EncoderBridgeOutputQueuePolicy,
        stop: Arc<AtomicBool>,
        terminal_failure: Arc<StdMutex<Option<String>>>,
    ) -> Self {
        let max_frames = RAW_VIDEO_FIFO_QUEUE_MAX_FRAMES;
        let frame_mailbox = Arc::new(LatestRawVideoFrameMailbox::default());
        let writer_mailbox = frame_mailbox.clone();
        // Queue + one in-flight result + one terminal flush result.
        let (result_tx, result_rx) = std_mpsc::sync_channel(max_frames + 2);
        let join = thread::Builder::new()
            .name(format!("videorc-{:?}-raw-video-fifo-writer", policy.role))
            .spawn(move || {
                run_raw_video_fifo_writer_loop_with_receiver(
                    fifo,
                    || writer_mailbox.receive(),
                    result_tx,
                    stop,
                    policy.max_age,
                    terminal_failure,
                    policy.role,
                );
            })
            .expect("could not start raw-video FIFO writer thread");
        Self {
            frame_mailbox,
            result_rx,
            join: Some(join),
        }
    }

    fn enqueue(
        &self,
        frame: QueuedRawVideoFrame,
        capacity_pressure_events: &mut u64,
    ) -> io::Result<RawVideoFifoEnqueueOutcome> {
        match self.frame_mailbox.offer(frame) {
            Ok(LatestRawVideoFrameOffer::Enqueued) => Ok(RawVideoFifoEnqueueOutcome::Enqueued),
            Ok(LatestRawVideoFrameOffer::Replaced(frame)) => {
                *capacity_pressure_events = capacity_pressure_events.saturating_add(1);
                Ok(RawVideoFifoEnqueueOutcome::Coalesced(frame))
            }
            Err(_) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw-video FIFO writer stopped",
            )),
        }
    }

    fn enqueue_startup(&self, frame: QueuedRawVideoFrame) -> io::Result<()> {
        self.frame_mailbox.offer(frame).map(|_| ()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw-video FIFO writer stopped during startup priming",
            )
        })
    }

    fn try_recv_result(&mut self) -> Option<RawVideoFifoWriterResult> {
        self.result_rx.try_recv().ok()
    }

    fn close_and_join(&mut self) {
        self.frame_mailbox.close();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for RawVideoFifoWriter {
    fn drop(&mut self) {
        self.close_and_join();
    }
}

#[cfg(test)]
fn run_raw_video_fifo_writer_loop<W: StdWrite>(
    mut sink: W,
    frame_rx: std_mpsc::Receiver<QueuedRawVideoFrame>,
    result_tx: std_mpsc::SyncSender<RawVideoFifoWriterResult>,
    stop: Arc<AtomicBool>,
    max_frame_age: Duration,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    role: EncoderBridgeOutputRole,
) {
    run_raw_video_fifo_writer_loop_with_receiver(
        &mut sink,
        || frame_rx.recv().ok(),
        result_tx,
        stop,
        max_frame_age,
        terminal_failure,
        role,
    );
}

fn run_raw_video_fifo_writer_loop_with_receiver<W, F>(
    mut sink: W,
    mut receive: F,
    result_tx: std_mpsc::SyncSender<RawVideoFifoWriterResult>,
    stop: Arc<AtomicBool>,
    max_frame_age: Duration,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    role: EncoderBridgeOutputRole,
) where
    W: StdWrite,
    F: FnMut() -> Option<QueuedRawVideoFrame>,
{
    while let Some(frame) = receive() {
        let write_started_at = Instant::now();
        let deadline = frame.submitted_at + max_frame_age;
        // Once any raw frame bytes reach FFmpeg, stopping mid-frame would
        // misalign every following YUV plane and can corrupt the final file.
        // Finish the in-flight frame within its existing age deadline; closing
        // the queue prevents any new work from being admitted during stop.
        match write_all_until(
            &mut sink,
            frame.bytes(),
            &stop,
            deadline,
            max_frame_age,
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            false,
        ) {
            Ok(()) => {
                let had_metal_target = frame.had_metal_target;
                let had_metal_export_handle = frame.had_metal_export_handle;
                let _ = result_tx.send(RawVideoFifoWriterResult::FrameWritten {
                    synthetic_buffer: frame.into_synthetic_buffer(),
                    write_ms: write_started_at.elapsed().as_secs_f64() * 1000.0,
                    had_metal_target,
                    had_metal_export_handle,
                });
            }
            Err(error) => {
                let message = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder output stopped: {error}",
                        encoder_bridge_output_role_label(role)
                    ),
                );
                let _ = result_tx.send(RawVideoFifoWriterResult::Error {
                    synthetic_buffer: frame.into_synthetic_buffer(),
                    message,
                });
                return;
            }
        }
    }
    if !stop.load(Ordering::Relaxed)
        && let Err(error) = sink.flush()
    {
        let message = record_encoder_bridge_terminal_failure(
            &terminal_failure,
            format!(
                "{} raw-video encoder output flush failed: {error}",
                encoder_bridge_output_role_label(role)
            ),
        );
        let _ = result_tx.send(RawVideoFifoWriterResult::Error {
            synthetic_buffer: None,
            message,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn drain_raw_video_fifo_writer_results(
    fifo_writer: &mut RawVideoFifoWriter,
    pending_frames: &mut u64,
    pending_started_at: &mut VecDeque<Instant>,
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    raw_video_copied_frames: &mut u64,
    raw_frames_delivered_in_window: &mut u64,
    metal_target_frames: &mut u64,
    metal_target_copied_frames: &mut u64,
    metal_target_handle_frames: &mut u64,
    fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    while let Some(result) = fifo_writer.try_recv_result() {
        match result {
            RawVideoFifoWriterResult::FrameWritten {
                synthetic_buffer,
                write_ms,
                had_metal_target,
                had_metal_export_handle,
            } => {
                *pending_frames = pending_frames.saturating_sub(1);
                pending_started_at.pop_front();
                *raw_video_copied_frames = raw_video_copied_frames.saturating_add(1);
                *raw_frames_delivered_in_window = raw_frames_delivered_in_window.saturating_add(1);
                if had_metal_target {
                    *metal_target_frames = metal_target_frames.saturating_add(1);
                    *metal_target_copied_frames = metal_target_copied_frames.saturating_add(1);
                }
                if had_metal_export_handle {
                    *metal_target_handle_frames = metal_target_handle_frames.saturating_add(1);
                }
                fifo_write_times_ms.push(write_ms);
                retain_recycled_synthetic_buffer(recycled_synthetic_buffer, synthetic_buffer);
            }
            RawVideoFifoWriterResult::Error {
                synthetic_buffer,
                message,
            } => {
                retain_recycled_synthetic_buffer(recycled_synthetic_buffer, synthetic_buffer);
                *pending_frames = 0;
                pending_started_at.clear();
                return Err(io::Error::other(message));
            }
        }
    }
    Ok(())
}

fn take_recycled_synthetic_buffer(
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    byte_len: usize,
) -> Vec<u8> {
    let mut buffer = recycled_synthetic_buffer
        .take()
        .unwrap_or_else(|| vec![0; byte_len]);
    buffer.resize(byte_len, 0);
    buffer
}

fn retain_recycled_synthetic_buffer(
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    returned: Option<Vec<u8>>,
) {
    if recycled_synthetic_buffer.is_none() {
        *recycled_synthetic_buffer = returned;
    }
}

#[cfg(target_os = "macos")]
struct VideoToolboxFifoWriter {
    frame_tx: Option<std_mpsc::SyncSender<QueuedVideoToolboxFrame>>,
    result_rx: std_mpsc::Receiver<VideoToolboxFifoWriterResult>,
    join: Option<thread::JoinHandle<()>>,
    policy: EncoderBridgeOutputQueuePolicy,
}

#[cfg(target_os = "macos")]
struct QueuedVideoToolboxFrame {
    frame: VideoToolboxH264AnnexBFrame,
    submitted_at: Instant,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum VideoToolboxFifoWriterResult {
    FrameWritten { encoded_bytes: u64, write_ms: f64 },
    Error(String),
}

#[cfg(target_os = "macos")]
impl VideoToolboxFifoWriter {
    fn start(
        fifo: File,
        video_output: EncoderBridgeVideoOutput,
        policy: EncoderBridgeOutputQueuePolicy,
        stop: Arc<AtomicBool>,
    ) -> Self {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(policy.max_frames);
        // The writer can have the full input queue plus one frame in flight.
        // One extra slot preserves a terminal flush error without deadlocking
        // close_and_join if the bridge is already tearing down.
        let (result_tx, result_rx) = std_mpsc::sync_channel(policy.max_frames + 2);
        let join = thread::Builder::new()
            .name(format!("videorc-{:?}-h264-fifo-writer", policy.role))
            .spawn(move || {
                run_video_toolbox_fifo_writer_loop(
                    fifo,
                    VideoToolboxH264PipeWriter::for_output(video_output),
                    frame_rx,
                    result_tx,
                    stop,
                    policy.max_age,
                );
            })
            .expect("could not start VideoToolbox FIFO writer thread");
        Self {
            frame_tx: Some(frame_tx),
            result_rx,
            join: Some(join),
            policy,
        }
    }

    fn enqueue(
        &self,
        frame: VideoToolboxH264AnnexBFrame,
        submitted_at: Instant,
        capacity_pressure_events: &mut u64,
    ) -> io::Result<()> {
        let tx = self
            .frame_tx
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "H.264 FIFO writer closed"))?;
        match offer_preserving_output_frame(
            tx,
            QueuedVideoToolboxFrame {
                frame,
                submitted_at,
            },
        ) {
            Ok(PreservingOutputFrameOffer::Enqueued) => Ok(()),
            Ok(PreservingOutputFrameOffer::CapacityPressure(_frame)) => {
                *capacity_pressure_events = capacity_pressure_events.saturating_add(1);
                Err(io::Error::other(format!(
                    "{} encoded H.264 FIFO reached its {}-frame safety ceiling; stopping this output without blocking the realtime bridge or silently continuing after a discarded access unit",
                    encoder_bridge_output_role_label(self.policy.role),
                    self.policy.max_frames
                )))
            }
            Err(_) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "H.264 FIFO writer stopped",
            )),
        }
    }

    fn try_recv_result(&mut self) -> Option<VideoToolboxFifoWriterResult> {
        self.result_rx.try_recv().ok()
    }

    fn close_and_join(&mut self) {
        self.frame_tx.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

enum PreservingOutputFrameOffer<T> {
    Enqueued,
    CapacityPressure(T),
}

fn offer_preserving_output_frame<T>(
    tx: &std_mpsc::SyncSender<T>,
    frame: T,
) -> std::result::Result<PreservingOutputFrameOffer<T>, T> {
    match tx.try_send(frame) {
        Ok(()) => Ok(PreservingOutputFrameOffer::Enqueued),
        Err(std_mpsc::TrySendError::Full(frame)) => {
            Ok(PreservingOutputFrameOffer::CapacityPressure(frame))
        }
        Err(std_mpsc::TrySendError::Disconnected(frame)) => Err(frame),
    }
}

#[cfg(target_os = "macos")]
impl Drop for VideoToolboxFifoWriter {
    fn drop(&mut self) {
        self.close_and_join();
    }
}

#[cfg(target_os = "macos")]
fn run_video_toolbox_fifo_writer_loop<W: StdWrite>(
    mut sink: W,
    mut h264_pipe_writer: VideoToolboxH264PipeWriter,
    frame_rx: std_mpsc::Receiver<QueuedVideoToolboxFrame>,
    result_tx: std_mpsc::SyncSender<VideoToolboxFifoWriterResult>,
    stop: Arc<AtomicBool>,
    max_frame_age: Duration,
) {
    while let Ok(queued) = frame_rx.recv() {
        let encoded_bytes = queued.frame.bytes.len() as u64;
        let write_started_at = Instant::now();
        let deadline = queued.submitted_at + max_frame_age;
        match h264_pipe_writer.write_frame_until(
            &mut sink,
            &queued.frame,
            &stop,
            deadline,
            max_frame_age,
        ) {
            Ok(()) => {
                let _ = result_tx.send(VideoToolboxFifoWriterResult::FrameWritten {
                    encoded_bytes,
                    write_ms: write_started_at.elapsed().as_secs_f64() * 1000.0,
                });
            }
            Err(error) => {
                let _ = result_tx.send(VideoToolboxFifoWriterResult::Error(error.to_string()));
                return;
            }
        }
    }
    if !stop.load(Ordering::Relaxed)
        && let Err(error) = sink.flush()
    {
        let _ = result_tx.send(VideoToolboxFifoWriterResult::Error(error.to_string()));
    }
}

#[cfg(target_os = "macos")]
enum VideoToolboxH264PipeWriter {
    AnnexB,
    MpegTs {
        writer: MpegTsH264Writer,
        access_unit_buffer: Vec<u8>,
        base_pts_90khz: Option<u64>,
    },
}

#[cfg(target_os = "macos")]
impl VideoToolboxH264PipeWriter {
    fn for_output(video_output: EncoderBridgeVideoOutput) -> Self {
        match video_output {
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => Self::MpegTs {
                writer: MpegTsH264Writer::new(),
                access_unit_buffer: Vec::new(),
                base_pts_90khz: None,
            },
            EncoderBridgeVideoOutput::RawYuv420p
            | EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => Self::AnnexB,
        }
    }

    #[cfg(test)]
    fn write_frame<W: StdWrite>(
        &mut self,
        sink: &mut W,
        frame: &VideoToolboxH264AnnexBFrame,
    ) -> io::Result<()> {
        let bytes = self.frame_bytes(frame)?;
        sink.write_all(bytes)
    }

    fn write_frame_until<W: StdWrite>(
        &mut self,
        sink: &mut W,
        frame: &VideoToolboxH264AnnexBFrame,
        stop: &AtomicBool,
        deadline: Instant,
        max_frame_age: Duration,
    ) -> io::Result<()> {
        let bytes = self.frame_bytes(frame)?;
        write_all_until(
            sink,
            bytes,
            stop,
            deadline,
            max_frame_age,
            FIFO_FRAME_WRITE_HARD_TIMEOUT,
            // Stop closes the sender and prevents new access units. Finish the
            // one already in flight so an ordinary user stop cannot manufacture
            // a bridge failure and strand a complete recording as recovery MKV.
            false,
        )
    }

    fn frame_bytes<'a>(
        &'a mut self,
        frame: &'a VideoToolboxH264AnnexBFrame,
    ) -> io::Result<&'a [u8]> {
        match self {
            Self::AnnexB => Ok(&frame.bytes),
            Self::MpegTs {
                writer,
                access_unit_buffer,
                base_pts_90khz,
            } => {
                let raw_pts_90khz = timing_to_90khz(
                    frame.timing.presentation_time_value,
                    frame.timing.presentation_time_scale,
                )
                .ok_or_else(|| {
                    io::Error::other("VideoToolbox frame timing cannot be mapped to MPEG-TS PTS")
                })?;
                // Rebase to the first frame: VideoToolbox stamps carry the
                // session-startup offset (seconds of host time), while the
                // audio leg starts at the shared video epoch = first frame.
                // Without this the container starts video ~startup-latency
                // AFTER audio (plan 023: 4000ms skew in the split baseline).
                let base = *base_pts_90khz.get_or_insert(raw_pts_90khz);
                let pts_90khz = raw_pts_90khz.saturating_sub(base);
                access_unit_buffer.clear();
                writer
                    .write_h264_access_unit(access_unit_buffer, pts_90khz, &frame.bytes)
                    .map(|_| ())?;
                Ok(access_unit_buffer)
            }
        }
    }
}

fn write_all_until<W: StdWrite>(
    sink: &mut W,
    mut bytes: &[u8],
    stop: &AtomicBool,
    mut deadline: Instant,
    progress_timeout: Duration,
    hard_timeout: Duration,
    cancel_on_stop: bool,
) -> io::Result<()> {
    let hard_deadline = Instant::now()
        .checked_add(hard_timeout)
        .unwrap_or_else(Instant::now);
    let mut consecutive_no_progress = 0_u32;
    while !bytes.is_empty() {
        if cancel_on_stop && stop.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Encoder FIFO writer stopped during a bounded write",
            ));
        }
        if Instant::now() >= deadline || Instant::now() >= hard_deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Encoder FIFO write exceeded the complete-frame delivery budget",
            ));
        }
        match sink.write(bytes) {
            Ok(0) => {
                consecutive_no_progress = consecutive_no_progress.saturating_add(1);
                wait_for_fifo_write_progress(consecutive_no_progress, deadline.min(hard_deadline));
            }
            Ok(written) => {
                bytes = &bytes[written..];
                consecutive_no_progress = 0;
                // Raw frames are indivisible. Once part of one reaches FFmpeg,
                // aborting on the original queue-age deadline leaves a terminal
                // short packet and corrupts/truncates the recording. Continued
                // byte progress proves the reader is alive, so use a sliding
                // no-progress deadline until this frame is complete.
                if !bytes.is_empty() {
                    deadline = Instant::now()
                        .checked_add(progress_timeout)
                        .unwrap_or_else(Instant::now)
                        .min(hard_deadline);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                consecutive_no_progress = consecutive_no_progress.saturating_add(1);
                wait_for_fifo_write_progress(consecutive_no_progress, deadline.min(hard_deadline));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn wait_for_fifo_write_progress(consecutive_no_progress: u32, deadline: Instant) {
    // A 1080p YUV420 frame is 3.11 MiB, while Unix FIFOs commonly accept only
    // a few KiB per nonblocking write. Sleeping milliseconds after every full
    // pipe therefore turns one frame into hundreds of sleeps (~800ms in the
    // Windows regression repro). While the reader is actively draining, yield
    // so it can run and retry immediately. Only back off once repeated attempts
    // show that no progress is being made; the caller's deadlines stay binding.
    if consecutive_no_progress <= FIFO_WRITE_PROGRESS_YIELD_BUDGET {
        thread::yield_now();
        return;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        thread::sleep(remaining.min(FIFO_WRITE_STALL_BACKOFF));
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn drain_video_toolbox_output_frames(
    video_toolbox: &mut EncoderBridgeVideoToolboxProbe,
    fifo_writer: &mut VideoToolboxFifoWriter,
    pending_video_toolbox_output_frames: &mut u64,
    pending_video_toolbox_fifo_frames: &mut u64,
    pending_video_toolbox_output_started_at: &mut HashMap<u64, Instant>,
    pending_video_toolbox_fifo_started_at: &mut VecDeque<Instant>,
    output_queue_capacity_pressure_events: &mut u64,
    video_toolbox_probe_errors: &mut u64,
    video_toolbox_fifo_enqueue_times_ms: &mut Vec<f64>,
    max_video_toolbox_fifo_enqueue_ms: &mut Option<f64>,
    max_frames: Option<usize>,
) -> io::Result<()> {
    let rejected_output_frames = video_toolbox.take_rejected_output_frames();
    fail_on_rejected_video_toolbox_output_frames(
        rejected_output_frames,
        output_queue_capacity_pressure_events,
        video_toolbox_probe_errors,
    )?;
    let mut drained = 0_usize;
    while max_frames.is_none_or(|limit| drained < limit) {
        let Some(message) = video_toolbox.try_recv_output() else {
            break;
        };
        let frame_index = message.frame_index;
        let submitted_at = pending_video_toolbox_output_started_at
            .remove(&frame_index)
            .unwrap_or_else(Instant::now);
        *pending_video_toolbox_output_frames =
            pending_video_toolbox_output_frames.saturating_sub(1);
        match message.result {
            Ok(frame) => {
                let enqueue_started_at = Instant::now();
                fifo_writer.enqueue(frame, submitted_at, output_queue_capacity_pressure_events)?;
                let enqueue_ms = enqueue_started_at.elapsed().as_secs_f64() * 1000.0;
                video_toolbox_fifo_enqueue_times_ms.push(enqueue_ms);
                *max_video_toolbox_fifo_enqueue_ms = Some(
                    max_video_toolbox_fifo_enqueue_ms
                        .map_or(enqueue_ms, |current| current.max(enqueue_ms)),
                );
                *pending_video_toolbox_fifo_frames =
                    pending_video_toolbox_fifo_frames.saturating_add(1);
                pending_video_toolbox_fifo_started_at.push_back(submitted_at);
            }
            Err(error) => {
                *video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
                return Err(io::Error::other(error));
            }
        }
        drained = drained.saturating_add(1);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn fail_on_rejected_video_toolbox_output_frames(
    rejected_output_frames: u64,
    output_queue_capacity_pressure_events: &mut u64,
    video_toolbox_probe_errors: &mut u64,
) -> io::Result<()> {
    if rejected_output_frames == 0 {
        return Ok(());
    }
    *output_queue_capacity_pressure_events =
        output_queue_capacity_pressure_events.saturating_add(rejected_output_frames);
    *video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(rejected_output_frames);
    Err(io::Error::other(format!(
        "bounded VideoToolbox callback queue rejected {rejected_output_frames} encoded frame(s); stopping this output because encoded H.264 access units cannot be dropped safely"
    )))
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn drain_video_toolbox_fifo_writer_results(
    fifo_writer: &mut VideoToolboxFifoWriter,
    pending_video_toolbox_fifo_frames: &mut u64,
    pending_video_toolbox_fifo_started_at: &mut VecDeque<Instant>,
    zero_copy_frames: &mut u64,
    video_toolbox_output_frames: &mut u64,
    video_toolbox_output_bytes: &mut u64,
    video_toolbox_fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    while let Some(result) = fifo_writer.try_recv_result() {
        match result {
            VideoToolboxFifoWriterResult::FrameWritten {
                encoded_bytes,
                write_ms,
            } => {
                *pending_video_toolbox_fifo_frames =
                    pending_video_toolbox_fifo_frames.saturating_sub(1);
                pending_video_toolbox_fifo_started_at.pop_front();
                *zero_copy_frames = zero_copy_frames.saturating_add(1);
                *video_toolbox_output_frames = video_toolbox_output_frames.saturating_add(1);
                *video_toolbox_output_bytes =
                    video_toolbox_output_bytes.saturating_add(encoded_bytes);
                video_toolbox_fifo_write_times_ms.push(write_ms);
            }
            VideoToolboxFifoWriterResult::Error(error) => {
                return Err(io::Error::other(error));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn oldest_pending_video_toolbox_frame_age(
    encoder_pending: &HashMap<u64, Instant>,
    fifo_pending: &VecDeque<Instant>,
) -> Option<Duration> {
    encoder_pending
        .values()
        .copied()
        .chain(fifo_pending.front().copied())
        .min()
        .map(|started_at| started_at.elapsed())
}

fn encoder_bridge_video_toolbox_probe_enabled() -> bool {
    parse_video_toolbox_probe_enabled(std::env::var(VIDEOTOOLBOX_PROBE_ENV).ok().as_deref())
}

fn parse_video_toolbox_probe_enabled(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn latest_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
) -> Option<FedCompositorFrame> {
    let frame = frame_store?
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .latest()?;
    #[cfg(target_os = "macos")]
    let metal_target = frame.metadata.metal_target_pixel_buffer();
    Some(FedCompositorFrame {
        frame: Arc::clone(&frame),
        sequence: frame.sequence,
        captured_at: frame.captured_at,
        age_ms: frame.captured_at.elapsed().as_millis() as u64,
        has_metal_iosurface_target: frame.pixel_format.has_metal_iosurface_target(),
        has_metal_export_handle: frame.metadata.has_metal_iosurface_target(),
        #[cfg(target_os = "macos")]
        metal_target,
    })
}

fn initial_bridge_wait_sequence(
    video_output: EncoderBridgeVideoOutput,
    frame_store: Option<&CompositorFrameStore>,
) -> Option<u64> {
    if video_output.uses_video_toolbox() {
        return None;
    }
    latest_compositor_frame(frame_store).map(|frame| frame.sequence)
}

fn next_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    previous_sequence: Option<u64>,
    wait_budget: Duration,
) -> Option<FedCompositorFrame> {
    if previous_sequence.is_none() || wait_budget.is_zero() {
        return latest_compositor_frame(frame_store);
    }

    let started_at = Instant::now();
    loop {
        let frame = latest_compositor_frame(frame_store);
        if frame
            .as_ref()
            .is_some_and(|frame| Some(frame.sequence) != previous_sequence)
            || started_at.elapsed() >= wait_budget
        {
            return frame;
        }
        let remaining = wait_budget.saturating_sub(started_at.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(2)));
    }
}

fn next_raw_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    previous_sequence: Option<u64>,
    wait_budget: Duration,
    expected_byte_len: usize,
) -> Option<FedCompositorFrame> {
    let frame = next_compositor_frame(frame_store, previous_sequence, wait_budget)?;
    (frame.frame.bytes.len() == expected_byte_len).then_some(frame)
}

fn open_recording_fifo_writer(
    path: &Path,
    stop: &AtomicBool,
    nonblocking_writes: bool,
) -> io::Result<File> {
    crate::fifo::open_writer(
        path,
        stop,
        Duration::from_millis(10),
        // Keep Unix FIFOs nonblocking. The VideoToolbox writer applies a
        // role-specific deadline and cancellation check around every partial
        // write, so a stalled FFmpeg reader cannot retain a worker forever.
        // Windows keeps the named pipe in PIPE_NOWAIT for the same bounded
        // writer contract; full buffers surface as zero-byte writes and retry
        // only until the role-specific deadline.
        !nonblocking_writes,
        "recording encoder bridge writer stopped before FIFO opened",
    )
}

fn emit_encoder_bridge_diagnostics_from_thread(
    diagnostics_tx: &watch::Sender<Option<EncoderBridgeWriterEvent>>,
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
) {
    let mut next = EncoderBridgeWriterEvent {
        session_id,
        target_fps,
        stats,
        diagnostics_context,
        error,
    };
    // Capacity-one/latest-wins diagnostics must never block the media writer.
    // Preserve a terminal error when final stats supersede it before the async
    // consumer observes the channel.
    diagnostics_tx.send_modify(move |current| {
        if next.error.is_none() {
            next.error = current.as_ref().and_then(|event| event.error.clone());
        }
        *current = Some(next);
    });
}

async fn read_encoder_progress(
    stderr: tokio::process::ChildStderr,
    progress: Arc<Mutex<EncoderBridgeProgress>>,
) -> EncoderBridgeProgress {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let Some(update) = parse_encoder_progress_line(&line) else {
            if is_ffmpeg_error_line(&line) {
                progress.lock().await.last_error = Some(line.trim().to_string());
            }
            continue;
        };
        let mut progress = progress.lock().await;
        if let Some(encoded_fps) = update.encoded_fps {
            progress.encoded_fps = Some(encoded_fps);
        }
        if let Some(encoder_speed) = update.encoder_speed {
            progress.encoder_speed = Some(encoder_speed);
        }
        if let Some(dropped_frames) = update.dropped_frames {
            progress.dropped_frames = dropped_frames;
        }
    }
    progress.lock().await.clone()
}

#[derive(Debug, Default, PartialEq)]
struct EncoderProgressUpdate {
    encoded_fps: Option<f64>,
    encoder_speed: Option<f64>,
    dropped_frames: Option<u64>,
}

fn parse_encoder_progress_line(line: &str) -> Option<EncoderProgressUpdate> {
    let update = EncoderProgressUpdate {
        encoded_fps: parse_stat_f64(line, "fps="),
        encoder_speed: parse_stat_f64(line, "speed="),
        dropped_frames: parse_stat_u64(line, "drop_frames=")
            .or_else(|| parse_stat_u64(line, "drop=")),
    };
    if update.encoded_fps.is_none()
        && update.encoder_speed.is_none()
        && update.dropped_frames.is_none()
    {
        return None;
    }
    Some(update)
}

fn parse_stat_f64(line: &str, label: &str) -> Option<f64> {
    stat_value(line, label)?
        .trim_end_matches('x')
        .parse::<f64>()
        .ok()
}

fn parse_stat_u64(line: &str, label: &str) -> Option<u64> {
    stat_value(line, label)?.parse::<u64>().ok()
}

fn stat_value<'line>(line: &'line str, label: &str) -> Option<&'line str> {
    let start = line.find(label)? + label.len();
    let tail = &line[start..];
    let value = tail.split_whitespace().next()?.trim();
    if value.is_empty() || value == "N/A" {
        None
    } else {
        Some(value)
    }
}

fn is_ffmpeg_error_line(line: &str) -> bool {
    let normalized = line.to_lowercase();
    normalized.contains("error") || normalized.contains("failed") || normalized.contains("invalid")
}

// --- Recording-leg degraded watch (plan 023 L4) ----------------------------
// The recording leg's input fps sitting below 80% of target for 5s is a
// mid-session quality incident (the owner found a 9fps 4K file AFTER the
// stream): say so while there is still time to act, like the mic-silent
// warning. Pure decision core; the diagnostics consumer drives it.

const RECORDING_DEGRADED_FPS_RATIO: f64 = 0.8;
const RECORDING_DEGRADED_HOLD_MS: u128 = 5_000;

#[derive(Default)]
pub(crate) struct RecordingFpsWatch {
    session_id: String,
    low_since_ms: Option<u128>,
    fired: bool,
}

/// Feed one recording-leg diagnostics sample; returns true exactly once per
/// session when the low-fps condition has held for the full window.
pub(crate) fn recording_fps_watch_update(
    watch: &mut RecordingFpsWatch,
    session_id: &str,
    input_fps: Option<f64>,
    target_fps: u32,
    now_ms: u128,
) -> bool {
    if watch.session_id != session_id {
        *watch = RecordingFpsWatch {
            session_id: session_id.to_string(),
            ..RecordingFpsWatch::default()
        };
    }
    let Some(input_fps) = input_fps else {
        return false;
    };
    if target_fps == 0 || watch.fired {
        return false;
    }
    if input_fps >= f64::from(target_fps) * RECORDING_DEGRADED_FPS_RATIO {
        watch.low_since_ms = None;
        return false;
    }
    let since = *watch.low_since_ms.get_or_insert(now_ms);
    if now_ms.saturating_sub(since) >= RECORDING_DEGRADED_HOLD_MS {
        watch.fired = true;
        return true;
    }
    false
}

static RECORDING_FPS_WATCH: std::sync::Mutex<Option<RecordingFpsWatch>> =
    std::sync::Mutex::new(None);

#[derive(Default)]
struct RecordingQueueDropWatch {
    session_id: String,
    fired: bool,
}

fn recording_queue_drop_watch_update(
    watch: &mut RecordingQueueDropWatch,
    session_id: &str,
    dropped_frames: u64,
) -> bool {
    if watch.session_id != session_id {
        *watch = RecordingQueueDropWatch {
            session_id: session_id.to_string(),
            ..RecordingQueueDropWatch::default()
        };
    }
    if dropped_frames == 0 || watch.fired {
        return false;
    }
    watch.fired = true;
    true
}

static RECORDING_QUEUE_DROP_WATCH: std::sync::Mutex<Option<RecordingQueueDropWatch>> =
    std::sync::Mutex::new(None);

async fn emit_encoder_bridge_diagnostics(
    state: &AppState,
    session_id: &str,
    target_fps: u32,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
) {
    if matches!(
        effective_encoder_bridge_output_role(diagnostics_context),
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared
    ) {
        let fire = {
            let mut guard = RECORDING_QUEUE_DROP_WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let watch = guard.get_or_insert_with(RecordingQueueDropWatch::default);
            recording_queue_drop_watch_update(
                watch,
                session_id,
                runtime.output_queue_dropped_frames,
            )
        };
        if fire {
            let message = format!(
                "Recording output could not keep up: {} video frame(s) were replaced before they reached FFmpeg. The saved file may be choppy or shorter than expected.",
                runtime.output_queue_dropped_frames
            );
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "recording-output-queue-drops",
                &message,
            );
        }
    }

    // L4 (plan 023): announce a degraded recording leg mid-session.
    if matches!(
        diagnostics_context.role,
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared
    ) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let fire = {
            let mut guard = RECORDING_FPS_WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let watch = guard.get_or_insert_with(RecordingFpsWatch::default);
            recording_fps_watch_update(watch, session_id, runtime.input_fps, target_fps, now_ms)
        };
        if fire {
            let message = format!(
                "Recording quality is degraded while streaming: the recording leg is producing                  {:.0} fps against the selected {target_fps} fps. The stream continues; the                  saved file will be choppy.",
                runtime.input_fps.unwrap_or(0.0)
            );
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "recording-degraded",
                &message,
            );
        }
    }

    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let base = if diagnostics.session_id.as_deref() == Some(session_id) {
            diagnostics.clone()
        } else {
            starting_diagnostics(session_id, target_fps, "encoder-bridge")
        };
        let recording_output = diagnostics_context.recording_output;
        let stream_output = diagnostics_context.stream_output;
        let (
            recording_output_frames,
            recording_output_bytes,
            stream_output_frames,
            stream_output_bytes,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.video_toolbox_output_frames,
                runtime.video_toolbox_output_bytes,
                base.encoder_bridge_stream_video_toolbox_output_frames,
                base.encoder_bridge_stream_video_toolbox_output_bytes,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_video_toolbox_output_frames,
                base.encoder_bridge_recording_video_toolbox_output_bytes,
                runtime.video_toolbox_output_frames,
                runtime.video_toolbox_output_bytes,
            ),
            EncoderBridgeOutputRole::Shared => (0, 0, 0, 0),
        };
        let video_toolbox_output_frames = if diagnostics_context.separate_output_encoders_active {
            recording_output_frames.saturating_add(stream_output_frames)
        } else {
            runtime.video_toolbox_output_frames
        };
        let video_toolbox_output_bytes = if diagnostics_context.separate_output_encoders_active {
            recording_output_bytes.saturating_add(stream_output_bytes)
        } else {
            runtime.video_toolbox_output_bytes
        };
        let max_option = |left: Option<f64>, right: Option<f64>| match (left, right) {
            (Some(left), Some(right)) => Some(left.max(right)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };
        let (
            recording_input_fps,
            stream_input_fps,
            recording_writer_loop_p95_ms,
            stream_writer_loop_p95_ms,
            recording_writer_active_p95_ms,
            stream_writer_active_p95_ms,
            recording_video_toolbox_fifo_enqueue_p95_ms,
            stream_video_toolbox_fifo_enqueue_p95_ms,
            recording_video_toolbox_fifo_enqueue_max_ms,
            stream_video_toolbox_fifo_enqueue_max_ms,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.input_fps,
                base.encoder_bridge_stream_input_fps,
                runtime.writer_loop_p95_ms,
                base.encoder_bridge_stream_writer_loop_p95_ms,
                runtime.writer_active_p95_ms,
                base.encoder_bridge_stream_writer_active_p95_ms,
                runtime.video_toolbox_fifo_enqueue_p95_ms,
                base.encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms,
                runtime.video_toolbox_fifo_enqueue_max_ms,
                base.encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_input_fps,
                runtime.input_fps,
                base.encoder_bridge_recording_writer_loop_p95_ms,
                runtime.writer_loop_p95_ms,
                base.encoder_bridge_recording_writer_active_p95_ms,
                runtime.writer_active_p95_ms,
                base.encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms,
                runtime.video_toolbox_fifo_enqueue_p95_ms,
                base.encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms,
                runtime.video_toolbox_fifo_enqueue_max_ms,
            ),
            EncoderBridgeOutputRole::Shared => {
                (None, None, None, None, None, None, None, None, None, None)
            }
        };
        let writer_loop_p95_ms = if diagnostics_context.separate_output_encoders_active {
            max_option(recording_writer_loop_p95_ms, stream_writer_loop_p95_ms)
        } else {
            runtime.writer_loop_p95_ms
        };
        let writer_active_p95_ms = if diagnostics_context.separate_output_encoders_active {
            max_option(recording_writer_active_p95_ms, stream_writer_active_p95_ms)
        } else {
            runtime.writer_active_p95_ms
        };
        let video_toolbox_fifo_enqueue_p95_ms =
            if diagnostics_context.separate_output_encoders_active {
                max_option(
                    recording_video_toolbox_fifo_enqueue_p95_ms,
                    stream_video_toolbox_fifo_enqueue_p95_ms,
                )
            } else {
                runtime.video_toolbox_fifo_enqueue_p95_ms
            };
        let video_toolbox_fifo_enqueue_max_ms =
            if diagnostics_context.separate_output_encoders_active {
                max_option(
                    recording_video_toolbox_fifo_enqueue_max_ms,
                    stream_video_toolbox_fifo_enqueue_max_ms,
                )
            } else {
                runtime.video_toolbox_fifo_enqueue_max_ms
            };
        let (
            recording_queue_depth,
            recording_queue_oldest_frame_age_ms,
            recording_queue_capacity_pressure_events,
            recording_queue_dropped_frames,
            stream_queue_depth,
            stream_queue_oldest_frame_age_ms,
            stream_queue_capacity_pressure_events,
            stream_queue_dropped_frames,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.queue_depth,
                runtime.output_queue_oldest_frame_age_ms,
                runtime.output_queue_capacity_pressure_events,
                runtime.output_queue_dropped_frames,
                base.encoder_bridge_stream_queue_depth,
                base.encoder_bridge_stream_queue_oldest_frame_age_ms,
                base.encoder_bridge_stream_queue_capacity_pressure_events,
                base.encoder_bridge_stream_queue_dropped_frames,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_queue_depth,
                base.encoder_bridge_recording_queue_oldest_frame_age_ms,
                base.encoder_bridge_recording_queue_capacity_pressure_events,
                base.encoder_bridge_recording_queue_dropped_frames,
                runtime.queue_depth,
                runtime.output_queue_oldest_frame_age_ms,
                runtime.output_queue_capacity_pressure_events,
                runtime.output_queue_dropped_frames,
            ),
            EncoderBridgeOutputRole::Shared => (
                recording_output.map_or(0, |_| runtime.queue_depth),
                recording_output.and(runtime.output_queue_oldest_frame_age_ms),
                recording_output.map_or(0, |_| runtime.output_queue_capacity_pressure_events),
                recording_output.map_or(0, |_| runtime.output_queue_dropped_frames),
                stream_output.map_or(0, |_| runtime.queue_depth),
                stream_output.and(runtime.output_queue_oldest_frame_age_ms),
                stream_output.map_or(0, |_| runtime.output_queue_capacity_pressure_events),
                stream_output.map_or(0, |_| runtime.output_queue_dropped_frames),
            ),
        };
        let output_queue_oldest_frame_age_ms =
            if diagnostics_context.separate_output_encoders_active {
                match (
                    recording_queue_oldest_frame_age_ms,
                    stream_queue_oldest_frame_age_ms,
                ) {
                    (Some(recording), Some(stream)) => Some(recording.max(stream)),
                    (Some(age), None) | (None, Some(age)) => Some(age),
                    (None, None) => None,
                }
            } else {
                runtime.output_queue_oldest_frame_age_ms
            };
        let output_queue_capacity_pressure_events =
            if diagnostics_context.separate_output_encoders_active {
                recording_queue_capacity_pressure_events
                    .saturating_add(stream_queue_capacity_pressure_events)
            } else {
                runtime.output_queue_capacity_pressure_events
            };
        let output_queue_dropped_frames = if diagnostics_context.separate_output_encoders_active {
            recording_queue_dropped_frames.saturating_add(stream_queue_dropped_frames)
        } else {
            runtime.output_queue_dropped_frames
        };
        let queue_depth = if diagnostics_context.separate_output_encoders_active {
            recording_queue_depth.saturating_add(stream_queue_depth)
        } else {
            runtime.queue_depth
        };
        let error = if diagnostics_context.separate_output_encoders_active {
            error.or_else(|| base.encoder_bridge_error.clone())
        } else {
            error
        };
        let next = apply_encoder_bridge_stats(
            base,
            EncoderBridgeDiagnosticSnapshot {
                queue_depth,
                output_queue_oldest_frame_age_ms,
                output_queue_capacity_pressure_events,
                output_queue_dropped_frames,
                input_fps: runtime.input_fps,
                dropped_frames: runtime.dropped_frames,
                encoder_speed: runtime.encoder_speed,
                repeated_fed_frames: runtime.repeated_fed_frames,
                repeated_frame_bursts: runtime.repeated_frame_bursts,
                max_repeated_frame_run: runtime.max_repeated_frame_run,
                synthetic_fallback_frames: runtime.synthetic_fallback_frames,
                source_to_encode_age_ms: runtime.source_to_encode_age_ms,
                source_to_encode_age_p95_ms: runtime.source_to_encode_age_p95_ms,
                repeated_frame_age_p95_ms: runtime.repeated_frame_age_p95_ms,
                repeated_frame_age_max_ms: runtime.repeated_frame_age_max_ms,
                metal_target_frames: runtime.metal_target_frames,
                raw_video_copied_frames: runtime.raw_video_copied_frames,
                metal_target_copied_frames: runtime.metal_target_copied_frames,
                metal_target_handle_frames: runtime.metal_target_handle_frames,
                zero_copy_frames: runtime.zero_copy_frames,
                video_toolbox_probe_frames: runtime.video_toolbox_probe_frames,
                video_toolbox_probe_bytes: runtime.video_toolbox_probe_bytes,
                video_toolbox_probe_errors: runtime.video_toolbox_probe_errors,
                video_toolbox_output_frames,
                video_toolbox_output_bytes,
                video_toolbox_output_encode_ms: runtime.video_toolbox_output_encode_ms,
                recording_output_width: recording_output.map(|output| output.width),
                recording_output_height: recording_output.map(|output| output.height),
                recording_output_fps: recording_output.map(|output| output.fps),
                recording_output_bitrate_kbps: recording_output.map(|output| output.bitrate_kbps),
                stream_output_width: stream_output.map(|output| output.width),
                stream_output_height: stream_output.map(|output| output.height),
                stream_output_fps: stream_output.map(|output| output.fps),
                stream_output_bitrate_kbps: stream_output.map(|output| output.bitrate_kbps),
                active_video_toolbox_output_encoders: diagnostics_context
                    .active_video_toolbox_output_encoders,
                recording_video_toolbox_output_frames: recording_output_frames,
                recording_video_toolbox_output_bytes: recording_output_bytes,
                stream_video_toolbox_output_frames: stream_output_frames,
                stream_video_toolbox_output_bytes: stream_output_bytes,
                separate_output_encoders_active: diagnostics_context
                    .separate_output_encoders_active,
                compositor_wait_p95_ms: runtime.compositor_wait_p95_ms,
                video_toolbox_submit_p95_ms: runtime.video_toolbox_submit_p95_ms,
                raw_video_fifo_write_p95_ms: runtime.raw_video_fifo_write_p95_ms,
                video_toolbox_fifo_write_p95_ms: runtime.video_toolbox_fifo_write_p95_ms,
                video_toolbox_fifo_enqueue_p95_ms,
                video_toolbox_fifo_enqueue_max_ms,
                writer_loop_p95_ms,
                writer_sleep_p95_ms: runtime.writer_sleep_p95_ms,
                writer_active_p95_ms,
                deadline_lag_p95_ms: runtime.deadline_lag_p95_ms,
                deadline_lag_max_ms: runtime.deadline_lag_max_ms,
                late_deadline_ticks: runtime.late_deadline_ticks,
                schedule_skipped_ms: runtime.schedule_skipped_ms,
                recording_input_fps,
                stream_input_fps,
                recording_queue_depth,
                recording_queue_oldest_frame_age_ms,
                recording_queue_capacity_pressure_events,
                recording_queue_dropped_frames,
                stream_queue_depth,
                stream_queue_oldest_frame_age_ms,
                stream_queue_capacity_pressure_events,
                stream_queue_dropped_frames,
                recording_writer_loop_p95_ms,
                stream_writer_loop_p95_ms,
                recording_writer_active_p95_ms,
                stream_writer_active_p95_ms,
                recording_video_toolbox_fifo_enqueue_p95_ms,
                stream_video_toolbox_fifo_enqueue_p95_ms,
                recording_video_toolbox_fifo_enqueue_max_ms,
                stream_video_toolbox_fifo_enqueue_max_ms,
                error,
            },
            target_fps,
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

fn measured_input_fps(frames_written: u64, started_at: Instant) -> Option<f64> {
    if frames_written == 0 {
        return None;
    }
    Some(frames_written as f64 / started_at.elapsed().as_secs_f64().max(0.001))
}

fn encoder_bridge_input_frame_count(
    video_output: EncoderBridgeVideoOutput,
    scheduled_frames: u64,
    raw_delivered_frames: u64,
) -> u64 {
    if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
        raw_delivered_frames
    } else {
        scheduled_frames
    }
}

fn p95_ms(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let index = (((95.0 / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    Some(sorted[index])
}

fn frame_count(duration_ms: u64, fps: u32) -> u64 {
    duration_ms
        .saturating_mul(u64::from(fps))
        .saturating_add(999)
        / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_channel_is_latest_wins_without_losing_terminal_error() {
        let (tx, rx) = watch::channel::<Option<EncoderBridgeWriterEvent>>(None);
        emit_encoder_bridge_diagnostics_from_thread(
            &tx,
            "session".to_string(),
            30,
            EncoderBridgeRuntimeStats {
                queue_depth: 1,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            Some("encoder failed".to_string()),
        );
        emit_encoder_bridge_diagnostics_from_thread(
            &tx,
            "session".to_string(),
            30,
            EncoderBridgeRuntimeStats {
                queue_depth: 2,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            None,
        );

        let latest = rx.borrow().clone().expect("latest diagnostics event");
        assert_eq!(latest.stats.queue_depth, 2);
        assert_eq!(latest.error.as_deref(), Some("encoder failed"));
    }

    #[test]
    fn stream_policy_coalesces_before_encode_then_fails_at_the_hard_latency_ceiling() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..EncoderBridgeDiagnosticsContext::default()
        });

        assert_eq!(policy.max_frames, 8);
        assert_eq!(policy.max_age, Duration::from_millis(150));
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 3, Some(Duration::from_millis(99))),
            EncoderBridgePreEncodeAdmission::Submit
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 4, Some(Duration::from_millis(35))),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 2, Some(Duration::from_millis(100))),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 8, Some(Duration::from_millis(35))),
            EncoderBridgePreEncodeAdmission::FailOutput
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 2, Some(Duration::from_millis(150))),
            EncoderBridgePreEncodeAdmission::FailOutput
        );
    }

    #[test]
    fn recording_policy_preserves_every_frame_and_fails_before_hidden_latency() {
        for role in [
            EncoderBridgeOutputRole::Recording,
            EncoderBridgeOutputRole::Shared,
        ] {
            let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
                role,
                ..EncoderBridgeDiagnosticsContext::default()
            });
            assert_eq!(policy.coalesce_at_frames, None);
            assert_eq!(policy.coalesce_at_age, None);
            assert_eq!(policy.max_frames, 16);
            assert_eq!(policy.max_age, Duration::from_millis(250));
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 15, Some(Duration::from_millis(249))),
                EncoderBridgePreEncodeAdmission::Submit
            );
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 16, Some(Duration::from_millis(99))),
                EncoderBridgePreEncodeAdmission::FailOutput
            );
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 4, Some(Duration::from_millis(250))),
                EncoderBridgePreEncodeAdmission::FailOutput
            );
        }
    }

    #[test]
    fn hard_pressure_error_names_the_role_budget_and_integrity_choice() {
        let recording_policy =
            encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
                role: EncoderBridgeOutputRole::Recording,
                ..EncoderBridgeDiagnosticsContext::default()
            });
        let recording_error = encoder_bridge_output_pressure_error(
            recording_policy,
            16,
            Some(Duration::from_millis(251)),
        )
        .to_string();
        assert!(recording_error.contains("recording encoder output"));
        assert!(recording_error.contains("depth 16/16"));
        assert!(recording_error.contains("oldest 251/250ms"));
        assert!(recording_error.contains("recording frames were preserved"));

        let stream_policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..EncoderBridgeDiagnosticsContext::default()
        });
        let stream_error = encoder_bridge_output_pressure_error(
            stream_policy,
            8,
            Some(Duration::from_millis(151)),
        )
        .to_string();
        assert!(stream_error.contains("stream encoder output"));
        assert!(stream_error.contains("encoded H.264 access units were preserved"));
    }

    #[test]
    fn stream_only_shared_diagnostics_use_stream_overload_policy() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Shared,
            recording_output: None,
            stream_output: Some(EncoderBridgeOutputProfile {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6_000,
            }),
            ..EncoderBridgeDiagnosticsContext::default()
        });

        assert_eq!(policy.role, EncoderBridgeOutputRole::Stream);
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 4, None),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
    }

    #[test]
    fn bounded_fifo_offer_reports_pressure_without_blocking_the_realtime_bridge() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        frame_tx.send(1_u64).expect("fill bounded queue");
        let offered = offer_preserving_output_frame(&frame_tx, 2_u64)
            .expect("bounded FIFO remains connected");
        let PreservingOutputFrameOffer::CapacityPressure(preserved) = offered else {
            panic!("full FIFO must report capacity pressure")
        };
        assert_eq!(preserved, 2);
        assert_eq!(frame_rx.recv().expect("drain oldest frame"), 1);
    }

    #[test]
    fn busy_raw_fifo_replaces_the_pending_frame_with_the_latest_tick() {
        let mailbox = LatestRawVideoFrameMailbox::default();
        assert!(matches!(
            mailbox.offer(QueuedRawVideoFrame::synthetic(vec![1], Instant::now())),
            Ok(LatestRawVideoFrameOffer::Enqueued)
        ));
        let replaced = mailbox
            .offer(QueuedRawVideoFrame::synthetic(vec![2], Instant::now()))
            .unwrap_or_else(|_| panic!("latest frame mailbox remains open"));
        let LatestRawVideoFrameOffer::Replaced(frame) = replaced else {
            panic!("second tick must replace the pending first tick")
        };
        assert_eq!(frame.into_synthetic_buffer(), Some(vec![1]));
        assert_eq!(
            mailbox
                .receive()
                .and_then(QueuedRawVideoFrame::into_synthetic_buffer),
            Some(vec![2])
        );
    }

    #[test]
    fn raw_bridge_cadence_counts_only_frames_delivered_to_ffmpeg() {
        assert_eq!(
            encoder_bridge_input_frame_count(EncoderBridgeVideoOutput::RawYuv420p, 30, 11),
            11
        );
        assert_eq!(
            encoder_bridge_input_frame_count(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                30,
                11,
            ),
            30
        );
    }

    #[test]
    fn recording_session_exposes_the_first_terminal_bridge_failure() {
        let terminal_failure = Arc::new(StdMutex::new(None));
        let session = EncoderBridgeRecordingSession {
            stop: Arc::new(AtomicBool::new(false)),
            terminal_failure: terminal_failure.clone(),
            startup_ready: None,
            fifo_path: std::env::temp_dir().join(format!(
                "videorc-missing-terminal-signal-test-{}",
                Uuid::new_v4()
            )),
            writer: None,
            diagnostics_task: None,
        };

        assert_eq!(session.terminal_failure(), None);
        record_encoder_bridge_terminal_failure(&terminal_failure, "raw FIFO timed out");
        record_encoder_bridge_terminal_failure(&terminal_failure, "later secondary error");

        assert_eq!(
            session.terminal_failure().as_deref(),
            Some("raw FIFO timed out")
        );
    }

    #[test]
    fn raw_fifo_writer_returns_the_owned_buffer_after_an_ordered_write() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(2);
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        let sink = SharedCountingSink::default();
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(
                vec![1, 2, 3, 4],
                Instant::now(),
            ))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            sink.clone(),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(250),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(sink.bytes(), vec![1, 2, 3, 4]);
        let result = result_rx.recv().expect("raw writer result");
        let RawVideoFifoWriterResult::FrameWritten {
            synthetic_buffer, ..
        } = result
        else {
            panic!("raw frame must be reported as written")
        };
        assert_eq!(synthetic_buffer, Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn raw_fifo_writer_reads_and_releases_the_shared_compositor_allocation() {
        let width = 8;
        let height = 8;
        let expected = vec![0x5a; raw_yuv420p_len(width, height).unwrap()];
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            1,
        )));
        let published = publish_test_compositor_frame(&frame_store, 1, width, height, &expected);
        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("shared compositor frame");
        assert!(Arc::ptr_eq(&published, &fed.frame));

        let queued = QueuedRawVideoFrame::compositor(&fed, Instant::now());
        assert_eq!(queued.bytes().as_ptr(), published.bytes.as_ptr());
        let retained_before_write = Arc::strong_count(&published);
        drop(fed);

        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let sink = SharedCountingSink::default();
        frame_tx.send(queued).expect("queue shared raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            sink.clone(),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(250),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(sink.bytes(), expected);
        let result = result_rx.recv().expect("raw writer result");
        let RawVideoFifoWriterResult::FrameWritten {
            synthetic_buffer, ..
        } = result
        else {
            panic!("shared raw frame must be reported as written")
        };
        assert!(synthetic_buffer.is_none());
        assert_eq!(Arc::strong_count(&published), retained_before_write - 2);
    }

    #[test]
    fn slow_raw_writer_consumes_pending_latest_frames_without_waiting_for_another_tick() {
        let mailbox = Arc::new(LatestRawVideoFrameMailbox::default());
        let writer_mailbox = mailbox.clone();
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        let (first_write_started_tx, first_write_started_rx) = std_mpsc::sync_channel(1);
        let (release_first_write_tx, release_first_write_rx) = std_mpsc::sync_channel(1);
        let sink = SharedCountingSink::default();
        let writer_sink = sink.clone();
        let writer = thread::spawn(move || {
            run_raw_video_fifo_writer_loop_with_receiver(
                GatedFirstWriteSink {
                    written: writer_sink,
                    first_write_started: Some(first_write_started_tx),
                    release_first_write: release_first_write_rx,
                },
                || writer_mailbox.receive(),
                result_tx,
                Arc::new(AtomicBool::new(false)),
                Duration::from_millis(250),
                Arc::new(StdMutex::new(None)),
                EncoderBridgeOutputRole::Recording,
            );
        });

        assert!(matches!(
            mailbox
                .offer(QueuedRawVideoFrame::synthetic(vec![0], Instant::now()))
                .unwrap_or_else(|_| panic!("raw mailbox remains open")),
            LatestRawVideoFrameOffer::Enqueued
        ));
        first_write_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer starts the first frame");
        assert!(matches!(
            mailbox
                .offer(QueuedRawVideoFrame::synthetic(vec![1], Instant::now()))
                .unwrap_or_else(|_| panic!("raw mailbox remains open")),
            LatestRawVideoFrameOffer::Enqueued
        ));
        let replacement = mailbox
            .offer(QueuedRawVideoFrame::synthetic(vec![2], Instant::now()))
            .unwrap_or_else(|_| panic!("raw mailbox remains open"));
        let LatestRawVideoFrameOffer::Replaced(replaced) = replacement else {
            panic!("latest tick must replace the pending frame while the writer is blocked")
        };
        assert_eq!(replaced.into_synthetic_buffer(), Some(vec![1]));
        mailbox.close();
        release_first_write_tx
            .send(())
            .expect("release the first frame write");
        writer.join().expect("slow raw writer joins");

        let delivered = result_rx
            .try_iter()
            .filter(|result| matches!(result, RawVideoFifoWriterResult::FrameWritten { .. }))
            .count();
        assert_eq!(delivered, 2);
        assert_eq!(sink.bytes(), vec![0, 2]);
    }

    #[test]
    fn synthetic_buffer_recycling_retains_at_most_one_spare() {
        let mut recycled = None;
        retain_recycled_synthetic_buffer(&mut recycled, Some(vec![1; 4]));
        retain_recycled_synthetic_buffer(&mut recycled, Some(vec![2; 8]));

        assert_eq!(recycled.as_deref(), Some([1, 1, 1, 1].as_slice()));
        let reused = take_recycled_synthetic_buffer(&mut recycled, 6);
        assert_eq!(reused.len(), 6);
        assert!(recycled.is_none());
    }

    #[test]
    fn raw_fifo_writer_uses_a_windows_safe_complete_frame_timeout() {
        #[cfg(target_os = "windows")]
        assert_eq!(
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            Duration::from_secs(30)
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            FIFO_FRAME_WRITE_HARD_TIMEOUT
        );
    }

    #[test]
    fn raw_fifo_writer_finishes_an_inflight_frame_when_stop_arrives_mid_write() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let stop = Arc::new(AtomicBool::new(false));
        let written = SharedCountingSink::default();
        let frame = vec![1, 2, 3, 4, 5, 6, 7, 8];
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(
                frame.clone(),
                Instant::now(),
            ))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            StopAfterPartialWriteSink {
                written: written.clone(),
                stop: stop.clone(),
                first_write: true,
            },
            frame_rx,
            result_tx,
            stop,
            Duration::from_millis(250),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(written.bytes(), frame);
        let result = result_rx.recv().expect("raw writer result");
        assert!(matches!(
            result,
            RawVideoFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[test]
    fn raw_fifo_writer_finishes_a_frame_while_the_reader_keeps_making_progress() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let written = SharedCountingSink::default();
        let frame = vec![1, 2, 3, 4, 5, 6, 7, 8];
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(
                frame.clone(),
                Instant::now(),
            ))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            SlowProgressSink {
                written: written.clone(),
                chunk_size: 2,
                delay: Duration::from_millis(12),
            },
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(20),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(written.bytes(), frame);
        let result = result_rx.recv().expect("raw writer result");
        assert!(matches!(
            result,
            RawVideoFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[test]
    fn intermittent_pipe_pressure_does_not_throttle_a_full_hd_raw_frame() {
        for pressure in [PipePressure::WouldBlock, PipePressure::ZeroWrite] {
            let mut sink = AlternatingBackpressureSink {
                written: 0,
                chunk_size: 8 * 1024,
                pressure_next: true,
                pressure,
            };
            let stop = AtomicBool::new(false);
            let bytes = vec![7; raw_yuv420p_len(1920, 1080).expect("1080p frame size")];
            let deadline = Instant::now() + Duration::from_millis(500);

            write_all_until(
                &mut sink,
                &bytes,
                &stop,
                deadline,
                Duration::from_millis(500),
                Duration::from_millis(500),
                false,
            )
            .expect("active FIFO draining must not pay a millisecond sleep per pipe-sized chunk");

            assert_eq!(sink.written, bytes.len());
        }
    }

    #[test]
    fn progressing_fifo_write_still_honors_a_complete_frame_hard_limit() {
        let written = SharedCountingSink::default();
        let mut sink = SlowProgressSink {
            written: written.clone(),
            chunk_size: 1,
            delay: Duration::from_millis(10),
        };
        let stop = AtomicBool::new(false);
        let bytes = vec![7; 100];
        let started_at = Instant::now();

        let error = write_all_until(
            &mut sink,
            &bytes,
            &stop,
            Instant::now() + Duration::from_millis(20),
            Duration::from_millis(20),
            Duration::from_millis(55),
            false,
        )
        .expect_err("continuous one-byte progress must not keep shutdown blocked forever");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started_at.elapsed() < Duration::from_millis(250));
        assert!(written.bytes().len() < bytes.len());
    }

    #[test]
    fn stalled_raw_fifo_writer_times_out_without_blocking_the_scheduler() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(
                vec![0x44; 64],
                Instant::now(),
            ))
            .expect("queue raw frame");
        drop(frame_tx);

        let started_at = Instant::now();
        let terminal_failure = Arc::new(StdMutex::new(None));
        run_raw_video_fifo_writer_loop(
            AlwaysWouldBlockSink,
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(20),
            terminal_failure.clone(),
            EncoderBridgeOutputRole::Recording,
        );

        assert!(started_at.elapsed() < Duration::from_millis(500));
        let result = result_rx.recv().expect("terminal raw writer result");
        let RawVideoFifoWriterResult::Error { message, .. } = result else {
            panic!("stalled raw writer must fail explicitly")
        };
        assert!(message.contains("complete-frame delivery budget"));
        assert_eq!(
            read_encoder_bridge_terminal_failure(&terminal_failure).as_deref(),
            Some(message.as_str())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn callback_queue_rejection_is_counted_and_fails_output_explicitly() {
        let mut capacity_pressure_events = 3;
        let mut encoder_errors = 5;

        let error = fail_on_rejected_video_toolbox_output_frames(
            2,
            &mut capacity_pressure_events,
            &mut encoder_errors,
        )
        .expect_err("an encoded-frame rejection must stop the affected output");

        assert_eq!(capacity_pressure_events, 5);
        assert_eq!(encoder_errors, 7);
        assert!(error.to_string().contains("cannot be dropped safely"));
    }

    // Plan 023 L4: the recording-degraded watch fires exactly once per session
    // after the low-fps condition holds for the full 5s window.
    #[test]
    fn recording_fps_watch_fires_once_after_sustained_low_fps() {
        use super::{RecordingFpsWatch, recording_fps_watch_update};
        let mut watch = RecordingFpsWatch::default();
        // Healthy: 30 target, 29 input — never fires.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(29.0),
            30,
            0
        ));
        // Low but not yet sustained.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            1_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            4_000
        ));
        // Recovery resets the window.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(28.0),
            30,
            5_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            6_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            10_000
        ));
        // Sustained past the hold window: fire once…
        assert!(recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            11_100
        ));
        // …and never again for the same session.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(2.0),
            30,
            30_000
        ));
        // A NEW session re-arms.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s2",
            Some(9.0),
            30,
            40_000
        ));
        assert!(recording_fps_watch_update(
            &mut watch,
            "s2",
            Some(9.0),
            30,
            45_100
        ));
        // Missing fps samples and zero targets never fire.
        assert!(!recording_fps_watch_update(
            &mut watch, "s3", None, 30, 50_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s3",
            Some(1.0),
            0,
            55_100
        ));
    }

    #[test]
    fn recording_queue_drop_watch_surfaces_each_affected_session_once() {
        let mut watch = RecordingQueueDropWatch::default();
        assert!(!recording_queue_drop_watch_update(&mut watch, "s1", 0));
        assert!(recording_queue_drop_watch_update(&mut watch, "s1", 1));
        assert!(!recording_queue_drop_watch_update(&mut watch, "s1", 9));
        assert!(!recording_queue_drop_watch_update(&mut watch, "s2", 0));
        assert!(recording_queue_drop_watch_update(&mut watch, "s2", 2));
    }

    use crate::compositor::{CompositorFrameExportHandle, CompositorPixelFormat};
    #[cfg(target_os = "macos")]
    use crate::metal_compositor::{GpuSource, GpuSourceKind, MetalSceneCompositor};

    #[test]
    fn video_toolbox_probe_env_is_opt_in() {
        assert!(!parse_video_toolbox_probe_enabled(None));
        assert!(!parse_video_toolbox_probe_enabled(Some("")));
        assert!(!parse_video_toolbox_probe_enabled(Some("0")));
        assert!(!parse_video_toolbox_probe_enabled(Some("false")));
        assert!(parse_video_toolbox_probe_enabled(Some("1")));
        assert!(parse_video_toolbox_probe_enabled(Some("true")));
        assert!(parse_video_toolbox_probe_enabled(Some(" yes ")));
        assert!(parse_video_toolbox_probe_enabled(Some("ON")));
    }

    #[test]
    fn bridge_frame_with_no_compositor_frame_is_synthetic_fallback() {
        assert_eq!(
            classify_bridge_frame(Some(4), None),
            BridgeFrameSource::SyntheticFallback
        );
        assert_eq!(
            classify_bridge_frame(None, None),
            BridgeFrameSource::SyntheticFallback
        );
    }

    #[test]
    fn bridge_frame_with_unchanged_sequence_is_a_repeat() {
        assert_eq!(
            classify_bridge_frame(Some(7), Some(7)),
            BridgeFrameSource::Repeated
        );
    }

    #[test]
    fn bridge_frame_with_advancing_or_first_sequence_is_fresh() {
        assert_eq!(
            classify_bridge_frame(Some(7), Some(8)),
            BridgeFrameSource::Fresh
        );
        assert_eq!(
            classify_bridge_frame(None, Some(1)),
            BridgeFrameSource::Fresh
        );
    }

    #[test]
    fn videotoolbox_bridge_keeps_bounded_fresh_frame_grace() {
        let frame_interval = Duration::from_millis(33);
        let normal_grace = videotoolbox_fresh_frame_grace(frame_interval);

        assert_eq!(normal_grace, Duration::from_millis(29));
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                0,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                0,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                1,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                1,
                frame_interval
            ),
            normal_grace
        );
    }

    #[test]
    fn raw_bridge_keeps_fresh_frame_wait_budget() {
        let frame_interval = Duration::from_millis(33);

        assert_eq!(
            compositor_frame_wait_budget(EncoderBridgeVideoOutput::RawYuv420p, 0, frame_interval),
            frame_interval
        );
        assert_eq!(
            compositor_frame_wait_budget(EncoderBridgeVideoOutput::RawYuv420p, 1, frame_interval),
            frame_interval + frame_interval
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_config_maps_4k30_recording_profile_to_realtime_h264_settings() {
        let config =
            VideoToolboxBridgeEncoderConfig::from_recording_profile(3840, 2160, 30, Some(30_000));

        assert_eq!(config.width, 3840);
        assert_eq!(config.height, 2160);
        assert_eq!(config.expected_frame_rate, 30);
        assert_eq!(config.max_key_frame_interval, 60);
        assert_eq!(config.average_bit_rate_bps, Some(30_000_000));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_config_maps_4k60_recording_profile_to_two_second_keyframes() {
        let config =
            VideoToolboxBridgeEncoderConfig::from_recording_profile(3840, 2160, 60, Some(50_000));

        assert_eq!(config.expected_frame_rate, 60);
        assert_eq!(config.max_key_frame_interval, 120);
        assert_eq!(config.average_bit_rate_bps, Some(50_000_000));
    }

    #[test]
    fn first_bridge_tick_consumes_ready_compositor_frame() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![42; raw_yuv420p_len(width, height).unwrap()];
        let captured_at = Instant::now()
            .checked_sub(Duration::from_millis(80))
            .unwrap_or_else(Instant::now);
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish(
                11,
                width,
                height,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                captured_at,
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(Arc::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 11);
        assert_eq!(fed.captured_at, captured_at);
        assert!(fed.age_ms >= 80);
        assert!(!fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(
            classify_bridge_frame(None, Some(fed.sequence)),
            BridgeFrameSource::Fresh
        );
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn copied_compositor_frame_reports_metal_target_candidate() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![84; raw_yuv420p_len(width, height).unwrap()];
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish(
                12,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                Instant::now(),
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(Arc::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 12);
        assert!(fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn next_compositor_frame_reports_metadata_without_yuv_copy_buffer() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        {
            let mut store = frame_store.lock().unwrap();
            let buffer = store.checkout_buffer(raw_yuv420p_len(width, height).unwrap());
            store.publish(
                14,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                Instant::now(),
                buffer,
            );
        }

        let fed = next_compositor_frame(Some(&frame_store), None, Duration::ZERO)
            .expect("ready compositor frame");

        assert_eq!(fed.sequence, 14);
        assert!(fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(
            fed.frame.bytes.len(),
            raw_yuv420p_len(width, height).unwrap()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copied_compositor_frame_retains_metal_target_handle_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let width = 64;
        let height = 64;
        let sources = [GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &[0, 64, 255, 255],
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
        }];
        compositor
            .compose_bgra(
                width as usize,
                height as usize,
                [0.0, 0.0, 0.0, 1.0],
                &sources,
            )
            .expect("compose retained Metal target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed Metal target unavailable");
            return;
        };
        if !target.has_iosurface() {
            eprintln!("skipping: retained Metal target is not IOSurface-backed");
            return;
        }

        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![21; raw_yuv420p_len(width, height).unwrap()];
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish_with_metadata(
                13,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                CompositorFrameExportHandle::metal_target(target),
                Instant::now(),
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(Arc::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 13);
        assert!(fed.has_metal_iosurface_target);
        assert!(fed.has_metal_export_handle);
        assert!(fed.metal_target.is_some());
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn bridge_waits_for_fresh_compositor_sequence_before_repeating() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let first = vec![1; raw_yuv420p_len(width, height).unwrap()];
        let second = vec![2; first.len()];
        let _first = publish_test_compositor_frame(&frame_store, 11, width, height, &first);

        let publisher = {
            let frame_store = Arc::clone(&frame_store);
            let second = second.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(5));
                let _ = publish_test_compositor_frame(&frame_store, 12, width, height, &second);
            })
        };

        let fed = next_raw_compositor_frame(
            Some(&frame_store),
            Some(11),
            Duration::from_millis(50),
            first.len(),
        )
        .expect("fresh compositor frame");
        publisher.join().expect("publisher");
        let latest = frame_store.lock().unwrap().latest().expect("latest frame");

        assert_eq!(fed.sequence, 12);
        assert!(Arc::ptr_eq(&fed.frame, &latest));
        assert_eq!(fed.frame.bytes, second);
    }

    #[test]
    fn bridge_reuses_latest_compositor_sequence_after_wait_budget() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![3; raw_yuv420p_len(width, height).unwrap()];
        let published = publish_test_compositor_frame(&frame_store, 11, width, height, &expected);

        let fed = next_raw_compositor_frame(
            Some(&frame_store),
            Some(11),
            Duration::from_millis(1),
            expected.len(),
        )
        .expect("latest compositor frame");

        assert_eq!(fed.sequence, 11);
        assert!(Arc::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn videotoolbox_bridge_waits_bounded_for_fresh_compositor_sequence() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            21,
            width,
            height,
            &vec![5; raw_yuv420p_len(width, height).unwrap()],
        );

        let publisher = {
            let frame_store = Arc::clone(&frame_store);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(5));
                let _ = publish_test_compositor_frame(
                    &frame_store,
                    22,
                    width,
                    height,
                    &vec![6; raw_yuv420p_len(width, height).unwrap()],
                );
            })
        };
        let fed = next_compositor_frame(Some(&frame_store), Some(21), Duration::from_millis(50))
            .expect("fresh compositor frame");
        publisher.join().expect("publisher");

        assert_eq!(fed.sequence, 22);
    }

    #[test]
    fn videotoolbox_bridge_reuses_latest_compositor_sequence_after_wait_budget() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            21,
            width,
            height,
            &vec![5; raw_yuv420p_len(width, height).unwrap()],
        );

        let fed = next_compositor_frame(Some(&frame_store), Some(21), Duration::from_millis(1))
            .expect("latest compositor frame");

        assert_eq!(fed.sequence, 21);
        assert_eq!(
            classify_bridge_frame(Some(21), Some(fed.sequence)),
            BridgeFrameSource::Repeated
        );
    }

    #[test]
    fn encoded_bridge_consumes_startup_validated_frame_without_waiting() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            31,
            width,
            height,
            &vec![7; raw_yuv420p_len(width, height).unwrap()],
        );

        assert_eq!(
            initial_bridge_wait_sequence(EncoderBridgeVideoOutput::RawYuv420p, Some(&frame_store)),
            Some(31)
        );
        assert_eq!(
            initial_bridge_wait_sequence(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                Some(&frame_store)
            ),
            None
        );
        assert_eq!(
            initial_bridge_wait_sequence(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                Some(&frame_store)
            ),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mpeg_ts_pipe_writer_coalesces_access_unit_to_single_fifo_write() {
        let mut pipe_writer = VideoToolboxH264PipeWriter::for_output(
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        );
        let frame = VideoToolboxH264AnnexBFrame {
            timing: VideoToolboxFrameTiming::new(1, 30, 1, 30),
            bytes: vec![0x55; 600],
            nal_types: vec![5],
            is_idr: true,
        };
        let mut sink = CountingSink::default();

        pipe_writer
            .write_frame(&mut sink, &frame)
            .expect("write MPEG-TS frame");

        assert_eq!(sink.write_calls, 1);
        assert_eq!(sink.bytes.len() % 188, 0);
        assert!(sink.bytes.len() > frame.bytes.len());
        assert_eq!(sink.bytes[0], 0x47);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mpeg_ts_pipe_writer_preserves_intentional_pre_encode_pts_gaps() {
        let mut pipe_writer = VideoToolboxH264PipeWriter::for_output(
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        );
        let mut sink = CountingSink::default();
        for frame_index in [0, 3] {
            pipe_writer
                .write_frame(
                    &mut sink,
                    &VideoToolboxH264AnnexBFrame {
                        timing: VideoToolboxFrameTiming::new(frame_index, 30, 1, 30),
                        bytes: vec![0x55; 64],
                        nal_types: vec![1],
                        is_idr: false,
                    },
                )
                .expect("write MPEG-TS frame");
        }

        let pts = sink
            .bytes
            .chunks_exact(188)
            .filter(|packet| {
                let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
                pid == 0x0101 && packet[1] & 0x40 != 0
            })
            .filter_map(|packet| {
                let payload = match (packet[3] >> 4) & 0x03 {
                    1 => &packet[4..],
                    3 => &packet[5 + usize::from(packet[4])..],
                    _ => return None,
                };
                (payload.len() >= 14 && payload.starts_with(&[0x00, 0x00, 0x01, 0xe0]))
                    .then(|| decode_test_pts(&payload[9..14]))
            })
            .collect::<Vec<_>>();

        // Stream coalescing advances the bridge tick/VideoToolbox timing while
        // skipping only the pre-encode submission. MPEG-TS therefore carries a
        // wall-true 100ms gap instead of compressing three ticks into one.
        assert_eq!(pts, vec![0, 9_000]);
    }

    #[cfg(target_os = "macos")]
    fn decode_test_pts(bytes: &[u8]) -> u64 {
        (u64::from((bytes[0] >> 1) & 0x07) << 30)
            | (u64::from(bytes[1]) << 22)
            | (u64::from((bytes[2] >> 1) & 0x7f) << 15)
            | (u64::from(bytes[3]) << 7)
            | u64::from((bytes[4] >> 1) & 0x7f)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_reports_written_frames() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(2);
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        for frame_index in 0..2 {
            frame_tx
                .send(QueuedVideoToolboxFrame {
                    frame: VideoToolboxH264AnnexBFrame {
                        timing: VideoToolboxFrameTiming::new(frame_index, 30, 1, 30),
                        bytes: vec![0x44; 64],
                        nal_types: vec![1],
                        is_idr: false,
                    },
                    submitted_at: Instant::now(),
                })
                .expect("queue frame");
        }
        drop(frame_tx);

        run_video_toolbox_fifo_writer_loop(
            CountingSink::default(),
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(250),
        );

        let results = result_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        for result in results {
            match result {
                VideoToolboxFifoWriterResult::FrameWritten {
                    encoded_bytes,
                    write_ms,
                } => {
                    assert_eq!(encoded_bytes, 64);
                    assert!(write_ms >= 0.0);
                }
                VideoToolboxFifoWriterResult::Error(error) => {
                    panic!("unexpected FIFO writer error: {error}");
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_finishes_in_flight_access_unit_after_stop() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let bytes = vec![0x44; 64];
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: bytes.clone(),
                    nal_types: vec![1],
                    is_idr: false,
                },
                submitted_at: Instant::now(),
            })
            .expect("queue frame");
        drop(frame_tx);
        let stop = Arc::new(AtomicBool::new(true));
        let sink = SharedCountingSink::default();

        run_video_toolbox_fifo_writer_loop(
            sink.clone(),
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            stop,
            Duration::from_millis(250),
        );

        assert_eq!(sink.bytes(), bytes);
        assert!(matches!(
            result_rx.recv().expect("written frame result"),
            VideoToolboxFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stalled_videotoolbox_fifo_writer_times_out_and_joins_without_detaching() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: vec![0x44; 64],
                    nal_types: vec![1],
                    is_idr: false,
                },
                submitted_at: Instant::now(),
            })
            .expect("queue frame");
        drop(frame_tx);

        let started_at = Instant::now();
        run_video_toolbox_fifo_writer_loop(
            AlwaysWouldBlockSink,
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(20),
        );

        assert!(started_at.elapsed() < Duration::from_millis(500));
        let result = result_rx.recv().expect("terminal writer result");
        let VideoToolboxFifoWriterResult::Error(error) = result else {
            panic!("stalled writer must fail explicitly")
        };
        assert!(error.contains("complete-frame delivery budget"));
    }

    struct AlwaysWouldBlockSink;

    impl StdWrite for AlwaysWouldBlockSink {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::WouldBlock))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct SharedCountingSink(Arc<std::sync::Mutex<Vec<u8>>>);

    impl SharedCountingSink {
        fn bytes(&self) -> Vec<u8> {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    impl StdWrite for SharedCountingSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct GatedFirstWriteSink {
        written: SharedCountingSink,
        first_write_started: Option<std_mpsc::SyncSender<()>>,
        release_first_write: std_mpsc::Receiver<()>,
    }

    impl StdWrite for GatedFirstWriteSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.first_write_started.take() {
                started
                    .send(())
                    .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test gate closed"))?;
                self.release_first_write
                    .recv_timeout(Duration::from_secs(1))
                    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "test gate timed out"))?;
            }
            self.written.write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct StopAfterPartialWriteSink {
        written: SharedCountingSink,
        stop: Arc<AtomicBool>,
        first_write: bool,
    }

    struct SlowProgressSink {
        written: SharedCountingSink,
        chunk_size: usize,
        delay: Duration,
    }

    #[derive(Clone, Copy)]
    enum PipePressure {
        WouldBlock,
        ZeroWrite,
    }

    struct AlternatingBackpressureSink {
        written: usize,
        chunk_size: usize,
        pressure_next: bool,
        pressure: PipePressure,
    }

    impl StdWrite for AlternatingBackpressureSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.pressure_next {
                self.pressure_next = false;
                return match self.pressure {
                    PipePressure::WouldBlock => Err(io::Error::from(io::ErrorKind::WouldBlock)),
                    PipePressure::ZeroWrite => Ok(0),
                };
            }
            self.pressure_next = true;
            let written = bytes.len().min(self.chunk_size);
            self.written += written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl StdWrite for SlowProgressSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            thread::sleep(self.delay);
            let written = bytes.len().min(self.chunk_size);
            self.written
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(&bytes[..written]);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl StdWrite for StopAfterPartialWriteSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let written = if self.first_write {
                bytes.len().div_ceil(2)
            } else {
                bytes.len()
            };
            self.written
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(&bytes[..written]);
            if self.first_write {
                self.first_write = false;
                self.stop.store(true, Ordering::Relaxed);
            }
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    #[derive(Default)]
    struct CountingSink {
        write_calls: usize,
        bytes: Vec<u8>,
    }

    #[cfg(target_os = "macos")]
    impl StdWrite for CountingSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.write_calls += 1;
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn publish_test_compositor_frame(
        frame_store: &CompositorFrameStore,
        sequence: u64,
        width: u32,
        height: u32,
        bytes: &[u8],
    ) -> CompositorFrameHandle {
        let mut store = frame_store.lock().unwrap();
        let mut buffer = store.checkout_buffer(bytes.len());
        buffer.copy_from_slice(bytes);
        store.publish(
            sequence,
            width,
            height,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            Instant::now(),
            buffer,
        )
    }

    fn test_settings() -> EncoderBridgeSettings {
        EncoderBridgeSettings {
            ffmpeg_path: "ffmpeg".to_string(),
            output_path: PathBuf::from("/tmp/bridge.mp4"),
            width: 640,
            height: 360,
            fps: 30,
            duration_ms: 2_000,
            bitrate_kbps: 2_000,
        }
    }

    #[test]
    fn bridge_args_feed_raw_rgba_frames_into_ffmpeg() {
        let args = encoder_bridge_ffmpeg_args(&test_settings());

        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&"rawvideo".to_string()));
        assert!(args.contains(&"-pix_fmt".to_string()));
        assert!(args.contains(&"rgba".to_string()));
        assert!(args.contains(&"-video_size".to_string()));
        assert!(args.contains(&"640x360".to_string()));
        assert!(args.contains(&"-framerate".to_string()));
        assert!(args.contains(&"30".to_string()));
        assert!(args.contains(&"pipe:0".to_string()));
        assert!(args.contains(&"-progress".to_string()));
        assert!(args.contains(&"pipe:2".to_string()));
    }

    #[test]
    fn synthetic_frame_renders_rgba_pixels_and_marker() {
        let frame = SyntheticMovingSource.render(1, 32, 24);
        let mut bytes = vec![0; raw_rgba_len(frame.width, frame.height).unwrap()];

        render_synthetic_rgba_frame(&frame, &mut bytes);

        assert_eq!(bytes.len(), 32 * 24 * 4);
        assert!(bytes.chunks_exact(4).all(|pixel| pixel[3] == 255));
        assert!(
            bytes
                .chunks_exact(4)
                .any(|pixel| pixel[0] == 255 && pixel[1] == 240 && pixel[2] == 32)
        );
    }

    #[test]
    fn synthetic_recording_frame_renders_yuv420p_pixels_and_marker() {
        let frame = SyntheticMovingSource.render(1, 32, 24);
        let mut bytes = vec![0; raw_yuv420p_len(frame.width, frame.height).unwrap()];

        render_synthetic_yuv420p_frame(&frame, &mut bytes);

        let y_len = 32 * 24;
        let uv_len = 16 * 12;
        assert_eq!(bytes.len(), y_len + uv_len * 2);
        assert!(bytes[..y_len].iter().any(|value| *value == 235));
        assert!(
            bytes[y_len..y_len + uv_len]
                .iter()
                .any(|value| *value == 60)
        );
    }

    #[test]
    fn progress_parser_reads_speed_fps_and_drops() {
        let progress =
            parse_encoder_progress_line("fps=29.95 speed=0.99x drop_frames=3").expect("progress");

        assert_eq!(progress.encoded_fps, Some(29.95));
        assert_eq!(progress.encoder_speed, Some(0.99));
        assert_eq!(progress.dropped_frames, Some(3));
    }

    #[test]
    fn frame_count_rounds_up_to_cover_duration() {
        assert_eq!(frame_count(2_000, 30), 60);
        assert_eq!(frame_count(1_001, 30), 31);
    }

    #[test]
    fn params_reject_empty_output_path() {
        let params = EncoderBridgeSyntheticParams {
            ffmpeg_path: None,
            output_path: Some(" ".to_string()),
            width: Some(640),
            height: Some(360),
            fps: Some(30),
            duration_ms: Some(2_000),
            bitrate_kbps: Some(2_000),
        };

        assert!(EncoderBridgeSettings::from_params(params).is_err());
    }

    #[test]
    fn params_accept_4k30_recording_profile_bitrate() {
        let params = EncoderBridgeSyntheticParams {
            ffmpeg_path: None,
            output_path: Some("/tmp/bridge-4k30.mp4".to_string()),
            width: Some(3840),
            height: Some(2160),
            fps: Some(30),
            duration_ms: Some(2_000),
            bitrate_kbps: Some(30_000),
        };

        let settings = EncoderBridgeSettings::from_params(params).expect("4K30 bridge settings");

        assert_eq!(settings.width, 3840);
        assert_eq!(settings.height, 2160);
        assert_eq!(settings.fps, 30);
        assert_eq!(settings.bitrate_kbps, 30_000);
    }

    // Plan 026 S1: the writer schedule must NEVER silently compress the video
    // timeline. Simulates the loop arithmetic against a compositor slower than
    // the target fps (the exact shape that produced audio drifting ~0.7s/min on
    // macOS and ~8% timeline compression in the first Windows artifact): every
    // on-schedule tick waits ~34ms for a fresh 29.4fps frame, so the loop
    // overruns its 33.33ms deadline every single iteration. With the absolute
    // schedule + zero-wait catch-up the emitted frame count must track wall
    // time; the old re-anchor design fails this by ~1.3% (≈780ms over 60s).
    #[test]
    fn bridge_schedule_never_compresses_under_a_slow_compositor() {
        let interval = Duration::from_nanos(1_000_000_000 / 30);
        let fresh_wait = Duration::from_micros(34_000); // 29.4fps compositor
        let catchup_cost = Duration::from_millis(2); // instant repeat + write

        let mut wall = Duration::ZERO;
        let mut next_frame_at = Duration::ZERO;
        let mut frames = 0_u64;
        let simulated = Duration::from_secs(60);

        while wall < simulated {
            let lag = wall.saturating_sub(next_frame_at);
            let plan = plan_bridge_tick(lag, interval);
            assert_eq!(
                plan.reanchor_skipped_intervals, 0,
                "a merely-slow compositor must never trigger the stall gap"
            );
            if wall < next_frame_at {
                wall = next_frame_at; // sleep to the deadline
            }
            next_frame_at += interval;
            wall += if plan.skip_fresh_wait {
                catchup_cost
            } else {
                fresh_wait
            };
            frames += 1;
        }

        let timeline = interval * frames as u32;
        let drift = if timeline > wall {
            timeline - wall
        } else {
            wall - timeline
        };
        assert!(
            drift <= Duration::from_millis(100),
            "video timeline drifted {}ms from wall clock over 60s (frames {frames})",
            drift.as_millis()
        );
    }

    #[test]
    fn bridge_schedule_stall_gap_is_explicit_and_wall_true() {
        let interval = Duration::from_nanos(1_000_000_000 / 30);

        // Sub-threshold lag: catch up with repeats, never drop intervals.
        let behind = plan_bridge_tick(Duration::from_millis(500), interval);
        assert!(behind.skip_fresh_wait);
        assert_eq!(behind.reanchor_skipped_intervals, 0);

        // On schedule: normal fresh-frame wait.
        let on_time = plan_bridge_tick(Duration::ZERO, interval);
        assert!(!on_time.skip_fresh_wait);
        assert_eq!(on_time.reanchor_skipped_intervals, 0);

        // Pathological stall (app nap): drop WHOLE intervals as an explicit,
        // counted gap so PTS stay wall-true instead of compressing.
        let raw_stalled = plan_bridge_tick(Duration::from_secs(5), interval);
        assert!(raw_stalled.skip_fresh_wait);
        assert_eq!(raw_stalled.reanchor_skipped_intervals, 150);

        let raw_just_below_threshold = plan_bridge_tick(
            ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD - Duration::from_nanos(1),
            interval,
        );
        assert_eq!(raw_just_below_threshold.reanchor_skipped_intervals, 0);
        let raw_at_threshold = plan_bridge_tick(ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD, interval);
        assert!(raw_at_threshold.reanchor_skipped_intervals > 0);

        let timestamped_stalled = plan_bridge_tick(Duration::from_secs(5), interval);
        assert!(timestamped_stalled.skip_fresh_wait);
        assert_eq!(timestamped_stalled.reanchor_skipped_intervals, 150); // 5s / 33.33ms
    }
}
