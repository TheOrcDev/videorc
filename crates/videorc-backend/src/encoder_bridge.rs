use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::compositor_synthetic::{SyntheticCompositorFrame, SyntheticMovingSource};
use crate::diagnostics::{
    EncoderBridgeDiagnosticSnapshot, apply_encoder_bridge_stats,
    apply_runtime_diagnostics_snapshot, starting_diagnostics,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::protocol::{EncoderBridgeSyntheticParams, EncoderBridgeSyntheticResult};
use crate::state::AppState;

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

#[derive(Debug, Clone, Copy)]
struct EncoderBridgeRuntimeStats {
    queue_depth: u64,
    input_fps: Option<f64>,
    dropped_frames: u64,
    encoder_speed: Option<f64>,
}

#[derive(Debug)]
pub struct EncoderBridgeRecordingSession {
    stop: Arc<AtomicBool>,
    writer: Option<JoinHandle<()>>,
}

impl EncoderBridgeRecordingSession {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for EncoderBridgeRecordingSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(writer) = self.writer.take() {
            writer.abort();
        }
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

        if window_started_at.elapsed() >= Duration::from_millis(500) {
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

pub fn start_synthetic_recording_bridge(
    state: AppState,
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    stdin: ChildStdin,
) -> Result<EncoderBridgeRecordingSession> {
    let byte_len = raw_yuv420p_len(width, height)?;
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let writer = tokio::spawn(async move {
        let params = SyntheticRecordingWriterParams {
            state,
            session_id,
            target_fps: target_fps.max(1),
            width: width.max(1),
            height: height.max(1),
            byte_len,
            stdin,
            stop: writer_stop,
        };
        write_synthetic_recording_frames(params).await;
    });

    Ok(EncoderBridgeRecordingSession {
        stop,
        writer: Some(writer),
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
    state: AppState,
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    byte_len: usize,
    stop: Arc<AtomicBool>,
    stdin: ChildStdin,
}

async fn write_synthetic_recording_frames(params: SyntheticRecordingWriterParams) {
    let SyntheticRecordingWriterParams {
        state,
        session_id,
        target_fps,
        width,
        height,
        byte_len,
        stop,
        mut stdin,
    } = params;
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let source = SyntheticMovingSource;
    let mut bytes = vec![0; byte_len];
    let mut sequence = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut window_started_at = Instant::now();
    let mut queue_depth = 0_u64;

    while !stop.load(Ordering::Relaxed) {
        ticker.tick().await;
        if stop.load(Ordering::Relaxed) {
            break;
        }
        sequence = sequence.saturating_add(1);
        let frame = source.render(sequence, width, height);
        render_synthetic_yuv420p_frame(&frame, &mut bytes);

        queue_depth = 1;
        if let Err(error) = stdin.write_all(&bytes).await {
            emit_encoder_bridge_diagnostics(
                &state,
                &session_id,
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    input_fps: measured_input_fps(frames_in_window, window_started_at),
                    dropped_frames: 0,
                    encoder_speed: None,
                },
                Some(format!(
                    "Could not write compositor frame into recording FFmpeg: {error}"
                )),
            )
            .await;
            break;
        }
        queue_depth = 0;
        frames_in_window = frames_in_window.saturating_add(1);

        if window_started_at.elapsed() >= Duration::from_millis(500) {
            emit_encoder_bridge_diagnostics(
                &state,
                &session_id,
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    input_fps: measured_input_fps(frames_in_window, window_started_at),
                    dropped_frames: 0,
                    encoder_speed: None,
                },
                None,
            )
            .await;
            window_started_at = Instant::now();
            frames_in_window = 0;
        }
    }

    let _ = stdin.shutdown().await;
    emit_encoder_bridge_diagnostics(
        &state,
        &session_id,
        target_fps,
        EncoderBridgeRuntimeStats {
            queue_depth,
            input_fps: measured_input_fps(frames_in_window, window_started_at),
            dropped_frames: 0,
            encoder_speed: None,
        },
        None,
    )
    .await;
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

fn frame_count(duration_ms: u64, fps: u32) -> u64 {
    duration_ms
        .saturating_mul(u64::from(fps))
        .saturating_add(999)
        / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

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
