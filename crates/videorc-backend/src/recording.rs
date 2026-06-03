use std::ffi::CString;
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep, timeout};
use uuid::Uuid;

use crate::audio::{
    AudioProcessingSettings, NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_FFMPEG_QUEUE_SIZE,
    NATIVE_AUDIO_SAMPLE_RATE, NativeAudioCaptureSession, NativeAudioSource, attach_fifo_writer,
    create_native_audio_fifo, native_audio_fifo_path, parse_coreaudio_microphone_id,
    start_native_audio_source,
};
use crate::camera_capture::{native_camera_name_for_id, parse_native_camera_id};
use crate::devices::{find_avfoundation_camera_index, find_avfoundation_screen_index};
use crate::diagnostics::{apply_audio_stats, apply_stream_health, starting_diagnostics};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::pipeline::{RecordingPipeline, container_for_outputs, container_key};
use crate::protocol::{
    AudioSettings, AudioTrack, AudioTrackSource, CameraCorner, CameraFit, CameraShape, CameraSize,
    CameraTransformMode, HealthLevel, LayoutPreset, PreviewLiveParams, PreviewLiveSource,
    PreviewLiveState, PreviewLiveStatus, PreviewSnapshot, PreviewSnapshotParams,
    RecordingPipelineStage, RecordingState, RecordingStatus, RemuxSessionParams, RtmpPreset,
    RtmpSettings, SideBySideCameraSide, SideBySideSplit, StartSessionParams, StreamHealth,
    VideoPreset, VideoSettings,
};
use crate::screen_capture::{parse_screencapturekit_display_id, parse_screencapturekit_window_id};
use crate::secrets;
use crate::state::AppState;
use crate::storage::{NewSession, PlatformAccountCredentials, default_preview_dir};
use crate::streaming::{
    StreamAuthMode, StreamPlatform, StreamTargetRuntime, StreamTargetSettings, StreamTargetState,
    StreamTargetsSnapshot, StreamUrlMode, StreamingSettings, stream_platform_from_preset,
    stream_platform_id, stream_platform_label,
};

const PREVIEW_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const LIVE_PREVIEW_WIDTH: u32 = 1280;
const LIVE_PREVIEW_HEIGHT: u32 = 720;
const LIVE_PREVIEW_FPS: u32 = 30;
const CAMERA_REFERENCE_WIDTH: u32 = LIVE_PREVIEW_WIDTH;
const CAMERA_REFERENCE_HEIGHT: u32 = LIVE_PREVIEW_HEIGHT;
const STOP_FINALIZE_TIMEOUT: Duration = Duration::from_secs(12);
const STOP_TERM_DELAY: Duration = Duration::from_secs(3);
const STOP_KILL_DELAY: Duration = Duration::from_secs(3);
const SHUTDOWN_GRACE_DELAY: Duration = Duration::from_millis(1200);
const CAPTURE_AUDIO_FILTER: &str = "aresample=async=1:first_pts=0";
const MONO_TO_STEREO_FILTER: &str = "pan=stereo|c0=c0|c1=c0";
const MICROPHONE_SYNC_OFFSET_MIN_MS: i32 = -1000;
const MICROPHONE_SYNC_OFFSET_MAX_MS: i32 = 1000;
const AVFOUNDATION_VIDEO_PIXEL_FORMAT: &str = "nv12";
const MJPEG_BOUNDARY: &[u8] = b"--videorc";
const MJPEG_HEADER_END: &[u8] = b"\r\n\r\n";
const PREVIEW_READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_PENDING_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const SCREEN_OVERLAY_FPS: u32 = 4;
const SCREEN_OVERLAY_FIFO_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

#[derive(Debug)]
pub struct ActiveRecording {
    pub session_id: String,
    pub pid: u32,
    pub stdin: Option<ChildStdin>,
    pub output_path: Option<PathBuf>,
    pub stream_url: Option<String>,
    pub ffmpeg_path: String,
    pub started_at: String,
    pub mode: String,
    pub audio_tracks: Vec<AudioTrack>,
    pub pipeline: RecordingPipeline,
    pub native_audio: Option<NativeAudioCaptureSession>,
    pub screen_overlay: Option<ScreenOverlaySession>,
    pub stop_requested: bool,
}

#[derive(Debug)]
pub struct ScreenOverlaySession {
    fifo_path: PathBuf,
    width: u32,
    height: u32,
    current_frame: Arc<StdMutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    writer: Option<JoinHandle<()>>,
}

impl ScreenOverlaySession {
    fn start(
        fifo_path: PathBuf,
        width: u32,
        height: u32,
        initial_image_path: Option<String>,
    ) -> Result<Self> {
        let transparent = transparent_overlay_frame(width, height);
        let initial = match initial_image_path {
            Some(path) => screen_overlay_frame_from_path(Path::new(&path), width, height)
                .unwrap_or_else(|_| transparent.clone()),
            None => transparent,
        };
        let current_frame = Arc::new(StdMutex::new(initial));
        let stop = Arc::new(AtomicBool::new(false));
        let writer_path = fifo_path.clone();
        let writer_frame = current_frame.clone();
        let writer_stop = stop.clone();
        let writer = thread::spawn(move || {
            write_screen_overlay_frames(writer_path, writer_frame, writer_stop, width, height);
        });

        Ok(Self {
            fifo_path,
            width,
            height,
            current_frame,
            stop,
            writer: Some(writer),
        })
    }

    pub fn set_image_path(&self, path: Option<&str>) -> Result<()> {
        let next_frame = match path {
            Some(path) => screen_overlay_frame_from_path(Path::new(path), self.width, self.height)?,
            None => transparent_overlay_frame(self.width, self.height),
        };
        if let Ok(mut current) = self.current_frame.lock() {
            *current = next_frame;
        }
        Ok(())
    }
}

impl Drop for ScreenOverlaySession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
    }
}

#[derive(Debug)]
pub struct LivePreviewState {
    pub status: PreviewLiveStatus,
    pub desired_params: Option<PreviewLiveParams>,
    pub idle_process: Option<ActiveLivePreview>,
}

#[derive(Debug)]
pub struct ActiveLivePreview {
    pub pid: u32,
    pub stdin: Option<ChildStdin>,
    pub first_frame_received: bool,
}

impl ActiveRecording {
    pub fn status(&self, state: RecordingState, message: Option<String>) -> RecordingStatus {
        RecordingStatus {
            state,
            session_id: Some(self.session_id.clone()),
            output_path: self
                .output_path
                .as_ref()
                .map(|path| path.display().to_string()),
            stream_url: self.stream_url.clone(),
            started_at: Some(self.started_at.clone()),
            audio_tracks: self.audio_tracks.clone(),
            pipeline: Some(self.pipeline.status()),
            duration_ms: None,
            message,
        }
    }

    pub fn set_active_screen_path(&self, path: Option<&str>) -> Result<()> {
        if let Some(overlay) = &self.screen_overlay {
            overlay.set_image_path(path)?;
        }
        Ok(())
    }
}

pub fn initial_live_preview_state() -> LivePreviewState {
    LivePreviewState {
        status: unavailable_live_preview_status(None),
        desired_params: None,
        idle_process: None,
    }
}

pub fn default_recordings_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Movies")
        .join("Videorc")
        .join("Recordings")
}

fn default_video_settings() -> VideoSettings {
    VideoSettings {
        preset: VideoPreset::Tutorial1440p30,
        width: 2560,
        height: 1440,
        fps: 30,
        bitrate_kbps: 8000,
    }
}

pub fn idle_status() -> RecordingStatus {
    RecordingStatus {
        state: RecordingState::Idle,
        session_id: None,
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: Some("Ready to start a capture session.".to_string()),
    }
}

pub async fn start_session(
    state: AppState,
    mut params: StartSessionParams,
) -> Result<RecordingStatus> {
    if state.recording.lock().await.is_some() {
        bail!("A capture session is already running");
    }

    hydrate_oauth_stream_keys(&state, &mut params)?;
    validate_outputs(&params)?;

    let ffmpeg_path = resolve_ffmpeg_path(params.output.ffmpeg_path.clone());
    let output_dir = params
        .output
        .output_directory
        .clone()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_recordings_dir);

    if params.output.record_enabled {
        fs::create_dir_all(&output_dir)
            .await
            .with_context(|| format!("Could not create {}", output_dir.display()))?;
    }

    let session_id = Uuid::new_v4().to_string();
    let started_at = Utc::now();
    let output_path = params.output.record_enabled.then(|| {
        output_dir.join(format!(
            "videorc-session-{}.mkv",
            started_at.format("%Y%m%d-%H%M%S")
        ))
    });
    let stream_resolution = if params.output.stream_enabled {
        match params
            .streaming
            .as_ref()
            .filter(|streaming| streaming.enabled)
        {
            Some(streaming) => {
                let resolution = resolve_stream_targets(streaming);
                // validate_outputs() already guaranteed a ready target; re-check
                // defensively so an empty set surfaces the actionable error rather
                // than silently starting with no stream legs.
                if resolution.ready.is_empty() {
                    stream_targets_from_streaming(streaming)?;
                }
                resolution
            }
            None => StreamTargetResolution {
                ready: vec![build_stream_url(&params.output.rtmp)?],
                skipped: Vec::new(),
            },
        }
    } else {
        StreamTargetResolution::default()
    };
    let stream_targets = stream_resolution.ready;
    let skipped_targets = stream_resolution.skipped;
    let stream_url = (!stream_targets.is_empty()).then(|| {
        stream_targets
            .iter()
            .map(|target| target.redacted_url.clone())
            .collect::<Vec<_>>()
            .join(", ")
    });
    let mode = output_mode(params.output.record_enabled, params.output.stream_enabled);
    let container =
        container_for_outputs(params.output.record_enabled, params.output.stream_enabled);

    state.database.create_session(&NewSession {
        id: session_id.clone(),
        title: format!("Session {}", started_at.format("%Y-%m-%d %H:%M")),
        started_at: started_at.to_rfc3339(),
        mode: mode.to_string(),
        output_path: output_path.as_ref().map(|path| path.display().to_string()),
        container: Some(container_key(&container).to_string()),
        stream_preset: params
            .output
            .stream_enabled
            .then(|| format!("{:?}", params.output.rtmp.preset)),
        sources: params.sources.clone(),
        layout: params.layout.clone(),
        output: params.output.clone(),
    })?;
    state
        .database
        .save_setting("last_capture_session", &params)?;
    if !stream_targets.is_empty() {
        let redacted = stream_targets
            .iter()
            .map(|target| target.redacted_url.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let _ = state.database.add_session_log(
            &session_id,
            HealthLevel::Info,
            "stream-targets-configured",
            &format!(
                "Streaming to {} destination(s): {redacted}",
                stream_targets.len()
            ),
            None,
        );
    }
    let _ = state.database.add_session_log(
        &session_id,
        HealthLevel::Info,
        "recording-start-requested",
        &format!("Starting {mode} session."),
        None,
    );

    emit_foundation_health_events(&state, &session_id, &params)?;
    if params.output.record_enabled {
        emit_disk_space_health_event(&state, &session_id, &output_dir).await?;
    }

    stop_idle_live_preview_for_recording(state.clone()).await;

    let mut capture = resolve_capture_inputs(&ffmpeg_path, &params).await;
    let native_audio_source =
        prepare_native_audio_source(&state, &session_id, &mut capture, &params).await;
    let audio_tracks = capture_audio_tracks(&capture);
    if matches!(capture.video, VideoInput::TestPattern) {
        let (code, message) = if matches!(params.layout.layout_preset, LayoutPreset::CameraOnly) {
            (
                "camera-capture-fallback",
                "Using FFmpeg test pattern because the selected camera was not available for camera-only capture.",
            )
        } else {
            (
                "screen-capture-fallback",
                "Using FFmpeg test pattern because a macOS screen/window source was not available.",
            )
        };
        emit_health_event(&state, Some(&session_id), HealthLevel::Warn, code, message)?;
    }
    // The screen+camera overlay and side-by-side paths both rely on the camera;
    // camera-only handles an unavailable camera via the test-pattern fallback
    // above and screen-only deliberately omits the camera.
    if matches!(
        params.layout.layout_preset,
        LayoutPreset::ScreenCamera | LayoutPreset::SideBySide
    ) && params.sources.camera_id.is_some()
        && capture.camera_index.is_none()
    {
        emit_health_event(
            &state,
            Some(&session_id),
            HealthLevel::Warn,
            "camera-source-unavailable",
            "Selected camera could not be bridged to the current FFmpeg recording path; continuing without the camera.",
        )?;
    }
    emit_audio_track_health_events(&state, &session_id, &params, &audio_tracks)?;
    let active_screen = state.database.active_stream_screen()?;
    let screen_overlay_fifo = screen_overlay_fifo_path(&session_id);
    create_screen_overlay_fifo(&screen_overlay_fifo)?;

    let mut pipeline = RecordingPipeline::new(
        params.output.record_enabled,
        params.output.stream_enabled,
        &audio_tracks,
    );
    let initial_diagnostics = starting_diagnostics(&session_id, params.output.video.fps);
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = initial_diagnostics.clone();
    }
    state.emit_event("diagnostics.stats", initial_diagnostics);
    let screen_overlay = ScreenOverlayInput {
        fifo_path: screen_overlay_fifo.clone(),
        width: params.output.video.width,
        height: params.output.video.height,
        fps: SCREEN_OVERLAY_FPS,
    };
    let args = ffmpeg_args(
        &capture,
        &params,
        output_path.as_deref(),
        &stream_targets,
        Some(&screen_overlay),
    )?;

    state.emit_event(
        "recording.status",
        RecordingStatus {
            state: RecordingState::Starting,
            session_id: Some(session_id.clone()),
            output_path: output_path.as_ref().map(|path| path.display().to_string()),
            stream_url: stream_url.clone(),
            started_at: Some(started_at.to_rfc3339()),
            audio_tracks: audio_tracks.clone(),
            pipeline: Some(pipeline.status()),
            duration_ms: None,
            message: Some(format!("Starting {mode} session.")),
        },
    );

    let mut child = ffmpeg_command(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Could not start {ffmpeg_path}"))?;

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let stdin = child.stdin.take();
    let pid = child.id().unwrap_or_default();
    pipeline.mark_running();
    let active = ActiveRecording {
        session_id: session_id.clone(),
        pid,
        stdin,
        output_path: output_path.clone(),
        stream_url,
        ffmpeg_path: ffmpeg_path.clone(),
        started_at: started_at.to_rfc3339(),
        mode: mode.to_string(),
        audio_tracks,
        pipeline,
        native_audio: native_audio_source
            .map(|prepared| attach_fifo_writer(prepared.source, prepared.fifo_path)),
        screen_overlay: Some(ScreenOverlaySession::start(
            screen_overlay_fifo,
            params.output.video.width,
            params.output.video.height,
            active_screen.map(|screen| screen.image_path),
        )?),
        stop_requested: false,
    };
    let running_state = if params.output.stream_enabled && !params.output.record_enabled {
        RecordingState::Streaming
    } else {
        RecordingState::Recording
    };
    let running_status = active.status(running_state, Some(format!("Running {mode} session.")));

    *state.recording.lock().await = Some(active);
    state.emit_event("recording.status", running_status.clone());
    publish_recording_live_preview_status(&state, None).await;
    if let Some(stdout) = stdout {
        tokio::spawn(publish_preview_stdout(state.clone(), None, stdout));
    }

    let has_recording_leg = output_path.is_some();
    let (stream_runtime, slave_positions) =
        build_stream_runtime(&stream_targets, &skipped_targets, has_recording_leg);
    if !stream_runtime.is_empty() {
        state.emit_event(
            "stream.targets",
            StreamTargetsSnapshot {
                session_id: session_id.clone(),
                targets: stream_runtime.clone(),
            },
        );
    }

    if let Some(stderr) = stderr {
        let log_state = state.clone();
        let log_session_id = session_id.clone();
        let target_fps = params.output.video.fps;
        tokio::spawn(async move {
            let mut stream_runtime = stream_runtime;
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                log_state.emit_log("warn", trimmed);
                if let Some(stream_health) = parse_ffmpeg_stream_health(&log_session_id, trimmed) {
                    let diagnostic_stats = {
                        let mut diagnostics = log_state.diagnostics.lock().await;
                        let next =
                            apply_stream_health(diagnostics.clone(), &stream_health, target_fps);
                        *diagnostics = next.clone();
                        next
                    };
                    log_state.emit_event("diagnostics.stats", diagnostic_stats);
                    if stream_health.dropped_frames.unwrap_or_default() > 0 {
                        let _ = emit_health_event(
                            &log_state,
                            Some(&log_session_id),
                            HealthLevel::Warn,
                            "stream-dropped-frames",
                            &format!(
                                "FFmpeg reports {} dropped frames.",
                                stream_health.dropped_frames.unwrap_or_default()
                            ),
                        );
                    }
                    log_state.emit_event("stream.health", stream_health);
                }
                if looks_like_ffmpeg_health_event(trimmed) {
                    let _ = emit_health_event(
                        &log_state,
                        Some(&log_session_id),
                        HealthLevel::Warn,
                        "ffmpeg-warning",
                        trimmed,
                    );
                }
                // A `tee` slave dropping mid-session (onfail=ignore keeps the rest
                // running) — attribute it to the specific target and re-emit the
                // per-target snapshot so the UI can flag exactly which platform fell.
                if let Some(failure) = parse_tee_slave_failure(trimmed)
                    && let Some(Some(position)) = slave_positions.get(failure.slave_index).copied()
                {
                    let mut changed = false;
                    if let Some(entry) = stream_runtime.get_mut(position)
                        && entry.state != StreamTargetState::Failed
                    {
                        let reason = if failure.reason.is_empty() {
                            "Stream connection failed".to_string()
                        } else {
                            failure.reason.clone()
                        };
                        let _ = emit_health_event(
                            &log_state,
                            Some(&log_session_id),
                            HealthLevel::Warn,
                            "stream-target-failed",
                            &format!("Streaming to {} stopped: {reason}", entry.label),
                        );
                        entry.state = StreamTargetState::Failed;
                        entry.message = Some(reason);
                        changed = true;
                    }
                    if changed {
                        log_state.emit_event(
                            "stream.targets",
                            StreamTargetsSnapshot {
                                session_id: log_session_id.clone(),
                                targets: stream_runtime.clone(),
                            },
                        );
                    }
                }
            }
        });
    }

    tokio::spawn(monitor_session(
        state.clone(),
        child,
        session_id,
        output_path,
    ));
    Ok(running_status)
}

fn hydrate_oauth_stream_keys(state: &AppState, params: &mut StartSessionParams) -> Result<()> {
    if !params.output.stream_enabled {
        return Ok(());
    }
    let Some(streaming) = params
        .streaming
        .as_mut()
        .filter(|streaming| streaming.enabled)
    else {
        return Ok(());
    };
    if !streaming
        .targets
        .iter()
        .any(|target| target.enabled && target.auth_mode == StreamAuthMode::Oauth)
    {
        return Ok(());
    }

    let credentials = state.database.list_platform_account_credentials()?;
    hydrate_oauth_stream_keys_from_credentials(streaming, &credentials, secrets::get_secret)
}

fn hydrate_oauth_stream_keys_from_credentials(
    streaming: &mut StreamingSettings,
    credentials: &[PlatformAccountCredentials],
    mut get_secret: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    for target in streaming
        .targets
        .iter_mut()
        .filter(|target| target.enabled && target.auth_mode == StreamAuthMode::Oauth)
    {
        if !target.stream_key.trim().is_empty() {
            target.stream_key_present = true;
            continue;
        }
        let credential = credentials.iter().find(|credential| {
            credential.account.platform == target.platform
                && target.account_id.as_deref().is_none_or(|account_id| {
                    credential.account.account_id == account_id
                        || credential.account.id == account_id
                })
        });
        let secret_ref = target
            .stream_key_secret_ref
            .clone()
            .or_else(|| credential.and_then(|credential| credential.stream_key_secret_ref.clone()));
        let Some(secret_ref) = secret_ref else {
            continue;
        };
        let stream_key = get_secret(&secret_ref)?;
        if !stream_key.trim().is_empty() {
            target.stream_key = stream_key;
            target.stream_key_secret_ref = Some(secret_ref);
            target.stream_key_present = true;
        }
    }

    Ok(())
}

pub async fn stop_recording(state: AppState) -> Result<RecordingStatus> {
    let mut final_status_events = state.events.subscribe();
    let mut guard = state.recording.lock().await;
    let Some(active) = guard.as_mut() else {
        return Ok(idle_status());
    };

    let pid = active.pid;
    let output_path = active.output_path.clone();
    let session_id = active.session_id.clone();
    let wait_session_id = session_id.clone();
    let mut force_stop_now = false;
    active.stop_requested = true;
    active
        .pipeline
        .mark_finalizing("Waiting for FFmpeg to flush and close output files.");
    if let Some(mut stdin) = active.stdin.take() {
        stdin
            .write_all(b"q\n")
            .await
            .context("Could not send stop command to FFmpeg")?;
        let _ = stdin.shutdown().await;
    } else {
        force_stop_now = true;
    }

    let status = active.status(
        RecordingState::Stopping,
        Some(if force_stop_now {
            format!("Force stopping {} session.", active.mode)
        } else {
            format!("Stopping {} session.", active.mode)
        }),
    );
    drop(guard);

    state.emit_event("recording.status", status.clone());
    let _ = emit_session_log(
        &state,
        &wait_session_id,
        HealthLevel::Info,
        "recording-stop-requested",
        "Stop requested; waiting for FFmpeg to finalize outputs.",
        None,
    );
    if force_stop_now {
        state.emit_log("warn", "Stop requested again; sending SIGTERM to FFmpeg.");
        let _ = send_process_signal(pid, "TERM").await;
        tokio::spawn(stop_kill_fallback(
            state.clone(),
            pid,
            session_id,
            output_path,
        ));
    } else {
        tokio::spawn(stop_fallback(state.clone(), pid, session_id, output_path));
    }

    Ok(
        wait_for_final_recording_status(&mut final_status_events, &wait_session_id)
            .await
            .unwrap_or(status),
    )
}

pub async fn remux_session(state: AppState, params: RemuxSessionParams) -> Result<String> {
    let input = state
        .database
        .session_recording_path(&params.session_id)?
        .map(PathBuf::from)
        .context("Session does not have an MKV output path")?;

    if input.extension().and_then(|value| value.to_str()) != Some("mkv") {
        bail!("Only MKV session outputs can be remuxed to MP4");
    }

    let output = input.with_extension("mp4");
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path);
    export_mp4_from_mkv(&ffmpeg_path, &input, &output).await?;

    state.database.finish_session(
        &params.session_id,
        "completed",
        None,
        Some(output.display().to_string()),
        None,
    )?;
    state.emit_log("info", "Created MP4 copy for session.");
    Ok(output.display().to_string())
}

async fn export_mp4_from_mkv(ffmpeg_path: &str, input: &Path, output: &Path) -> Result<()> {
    let status = Command::new(ffmpeg_path)
        .args(mp4_export_args(input, output))
        .status()
        .await
        .with_context(|| format!("Could not start {ffmpeg_path} for MP4 export"))?;

    if !status.success() {
        bail!("FFmpeg MP4 export failed with {status}");
    }

    Ok(())
}

fn mp4_export_args(input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-i".to_string(),
        input.display().to_string(),
        "-map".to_string(),
        "0".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output.display().to_string(),
    ]
}

pub async fn create_preview_snapshot(
    state: AppState,
    params: PreviewSnapshotParams,
) -> Result<PreviewSnapshot> {
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());
    let preview_id = Uuid::new_v4().to_string();
    let preview_dir = default_preview_dir();
    fs::create_dir_all(&preview_dir)
        .await
        .with_context(|| format!("Could not create {}", preview_dir.display()))?;

    let output_path = preview_file_path(&preview_id);
    let session_params = StartSessionParams {
        sources: params.sources,
        layout: params.layout,
        output: crate::protocol::OutputSettings {
            record_enabled: true,
            stream_enabled: false,
            output_directory: None,
            ffmpeg_path: Some(ffmpeg_path.clone()),
            video: default_video_settings(),
            rtmp: RtmpSettings {
                preset: RtmpPreset::Custom,
                server_url: "rtmp://preview.invalid/live".to_string(),
                stream_key: "preview".to_string(),
            },
        },
        audio: Default::default(),
        streaming: None,
    };
    let mut capture = resolve_capture_inputs(&ffmpeg_path, &session_params).await;
    capture.microphone = None;
    let args = preview_ffmpeg_args(&capture, &session_params, &output_path)?;
    let output = run_preview_command(&ffmpeg_path, &args).await?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "Preview snapshot failed{}",
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        );
    }

    let snapshot = PreviewSnapshot {
        id: preview_id.clone(),
        url: format!(
            "http://127.0.0.1:{}/preview/{}?token={}",
            state.port, preview_id, state.token
        ),
        created_at: Utc::now().to_rfc3339(),
    };
    state.emit_event("preview.updated", &snapshot);
    Ok(snapshot)
}

#[derive(Debug)]
struct PreviewCommandOutput {
    status: ExitStatus,
    stderr: Vec<u8>,
}

async fn run_preview_command(ffmpeg_path: &str, args: &[String]) -> Result<PreviewCommandOutput> {
    run_preview_command_with_timeout(ffmpeg_path, args, PREVIEW_SNAPSHOT_TIMEOUT).await
}

async fn run_preview_command_with_timeout(
    ffmpeg_path: &str,
    args: &[String],
    preview_timeout: Duration,
) -> Result<PreviewCommandOutput> {
    let mut child = ffmpeg_command(ffmpeg_path)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Could not start {ffmpeg_path} for preview"))?;

    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_end(&mut bytes).await;
        }
        bytes
    });

    let status = match timeout(preview_timeout, child.wait()).await {
        Ok(status) => {
            status.with_context(|| format!("Could not wait for {ffmpeg_path} preview"))?
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let stderr = stderr_task.await.unwrap_or_default();
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            bail!(
                "Preview snapshot timed out after {} seconds{}",
                preview_timeout.as_secs(),
                if message.is_empty() {
                    String::new()
                } else {
                    format!(": {message}")
                }
            );
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();

    Ok(PreviewCommandOutput { status, stderr })
}

pub fn preview_file_path(preview_id: &str) -> PathBuf {
    default_preview_dir().join(format!("{preview_id}.jpg"))
}

pub async fn start_live_preview(
    state: AppState,
    params: PreviewLiveParams,
) -> Result<PreviewLiveStatus> {
    if state.recording.lock().await.is_some() {
        let status = recording_live_preview_status(&state, None);
        {
            let mut guard = state.live_preview.lock().await;
            guard.desired_params = Some(params);
            guard.status = status.clone();
        }
        state.emit_event("preview.live.status", status.clone());
        return Ok(status);
    }

    if let Some(status) = reusable_idle_live_preview_status(&state, &params).await {
        return Ok(status);
    }

    start_idle_live_preview(state, params, PreviewLiveState::Connecting).await
}

pub async fn stop_live_preview(state: AppState) -> Result<PreviewLiveStatus> {
    let process = {
        let mut guard = state.live_preview.lock().await;
        let process = guard.idle_process.take();
        guard.desired_params = None;
        guard.status = unavailable_live_preview_status(Some("Live preview stopped.".to_string()));
        process
    };
    clear_latest_preview_frame(&state).await;
    stop_live_preview_process(process).await;

    let status = live_preview_status(&state).await;
    state.emit_event("preview.live.status", status.clone());
    Ok(status)
}

pub async fn live_preview_status(state: &AppState) -> PreviewLiveStatus {
    state.live_preview.lock().await.status.clone()
}

async fn reusable_idle_live_preview_status(
    state: &AppState,
    params: &PreviewLiveParams,
) -> Option<PreviewLiveStatus> {
    let guard = state.live_preview.lock().await;
    if should_reuse_idle_live_preview(&guard, params) {
        return Some(guard.status.clone());
    }

    None
}

fn should_reuse_idle_live_preview(preview: &LivePreviewState, params: &PreviewLiveParams) -> bool {
    preview.idle_process.is_some()
        && preview.desired_params.as_ref() == Some(params)
        && matches!(
            preview.status.state,
            PreviewLiveState::Connecting | PreviewLiveState::Live | PreviewLiveState::Reconnecting
        )
}

pub fn subscribe_live_preview_frames(
    state: &AppState,
) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
    state.preview_frames.subscribe()
}

fn ffmpeg_command(ffmpeg_path: &str) -> Command {
    let mut command = Command::new(ffmpeg_path);
    command.kill_on_drop(true);
    command
}

pub async fn shutdown_capture_processes(state: AppState) {
    let idle_process = {
        let mut guard = state.live_preview.lock().await;
        guard.desired_params = None;
        guard.status = unavailable_live_preview_status(Some(
            "Backend is shutting down; live preview stopped.".to_string(),
        ));
        guard.idle_process.take()
    };
    stop_live_preview_process(idle_process).await;

    let recording = {
        let mut guard = state.recording.lock().await;
        guard.take()
    };
    stop_recording_process_for_shutdown(recording).await;
}

async fn start_idle_live_preview(
    state: AppState,
    params: PreviewLiveParams,
    starting_state: PreviewLiveState,
) -> Result<PreviewLiveStatus> {
    let old_process = {
        let mut guard = state.live_preview.lock().await;
        let old_process = guard.idle_process.take();
        guard.desired_params = Some(params.clone());
        guard.status = PreviewLiveStatus {
            state: starting_state,
            source: PreviewLiveSource::IdlePreview,
            url: Some(live_preview_url(&state)),
            message: Some("Starting live preview.".to_string()),
        };
        old_process
    };
    clear_latest_preview_frame(&state).await;
    state.emit_event("preview.live.status", live_preview_status(&state).await);
    stop_live_preview_process(old_process).await;

    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());
    let session_params = live_preview_session_params(params, ffmpeg_path.clone());
    let mut capture = resolve_capture_inputs(&ffmpeg_path, &session_params).await;
    capture.microphone = None;
    let args = live_preview_ffmpeg_args(&capture, &session_params)?;

    let mut command = ffmpeg_command(&ffmpeg_path);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let status = unavailable_live_preview_status(Some(format!(
                "Could not start {ffmpeg_path} for live preview: {error}"
            )));
            {
                let mut guard = state.live_preview.lock().await;
                guard.status = status.clone();
                guard.idle_process = None;
            }
            state.emit_event("preview.live.status", status.clone());
            return Ok(status);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    let pid = child.id().unwrap_or_default();

    if let Some(stdout) = stdout {
        tokio::spawn(publish_preview_stdout(state.clone(), Some(pid), stdout));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(log_live_preview_stderr(state.clone(), stderr));
    }

    {
        let mut guard = state.live_preview.lock().await;
        guard.idle_process = Some(ActiveLivePreview {
            pid,
            stdin,
            first_frame_received: false,
        });
    }
    let status = live_preview_status(&state).await;
    state.emit_event("preview.live.status", status.clone());
    tokio::spawn(watch_idle_live_preview_first_frame(state.clone(), pid));
    tokio::spawn(monitor_idle_live_preview(state.clone(), child, pid));
    Ok(status)
}

fn live_preview_session_params(
    params: PreviewLiveParams,
    ffmpeg_path: String,
) -> StartSessionParams {
    let video = live_preview_video_settings(params.video.unwrap_or_else(default_video_settings));

    StartSessionParams {
        sources: params.sources,
        layout: params.layout,
        output: crate::protocol::OutputSettings {
            record_enabled: true,
            stream_enabled: false,
            output_directory: None,
            ffmpeg_path: Some(ffmpeg_path),
            video,
            rtmp: RtmpSettings {
                preset: RtmpPreset::Custom,
                server_url: "rtmp://preview.invalid/live".to_string(),
                stream_key: "preview".to_string(),
            },
        },
        audio: Default::default(),
        streaming: None,
    }
}

fn live_preview_video_settings(mut video: VideoSettings) -> VideoSettings {
    video.width = LIVE_PREVIEW_WIDTH;
    video.height = LIVE_PREVIEW_HEIGHT;
    video.fps = video.fps.clamp(24, LIVE_PREVIEW_FPS);
    video.bitrate_kbps = video.bitrate_kbps.min(4000);
    video
}

async fn stop_idle_live_preview_for_recording(state: AppState) {
    let process = {
        let mut guard = state.live_preview.lock().await;
        let process = guard.idle_process.take();
        if guard.desired_params.is_some() || process.is_some() {
            guard.status = PreviewLiveStatus {
                state: PreviewLiveState::Connecting,
                source: PreviewLiveSource::RecordingSession,
                url: Some(live_preview_url(&state)),
                message: Some("Switching preview to the recording session.".to_string()),
            };
        }
        process
    };
    clear_latest_preview_frame(&state).await;
    if process.is_some() {
        state.emit_event("preview.live.status", live_preview_status(&state).await);
    }
    stop_live_preview_process(process).await;
}

async fn publish_recording_live_preview_status(state: &AppState, message: Option<String>) {
    let status = recording_live_preview_status(state, message);
    {
        let mut guard = state.live_preview.lock().await;
        guard.status = status.clone();
    }
    state.emit_event("preview.live.status", status);
}

async fn clear_latest_preview_frame(state: &AppState) {
    *state.preview_latest_frame.write().await = None;
}

async fn restart_idle_live_preview_if_desired(state: AppState) {
    let desired_params = {
        let mut guard = state.live_preview.lock().await;
        let desired_params = guard.desired_params.clone();
        if desired_params.is_some() {
            guard.status = PreviewLiveStatus {
                state: PreviewLiveState::Reconnecting,
                source: PreviewLiveSource::IdlePreview,
                url: Some(live_preview_url(&state)),
                message: Some("Restarting idle live preview.".to_string()),
            };
        } else {
            guard.status =
                unavailable_live_preview_status(Some("No live preview requested.".to_string()));
        }
        desired_params
    };
    state.emit_event("preview.live.status", live_preview_status(&state).await);

    if let Some(params) = desired_params {
        let _ = start_idle_live_preview(state, params, PreviewLiveState::Reconnecting).await;
    }
}

async fn monitor_idle_live_preview(state: AppState, mut child: tokio::process::Child, pid: u32) {
    let status = child.wait().await;
    let mut should_emit = false;
    {
        let mut guard = state.live_preview.lock().await;
        let matches_active = guard
            .idle_process
            .as_ref()
            .is_some_and(|process| process.pid == pid);
        if matches_active {
            guard.idle_process = None;
            let message = match status {
                Ok(exit_status) if exit_status.success() => "Live preview stopped.".to_string(),
                Ok(exit_status) => format!("Live preview exited with {exit_status}."),
                Err(error) => format!("Could not wait for live preview: {error}."),
            };
            guard.status = unavailable_live_preview_status(Some(message));
            should_emit = true;
        }
    }

    if should_emit {
        state.emit_event("preview.live.status", live_preview_status(&state).await);
    }
}

async fn publish_preview_stdout(state: AppState, idle_pid: Option<u32>, mut stdout: ChildStdout) {
    let mut buffer = [0_u8; PREVIEW_READ_BUFFER_BYTES];
    let mut pending = Vec::new();
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);

                while let Some(part) = drain_next_mjpeg_part(&mut pending) {
                    if let Some(jpeg) = jpeg_bytes_from_mjpeg_part(&part) {
                        *state.preview_latest_frame.write().await = Some(jpeg);
                        if let Some(pid) = idle_pid {
                            mark_idle_live_preview_frame_received(&state, pid).await;
                        }
                    }
                    let _ = state.preview_frames.send(part);
                }

                if pending.len() > MAX_PENDING_PREVIEW_BYTES {
                    if let Some(boundary) = find_bytes(&pending, MJPEG_BOUNDARY) {
                        pending.drain(..boundary);
                    } else {
                        pending.clear();
                    }
                }
            }
            Err(error) => {
                state.emit_log("warn", format!("Live preview stream read failed: {error}"));
                break;
            }
        }
    }
}

fn drain_next_mjpeg_part(pending: &mut Vec<u8>) -> Option<Vec<u8>> {
    let start = find_bytes(pending, MJPEG_BOUNDARY)?;
    if start > 0 {
        pending.drain(..start);
    }

    let header_end = find_bytes(pending, MJPEG_HEADER_END)? + MJPEG_HEADER_END.len();
    let content_length = parse_mjpeg_content_length(&pending[..header_end])?;
    let mut part_end = header_end + content_length;
    if pending.len() < part_end {
        return None;
    }
    if pending.len() >= part_end + 2 && &pending[part_end..part_end + 2] == b"\r\n" {
        part_end += 2;
    }

    Some(pending.drain(..part_end).collect())
}

fn parse_mjpeg_content_length(headers: &[u8]) -> Option<usize> {
    let headers = std::str::from_utf8(headers).ok()?;
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

fn jpeg_bytes_from_mjpeg_part(part: &[u8]) -> Option<Vec<u8>> {
    let header_end = find_bytes(part, MJPEG_HEADER_END)? + MJPEG_HEADER_END.len();
    let content_length = parse_mjpeg_content_length(&part[..header_end])?;
    let part_end = header_end + content_length;
    (part.len() >= part_end).then(|| part[header_end..part_end].to_vec())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn mark_idle_live_preview_frame_received(state: &AppState, pid: u32) {
    let mut should_emit = false;
    {
        let mut guard = state.live_preview.lock().await;
        let should_mark_live = match guard.idle_process.as_mut() {
            Some(process) if process.pid == pid && !process.first_frame_received => {
                process.first_frame_received = true;
                true
            }
            _ => false,
        };
        if should_mark_live {
            guard.status = PreviewLiveStatus {
                state: PreviewLiveState::Live,
                source: PreviewLiveSource::IdlePreview,
                url: Some(live_preview_url(state)),
                message: Some("Live preview is receiving frames.".to_string()),
            };
            should_emit = true;
        }
    }

    if should_emit {
        state.emit_event("preview.live.status", live_preview_status(state).await);
    }
}

async fn watch_idle_live_preview_first_frame(state: AppState, pid: u32) {
    sleep(Duration::from_secs(6)).await;
    let process = {
        let mut guard = state.live_preview.lock().await;
        match guard.idle_process.as_ref() {
            Some(process) if process.pid == pid && !process.first_frame_received => {
                guard.status = unavailable_live_preview_status(Some(
                    "Live preview did not receive video frames. Check macOS screen/camera permissions or select another source."
                        .to_string(),
                ));
                guard.idle_process.take()
            }
            _ => None,
        }
    };

    if process.is_some() {
        state.emit_event("preview.live.status", live_preview_status(&state).await);
        stop_live_preview_process(process).await;
    }
}

async fn log_live_preview_stderr(state: AppState, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        state.emit_log("warn", trimmed);
    }
}

async fn stop_live_preview_process(process: Option<ActiveLivePreview>) {
    let Some(mut process) = process else {
        return;
    };

    if let Some(mut stdin) = process.stdin.take() {
        let _ = stdin.write_all(b"q\n").await;
        let _ = stdin.shutdown().await;
    }

    if process.pid != 0 {
        if wait_for_process_exit(process.pid, Duration::from_secs(2)).await {
            return;
        }
        let _ = send_process_signal(process.pid, "TERM").await;
        if wait_for_process_exit(process.pid, Duration::from_secs(2)).await {
            return;
        }
        let _ = send_process_signal(process.pid, "KILL").await;
        let _ = wait_for_process_exit(process.pid, Duration::from_secs(1)).await;
    }
}

async fn stop_recording_process_for_shutdown(recording: Option<ActiveRecording>) {
    let Some(mut recording) = recording else {
        return;
    };

    if let Some(mut stdin) = recording.stdin.take() {
        let _ = stdin.write_all(b"q\n").await;
        let _ = stdin.shutdown().await;
    }

    if recording.pid == 0 {
        return;
    }

    sleep(SHUTDOWN_GRACE_DELAY).await;
    if !process_is_running(recording.pid).await {
        return;
    }

    let _ = send_process_signal(recording.pid, "TERM").await;
    sleep(SHUTDOWN_GRACE_DELAY).await;
    if process_is_running(recording.pid).await {
        let _ = send_process_signal(recording.pid, "KILL").await;
    }
}

fn recording_live_preview_status(state: &AppState, message: Option<String>) -> PreviewLiveStatus {
    PreviewLiveStatus {
        state: PreviewLiveState::Live,
        source: PreviewLiveSource::RecordingSession,
        url: Some(live_preview_url(state)),
        message: Some(message.unwrap_or_else(|| {
            "Live preview is following the active recording session.".to_string()
        })),
    }
}

fn unavailable_live_preview_status(message: Option<String>) -> PreviewLiveStatus {
    PreviewLiveStatus {
        state: PreviewLiveState::Unavailable,
        source: PreviewLiveSource::Unavailable,
        url: None,
        message,
    }
}

fn live_preview_url(state: &AppState) -> String {
    format!(
        "http://127.0.0.1:{}/preview/live.mjpeg?token={}",
        state.port, state.token
    )
}

async fn stop_fallback(
    state: AppState,
    pid: u32,
    session_id: String,
    output_path: Option<PathBuf>,
) {
    if pid == 0 {
        return;
    }

    sleep(STOP_TERM_DELAY).await;

    if !recording_matches(&state, pid, &session_id, &output_path).await {
        return;
    }

    state.emit_log(
        "warn",
        "FFmpeg did not stop promptly after stdin quit command; sending SIGTERM.",
    );
    let _ = send_process_signal(pid, "TERM").await;
    stop_kill_fallback(state, pid, session_id, output_path).await;
}

async fn stop_kill_fallback(
    state: AppState,
    pid: u32,
    session_id: String,
    output_path: Option<PathBuf>,
) {
    sleep(STOP_KILL_DELAY).await;

    if !recording_matches(&state, pid, &session_id, &output_path).await {
        return;
    }

    state.emit_log(
        "warn",
        "FFmpeg did not stop after SIGTERM; sending SIGKILL.",
    );
    let _ = send_process_signal(pid, "KILL").await;
}

async fn recording_matches(
    state: &AppState,
    pid: u32,
    session_id: &str,
    output_path: &Option<PathBuf>,
) -> bool {
    state.recording.lock().await.as_ref().is_some_and(|active| {
        active.pid == pid && active.session_id == session_id && &active.output_path == output_path
    })
}

async fn wait_for_final_recording_status(
    events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    session_id: &str,
) -> Option<RecordingStatus> {
    timeout(STOP_FINALIZE_TIMEOUT, async {
        loop {
            match events.recv().await {
                Ok(event) if event.event == "recording.status" => {
                    let Ok(status) = serde_json::from_value::<RecordingStatus>(event.payload)
                    else {
                        continue;
                    };
                    if status.session_id.as_deref() == Some(session_id)
                        && matches!(status.state, RecordingState::Idle | RecordingState::Failed)
                    {
                        return Some(status);
                    }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

async fn send_process_signal(pid: u32, signal: &str) -> Result<()> {
    Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .status()
        .await
        .with_context(|| format!("Could not send SIG{signal} to FFmpeg"))?;
    Ok(())
}

async fn process_is_running(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

async fn wait_for_process_exit(pid: u32, wait: Duration) -> bool {
    timeout(wait, async {
        while process_is_running(pid).await {
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .is_ok()
}

async fn monitor_session(
    state: AppState,
    mut child: tokio::process::Child,
    session_id: String,
    output_path: Option<PathBuf>,
) {
    let status = child.wait().await;
    let mut guard = state.recording.lock().await;
    let monitored_recording = guard
        .as_ref()
        .filter(|active| active.session_id == session_id)
        .map(|active| {
            let native_audio_stats = active.native_audio.as_ref().map(|audio| NativeAudioStats {
                device_name: audio.device_name.clone(),
                captured_frames: audio.captured_frames(),
                dropped_frames: audio.dropped_frames(),
            });
            MonitoredRecording {
                stop_requested: active.stop_requested,
                ffmpeg_path: active.ffmpeg_path.clone(),
                started_at: active.started_at.clone(),
                pipeline: active.pipeline.clone(),
                native_audio_stats,
            }
        });
    if monitored_recording.is_some() {
        guard.take();
    }
    drop(guard);

    let Some(mut monitored_recording) = monitored_recording else {
        return;
    };

    if let Some(native_audio_stats) = monitored_recording.native_audio_stats {
        let diagnostic_stats = {
            let mut diagnostics = state.diagnostics.lock().await;
            let next = apply_audio_stats(
                diagnostics.clone(),
                native_audio_stats.captured_frames,
                native_audio_stats.dropped_frames,
            );
            *diagnostics = next.clone();
            next
        };
        state.emit_event("diagnostics.stats", diagnostic_stats);
        state.emit_log(
            if native_audio_stats.dropped_frames > 0 {
                "warn"
            } else {
                "info"
            },
            format!(
                "Native microphone capture ended for {}: {} frames captured, {} frames dropped.",
                native_audio_stats.device_name,
                native_audio_stats.captured_frames,
                native_audio_stats.dropped_frames
            ),
        );
        if native_audio_stats.dropped_frames > 0 {
            let message = format!(
                "Native microphone dropped {} frames during capture.",
                native_audio_stats.dropped_frames
            );
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Warn,
                "mic-dropped-frames",
                &message,
            );
        }
    }

    let ended_at = Utc::now().to_rfc3339();
    let duration_ms = recording_duration_ms(&monitored_recording.started_at, &ended_at);
    match status {
        Ok(exit_status) if exit_status.success() || monitored_recording.stop_requested => {
            let message = if exit_status.success() {
                "Capture session finalized.".to_string()
            } else {
                format!("Capture session finalized after stop signal ({exit_status}).")
            };
            monitored_recording.pipeline.mark_finished();
            state.emit_log(
                if exit_status.success() {
                    "info"
                } else {
                    "warn"
                },
                &message,
            );
            let mp4_path = if let Some(output_path) = output_path.as_ref() {
                match export_completed_recording_to_mp4(
                    &state,
                    &session_id,
                    &monitored_recording.ffmpeg_path,
                    output_path,
                )
                .await
                {
                    Ok(path) => path,
                    Err(error) => {
                        let message = format!(
                            "MP4 export failed; keeping MKV recovery file at {}. {error}",
                            output_path.display()
                        );
                        state.emit_log("warn", &message);
                        let _ = emit_health_event(
                            &state,
                            Some(&session_id),
                            HealthLevel::Warn,
                            "mp4-export-failed",
                            &message,
                        );
                        None
                    }
                }
            } else {
                None
            };
            let _ = state.database.finish_session(
                &session_id,
                "completed",
                Some(ended_at),
                mp4_path.as_ref().map(|path| path.display().to_string()),
                duration_ms,
            );
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Info,
                "recording-finalized",
                "Recording pipeline finalized and output metadata was saved.",
            );
            state.emit_event(
                "recording.status",
                RecordingStatus {
                    state: RecordingState::Idle,
                    session_id: Some(session_id),
                    output_path: mp4_path
                        .as_ref()
                        .or(output_path.as_ref())
                        .map(|path| path.display().to_string()),
                    stream_url: None,
                    started_at: None,
                    audio_tracks: Vec::new(),
                    pipeline: Some(monitored_recording.pipeline.status()),
                    duration_ms,
                    message: Some("Capture session finalized.".to_string()),
                },
            );
        }
        Ok(exit_status) => {
            let message = format!("FFmpeg exited with {exit_status}");
            monitored_recording
                .pipeline
                .mark_failed(RecordingPipelineStage::Muxer, &message);
            state.emit_log("error", &message);
            let _ = state.database.finish_session(
                &session_id,
                "failed",
                Some(ended_at),
                None,
                duration_ms,
            );
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Error,
                "ffmpeg-exit",
                &message,
            );
            state.emit_event(
                "recording.status",
                RecordingStatus {
                    state: RecordingState::Failed,
                    session_id: Some(session_id),
                    output_path: output_path.as_ref().map(|path| path.display().to_string()),
                    stream_url: None,
                    started_at: None,
                    audio_tracks: Vec::new(),
                    pipeline: Some(monitored_recording.pipeline.status()),
                    duration_ms,
                    message: Some(message),
                },
            );
        }
        Err(error) => {
            let message = format!("Could not wait for FFmpeg: {error}");
            monitored_recording
                .pipeline
                .mark_failed(RecordingPipelineStage::Muxer, &message);
            state.emit_log("error", &message);
            let _ = state.database.finish_session(
                &session_id,
                "failed",
                Some(ended_at),
                None,
                duration_ms,
            );
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Error,
                "ffmpeg-wait-failed",
                &message,
            );
            state.emit_event(
                "recording.status",
                RecordingStatus {
                    state: RecordingState::Failed,
                    session_id: Some(session_id),
                    output_path: output_path.as_ref().map(|path| path.display().to_string()),
                    stream_url: None,
                    started_at: None,
                    audio_tracks: Vec::new(),
                    pipeline: Some(monitored_recording.pipeline.status()),
                    duration_ms,
                    message: Some(message),
                },
            );
        }
    }

    restart_idle_live_preview_if_desired(state).await;
}

async fn export_completed_recording_to_mp4(
    state: &AppState,
    session_id: &str,
    ffmpeg_path: &str,
    input: &Path,
) -> Result<Option<PathBuf>> {
    if input.extension().and_then(|value| value.to_str()) != Some("mkv") {
        return Ok(None);
    }

    let output = input.with_extension("mp4");
    state.emit_log(
        "info",
        format!("Exporting MP4 recording to {}.", output.display()),
    );
    export_mp4_from_mkv(ffmpeg_path, input, &output).await?;

    match fs::remove_file(input).await {
        Ok(()) => {
            state.emit_log(
                "info",
                format!("Removed temporary MKV capture file {}.", input.display()),
            );
        }
        Err(error) => {
            state.emit_log(
                "warn",
                format!(
                    "Created MP4 export but could not remove temporary MKV {}: {error}",
                    input.display()
                ),
            );
        }
    }

    emit_health_event(
        state,
        Some(session_id),
        HealthLevel::Info,
        "mp4-export-created",
        &format!("MP4 recording exported to {}.", output.display()),
    )?;

    Ok(Some(output))
}

#[derive(Debug)]
struct NativeAudioStats {
    device_name: String,
    captured_frames: u64,
    dropped_frames: u64,
}

#[derive(Debug)]
struct MonitoredRecording {
    stop_requested: bool,
    ffmpeg_path: String,
    started_at: String,
    pipeline: RecordingPipeline,
    native_audio_stats: Option<NativeAudioStats>,
}

fn recording_duration_ms(started_at: &str, ended_at: &str) -> Option<i64> {
    let started = DateTime::parse_from_rfc3339(started_at).ok()?;
    let ended = DateTime::parse_from_rfc3339(ended_at).ok()?;

    Some((ended - started).num_milliseconds().max(0))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureInputs {
    video: VideoInput,
    camera_index: Option<usize>,
    microphone: Option<MicrophoneInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VideoInput {
    MacScreen { index: usize },
    MacCamera { index: usize },
    TestPattern,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MicrophoneInput {
    CoreAudio {
        device_id: u32,
        fifo_path: Option<PathBuf>,
    },
    AvFoundation {
        index: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StreamTarget {
    url: String,
    redacted_url: String,
    target_id: String,
    platform: StreamPlatform,
    label: String,
}

/// An enabled stream destination that was skipped this session because its
/// credentials are incomplete. Surfaced to the renderer (M5) so the user sees which
/// platforms are not going live, rather than the leg silently disappearing.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkippedStreamTarget {
    target_id: String,
    platform: StreamPlatform,
    label: String,
    reason: String,
}

/// Outcome of resolving a `StreamingSettings` into concrete tee targets: the
/// destinations that are ready to stream, plus the enabled-but-incomplete ones.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct StreamTargetResolution {
    ready: Vec<StreamTarget>,
    skipped: Vec<SkippedStreamTarget>,
}

#[derive(Debug)]
struct PreparedNativeAudioSource {
    source: NativeAudioSource,
    fifo_path: PathBuf,
}

async fn resolve_capture_inputs(ffmpeg_path: &str, params: &StartSessionParams) -> CaptureInputs {
    let microphone = params.sources.microphone_id.as_deref().and_then(|id| {
        parse_coreaudio_microphone_id(id)
            .map(|device_id| MicrophoneInput::CoreAudio {
                device_id,
                fifo_path: None,
            })
            .or_else(|| {
                parse_avfoundation_id(id).map(|index| MicrophoneInput::AvFoundation { index })
            })
    });

    // Camera-only makes the camera the primary input. No screen is enumerated or
    // captured, so macOS Screen Recording permission is never requested.
    if matches!(params.layout.layout_preset, LayoutPreset::CameraOnly) {
        let camera_index =
            resolve_camera_input(ffmpeg_path, params.sources.camera_id.as_deref()).await;
        return CaptureInputs {
            video: camera_index
                .map(|index| VideoInput::MacCamera { index })
                .unwrap_or(VideoInput::TestPattern),
            camera_index: None,
            microphone,
        };
    }

    let selected_screen = (!params.sources.test_pattern)
        .then(|| {
            params
                .sources
                .screen_id
                .as_deref()
                .and_then(parse_avfoundation_id)
        })
        .flatten();
    // Screen-only intentionally skips the camera overlay so no camera permission
    // is requested.
    let camera_index = if matches!(params.layout.layout_preset, LayoutPreset::ScreenOnly) {
        None
    } else {
        resolve_camera_input(ffmpeg_path, params.sources.camera_id.as_deref()).await
    };
    let detected_screen = if cfg!(target_os = "macos") && !params.sources.test_pattern {
        selected_screen.or(find_avfoundation_screen_index(ffmpeg_path).await)
    } else {
        None
    };

    CaptureInputs {
        video: detected_screen
            .map(|index| VideoInput::MacScreen { index })
            .unwrap_or(VideoInput::TestPattern),
        camera_index,
        microphone,
    }
}

async fn resolve_camera_input(ffmpeg_path: &str, camera_id: Option<&str>) -> Option<usize> {
    let camera_id = camera_id?;
    if let Some(index) = parse_avfoundation_id(camera_id) {
        return Some(index);
    }

    let camera_name = native_camera_name_for_id(camera_id)?;
    find_avfoundation_camera_index(ffmpeg_path, &camera_name).await
}

async fn prepare_native_audio_source(
    state: &AppState,
    session_id: &str,
    capture: &mut CaptureInputs,
    params: &StartSessionParams,
) -> Option<PreparedNativeAudioSource> {
    let Some(MicrophoneInput::CoreAudio {
        device_id,
        fifo_path,
    }) = capture.microphone.as_mut()
    else {
        return None;
    };

    let path = native_audio_fifo_path(session_id);
    if let Err(error) = create_native_audio_fifo(&path) {
        let message = format!(
            "Native CoreAudio microphone is unavailable; continuing video-only. Could not create audio FIFO: {error}"
        );
        state.emit_log("warn", &message);
        let _ = emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Warn,
            "microphone-native-fifo-failed",
            &message,
        );
        capture.microphone = None;
        return None;
    }

    let settings = audio_processing_settings(params);
    match start_native_audio_source(*device_id, settings) {
        Ok(source) => {
            let device_name = source.device_name.clone();
            *fifo_path = Some(path.clone());
            state.emit_log(
                "info",
                format!(
                    "Native CoreAudio microphone capture started for {device_name} at {} Hz float32 stereo.",
                    NATIVE_AUDIO_SAMPLE_RATE
                ),
            );
            Some(PreparedNativeAudioSource {
                source,
                fifo_path: path,
            })
        }
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            let message = format!(
                "Native CoreAudio microphone is unavailable; continuing video-only. {error}"
            );
            state.emit_log("warn", &message);
            let _ = emit_health_event(
                state,
                Some(session_id),
                if message.to_lowercase().contains("permission")
                    || message.to_lowercase().contains("unauthor")
                {
                    HealthLevel::Error
                } else {
                    HealthLevel::Warn
                },
                "microphone-native-unavailable",
                &message,
            );
            capture.microphone = None;
            None
        }
    }
}

/// Builds the `-f tee` output args with per-slave FIFO isolation. Each slave runs in
/// its own buffered thread, so a slow, distant, or reconnecting RTMP endpoint cannot
/// back-pressure the shared encoder and stall the other platforms (or the local
/// recording) — the classic cause of "one platform makes them all lag." On sustained
/// overflow the lagging slave drops packets instead of blocking everyone; the queue
/// is large enough that the disk-backed recording leg never drops in practice. We do
/// not enable fifo auto-recovery, so a leg that fails to open still surfaces the
/// `Slave muxer #N failed` line that drives the per-target failure status (M5).
fn tee_output_args(spec: String) -> Vec<String> {
    vec![
        "-f".to_string(),
        "tee".to_string(),
        "-use_fifo".to_string(),
        "1".to_string(),
        "-fifo_options".to_string(),
        "queue_size=512:drop_pkts_on_overflow=1".to_string(),
        spec,
    ]
}

fn ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
    output_path: Option<&Path>,
    stream_targets: &[StreamTarget],
    screen_overlay: Option<&ScreenOverlayInput>,
) -> Result<Vec<String>> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-stats".to_string(),
        "-stats_period".to_string(),
        "2".to_string(),
        "-progress".to_string(),
        "pipe:2".to_string(),
    ];
    let input_layout = append_input_args(
        &mut args,
        capture,
        true,
        &params.output.video,
        screen_overlay,
    );
    let filter = recording_video_filter(
        input_layout.camera_input_index,
        input_layout.screen_overlay_input_index,
        params,
        true,
    );

    args.extend([
        "-filter_complex".to_string(),
        filter,
        "-map".to_string(),
        "[v_main]".to_string(),
    ]);
    append_audio_output_args(&mut args, &input_layout);
    args.extend([
        "-r".to_string(),
        params.output.video.fps.to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:v".to_string(),
        "h264_videotoolbox".to_string(),
        "-realtime".to_string(),
        "1".to_string(),
        "-prio_speed".to_string(),
        "1".to_string(),
        "-b:v".to_string(),
        format!("{}k", params.output.video.bitrate_kbps),
        "-maxrate".to_string(),
        format!("{}k", params.output.video.bitrate_kbps),
        "-bufsize".to_string(),
        format!("{}k", params.output.video.bitrate_kbps.saturating_mul(2)),
        // Pin a 2-second keyframe interval (closed GOP). YouTube — and HLS/DVR on
        // every platform — will not go live without a regular keyframe cadence, while
        // Twitch tolerates an irregular GOP. That difference is exactly why an
        // unpinned videotoolbox encode reaches Twitch but never appears on YouTube.
        // `-g` bounds the max interval; `-force_key_frames` guarantees exact 2s
        // alignment, and because there is one shared encoder every tee leg (and the
        // MKV) inherits it.
        "-g".to_string(),
        params.output.video.fps.saturating_mul(2).to_string(),
        "-force_key_frames".to_string(),
        "expr:gte(t,n_forced*2)".to_string(),
        // Required for the `tee` fan-out: a single shared videotoolbox encoder feeds
        // the matroska and flv slaves, which both need the H.264 SPS/PPS carried as
        // global extradata. Without this the matroska slave fails its header write
        // ("Could not write header (incorrect codec parameters ?)") and, because it is
        // onfail=abort, takes down the entire tee. Harmless for the single mkv/flv
        // outputs (those muxers request global headers from the encoder anyway).
        "-flags".to_string(),
        "+global_header".to_string(),
    ]);
    append_audio_encoding_args(
        &mut args,
        &input_layout,
        &params.audio,
        !stream_targets.is_empty(),
    );

    let stream_legs = stream_targets
        .iter()
        .map(|target| {
            format!(
                "[f=flv:onfail=ignore:flvflags=no_duration_filesize]{}",
                escape_tee_target(&target.url)
            )
        })
        .collect::<Vec<_>>();

    match (output_path, stream_targets) {
        // Local recording only.
        (Some(path), []) => args.push(path.display().to_string()),
        // Local recording + one or more streams: tee the MKV (onfail=abort) and
        // every RTMP leg (onfail=ignore so a failing platform does not kill the
        // recording or the other streams).
        (Some(path), _) => {
            let mut legs = vec![format!(
                "[f=matroska:onfail=abort]{}",
                escape_tee_target(&path.display().to_string())
            )];
            legs.extend(stream_legs);
            args.extend(tee_output_args(legs.join("|")));
        }
        // A single stream uses a plain FLV output (the proven path).
        (None, [single]) => {
            args.extend([
                "-flvflags".to_string(),
                "no_duration_filesize".to_string(),
                "-f".to_string(),
                "flv".to_string(),
                single.url.clone(),
            ]);
        }
        // Multiple streams without local recording: tee of FLV legs only.
        (None, targets) if !targets.is_empty() => {
            args.extend(tee_output_args(stream_legs.join("|")));
        }
        (None, _) => bail!("At least one output target is required"),
    }

    args.extend(["-map".to_string(), "[preview]".to_string()]);
    append_live_preview_output_args(&mut args);

    Ok(args)
}

fn preview_ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
    output_path: &Path,
) -> Result<Vec<String>> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    let input_layout = append_input_args(&mut args, capture, false, &params.output.video, None);
    args.extend([
        "-filter_complex".to_string(),
        video_filter(input_layout.camera_input_index, params, true),
        "-map".to_string(),
        "[v]".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        "4".to_string(),
        "-update".to_string(),
        "1".to_string(),
        output_path.display().to_string(),
    ]);
    Ok(args)
}

fn live_preview_ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
) -> Result<Vec<String>> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    let input_layout = append_input_args(&mut args, capture, false, &params.output.video, None);
    args.extend([
        "-filter_complex".to_string(),
        live_preview_filter(input_layout.camera_input_index, params),
        "-map".to_string(),
        "[preview]".to_string(),
    ]);
    append_live_preview_output_args(&mut args);
    Ok(args)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InputLayout {
    camera_input_index: Option<usize>,
    screen_overlay_input_index: Option<usize>,
    audio_inputs: Vec<AudioInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScreenOverlayInput {
    fifo_path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioInput {
    input_index: usize,
    track: AudioTrack,
    channels: u16,
}

fn append_input_args(
    args: &mut Vec<String>,
    capture: &CaptureInputs,
    include_audio: bool,
    video: &VideoSettings,
    screen_overlay: Option<&ScreenOverlayInput>,
) -> InputLayout {
    let mut next_input_index = 0;
    let mut audio_inputs = Vec::new();

    match capture.video {
        VideoInput::MacScreen { index } | VideoInput::MacCamera { index } => {
            // The cursor is only meaningful for screen capture, never the camera.
            let capture_cursor = matches!(capture.video, VideoInput::MacScreen { .. });
            append_avfoundation_video_input(args, index, video.fps, capture_cursor);
            next_input_index += 1;

            if include_audio
                && append_microphone_input(args, capture.microphone.as_ref(), &mut next_input_index)
            {
                audio_inputs.push(AudioInput {
                    input_index: next_input_index - 1,
                    track: microphone_audio_track(),
                    channels: microphone_channels(capture.microphone.as_ref()),
                });
            }
        }
        VideoInput::TestPattern => {
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-i".to_string(),
                format!(
                    "testsrc2=size={}x{}:rate={}",
                    video.width, video.height, video.fps
                ),
            ]);
            next_input_index += 1;

            if include_audio {
                if append_microphone_input(args, capture.microphone.as_ref(), &mut next_input_index)
                {
                    audio_inputs.push(AudioInput {
                        input_index: next_input_index - 1,
                        track: microphone_audio_track(),
                        channels: microphone_channels(capture.microphone.as_ref()),
                    });
                } else {
                    args.extend([
                        "-f".to_string(),
                        "lavfi".to_string(),
                        "-i".to_string(),
                        "sine=frequency=880:sample_rate=48000".to_string(),
                    ]);
                    audio_inputs.push(AudioInput {
                        input_index: next_input_index,
                        track: test_tone_audio_track(),
                        channels: 1,
                    });
                    next_input_index += 1;
                }
            }
        }
    };

    let camera_input_index = capture.camera_index.map(|camera_index| {
        let input_index = next_input_index;
        append_avfoundation_video_input(args, camera_index, video.fps, false);
        next_input_index += 1;
        input_index
    });

    let screen_overlay_input_index = screen_overlay.map(|overlay| {
        let input_index = next_input_index;
        append_screen_overlay_input(args, overlay);
        input_index
    });

    InputLayout {
        camera_input_index,
        screen_overlay_input_index,
        audio_inputs,
    }
}

fn append_microphone_input(
    args: &mut Vec<String>,
    microphone: Option<&MicrophoneInput>,
    next_input_index: &mut usize,
) -> bool {
    let Some(microphone) = microphone else {
        return false;
    };

    match microphone {
        MicrophoneInput::CoreAudio {
            fifo_path: Some(fifo_path),
            ..
        } => {
            args.extend([
                "-f".to_string(),
                "f32le".to_string(),
                "-ar".to_string(),
                NATIVE_AUDIO_SAMPLE_RATE.to_string(),
                "-ac".to_string(),
                NATIVE_AUDIO_CHANNELS.to_string(),
                "-thread_queue_size".to_string(),
                NATIVE_AUDIO_FFMPEG_QUEUE_SIZE.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
            *next_input_index += 1;
            true
        }
        MicrophoneInput::CoreAudio {
            fifo_path: None, ..
        } => false,
        MicrophoneInput::AvFoundation { index } => {
            args.extend([
                "-f".to_string(),
                "avfoundation".to_string(),
                "-thread_queue_size".to_string(),
                "512".to_string(),
                "-i".to_string(),
                format!(":{index}"),
            ]);
            *next_input_index += 1;
            true
        }
    }
}

fn microphone_channels(microphone: Option<&MicrophoneInput>) -> u16 {
    match microphone {
        Some(MicrophoneInput::CoreAudio { .. }) => NATIVE_AUDIO_CHANNELS,
        Some(MicrophoneInput::AvFoundation { .. }) => 1,
        None => 0,
    }
}

fn append_avfoundation_video_input(
    args: &mut Vec<String>,
    device_index: usize,
    fps: u32,
    capture_cursor: bool,
) {
    args.extend([
        "-fflags".to_string(),
        "nobuffer".to_string(),
        "-flags".to_string(),
        "low_delay".to_string(),
        "-probesize".to_string(),
        "32".to_string(),
        "-analyzeduration".to_string(),
        "0".to_string(),
        "-thread_queue_size".to_string(),
        "16".to_string(),
        "-f".to_string(),
        "avfoundation".to_string(),
        "-pixel_format".to_string(),
        AVFOUNDATION_VIDEO_PIXEL_FORMAT.to_string(),
        "-framerate".to_string(),
        fps.to_string(),
    ]);
    if capture_cursor {
        args.extend(["-capture_cursor".to_string(), "1".to_string()]);
    }
    args.extend(["-i".to_string(), format!("{device_index}:none")]);
}

fn append_screen_overlay_input(args: &mut Vec<String>, overlay: &ScreenOverlayInput) {
    args.extend([
        "-thread_queue_size".to_string(),
        "4".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgba".to_string(),
        "-s".to_string(),
        format!("{}x{}", overlay.width, overlay.height),
        "-framerate".to_string(),
        overlay.fps.to_string(),
        "-i".to_string(),
        overlay.fifo_path.display().to_string(),
    ]);
}

fn screen_overlay_fifo_path(session_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("videorc-screen-overlay-{session_id}.rgba"))
}

fn create_screen_overlay_fifo(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path).with_context(|| {
            format!(
                "Could not remove stale Screen overlay FIFO {}",
                path.display()
            )
        })?;
    }

    let c_path = CString::new(path.display().to_string())
        .context("Screen overlay FIFO path contained an interior NUL byte")?;
    let status = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if status != 0 {
        return Err(io::Error::last_os_error())
            .with_context(|| format!("Could not create Screen overlay FIFO {}", path.display()));
    }

    Ok(())
}

fn open_screen_overlay_fifo_writer(path: &Path, stop: &AtomicBool) -> io::Result<File> {
    let c_path = CString::new(path.display().to_string()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Screen overlay FIFO path",
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
        thread::sleep(SCREEN_OVERLAY_FIFO_OPEN_RETRY);
    }

    Err(io::Error::new(
        io::ErrorKind::Interrupted,
        "Screen overlay writer stopped before FIFO opened",
    ))
}

fn write_screen_overlay_frames(
    path: PathBuf,
    current_frame: Arc<StdMutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    width: u32,
    height: u32,
) {
    let mut file = match open_screen_overlay_fifo_writer(&path, &stop) {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!("Could not open Screen overlay FIFO: {error}");
            return;
        }
    };
    let transparent = transparent_overlay_frame(width, height);
    let frame_interval =
        std::time::Duration::from_millis(1000 / u64::from(SCREEN_OVERLAY_FPS.max(1)));

    while !stop.load(Ordering::Relaxed) {
        let frame = current_frame
            .lock()
            .map(|frame| frame.clone())
            .unwrap_or_else(|_| transparent.clone());
        let frame = if frame.len() == transparent.len() {
            frame
        } else {
            transparent.clone()
        };
        if let Err(error) = file.write_all(&frame) {
            tracing::warn!("Could not write Screen overlay frame: {error}");
            break;
        }
        thread::sleep(frame_interval);
    }
}

fn transparent_overlay_frame(width: u32, height: u32) -> Vec<u8> {
    vec![0; width as usize * height as usize * 4]
}

fn screen_overlay_frame_from_path(path: &Path, width: u32, height: u32) -> Result<Vec<u8>> {
    let image = image::open(path)
        .with_context(|| format!("Could not decode Screen image {}", path.display()))?
        .into_rgba8();
    let image = if image.width() == width && image.height() == height {
        image
    } else {
        image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle)
    };
    Ok(image.into_raw())
}

fn append_audio_output_args(args: &mut Vec<String>, input_layout: &InputLayout) {
    for (track_index, audio_input) in input_layout.audio_inputs.iter().enumerate() {
        args.extend([
            "-map".to_string(),
            format!("{}:a?", audio_input.input_index),
            format!("-metadata:s:a:{track_index}"),
            format!("title={}", audio_input.track.label),
        ]);
    }
}

fn append_audio_encoding_args(
    args: &mut Vec<String>,
    input_layout: &InputLayout,
    audio: &AudioSettings,
    streaming: bool,
) {
    if input_layout.audio_inputs.is_empty() {
        return;
    }

    let filter = capture_audio_filter(input_layout, audio);
    args.extend([
        "-af".to_string(),
        filter,
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        audio_output_channels(input_layout).to_string(),
        "-c:a".to_string(),
        if streaming { "aac" } else { "pcm_s16le" }.to_string(),
    ]);

    if streaming {
        args.extend(["-b:a".to_string(), "160k".to_string()]);
    }
}

fn capture_audio_filter(input_layout: &InputLayout, audio: &AudioSettings) -> String {
    let has_microphone = input_layout
        .audio_inputs
        .iter()
        .any(|input| input.track.source == AudioTrackSource::Microphone);
    let has_mono_input = input_layout
        .audio_inputs
        .iter()
        .any(|input| input.channels == 1);
    let mut filters = Vec::new();

    if has_microphone {
        let offset_ms = audio
            .microphone_sync_offset_ms
            .clamp(MICROPHONE_SYNC_OFFSET_MIN_MS, MICROPHONE_SYNC_OFFSET_MAX_MS);
        if offset_ms != 0 {
            let offset_seconds = f64::from(offset_ms) / 1000.0;
            filters.push(format!("asetpts=PTS{offset_seconds:+.3}/TB"));
        }
    }

    if has_mono_input {
        filters.push(MONO_TO_STEREO_FILTER.to_string());
    }
    filters.push(CAPTURE_AUDIO_FILTER.to_string());
    filters.join(",")
}

fn audio_output_channels(input_layout: &InputLayout) -> u16 {
    if input_layout.audio_inputs.is_empty() {
        0
    } else {
        NATIVE_AUDIO_CHANNELS
    }
}

fn append_live_preview_output_args(args: &mut Vec<String>) {
    args.extend([
        "-an".to_string(),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "-q:v".to_string(),
        "6".to_string(),
        "-flush_packets".to_string(),
        "1".to_string(),
        "-f".to_string(),
        "mpjpeg".to_string(),
        "-boundary_tag".to_string(),
        "videorc".to_string(),
        "pipe:1".to_string(),
    ]);
}

fn capture_audio_tracks(capture: &CaptureInputs) -> Vec<AudioTrack> {
    if capture.microphone.is_some() {
        return vec![microphone_audio_track()];
    }

    if matches!(capture.video, VideoInput::TestPattern) {
        return vec![test_tone_audio_track()];
    }

    Vec::new()
}

fn microphone_audio_track() -> AudioTrack {
    AudioTrack {
        id: "microphone".to_string(),
        label: "Microphone".to_string(),
        source: AudioTrackSource::Microphone,
    }
}

fn test_tone_audio_track() -> AudioTrack {
    AudioTrack {
        id: "test-tone".to_string(),
        label: "Test tone".to_string(),
        source: AudioTrackSource::TestTone,
    }
}

fn recording_video_filter(
    camera_input_index: Option<usize>,
    screen_overlay_input_index: Option<usize>,
    params: &StartSessionParams,
    include_live_preview: bool,
) -> String {
    let scene = video_filter(camera_input_index, params, false);
    let video = if let Some(overlay_index) = screen_overlay_input_index {
        format!("{scene};[v][{overlay_index}:v]overlay=x=0:y=0:format=auto:repeatlast=1[v_screen]")
    } else {
        scene
    };
    let video_label = if screen_overlay_input_index.is_some() {
        "v_screen"
    } else {
        "v"
    };
    if include_live_preview {
        format!(
            "{video};[{video_label}]split=2[v_main][v_preview];[v_preview]{}[preview]",
            live_preview_scale_filter()
        )
    } else {
        format!("{video};[{video_label}]null[v_main]")
    }
}

fn live_preview_filter(camera_input_index: Option<usize>, params: &StartSessionParams) -> String {
    format!(
        "{};[v]{}[preview]",
        video_filter(camera_input_index, params, false),
        live_preview_scale_filter()
    )
}

fn live_preview_scale_filter() -> String {
    format!(
        "scale=w={LIVE_PREVIEW_WIDTH}:h={LIVE_PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad={LIVE_PREVIEW_WIDTH}:{LIVE_PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps={LIVE_PREVIEW_FPS}"
    )
}

fn video_filter(
    camera_input_index: Option<usize>,
    params: &StartSessionParams,
    preview: bool,
) -> String {
    if matches!(params.layout.layout_preset, LayoutPreset::CameraOnly) {
        return camera_only_video_filter(params, preview);
    }

    if matches!(params.layout.layout_preset, LayoutPreset::SideBySide) {
        return side_by_side_video_filter(camera_input_index, params, preview);
    }

    let base_scale = if preview {
        "scale=w=960:h=-2".to_string()
    } else {
        output_scale_filter(&params.output.video)
    };

    if let Some(camera_input_index) = camera_input_index {
        let camera = camera_chain_filter(camera_input_index, params);
        let (x, y) = camera_overlay_position(&params.layout, &params.output.video);
        let final_scale = if preview { ",scale=w=960:h=-2" } else { "" };

        return format!(
            "[0:v]setpts=PTS-STARTPTS,{base_scale},fps={}[base];{camera};[base][cam]overlay=x={x}:y={y}:format=auto{final_scale}[v]",
            params.output.video.fps
        );
    }

    format!(
        "[0:v]setpts=PTS-STARTPTS,{base_scale},fps={}[v]",
        params.output.video.fps
    )
}

fn camera_only_video_filter(params: &StartSessionParams, preview: bool) -> String {
    let video = &params.output.video;
    let prefix = if params.layout.camera_mirror {
        "[0:v]setpts=PTS-STARTPTS,hflip,"
    } else {
        "[0:v]setpts=PTS-STARTPTS,"
    };
    // The camera fills the whole canvas as a rectangle, reusing the same
    // fit/fill/zoom/pan treatment as the overlay box so preview and output match.
    let frame = camera_frame_filter(video.width, video.height, &params.layout);
    let final_scale = if preview { ",scale=w=960:h=-2" } else { "" };
    format!("{prefix}{frame},fps={}{final_scale}[v]", video.fps)
}

/// Splits the canvas width into the screen and camera regions. The screen always
/// gets the larger (or equal) share, and the two widths sum to the canvas width.
fn side_by_side_widths(split: SideBySideSplit, total_width: u32) -> (u32, u32) {
    let screen_fraction = match split {
        SideBySideSplit::Even => 0.5,
        SideBySideSplit::SixtyForty => 0.6,
        SideBySideSplit::SeventyThirty => 0.7,
    };
    let mut screen_width = (f64::from(total_width) * screen_fraction).round() as u32;
    screen_width -= screen_width % 2;
    screen_width = screen_width.clamp(2, total_width.saturating_sub(2));
    (screen_width, total_width - screen_width)
}

fn side_by_side_video_filter(
    camera_input_index: Option<usize>,
    params: &StartSessionParams,
    preview: bool,
) -> String {
    let video = &params.output.video;
    let (screen_width, camera_width) =
        side_by_side_widths(params.layout.side_by_side_split, video.width);
    let height = video.height;
    let fps = video.fps;

    // Each region covers its area (scale to fill + center crop) so the two halves
    // tile the canvas with no black gap between them.
    let screen = format!(
        "[0:v]setpts=PTS-STARTPTS,scale={screen_width}:{height}:force_original_aspect_ratio=increase,crop={screen_width}:{height},fps={fps},format=yuv420p[sbs_screen]"
    );
    let camera = match camera_input_index {
        Some(index) => {
            let mirror = if params.layout.camera_mirror {
                "hflip,"
            } else {
                ""
            };
            let frame = camera_frame_filter(camera_width, height, &params.layout);
            format!(
                "[{index}:v]setpts=PTS-STARTPTS,{mirror}{frame},fps={fps},format=yuv420p[sbs_camera]"
            )
        }
        None => {
            format!("color=c=black:s={camera_width}x{height}:r={fps},format=yuv420p[sbs_camera]")
        }
    };
    let (left, right) = match params.layout.side_by_side_camera_side {
        SideBySideCameraSide::Right => ("sbs_screen", "sbs_camera"),
        SideBySideCameraSide::Left => ("sbs_camera", "sbs_screen"),
    };
    let final_scale = if preview { ",scale=w=960:h=-2" } else { "" };
    format!("{screen};{camera};[{left}][{right}]hstack=inputs=2{final_scale}[v]")
}

fn output_scale_filter(video: &VideoSettings) -> String {
    format!(
        "scale=w={}:h={}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        video.width, video.height, video.width, video.height
    )
}

fn camera_frame_filter(
    width: u32,
    height: u32,
    layout: &crate::protocol::LayoutSettings,
) -> String {
    let zoom = layout.camera_zoom.clamp(100, 200);
    let scaled_width = width * zoom / 100;
    let scaled_height = height * zoom / 100;
    match layout.camera_fit {
        CameraFit::Fit if zoom == 100 => format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        ),
        CameraFit::Fit | CameraFit::Fill => format!(
            "scale={scaled_width}:{scaled_height}:force_original_aspect_ratio=increase,crop=w={width}:h={height}:x='{}':y='{}'",
            crop_offset_expr(layout.camera_offset_x, "iw", "ow"),
            crop_offset_expr(layout.camera_offset_y, "ih", "oh")
        ),
    }
}

fn camera_chain_filter(camera_input_index: usize, params: &StartSessionParams) -> String {
    let (width, height) = scaled_camera_box_size(
        &params.layout.camera_size,
        &params.layout.camera_shape,
        &params.output.video,
    );
    let prefix = if params.layout.camera_mirror {
        format!("[{camera_input_index}:v]setpts=PTS-STARTPTS,hflip,")
    } else {
        format!("[{camera_input_index}:v]setpts=PTS-STARTPTS,")
    };
    let frame = camera_frame_filter(width, height, &params.layout);

    match params.layout.camera_shape {
        CameraShape::Rectangle => format!("{prefix}{frame}[cam]"),
        CameraShape::Circle => {
            let radius = width / 2;
            format!(
                "{prefix}{frame},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-{radius})*(X-{radius})+(Y-{radius})*(Y-{radius}),{radius}*{radius}),255,0)'[cam]"
            )
        }
    }
}

fn camera_box_size(size: &CameraSize, shape: &CameraShape) -> (u32, u32) {
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    let height = match shape {
        CameraShape::Rectangle => (width * 9 + 8) / 16,
        CameraShape::Circle => width,
    };

    (width, height)
}

fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    video: &VideoSettings,
) -> (u32, u32) {
    let scale = camera_output_scale(video);
    let (width, height) = camera_box_size(size, shape);

    (
        scale_camera_dimension(width, scale),
        scale_camera_dimension(height, scale),
    )
}

fn scaled_camera_margin(layout: &crate::protocol::LayoutSettings, video: &VideoSettings) -> u32 {
    scale_camera_dimension(layout.camera_margin.min(160), camera_output_scale(video))
}

/// Builds the FFmpeg `overlay` x/y expressions for the camera box. In `custom`
/// mode the normalized dragged position drives `W*x`/`H*y` (clamped so the box
/// stays on-canvas); otherwise the camera sits in its corner/size preset.
fn camera_overlay_position(
    layout: &crate::protocol::LayoutSettings,
    video: &VideoSettings,
) -> (String, String) {
    if let (CameraTransformMode::Custom, Some(transform)) =
        (layout.camera_transform_mode, layout.camera_transform)
    {
        let (cam_width, cam_height) =
            scaled_camera_box_size(&layout.camera_size, &layout.camera_shape, video);
        let max_x = 1.0 - f64::from(cam_width) / f64::from(video.width.max(1));
        let max_y = 1.0 - f64::from(cam_height) / f64::from(video.height.max(1));
        let x = transform.x.clamp(0.0, max_x.max(0.0));
        let y = transform.y.clamp(0.0, max_y.max(0.0));
        return (format!("W*{x:.5}"), format!("H*{y:.5}"));
    }

    let margin = scaled_camera_margin(layout, video);
    match layout.camera_corner {
        CameraCorner::TopLeft => (format!("{margin}"), format!("{margin}")),
        CameraCorner::TopRight => (format!("W-w-{margin}"), format!("{margin}")),
        CameraCorner::BottomLeft => (format!("{margin}"), format!("H-h-{margin}")),
        CameraCorner::BottomRight => (format!("W-w-{margin}"), format!("H-h-{margin}")),
    }
}

fn camera_output_scale(video: &VideoSettings) -> f64 {
    (f64::from(video.width) / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(f64::from(video.height) / f64::from(CAMERA_REFERENCE_HEIGHT))
}

fn scale_camera_dimension(value: u32, scale: f64) -> u32 {
    (f64::from(value) * scale).round().max(1.0) as u32
}

fn crop_offset_expr(offset: i32, input_size: &str, output_size: &str) -> String {
    let offset = offset.clamp(-100, 100);
    format!("({input_size}-{output_size})/2+({offset})*({input_size}-{output_size})/200")
}

fn validate_outputs(params: &StartSessionParams) -> Result<()> {
    if !params.output.record_enabled && !params.output.stream_enabled {
        bail!("Enable local recording, RTMP streaming, or both");
    }

    if params.output.stream_enabled {
        match params
            .streaming
            .as_ref()
            .filter(|streaming| streaming.enabled)
        {
            Some(streaming) => {
                stream_targets_from_streaming(streaming)?;
            }
            None => {
                build_stream_url(&params.output.rtmp)?;
            }
        }
    }

    validate_video_settings(&params.output.video)?;

    Ok(())
}

fn validate_video_settings(video: &VideoSettings) -> Result<()> {
    if !(640..=3840).contains(&video.width) || !(360..=2160).contains(&video.height) {
        bail!("Video resolution must be between 640x360 and 3840x2160");
    }

    if !(24..=60).contains(&video.fps) {
        bail!("Video FPS must be between 24 and 60");
    }

    if !(1_000..=50_000).contains(&video.bitrate_kbps) {
        bail!("Video bitrate must be between 1000 and 50000 kbps");
    }

    Ok(())
}

fn build_stream_url(settings: &RtmpSettings) -> Result<StreamTarget> {
    let server_url = settings.server_url.trim().trim_end_matches('/');
    let stream_key = settings.stream_key.trim().trim_start_matches('/');

    if server_url.is_empty() {
        bail!("RTMP server URL is required when streaming is enabled");
    }

    if stream_key.is_empty() {
        bail!("Stream key is required when streaming is enabled");
    }

    let url = format!("{server_url}/{stream_key}");
    let platform = stream_platform_from_preset(&settings.preset);
    Ok(StreamTarget {
        url,
        redacted_url: format!("{server_url}/••••"),
        target_id: stream_platform_id(platform).to_string(),
        platform,
        label: stream_platform_label(platform).to_string(),
    })
}

fn redact_stream_url(url: &str) -> String {
    match url.rsplit_once('/') {
        Some((prefix, _)) => format!("{prefix}/••••"),
        None => "••••".to_string(),
    }
}

fn escape_tee_target(target: &str) -> String {
    // The tee muxer uses `|` to separate slave outputs and `[]` for per-output
    // options; backslash-escape those so URLs/paths cannot break the filtergraph.
    target
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn resolve_stream_target(target: &StreamTargetSettings) -> Result<StreamTarget> {
    let server = target.server_url.trim().trim_end_matches('/');
    if server.is_empty() {
        bail!("{} RTMP URL is missing", target.label);
    }
    if matches!(target.url_mode, Some(StreamUrlMode::FullUrl)) {
        return Ok(StreamTarget {
            url: server.to_string(),
            redacted_url: redact_stream_url(server),
            target_id: target.id.clone(),
            platform: target.platform,
            label: target.label.clone(),
        });
    }
    let stream_key = target.stream_key.trim().trim_start_matches('/');
    if stream_key.is_empty() {
        bail!("{} stream key is missing", target.label);
    }
    Ok(StreamTarget {
        url: format!("{server}/{stream_key}"),
        redacted_url: format!("{server}/••••"),
        target_id: target.id.clone(),
        platform: target.platform,
        label: target.label.clone(),
    })
}

/// Resolves every enabled stream target, partitioning into the destinations that are
/// ready (complete credentials) and the enabled-but-incomplete ones that get skipped
/// for this session. Never errors — callers decide whether an empty `ready` set is
/// fatal — so the skipped set can be surfaced to the user (M5).
fn resolve_stream_targets(streaming: &StreamingSettings) -> StreamTargetResolution {
    let mut resolution = StreamTargetResolution::default();
    for target in streaming.targets.iter().filter(|target| target.enabled) {
        match resolve_stream_target(target) {
            Ok(resolved) => resolution.ready.push(resolved),
            Err(error) => resolution.skipped.push(SkippedStreamTarget {
                target_id: target.id.clone(),
                platform: target.platform,
                label: target.label.clone(),
                reason: error.to_string(),
            }),
        }
    }
    resolution
}

/// Resolves the ready tee targets for an enabled streaming config, erroring when no
/// enabled destination has complete credentials.
fn stream_targets_from_streaming(streaming: &StreamingSettings) -> Result<Vec<StreamTarget>> {
    let resolution = resolve_stream_targets(streaming);
    if resolution.ready.is_empty() {
        if resolution.skipped.is_empty() {
            bail!("Enable at least one streaming destination");
        }
        let problems = resolution
            .skipped
            .iter()
            .map(|skip| skip.reason.clone())
            .collect::<Vec<_>>()
            .join("; ");
        bail!("No streaming destination is ready: {problems}");
    }
    Ok(resolution.ready)
}

/// The slave index a recording leg occupies: a tee places the MKV (onfail=abort)
/// first, so stream legs are offset by one when recording, otherwise they start at 0.
fn tee_slave_offset(has_recording_leg: bool) -> usize {
    usize::from(has_recording_leg)
}

/// Builds the initial per-target runtime snapshot — ready destinations as `Live`,
/// skipped ones as `NotConfigured` with their reason — plus a map from tee slave
/// index to snapshot position so a per-slave stderr failure can be attributed to the
/// right target. The map is empty for the plain (non-tee) single-stream output.
fn build_stream_runtime(
    ready: &[StreamTarget],
    skipped: &[SkippedStreamTarget],
    has_recording_leg: bool,
) -> (Vec<StreamTargetRuntime>, Vec<Option<usize>>) {
    let mut runtime = Vec::with_capacity(ready.len() + skipped.len());
    for target in ready {
        runtime.push(StreamTargetRuntime {
            target_id: target.target_id.clone(),
            platform: target.platform,
            label: target.label.clone(),
            state: StreamTargetState::Live,
            message: None,
            redacted_url: Some(target.redacted_url.clone()),
        });
    }
    for skip in skipped {
        runtime.push(StreamTargetRuntime {
            target_id: skip.target_id.clone(),
            platform: skip.platform,
            label: skip.label.clone(),
            state: StreamTargetState::NotConfigured,
            message: Some(skip.reason.clone()),
            redacted_url: None,
        });
    }

    // Only a tee labels its slaves by index. Two or more legs always tee; a single
    // stream alongside a recording also tees (MKV onfail=abort + one flv leg), but a
    // lone stream with no recording is a plain flv output with no per-slave reporting.
    let tee_used = ready.len() > 1 || (has_recording_leg && !ready.is_empty());
    let mut slave_positions = Vec::new();
    if tee_used {
        let offset = tee_slave_offset(has_recording_leg);
        slave_positions = vec![None; ready.len() + offset];
        for position in 0..ready.len() {
            slave_positions[position + offset] = Some(position);
        }
    }
    (runtime, slave_positions)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TeeSlaveFailure {
    slave_index: usize,
    reason: String,
}

/// Parses an FFmpeg `tee` per-slave failure line, e.g.
/// `[tee @ 0x..] Slave muxer #1 failed: Connection refused, continuing with 1/2 slaves.`
/// Returns the failing slave index and a short reason so a dropped stream leg can be
/// attributed to a specific target (the `tee` keeps running the other slaves).
fn parse_tee_slave_failure(line: &str) -> Option<TeeSlaveFailure> {
    let marker = "Slave muxer #";
    let start = line.find(marker)? + marker.len();
    let (index_str, after) = line[start..].split_once(" failed")?;
    let slave_index = index_str.trim().parse::<usize>().ok()?;
    let reason = after
        .trim_start_matches(':')
        .split(", continuing")
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_string();
    Some(TeeSlaveFailure {
        slave_index,
        reason,
    })
}

fn output_mode(record_enabled: bool, stream_enabled: bool) -> &'static str {
    match (record_enabled, stream_enabled) {
        (true, true) => "record+stream",
        (true, false) => "record",
        (false, true) => "stream",
        (false, false) => "idle",
    }
}

fn audio_processing_settings(params: &StartSessionParams) -> AudioProcessingSettings {
    AudioProcessingSettings {
        gain_db: params.audio.microphone_gain_db.clamp(-24.0, 24.0),
        muted: params.audio.microphone_muted,
    }
}

fn parse_avfoundation_id(id: &str) -> Option<usize> {
    id.strip_prefix("screen:avfoundation:")
        .or_else(|| id.strip_prefix("camera:avfoundation:"))
        .or_else(|| id.strip_prefix("microphone:avfoundation:"))?
        .parse()
        .ok()
}

fn emit_foundation_health_events(
    state: &AppState,
    session_id: &str,
    params: &StartSessionParams,
) -> Result<()> {
    if params.sources.microphone_id.is_none() {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Warn,
            "microphone-not-selected",
            "No microphone is selected for this capture session.",
        )?;
    }

    if params
        .sources
        .screen_id
        .as_deref()
        .and_then(parse_screencapturekit_display_id)
        .is_some()
    {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "screen-screencapturekit-discovery",
            "Screen source was discovered with native ScreenCaptureKit. Recording still uses the FFmpeg AVFoundation fallback bridge until the native video bridge lands.",
        )?;
    }

    if params
        .sources
        .window_id
        .as_deref()
        .and_then(parse_screencapturekit_window_id)
        .is_some()
    {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Warn,
            "window-capture-fallback",
            "Window source was selected with native ScreenCaptureKit discovery, but this phase records the primary display through the FFmpeg AVFoundation fallback bridge.",
        )?;
    }

    if params
        .sources
        .camera_id
        .as_deref()
        .and_then(parse_native_camera_id)
        .is_some()
    {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "camera-native-avfoundation-discovery",
            "Camera source was discovered with native AVFoundation and selected by unique ID. Recording still uses the FFmpeg AVFoundation fallback bridge until the native camera frame bridge lands.",
        )?;
    }

    if matches!(params.layout.camera_shape, CameraShape::Circle) {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "camera-shape-circle",
            "Circle camera shape is applied with an FFmpeg alpha mask in the current preview/recording path.",
        )?;
    }

    if matches!(params.output.rtmp.preset, RtmpPreset::X) && params.output.stream_enabled {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "x-rtmp-access",
            "X/Twitter streaming requires an account with live RTMP access.",
        )?;
    }

    Ok(())
}

fn emit_audio_track_health_events(
    state: &AppState,
    session_id: &str,
    params: &StartSessionParams,
    audio_tracks: &[AudioTrack],
) -> Result<()> {
    if !params.output.record_enabled {
        return Ok(());
    }

    if audio_tracks.is_empty() {
        return Ok(());
    }

    let labels = audio_tracks
        .iter()
        .map(|track| track.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    emit_health_event(
        state,
        Some(session_id),
        HealthLevel::Info,
        "audio-tracks-separated",
        &format!("Local MKV will preserve separate audio track(s): {labels}."),
    )?;

    Ok(())
}

async fn emit_disk_space_health_event(
    state: &AppState,
    session_id: &str,
    output_dir: &Path,
) -> Result<()> {
    let output = Command::new("df")
        .args(["-Pk", &output_dir.display().to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let Ok(output) = output else {
        return Ok(());
    };

    if !output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(line) = stdout.lines().nth(1) else {
        return Ok(());
    };
    let columns = line.split_whitespace().collect::<Vec<_>>();
    let Some(available_kb) = columns.get(3).and_then(|value| value.parse::<u64>().ok()) else {
        return Ok(());
    };

    if available_kb < 1_048_576 {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Warn,
            "disk-space-low",
            "Less than 1 GB is available in the selected recording location.",
        )?;
    }

    Ok(())
}

pub fn emit_health_event(
    state: &AppState,
    session_id: Option<&str>,
    level: HealthLevel,
    code: &str,
    message: &str,
) -> Result<()> {
    let event = state
        .database
        .add_health_event(session_id, level, code, message)?;
    if let Some(session_id) = session_id {
        let _ =
            state
                .database
                .add_session_log(session_id, event.level.clone(), code, message, None);
    }
    state.emit_event("health.event", event);
    Ok(())
}

fn emit_session_log(
    state: &AppState,
    session_id: &str,
    level: HealthLevel,
    code: &str,
    message: &str,
    source_id: Option<&str>,
) -> Result<()> {
    let entry = state
        .database
        .add_session_log(session_id, level, code, message, source_id)?;
    state.emit_event("session.log", entry);
    Ok(())
}

fn looks_like_ffmpeg_health_event(line: &str) -> bool {
    let normalized = line.to_lowercase();
    normalized.contains("dropped")
        || normalized.contains("overload")
        || normalized.contains("permission")
        || normalized.contains("failed")
        || normalized.contains("connection")
}

fn parse_ffmpeg_stream_health(session_id: &str, line: &str) -> Option<StreamHealth> {
    let fps = parse_stat_f64(line, "fps=");
    let dropped_frames =
        parse_stat_u64(line, "drop_frames=").or_else(|| parse_stat_u64(line, "drop="));
    let speed = parse_stat_f64(line, "speed=");

    if fps.is_none() && dropped_frames.is_none() && speed.is_none() {
        return None;
    }

    Some(StreamHealth {
        session_id: session_id.to_string(),
        fps,
        dropped_frames,
        speed,
        created_at: Utc::now().to_rfc3339(),
    })
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

fn stat_value<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let start = line.find(label)? + label.len();
    line[start..].split_whitespace().next()
}

pub type RecordingSlot = Arc<Mutex<Option<ActiveRecording>>>;
pub type LivePreviewSlot = Arc<Mutex<LivePreviewState>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransform, LayoutPreset,
        LayoutSettings, OutputSettings, PreviewLiveParams, RtmpSettings, SourceSelection,
    };
    use crate::streaming::{
        PlatformAccount, PlatformAccountStatus, StreamAuthMode, StreamMode, StreamPlatform,
        StreamTargetState, default_stream_targets,
    };

    fn base_params(record_enabled: bool, stream_enabled: bool) -> StartSessionParams {
        StartSessionParams {
            sources: SourceSelection {
                screen_id: Some("screen:avfoundation:3".to_string()),
                window_id: None,
                camera_id: Some("camera:avfoundation:0".to_string()),
                microphone_id: Some("microphone:avfoundation:1".to_string()),
                test_pattern: false,
            },
            layout: LayoutSettings {
                layout_preset: LayoutPreset::ScreenCamera,
                camera_transform_mode: CameraTransformMode::Preset,
                camera_transform: None,
                camera_corner: CameraCorner::BottomRight,
                camera_size: CameraSize::Medium,
                camera_shape: CameraShape::Rectangle,
                camera_margin: 32,
                camera_fit: CameraFit::Fill,
                camera_mirror: false,
                camera_zoom: 100,
                camera_offset_x: 0,
                camera_offset_y: 0,
                side_by_side_split: SideBySideSplit::SeventyThirty,
                side_by_side_camera_side: SideBySideCameraSide::Right,
            },
            output: OutputSettings {
                record_enabled,
                stream_enabled,
                output_directory: None,
                ffmpeg_path: None,
                video: default_video_settings(),
                rtmp: RtmpSettings {
                    preset: RtmpPreset::YouTube,
                    server_url: "rtmp://a.rtmp.youtube.com/live2".to_string(),
                    stream_key: "abc123".to_string(),
                },
            },
            audio: Default::default(),
            streaming: None,
        }
    }

    fn streaming_for(enabled: &[(StreamPlatform, &str, &str)]) -> StreamingSettings {
        let mut targets = default_stream_targets();
        for (platform, server, key) in enabled {
            if let Some(target) = targets.iter_mut().find(|t| t.platform == *platform) {
                target.enabled = true;
                if !server.is_empty() {
                    target.server_url = server.to_string();
                }
                target.stream_key = key.to_string();
                target.stream_key_present = !key.is_empty();
            }
        }
        let enabled_target_ids = targets
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.id.clone())
            .collect();
        StreamingSettings {
            enabled: !enabled.is_empty(),
            mode: StreamMode::Single,
            targets,
            selected_target_id: None,
            default_output_preset: VideoPreset::Tutorial1080p30,
            default_bitrate_kbps: 6000,
            enabled_target_ids,
        }
    }

    #[test]
    fn resolves_single_ready_stream_target() {
        let streaming = streaming_for(&[(
            StreamPlatform::Twitch,
            "rtmp://live.twitch.tv/app",
            "key-123",
        )]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].url, "rtmp://live.twitch.tv/app/key-123");
        assert_eq!(targets[0].redacted_url, "rtmp://live.twitch.tv/app/••••");
        assert!(!targets[0].redacted_url.contains("key-123"));
    }

    #[test]
    fn resolves_three_ready_stream_targets() {
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
            (StreamPlatform::X, "rtmp://x.example/app", "xk"),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 3);
        assert!(targets.iter().any(|t| t.url.ends_with("/yt")));
        assert!(targets.iter().any(|t| t.url.ends_with("/tw")));
        assert!(targets.iter().any(|t| t.url.ends_with("/xk")));
    }

    #[test]
    fn skips_incomplete_enabled_targets() {
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", ""),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(targets[0].url.ends_with("/yt"));
    }

    #[test]
    fn errors_when_no_target_ready_and_names_the_target() {
        let streaming = streaming_for(&[(StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "")]);
        let error = stream_targets_from_streaming(&streaming)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Twitch"),
            "error should name the target: {error}"
        );
        assert!(
            error.contains("stream key"),
            "error should mention the missing key: {error}"
        );
    }

    #[test]
    fn resolve_stream_targets_partitions_ready_and_skipped() {
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", ""),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        assert_eq!(resolution.ready.len(), 1);
        assert_eq!(resolution.ready[0].platform, StreamPlatform::Youtube);
        assert_eq!(resolution.skipped.len(), 1);
        assert_eq!(resolution.skipped[0].platform, StreamPlatform::Twitch);
        assert!(
            resolution.skipped[0].reason.contains("stream key"),
            "skip reason should explain why: {}",
            resolution.skipped[0].reason
        );
    }

    #[test]
    fn oauth_stream_targets_hydrate_key_from_account_secret_ref() {
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "",
        )]);
        let youtube = streaming
            .targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        youtube.auth_mode = StreamAuthMode::Oauth;
        youtube.account_id = Some("UC123".to_string());
        youtube.stream_key_secret_ref = None;
        let credentials = vec![PlatformAccountCredentials {
            account: PlatformAccount {
                id: "backend-account-id".to_string(),
                platform: StreamPlatform::Youtube,
                account_id: "UC123".to_string(),
                account_label: "Videogre Channel".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: Vec::new(),
                access_token_present: true,
                refresh_token_present: true,
                stream_key_present: true,
                expires_at: None,
                connected_at: "2026-06-03T00:00:00Z".to_string(),
                updated_at: "2026-06-03T00:00:00Z".to_string(),
                status: PlatformAccountStatus::Connected,
            },
            token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
            refresh_token_secret_ref: None,
            stream_key_secret_ref: Some("platform:youtube:UC123:stream-key".to_string()),
        }];

        hydrate_oauth_stream_keys_from_credentials(&mut streaming, &credentials, |secret_ref| {
            assert_eq!(secret_ref, "platform:youtube:UC123:stream-key");
            Ok("secret-youtube-key".to_string())
        })
        .unwrap();

        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].url,
            "rtmp://a.rtmp.youtube.com/live2/secret-youtube-key"
        );
        assert!(!targets[0].redacted_url.contains("secret-youtube-key"));
        let youtube = streaming
            .targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        assert_eq!(youtube.stream_key, "secret-youtube-key");
        assert!(youtube.stream_key_present);
        assert_eq!(
            youtube.stream_key_secret_ref.as_deref(),
            Some("platform:youtube:UC123:stream-key")
        );
    }

    #[test]
    fn parse_tee_slave_failure_extracts_index_and_reason() {
        let failure = parse_tee_slave_failure(
            "[tee @ 0x10] Slave muxer #2 failed: Connection refused, continuing with 2/3 slaves.",
        )
        .expect("should parse a tee slave failure");
        assert_eq!(failure.slave_index, 2);
        assert_eq!(failure.reason, "Connection refused");
    }

    #[test]
    fn parse_tee_slave_failure_ignores_unrelated_lines() {
        assert!(parse_tee_slave_failure("frame=10 fps=30 speed=1x").is_none());
        assert!(parse_tee_slave_failure("[tee @ 0x10] Slave muxer failed somehow").is_none());
    }

    #[test]
    fn build_stream_runtime_maps_slaves_after_recording_leg() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw"),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (runtime, slaves) = build_stream_runtime(&resolution.ready, &resolution.skipped, true);
        assert_eq!(runtime.len(), 2);
        assert!(runtime.iter().all(|t| t.state == StreamTargetState::Live));
        // Slave #0 is the MKV (onfail=abort); the two stream legs are #1 and #2.
        assert_eq!(slaves.first().copied().flatten(), None);
        assert_eq!(slaves.get(1).copied().flatten(), Some(0));
        assert_eq!(slaves.get(2).copied().flatten(), Some(1));
    }

    #[test]
    fn build_stream_runtime_stream_only_multi_starts_at_zero() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw"),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (_, slaves) = build_stream_runtime(&resolution.ready, &resolution.skipped, false);
        assert_eq!(slaves.first().copied().flatten(), Some(0));
        assert_eq!(slaves.get(1).copied().flatten(), Some(1));
    }

    #[test]
    fn build_stream_runtime_single_stream_only_has_no_slave_map() {
        let streaming = streaming_for(&[(StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw")]);
        let resolution = resolve_stream_targets(&streaming);
        // A lone stream with no recording is a plain flv output: no per-slave reporting.
        let (runtime, slaves) = build_stream_runtime(&resolution.ready, &resolution.skipped, false);
        assert_eq!(runtime.len(), 1);
        assert!(slaves.is_empty());
        // ...but the same single stream *with* a recording tees (MKV + one leg).
        let (_, with_rec) = build_stream_runtime(&resolution.ready, &resolution.skipped, true);
        assert_eq!(with_rec.get(1).copied().flatten(), Some(0));
    }

    #[test]
    fn build_stream_runtime_marks_skipped_targets_not_configured() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", ""),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (runtime, _) = build_stream_runtime(&resolution.ready, &resolution.skipped, true);
        let twitch = runtime
            .iter()
            .find(|t| t.platform == StreamPlatform::Twitch)
            .expect("skipped target should still appear in the snapshot");
        assert_eq!(twitch.state, StreamTargetState::NotConfigured);
        assert!(twitch.message.is_some());
        // A skipped target never leaks a URL.
        assert!(twitch.redacted_url.is_none());
    }

    #[test]
    fn full_url_mode_uses_server_as_complete_url() {
        let mut streaming = streaming_for(&[(
            StreamPlatform::Custom,
            "rtmp://custom.example/app/secret",
            "",
        )]);
        if let Some(custom) = streaming
            .targets
            .iter_mut()
            .find(|t| t.platform == StreamPlatform::Custom)
        {
            custom.url_mode = Some(StreamUrlMode::FullUrl);
        }
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].url, "rtmp://custom.example/app/secret");
        assert!(!targets[0].redacted_url.contains("secret"));
    }

    #[test]
    fn record_plus_multistream_tees_every_target() {
        let params = base_params(true, true);
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
            (StreamPlatform::X, "rtmp://x.example/app", "xk"),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &targets,
            None,
        )
        .unwrap();

        assert!(args.contains(&"tee".to_string()));
        let tee = args.iter().find(|arg| arg.contains("[f=matroska")).unwrap();
        assert!(tee.contains("[f=matroska:onfail=abort]/tmp/videorc-test.mkv"));
        assert!(tee.contains("onfail=ignore"));
        assert_eq!(
            tee.matches("[f=flv").count(),
            3,
            "expected 3 flv legs: {tee}"
        );
        assert!(tee.contains("rtmp://a.rtmp.youtube.com/live2/yt"));
        assert!(tee.contains("rtmp://live.twitch.tv/app/tw"));
        assert!(tee.contains("rtmp://x.example/app/xk"));
        // The tee shares one encoder across the matroska + flv slaves, so the H.264
        // SPS/PPS must be emitted as global extradata or the matroska slave fails its
        // header write and aborts the whole fan-out. Locked in by an end-to-end local
        // RTMP smoke (scripts/smoke-multistream-app.mjs).
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-flags" && window[1] == "+global_header"),
            "record + multistream tee must force global extradata: {args:?}"
        );
        // FIFO-isolate each slave so a slow platform cannot back-pressure the encoder
        // and stall the others (or the recording).
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-use_fifo" && window[1] == "1"),
            "tee must isolate slaves with a fifo: {args:?}"
        );
    }

    #[test]
    fn stream_only_multistream_tees_flv_without_recording() {
        let params = base_params(false, true);
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            None,
            &targets,
            None,
        )
        .unwrap();

        assert!(args.contains(&"tee".to_string()));
        let tee = args.iter().find(|arg| arg.contains("[f=flv")).unwrap();
        assert!(!tee.contains("[f=matroska"));
        assert_eq!(tee.matches("[f=flv").count(), 2);
        // The stream-only tee fans one encoder across multiple flv slaves, which also
        // need the H.264 SPS/PPS as global extradata.
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-flags" && window[1] == "+global_header"),
            "stream-only tee must force global extradata: {args:?}"
        );
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-use_fifo" && window[1] == "1"),
            "stream-only tee must isolate slaves with a fifo: {args:?}"
        );
    }

    #[test]
    fn single_stream_only_uses_plain_flv_output() {
        let params = base_params(false, true);
        let targets = vec![build_stream_url(&params.output.rtmp).unwrap()];
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            None,
            &targets,
            None,
        )
        .unwrap();

        assert!(!args.contains(&"tee".to_string()));
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-f" && window[1] == "flv")
        );
        assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/abc123".to_string()));
    }

    #[test]
    fn camera_overlay_position_uses_corner_in_preset_mode() {
        let params = base_params(true, false);
        let (x, y) = camera_overlay_position(&params.layout, &params.output.video);
        assert!(
            x.starts_with("W-w-"),
            "expected bottom-right x expr, got {x}"
        );
        assert!(
            y.starts_with("H-h-"),
            "expected bottom-right y expr, got {y}"
        );
    }

    #[test]
    fn camera_overlay_position_uses_normalized_offsets_in_custom_mode() {
        let mut params = base_params(true, false);
        params.layout.camera_transform_mode = CameraTransformMode::Custom;
        params.layout.camera_transform = Some(CameraTransform {
            x: 0.25,
            y: 0.5,
            width: 0.3,
            height: 0.3,
        });

        let (x, y) = camera_overlay_position(&params.layout, &params.output.video);
        assert_eq!(x, "W*0.25000");
        assert_eq!(y, "H*0.50000");
    }

    #[test]
    fn camera_only_filter_fills_canvas_without_overlay() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::CameraOnly;
        params.layout.camera_mirror = true;

        let filter = video_filter(None, &params, false);

        assert!(filter.starts_with("[0:v]setpts=PTS-STARTPTS,hflip,"));
        assert!(
            filter.contains("crop=w=2560:h=1440"),
            "expected full-canvas crop: {filter}"
        );
        assert!(filter.ends_with("[v]"));
        assert!(!filter.contains("overlay"));
        assert!(!filter.contains("[base]"));
    }

    #[test]
    fn camera_only_opens_camera_as_primary_input() {
        let params = base_params(true, false);
        let mut args = Vec::new();
        let layout = append_input_args(
            &mut args,
            &CaptureInputs {
                video: VideoInput::MacCamera { index: 0 },
                camera_index: None,
                microphone: None,
            },
            true,
            &params.output.video,
            None,
        );

        assert!(layout.camera_input_index.is_none());
        assert_eq!(ffmpeg_inputs(&args), vec!["0:none"]);
        assert!(!args.iter().any(|arg| arg == "-capture_cursor"));
    }

    #[tokio::test]
    async fn camera_only_resolves_camera_as_video_input() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::CameraOnly;

        let capture = resolve_capture_inputs("ffmpeg", &params).await;

        assert_eq!(capture.video, VideoInput::MacCamera { index: 0 });
        assert!(capture.camera_index.is_none());
    }

    #[tokio::test]
    async fn screen_only_skips_camera_even_when_selected() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::ScreenOnly;

        let capture = resolve_capture_inputs("ffmpeg", &params).await;

        assert!(capture.camera_index.is_none());
    }

    #[test]
    fn side_by_side_widths_keep_screen_larger_and_tile_the_canvas() {
        for (split, expected_screen) in [
            (SideBySideSplit::Even, 1280u32),
            (SideBySideSplit::SixtyForty, 1536),
            (SideBySideSplit::SeventyThirty, 1792),
        ] {
            let (screen, camera) = side_by_side_widths(split, 2560);
            assert_eq!(screen, expected_screen);
            assert_eq!(screen + camera, 2560);
            assert!(screen >= camera);
            assert_eq!(screen % 2, 0);
            assert_eq!(camera % 2, 0);
        }
    }

    #[test]
    fn side_by_side_filter_orders_regions_by_camera_side() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::SideBySide;
        params.layout.side_by_side_split = SideBySideSplit::SeventyThirty;
        params.layout.side_by_side_camera_side = SideBySideCameraSide::Right;

        let right = video_filter(Some(1), &params, false);
        assert!(right.contains("crop=1792:1440"), "screen region: {right}");
        assert!(right.contains("[1:v]setpts=PTS-STARTPTS,"));
        assert!(right.contains("[sbs_screen][sbs_camera]hstack=inputs=2"));
        assert!(!right.contains("overlay"));

        params.layout.side_by_side_camera_side = SideBySideCameraSide::Left;
        let left = video_filter(Some(1), &params, false);
        assert!(left.contains("[sbs_camera][sbs_screen]hstack=inputs=2"));
    }

    fn ffmpeg_inputs(args: &[String]) -> Vec<&str> {
        args.windows(2)
            .filter_map(|pair| (pair[0] == "-i").then_some(pair[1].as_str()))
            .collect()
    }

    fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.windows(2)
            .find_map(|pair| (pair[0] == name).then_some(pair[1].as_str()))
    }

    fn input_arg_value<'a>(args: &'a [String], input: &str, name: &str) -> Option<&'a str> {
        let input_position = args
            .windows(2)
            .position(|pair| pair[0] == "-i" && pair[1] == input)?;
        let start = args[..input_position]
            .iter()
            .rposition(|arg| arg == "-i")
            .map_or(0, |position| position + 2);

        args[start..input_position]
            .windows(2)
            .find_map(|pair| (pair[0] == name).then_some(pair[1].as_str()))
    }

    fn input_has_arg(args: &[String], input: &str, name: &str) -> bool {
        let Some(input_position) = args
            .windows(2)
            .position(|pair| pair[0] == "-i" && pair[1] == input)
        else {
            return false;
        };
        let start = args[..input_position]
            .iter()
            .rposition(|arg| arg == "-i")
            .map_or(0, |position| position + 2);

        args[start..input_position].iter().any(|arg| arg == name)
    }

    #[test]
    fn capture_audio_filter_keeps_mic_processing_stable() {
        assert!(CAPTURE_AUDIO_FILTER.contains("aresample=async=1:first_pts=0"));
        assert!(!CAPTURE_AUDIO_FILTER.contains("volume="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("dynaudnorm="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("alimiter="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("volume=24dB"));
    }

    #[test]
    fn default_recordings_dir_uses_videorc_movies_folder() {
        let path = default_recordings_dir();
        let rendered = path.display().to_string();

        assert!(rendered.contains("Movies"));
        assert!(rendered.ends_with("Videorc/Recordings"));
    }

    #[test]
    fn live_preview_initial_status_is_unavailable() {
        let state = initial_live_preview_state();

        assert_eq!(state.status.state, PreviewLiveState::Unavailable);
        assert_eq!(state.status.source, PreviewLiveSource::Unavailable);
        assert!(state.status.url.is_none());
    }

    #[test]
    fn same_connecting_idle_preview_is_reused() {
        let params = PreviewLiveParams {
            sources: base_params(true, false).sources,
            layout: base_params(true, false).layout,
            ffmpeg_path: None,
            video: Some(default_video_settings()),
        };
        let state = LivePreviewState {
            status: PreviewLiveStatus {
                state: PreviewLiveState::Connecting,
                source: PreviewLiveSource::IdlePreview,
                url: Some("http://127.0.0.1:1234/preview/live.mjpeg?token=test".to_string()),
                message: Some("Starting live preview.".to_string()),
            },
            desired_params: Some(params.clone()),
            idle_process: Some(ActiveLivePreview {
                pid: 123,
                stdin: None,
                first_frame_received: false,
            }),
        };

        assert!(should_reuse_idle_live_preview(&state, &params));
    }

    #[test]
    fn unavailable_idle_preview_is_not_reused() {
        let params = PreviewLiveParams {
            sources: base_params(true, false).sources,
            layout: base_params(true, false).layout,
            ffmpeg_path: None,
            video: Some(default_video_settings()),
        };
        let state = LivePreviewState {
            status: unavailable_live_preview_status(Some("No frames.".to_string())),
            desired_params: Some(params.clone()),
            idle_process: Some(ActiveLivePreview {
                pid: 123,
                stdin: None,
                first_frame_received: false,
            }),
        };

        assert!(!should_reuse_idle_live_preview(&state, &params));
    }

    #[tokio::test]
    async fn stop_waits_for_final_recording_status_event() {
        let (events, _) = tokio::sync::broadcast::channel(8);
        let mut receiver = events.subscribe();
        let session_id = "session";

        events
            .send(crate::protocol::ServerEvent::new(
                "recording.status",
                RecordingStatus {
                    state: RecordingState::Stopping,
                    session_id: Some(session_id.to_string()),
                    output_path: None,
                    stream_url: None,
                    started_at: None,
                    audio_tracks: Vec::new(),
                    pipeline: None,
                    duration_ms: None,
                    message: Some("Stopping.".to_string()),
                },
            ))
            .unwrap();
        events
            .send(crate::protocol::ServerEvent::new(
                "recording.status",
                RecordingStatus {
                    state: RecordingState::Idle,
                    session_id: Some(session_id.to_string()),
                    output_path: Some("/tmp/videorc-test.mkv".to_string()),
                    stream_url: None,
                    started_at: None,
                    audio_tracks: Vec::new(),
                    pipeline: None,
                    duration_ms: None,
                    message: Some("Capture session finalized.".to_string()),
                },
            ))
            .unwrap();

        let status = wait_for_final_recording_status(&mut receiver, session_id)
            .await
            .unwrap();

        assert!(matches!(status.state, RecordingState::Idle));
        assert_eq!(status.output_path.as_deref(), Some("/tmp/videorc-test.mkv"));
    }

    #[test]
    fn shared_pipeline_uses_tee_for_dual_output() {
        let params = base_params(true, true);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[build_stream_url(&params.output.rtmp).unwrap()],
            None,
        )
        .unwrap();

        assert!(args.contains(&"tee".to_string()));
        assert!(args.iter().any(|arg| arg.contains("[f=matroska")));
        assert!(args.iter().any(|arg| arg.contains("[f=flv")));
        assert!(args.contains(&"-filter_complex".to_string()));
        assert_eq!(ffmpeg_inputs(&args), vec!["3:none", ":1", "0:none"]);
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert!(args.iter().any(|arg| arg.contains("[2:v]")));
        assert!(args.iter().any(|arg| arg == "title=Microphone"));
        assert_eq!(
            arg_value(&args, "-af"),
            Some("asetpts=PTS-0.250/TB,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&args, "-ar"), Some("48000"));
        assert_eq!(arg_value(&args, "-ac"), Some("2"));
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        assert_eq!(arg_value(&args, "-b:a"), Some("160k"));
        assert_eq!(arg_value(&args, "-realtime"), Some("1"));
        assert_eq!(arg_value(&args, "-prio_speed"), Some("1"));
        // A pinned 2-second keyframe interval so YouTube (and HLS/DVR) go live.
        assert_eq!(
            arg_value(&args, "-force_key_frames"),
            Some("expr:gte(t,n_forced*2)")
        );
        let fps = arg_value(&args, "-r")
            .and_then(|value| value.parse::<u32>().ok())
            .expect("fps arg present");
        let expected_gop = (fps * 2).to_string();
        assert_eq!(arg_value(&args, "-g"), Some(expected_gop.as_str()));
        assert!(args.contains(&"8000k".to_string()));
        assert!(args.iter().any(|arg| arg.contains("pad=2560:1440")));
        assert!(args.contains(&"pipe:2".to_string()));
        assert!(args.contains(&"pipe:1".to_string()));
        assert!(args.iter().any(|arg| arg.contains("[v]split=2")));
        assert!(args.iter().any(|arg| arg == "[preview]"));
    }

    #[test]
    fn recording_pipeline_adds_screen_overlay_fifo_without_changing_audio_mapping() {
        let params = base_params(true, true);
        let overlay = ScreenOverlayInput {
            fifo_path: PathBuf::from("/tmp/videorc-screen-overlay-test.rgba"),
            width: params.output.video.width,
            height: params.output.video.height,
            fps: SCREEN_OVERLAY_FPS,
        };
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[build_stream_url(&params.output.rtmp).unwrap()],
            Some(&overlay),
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                "3:none",
                ":1",
                "0:none",
                "/tmp/videorc-screen-overlay-test.rgba"
            ]
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-screen-overlay-test.rgba", "-f"),
            Some("rawvideo")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-screen-overlay-test.rgba", "-pix_fmt"),
            Some("rgba")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-screen-overlay-test.rgba", "-s"),
            Some("2560x1440")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-screen-overlay-test.rgba", "-framerate"),
            Some("4")
        );
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert!(!args.iter().any(|arg| arg == "3:a?"));
        let filter = arg_value(&args, "-filter_complex").unwrap();
        assert!(filter.contains("[v][3:v]overlay=x=0:y=0"));
        assert!(filter.contains("[v_screen]split=2[v_main][v_preview]"));
    }

    #[test]
    fn mac_recording_uses_dedicated_microphone_audio_input() {
        let params = base_params(true, false);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(ffmpeg_inputs(&args), vec!["3:none", ":1"]);
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert!(args.iter().any(|arg| arg == "-metadata:s:a:0"));
        assert!(args.iter().any(|arg| arg == "title=Microphone"));
        assert_eq!(
            arg_value(&args, "-af"),
            Some("asetpts=PTS-0.250/TB,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&args, "-ar"), Some("48000"));
        assert_eq!(arg_value(&args, "-ac"), Some("2"));
        assert_eq!(arg_value(&args, "-c:a"), Some("pcm_s16le"));
        assert_eq!(arg_value(&args, "-b:a"), None);
    }

    #[test]
    fn mac_recording_uses_native_coreaudio_fifo_when_selected() {
        let params = base_params(true, false);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: Some(MicrophoneInput::CoreAudio {
                    device_id: 42,
                    fifo_path: Some(PathBuf::from("/tmp/videorc-audio-test.f32le")),
                }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec!["3:none", "/tmp/videorc-audio-test.f32le"]
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-audio-test.f32le", "-f"),
            Some("f32le")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-audio-test.f32le", "-ar"),
            Some("48000")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-audio-test.f32le", "-ac"),
            Some("2")
        );
        assert_eq!(
            input_arg_value(&args, "/tmp/videorc-audio-test.f32le", "-thread_queue_size"),
            Some("64")
        );
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert_eq!(
            arg_value(&args, "-af"),
            Some("asetpts=PTS-0.250/TB,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&args, "-ac"), Some("2"));
        assert_eq!(arg_value(&args, "-c:a"), Some("pcm_s16le"));
    }

    #[test]
    fn microphone_sync_offset_can_be_tuned_or_disabled() {
        let mut params = base_params(true, false);
        params.audio.microphone_sync_offset_ms = 120;
        let delayed = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        params.audio.microphone_sync_offset_ms = 0;
        let disabled = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(
            arg_value(&delayed, "-af"),
            Some("asetpts=PTS+0.120/TB,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(
            arg_value(&disabled, "-af"),
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
    }

    #[test]
    fn microphone_sync_offset_does_not_shift_test_tone() {
        let params = base_params(true, false);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(
            arg_value(&args, "-af"),
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&args, "-ac"), Some("2"));
    }

    #[test]
    fn mac_recording_without_mic_is_video_only() {
        let params = base_params(true, false);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(ffmpeg_inputs(&args), vec!["3:none"]);
        assert!(!args.iter().any(|arg| arg.ends_with(":a?")));
        assert_eq!(arg_value(&args, "-af"), None);
        assert_eq!(arg_value(&args, "-c:a"), None);
        assert!(args.contains(&"pipe:1".to_string()));
    }

    #[test]
    fn recording_command_includes_muted_mjpeg_live_preview_output() {
        let params = base_params(true, false);
        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: None,
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert!(args.iter().any(|arg| arg.contains("[v]split=2")));
        assert!(args.iter().any(|arg| arg.contains("pad=1280:720")));
        assert!(args.iter().any(|arg| arg == "-an"));
        assert!(args.iter().any(|arg| arg == "mjpeg"));
        assert!(args.iter().any(|arg| arg == "mpjpeg"));
        assert_eq!(arg_value(&args, "-flush_packets"), Some("1"));
        assert!(args.iter().any(|arg| arg == "videorc"));
        assert!(args.iter().any(|arg| arg == "pipe:1"));
    }

    #[test]
    fn mp4_export_copies_video_and_encodes_audio_for_mp4_compatibility() {
        let args = mp4_export_args(
            Path::new("/tmp/videorc-test.mkv"),
            Path::new("/tmp/videorc-test.mp4"),
        );

        assert_eq!(arg_value(&args, "-i"), Some("/tmp/videorc-test.mkv"));
        assert_eq!(arg_value(&args, "-map"), Some("0"));
        assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        assert_eq!(arg_value(&args, "-b:a"), Some("160k"));
        assert_eq!(arg_value(&args, "-movflags"), Some("+faststart"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("/tmp/videorc-test.mp4")
        );
    }

    #[test]
    fn idle_live_preview_command_is_video_only() {
        let params = base_params(true, false);
        let args = live_preview_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
        )
        .unwrap();

        assert_eq!(ffmpeg_inputs(&args), vec!["3:none", "0:none"]);
        assert_eq!(
            input_arg_value(&args, "3:none", "-fflags"),
            Some("nobuffer")
        );
        assert_eq!(
            input_arg_value(&args, "3:none", "-flags"),
            Some("low_delay")
        );
        assert_eq!(input_arg_value(&args, "3:none", "-probesize"), Some("32"));
        assert_eq!(
            input_arg_value(&args, "3:none", "-analyzeduration"),
            Some("0")
        );
        assert_eq!(
            input_arg_value(&args, "3:none", "-thread_queue_size"),
            Some("16")
        );
        assert_eq!(
            input_arg_value(&args, "3:none", "-pixel_format"),
            Some(AVFOUNDATION_VIDEO_PIXEL_FORMAT)
        );
        assert_eq!(input_arg_value(&args, "3:none", "-framerate"), Some("30"));
        assert_eq!(
            input_arg_value(&args, "3:none", "-capture_cursor"),
            Some("1")
        );
        assert_eq!(
            input_arg_value(&args, "0:none", "-fflags"),
            Some("nobuffer")
        );
        assert_eq!(
            input_arg_value(&args, "0:none", "-flags"),
            Some("low_delay")
        );
        assert_eq!(input_arg_value(&args, "0:none", "-probesize"), Some("32"));
        assert_eq!(
            input_arg_value(&args, "0:none", "-analyzeduration"),
            Some("0")
        );
        assert_eq!(
            input_arg_value(&args, "0:none", "-thread_queue_size"),
            Some("16")
        );
        assert_eq!(
            input_arg_value(&args, "0:none", "-pixel_format"),
            Some(AVFOUNDATION_VIDEO_PIXEL_FORMAT)
        );
        assert!(!input_has_arg(&args, "0:none", "-capture_cursor"));
        assert!(!args.iter().any(|arg| arg.ends_with(":a?")));
        assert!(args.iter().any(|arg| arg.contains("pad=1280:720")));
        assert!(args.iter().any(|arg| arg.contains("fps=30")));
        assert!(args.iter().any(|arg| arg.contains("setpts=PTS-STARTPTS")));
        assert!(args.iter().any(|arg| arg == "[preview]"));
        assert!(args.iter().any(|arg| arg == "pipe:1"));
    }

    #[test]
    fn idle_live_preview_caps_composition_to_preview_resolution() {
        let mut params = base_params(true, false);
        params.output.video.fps = 60;
        params.output.video.bitrate_kbps = 9000;
        let preview_params = PreviewLiveParams {
            sources: params.sources,
            layout: params.layout,
            ffmpeg_path: None,
            video: Some(params.output.video),
        };

        let session = live_preview_session_params(preview_params, "ffmpeg".to_string());

        assert_eq!(session.output.video.width, LIVE_PREVIEW_WIDTH);
        assert_eq!(session.output.video.height, LIVE_PREVIEW_HEIGHT);
        assert_eq!(session.output.video.fps, LIVE_PREVIEW_FPS);
        assert_eq!(session.output.video.bitrate_kbps, 4000);
    }

    #[test]
    fn recording_camera_overlay_scales_to_match_idle_preview_size() {
        let recording = base_params(true, false);
        let recording_filter = recording_video_filter(Some(1), None, &recording, true);
        let preview_session = live_preview_session_params(
            PreviewLiveParams {
                sources: recording.sources.clone(),
                layout: recording.layout.clone(),
                ffmpeg_path: None,
                video: Some(recording.output.video.clone()),
            },
            "ffmpeg".to_string(),
        );
        let preview_filter = live_preview_filter(Some(1), &preview_session);

        assert!(recording_filter.contains("scale=720:406"));
        assert!(recording_filter.contains("overlay=x=W-w-64:y=H-h-64"));
        assert!(preview_filter.contains("scale=360:203"));
        assert!(preview_filter.contains("overlay=x=W-w-32:y=H-h-32"));
    }

    #[test]
    fn mjpeg_stdout_parser_drains_complete_parts() {
        let mut pending = b"junk--videorc\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\n\xff\xd8\xff\xd9\r\n--videorc\r\nContent-length: 3\r\n\r\nabc".to_vec();

        let first = drain_next_mjpeg_part(&mut pending).unwrap();
        let second = drain_next_mjpeg_part(&mut pending).unwrap();

        assert!(first.starts_with(MJPEG_BOUNDARY));
        assert!(first.ends_with(b"\r\n"));
        assert!(first.windows(2).any(|window| window == [0xff, 0xd8]));
        assert_eq!(
            std::str::from_utf8(&second).unwrap(),
            "--videorc\r\nContent-length: 3\r\n\r\nabc"
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn mjpeg_part_exposes_latest_jpeg_payload() {
        let part =
            b"--videorc\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9\r\n";

        assert_eq!(
            jpeg_bytes_from_mjpeg_part(part),
            Some(vec![0xff, 0xd8, 0xff, 0xd9])
        );
    }

    #[test]
    fn test_pattern_uses_mic_when_selected_otherwise_test_tone() {
        let params = base_params(true, false);
        let with_mic = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: Some(MicrophoneInput::AvFoundation { index: 1 }),
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();
        let without_mic = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&with_mic),
            vec!["testsrc2=size=2560x1440:rate=30", ":1"]
        );
        assert!(with_mic.iter().any(|arg| arg == "title=Microphone"));
        assert_eq!(
            arg_value(&with_mic, "-af"),
            Some("asetpts=PTS-0.250/TB,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&with_mic, "-ac"), Some("2"));
        assert_eq!(arg_value(&with_mic, "-c:a"), Some("pcm_s16le"));
        assert_eq!(
            ffmpeg_inputs(&without_mic),
            vec![
                "testsrc2=size=2560x1440:rate=30",
                "sine=frequency=880:sample_rate=48000"
            ]
        );
        assert!(without_mic.iter().any(|arg| arg == "title=Test tone"));
        assert_eq!(
            arg_value(&without_mic, "-af"),
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&without_mic, "-ac"), Some("2"));
        assert_eq!(arg_value(&without_mic, "-c:a"), Some("pcm_s16le"));
    }

    #[test]
    fn circle_camera_filter_uses_alpha_mask() {
        let mut params = base_params(true, false);
        params.layout.camera_shape = CameraShape::Circle;
        let filter = video_filter(Some(1), &params, true);

        assert!(filter.contains("format=rgba"));
        assert!(filter.contains("geq="));
        assert!(filter.contains("scale=w=960:h=-2"));
    }

    #[test]
    fn camera_filter_applies_framing_controls() {
        let mut params = base_params(true, false);
        params.layout.camera_fit = CameraFit::Fill;
        params.layout.camera_mirror = true;
        params.layout.camera_zoom = 150;
        params.layout.camera_offset_x = 40;
        params.layout.camera_offset_y = -20;
        let filter = camera_chain_filter(1, &params);

        assert!(filter.starts_with("[1:v]setpts=PTS-STARTPTS,hflip,"));
        assert!(filter.contains("scale=1080:609"));
        assert!(filter.contains("crop=w=720:h=406"));
        assert!(filter.contains("(40)*(iw-ow)/200"));
        assert!(filter.contains("(-20)*(ih-oh)/200"));
    }

    #[test]
    fn camera_fit_filter_pads_to_fixed_frame() {
        let mut params = base_params(true, false);
        params.layout.camera_fit = CameraFit::Fit;
        let filter = camera_chain_filter(1, &params);

        assert!(filter.contains("force_original_aspect_ratio=decrease"));
        assert!(filter.contains("pad=720:406"));
    }

    #[test]
    fn custom_transform_keeps_circle_mask_in_recording() {
        let mut params = base_params(true, false);
        params.layout.camera_shape = CameraShape::Circle;
        params.layout.camera_transform_mode = CameraTransformMode::Custom;
        params.layout.camera_transform = Some(CameraTransform {
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.3,
        });

        let filter = video_filter(Some(1), &params, false);

        // The dragged position drives the overlay placement...
        assert!(
            filter.contains("overlay=x=W*0.10000:y=H*0.10000"),
            "missing custom overlay position: {filter}"
        );
        // ...while the circle alpha mask still applies to the camera content.
        assert!(filter.contains("format=rgba"));
        assert!(filter.contains("geq="));
    }

    #[test]
    fn preview_and_recording_share_camera_treatment() {
        let mut params = base_params(true, false);
        params.layout.camera_shape = CameraShape::Circle;
        params.layout.camera_mirror = true;
        params.layout.camera_fit = CameraFit::Fit;

        let recording = recording_video_filter(Some(1), None, &params, false);
        let preview_session = live_preview_session_params(
            PreviewLiveParams {
                sources: params.sources.clone(),
                layout: params.layout.clone(),
                ffmpeg_path: None,
                video: Some(params.output.video.clone()),
            },
            "ffmpeg".to_string(),
        );
        let preview = live_preview_filter(Some(1), &preview_session);

        // Mirror, circle mask, and fit padding must appear identically in the
        // live preview and the recording so the two never drift apart.
        for marker in [
            "hflip",
            "format=rgba",
            "geq=",
            "force_original_aspect_ratio=decrease",
        ] {
            assert!(
                recording.contains(marker),
                "recording missing {marker}: {recording}"
            );
            assert!(
                preview.contains(marker),
                "preview missing {marker}: {preview}"
            );
        }
    }

    #[test]
    fn stream_requires_manual_key() {
        let mut params = base_params(false, true);
        params.output.rtmp.stream_key.clear();

        assert!(validate_outputs(&params).is_err());
    }

    #[test]
    fn rejects_invalid_video_settings() {
        let mut params = base_params(true, false);
        params.output.video.fps = 120;

        assert!(validate_outputs(&params).is_err());
    }

    #[tokio::test]
    async fn preview_command_times_out() {
        let args = vec!["-c".to_string(), "sleep 5".to_string()];
        let error = run_preview_command_with_timeout("sh", &args, Duration::from_millis(100))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("Preview snapshot timed out"));
    }

    #[test]
    fn parses_avfoundation_device_ids() {
        assert_eq!(parse_avfoundation_id("camera:avfoundation:12"), Some(12));
        assert_eq!(parse_avfoundation_id("window:native-adapter-pending"), None);
    }

    #[test]
    fn parses_ffmpeg_stream_health() {
        let health = parse_ffmpeg_stream_health(
            "session",
            "frame=151 fps=29.97 q=-0.0 size=1024kB drop=3 speed=1.02x",
        )
        .unwrap();

        assert_eq!(health.fps, Some(29.97));
        assert_eq!(health.dropped_frames, Some(3));
        assert_eq!(health.speed, Some(1.02));

        let progress_health = parse_ffmpeg_stream_health("session", "drop_frames=7").unwrap();
        assert_eq!(progress_health.dropped_frames, Some(7));
    }
}
