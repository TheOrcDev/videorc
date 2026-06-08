use std::ffi::CString;
use std::fs::File;
use std::io::{self, Write as StdWrite};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle as TokioJoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::compositor::CompositorFrameStore;
use crate::compositor_synthetic::{SyntheticCompositorFrame, SyntheticMovingSource};
use crate::diagnostics::{
    EncoderBridgeDiagnosticSnapshot, apply_encoder_bridge_stats,
    apply_runtime_diagnostics_snapshot, starting_diagnostics,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::mpeg_ts::{MpegTsH264Writer, timing_to_90khz};
use crate::protocol::{EncoderBridgeSyntheticParams, EncoderBridgeSyntheticResult};
use crate::state::AppState;
#[cfg(target_os = "macos")]
use crate::video_toolbox_encoder::{
    VideoToolboxFrameTiming, VideoToolboxH264AnnexBFrame, VideoToolboxH264AsyncAnnexBFrame,
    VideoToolboxH264Session,
};

const ENCODER_BRIDGE_DIAGNOSTIC_WINDOW: Duration = Duration::from_secs(2);
const ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD: Duration = Duration::from_millis(1);
const VIDEOTOOLBOX_FRESH_FRAME_GRACE_DIVISOR: f64 = 2.0;
const VIDEOTOOLBOX_PROBE_ENV: &str = "VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE";

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
    video_toolbox_fifo_write_p95_ms: Option<f64>,
    writer_loop_p95_ms: Option<f64>,
    writer_sleep_p95_ms: Option<f64>,
    writer_active_p95_ms: Option<f64>,
    deadline_lag_p95_ms: Option<f64>,
    deadline_lag_max_ms: Option<f64>,
    late_deadline_ticks: u64,
}

/// A compositor frame fed into the encoder FIFO on one tick.
#[derive(Clone)]
struct FedCompositorFrame {
    sequence: u64,
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

fn compositor_frame_wait_budget(
    video_output: EncoderBridgeVideoOutput,
    consecutive_repeated_frames: u64,
    frame_interval: Duration,
) -> Duration {
    if video_output.uses_video_toolbox() {
        // Keep the normal VideoToolbox tick mostly immediate, but give the compositor
        // a small phase-alignment grace. Zero wait sampled just before a fresh Metal
        // target publish and produced many isolated duplicate re-feeds; full-frame
        // waits pushed the writer loop behind real time.
        return if consecutive_repeated_frames > 0 {
            match video_output {
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => frame_interval + frame_interval,
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => frame_interval,
                EncoderBridgeVideoOutput::RawYuv420p => Duration::ZERO,
            }
        } else {
            videotoolbox_fresh_frame_grace(frame_interval)
        };
    }
    if consecutive_repeated_frames > 0 {
        frame_interval + frame_interval
    } else {
        frame_interval
    }
}

fn videotoolbox_fresh_frame_grace(frame_interval: Duration) -> Duration {
    Duration::from_secs_f64(frame_interval.as_secs_f64() / VIDEOTOOLBOX_FRESH_FRAME_GRACE_DIVISOR)
}

#[derive(Debug)]
pub struct EncoderBridgeRecordingSession {
    stop: Arc<AtomicBool>,
    fifo_path: PathBuf,
    writer: Option<thread::JoinHandle<()>>,
    diagnostics_task: Option<TokioJoinHandle<()>>,
}

impl EncoderBridgeRecordingSession {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for EncoderBridgeRecordingSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.writer.take();
        if let Some(task) = self.diagnostics_task.take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
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
        None,
    )
    .await;

    let progress = Arc::new(Mutex::new(EncoderBridgeProgress::default()));
    let mut child = Command::new(&settings.ffmpeg_path)
        .args(encoder_bridge_ffmpeg_args(&settings))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
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
) -> Result<EncoderBridgeRecordingSession> {
    let byte_len = raw_yuv420p_len(width, height)?;
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let writer_fifo_path = fifo_path.clone();
    let (diagnostics_tx, mut diagnostics_rx) =
        mpsc::unbounded_channel::<EncoderBridgeWriterEvent>();
    let diagnostics_state = state.clone();
    let diagnostics_task = tokio::spawn(async move {
        while let Some(event) = diagnostics_rx.recv().await {
            emit_encoder_bridge_diagnostics(
                &diagnostics_state,
                &event.session_id,
                event.target_fps,
                event.stats,
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
                stop: writer_stop,
                diagnostics_tx,
            };
            write_synthetic_recording_frames(params);
        })
        .context("Could not start recording encoder bridge writer thread")?;

    Ok(EncoderBridgeRecordingSession {
        stop,
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
    fifo_path: PathBuf,
    frame_store: Option<CompositorFrameStore>,
    video_output: EncoderBridgeVideoOutput,
    bitrate_kbps: Option<u32>,
    diagnostics_tx: mpsc::UnboundedSender<EncoderBridgeWriterEvent>,
}

#[derive(Debug, Clone)]
struct EncoderBridgeWriterEvent {
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
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
        fifo_path,
        frame_store,
        video_output,
        bitrate_kbps,
        diagnostics_tx,
    } = params;
    let mut fifo = match open_recording_fifo_writer(&fifo_path, &stop) {
        Ok(fifo) => fifo,
        Err(error) => {
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
                Some(format!(
                    "Could not open recording encoder bridge FIFO {}: {error}",
                    fifo_path.display()
                )),
            );
            return;
        }
    };
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let source = SyntheticMovingSource;
    let mut bytes = vec![0; byte_len];
    let mut sequence = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut window_started_at = Instant::now();
    let mut next_frame_at = Instant::now();
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
    let mut compositor_wait_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_submit_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_fifo_write_times_ms = Vec::with_capacity(128);
    let mut writer_loop_times_ms = Vec::with_capacity(128);
    let mut writer_sleep_times_ms = Vec::with_capacity(128);
    let mut writer_active_times_ms = Vec::with_capacity(128);
    let mut deadline_lag_times_ms = Vec::with_capacity(128);
    let mut max_deadline_lag_ms: Option<f64> = None;
    let mut late_deadline_ticks = 0_u64;
    #[cfg(target_os = "macos")]
    let mut video_toolbox_probe = EncoderBridgeVideoToolboxProbe::new(
        video_output.uses_video_toolbox() || encoder_bridge_video_toolbox_probe_enabled(),
        width,
        height,
        target_fps,
        bitrate_kbps,
    );
    #[cfg(target_os = "macos")]
    let mut h264_pipe_writer = VideoToolboxH264PipeWriter::for_output(video_output);
    #[cfg(target_os = "macos")]
    if video_output.uses_video_toolbox()
        && let Err(error) = video_toolbox_probe.prepare_session()
    {
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
            Some(format!(
                "Could not prepare VideoToolbox encoder bridge output: {error}"
            )),
        );
        return;
    }
    let mut last_fed_sequence: Option<u64> = None;
    let mut first_frame_wait_sequence =
        latest_compositor_frame(frame_store.as_ref()).map(|frame| frame.sequence);
    let mut consecutive_repeated_frames = 0_u64;

    while !stop.load(Ordering::Relaxed) {
        let loop_started_at = Instant::now();
        let now = Instant::now();
        if now > next_frame_at {
            let deadline_lag = now.duration_since(next_frame_at);
            if deadline_lag >= ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD {
                let lag_ms = deadline_lag.as_secs_f64() * 1000.0;
                deadline_lag_times_ms.push(lag_ms);
                max_deadline_lag_ms =
                    Some(max_deadline_lag_ms.map_or(lag_ms, |current| current.max(lag_ms)));
                late_deadline_ticks = late_deadline_ticks.saturating_add(1);
            }
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
        let startup_wait_sequence = if last_fed_sequence.is_none() {
            first_frame_wait_sequence
        } else {
            None
        };
        let wait_budget = if startup_wait_sequence.is_some() {
            frame_interval + frame_interval
        } else {
            compositor_frame_wait_budget(video_output, consecutive_repeated_frames, frame_interval)
        };
        let previous_sequence = last_fed_sequence.or(startup_wait_sequence);
        let compositor_wait_started_at = Instant::now();
        let fed = match video_output {
            EncoderBridgeVideoOutput::RawYuv420p => copy_next_compositor_frame(
                frame_store.as_ref(),
                &mut bytes,
                previous_sequence,
                wait_budget,
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
                            input_fps: measured_input_fps(frames_in_window, window_started_at),
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
                            video_toolbox_fifo_write_p95_ms: p95_ms(
                                &video_toolbox_fifo_write_times_ms,
                            ),
                            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                            deadline_lag_max_ms: max_deadline_lag_ms,
                            late_deadline_ticks,
                        },
                        Some(
                            "VideoToolbox encoder bridge had no compositor frame to encode"
                                .to_string(),
                        ),
                    );
                    break;
                }
                let frame = source.render(sequence, width, height);
                render_synthetic_yuv420p_frame(&frame, &mut bytes);
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
        let wrote_metal_target_frame = fed
            .as_ref()
            .is_some_and(|frame| frame.has_metal_iosurface_target);
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
            pending_video_toolbox_output_frames
        } else {
            1
        };
        let write_result = match video_output {
            EncoderBridgeVideoOutput::RawYuv420p => fifo.write_all(&bytes).map(|()| {
                raw_video_copied_frames = raw_video_copied_frames.saturating_add(1);
                if wrote_metal_target_frame {
                    metal_target_frames = metal_target_frames.saturating_add(1);
                    metal_target_copied_frames = metal_target_copied_frames.saturating_add(1);
                }
                if wrote_metal_target_handle {
                    metal_target_handle_frames = metal_target_handle_frames.saturating_add(1);
                }
            }),
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
                                    let encode_ms = encode_started_at.elapsed().as_millis() as u64;
                                    video_toolbox_submit_times_ms
                                        .push(encode_started_at.elapsed().as_secs_f64() * 1000.0);
                                    max_video_toolbox_output_encode_ms = Some(
                                        max_video_toolbox_output_encode_ms
                                            .map_or(encode_ms, |current| current.max(encode_ms)),
                                    );
                                    pending_video_toolbox_output_frames =
                                        pending_video_toolbox_output_frames.saturating_add(1);
                                    if wrote_metal_target_frame {
                                        metal_target_frames = metal_target_frames.saturating_add(1);
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
        };
        if let Err(error) = write_result {
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    input_fps: measured_input_fps(frames_in_window, window_started_at),
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
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                },
                Some(format!(
                    "Could not write compositor frame into recording FFmpeg: {error}"
                )),
            );
            break;
        }
        #[cfg(target_os = "macos")]
        if video_output.uses_video_toolbox()
            && let Err(error) = drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                &mut fifo,
                &mut h264_pipe_writer,
                &mut pending_video_toolbox_output_frames,
                &mut zero_copy_frames,
                &mut video_toolbox_output_frames,
                &mut video_toolbox_output_bytes,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_write_times_ms,
            )
        {
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth: pending_video_toolbox_output_frames,
                    input_fps: measured_input_fps(frames_in_window, window_started_at),
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
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                },
                Some(format!(
                    "Could not write VideoToolbox output into recording FFmpeg: {error}"
                )),
            );
            break;
        }
        queue_depth = if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames
        } else {
            0
        };
        writer_active_times_ms.push(active_started_at.elapsed().as_secs_f64() * 1000.0);
        writer_loop_times_ms.push(loop_started_at.elapsed().as_secs_f64() * 1000.0);
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
                    input_fps: measured_input_fps(frames_in_window, window_started_at),
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
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                },
                None,
            );
            window_started_at = Instant::now();
            frames_in_window = 0;
            compositor_wait_times_ms.clear();
            video_toolbox_submit_times_ms.clear();
            video_toolbox_fifo_write_times_ms.clear();
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
        while pending_video_toolbox_output_frames > 0
            && drain_started_at.elapsed() < Duration::from_secs(2)
        {
            if drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                &mut fifo,
                &mut h264_pipe_writer,
                &mut pending_video_toolbox_output_frames,
                &mut zero_copy_frames,
                &mut video_toolbox_output_frames,
                &mut video_toolbox_output_bytes,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_write_times_ms,
            )
            .is_err()
            {
                break;
            }
            if pending_video_toolbox_output_frames > 0 {
                thread::sleep(Duration::from_millis(2));
            }
        }
        queue_depth = pending_video_toolbox_output_frames;
    }

    let _ = fifo.flush();
    drop(fifo);
    emit_encoder_bridge_diagnostics_from_thread(
        &diagnostics_tx,
        session_id,
        target_fps,
        EncoderBridgeRuntimeStats {
            queue_depth,
            input_fps: None,
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
            video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
            deadline_lag_max_ms: max_deadline_lag_ms,
            late_deadline_ticks,
        },
        None,
    );
}

#[cfg(target_os = "macos")]
struct EncoderBridgeVideoToolboxProbe {
    enabled: bool,
    width: usize,
    height: usize,
    fps: i32,
    max_key_frame_interval: i32,
    bitrate_kbps: Option<u32>,
    session: Option<VideoToolboxH264Session>,
    output_tx: std_mpsc::Sender<VideoToolboxH264AsyncAnnexBFrame>,
    output_rx: std_mpsc::Receiver<VideoToolboxH264AsyncAnnexBFrame>,
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
        let fps = i32::try_from(fps.max(1)).unwrap_or(i32::MAX);
        let (output_tx, output_rx) = std_mpsc::channel();
        Self {
            enabled,
            width: width.max(1) as usize,
            height: height.max(1) as usize,
            fps,
            max_key_frame_interval: fps.saturating_mul(2).max(1),
            bitrate_kbps,
            session: None,
            output_tx,
            output_rx,
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
        let timing = match VideoToolboxFrameTiming::frame_index(frame_index, self.fps) {
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
        let timing = match VideoToolboxFrameTiming::frame_index(frame_index_i64, self.fps) {
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

    fn complete_pending(&self) -> Result<()> {
        if let Some(session) = self.session.as_ref() {
            session.complete_pending_frames()?;
        }
        Ok(())
    }

    fn prepare_session(&mut self) -> Result<()> {
        let session = match self.bitrate_kbps {
            Some(bitrate_kbps) => VideoToolboxH264Session::new_realtime_with_bitrate(
                self.width,
                self.height,
                self.fps,
                self.max_key_frame_interval,
                i64::from(bitrate_kbps).saturating_mul(1_000),
            )?,
            None => VideoToolboxH264Session::new_realtime(
                self.width,
                self.height,
                self.fps,
                self.max_key_frame_interval,
            )?,
        };
        session.prepare()?;
        self.session = Some(session);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
enum VideoToolboxH264PipeWriter {
    AnnexB,
    MpegTs {
        writer: MpegTsH264Writer,
        access_unit_buffer: Vec<u8>,
    },
}

#[cfg(target_os = "macos")]
impl VideoToolboxH264PipeWriter {
    fn for_output(video_output: EncoderBridgeVideoOutput) -> Self {
        match video_output {
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => Self::MpegTs {
                writer: MpegTsH264Writer::new(),
                access_unit_buffer: Vec::new(),
            },
            EncoderBridgeVideoOutput::RawYuv420p
            | EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => Self::AnnexB,
        }
    }

    fn write_frame<W: StdWrite>(
        &mut self,
        sink: &mut W,
        frame: &VideoToolboxH264AnnexBFrame,
    ) -> io::Result<()> {
        match self {
            Self::AnnexB => sink.write_all(&frame.bytes),
            Self::MpegTs {
                writer,
                access_unit_buffer,
            } => {
                let pts_90khz = timing_to_90khz(
                    frame.timing.presentation_time_value,
                    frame.timing.presentation_time_scale,
                )
                .ok_or_else(|| {
                    io::Error::other("VideoToolbox frame timing cannot be mapped to MPEG-TS PTS")
                })?;
                access_unit_buffer.clear();
                writer
                    .write_h264_access_unit(access_unit_buffer, pts_90khz, &frame.bytes)
                    .map(|_| ())?;
                sink.write_all(access_unit_buffer)
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn drain_video_toolbox_output_frames(
    video_toolbox: &mut EncoderBridgeVideoToolboxProbe,
    fifo: &mut File,
    h264_pipe_writer: &mut VideoToolboxH264PipeWriter,
    pending_video_toolbox_output_frames: &mut u64,
    zero_copy_frames: &mut u64,
    video_toolbox_output_frames: &mut u64,
    video_toolbox_output_bytes: &mut u64,
    video_toolbox_probe_errors: &mut u64,
    video_toolbox_fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    while let Some(message) = video_toolbox.try_recv_output() {
        let _frame_index = message.frame_index;
        *pending_video_toolbox_output_frames =
            pending_video_toolbox_output_frames.saturating_sub(1);
        match message.result {
            Ok(frame) => {
                let encoded_bytes = frame.bytes.len() as u64;
                let write_started_at = Instant::now();
                h264_pipe_writer.write_frame(fifo, &frame)?;
                video_toolbox_fifo_write_times_ms
                    .push(write_started_at.elapsed().as_secs_f64() * 1000.0);
                *zero_copy_frames = zero_copy_frames.saturating_add(1);
                *video_toolbox_output_frames = video_toolbox_output_frames.saturating_add(1);
                *video_toolbox_output_bytes =
                    video_toolbox_output_bytes.saturating_add(encoded_bytes);
            }
            Err(error) => {
                *video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
                return Err(io::Error::other(error));
            }
        }
    }
    Ok(())
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

fn copy_latest_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    bytes: &mut [u8],
) -> Option<FedCompositorFrame> {
    let frame = frame_store?
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .latest()?;
    if frame.bytes.len() != bytes.len() {
        return None;
    }
    bytes.copy_from_slice(&frame.bytes);
    #[cfg(target_os = "macos")]
    let metal_target = frame.metadata.metal_target_pixel_buffer();
    Some(FedCompositorFrame {
        sequence: frame.sequence,
        age_ms: frame.captured_at.elapsed().as_millis() as u64,
        has_metal_iosurface_target: frame.pixel_format.has_metal_iosurface_target(),
        has_metal_export_handle: frame.metadata.has_metal_iosurface_target(),
        #[cfg(target_os = "macos")]
        metal_target,
    })
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
        sequence: frame.sequence,
        age_ms: frame.captured_at.elapsed().as_millis() as u64,
        has_metal_iosurface_target: frame.pixel_format.has_metal_iosurface_target(),
        has_metal_export_handle: frame.metadata.has_metal_iosurface_target(),
        #[cfg(target_os = "macos")]
        metal_target,
    })
}

fn copy_next_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    bytes: &mut [u8],
    previous_sequence: Option<u64>,
    wait_budget: Duration,
) -> Option<FedCompositorFrame> {
    if previous_sequence.is_none() || wait_budget.is_zero() {
        return copy_latest_compositor_frame(frame_store, bytes);
    }

    let started_at = Instant::now();
    loop {
        let frame = copy_latest_compositor_frame(frame_store, bytes);
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

fn open_recording_fifo_writer(path: &Path, stop: &AtomicBool) -> io::Result<File> {
    let c_path = CString::new(path.display().to_string()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid recording encoder bridge FIFO path",
        )
    })?;

    while !stop.load(Ordering::Relaxed) {
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if fd >= 0 {
            let _ = unsafe { libc::fcntl(fd, libc::F_SETFL, 0) };
            return Ok(unsafe { File::from_raw_fd(fd) });
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENXIO) {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(10));
    }

    Err(io::Error::new(
        io::ErrorKind::Interrupted,
        "recording encoder bridge writer stopped before FIFO opened",
    ))
}

fn emit_encoder_bridge_diagnostics_from_thread(
    diagnostics_tx: &mpsc::UnboundedSender<EncoderBridgeWriterEvent>,
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
    error: Option<String>,
) {
    let _ = diagnostics_tx.send(EncoderBridgeWriterEvent {
        session_id,
        target_fps,
        stats,
        error,
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

async fn emit_encoder_bridge_diagnostics(
    state: &AppState,
    session_id: &str,
    target_fps: u32,
    runtime: EncoderBridgeRuntimeStats,
    error: Option<String>,
) {
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let base = if diagnostics.session_id.as_deref() == Some(session_id) {
            diagnostics.clone()
        } else {
            starting_diagnostics(session_id, target_fps, "encoder-bridge")
        };
        let next = apply_encoder_bridge_stats(
            base,
            EncoderBridgeDiagnosticSnapshot {
                queue_depth: runtime.queue_depth,
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
                video_toolbox_output_frames: runtime.video_toolbox_output_frames,
                video_toolbox_output_bytes: runtime.video_toolbox_output_bytes,
                video_toolbox_output_encode_ms: runtime.video_toolbox_output_encode_ms,
                compositor_wait_p95_ms: runtime.compositor_wait_p95_ms,
                video_toolbox_submit_p95_ms: runtime.video_toolbox_submit_p95_ms,
                video_toolbox_fifo_write_p95_ms: runtime.video_toolbox_fifo_write_p95_ms,
                writer_loop_p95_ms: runtime.writer_loop_p95_ms,
                writer_sleep_p95_ms: runtime.writer_sleep_p95_ms,
                writer_active_p95_ms: runtime.writer_active_p95_ms,
                deadline_lag_p95_ms: runtime.deadline_lag_p95_ms,
                deadline_lag_max_ms: runtime.deadline_lag_max_ms,
                late_deadline_ticks: runtime.late_deadline_ticks,
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
    fn videotoolbox_bridge_uses_small_normal_tick_grace() {
        let frame_interval = Duration::from_millis(33);
        let normal_grace = videotoolbox_fresh_frame_grace(frame_interval);

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
            frame_interval
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                1,
                frame_interval
            ),
            frame_interval + frame_interval
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

    #[test]
    fn first_bridge_tick_consumes_ready_compositor_frame() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![42; raw_yuv420p_len(width, height).unwrap()];
        {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish(
                11,
                width,
                height,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                Instant::now(),
                buffer,
            );
        }

        let mut bytes = vec![0; expected.len()];
        let fed = copy_latest_compositor_frame(Some(&frame_store), &mut bytes)
            .expect("ready compositor frame");

        assert_eq!(fed.sequence, 11);
        assert!(!fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(
            classify_bridge_frame(None, Some(fed.sequence)),
            BridgeFrameSource::Fresh
        );
        assert_eq!(bytes, expected);
    }

    #[test]
    fn copied_compositor_frame_reports_metal_target_candidate() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![84; raw_yuv420p_len(width, height).unwrap()];
        {
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
            );
        }

        let mut bytes = vec![0; expected.len()];
        let fed = copy_latest_compositor_frame(Some(&frame_store), &mut bytes)
            .expect("ready compositor frame");

        assert_eq!(fed.sequence, 12);
        assert!(fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(bytes, expected);
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
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
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
        {
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
            );
        }

        let mut bytes = vec![0; expected.len()];
        let fed = copy_latest_compositor_frame(Some(&frame_store), &mut bytes)
            .expect("ready compositor frame");

        assert_eq!(fed.sequence, 13);
        assert!(fed.has_metal_iosurface_target);
        assert!(fed.has_metal_export_handle);
        assert!(fed.metal_target.is_some());
        assert_eq!(bytes, expected);
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
        publish_test_compositor_frame(&frame_store, 11, width, height, &first);

        let publisher = {
            let frame_store = Arc::clone(&frame_store);
            let second = second.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(5));
                publish_test_compositor_frame(&frame_store, 12, width, height, &second);
            })
        };

        let mut bytes = vec![0; first.len()];
        let fed = copy_next_compositor_frame(
            Some(&frame_store),
            &mut bytes,
            Some(11),
            Duration::from_millis(50),
        )
        .expect("fresh compositor frame");
        publisher.join().expect("publisher");

        assert_eq!(fed.sequence, 12);
        assert_eq!(bytes, second);
    }

    #[test]
    fn bridge_reuses_latest_compositor_sequence_after_wait_budget() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![3; raw_yuv420p_len(width, height).unwrap()];
        publish_test_compositor_frame(&frame_store, 11, width, height, &expected);

        let mut bytes = vec![0; expected.len()];
        let fed = copy_next_compositor_frame(
            Some(&frame_store),
            &mut bytes,
            Some(11),
            Duration::from_millis(1),
        )
        .expect("latest compositor frame");

        assert_eq!(fed.sequence, 11);
        assert_eq!(bytes, expected);
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
    ) {
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
        );
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
}
