use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time::{Duration, sleep, timeout};
use uuid::Uuid;

use crate::audio::{
    AudioCaptureStats, AudioProcessingSettings, NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_SAMPLE_RATE,
    NativeAudioCaptureSession, NativeAudioSource, attach_fifo_writer, audio_capture_coverage,
    create_native_audio_fifo, native_audio_fifo_path, parse_coreaudio_microphone_id,
    parse_windows_dshow_microphone_id, start_native_audio_source,
};
use crate::camera_capture::{
    native_camera_name_for_id, parse_native_camera_id, parse_windows_dshow_camera_id,
};
use crate::capture_input::{
    MicrophoneInput, VideoInput, WindowsScreenCaptureBackend, append_avfoundation_video_input,
    append_microphone_input, append_windows_dshow_video_input, append_windows_screen_video_input,
    microphone_channels, microphone_needs_graph_gain,
};
use crate::compositor::{
    CompositorAuxiliaryOutput, CompositorFrameConsumer, CompositorStartParams,
    CompositorStartupBarrierParams, CompositorStartupBarrierResult,
    CompositorStartupSourceRequirements, background_stage_margin, compositor_frame_store,
    compositor_stream_frame_store, start_synthetic_compositor, update_compositor_scene,
    wait_for_compositor_startup_frames,
};
use crate::devices::{
    find_avfoundation_camera_index, find_avfoundation_microphone_index_for_native_name,
    find_avfoundation_screen_index, find_avfoundation_screen_index_for_native_display_id,
};
use crate::diagnostics::{
    RecordingStartupBarrierDiagnosticSnapshot, apply_active_scene_revision, apply_audio_stats,
    apply_duplicate_capture_sources, apply_preview_frame_age, apply_preview_stats,
    apply_recording_startup_barrier_stats, apply_runtime_diagnostics_snapshot, apply_stream_health,
    starting_diagnostics,
};
use crate::encoder_bridge::{
    EncoderBridgeDiagnosticsContext, EncoderBridgeOutputProfile, EncoderBridgeOutputRole,
    EncoderBridgeRecordingSession, EncoderBridgeVideoOutput, start_synthetic_recording_bridge,
};
use crate::entitlements;
use crate::ffmpeg::{ffprobe_path_for, resolve_ffmpeg_path};
use crate::ffmpeg_work::{CapturePermit, MaintenanceCancelToken};
use crate::pipeline::{RecordingPipeline, container_for_outputs, container_key};
use crate::preview_camera::{
    preview_camera_latest_frame_info, reset_preview_camera_capture_timings,
};
use crate::preview_screen::preview_screen_latest_frame_info;
use crate::process_job::{spawn_owned_tokio, status_owned_tokio};
use crate::protocol::{
    AudioSettings, AudioTrack, AudioTrackSource, BackgroundFit, CameraAspect, CameraCorner,
    CameraFit, CameraShape, CameraSize, CameraTransformMode, CompositorBackend,
    CompositorSceneUpdateParams, CompositorState, DiagnosticStats, EffectiveSceneBackground,
    EncodeBackend, EntitlementsSnapshot, FeatureId, HealthLevel, LayoutPreset, LayoutSettings,
    PreviewCameraState, PreviewLiveParams, PreviewLiveSource, PreviewLiveState, PreviewLiveStatus,
    PreviewScreenSourceKind, PreviewScreenState, PreviewSnapshot, PreviewSnapshotParams,
    PreviewSurfaceBacking, PreviewTransport, RecordingPipelineStage, RecordingState,
    RecordingStatus, RemuxSessionParams, RtmpPreset, RtmpSettings, Scene, SceneConfigParams,
    SceneSourceKind, SceneTransform, SideBySideCameraSide, SideBySideSplit, StartSessionParams,
    StreamHealth, StreamScreen, VideoPreset, VideoSettings,
};
use crate::repair::{
    GateStatus, MAINTENANCE_CANCELLED, QualityExpectations, QualityThresholds, QualityVerdict,
    RepairJob, analyze_recording_cancellable, gate_recording_cancellable, has_user_impacting_issue,
    issue_reasons,
};
use crate::scene::{scene_from_capture_config, validate_scene_background};
use crate::screen_capture::{
    is_windows_gdigrab_desktop_screen_id, parse_screencapturekit_display_id,
    parse_screencapturekit_window_id, parse_windows_dxgi_output_index,
};
use crate::secrets;
use crate::state::{AppState, PreviewFrame};
use crate::storage::{Database, NewSession, PlatformAccountCredentials, default_preview_dir};
use crate::streaming::{
    StreamAuthMode, StreamPlatform, StreamTargetRuntime, StreamTargetSettings, StreamTargetState,
    StreamTargetsSnapshot, StreamUrlMode, StreamingSettings, stream_platform_from_preset,
    stream_platform_id, stream_platform_label,
};

const PREVIEW_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the live mic-stats sampler reads CoreAudio counters during a recording.
const NATIVE_AUDIO_SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);
/// Silent-mic health check (plan 021 F3): how deep into a recording the mic may
/// stay silent before the session gets a truthful warning, and the session-peak
/// floor below which a track counts as silence (TCC-unauthorized processes get
/// silent zeros from CoreAudio — frames advance, the track holds nothing).
const MIC_SILENT_CHECK_AFTER: Duration = Duration::from_secs(10);
const MIC_SILENT_PEAK_EPSILON: f32 = 0.001;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SilentMicKind {
    /// The device never delivered a frame (missing/wedged input).
    NoFrames,
    /// Frames arrived but every sample was zero — CoreAudio's silence for a
    /// TCC-unauthorized process, or a hard-muted device.
    AllSilence,
}

fn silent_mic_verdict(captured_frames: u64, session_peak: f32) -> Option<SilentMicKind> {
    if captured_frames == 0 {
        return Some(SilentMicKind::NoFrames);
    }
    if session_peak < MIC_SILENT_PEAK_EPSILON {
        return Some(SilentMicKind::AllSilence);
    }
    None
}
const RECORDING_PREVIEW_WIDTH: u32 = 640;
const RECORDING_PREVIEW_HEIGHT: u32 = 360;
const RECORDING_PREVIEW_FPS: u32 = 5;
const RECORDING_PREVIEW_JPEG_QUALITY: u32 = 6;
const IDLE_PREVIEW_WIDTH: u32 = 1280;
const IDLE_PREVIEW_HEIGHT: u32 = 720;
const IDLE_PREVIEW_FPS: u32 = 10;
const IDLE_PREVIEW_JPEG_QUALITY: u32 = 4;
const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;
const STOP_FINALIZE_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TERM_DELAY: Duration = Duration::from_secs(3);
const STOP_KILL_DELAY: Duration = Duration::from_secs(3);
// Sessions with a live RTMP leg get a longer quit grace: the tee/fifo leg
// must drain its queue and close the connection so the platform sees an
// RTMP-level goodbye instead of a dead socket. Every session before plan 031
// ended in SIGKILL (quit -> 3s -> TERM -> 3s -> KILL), which is the prime
// suspect for X sources going playback-dead on reuse (2026-07-08 incident).
const STOP_TERM_DELAY_STREAMING: Duration = Duration::from_secs(8);
const STOP_KILL_DELAY_STREAMING: Duration = Duration::from_secs(5);
const SHUTDOWN_GRACE_DELAY: Duration = Duration::from_millis(1200);
const CAPTURE_AUDIO_FILTER: &str = "aresample=async=1:first_pts=0";
const MONO_TO_STEREO_FILTER: &str = "pan=stereo|c0=c0|c1=c0";
const MICROPHONE_SYNC_OFFSET_MIN_MS: i32 = -1000;
const MICROPHONE_SYNC_OFFSET_MAX_MS: i32 = 1000;
// The isolated FLV/RTMP egress path adds about 130ms of audio latency relative
// to its copied video stream. Two real split-output calibrations (10s and 60s)
// agreed within 5ms; advancing by the old 220ms calibration made stream audio
// consistently 87-92ms early even though the local recording stayed aligned.
const STREAM_OUTPUT_AUDIO_ADVANCE_MS: i32 = 130;
const MJPEG_BOUNDARY: &[u8] = b"--videorc";
const MJPEG_HEADER_END: &[u8] = b"\r\n\r\n";
const PREVIEW_READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_PENDING_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const SCREEN_OVERLAY_FPS: u32 = 4;
const SCREEN_OVERLAY_FIFO_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);
const SCREEN_OVERLAY_FIFO_WRITE_RETRY: std::time::Duration = std::time::Duration::from_millis(5);
const POST_RECORDING_GATE_IDLE_DELAY: Duration = Duration::from_secs(30);
const POST_RECORDING_FAST_ASSESSMENT_TIMEOUT: Duration = Duration::from_secs(60);
const POST_RECORDING_REPAIR_TIMEOUT: Duration = Duration::from_secs(180);
// Raw compositor frames arrive over a live FIFO alongside live device audio.
// FFmpeg needs a dedicated demux thread for that input; without one, Windows
// dshow polling can leave the named-pipe reader idle until its buffer fills,
// blocking the bridge and starving both recording and preview.
const ENCODER_BRIDGE_RAW_VIDEO_INPUT_QUEUE_FRAMES: u32 = 16;
const ENCODER_BRIDGE_VIDEO_OUTPUT_ENV: &str = "VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT";

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
    pub encoder_bridge: Option<EncoderBridgeRecordingSession>,
    pub encoder_bridge_stream: Option<EncoderBridgeRecordingSession>,
    /// True only when this session has a viewer-facing stream leg rendered by
    /// the compositor bridge. Legacy FFmpeg and record-only paths must reject
    /// comment highlights before touching the overlay slot.
    pub comment_highlight_available: bool,
    pub _capture_permit: Option<CapturePermit>,
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
        let _ = crate::fifo::cleanup(&self.fifo_path);
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

/// Expand a leading `~` to the platform home directory. Shells do this before
/// a program ever sees the path; users type `~/Movies/...` into Settings
/// expecting the same.
pub fn expand_user_path(path: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    let home_var = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let home_var = "HOME";

    if path == "~"
        && let Some(home) = std::env::var_os(home_var)
    {
        return PathBuf::from(home);
    }
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = std::env::var_os(home_var)
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(path)
}

/// Resolve the user-configured output directory: blank means the platform
/// default, a leading `~` expands, and anything still RELATIVE is refused.
/// Two recordings landed INSIDE the signed app bundle (2026-07-06) because a
/// literal "~/Movies/…" from Settings resolved against the backend's cwd —
/// never write relative to cwd.
pub fn resolve_output_directory(configured: Option<&str>) -> Result<PathBuf> {
    let Some(trimmed) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(default_recordings_dir());
    };
    let expanded = expand_user_path(trimmed);
    if !expanded.is_absolute() {
        bail!(
            "Output directory '{trimmed}' is not a full path. Use an absolute path like /Users/you/Movies, or clear it in Settings to use the default."
        );
    }
    Ok(expanded)
}

pub fn default_recordings_dir() -> PathBuf {
    // Harness isolation (F-016): smokes must never write into the user's real
    // media library — Electron main forces this env for isolated backend
    // spawns, mirroring the sqlite/secrets overrides.
    if let Some(dir) = std::env::var_os("VIDEORC_RECORDINGS_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    // macOS keeps captures under ~/Movies; Windows uses ~/Videos (the
    // platform's Known Folder for the same content).
    #[cfg(target_os = "windows")]
    let (home_var, media_dir) = ("USERPROFILE", "Videos");
    #[cfg(not(target_os = "windows"))]
    let (home_var, media_dir) = ("HOME", "Movies");

    std::env::var_os(home_var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(media_dir)
        .join("Videorc")
        .join("Recordings")
}

/// FX8: Library titles read in the user's wall clock. Generic over the zone so
/// the conversion is testable with a fixed offset (`Local` at the call site).
fn session_title<Tz: chrono::TimeZone>(started_at: &DateTime<Utc>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    format!(
        "Session {}",
        started_at.with_timezone(tz).format("%Y-%m-%d %H:%M")
    )
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

struct RecordingStartupSceneLease {
    scene_revision: u64,
    _scene_commit: OwnedMutexGuard<()>,
}

async fn commit_recording_startup_scene_at_time(
    state: &AppState,
    scene: &Scene,
    layout: LayoutSettings,
    active_screen: Option<StreamScreen>,
    now_millis: u64,
) -> RecordingStartupSceneLease {
    // Recording startup and live/idle scene transactions share one commit edge.
    // Keep this lease alive until the exact startup revision reaches compositor
    // pixels; otherwise the renderer's delayed idle reload can replace the scene
    // while the recording barrier is still waiting for it.
    let scene_commit = state.scene_commit.clone().lock_owned().await;
    {
        let mut active_scene = state.scene.lock().await;
        *active_scene = scene.clone();
    }
    let current_revision = state.compositor.lock().await.status.scene_revision;
    let scene_revision = crate::live_layout::next_scene_revision(current_revision, now_millis);
    update_compositor_scene(
        state,
        CompositorSceneUpdateParams {
            revision: scene_revision,
            scene: Some(scene.clone()),
            layout,
            active_screen,
        },
    )
    .await;

    RecordingStartupSceneLease {
        scene_revision,
        _scene_commit: scene_commit,
    }
}

pub async fn start_session(
    state: AppState,
    mut params: StartSessionParams,
) -> Result<RecordingStatus> {
    if state.recording.lock().await.is_some() {
        bail!("A capture session is already running");
    }

    hydrate_stream_key_secret_refs(&state, &mut params)?;
    validate_session_entitlements(&params, &entitlements::current_entitlements())?;

    let capture_permit = state.ffmpeg_work.begin_capture_when_available().await;
    validate_outputs(&params)?;
    if let Some(scene) = params.scene.as_ref()
        && let Err(message) = validate_scene_background(scene)
    {
        bail!(message);
    }

    let ffmpeg_path = resolve_ffmpeg_path(params.output.ffmpeg_path.clone());
    let output_dir = resolve_output_directory(params.output.output_directory.as_deref())?;

    if params.output.record_enabled {
        fs::create_dir_all(&output_dir)
            .await
            .with_context(|| format!("Could not create {}", output_dir.display()))?;
    }

    let session_id = Uuid::new_v4().to_string();
    let started_at = Utc::now();
    // FX8: the display title reads in the user's wall clock — it sat next to
    // Library's locally-rendered date column showing a different time. The
    // stored `started_at` (RFC3339 UTC) and the output filename stay UTC.
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

    // F-017: every early error below this point used to leave a permanent
    // 'running' Library row pointing at a file that never existed. The guard
    // marks the row failed on ANY exit path that doesn't reach the pipeline.
    let mut session_row_guard = SessionStartRowGuard::new(state.database.clone(), &session_id);

    state.database.create_session(&NewSession {
        id: session_id.clone(),
        title: session_title(&started_at, &chrono::Local),
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

    if params.output.record_enabled {
        emit_disk_space_health_event(&state, &session_id, &output_dir).await?;
    }

    stop_idle_live_preview_for_recording(state.clone()).await;

    let mut capture = resolve_capture_inputs(&ffmpeg_path, &params).await;
    let mut native_audio_source =
        prepare_native_audio_source(&state, &session_id, &mut capture, &params).await;
    // Warm up the microphone before the video pipeline starts so audio and video begin in
    // lockstep. CoreAudio takes a few hundred ms to deliver its first callback while video
    // frames flow immediately; without this wait the recorded audio lags the picture by
    // that startup latency (measured ~360-390ms on real recordings).
    if let Some(prepared) = native_audio_source.as_ref()
        && !await_microphone_warmup(&state, prepared.source.stats_handle()).await
        && let Some(prepared) = native_audio_source.take()
    {
        let device_name = prepared.source.device_name.clone();
        if let Some(index) =
            find_avfoundation_microphone_index_for_native_name(&ffmpeg_path, &device_name).await
        {
            let message = format!(
                "Native microphone {device_name} did not deliver warmup frames; switching this session to the FFmpeg avfoundation fallback input."
            );
            state.emit_log("warn", &message);
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Warn,
                "microphone-fallback-selected",
                &message,
            );
            capture.microphone = Some(MicrophoneInput::AvFoundation { index });
        } else {
            let message = format!(
                "Native microphone {device_name} did not deliver warmup frames and no matching fallback input was found; omitting the mic FIFO so FFmpeg can finalize video instead of blocking on an empty audio input."
            );
            state.emit_log("warn", &message);
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Warn,
                "microphone-native-warmup-timeout",
                &message,
            );
            capture.microphone = None;
        }
        let _ = crate::fifo::cleanup(&prepared.fifo_path);
    }
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
    emit_audio_track_health_events(&state, &session_id, &params, &audio_tracks)?;
    let active_screen = state.database.active_stream_screen()?;
    let use_encoder_bridge =
        should_use_compositor_encoder_bridge(&state, &params, active_screen.as_ref()).await?;
    emit_foundation_health_events(&state, &session_id, &params, use_encoder_bridge)?;
    // The legacy FFmpeg screen+camera overlay and side-by-side paths both rely on the
    // camera device index. The protected compositor bridge uses native source frames, so
    // an unavailable FFmpeg camera index is not itself a recording-path failure there.
    if !use_encoder_bridge
        && matches!(
            params.layout.layout_preset,
            LayoutPreset::ScreenCamera | LayoutPreset::SideBySide
        )
        && params.sources.camera_id.is_some()
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
    if !use_encoder_bridge {
        state.emit_log(
            "warn",
            "Session is using the legacy FFmpeg capture path (encoder bridge disabled by env or fps > 30).",
        );
    }
    // Shared session epoch (plan slice A2): the encoder bridge sets this at its first
    // delivered video frame, and the audio FIFO writer trims everything captured
    // before that instant — so audio and video content start together regardless of
    // how long the video pipeline takes to warm up at a given resolution.
    let video_epoch: std::sync::Arc<std::sync::OnceLock<Instant>> =
        std::sync::Arc::new(std::sync::OnceLock::new());
    let encoder_bridge_fifo = if use_encoder_bridge {
        let fifo_path = recording_encoder_bridge_fifo_path(&session_id);
        create_recording_encoder_bridge_fifo(&fifo_path)?;
        Some(fifo_path)
    } else {
        None
    };
    let encoder_bridge_video_output = if use_encoder_bridge {
        recording_encoder_bridge_video_output(
            params.output.record_enabled,
            params.output.stream_enabled,
        )
    } else {
        EncoderBridgeVideoOutput::RawYuv420p
    };
    let encoder_bridge_stream_output = if use_encoder_bridge {
        recording_compositor_stream_output(&params, encoder_bridge_video_output)?
    } else {
        None
    };
    // Remember this session's caption styling for the post-recording burned
    // copy (defaults when captions params are absent).
    {
        let captions_params = params.captions.clone().unwrap_or_default();
        crate::captions::set_caption_session_style(
            &state,
            captions_params.position,
            captions_params.text_size,
            params.output.video.width,
            params.output.video.height,
        )
        .await;
    }
    // A new session must never inherit a composited caption bar. The overlay
    // slot is app-global and the renderer's stop-time clear is best-effort
    // (fire-and-forget, and a closed renderer never sends it) — clearing here
    // is the authoritative boundary (caption carry-over fix, 2026-07-04).
    let _ = crate::captions::clear_caption_overlay(&state.caption_overlay);
    // Same boundary rule for comment highlights, including backend state and
    // any old expiry task — a new session never inherits the prior card.
    let _ = crate::comment_highlight::clear_comment_highlight_for_session_start(&state).await;
    // Burn-in needs the synthetic compositor (encoder-bridge path) and, for a
    // split-leg plan, an auxiliary render. Outside those shapes the captions
    // stay UI-only — say so instead of silently skipping pixels.
    {
        let leg_plan = caption_leg_plan(&params);
        let burn_requested = leg_plan.primary || leg_plan.aux;
        let split_needed_but_missing = leg_plan.force_same_profile_split
            && params.output.record_enabled
            && params.output.stream_enabled
            && encoder_bridge_stream_output.is_none();
        if burn_requested && (!use_encoder_bridge || split_needed_but_missing) {
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Warn,
                "captions-burn-in-unavailable",
                "Caption burn-in is unavailable for this session's encoder path; captions stay on-screen only.",
            );
        }
    }
    let encoder_bridge_resolved_stream_profile =
        if use_encoder_bridge && params.output.stream_enabled {
            match encoder_bridge_stream_output {
                Some(stream_output) => Some(resolve_auxiliary_stream_output_video(
                    &params,
                    &stream_output,
                )?),
                None => Some(resolve_stream_output_video(&params)?),
            }
        } else {
            None
        };
    let encoder_bridge_stream_profile =
        encoder_bridge_stream_output.and_then(|_| encoder_bridge_resolved_stream_profile.clone());
    let encoder_bridge_stream_fifo = if encoder_bridge_stream_output.is_some() {
        let fifo_path = stream_encoder_bridge_fifo_path(&session_id);
        create_stream_encoder_bridge_fifo(&fifo_path)?;
        Some(fifo_path)
    } else {
        None
    };
    let screen_overlay_fifo =
        if !use_encoder_bridge && (active_screen.is_some() || params.output.stream_enabled) {
            let fifo_path = screen_overlay_fifo_path(&session_id);
            create_screen_overlay_fifo(&fifo_path)?;
            Some(fifo_path)
        } else {
            None
        };

    let mut pipeline = RecordingPipeline::new(
        params.output.record_enabled,
        params.output.stream_enabled,
        &audio_tracks,
    );
    let duplicate_capture_sources = if use_encoder_bridge {
        Vec::new()
    } else {
        duplicate_capture_sources_for_capture(&state, &capture).await
    };
    let mut initial_diagnostics = apply_duplicate_capture_sources(
        starting_diagnostics(&session_id, params.output.video.fps, mode),
        duplicate_capture_sources,
    );
    // Both the shared-compositor bridge and the legacy path request the platform H.264
    // encoder. The bridge is the protected consumer of the compositor output, paced by
    // the output clock; the legacy path captures via FFmpeg.
    initial_diagnostics.encode_backend = Some(default_h264_encode_backend());
    initial_diagnostics.recording_protected = use_encoder_bridge;
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = initial_diagnostics.clone();
    }
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(initial_diagnostics, state.ffmpeg_work.snapshot()),
    );
    let screen_overlay = screen_overlay_fifo
        .as_ref()
        .map(|fifo_path| ScreenOverlayInput {
            fifo_path: fifo_path.clone(),
            width: params.output.video.width,
            height: params.output.video.height,
            fps: SCREEN_OVERLAY_FPS,
        });
    let mut startup_barrier_result: Option<CompositorStartupBarrierResult> = None;
    let mut recording_startup_scene: Option<RecordingStartupSceneLease> = None;
    let (encoder_bridge_frame_store, encoder_bridge_stream_frame_store) = if use_encoder_bridge {
        let target_fps = recording_compositor_target_fps(&state, &params.output.video).await;
        start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps,
                width: params.output.video.width,
                height: params.output.video.height,
                frame_consumer: if matches!(
                    encoder_bridge_video_output,
                    EncoderBridgeVideoOutput::RawYuv420p
                ) {
                    CompositorFrameConsumer::RawYuvEncoder
                } else {
                    CompositorFrameConsumer::VideoToolboxEncoder
                },
                stream_output: encoder_bridge_stream_output,
                // Per-leg overlay plan (R1): primary = recording (or the
                // stream when stream-only), aux = the split stream leg.
                caption_overlay_on_primary: caption_leg_plan(&params).primary,
                caption_overlay_on_aux: caption_leg_plan(&params).aux,
                highlight_overlay_on_primary: crate::captions::highlight_overlay_leg_plan(
                    params.output.record_enabled,
                    params.output.stream_enabled,
                    encoder_bridge_stream_output.is_some(),
                )
                .0,
                highlight_overlay_on_aux: crate::captions::highlight_overlay_leg_plan(
                    params.output.record_enabled,
                    params.output.stream_enabled,
                    encoder_bridge_stream_output.is_some(),
                )
                .1,
            },
        )
        .await;
        let scene = params.scene.clone().unwrap_or_else(|| {
            scene_from_capture_config(SceneConfigParams {
                sources: params.sources.clone(),
                layout: params.layout.clone(),
                video: Some(params.output.video.clone()),
                background: None,
                protected_overlay_window_ids: Vec::new(),
            })
        });
        let startup_source_requirements = recording_startup_source_requirements(&scene);
        if let Err(error) = await_recording_camera_cadence_ready(
            &state,
            &session_id,
            params.output.video.fps,
            startup_source_requirements,
        )
        .await
        {
            emit_preflight_failure_report(
                &state,
                &session_id,
                "camera source cadence",
                &error.to_string(),
                &params,
                &startup_source_requirements,
            )
            .await;
            if let Some(fifo_path) = encoder_bridge_fifo.as_ref() {
                let _ = crate::fifo::cleanup(fifo_path);
            }
            if let Some(fifo_path) = encoder_bridge_stream_fifo.as_ref() {
                let _ = crate::fifo::cleanup(fifo_path);
            }
            return Err(error);
        }
        let startup_scene = commit_recording_startup_scene_at_time(
            &state,
            &scene,
            params.layout.clone(),
            active_screen.clone(),
            u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0),
        )
        .await;
        let startup_scene_revision = startup_scene.scene_revision;
        recording_startup_scene = Some(startup_scene);
        match await_recording_startup_barrier(
            &state,
            &session_id,
            params.output.video.width,
            params.output.video.height,
            params.output.video.fps,
            Some(startup_scene_revision),
            startup_source_requirements,
        )
        .await
        {
            Ok(result) => {
                startup_barrier_result = Some(result);
            }
            Err(error) => {
                emit_preflight_failure_report(
                    &state,
                    &session_id,
                    "compositor startup",
                    &error.to_string(),
                    &params,
                    &startup_source_requirements,
                )
                .await;
                if let Some(fifo_path) = encoder_bridge_fifo.as_ref() {
                    let _ = crate::fifo::cleanup(fifo_path);
                }
                if let Some(fifo_path) = encoder_bridge_stream_fifo.as_ref() {
                    let _ = crate::fifo::cleanup(fifo_path);
                }
                return Err(error);
            }
        }
        let recording_store = Some(compositor_frame_store(&state).await);
        let stream_store = if encoder_bridge_stream_output.is_some() {
            Some(
                compositor_stream_frame_store(&state)
                    .await
                    .context("Split output compositor stream frame store was not prepared")?,
            )
        } else {
            None
        };
        (recording_store, stream_store)
    } else {
        (None, None)
    };
    let args = if use_encoder_bridge {
        let fifo_path = encoder_bridge_fifo
            .as_deref()
            .context("Encoder bridge FIFO path was not prepared")?;
        if params.output.record_enabled && !params.output.stream_enabled {
            bridge_recording_ffmpeg_args(
                &capture,
                &params,
                output_path.as_deref(),
                fifo_path,
                encoder_bridge_video_output,
            )?
        } else if let (Some(stream_output), Some(stream_fifo_path)) = (
            encoder_bridge_stream_output,
            encoder_bridge_stream_fifo.as_deref(),
        ) {
            bridge_compositor_split_output_ffmpeg_args(
                &capture,
                &params,
                output_path.as_deref(),
                &stream_targets,
                fifo_path,
                stream_fifo_path,
                encoder_bridge_video_output,
                stream_output,
            )?
        } else {
            bridge_compositor_ffmpeg_args(
                &capture,
                &params,
                output_path.as_deref(),
                &stream_targets,
                fifo_path,
                encoder_bridge_video_output,
            )?
        }
    } else {
        ffmpeg_args(
            &capture,
            &params,
            output_path.as_deref(),
            &stream_targets,
            screen_overlay.as_ref(),
        )?
    };

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

    let mut command = ffmpeg_command(&ffmpeg_path);
    command
        .args(&args)
        .stdin(if use_encoder_bridge {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_tokio(&mut command)
        .with_context(|| format!("Could not start {ffmpeg_path}"))?;

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let stdin = if use_encoder_bridge {
        None
    } else {
        child.stdin.take()
    };
    let pid = child.id().unwrap_or_default();
    let (encoder_bridge, encoder_bridge_stream) = if use_encoder_bridge {
        let bridge_fifo_path = encoder_bridge_fifo
            .clone()
            .context("Encoder bridge FIFO path was unavailable")?;
        let recording_diagnostics_context = encoder_bridge_diagnostics_context(
            if encoder_bridge_stream_profile.is_some() {
                EncoderBridgeOutputRole::Recording
            } else {
                EncoderBridgeOutputRole::Shared
            },
            params.output.record_enabled.then_some(&params.output.video),
            encoder_bridge_resolved_stream_profile.as_ref(),
            encoder_bridge_video_output,
            encoder_bridge_stream_profile.is_some(),
        );
        let recording_bridge = start_synthetic_recording_bridge(
            state.clone(),
            session_id.clone(),
            params.output.video.fps,
            params.output.video.width,
            params.output.video.height,
            bridge_fifo_path,
            encoder_bridge_frame_store.clone(),
            encoder_bridge_video_output,
            Some(params.output.video.bitrate_kbps),
            recording_diagnostics_context,
            video_epoch.clone(),
        )?;
        let stream_bridge = match (
            encoder_bridge_stream_fifo.clone(),
            encoder_bridge_stream_profile.as_ref(),
            encoder_bridge_stream_frame_store.clone(),
        ) {
            (Some(stream_fifo_path), Some(stream_profile), Some(stream_frame_store)) => {
                let stream_diagnostics_context = encoder_bridge_diagnostics_context(
                    EncoderBridgeOutputRole::Stream,
                    Some(&params.output.video),
                    Some(stream_profile),
                    encoder_bridge_video_output,
                    true,
                );
                Some(start_synthetic_recording_bridge(
                    state.clone(),
                    session_id.clone(),
                    stream_profile.fps,
                    stream_profile.width,
                    stream_profile.height,
                    stream_fifo_path,
                    Some(stream_frame_store),
                    encoder_bridge_video_output,
                    Some(stream_profile.bitrate_kbps),
                    stream_diagnostics_context,
                    video_epoch.clone(),
                )?)
            }
            _ => None,
        };
        (Some(recording_bridge), stream_bridge)
    } else {
        (None, None)
    };
    if let Some(result) = startup_barrier_result.as_ref() {
        publish_recording_startup_barrier_diagnostics(
            &state,
            "encoding",
            result,
            Some(result.wait_ms),
        )
        .await;
    }
    pipeline.mark_running();
    let has_native_audio = native_audio_source.is_some();
    // Post-recording quality gate inputs (slice 8): what this session is expected to
    // contain, captured before `audio_tracks` is moved into the active recording.
    let gate_expect_audio = !audio_tracks.is_empty();
    let gate_intended_fps = (params.output.video.fps > 0).then_some(params.output.video.fps as f64);
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
        native_audio: native_audio_source.map(|prepared| {
            attach_fifo_writer(
                prepared.source,
                prepared.fifo_path,
                use_encoder_bridge.then(|| video_epoch.clone()),
            )
        }),
        screen_overlay: match screen_overlay_fifo {
            Some(screen_overlay_fifo) => Some(ScreenOverlaySession::start(
                screen_overlay_fifo,
                params.output.video.width,
                params.output.video.height,
                active_screen.clone().map(|screen| screen.image_path),
            )?),
            None => None,
        },
        encoder_bridge,
        encoder_bridge_stream,
        comment_highlight_available: comment_highlight_available(&params, use_encoder_bridge),
        _capture_permit: Some(capture_permit),
        stop_requested: false,
    };
    let running_state = if params.output.stream_enabled && !params.output.record_enabled {
        RecordingState::Streaming
    } else {
        RecordingState::Recording
    };
    let running_status = active.status(running_state, Some(format!("Running {mode} session.")));

    *state.recording.lock().await = Some(active);
    // A delayed idle capture-config reload that was queued before session start
    // may resume only after `recording` is authoritative; the idle-only commit
    // path will then reject it instead of silently replacing the startup scene.
    drop(recording_startup_scene.take());
    state.emit_event("recording.status", running_status.clone());
    publish_recording_live_preview_status(&state, use_encoder_bridge, None).await;
    if has_native_audio {
        tokio::spawn(sample_native_audio_during_recording(
            state.clone(),
            session_id.clone(),
        ));
    }
    if let Some(stdout) = stdout {
        tokio::spawn(publish_preview_stdout(state.clone(), None, stdout));
    }

    let stream_tee_has_recording_leg =
        output_path.is_some() && !(use_encoder_bridge && encoder_bridge_stream_profile.is_some());
    let (stream_runtime, slave_positions, stream_url_positions) = build_stream_runtime(
        &stream_targets,
        &skipped_targets,
        stream_tee_has_recording_leg,
    );
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

                // Progress/stat spam must not reach the bounded log ring —
                // it evicted every useful entry within ~60s during the
                // 2026-07-08 X incident. Stats still feed stream health.
                if is_ffmpeg_progress_noise(trimmed) {
                    tracing::debug!("{trimmed}");
                } else {
                    log_state.emit_log("warn", trimmed);
                }
                if let Some(stream_health) = parse_ffmpeg_stream_health(&log_session_id, trimmed) {
                    let scene_revision = current_compositor_scene_revision(&log_state).await;
                    let diagnostic_stats = {
                        let mut diagnostics = log_state.diagnostics.lock().await;
                        let next = apply_active_scene_revision(
                            apply_stream_health(diagnostics.clone(), &stream_health, target_fps),
                            scene_revision,
                        );
                        *diagnostics = next.clone();
                        next
                    };
                    log_state.emit_event(
                        "diagnostics.stats",
                        apply_runtime_diagnostics_snapshot(
                            diagnostic_stats,
                            log_state.ffmpeg_work.snapshot(),
                        ),
                    );
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
                // Per-target fifo-muxer legs (plan 023): attribute by URL.
                if let Some(failure) = parse_fifo_output_failure(trimmed)
                    && let Some(position) = stream_url_positions
                        .iter()
                        .find(|(url, _)| *url == failure.url)
                        .map(|(_, position)| *position)
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
        PostRecordingGate {
            intended_fps: gate_intended_fps,
            expect_audio: gate_expect_audio,
        },
    ));
    // The pipeline owns the row from here; monitor_session finishes it.
    session_row_guard.disarm();
    Ok(running_status)
}

/// Marks a freshly-created session row failed if session startup bails before
/// the pipeline takes ownership (F-017 — phantom "running" Library rows).
struct SessionStartRowGuard {
    database: Database,
    session_id: String,
    armed: bool,
}

impl SessionStartRowGuard {
    fn new(database: Database, session_id: &str) -> Self {
        Self {
            database,
            session_id: session_id.to_string(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionStartRowGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = self.database.finish_session(
            &self.session_id,
            "failed",
            Some(Utc::now().to_rfc3339()),
            None,
            None,
        );
        let _ = self.database.add_session_log(
            &self.session_id,
            HealthLevel::Error,
            "session-start-failed",
            "Session start did not reach a running pipeline; the session was marked failed.",
            None,
        );
    }
}

fn hydrate_stream_key_secret_refs(state: &AppState, params: &mut StartSessionParams) -> Result<()> {
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
    let credentials = if streaming.targets.iter().any(|target| {
        target.enabled
            && target.stream_key.trim().is_empty()
            && target.auth_mode == StreamAuthMode::Oauth
            && target.stream_key_secret_ref.is_none()
    }) {
        state.database.list_platform_account_credentials()?
    } else {
        Vec::new()
    };
    hydrate_stream_key_secret_refs_from_credentials(streaming, &credentials, secrets::get_secret)
}

fn hydrate_stream_key_secret_refs_from_credentials(
    streaming: &mut StreamingSettings,
    credentials: &[PlatformAccountCredentials],
    mut get_secret: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    for target in streaming.targets.iter_mut().filter(|target| target.enabled) {
        if matches!(target.url_mode, Some(StreamUrlMode::FullUrl))
            && !target.server_url.trim().is_empty()
        {
            target.stream_key_present = true;
            continue;
        }
        if !target.stream_key.trim().is_empty() {
            target.stream_key_present = true;
            continue;
        }
        let credential = if target.auth_mode == StreamAuthMode::Oauth {
            credentials.iter().find(|credential| {
                credential.account.platform == target.platform
                    && target.account_id.as_deref().is_none_or(|account_id| {
                        credential.account.account_id == account_id
                            || credential.account.id == account_id
                    })
            })
        } else {
            None
        };
        let secret_ref = target
            .stream_key_secret_ref
            .clone()
            .or_else(|| credential.and_then(|credential| credential.stream_key_secret_ref.clone()));
        let Some(secret_ref) = secret_ref else {
            continue;
        };
        let stream_key = get_secret(&secret_ref)?;
        if !stream_key.trim().is_empty() {
            if matches!(target.url_mode, Some(StreamUrlMode::FullUrl)) {
                target.server_url = stream_key;
            } else {
                target.stream_key = stream_key;
            }
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
        drop(guard);
        let _ = crate::comment_highlight::clear_comment_highlight(&state).await;
        return Ok(idle_status());
    };

    let pid = active.pid;
    let output_path = active.output_path.clone();
    let session_id = active.session_id.clone();
    let wait_session_id = session_id.clone();
    let mut force_stop_now = false;
    active.stop_requested = true;
    if let Some(native_audio) = active.native_audio.as_ref() {
        native_audio.finish_recording_window();
    }
    active
        .pipeline
        .mark_finalizing("Waiting for FFmpeg to flush and close output files.");
    if let Some(encoder_bridge) = &active.encoder_bridge {
        if let Some(encoder_bridge_stream) = &active.encoder_bridge_stream {
            encoder_bridge_stream.stop();
        }
        encoder_bridge.stop();
    } else if let Some(mut stdin) = active.stdin.take() {
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
    // Keep recording -> highlight lock order aligned with set_comment_highlight:
    // once stop_requested is true, no late set can install a new card after
    // this authoritative clear.
    let _ =
        crate::comment_highlight::clear_comment_highlight_for_session_end(&state, &wait_session_id)
            .await;
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
            false,
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
    let mut command = Command::new(ffmpeg_path);
    command.args(mp4_export_args(input, output));
    let status = status_owned_tokio(&mut command)
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
        scene: None,
        captions: None,
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
    let mut command = ffmpeg_command(ffmpeg_path);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_tokio(&mut command)
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
            transport: PreviewTransport::LatestJpegPolling,
            backing: PreviewSurfaceBacking::None,
            target_fps: Some(IDLE_PREVIEW_FPS),
            width: Some(IDLE_PREVIEW_WIDTH),
            height: Some(IDLE_PREVIEW_HEIGHT),
            url: Some(live_preview_url(&state)),
            message: Some("Starting explicit JPEG polling fallback preview.".to_string()),
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
    let mut child = match spawn_owned_tokio(&mut command) {
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
        scene: None,
        captions: None,
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
    video.width = IDLE_PREVIEW_WIDTH;
    video.height = IDLE_PREVIEW_HEIGHT;
    video.fps = video.fps.clamp(24, 30);
    video.bitrate_kbps = video.bitrate_kbps.min(1500);
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
                transport: PreviewTransport::LatestJpegPolling,
                backing: PreviewSurfaceBacking::None,
                target_fps: Some(RECORDING_PREVIEW_FPS),
                width: Some(RECORDING_PREVIEW_WIDTH),
                height: Some(RECORDING_PREVIEW_HEIGHT),
                url: Some(live_preview_url(&state)),
                message: Some(
                    "Switching the explicit JPEG polling fallback to the recording session."
                        .to_string(),
                ),
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

async fn publish_recording_live_preview_status(
    state: &AppState,
    use_native_surface: bool,
    message: Option<String>,
) {
    let status = if use_native_surface {
        recording_native_surface_preview_status(state, message).await
    } else {
        recording_live_preview_status(state, message)
    };
    {
        let mut guard = state.live_preview.lock().await;
        guard.status = status.clone();
    }
    state.emit_event("preview.live.status", status);
}

async fn clear_latest_preview_frame(state: &AppState) {
    *state.preview_latest_frame.write().await = None;
    let mut metrics = state.preview_metrics.lock().await;
    metrics.last_presented_at = None;
    metrics.last_presented_sequence = None;
    metrics.present_fps = None;
    metrics.repeated_frames = 0;
}

async fn restart_idle_live_preview_if_desired(state: AppState) {
    let desired_params = {
        let mut guard = state.live_preview.lock().await;
        let desired_params = guard.desired_params.clone();
        if desired_params.is_some() {
            guard.status = PreviewLiveStatus {
                state: PreviewLiveState::Reconnecting,
                source: PreviewLiveSource::IdlePreview,
                transport: PreviewTransport::LatestJpegPolling,
                backing: PreviewSurfaceBacking::None,
                target_fps: Some(IDLE_PREVIEW_FPS),
                width: Some(IDLE_PREVIEW_WIDTH),
                height: Some(IDLE_PREVIEW_HEIGHT),
                url: Some(live_preview_url(&state)),
                message: Some("Restarting explicit JPEG polling fallback preview.".to_string()),
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
    let mut last_frame_at: Option<Instant> = None;
    let mut dropped_preview_frames = 0_u64;
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);

                while let Some(part) = drain_next_mjpeg_part(&mut pending) {
                    if let Some(jpeg) = jpeg_bytes_from_mjpeg_part(&part) {
                        let now = Instant::now();
                        let sequence = {
                            let mut metrics = state.preview_metrics.lock().await;
                            metrics.next_sequence = metrics.next_sequence.saturating_add(1);
                            metrics.next_sequence
                        };
                        *state.preview_latest_frame.write().await = Some(PreviewFrame {
                            sequence,
                            bytes: jpeg,
                            published_at: now,
                        });
                        if let Some(pid) = idle_pid {
                            mark_idle_live_preview_frame_received(&state, pid).await;
                        }
                        let preview_latency_ms = last_frame_at.map(|last_frame_at| {
                            now.saturating_duration_since(last_frame_at).as_millis() as u64
                        });
                        last_frame_at = Some(now);
                        update_preview_diagnostics(
                            &state,
                            preview_latency_ms,
                            dropped_preview_frames,
                            preview_target_fps_for_source(idle_pid),
                        )
                        .await;
                    }
                    let _ = state.preview_frames.send(part);
                }

                if pending.len() > MAX_PENDING_PREVIEW_BYTES {
                    dropped_preview_frames = dropped_preview_frames.saturating_add(1);
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

async fn update_preview_diagnostics(
    state: &AppState,
    preview_latency_ms: Option<u64>,
    preview_dropped_frames: u64,
    preview_target_fps: Option<f64>,
) {
    let scene_revision = current_compositor_scene_revision(state).await;
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let next = apply_active_scene_revision(
            apply_preview_stats(
                diagnostics.clone(),
                preview_latency_ms,
                preview_dropped_frames,
                preview_target_fps,
                PreviewTransport::LatestJpegPolling,
            ),
            scene_revision,
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

pub async fn update_preview_frame_age(
    state: &AppState,
    preview_sequence: u64,
    preview_frame_age_ms: u64,
) {
    let (preview_present_fps, preview_repeated_frames) = {
        let mut metrics = state.preview_metrics.lock().await;
        let now = Instant::now();
        let present_fps = metrics.last_presented_at.map(|last_presented_at| {
            1000.0
                / now
                    .saturating_duration_since(last_presented_at)
                    .as_millis()
                    .max(1) as f64
        });
        if metrics
            .last_presented_sequence
            .is_some_and(|last_sequence| last_sequence == preview_sequence)
        {
            metrics.repeated_frames = metrics.repeated_frames.saturating_add(1);
        }
        metrics.last_presented_at = Some(now);
        metrics.last_presented_sequence = Some(preview_sequence);
        metrics.present_fps = present_fps;
        (metrics.present_fps, metrics.repeated_frames)
    };
    let scene_revision = current_compositor_scene_revision(state).await;
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let next = apply_active_scene_revision(
            apply_preview_frame_age(
                diagnostics.clone(),
                preview_frame_age_ms,
                preview_present_fps,
                preview_repeated_frames,
            ),
            scene_revision,
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

async fn current_compositor_scene_revision(state: &AppState) -> Option<u64> {
    state.compositor.lock().await.status.scene_revision
}

fn preview_target_fps_for_source(idle_pid: Option<u32>) -> Option<f64> {
    Some(f64::from(if idle_pid.is_some() {
        IDLE_PREVIEW_FPS
    } else {
        RECORDING_PREVIEW_FPS
    }))
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
                transport: PreviewTransport::LatestJpegPolling,
                backing: PreviewSurfaceBacking::None,
                target_fps: Some(IDLE_PREVIEW_FPS),
                width: Some(IDLE_PREVIEW_WIDTH),
                height: Some(IDLE_PREVIEW_HEIGHT),
                url: Some(live_preview_url(state)),
                message: Some(
                    "Explicit JPEG polling fallback is active and receiving frames.".to_string(),
                ),
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

    if let Some(encoder_bridge) = &recording.encoder_bridge {
        if let Some(encoder_bridge_stream) = &recording.encoder_bridge_stream {
            encoder_bridge_stream.stop();
        }
        encoder_bridge.stop();
    } else if let Some(mut stdin) = recording.stdin.take() {
        let _ = stdin.write_all(b"q\n").await;
        let _ = stdin.shutdown().await;
    }
    if let Some(native_audio) = recording.native_audio.as_ref() {
        native_audio.finish_recording_window();
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
        transport: PreviewTransport::LatestJpegPolling,
        backing: PreviewSurfaceBacking::None,
        target_fps: Some(RECORDING_PREVIEW_FPS),
        width: Some(RECORDING_PREVIEW_WIDTH),
        height: Some(RECORDING_PREVIEW_HEIGHT),
        url: Some(live_preview_url(state)),
        message: Some(message.unwrap_or_else(|| {
            "Explicit JPEG polling fallback is following the active recording session.".to_string()
        })),
    }
}

async fn recording_native_surface_preview_status(
    state: &AppState,
    message: Option<String>,
) -> PreviewLiveStatus {
    let compositor = state.compositor.lock().await.status.clone();
    PreviewLiveStatus {
        state: if compositor.state == CompositorState::Live {
            PreviewLiveState::Live
        } else {
            PreviewLiveState::Connecting
        },
        source: PreviewLiveSource::RecordingSession,
        transport: PreviewTransport::ElectronProofSurface,
        backing: PreviewSurfaceBacking::ElectronBrowserWindow,
        target_fps: Some(compositor.target_fps),
        width: Some(compositor.width),
        height: Some(compositor.height),
        url: None,
        message: Some(message.unwrap_or_else(|| {
            "Preview is using the Electron proof compositor surface; JPEG/MJPEG fallback is inactive."
                .to_string()
        })),
    }
}

fn unavailable_live_preview_status(message: Option<String>) -> PreviewLiveStatus {
    PreviewLiveStatus {
        state: PreviewLiveState::Unavailable,
        source: PreviewLiveSource::Unavailable,
        transport: PreviewTransport::Unavailable,
        backing: PreviewSurfaceBacking::None,
        target_fps: None,
        width: None,
        height: None,
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

    let streaming = state
        .recording
        .lock()
        .await
        .as_ref()
        .is_some_and(|active| active.pid == pid && active.stream_url.is_some());
    sleep(if streaming {
        STOP_TERM_DELAY_STREAMING
    } else {
        STOP_TERM_DELAY
    })
    .await;

    if !recording_matches(&state, pid, &session_id, &output_path).await {
        return;
    }

    state.emit_log(
        "warn",
        "FFmpeg did not stop promptly after stdin quit command; sending SIGTERM.",
    );
    let _ = send_process_signal(pid, "TERM").await;
    stop_kill_fallback(state, pid, session_id, output_path, streaming).await;
}

async fn stop_kill_fallback(
    state: AppState,
    pid: u32,
    session_id: String,
    output_path: Option<PathBuf>,
    streaming: bool,
) {
    sleep(if streaming {
        STOP_KILL_DELAY_STREAMING
    } else {
        STOP_KILL_DELAY
    })
    .await;

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

/// What the post-recording quality gate (slice 8) needs to judge a finalized file:
/// the session's intended fps and whether an audio source was selected.
#[derive(Debug, Clone, Copy)]
struct PostRecordingGate {
    intended_fps: Option<f64>,
    expect_audio: bool,
}

/// Live mic-stats sampler: while this session is the active recording, periodically read
/// the CoreAudio capture counters and emit updated diagnostics, so `micCapturedFrames` /
/// `micDroppedFrames` and the derived capture-coverage gap signal update *during* the run
/// instead of only at stop. Exits as soon as the session is replaced or ends.
async fn sample_native_audio_during_recording(state: AppState, session_id: String) {
    let started_at = std::time::Instant::now();
    let mut ticker = tokio::time::interval(NATIVE_AUDIO_SAMPLE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut silent_mic_reported = false;
    loop {
        ticker.tick().await;
        let counters = {
            let recording = state.recording.lock().await;
            match recording.as_ref() {
                Some(active) if active.session_id == session_id => {
                    active.native_audio.as_ref().map(|audio| {
                        (
                            audio.captured_frames(),
                            audio.dropped_frames(),
                            audio.live_peak(),
                            audio.session_peak(),
                            audio.device_name.clone(),
                            audio.recording_window_elapsed_secs(),
                        )
                    })
                }
                _ => return,
            }
        };
        let Some((
            captured_frames,
            dropped_frames,
            live_peak,
            session_peak,
            device_name,
            capture_elapsed_secs,
        )) = counters
        else {
            return;
        };

        // Early truthful warning (plan 021 F3): a mic that has produced nothing
        // this deep into the recording will not fix itself — tell the user NOW,
        // while stopping and fixing still saves the take. A TCC-unauthorized
        // process receives silent zeros (frames count, peak stays 0), so both
        // "no frames" and "all-silence" trip the check. Fires at most once.
        if !silent_mic_reported
            && started_at.elapsed() >= MIC_SILENT_CHECK_AFTER
            && let Some(kind) = silent_mic_verdict(captured_frames, session_peak)
        {
            silent_mic_reported = true;
            let message = match kind {
                SilentMicKind::NoFrames => format!(
                    "Microphone \"{device_name}\" has not produced any audio since this session started — check the input device in Settings."
                ),
                SilentMicKind::AllSilence => format!(
                    "Microphone \"{device_name}\" is capturing only silence — if you just granted microphone access, quit and reopen Videorc."
                ),
            };
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Warn,
                "mic-silent",
                &message,
            );
        }
        let coverage = capture_elapsed_secs.and_then(|elapsed_secs| {
            audio_capture_coverage(captured_frames, elapsed_secs, NATIVE_AUDIO_SAMPLE_RATE)
        });
        let diagnostic_stats = {
            let mut diagnostics = state.diagnostics.lock().await;
            let next = apply_audio_stats(
                diagnostics.clone(),
                captured_frames,
                dropped_frames,
                coverage,
                Some(live_peak),
            );
            *diagnostics = next.clone();
            next
        };
        state.emit_event(
            "diagnostics.stats",
            apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
        );
    }
}

async fn final_session_diagnostics_snapshot(state: &AppState, session_id: &str) -> DiagnosticStats {
    let diagnostic_stats = {
        let diagnostics = state.diagnostics.lock().await;
        diagnostics.clone()
    };
    let mut snapshot =
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot());
    snapshot.session_id = Some(session_id.to_string());
    snapshot
}

async fn monitor_session(
    state: AppState,
    mut child: tokio::process::Child,
    session_id: String,
    output_path: Option<PathBuf>,
    gate: PostRecordingGate,
) {
    let status = child.wait().await;
    let finalizing_permit = state.ffmpeg_work.begin_finalizing();
    let mut guard = state.recording.lock().await;
    let monitored_recording = guard
        .as_ref()
        .filter(|active| active.session_id == session_id)
        .map(|active| {
            let native_audio_stats = active.native_audio.as_ref().map(|audio| {
                audio.finish_recording_window();
                NativeAudioStats {
                    device_name: audio.device_name.clone(),
                    captured_frames: audio.captured_frames(),
                    dropped_frames: audio.dropped_frames(),
                    session_peak: audio.session_peak(),
                }
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

    // Also cover provider/process exits that bypass an explicit stop RPC. The
    // session guard prevents this late monitor task from clearing a newer
    // session's card.
    let _ = crate::comment_highlight::clear_comment_highlight_for_session_end(&state, &session_id)
        .await;

    if let Some(native_audio_stats) = monitored_recording.native_audio_stats {
        let diagnostic_stats = {
            let mut diagnostics = state.diagnostics.lock().await;
            let next = apply_audio_stats(
                diagnostics.clone(),
                native_audio_stats.captured_frames,
                native_audio_stats.dropped_frames,
                None,
                // Session over: the live meter must fall silent, not freeze.
                None,
            );
            *diagnostics = next.clone();
            next
        };
        state.emit_event(
            "diagnostics.stats",
            apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
        );
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
        // Silent-mic verdict at finalize (plan 021 F3): the user must learn the
        // file has no sound from the app, not from playing it back.
        if let Some(kind) = silent_mic_verdict(
            native_audio_stats.captured_frames,
            native_audio_stats.session_peak,
        ) {
            let message = match kind {
                SilentMicKind::NoFrames => format!(
                    "Microphone \"{}\" captured no audio — this recording has a silent audio track. Check the input device in Settings.",
                    native_audio_stats.device_name
                ),
                SilentMicKind::AllSilence => format!(
                    "Microphone \"{}\" captured only silence — this recording has a silent audio track. If you just granted microphone access, quit and reopen Videorc.",
                    native_audio_stats.device_name
                ),
            };
            let _ = emit_health_event(
                &state,
                Some(&session_id),
                HealthLevel::Error,
                "mic-silent",
                &message,
            );
        }
    }

    let ended_at = Utc::now().to_rfc3339();
    let duration_ms = recording_duration_ms(&monitored_recording.started_at, &ended_at);
    let final_diagnostics = final_session_diagnostics_snapshot(&state, &session_id).await;
    match status {
        Ok(exit_status) if exit_status.success() || monitored_recording.stop_requested => {
            let message = if exit_status.success() {
                "Capture session finalized.".to_string()
            } else {
                format!("Capture session finalized after stop signal ({exit_status}).")
            };
            monitored_recording.pipeline.mark_finished();
            // Cloned before `session_id` is moved into the finalized status below, so the
            // post-recording quality gate can still reference this session.
            let gate_session_id = session_id.clone();
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
            // The Library describes the media file, not how long the record
            // button was active. A stalled encoder can produce a much shorter
            // timeline than wall time, so persist the probed finalized duration
            // and retain elapsed time only as a fallback when probing fails.
            let duration_ms = match mp4_path.as_ref().or(output_path.as_ref()) {
                Some(final_path) => crate::session_ops::probe_duration_ms(
                    &monitored_recording.ffmpeg_path,
                    final_path,
                )
                .await
                .or(duration_ms),
                None => duration_ms,
            };
            let _ = state.database.finish_session(
                &session_id,
                "completed",
                Some(ended_at),
                mp4_path.as_ref().map(|path| path.display().to_string()),
                duration_ms,
            );
            let _ = state
                .database
                .save_session_diagnostics(&session_id, &final_diagnostics);
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
            // Slice 8: check (and, if needed, repair in place) the finalized file off
            // the hot path. The recording is already marked complete; the gate only ever
            // replaces the visible file with a validated better version, keeping a backup.
            if let Some(final_path) = mp4_path.clone().or(output_path.clone()) {
                // Aligned captions (burn-in plan B2/B3): drain this session's
                // live caption chunks into an .srt sidecar, then queue the
                // idle-time captioned copy from the same chunks.
                let caption_chunks =
                    crate::captions::write_caption_artifacts(&state, &gate_session_id, &final_path)
                        .await;
                if !caption_chunks.is_empty() {
                    crate::captions::begin_caption_cue_render(
                        &state,
                        &gate_session_id,
                        &monitored_recording.ffmpeg_path,
                        &final_path,
                        &caption_chunks,
                    )
                    .await;
                }
                // Library poster (L2): one thumbnail frame per recording,
                // extracted off the hot path under the idle ffmpeg permit.
                {
                    let poster_state = state.clone();
                    let poster_session_id = gate_session_id.clone();
                    let poster_path = final_path.display().to_string();
                    let poster_ffmpeg = monitored_recording.ffmpeg_path.clone();
                    tokio::spawn(async move {
                        crate::posters::ensure_session_poster(
                            &poster_state,
                            &poster_session_id,
                            &poster_path,
                            duration_ms,
                            &poster_ffmpeg,
                        )
                        .await;
                    });
                }
                enqueue_post_recording_gate(
                    state.clone(),
                    gate_session_id,
                    monitored_recording.ffmpeg_path.clone(),
                    final_path,
                    gate,
                );
            }
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
            let _ = state
                .database
                .save_session_diagnostics(&session_id, &final_diagnostics);
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
            let _ = state
                .database
                .save_session_diagnostics(&session_id, &final_diagnostics);
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
    drop(finalizing_permit);

    restart_idle_live_preview_if_desired(state).await;
}

/// Queues the post-recording quality gate through the idle-only maintenance coordinator.
/// The job is persisted immediately, but FFmpeg analysis/repair only starts after capture
/// and finalization are idle.
fn enqueue_post_recording_gate(
    state: AppState,
    session_id: String,
    ffmpeg_path: String,
    final_path: PathBuf,
    gate: PostRecordingGate,
) {
    tokio::spawn(async move {
        let path_str = final_path.display().to_string();
        let expectations = QualityExpectations {
            intended_fps: gate.intended_fps,
            expect_audio: gate.expect_audio,
        };
        let mut job = RepairJob::pending(
            Uuid::new_v4().to_string(),
            path_str.clone(),
            &expectations,
            Utc::now().to_rfc3339(),
        );
        let _ = state.database.upsert_repair_job(&job);

        state.emit_log(
            "info",
            format!("Queued post-recording quality check for {path_str}."),
        );

        sleep(POST_RECORDING_GATE_IDLE_DELAY).await;
        let _maintenance = state.ffmpeg_work.begin_maintenance_when_idle().await;
        let cancel_token = _maintenance.cancel_token();
        job.mark_running(Utc::now().to_rfc3339());
        let _ = state.database.upsert_repair_job(&job);

        state.emit_log(
            "info",
            format!("Running idle post-recording quality check on {path_str}."),
        );

        let fast_assessment = timeout(
            POST_RECORDING_FAST_ASSESSMENT_TIMEOUT,
            run_quality_assessment(
                ffmpeg_path.clone(),
                path_str.clone(),
                expectations,
                cancel_token.clone(),
            ),
        )
        .await
        .map_err(|_| {
            format!(
                "quality assessment timed out after {}s",
                POST_RECORDING_FAST_ASSESSMENT_TIMEOUT.as_secs()
            )
        })
        .and_then(|result| result);

        let should_attempt_repair = match fast_assessment {
            Ok(status @ GateStatus::Ready { .. }) | Ok(status @ GateStatus::Failed { .. }) => {
                job.complete_with_gate(&status, Utc::now().to_rfc3339());
                let _ = state.database.upsert_repair_job(&job);
                emit_gate_health(&state, Some(&session_id), &status);
                return;
            }
            Ok(status @ GateStatus::NotHundredPercent { .. }) => {
                record_running_quality_snapshot(&mut job, &status, Utc::now().to_rfc3339());
                let _ = state.database.upsert_repair_job(&job);
                emit_gate_health(&state, Some(&session_id), &status);
                true
            }
            Ok(status @ GateStatus::Repaired { .. }) => {
                job.complete_with_gate(&status, Utc::now().to_rfc3339());
                let _ = state.database.upsert_repair_job(&job);
                emit_gate_health(&state, Some(&session_id), &status);
                return;
            }
            Err(error) if error.contains(MAINTENANCE_CANCELLED) => {
                job.defer(
                    "quality check deferred because capture started".to_string(),
                    Utc::now().to_rfc3339(),
                );
                let _ = state.database.upsert_repair_job(&job);
                return;
            }
            Err(error) => {
                state.emit_log(
                    "warn",
                    format!("Fast post-recording quality assessment could not run: {error}"),
                );
                job.fail(
                    format!("quality assessment task failed: {error}"),
                    Utc::now().to_rfc3339(),
                );
                let _ = state.database.upsert_repair_job(&job);
                let failed = GateStatus::Failed {
                    path: path_str.clone(),
                    reason: error,
                };
                emit_gate_health(&state, Some(&session_id), &failed);
                return;
            }
        };

        if !should_attempt_repair {
            return;
        }

        match timeout(
            POST_RECORDING_REPAIR_TIMEOUT,
            run_quality_gate(ffmpeg_path, path_str, expectations, cancel_token),
        )
        .await
        .map_err(|_| {
            format!(
                "quality repair timed out after {}s",
                POST_RECORDING_REPAIR_TIMEOUT.as_secs()
            )
        })
        .and_then(|result| result)
        {
            Ok(status) => {
                let changed = job.outcome.as_ref() != serde_json::to_value(&status).ok().as_ref();
                job.complete_with_gate(&status, Utc::now().to_rfc3339());
                let _ = state.database.upsert_repair_job(&job);
                if changed {
                    emit_gate_health(&state, Some(&session_id), &status);
                }
            }
            Err(error) if error.contains(MAINTENANCE_CANCELLED) => {
                job.defer(
                    "quality check deferred because capture started".to_string(),
                    Utc::now().to_rfc3339(),
                );
            }
            Err(error) => {
                state.emit_log(
                    "warn",
                    format!("Post-recording quality check could not run: {error}"),
                );
                job.fail(
                    format!("quality check task failed: {error}"),
                    Utc::now().to_rfc3339(),
                );
                let failed = GateStatus::Failed {
                    path: job.file_path.clone(),
                    reason: error,
                };
                emit_gate_health(&state, Some(&session_id), &failed);
            }
        }
        let _ = state.database.upsert_repair_job(&job);
    });
}

/// Runs the strict read-only quality assessment on a blocking thread so the app can
/// surface a fast verdict before any slower repair/interpolation work starts.
async fn run_quality_assessment(
    ffmpeg_path: String,
    file_path: String,
    expectations: QualityExpectations,
    cancel_token: MaintenanceCancelToken,
) -> std::result::Result<GateStatus, String> {
    tokio::task::spawn_blocking(move || {
        let ffprobe_path = ffprobe_path_for(&ffmpeg_path);
        let path = file_path.clone();
        let is_cancelled = || cancel_token.is_cancelled();
        let status = match analyze_recording_cancellable(
            &ffmpeg_path,
            &ffprobe_path,
            &file_path,
            &QualityThresholds::default(),
            &expectations,
            &is_cancelled,
        ) {
            Ok((_, report)) if report.verdict == QualityVerdict::Clean => {
                GateStatus::Ready { path }
            }
            Ok((_, report)) => GateStatus::NotHundredPercent {
                path,
                reasons: issue_reasons(&report.issues),
                needs_attention: has_user_impacting_issue(&report.issues),
            },
            Err(reason) if reason.contains(MAINTENANCE_CANCELLED) => {
                return Err(MAINTENANCE_CANCELLED.to_string());
            }
            Err(reason) => GateStatus::Failed { path, reason },
        };
        if is_cancelled() {
            Err(MAINTENANCE_CANCELLED.to_string())
        } else {
            Ok(status)
        }
    })
    .await
    .map_err(|error| format!("quality assessment task failed: {error}"))?
}

fn record_running_quality_snapshot(job: &mut RepairJob, status: &GateStatus, now: String) {
    job.outcome = serde_json::to_value(status).ok();
    job.reason = None;
    job.updated_at = now;
}

/// Runs the (blocking) quality gate for a file on a blocking thread so it never stalls
/// the async runtime.
async fn run_quality_gate(
    ffmpeg_path: String,
    file_path: String,
    expectations: QualityExpectations,
    cancel_token: MaintenanceCancelToken,
) -> std::result::Result<GateStatus, String> {
    tokio::task::spawn_blocking(move || {
        let ffprobe_path = ffprobe_path_for(&ffmpeg_path);
        let is_cancelled = || cancel_token.is_cancelled();
        let status = gate_recording_cancellable(
            &ffmpeg_path,
            &ffprobe_path,
            &file_path,
            &QualityThresholds::default(),
            &expectations,
            &is_cancelled,
        );
        if is_cancelled()
            || matches!(&status, GateStatus::Failed { reason, .. } if reason.contains(MAINTENANCE_CANCELLED))
        {
            Err(MAINTENANCE_CANCELLED.to_string())
        } else {
            Ok(status)
        }
    })
    .await
    .map_err(|error| format!("quality check task failed: {error}"))?
}

/// Emits the health event that matches a gate verdict (passed / repaired / not 100% /
/// check failed). `session_id` is `None` for resume runs, which have no live session.
///
/// Level policy (toast-noise plan): the renderer only toasts warn/error-level quality
/// events, so warn is reserved for verdicts a user would notice and can act on (a
/// missing stream). Analyzer residuals and internal tooling failures stay info-level
/// records for the Library row, session log, and Diagnostics.
fn emit_gate_health(state: &AppState, session_id: Option<&str>, status: &GateStatus) {
    match status {
        GateStatus::Ready { .. } => {
            let _ = emit_health_event(
                state,
                session_id,
                HealthLevel::Info,
                "recording-quality-passed",
                "Recording passed the automated quality check.",
            );
        }
        GateStatus::Repaired { interpolated, .. } => {
            let message = if *interpolated {
                "Recording was automatically repaired (interpolated frames)."
            } else {
                "Recording was automatically repaired to pass the quality check."
            };
            let _ = emit_health_event(
                state,
                session_id,
                HealthLevel::Info,
                "recording-quality-repaired",
                message,
            );
        }
        GateStatus::NotHundredPercent {
            reasons,
            needs_attention,
            ..
        } => {
            let message = format!(
                "Recording could not be brought to 100%: {}",
                reasons.join("; ")
            );
            let level = if *needs_attention {
                HealthLevel::Warn
            } else {
                HealthLevel::Info
            };
            let _ = emit_health_event(
                state,
                session_id,
                level,
                "recording-quality-not-100",
                &message,
            );
        }
        GateStatus::Failed { path, reason } => {
            // An internal tooling failure, not a broken recording: the file is
            // untouched and usually fine. The raw reason (often ffmpeg stderr)
            // goes to the app log for support bundles; the user-visible record
            // gets plain language and stays info-level so it never toasts.
            let mut detail = reason.clone();
            const MAX_LOGGED_REASON: usize = 600;
            if detail.len() > MAX_LOGGED_REASON {
                let cut = (0..=MAX_LOGGED_REASON)
                    .rev()
                    .find(|index| detail.is_char_boundary(*index))
                    .unwrap_or(0);
                detail.truncate(cut);
                detail.push('…');
            }
            state.emit_log(
                "warn",
                format!("Post-recording quality check failed for {path}: {detail}"),
            );
            let _ = emit_health_event(
                state,
                session_id,
                HealthLevel::Info,
                "recording-quality-check-failed",
                "Automatic quality check could not run on this recording. The file is untouched.",
            );
        }
    }
}

/// On launch, queues any repair jobs left unfinished (pending or running) when the app
/// last quit. FFmpeg work still waits for the idle-only maintenance coordinator, so
/// startup never races the user's first capture.
pub async fn resume_pending_repair_jobs(state: AppState) {
    let jobs = match state.database.incomplete_repair_jobs() {
        Ok(jobs) => jobs,
        Err(error) => {
            state.emit_log(
                "warn",
                format!("Could not load repair jobs to resume: {error}"),
            );
            return;
        }
    };
    if jobs.is_empty() {
        return;
    }

    let mut resumable_jobs = Vec::new();
    let mut stale_count = 0usize;
    for mut job in jobs {
        if let Some(reason) = stale_repair_job_reason(&job) {
            job.cancel_with_reason(reason, Utc::now().to_rfc3339());
            let _ = state.database.upsert_repair_job(&job);
            stale_count += 1;
        } else {
            resumable_jobs.push(job);
        }
    }

    if stale_count > 0 {
        state.emit_log(
            "info",
            format!("Skipped {stale_count} stale interrupted repair job(s)."),
        );
    }

    if resumable_jobs.is_empty() {
        return;
    }

    state.emit_log(
        "info",
        format!("Queued {} interrupted repair job(s).", resumable_jobs.len()),
    );
    let ffmpeg_path = resolve_ffmpeg_path(None);

    for mut job in resumable_jobs {
        let state = state.clone();
        let ffmpeg_path = ffmpeg_path.clone();
        tokio::spawn(async move {
            sleep(POST_RECORDING_GATE_IDLE_DELAY).await;
            let _maintenance = state.ffmpeg_work.begin_maintenance_when_idle().await;
            let cancel_token = _maintenance.cancel_token();
            job.mark_running(Utc::now().to_rfc3339());
            let _ = state.database.upsert_repair_job(&job);

            let fast_assessment = timeout(
                POST_RECORDING_FAST_ASSESSMENT_TIMEOUT,
                run_quality_assessment(
                    ffmpeg_path.clone(),
                    job.file_path.clone(),
                    job.expectations(),
                    cancel_token.clone(),
                ),
            )
            .await
            .map_err(|_| {
                format!(
                    "quality assessment timed out after {}s",
                    POST_RECORDING_FAST_ASSESSMENT_TIMEOUT.as_secs()
                )
            })
            .and_then(|result| result);

            let should_attempt_repair = match fast_assessment {
                Ok(status @ GateStatus::Ready { .. }) | Ok(status @ GateStatus::Failed { .. }) => {
                    job.complete_with_gate(&status, Utc::now().to_rfc3339());
                    let _ = state.database.upsert_repair_job(&job);
                    emit_gate_health(&state, None, &status);
                    return;
                }
                Ok(status @ GateStatus::NotHundredPercent { .. }) => {
                    record_running_quality_snapshot(&mut job, &status, Utc::now().to_rfc3339());
                    let _ = state.database.upsert_repair_job(&job);
                    emit_gate_health(&state, None, &status);
                    true
                }
                Ok(status @ GateStatus::Repaired { .. }) => {
                    job.complete_with_gate(&status, Utc::now().to_rfc3339());
                    let _ = state.database.upsert_repair_job(&job);
                    emit_gate_health(&state, None, &status);
                    return;
                }
                Err(error) if error.contains(MAINTENANCE_CANCELLED) => {
                    job.defer(
                        "repair job deferred because capture started".to_string(),
                        Utc::now().to_rfc3339(),
                    );
                    let _ = state.database.upsert_repair_job(&job);
                    return;
                }
                Err(error) => {
                    state.emit_log(
                        "warn",
                        format!(
                            "Could not resume quality assessment for {}: {error}",
                            job.file_path
                        ),
                    );
                    job.fail(
                        format!("resume assessment failed: {error}"),
                        Utc::now().to_rfc3339(),
                    );
                    let failed = GateStatus::Failed {
                        path: job.file_path.clone(),
                        reason: error,
                    };
                    emit_gate_health(&state, None, &failed);
                    let _ = state.database.upsert_repair_job(&job);
                    return;
                }
            };

            if !should_attempt_repair {
                return;
            }

            let gate = timeout(
                POST_RECORDING_REPAIR_TIMEOUT,
                run_quality_gate(
                    ffmpeg_path,
                    job.file_path.clone(),
                    job.expectations(),
                    cancel_token,
                ),
            )
            .await
            .map_err(|_| {
                format!(
                    "quality repair timed out after {}s",
                    POST_RECORDING_REPAIR_TIMEOUT.as_secs()
                )
            })
            .and_then(|result| result);
            match gate {
                Ok(status) => {
                    let changed =
                        job.outcome.as_ref() != serde_json::to_value(&status).ok().as_ref();
                    job.complete_with_gate(&status, Utc::now().to_rfc3339());
                    let _ = state.database.upsert_repair_job(&job);
                    if changed {
                        emit_gate_health(&state, None, &status);
                    }
                }
                Err(error) if error.contains(MAINTENANCE_CANCELLED) => {
                    job.defer(
                        "repair job deferred because capture started".to_string(),
                        Utc::now().to_rfc3339(),
                    );
                }
                Err(error) => {
                    state.emit_log(
                        "warn",
                        format!("Could not resume repair for {}: {error}", job.file_path),
                    );
                    job.fail(
                        format!("resume task failed: {error}"),
                        Utc::now().to_rfc3339(),
                    );
                    let failed = GateStatus::Failed {
                        path: job.file_path.clone(),
                        reason: error,
                    };
                    emit_gate_health(&state, None, &failed);
                }
            }
            let _ = state.database.upsert_repair_job(&job);
        });
    }
}

fn stale_repair_job_reason(job: &RepairJob) -> Option<String> {
    let path = Path::new(&job.file_path);
    if !path.exists() {
        return Some(format!(
            "stale repair job skipped because {} is missing",
            job.file_path
        ));
    }
    if is_temp_smoke_repair_path(path, &job.file_path) {
        return Some(format!(
            "stale repair job skipped because {} is temporary smoke output",
            job.file_path
        ));
    }
    None
}

fn is_temp_smoke_repair_path(path: &Path, rendered: &str) -> bool {
    path.starts_with(std::env::temp_dir())
        && rendered.contains("videorc-")
        && rendered.contains("smoke")
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
    session_peak: f32,
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
struct StreamTarget {
    url: String,
    redacted_url: String,
    target_id: String,
    platform: StreamPlatform,
    label: String,
    output_video: Option<VideoSettings>,
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
    let microphone = resolve_microphone_input(params.sources.microphone_id.as_deref());

    // Camera-only makes the camera the primary input. No screen is enumerated or
    // captured, so macOS Screen Recording permission is never requested.
    if matches!(params.layout.layout_preset, LayoutPreset::CameraOnly) {
        let primary_camera =
            resolve_primary_camera_video_input(ffmpeg_path, params.sources.camera_id.as_deref())
                .await;
        return CaptureInputs {
            video: primary_camera.unwrap_or(VideoInput::TestPattern),
            camera_index: None,
            microphone,
        };
    }

    let has_real_screen_source =
        params.sources.screen_id.is_some() || params.sources.window_id.is_some();
    let selected_screen = if params.sources.test_pattern && !has_real_screen_source {
        None
    } else {
        resolve_primary_screen_video_input(ffmpeg_path, params.sources.screen_id.as_deref()).await
    };
    // Screen-only intentionally skips the camera overlay so no camera permission
    // is requested.
    let camera_index = if matches!(params.layout.layout_preset, LayoutPreset::ScreenOnly) {
        None
    } else {
        resolve_camera_input(ffmpeg_path, params.sources.camera_id.as_deref()).await
    };
    let detected_screen = if let Some(selected_screen) = selected_screen {
        Some(selected_screen)
    } else if cfg!(target_os = "macos") && (!params.sources.test_pattern || has_real_screen_source)
    {
        find_avfoundation_screen_index(ffmpeg_path)
            .await
            .map(|index| VideoInput::MacScreen { index })
    } else {
        None
    };

    CaptureInputs {
        video: detected_screen.unwrap_or(VideoInput::TestPattern),
        camera_index,
        microphone,
    }
}

async fn duplicate_capture_sources_for_capture(
    state: &AppState,
    capture: &CaptureInputs,
) -> Vec<String> {
    let camera_status = state.preview_camera.lock().await.status.clone();
    let screen_status = state.preview_screen.lock().await.status.clone();
    duplicate_capture_sources_for_statuses(
        capture,
        camera_status.state,
        camera_status.camera_id.as_deref(),
        screen_status.state,
        screen_status.source_kind,
        screen_status.source_id.as_deref(),
    )
}

fn duplicate_capture_sources_for_statuses(
    capture: &CaptureInputs,
    camera_state: PreviewCameraState,
    camera_id: Option<&str>,
    screen_state: PreviewScreenState,
    screen_source_kind: Option<PreviewScreenSourceKind>,
    screen_source_id: Option<&str>,
) -> Vec<String> {
    let mut sources = Vec::new();
    let recording_uses_camera = capture.camera_index.is_some()
        || matches!(
            capture.video,
            VideoInput::MacCamera { .. } | VideoInput::WindowsCamera { .. }
        );
    let recording_uses_screen = matches!(
        capture.video,
        VideoInput::MacScreen { .. } | VideoInput::WindowsScreen { .. }
    );

    if recording_uses_camera && camera_state == PreviewCameraState::Live {
        let source_id = camera_id.unwrap_or("unknown");
        sources.push(duplicate_capture_source_label("camera", source_id));
    }
    if recording_uses_screen && screen_state == PreviewScreenState::Live {
        let source_kind = match screen_source_kind {
            Some(PreviewScreenSourceKind::Screen) => "screen",
            Some(PreviewScreenSourceKind::Window) => "window",
            None => "screen",
        };
        let source_id = screen_source_id.unwrap_or("unknown");
        sources.push(duplicate_capture_source_label(source_kind, source_id));
    }

    sources
}

fn duplicate_capture_source_label(kind: &str, source_id: &str) -> String {
    if source_id.starts_with(&format!("{kind}:")) {
        source_id.to_string()
    } else {
        format!("{kind}:{source_id}")
    }
}

fn resolve_microphone_input(microphone_id: Option<&str>) -> Option<MicrophoneInput> {
    let microphone_id = microphone_id?;
    parse_coreaudio_microphone_id(microphone_id)
        .map(|device_id| MicrophoneInput::CoreAudio {
            device_id,
            fifo_path: None,
        })
        .or_else(|| {
            parse_avfoundation_id(microphone_id)
                .map(|index| MicrophoneInput::AvFoundation { index })
        })
        .or_else(|| {
            parse_windows_dshow_microphone_id(microphone_id)
                .map(|device_name| MicrophoneInput::WindowsDshow { device_name })
        })
}

async fn resolve_primary_camera_video_input(
    ffmpeg_path: &str,
    camera_id: Option<&str>,
) -> Option<VideoInput> {
    let camera_id = camera_id?;
    if let Some(index) = parse_avfoundation_id(camera_id) {
        return Some(VideoInput::MacCamera { index });
    }
    if let Some(device_name) = parse_windows_dshow_camera_id(camera_id) {
        return Some(VideoInput::WindowsCamera { device_name });
    }

    let camera_name = native_camera_name_for_id(camera_id)?;
    find_avfoundation_camera_index(ffmpeg_path, &camera_name)
        .await
        .map(|index| VideoInput::MacCamera { index })
}

async fn resolve_camera_input(ffmpeg_path: &str, camera_id: Option<&str>) -> Option<usize> {
    let camera_id = camera_id?;
    if let Some(index) = parse_avfoundation_id(camera_id) {
        return Some(index);
    }

    let camera_name = native_camera_name_for_id(camera_id)?;
    find_avfoundation_camera_index(ffmpeg_path, &camera_name).await
}

async fn resolve_primary_screen_video_input(
    ffmpeg_path: &str,
    screen_id: Option<&str>,
) -> Option<VideoInput> {
    let screen_id = screen_id?;
    if let Some(index) = parse_avfoundation_id(screen_id) {
        return Some(VideoInput::MacScreen { index });
    }

    if let Some(output_index) = parse_windows_dxgi_output_index(screen_id) {
        return Some(VideoInput::WindowsScreen {
            backend: WindowsScreenCaptureBackend::Ddagrab { output_index },
        });
    }

    if is_windows_gdigrab_desktop_screen_id(screen_id) {
        return Some(VideoInput::WindowsScreen {
            backend: WindowsScreenCaptureBackend::GdiGrabDesktop,
        });
    }

    if parse_screencapturekit_display_id(screen_id).is_some() {
        return find_avfoundation_screen_index_for_native_display_id(ffmpeg_path, screen_id)
            .await
            .map(|index| VideoInput::MacScreen { index });
    }

    None
}

/// Maximum time to wait for the microphone to warm up before starting the video pipeline.
const MICROPHONE_WARMUP_TIMEOUT: Duration = Duration::from_millis(1500);
/// Maximum time to wait for fresh target-resolution compositor frames before encoding.
const RECORDING_STARTUP_BARRIER_TIMEOUT: Duration = Duration::from_millis(2500);
/// Consecutive target-resolution real-source compositor frames required before encoding.
const RECORDING_STARTUP_BARRIER_MIN_FRAMES: u32 = 3;
/// How many frame intervals the startup barrier allows between consecutive
/// accepted compositor publishes. macOS Metal stays near the interval; Windows
/// CPU compose + dshow delivery routinely lands 100–180ms gaps at session start
/// (on-box: 130ms then 172ms over earlier 71ms/150ms budgets), so non-macOS uses
/// a looser factor (~200ms at 30fps) plus a floor. Stalled pipelines still fail
/// at multi-hundred-ms.
#[cfg(target_os = "macos")]
const RECORDING_STARTUP_CADENCE_FRAME_INTERVAL_FACTOR: f64 = 2.1;
#[cfg(not(target_os = "macos"))]
const RECORDING_STARTUP_CADENCE_FRAME_INTERVAL_FACTOR: f64 = 6.0;
/// Windows compose/dshow startup gaps are often wall-clock-bound rather than
/// pure multiples of the target frame interval; keep a hard floor so 60fps
/// sessions do not inherit an unrealistically tight cadence budget.
#[cfg(not(target_os = "macos"))]
const RECORDING_STARTUP_CADENCE_MIN_FRAME_GAP: Duration = Duration::from_millis(200);
const RECORDING_CAMERA_CADENCE_READY_TIMEOUT: Duration = Duration::from_millis(3000);
const RECORDING_CAMERA_CADENCE_READY_POLL: Duration = Duration::from_millis(25);
const RECORDING_CAMERA_CADENCE_FRAME_INTERVAL_FACTOR: f64 = 2.1;
const RECORDING_CAMERA_CADENCE_MAX_FRAME_AGE_MS: u64 = 250;
// The FFmpeg/dshow callback cadence (Windows) is jitterier than AVFoundation's
// sample-PTS cadence, so its readiness budget is more generous: the compositor
// absorbs occasional camera hitches, and frame freshness already proves the
// stream is live. ~140ms p95 at 30fps still catches a genuinely stalled camera.
const RECORDING_CAMERA_CADENCE_CALLBACK_BUDGET_FACTOR: f64 = 2.0;
const RECORDING_ENCODER_BRIDGE_SOURCE_READY_TIMEOUT: Duration = Duration::from_millis(750);
const RECORDING_ENCODER_BRIDGE_SOURCE_READY_POLL: Duration = Duration::from_millis(25);

/// Wait for CoreAudio to deliver its first callback (the mic-warmed-up signal) before the
/// video pipeline starts, so audio and video begin in lockstep instead of the audio
/// trailing the picture by the AudioUnit startup latency. Degrades gracefully — proceeds
/// after the timeout if the mic never warms up — so a flaky mic never blocks recording.
async fn await_microphone_warmup(state: &AppState, stats: Arc<AudioCaptureStats>) -> bool {
    let started_at = std::time::Instant::now();
    while stats.captured_frames() == 0 {
        if started_at.elapsed() >= MICROPHONE_WARMUP_TIMEOUT {
            state.emit_log(
                "warn",
                "Microphone did not warm up before the timeout; audio may start slightly late.",
            );
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    state.emit_log(
        "info",
        format!(
            "Microphone warmed up in {}ms; starting video aligned to audio.",
            started_at.elapsed().as_millis()
        ),
    );
    true
}

async fn await_recording_startup_barrier(
    state: &AppState,
    session_id: &str,
    width: u32,
    height: u32,
    target_fps: u32,
    required_scene_revision: Option<u64>,
    requirements: CompositorStartupSourceRequirements,
) -> Result<CompositorStartupBarrierResult> {
    publish_recording_startup_barrier_diagnostics(
        state,
        "waiting",
        &CompositorStartupBarrierResult {
            ready: false,
            wait_ms: 0,
            frames_observed: 0,
            first_source_frame_ms: None,
            first_full_resolution_frame_ms: None,
            timeout_reason: None,
        },
        None,
    )
    .await;

    let max_frame_gap = recording_startup_frame_gap_budget(target_fps);
    let result = wait_for_compositor_startup_frames(
        state,
        CompositorStartupBarrierParams {
            width,
            height,
            required_scene_revision,
            min_consecutive_frames: RECORDING_STARTUP_BARRIER_MIN_FRAMES,
            max_frame_gap: Some(max_frame_gap),
            timeout: RECORDING_STARTUP_BARRIER_TIMEOUT,
            requirements,
        },
    )
    .await;

    if result.ready {
        publish_recording_startup_barrier_diagnostics(state, "ready", &result, None).await;
        let _ = emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "recording-startup-barrier-ready",
            &format!(
                "Recording startup waited {}ms for {} fresh {}x{} compositor frame(s) with frame gaps at or below {}ms.",
                result.wait_ms,
                result.frames_observed,
                width,
                height,
                max_frame_gap.as_millis()
            ),
        );
        return Ok(result);
    }

    publish_recording_startup_barrier_diagnostics(state, "timed-out", &result, None).await;
    let reason = result
        .timeout_reason
        .clone()
        .unwrap_or_else(|| "compositor did not produce ready frames".to_string());
    let message = format!("Recording startup blocked before encoding: {reason}.");
    let _ = emit_health_event(
        state,
        Some(session_id),
        HealthLevel::Error,
        "recording-startup-barrier-timeout",
        &message,
    );
    bail!(message)
}

async fn await_recording_camera_cadence_ready(
    state: &AppState,
    session_id: &str,
    target_fps: u32,
    requirements: CompositorStartupSourceRequirements,
) -> Result<()> {
    if !requirements.require_camera_source {
        return Ok(());
    }

    reset_preview_camera_capture_timings(state).await;
    let started_at = Instant::now();
    let threshold_ms = camera_cadence_ready_threshold_ms(target_fps);

    loop {
        let (sample_pts_gap_p95_ms, callback_gap_p95_ms, frame_age_ms) = {
            let diagnostics = state.diagnostics.lock().await;
            (
                diagnostics.preview_camera_sample_pts_gap_p95_ms,
                diagnostics.preview_camera_capture_gap_p95_ms,
                diagnostics.preview_camera_frame_age_ms,
            )
        };

        if camera_cadence_ready(
            sample_pts_gap_p95_ms,
            callback_gap_p95_ms,
            frame_age_ms,
            threshold_ms,
        ) {
            let _ = emit_health_event(
                state,
                Some(session_id),
                HealthLevel::Info,
                "recording-camera-cadence-ready",
                &format!(
                    "Camera cadence settled before recording start: sample PTS p95 {} (threshold {:.0}ms), callback p95 {}, frame age {}.",
                    optional_ms(sample_pts_gap_p95_ms),
                    threshold_ms,
                    optional_ms(callback_gap_p95_ms),
                    optional_u64_ms(frame_age_ms)
                ),
            );
            return Ok(());
        }

        if started_at.elapsed() >= RECORDING_CAMERA_CADENCE_READY_TIMEOUT {
            let message = format!(
                "Recording startup blocked before encoding: camera sample PTS cadence did not settle (sample PTS p95 {}, threshold {:.0}ms, callback p95 {}, frame age {}).",
                optional_ms(sample_pts_gap_p95_ms),
                threshold_ms,
                optional_ms(callback_gap_p95_ms),
                optional_u64_ms(frame_age_ms)
            );
            let _ = emit_health_event(
                state,
                Some(session_id),
                HealthLevel::Error,
                "recording-camera-cadence-timeout",
                &message,
            );
            bail!(message);
        }

        sleep(RECORDING_CAMERA_CADENCE_READY_POLL).await;
    }
}

fn camera_cadence_ready(
    sample_pts_gap_p95_ms: Option<f64>,
    callback_gap_p95_ms: Option<f64>,
    frame_age_ms: Option<u64>,
    threshold_ms: f64,
) -> bool {
    let frames_fresh =
        frame_age_ms.is_some_and(|age| age <= RECORDING_CAMERA_CADENCE_MAX_FRAME_AGE_MS);
    if !frames_fresh {
        return false;
    }

    match sample_pts_gap_p95_ms.filter(|gap| gap.is_finite()) {
        // macOS AVFoundation native capture reports per-sample presentation
        // timestamps, so we gate on that precise cadence.
        Some(gap) => gap <= threshold_ms,
        // The FFmpeg-fed path (Windows dshow) delivers raw frames with no
        // per-sample PTS, so `sample_pts_gap` is never measured — the old gate
        // could never pass and blocked every recording. The compositor reads
        // the frame store on its own clock and repeats the last frame across a
        // camera hitch, so readiness here is a SUSTAINED, fresh stream: a
        // measured callback cadence within a lenient budget (dshow jitter runs
        // higher than AVFoundation) plus a recent frame (checked above).
        None => callback_gap_p95_ms.is_some_and(|gap| {
            gap.is_finite() && gap <= threshold_ms * RECORDING_CAMERA_CADENCE_CALLBACK_BUDGET_FACTOR
        }),
    }
}

fn camera_cadence_ready_threshold_ms(target_fps: u32) -> f64 {
    1000.0 / f64::from(target_fps.max(1)) * RECORDING_CAMERA_CADENCE_FRAME_INTERVAL_FACTOR
}

fn recording_startup_frame_gap_budget(target_fps: u32) -> Duration {
    let frame_interval_ms =
        1000.0 / f64::from(target_fps.max(1)) * RECORDING_STARTUP_CADENCE_FRAME_INTERVAL_FACTOR;
    let budget = Duration::from_millis(frame_interval_ms.ceil() as u64);
    // Exactly one arm survives cfg-stripping and becomes the tail expression;
    // `return` here would trip clippy::needless_return on that platform.
    #[cfg(not(target_os = "macos"))]
    {
        budget.max(RECORDING_STARTUP_CADENCE_MIN_FRAME_GAP)
    }
    #[cfg(target_os = "macos")]
    {
        budget
    }
}

fn optional_ms(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map(|value| format!("{value:.1}ms"))
        .unwrap_or_else(|| "n/a".to_string())
}

fn optional_u64_ms(value: Option<u64>) -> String {
    value
        .map(|value| format!("{value}ms"))
        .unwrap_or_else(|| "n/a".to_string())
}

/// Inputs for the copyable preflight failure report. Kept as plain data so the rendered text
/// can be unit-tested without standing up a recording session.
struct PreflightFailureReport<'a> {
    owner: &'a str,
    reason: &'a str,
    width: u32,
    height: u32,
    target_fps: u32,
    require_camera: bool,
    require_screen: bool,
    compositor_backend: &'a str,
    compositor_cpu_fallback_frames: u64,
    encode_backend: &'a str,
    camera_frame_age_ms: Option<u64>,
    camera_sample_pts_gap_p95_ms: Option<f64>,
    screen_frame_age_ms: Option<u64>,
    maintenance_active: bool,
}

/// Render a copyable, owner-tagged preflight failure report naming the source, compositor, and
/// encoder context so a blocked start is diagnosable without reproducing it.
fn format_preflight_failure_report(report: &PreflightFailureReport) -> String {
    let mut lines = vec![
        format!(
            "Recording preflight failed: {} did not reach healthy full-output frame cadence before the timeout.",
            report.owner
        ),
        format!("Reason: {}", report.reason),
        format!(
            "Output: {}x{} @ {}fps",
            report.width, report.height, report.target_fps
        ),
        format!(
            "Sources required: camera={}, screen/window={}",
            bool_label(report.require_camera),
            bool_label(report.require_screen)
        ),
        format!(
            "Compositor: {} (CPU-fallback frames {})",
            report.compositor_backend, report.compositor_cpu_fallback_frames
        ),
        format!("Encoder: {}", report.encode_backend),
    ];
    if report.require_camera {
        lines.push(format!(
            "Camera: frame age {}, sample PTS gap p95 {}",
            optional_u64_ms(report.camera_frame_age_ms),
            optional_ms(report.camera_sample_pts_gap_p95_ms)
        ));
    }
    if report.require_screen {
        lines.push(format!(
            "Screen/window: frame age {}",
            optional_u64_ms(report.screen_frame_age_ms)
        ));
    }
    lines.push(format!(
        "Maintenance job active during start: {}",
        bool_label(report.maintenance_active)
    ));
    lines.push(
        "Next: confirm the named source is delivering frames (grant capture permission or reselect \
         the device), wait for any active maintenance job to finish, then retry. A cpu-fallback \
         compositor points at Metal availability."
            .to_string(),
    );
    lines.join("\n")
}

fn bool_label(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum FfmpegH264Platform {
    Macos,
    Windows,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FfmpegH264Encoder {
    codec: &'static str,
    pix_fmt: &'static str,
    backend: EncodeBackend,
}

fn current_ffmpeg_h264_platform() -> FfmpegH264Platform {
    #[cfg(target_os = "macos")]
    {
        FfmpegH264Platform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        FfmpegH264Platform::Windows
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        FfmpegH264Platform::Other
    }
}

fn ffmpeg_h264_encoder(platform: FfmpegH264Platform) -> FfmpegH264Encoder {
    match platform {
        FfmpegH264Platform::Macos => FfmpegH264Encoder {
            codec: "h264_videotoolbox",
            pix_fmt: "yuv420p",
            backend: EncodeBackend::HardwareVideotoolbox,
        },
        FfmpegH264Platform::Windows => FfmpegH264Encoder {
            codec: "h264_mf",
            // FFmpeg's MediaFoundation wrapper accepts yuv420p on some encoders,
            // but nv12 is the safer input shape for hardware-backed devices.
            pix_fmt: "nv12",
            backend: EncodeBackend::HardwareMediaFoundation,
        },
        FfmpegH264Platform::Other => FfmpegH264Encoder {
            codec: "libx264",
            pix_fmt: "yuv420p",
            backend: EncodeBackend::SoftwareX264,
        },
    }
}

fn default_h264_encode_backend() -> EncodeBackend {
    ffmpeg_h264_encoder(current_ffmpeg_h264_platform()).backend
}

fn append_h264_encoding_args(args: &mut Vec<String>, video: &VideoSettings) {
    append_h264_encoding_args_for_platform(args, video, current_ffmpeg_h264_platform());
}

fn append_h264_encoding_args_for_platform(
    args: &mut Vec<String>,
    video: &VideoSettings,
    platform: FfmpegH264Platform,
) {
    let encoder = ffmpeg_h264_encoder(platform);
    args.extend([
        "-r".to_string(),
        video.fps.to_string(),
        "-pix_fmt".to_string(),
        encoder.pix_fmt.to_string(),
        "-c:v".to_string(),
        encoder.codec.to_string(),
    ]);
    match platform {
        FfmpegH264Platform::Macos => {
            args.extend([
                "-allow_sw".to_string(),
                "1".to_string(),
                "-realtime".to_string(),
                "1".to_string(),
                "-prio_speed".to_string(),
                "1".to_string(),
            ]);
        }
        FfmpegH264Platform::Windows => {
            // Keep the low-delay Media Foundation profile, but let the encoder
            // select an available implementation. Forcing hardware encoding
            // makes h264_mf fail outright on systems without a compatible
            // hardware MFT.
            args.extend([
                "-rate_control".to_string(),
                "ld_vbr".to_string(),
                "-scenario".to_string(),
                "live_streaming".to_string(),
            ]);
        }
        FfmpegH264Platform::Other => {
            args.extend([
                "-preset".to_string(),
                "ultrafast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
            ]);
        }
    }
    args.extend([
        "-b:v".to_string(),
        format!("{}k", video.bitrate_kbps),
        "-maxrate".to_string(),
        format!("{}k", video.bitrate_kbps),
        "-bufsize".to_string(),
        format!("{}k", video.bitrate_kbps.saturating_mul(2)),
        // Pin a 2-second keyframe interval so YouTube and HLS/DVR go live.
        "-g".to_string(),
        video.fps.saturating_mul(2).to_string(),
        "-force_key_frames".to_string(),
        "expr:gte(t,n_forced*2)".to_string(),
        // Tee/fifo fan-out needs H.264 SPS/PPS carried as global extradata.
        "-flags".to_string(),
        "+global_header".to_string(),
    ]);
}

fn compositor_backend_label(backend: Option<CompositorBackend>) -> &'static str {
    match backend {
        Some(CompositorBackend::Metal) => "metal",
        Some(CompositorBackend::Cpu) => "cpu",
        Some(CompositorBackend::CpuFallback) => "cpu-fallback",
        None => "unknown",
    }
}

fn encode_backend_label(backend: Option<EncodeBackend>) -> &'static str {
    match backend {
        Some(EncodeBackend::HardwareVideotoolbox) => "hardware-videotoolbox",
        Some(EncodeBackend::HardwareMediaFoundation) => "hardware-mediafoundation",
        Some(EncodeBackend::SoftwareX264) => "software-x264",
        None => "unknown",
    }
}

/// Build the structured preflight report from the live diagnostics snapshot and emit it as an
/// error health event. The start path stays blocked and writes no file; this only enriches the
/// failure surface (Diagnostics) so the failing owner is copyable.
async fn emit_preflight_failure_report(
    state: &AppState,
    session_id: &str,
    owner: &str,
    reason: &str,
    params: &StartSessionParams,
    requirements: &CompositorStartupSourceRequirements,
) {
    let snapshot = { state.diagnostics.lock().await.clone() };
    let maintenance = state.ffmpeg_work.snapshot();
    let report = format_preflight_failure_report(&PreflightFailureReport {
        owner,
        reason,
        width: params.output.video.width,
        height: params.output.video.height,
        target_fps: params.output.video.fps,
        require_camera: requirements.require_camera_source,
        require_screen: requirements.require_screen_source,
        compositor_backend: compositor_backend_label(snapshot.compositor_backend),
        compositor_cpu_fallback_frames: snapshot.compositor_cpu_fallback_frames,
        encode_backend: encode_backend_label(snapshot.encode_backend),
        camera_frame_age_ms: snapshot.preview_camera_frame_age_ms,
        camera_sample_pts_gap_p95_ms: snapshot.preview_camera_sample_pts_gap_p95_ms,
        screen_frame_age_ms: snapshot.preview_screen_frame_age_ms,
        maintenance_active: maintenance.maintenance_running,
    });
    let _ = emit_health_event(
        state,
        Some(session_id),
        HealthLevel::Error,
        "recording-preflight-report",
        &report,
    );
}

fn recording_startup_source_requirements(scene: &Scene) -> CompositorStartupSourceRequirements {
    let mut require_camera_source = false;
    let mut require_screen_source = false;
    for source in scene.sources.iter().filter(|source| source.visible) {
        match source.kind {
            SceneSourceKind::Camera => require_camera_source = true,
            SceneSourceKind::Screen | SceneSourceKind::Window => require_screen_source = true,
            SceneSourceKind::TestPattern => {}
        }
    }

    CompositorStartupSourceRequirements {
        require_real_source: require_camera_source || require_screen_source,
        require_camera_source,
        require_screen_source,
    }
}

async fn publish_recording_startup_barrier_diagnostics(
    state: &AppState,
    state_label: &str,
    result: &CompositorStartupBarrierResult,
    first_encoded_frame_ms: Option<u64>,
) {
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let next = apply_recording_startup_barrier_stats(
            diagnostics.clone(),
            RecordingStartupBarrierDiagnosticSnapshot {
                state: state_label.to_string(),
                wait_ms: result.wait_ms,
                timeout_reason: result.timeout_reason.clone(),
                first_source_frame_ms: result.first_source_frame_ms,
                first_full_resolution_compositor_frame_ms: result.first_full_resolution_frame_ms,
                first_encoded_frame_ms,
            },
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
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
            let _ = crate::fifo::cleanup(&path);
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

async fn should_use_compositor_encoder_bridge(
    state: &AppState,
    params: &StartSessionParams,
    active_screen: Option<&crate::protocol::StreamScreen>,
) -> Result<bool> {
    if !params.output.record_enabled && !params.output.stream_enabled {
        return Ok(false);
    }
    if compositor_encoder_bridge_disabled(
        params.output.record_enabled,
        params.output.stream_enabled,
    ) {
        // Explicit developer env override — the only sanctioned legacy escape hatch.
        return Ok(false);
    }
    if params.output.video.fps > 30 {
        // >30fps still rides the legacy path by design (bridge cap); not silent —
        // the session log records it below at the call site.
        return Ok(false);
    }
    let scene = params.scene.clone().unwrap_or_else(|| {
        scene_from_capture_config(SceneConfigParams {
            sources: params.sources.clone(),
            layout: params.layout.clone(),
            video: Some(params.output.video.clone()),
            background: None,
            protected_overlay_window_ids: Vec::new(),
        })
    });
    let screen_image_usable = stream_screen_image_usable(active_screen);
    if wait_for_recording_encoder_bridge_sources_ready(state, &scene, screen_image_usable).await {
        return Ok(true);
    }
    // No silent downgrade (master plan, locked): falling back to the legacy FFmpeg
    // capture here records something DIFFERENT from the preview (the user saw the
    // synthetic pattern in the preview while the file captured via AVFoundation).
    // Block with the exact reason instead.
    let has_camera_frame = preview_camera_latest_frame_info(state).await.is_some();
    let screen_status = crate::preview_screen::preview_screen_status(state).await;
    let has_screen_frame = !screen_preview_is_failed(&screen_status)
        && preview_screen_latest_frame_info(state).await.is_some();
    let mut missing = Vec::new();
    if !has_screen_frame {
        missing.push("screen");
    }
    if !has_camera_frame {
        missing.push("camera");
    }
    let detail = if screen_preview_is_failed(&screen_status) {
        format!(
            " Screen preview reported: {}.",
            screen_status
                .message
                .as_deref()
                .unwrap_or("failed without a message")
        )
    } else {
        String::new()
    };
    bail!(
        "Cannot start: the {} preview source(s) produced no frames, so the recording would not match the preview.{} Re-select the source (or restart the app) and try again.",
        if missing.is_empty() {
            "required".to_string()
        } else {
            missing.join(" + ")
        },
        detail
    )
}

/// Whether an active takeover screen can actually feed the compositor: the row in the
/// database is only a pointer, the compositor needs the image file itself. Treating a
/// dangling row as a usable screen let sessions start with nothing to composite.
fn stream_screen_image_usable(active_screen: Option<&crate::protocol::StreamScreen>) -> bool {
    active_screen.is_some_and(|screen| std::path::Path::new(&screen.image_path).is_file())
}

fn screen_preview_is_failed(status: &crate::protocol::PreviewScreenStatus) -> bool {
    matches!(status.state, crate::protocol::PreviewScreenState::Failed)
}

async fn wait_for_recording_encoder_bridge_sources_ready(
    state: &AppState,
    scene: &Scene,
    screen_image_usable: bool,
) -> bool {
    let deadline = Instant::now() + RECORDING_ENCODER_BRIDGE_SOURCE_READY_TIMEOUT;
    loop {
        let has_camera_frame = preview_camera_latest_frame_info(state).await.is_some();
        // A Failed screen preview can still hold old frames in its store; recording
        // from them would freeze the screen layer. Only a non-failed source with at
        // least one frame counts as ready.
        let has_screen_frame =
            !screen_preview_is_failed(&crate::preview_screen::preview_screen_status(state).await)
                && preview_screen_latest_frame_info(state).await.is_some();
        if recording_encoder_bridge_sources_ready(
            scene,
            screen_image_usable,
            has_camera_frame,
            has_screen_frame,
        ) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(RECORDING_ENCODER_BRIDGE_SOURCE_READY_POLL).await;
    }
}

async fn recording_compositor_target_fps(_state: &AppState, video: &VideoSettings) -> u32 {
    let recording_fps = video.fps.max(1);
    // The recording compositor is the protected producer for the encoder bridge.
    // Match the file cadence at 4K; driving extra headroom here increases Metal
    // command wait and can make fresh sequence numbers carry stale visual content.
    recording_fps
}

fn compositor_encoder_bridge_disabled(record_enabled: bool, stream_enabled: bool) -> bool {
    if encoder_bridge_disabled_setting(std::env::var("VIDEORC_ENCODER_BRIDGE").ok().as_deref()) {
        return true;
    }
    if record_enabled
        && encoder_bridge_recording_disabled(
            std::env::var("VIDEORC_RECORDING_ENCODER_BRIDGE")
                .ok()
                .as_deref(),
        )
    {
        return true;
    }
    stream_enabled
        && encoder_bridge_streaming_disabled(
            std::env::var("VIDEORC_STREAMING_ENCODER_BRIDGE")
                .ok()
                .as_deref(),
        )
}

fn recording_encoder_bridge_video_output(
    record_enabled: bool,
    stream_enabled: bool,
) -> EncoderBridgeVideoOutput {
    select_encoder_bridge_video_output(
        std::env::var(ENCODER_BRIDGE_VIDEO_OUTPUT_ENV)
            .ok()
            .as_deref(),
        record_enabled,
        stream_enabled,
    )
}

fn select_encoder_bridge_video_output(
    setting: Option<&str>,
    record_enabled: bool,
    stream_enabled: bool,
) -> EncoderBridgeVideoOutput {
    parse_encoder_bridge_video_output(
        setting,
        default_encoder_bridge_video_output_for_outputs(record_enabled, stream_enabled),
    )
}

fn parse_encoder_bridge_video_output(
    setting: Option<&str>,
    default_output: EncoderBridgeVideoOutput,
) -> EncoderBridgeVideoOutput {
    let Some(setting) = setting.map(str::trim).filter(|setting| !setting.is_empty()) else {
        return default_output;
    };
    match setting.to_ascii_lowercase().as_str() {
        "raw" | "raw-yuv420p" | "raw_yuv420p" | "rawvideo" | "yuv420p" => {
            EncoderBridgeVideoOutput::RawYuv420p
        }
        "videotoolbox-h264" | "h264" | "annex-b" | "annexb" => {
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
        }
        "videotoolbox-h264-mpegts" | "h264-mpegts" | "mpegts" | "mpeg-ts" => {
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        }
        _ => default_output,
    }
}

fn default_encoder_bridge_video_output_for_outputs(
    _record_enabled: bool,
    _stream_enabled: bool,
) -> EncoderBridgeVideoOutput {
    // MpegTs everywhere (plan 023 L1). Streaming legs sat on Annex-B as an
    // LVF2 stopgap — but raw Annex-B has no timestamps, so the muxer stamped
    // frames with demux WALLCLOCK and record+stream recordings came out as
    // duplicate-PTS slideshows (the owner's 9fps 4K incident). The real LVF2
    // causes are fixed at the args: minimal mpegts probing on FIFO inputs
    // (default 5MB probe starved the multi-input graph) and fifo-muxer-wrapped
    // per-target FLV outputs with an explicit FLV codec tag (tee forwards the
    // mpegts tag [27], which flv rejects). Annex-B stays reachable via
    // VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT for diagnosis.
    default_encoder_bridge_video_output()
}

fn default_encoder_bridge_video_output() -> EncoderBridgeVideoOutput {
    #[cfg(target_os = "macos")]
    {
        EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    }
    #[cfg(not(target_os = "macos"))]
    {
        EncoderBridgeVideoOutput::RawYuv420p
    }
}

fn encoder_bridge_recording_disabled(setting: Option<&str>) -> bool {
    encoder_bridge_disabled_setting(setting)
}

fn encoder_bridge_streaming_disabled(setting: Option<&str>) -> bool {
    encoder_bridge_disabled_setting(setting)
}

fn encoder_bridge_disabled_setting(setting: Option<&str>) -> bool {
    setting.is_some_and(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        matches!(normalized.as_str(), "0" | "false" | "off" | "legacy")
    })
}

fn recording_encoder_bridge_sources_ready(
    scene: &Scene,
    has_active_screen_image: bool,
    has_camera_frame: bool,
    has_screen_frame: bool,
) -> bool {
    scene
        .sources
        .iter()
        .filter(|source| source.visible)
        .all(|source| match source.kind {
            SceneSourceKind::TestPattern => true,
            SceneSourceKind::Camera => has_camera_frame,
            SceneSourceKind::Screen | SceneSourceKind::Window => {
                has_active_screen_image || has_screen_frame
            }
        })
}

fn bridge_recording_ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
    output_path: Option<&Path>,
    fifo_path: &Path,
    video_output: EncoderBridgeVideoOutput,
) -> Result<Vec<String>> {
    let output_path =
        output_path.context("Encoder bridge recording requires a local output path")?;
    bridge_compositor_ffmpeg_args(
        capture,
        params,
        Some(output_path),
        &[],
        fifo_path,
        video_output,
    )
}

fn bridge_compositor_ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
    output_path: Option<&Path>,
    stream_targets: &[StreamTarget],
    fifo_path: &Path,
    video_output: EncoderBridgeVideoOutput,
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
    let input_layout =
        append_bridge_recording_input_args(&mut args, capture, params, fifo_path, video_output);
    // Copy-kind outputs (AnnexB/MpegTs) with stream targets fan out as one
    // file output plus one fifo-muxer-wrapped FLV output per target — tee
    // cannot carry an mpegts input to flv slaves (codec tag [27] propagates
    // verbatim and flv rejects it), and a refused RTMP target must be a dead
    // LEG, never a dead session (plan 023 L1).
    let copy_stream_fanout = matches!(
        video_output,
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    ) && !stream_targets.is_empty();
    if !copy_stream_fanout {
        match video_output {
            EncoderBridgeVideoOutput::RawYuv420p => {
                args.extend([
                    "-filter_complex".to_string(),
                    bridge_recording_video_filter(
                        input_layout.video_input_index,
                        &params.output.video,
                    ),
                    "-map".to_string(),
                    "[v_main]".to_string(),
                ]);
            }
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
                args.extend([
                    "-map".to_string(),
                    format!("{}:v", input_layout.video_input_index),
                ]);
            }
        }
        append_audio_output_args(&mut args, &input_layout);
        match video_output {
            EncoderBridgeVideoOutput::RawYuv420p => {
                append_h264_encoding_args(&mut args, &params.output.video);
            }
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
                args.extend(["-c:v".to_string(), "copy".to_string()]);
            }
        }
        append_audio_encoding_args(
            &mut args,
            &input_layout,
            &params.audio,
            !stream_targets.is_empty(),
        );
        args.push("-shortest".to_string());
    }

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
        (Some(path), []) => args.push(path.display().to_string()),
        (Some(path), _) if copy_stream_fanout => {
            append_bridge_copy_file_output(&mut args, &input_layout, &params.audio, true, path);
            for target in stream_targets {
                append_bridge_copy_flv_output(
                    &mut args,
                    &input_layout,
                    &params.audio,
                    target,
                    false,
                );
            }
        }
        (Some(path), _) => {
            let mut legs = vec![format!(
                "[f=matroska:onfail=abort]{}",
                escape_tee_target(&path.display().to_string())
            )];
            legs.extend(stream_legs);
            args.extend(tee_output_args(legs.join("|")));
        }
        (None, targets) if copy_stream_fanout => {
            for target in targets {
                append_bridge_copy_flv_output(
                    &mut args,
                    &input_layout,
                    &params.audio,
                    target,
                    false,
                );
            }
        }
        (None, [single]) => {
            args.extend([
                "-flvflags".to_string(),
                "no_duration_filesize".to_string(),
                "-f".to_string(),
                "flv".to_string(),
                single.url.clone(),
            ]);
        }
        (None, targets) if !targets.is_empty() => {
            args.extend(tee_output_args(stream_legs.join("|")));
        }
        (None, _) => bail!("At least one output target is required"),
    }

    Ok(args)
}

#[allow(clippy::too_many_arguments)]
fn bridge_compositor_split_output_ffmpeg_args(
    capture: &CaptureInputs,
    params: &StartSessionParams,
    output_path: Option<&Path>,
    stream_targets: &[StreamTarget],
    recording_fifo_path: &Path,
    stream_fifo_path: &Path,
    recording_video_output: EncoderBridgeVideoOutput,
    stream_output: CompositorAuxiliaryOutput,
) -> Result<Vec<String>> {
    let output_path =
        output_path.context("Split output encoder bridge requires a local recording path")?;
    if stream_targets.is_empty() {
        bail!("Split output encoder bridge requires at least one stream target");
    }
    ensure_encoded_bridge_video_output(recording_video_output)?;
    let stream_video = resolve_auxiliary_stream_output_video(params, &stream_output)?;
    if stream_output.width != stream_video.width || stream_output.height != stream_video.height {
        bail!(
            "Split output compositor target {}x{} does not match stream profile {}x{}",
            stream_output.width,
            stream_output.height,
            stream_video.width,
            stream_video.height
        );
    }

    let mut args = bridge_ffmpeg_base_args();
    let mut next_input_index = 0;
    let mut audio_inputs = Vec::new();
    append_bridge_audio_input_args(&mut args, capture, &mut next_input_index, &mut audio_inputs);
    let recording_video_input_index = append_bridge_encoded_video_input_args(
        &mut args,
        &mut next_input_index,
        recording_fifo_path,
        recording_video_output,
        params.output.video.fps,
    )?;
    let stream_video_input_index = append_bridge_encoded_video_input_args(
        &mut args,
        &mut next_input_index,
        stream_fifo_path,
        recording_video_output,
        stream_video.fps,
    )?;
    let input_layout = InputLayout {
        video_input_index: recording_video_input_index,
        camera_input_index: None,
        screen_overlay_input_index: None,
        audio_inputs,
        microphone_graph_gain: microphone_needs_graph_gain(capture.microphone.as_ref()),
    };

    args.extend([
        "-map".to_string(),
        format!("{recording_video_input_index}:v"),
    ]);
    append_audio_output_args(&mut args, &input_layout);
    args.extend([
        "-c:v".to_string(),
        "copy".to_string(),
        "-tag:v".to_string(),
        "0".to_string(),
    ]);
    append_audio_encoding_args(&mut args, &input_layout, &params.audio, true);
    args.push("-shortest".to_string());
    args.push(output_path.display().to_string());

    let stream_input_layout = InputLayout {
        video_input_index: stream_video_input_index,
        camera_input_index: None,
        screen_overlay_input_index: None,
        audio_inputs: input_layout.audio_inputs.clone(),
        microphone_graph_gain: input_layout.microphone_graph_gain,
    };
    let mut stream_routes = Vec::new();
    let mut uses_recording_stream_input = false;
    let mut uses_companion_stream_input = false;
    for target in stream_targets {
        let target_video = target.output_video.as_ref().unwrap_or(&stream_video);
        let video_input_index = if same_video_profile(target_video, &params.output.video) {
            uses_recording_stream_input = true;
            recording_video_input_index
        } else if same_video_profile(target_video, &stream_video) {
            uses_companion_stream_input = true;
            stream_video_input_index
        } else {
            bail!(
                "Target {} resolves to unsupported mixed stream profile {}x{}@{} {}kbps",
                target.label,
                target_video.width,
                target_video.height,
                target_video.fps,
                target_video.bitrate_kbps
            );
        };
        stream_routes.push((target, video_input_index));
    }
    let mixed_stream_inputs = uses_recording_stream_input && uses_companion_stream_input;

    if mixed_stream_inputs {
        for (target, video_input_index) in stream_routes {
            let stream_input_layout = InputLayout {
                video_input_index,
                camera_input_index: None,
                screen_overlay_input_index: None,
                audio_inputs: input_layout.audio_inputs.clone(),
                microphone_graph_gain: input_layout.microphone_graph_gain,
            };
            append_bridge_copy_flv_output(
                &mut args,
                &stream_input_layout,
                &params.audio,
                target,
                true,
            );
        }
        return Ok(args);
    }

    // One fifo-muxer-wrapped FLV output per target: a refused RTMP target is a
    // dead LEG (background retries, packet drops on overflow), never a dead
    // SESSION — the old direct/tee shapes aborted the local recording when a
    // platform handshake failed (plan 023 L1).
    for target in stream_targets {
        append_bridge_copy_flv_output(&mut args, &stream_input_layout, &params.audio, target, true);
    }

    Ok(args)
}

fn bridge_ffmpeg_base_args() -> Vec<String> {
    vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-stats".to_string(),
        "-stats_period".to_string(),
        "2".to_string(),
        "-progress".to_string(),
        "pipe:2".to_string(),
    ]
}

fn ensure_encoded_bridge_video_output(video_output: EncoderBridgeVideoOutput) -> Result<()> {
    if matches!(
        video_output,
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    ) {
        Ok(())
    } else {
        bail!("Split output encoder bridge requires encoded VideoToolbox H.264 inputs")
    }
}

fn append_bridge_recording_input_args(
    args: &mut Vec<String>,
    capture: &CaptureInputs,
    params: &StartSessionParams,
    fifo_path: &Path,
    video_output: EncoderBridgeVideoOutput,
) -> InputLayout {
    let video = &params.output.video;
    let audio_first = matches!(
        video_output,
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    );
    let mut next_input_index = 0;
    let mut audio_inputs = Vec::new();
    if audio_first {
        append_bridge_audio_input_args(args, capture, &mut next_input_index, &mut audio_inputs);
    }
    let video_input_index = next_input_index;
    match video_output {
        EncoderBridgeVideoOutput::RawYuv420p => {
            // rawvideo carries pixels only—there are no per-frame timestamps to
            // preserve. `-use_wallclock_as_timestamps` therefore collapses or
            // otherwise retimes FIFO input on Windows. Keep the declared CFR
            // timestamps and require the selected encoder to sustain the output
            // cadence instead.
            args.extend([
                "-thread_queue_size".to_string(),
                ENCODER_BRIDGE_RAW_VIDEO_INPUT_QUEUE_FRAMES.to_string(),
                "-f".to_string(),
                "rawvideo".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                "-video_size".to_string(),
                format!("{}x{}", video.width, video.height),
                "-framerate".to_string(),
                video.fps.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
        }
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => {
            args.extend([
                "-use_wallclock_as_timestamps".to_string(),
                "1".to_string(),
                "-f".to_string(),
                "h264".to_string(),
                "-framerate".to_string(),
                video.fps.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
        }
        EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
            // Minimal probing ONLY when streaming: default (~5MB) probing on a
            // low-bitrate FIFO delays first bytes by many seconds, which
            // starves RTMP targets (LVF2 "no bytes", plan 023 L1). Record-only
            // keeps the default — shrinking it shifted A/V start alignment in
            // smoke:dev, and a startup delay doesn't hurt a local file. Do not
            // add `-fflags nobuffer`: on a non-seekable H.264 MPEG-TS FIFO it
            // discards the packets consumed during probing, including the first
            // keyframe, so video begins at the next GOP while audio begins at 0.
            if params.output.stream_enabled {
                args.extend([
                    "-probesize".to_string(),
                    "65536".to_string(),
                    "-analyzeduration".to_string(),
                    "0".to_string(),
                ]);
            }
            args.extend([
                "-f".to_string(),
                "mpegts".to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
        }
    }
    next_input_index += 1;

    if !audio_first {
        append_bridge_audio_input_args(args, capture, &mut next_input_index, &mut audio_inputs);
    }

    InputLayout {
        video_input_index,
        camera_input_index: None,
        screen_overlay_input_index: None,
        audio_inputs,
        microphone_graph_gain: microphone_needs_graph_gain(capture.microphone.as_ref()),
    }
}

fn append_bridge_encoded_video_input_args(
    args: &mut Vec<String>,
    next_input_index: &mut usize,
    fifo_path: &Path,
    video_output: EncoderBridgeVideoOutput,
    fps: u32,
) -> Result<usize> {
    ensure_encoded_bridge_video_output(video_output)?;
    let input_index = *next_input_index;
    match video_output {
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => {
            args.extend([
                "-use_wallclock_as_timestamps".to_string(),
                "1".to_string(),
                "-f".to_string(),
                "h264".to_string(),
                "-framerate".to_string(),
                fps.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
        }
        EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
            args.extend([
                // Same probe discipline as append_bridge_recording_input_args:
                // the writer is our own bridge; default mpegts probing starves
                // a multi-FIFO graph (LVF2 "no bytes", plan 023 L1). `nobuffer`
                // is deliberately absent because it discards the first GOP on
                // these non-seekable FIFOs and creates a deterministic A/V gap.
                "-probesize".to_string(),
                "65536".to_string(),
                "-analyzeduration".to_string(),
                "0".to_string(),
                "-f".to_string(),
                "mpegts".to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
        }
        EncoderBridgeVideoOutput::RawYuv420p => unreachable!("checked above"),
    }
    *next_input_index += 1;
    Ok(input_index)
}

fn append_bridge_copy_file_output(
    args: &mut Vec<String>,
    input_layout: &InputLayout,
    audio: &AudioSettings,
    streaming_audio: bool,
    path: &Path,
) {
    append_bridge_copy_output_args(args, input_layout, audio, streaming_audio);
    args.push(path.display().to_string());
}

fn append_bridge_copy_flv_output(
    args: &mut Vec<String>,
    input_layout: &InputLayout,
    audio: &AudioSettings,
    target: &StreamTarget,
    advance_audio: bool,
) {
    let stream_audio;
    let audio = if advance_audio {
        stream_audio = stream_output_audio_settings(audio);
        &stream_audio
    } else {
        audio
    };
    append_bridge_copy_output_args(args, input_layout, audio, true);
    // FLV's H264 codec tag, explicitly: the mpegts input carries tag [27]
    // (stream_type) through -c:v copy, wrapper muxers clone it verbatim into
    // the inner flv muxer, and "-tag:v 0" is a no-op for copy (0 = keep).
    args.extend(["-tag:v".to_string(), "7".to_string()]);
    // Each RTMP target is its own output wrapped in ffmpeg's `fifo` muxer:
    // a refused/unreachable target retries in the background and drops
    // packets on overflow instead of aborting the whole session (tee cannot
    // carry mpegts inputs to flv slaves — it forwards the mpegts codec tag
    // [27], which the FLV muxer rejects; standalone outputs negotiate tags
    // correctly — plan 023 L1).
    args.extend([
        "-f".to_string(),
        "fifo".to_string(),
        "-fifo_format".to_string(),
        "flv".to_string(),
        "-queue_size".to_string(),
        "512".to_string(),
        "-drop_pkts_on_overflow".to_string(),
        "1".to_string(),
        "-attempt_recovery".to_string(),
        "1".to_string(),
        "-recovery_wait_time".to_string(),
        "2".to_string(),
        target.url.clone(),
    ]);
}

fn append_bridge_copy_output_args(
    args: &mut Vec<String>,
    input_layout: &InputLayout,
    audio: &AudioSettings,
    streaming_audio: bool,
) {
    args.extend([
        "-map".to_string(),
        format!("{}:v", input_layout.video_input_index),
    ]);
    append_audio_output_args(args, input_layout);
    args.extend(["-c:v".to_string(), "copy".to_string()]);
    append_audio_encoding_args(args, input_layout, audio, streaming_audio);
    args.push("-shortest".to_string());
}

fn stream_output_audio_settings(audio: &AudioSettings) -> AudioSettings {
    let mut adjusted = audio.clone();
    adjusted.microphone_sync_offset_ms = adjusted
        .microphone_sync_offset_ms
        .saturating_sub(STREAM_OUTPUT_AUDIO_ADVANCE_MS)
        .clamp(MICROPHONE_SYNC_OFFSET_MIN_MS, MICROPHONE_SYNC_OFFSET_MAX_MS);
    adjusted
}

fn append_bridge_audio_input_args(
    args: &mut Vec<String>,
    capture: &CaptureInputs,
    next_input_index: &mut usize,
    audio_inputs: &mut Vec<AudioInput>,
) {
    if append_microphone_input(args, capture.microphone.as_ref(), next_input_index) {
        audio_inputs.push(AudioInput {
            input_index: *next_input_index - 1,
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
            input_index: *next_input_index,
            track: test_tone_audio_track(),
            channels: 1,
        });
        *next_input_index += 1;
    }
}

fn bridge_recording_video_filter(video_input_index: usize, video: &VideoSettings) -> String {
    let fps = video.fps.max(1);
    format!("[{video_input_index}:v]fps={fps}[v_main]")
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
    let filter = recording_video_filter(capture, &input_layout, params, true);

    args.extend([
        "-filter_complex".to_string(),
        filter,
        "-map".to_string(),
        "[v_main]".to_string(),
    ]);
    append_audio_output_args(&mut args, &input_layout);
    append_h264_encoding_args(&mut args, &params.output.video);
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
    append_live_preview_output_args(&mut args, RECORDING_PREVIEW_JPEG_QUALITY);

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
    append_live_preview_output_args(&mut args, IDLE_PREVIEW_JPEG_QUALITY);
    Ok(args)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InputLayout {
    video_input_index: usize,
    camera_input_index: Option<usize>,
    screen_overlay_input_index: Option<usize>,
    audio_inputs: Vec<AudioInput>,
    /// Gain/mute must ride the ffmpeg filter graph (ffmpeg-owned mic capture,
    /// e.g. Windows dshow) instead of the in-process native audio path.
    microphone_graph_gain: bool,
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
        VideoInput::WindowsScreen { ref backend } => {
            append_windows_screen_video_input(args, backend, video.fps, true);
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
        VideoInput::WindowsCamera { ref device_name } => {
            append_windows_dshow_video_input(args, device_name, video.fps);
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
                "-re".to_string(),
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
                        "-re".to_string(),
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
        video_input_index: 0,
        camera_input_index,
        screen_overlay_input_index,
        audio_inputs,
        microphone_graph_gain: microphone_needs_graph_gain(capture.microphone.as_ref()),
    }
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
    crate::fifo::transport_path(&format!("videorc-screen-overlay-{session_id}.rgba"))
}

fn recording_encoder_bridge_fifo_path(session_id: &str) -> PathBuf {
    crate::fifo::transport_path(&format!(
        "videorc-recording-encoder-bridge-{session_id}.yuv"
    ))
}

fn stream_encoder_bridge_fifo_path(session_id: &str) -> PathBuf {
    crate::fifo::transport_path(&format!("videorc-stream-encoder-bridge-{session_id}.h264"))
}

fn create_recording_encoder_bridge_fifo(path: &Path) -> Result<()> {
    crate::fifo::cleanup(path).with_context(|| {
        format!(
            "Could not remove stale recording encoder bridge FIFO {}",
            path.display()
        )
    })?;

    crate::fifo::create(path).with_context(|| {
        format!(
            "Could not create recording encoder bridge FIFO {}",
            path.display()
        )
    })
}

fn create_stream_encoder_bridge_fifo(path: &Path) -> Result<()> {
    crate::fifo::cleanup(path).with_context(|| {
        format!(
            "Could not remove stale stream encoder bridge FIFO {}",
            path.display()
        )
    })?;

    crate::fifo::create(path).with_context(|| {
        format!(
            "Could not create stream encoder bridge FIFO {}",
            path.display()
        )
    })
}

fn create_screen_overlay_fifo(path: &Path) -> Result<()> {
    crate::fifo::cleanup(path).with_context(|| {
        format!(
            "Could not remove stale Screen overlay FIFO {}",
            path.display()
        )
    })?;

    crate::fifo::create(path)
        .with_context(|| format!("Could not create Screen overlay FIFO {}", path.display()))
}

fn open_screen_overlay_fifo_writer(path: &Path, stop: &AtomicBool) -> io::Result<File> {
    crate::fifo::open_writer(
        path,
        stop,
        SCREEN_OVERLAY_FIFO_OPEN_RETRY,
        false,
        "Screen overlay writer stopped before FIFO opened",
    )
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
        match write_screen_overlay_frame(&mut file, &frame, &stop) {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) => {
                tracing::warn!("Could not write Screen overlay frame: {error}");
                break;
            }
        }
        thread::sleep(frame_interval);
    }
}

fn write_screen_overlay_frame(
    file: &mut File,
    frame: &[u8],
    stop: &AtomicBool,
) -> io::Result<bool> {
    let mut written = 0;
    while written < frame.len() {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }

        match file.write(&frame[written..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "Screen overlay FIFO write returned zero bytes",
                ));
            }
            Ok(bytes) => written += bytes,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(SCREEN_OVERLAY_FIFO_WRITE_RETRY);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
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
            if offset_ms > 0 {
                filters.push(format!("adelay={offset_ms}:all=1"));
            } else {
                let trim_seconds = f64::from(offset_ms.saturating_abs()) / 1000.0;
                filters.push(format!("atrim=start={trim_seconds:.3}"));
                filters.push("asetpts=PTS-STARTPTS".to_string());
            }
        }
    }

    if has_microphone && input_layout.microphone_graph_gain {
        // ffmpeg-owned mic capture records the raw device signal, so mute and
        // gain live here — mirroring the native path's in-process processing
        // (muted wins and records digital silence, keeping the track alive).
        if audio.microphone_muted {
            filters.push("volume=0".to_string());
        } else if audio.microphone_gain_db != 0.0 {
            filters.push(format!("volume={}dB", audio.microphone_gain_db));
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

fn append_live_preview_output_args(args: &mut Vec<String>, jpeg_quality: u32) {
    args.extend([
        "-an".to_string(),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "-q:v".to_string(),
        jpeg_quality.to_string(),
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
    capture: &CaptureInputs,
    input_layout: &InputLayout,
    params: &StartSessionParams,
    include_live_preview: bool,
) -> String {
    let scene = params
        .scene
        .as_ref()
        .map(|scene| scene_video_filter(scene, capture, input_layout, params))
        .unwrap_or_else(|| video_filter(input_layout.camera_input_index, params, false));
    let video = if let Some(overlay_index) = input_layout.screen_overlay_input_index {
        format!("{scene};[v][{overlay_index}:v]overlay=x=0:y=0:format=auto:repeatlast=1[v_screen]")
    } else {
        scene
    };
    let video_label = if input_layout.screen_overlay_input_index.is_some() {
        "v_screen"
    } else {
        "v"
    };
    if include_live_preview {
        format!(
            "{video};[{video_label}]split=2[v_main][v_preview];[v_preview]{}[preview]",
            recording_preview_scale_filter()
        )
    } else {
        format!("{video};[{video_label}]null[v_main]")
    }
}

fn scene_video_filter(
    scene: &Scene,
    capture: &CaptureInputs,
    input_layout: &InputLayout,
    params: &StartSessionParams,
) -> String {
    let video = &params.output.video;
    let width = video.width.max(1);
    let height = video.height.max(1);
    let fps = video.fps.max(1);
    let background = scene
        .background
        .as_ref()
        .filter(|background| !background.managed_asset_path.trim().is_empty());
    let mut graph = match background {
        Some(background) => vec![
            format!("color=c=black:s={width}x{height}:r={fps}[scene_canvas_base]"),
            scene_background_canvas_filter(background, width, height, fps),
        ],
        None => vec![format!(
            "color=c=black:s={width}x{height}:r={fps}[scene_canvas0]"
        )],
    };
    let mut canvas_label = "scene_canvas0".to_string();
    let mut layer_index = 0usize;
    // Stage inset sized by the background's visibility setting (0 = full canvas).
    let stage_margin = background_stage_margin(background);

    for source in scene.sources.iter().filter(|source| source.visible) {
        let Some(input_index) = scene_source_input_index(&source.kind, capture, input_layout)
        else {
            continue;
        };
        let transform =
            scene_source_render_transform(&source.transform, &source.kind, stage_margin);
        let Some((x, y, layer_width, layer_height)) =
            scene_source_rect_pixels(&transform, width, height)
        else {
            continue;
        };

        let layer_label = format!("scene_layer{layer_index}");
        graph.push(scene_source_layer_filter(
            input_index,
            &layer_label,
            &source.kind,
            &transform,
            layer_width,
            layer_height,
            params,
        ));
        let next_canvas_label = format!("scene_canvas{}", layer_index + 1);
        graph.push(format!(
            "[{canvas_label}][{layer_label}]overlay=x={x}:y={y}:format=auto[{next_canvas_label}]"
        ));
        canvas_label = next_canvas_label;
        layer_index += 1;
    }

    if layer_index == 0 {
        graph.push("[scene_canvas0]null[v]".to_string());
    } else {
        graph.push(format!("[{canvas_label}]fps={fps}[v]"));
    }
    graph.join(";")
}

fn scene_background_canvas_filter(
    background: &EffectiveSceneBackground,
    width: u32,
    height: u32,
    fps: u32,
) -> String {
    let path = escape_filter_path(&background.managed_asset_path);
    let fit = scene_background_fit_filter(&background.fit, width, height);
    format!(
        "movie=filename='{path}',loop=loop=-1:size=1:start=0,setpts=N/{fps}/TB,{fit},format=rgba[scene_background];[scene_canvas_base][scene_background]overlay=x=0:y=0:shortest=0:repeatlast=1[scene_canvas0]"
    )
}

fn scene_background_fit_filter(fit: &BackgroundFit, width: u32, height: u32) -> String {
    match fit {
        BackgroundFit::Fit => format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        ),
        BackgroundFit::Stretch => format!("scale={width}:{height}"),
        BackgroundFit::Fill => format!(
            "scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
        ),
    }
}

fn scene_source_render_transform(
    transform: &SceneTransform,
    source_kind: &SceneSourceKind,
    stage_margin: f64,
) -> SceneTransform {
    if stage_margin <= 0.0 || !scene_source_uses_background_stage(source_kind) {
        return transform.clone();
    }
    let stage_scale = 1.0 - (stage_margin * 2.0);
    SceneTransform {
        x: stage_margin + (transform.x * stage_scale),
        y: stage_margin + (transform.y * stage_scale),
        width: transform.width * stage_scale,
        height: transform.height * stage_scale,
        crop_left: transform.crop_left,
        crop_top: transform.crop_top,
        crop_right: transform.crop_right,
        crop_bottom: transform.crop_bottom,
    }
}

fn scene_source_uses_background_stage(source_kind: &SceneSourceKind) -> bool {
    matches!(
        source_kind,
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern
    )
}

fn escape_filter_path(path: &str) -> String {
    path.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
        .replace(',', "\\,")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn scene_source_input_index(
    kind: &SceneSourceKind,
    capture: &CaptureInputs,
    input_layout: &InputLayout,
) -> Option<usize> {
    match kind {
        SceneSourceKind::Camera => input_layout.camera_input_index.or_else(|| {
            matches!(
                capture.video,
                VideoInput::MacCamera { .. } | VideoInput::WindowsCamera { .. }
            )
            .then_some(0)
        }),
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern => {
            matches!(
                capture.video,
                VideoInput::MacScreen { .. }
                    | VideoInput::WindowsScreen { .. }
                    | VideoInput::TestPattern
            )
            .then_some(0)
        }
    }
}

fn scene_source_rect_pixels(
    transform: &crate::protocol::SceneTransform,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<(u32, u32, u32, u32)> {
    if transform.width <= 0.0 || transform.height <= 0.0 {
        return None;
    }
    let x = normalized_to_pixel(transform.x, canvas_width).min(canvas_width.saturating_sub(1));
    let y = normalized_to_pixel(transform.y, canvas_height).min(canvas_height.saturating_sub(1));
    let max_width = canvas_width.saturating_sub(x).max(1);
    let max_height = canvas_height.saturating_sub(y).max(1);
    let width = normalized_to_span(transform.width, canvas_width).min(max_width);
    let height = normalized_to_span(transform.height, canvas_height).min(max_height);
    Some((x, y, width, height))
}

fn normalized_to_pixel(value: f64, span: u32) -> u32 {
    (value.clamp(0.0, 1.0) * f64::from(span)).round() as u32
}

fn normalized_to_span(value: f64, span: u32) -> u32 {
    (value.clamp(0.0, 1.0) * f64::from(span)).round().max(1.0) as u32
}

fn camera_circle_mask_applies(layout: &LayoutSettings) -> bool {
    matches!(layout.layout_preset, LayoutPreset::ScreenCamera)
        && matches!(layout.camera_shape, CameraShape::Circle)
}

fn scene_source_layer_filter(
    input_index: usize,
    layer_label: &str,
    kind: &SceneSourceKind,
    transform: &crate::protocol::SceneTransform,
    width: u32,
    height: u32,
    params: &StartSessionParams,
) -> String {
    let mirror = if matches!(kind, SceneSourceKind::Camera) && params.layout.camera_mirror {
        "hflip,"
    } else {
        ""
    };
    let crop = normalized_crop_filter(transform);
    let fit = scene_source_fit_filter(kind, width, height, params);
    let shape = if matches!(kind, SceneSourceKind::Camera) {
        if camera_circle_mask_applies(&params.layout) {
            circle_alpha_mask_filter(width, height)
        } else if let Some(pct) = camera_rounded_mask_pct(&params.layout) {
            rounded_alpha_mask_filter(width, height, pct)
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    format!("[{input_index}:v]setpts=PTS-STARTPTS,{mirror}{crop}{fit}{shape}[{layer_label}]")
}

fn normalized_crop_filter(transform: &crate::protocol::SceneTransform) -> String {
    let left = transform.crop_left.clamp(0.0, 0.95);
    let right = transform.crop_right.clamp(0.0, 0.95);
    let top = transform.crop_top.clamp(0.0, 0.95);
    let bottom = transform.crop_bottom.clamp(0.0, 0.95);
    let kept_x = (1.0 - left - right).max(0.001);
    let kept_y = (1.0 - top - bottom).max(0.001);
    format!("crop=w='iw*{kept_x:.6}':h='ih*{kept_y:.6}':x='iw*{left:.6}':y='ih*{top:.6}',")
}

fn scene_source_fit_filter(
    kind: &SceneSourceKind,
    width: u32,
    height: u32,
    params: &StartSessionParams,
) -> String {
    let contain = match kind {
        SceneSourceKind::Camera => {
            matches!(params.layout.camera_fit, CameraFit::Fit) && params.layout.camera_zoom <= 100
        }
        // Screen-like content always CONTAINS — nothing on the user's screen may
        // be cropped away by the layout box (cover hid the Dock on 16:10 screens
        // in 16:9 boxes; matches compositor_scene_source_fit). Transparent bars
        // so the canvas/background stage shows through the letterbox.
        SceneSourceKind::Screen | SceneSourceKind::Window => true,
        SceneSourceKind::TestPattern => false,
    };
    if contain {
        return format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,format=rgba,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0"
        );
    }
    format!(
        "scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},format=rgba"
    )
}

fn circle_alpha_mask_filter(width: u32, height: u32) -> String {
    let center_x = f64::from(width) / 2.0;
    let center_y = f64::from(height) / 2.0;
    let radius = f64::from(width.min(height)) / 2.0;
    format!(
        ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-{center_x:.3})*(X-{center_x:.3})+(Y-{center_y:.3})*(Y-{center_y:.3}),{radius:.3}*{radius:.3}),255,0)'"
    )
}

/// Rounded-rect alpha mask over the full `width`×`height` box. Radius is
/// `radius_pct`% of the shorter side (the same rule every render path uses —
/// CPU `inside_rounded_rect`, the Metal shader, and this filter must agree).
/// SDF form: a pixel is inside when its distance beyond the radius-shrunk box
/// (qx, qy) satisfies qx²+qy² ≤ r².
fn rounded_alpha_mask_filter(width: u32, height: u32, radius_pct: u32) -> String {
    let center_x = f64::from(width) / 2.0;
    let center_y = f64::from(height) / 2.0;
    let radius = f64::from(width.min(height)) * f64::from(radius_pct.min(50)) / 100.0;
    let inner_half_w = (f64::from(width) / 2.0 - radius).max(0.0);
    let inner_half_h = (f64::from(height) / 2.0 - radius).max(0.0);
    let radius_sq = radius * radius;
    format!(
        ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(st(0,max(abs(X-{center_x:.3})-{inner_half_w:.3},0))*ld(0)+st(1,max(abs(Y-{center_y:.3})-{inner_half_h:.3},0))*ld(1),{radius_sq:.3}),255,0)'"
    )
}

fn camera_rounded_mask_pct(layout: &LayoutSettings) -> Option<u32> {
    (matches!(layout.layout_preset, LayoutPreset::ScreenCamera)
        && matches!(layout.camera_shape, CameraShape::Rounded))
    .then(|| layout.camera_corner_radius_pct.min(50))
}

fn live_preview_filter(camera_input_index: Option<usize>, params: &StartSessionParams) -> String {
    format!(
        "{};[v]{}[preview]",
        video_filter(camera_input_index, params, false),
        idle_preview_scale_filter()
    )
}

fn recording_preview_scale_filter() -> String {
    format!(
        "scale=w={RECORDING_PREVIEW_WIDTH}:h={RECORDING_PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad={RECORDING_PREVIEW_WIDTH}:{RECORDING_PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps={RECORDING_PREVIEW_FPS}"
    )
}

fn idle_preview_scale_filter() -> String {
    format!(
        "scale=w={IDLE_PREVIEW_WIDTH}:h={IDLE_PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad={IDLE_PREVIEW_WIDTH}:{IDLE_PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps={IDLE_PREVIEW_FPS}"
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
    let overlay_shape = if camera_circle_mask_applies(&params.layout) {
        CameraShape::Circle
    } else if camera_rounded_mask_pct(&params.layout).is_some() {
        CameraShape::Rounded
    } else {
        CameraShape::Rectangle
    };
    let (width, height) = scaled_camera_box_size(
        &params.layout.camera_size,
        &overlay_shape,
        &params.layout.camera_aspect,
        &params.output.video,
    );
    let prefix = if params.layout.camera_mirror {
        format!("[{camera_input_index}:v]setpts=PTS-STARTPTS,hflip,")
    } else {
        format!("[{camera_input_index}:v]setpts=PTS-STARTPTS,")
    };
    let frame = camera_frame_filter(width, height, &params.layout);

    match overlay_shape {
        CameraShape::Rectangle => format!("{prefix}{frame}[cam]"),
        CameraShape::Rounded => {
            let pct = camera_rounded_mask_pct(&params.layout).unwrap_or(0);
            let mask = rounded_alpha_mask_filter(width, height, pct);
            format!("{prefix}{frame},format=rgba{mask}[cam]")
        }
        CameraShape::Circle => {
            let radius = width / 2;
            format!(
                "{prefix}{frame},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-{radius})*(X-{radius})+(Y-{radius})*(Y-{radius}),{radius}*{radius}),255,0)'[cam]"
            )
        }
    }
}

fn camera_box_size(size: &CameraSize, shape: &CameraShape, aspect: &CameraAspect) -> (u32, u32) {
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    // Must mirror scene::camera_box_size and preview_camera's copy.
    let height = match shape {
        CameraShape::Circle => width,
        CameraShape::Rectangle | CameraShape::Rounded => match aspect {
            CameraAspect::Source => (width * 9 + 8) / 16,
            CameraAspect::Square => width,
            CameraAspect::Portrait => (width * 4u32).div_ceil(3),
        },
    };

    (width, height)
}

fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
    video: &VideoSettings,
) -> (u32, u32) {
    let scale = camera_output_scale(video);
    let (width, height) = camera_box_size(size, shape, aspect);

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
        let (cam_width, cam_height) = scaled_camera_box_size(
            &layout.camera_size,
            &layout.camera_shape,
            &layout.camera_aspect,
            video,
        );
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

fn validate_session_entitlements(
    params: &StartSessionParams,
    snapshot: &EntitlementsSnapshot,
) -> Result<()> {
    if params.output.stream_enabled {
        entitlements::require_feature(snapshot, FeatureId::Livestreaming)?;
        let destination_count = ready_stream_destination_count(params)?;
        if destination_count > snapshot.limits.streaming.max_destinations {
            if snapshot.limits.streaming.max_destinations <= 1 {
                entitlements::require_feature(snapshot, FeatureId::Multistreaming)?;
            }
            bail!(
                "This plan allows up to {} livestream destination(s); this session has {} ready destination(s).",
                snapshot.limits.streaming.max_destinations,
                destination_count
            );
        }
        let stream_video = resolve_stream_output_video(params)?;
        if stream_video.width > snapshot.limits.streaming.max_width
            || stream_video.height > snapshot.limits.streaming.max_height
            || stream_video.fps > snapshot.limits.streaming.max_fps
            || stream_video.bitrate_kbps > snapshot.limits.streaming.max_bitrate_kbps
        {
            bail!(
                "This plan allows livestreaming up to {}x{}@{}fps, {} kbps; selected stream output is {}x{}@{}fps, {} kbps.",
                snapshot.limits.streaming.max_width,
                snapshot.limits.streaming.max_height,
                snapshot.limits.streaming.max_fps,
                snapshot.limits.streaming.max_bitrate_kbps,
                stream_video.width,
                stream_video.height,
                stream_video.fps,
                stream_video.bitrate_kbps
            );
        }
    }

    Ok(())
}

fn ready_stream_destination_count(params: &StartSessionParams) -> Result<u32> {
    if !params.output.stream_enabled {
        return Ok(0);
    }

    let count = match params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
    {
        Some(streaming) => stream_targets_from_streaming(streaming)?.len(),
        None => 1,
    };

    Ok(u32::try_from(count).unwrap_or(u32::MAX))
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
    validate_video_profile_policy(params)?;

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

fn validate_video_profile_policy(params: &StartSessionParams) -> Result<()> {
    let video = &params.output.video;
    validate_named_video_profile(video)?;

    if params.output.stream_enabled {
        let has_explicit_stream_output_profile = params
            .streaming
            .as_ref()
            .is_some_and(|streaming| streaming.enabled);
        if (video.width > 1920 || video.height > 1080) && !has_explicit_stream_output_profile {
            bail!(
                "4K livestreaming is not enabled for v1. Disable streaming for 4K local recording or select a stream-safe 1080p profile."
            );
        }
        let split_output_profiles = resolve_split_output_profiles(params)?;
        let stream_video = split_output_profiles
            .stream
            .as_ref()
            .unwrap_or(&params.output.video);
        if is_true_4k_stream_output(stream_video) {
            validate_true_4k_stream_profile(params, stream_video)?;
        } else if stream_video.bitrate_kbps > 6000 {
            bail!(
                "Streaming bitrate must be 6000 kbps or lower for the v1 platform-safe path. Select stream-safe-1080p30/60 or reduce the custom bitrate."
            );
        }
        if video.width > 1920 || video.height > 1080 {
            if !params.output.record_enabled {
                bail!(
                    "4K livestreaming is not enabled for v1. Disable streaming for 4K local recording or select a stream-safe 1080p profile."
                );
            }
            if video.fps > 30 {
                bail!(
                    "4K local recording plus streaming requires a 30fps recording profile for the v1 split-output path."
                );
            }
            if stream_video.fps > video.fps {
                bail!(
                    "4K local recording plus streaming requires a stream FPS no higher than the recording FPS for v1."
                );
            }
            if compositor_encoder_bridge_disabled(
                params.output.record_enabled,
                params.output.stream_enabled,
            ) {
                bail!(
                    "4K local recording plus streaming requires the encoder bridge split-output path. Remove encoder bridge legacy/disabled overrides for this mode."
                );
            }
            let bridge_video_output = recording_encoder_bridge_video_output(
                params.output.record_enabled,
                params.output.stream_enabled,
            );
            ensure_encoded_bridge_video_output(bridge_video_output)?;
        }
    }

    if is_4k_video(video) {
        if !params.output.record_enabled {
            bail!("4K output profiles require local recording to be enabled.");
        }
        if video.fps > 30 && !matches!(video.preset, VideoPreset::Record4k60Experimental) {
            bail!(
                "4K60 is experimental. Select record-4k60-experimental explicitly or use record-4k30 for v1 acceptance."
            );
        }
    }

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SplitOutputProfiles {
    recording: Option<VideoSettings>,
    stream: Option<VideoSettings>,
}

fn resolve_split_output_profiles(params: &StartSessionParams) -> Result<SplitOutputProfiles> {
    let recording = params
        .output
        .record_enabled
        .then(|| params.output.video.clone());
    let stream = if params.output.stream_enabled {
        Some(resolve_stream_output_video(params)?)
    } else {
        None
    };

    Ok(SplitOutputProfiles { recording, stream })
}

fn caption_burn_target(params: &StartSessionParams) -> crate::captions::CaptionBurnTarget {
    params
        .captions
        .as_ref()
        .map(|captions| captions.effective_burn_target())
        .unwrap_or_default()
}

fn caption_leg_plan(params: &StartSessionParams) -> crate::captions::CaptionOverlayLegPlan {
    crate::captions::caption_overlay_leg_plan(
        params.output.record_enabled,
        params.output.stream_enabled,
        caption_burn_target(params),
    )
}

fn comment_highlight_available(params: &StartSessionParams, use_encoder_bridge: bool) -> bool {
    params.output.stream_enabled && use_encoder_bridge
}

fn recording_compositor_stream_output(
    params: &StartSessionParams,
    video_output: EncoderBridgeVideoOutput,
) -> Result<Option<CompositorAuxiliaryOutput>> {
    if !params.output.record_enabled || !params.output.stream_enabled {
        return Ok(None);
    }
    if !matches!(
        video_output,
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    ) {
        return Ok(None);
    }
    let recording = &params.output.video;
    let companion_outputs = companion_stream_outputs_for_recording(params, recording)?;
    if companion_outputs.is_empty() {
        // When the stream shares the recording profile it shares frames too —
        // a burn target that treats the legs DIFFERENTLY (one burned, one
        // clean) forces a same-profile auxiliary leg (A0 verdict / R1 plan).
        // Costs one extra render per frame while enabled.
        if caption_leg_plan(params).force_same_profile_split {
            return Ok(Some(CompositorAuxiliaryOutput {
                width: recording.width,
                height: recording.height,
                frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            }));
        }
        return Ok(None);
    }
    if companion_outputs.len() > 1 {
        bail!(
            "Mixed stream output currently supports one companion output profile beside the recording profile."
        );
    }
    let stream = &companion_outputs[0];
    Ok(Some(CompositorAuxiliaryOutput {
        width: stream.width,
        height: stream.height,
        frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
    }))
}

fn companion_stream_outputs_for_recording(
    params: &StartSessionParams,
    recording: &VideoSettings,
) -> Result<Vec<VideoSettings>> {
    let mut outputs = Vec::new();
    for output in resolved_enabled_stream_output_videos(params)? {
        if same_video_profile(&output, recording) {
            continue;
        }
        if !outputs
            .iter()
            .any(|existing| same_video_profile(existing, &output))
        {
            outputs.push(output);
        }
    }
    Ok(outputs)
}

fn resolved_enabled_stream_output_videos(
    params: &StartSessionParams,
) -> Result<Vec<VideoSettings>> {
    if !params.output.stream_enabled {
        return Ok(Vec::new());
    }
    if let Some(streaming) = params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
    {
        return Ok(enabled_streaming_targets(params)
            .into_iter()
            .map(|target| stream_target_output_video(streaming, target))
            .collect());
    }
    Ok(vec![params.output.video.clone()])
}

fn same_video_profile(left: &VideoSettings, right: &VideoSettings) -> bool {
    left.width == right.width
        && left.height == right.height
        && left.fps == right.fps
        && left.bitrate_kbps == right.bitrate_kbps
}

fn resolve_auxiliary_stream_output_video(
    params: &StartSessionParams,
    stream_output: &CompositorAuxiliaryOutput,
) -> Result<VideoSettings> {
    let companion_outputs = companion_stream_outputs_for_recording(params, &params.output.video)?;
    companion_outputs
        .into_iter()
        .find(|output| output.width == stream_output.width && output.height == stream_output.height)
        .or_else(|| resolve_stream_output_video(params).ok())
        .with_context(|| {
            format!(
                "No stream profile matched auxiliary compositor output {}x{}",
                stream_output.width, stream_output.height
            )
        })
}

fn encoder_bridge_output_profile(video: &VideoSettings) -> EncoderBridgeOutputProfile {
    EncoderBridgeOutputProfile {
        width: video.width,
        height: video.height,
        fps: video.fps,
        bitrate_kbps: video.bitrate_kbps,
    }
}

fn encoder_bridge_diagnostics_context(
    role: EncoderBridgeOutputRole,
    recording_output: Option<&VideoSettings>,
    stream_output: Option<&VideoSettings>,
    video_output: EncoderBridgeVideoOutput,
    separate_output_encoders_active: bool,
) -> EncoderBridgeDiagnosticsContext {
    let active_video_toolbox_output_encoders = if matches!(
        video_output,
        EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
            | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
    ) {
        if separate_output_encoders_active {
            2
        } else {
            1
        }
    } else {
        0
    };
    EncoderBridgeDiagnosticsContext {
        role,
        recording_output: recording_output.map(encoder_bridge_output_profile),
        stream_output: stream_output.map(encoder_bridge_output_profile),
        active_video_toolbox_output_encoders,
        separate_output_encoders_active,
    }
}

fn resolve_stream_output_video(params: &StartSessionParams) -> Result<VideoSettings> {
    let stream_video = match params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
    {
        Some(streaming) => {
            let mut video = video_preset_defaults(streaming.default_output_preset.clone());
            video.bitrate_kbps = streaming.default_bitrate_kbps;
            video
        }
        None => params.output.video.clone(),
    };

    if is_true_4k_stream_output(&stream_video) {
        validate_true_4k_stream_profile(params, &stream_video)?;
        return Ok(stream_video);
    }
    if stream_video.width > 1920 || stream_video.height > 1080 {
        bail!(
            "Stream output preset {:?} resolves to {}x{}; v1 stream output must be 1080p or lower.",
            stream_video.preset,
            stream_video.width,
            stream_video.height
        );
    }
    if stream_video.bitrate_kbps > 6000 {
        bail!("Stream output bitrate must be 6000 kbps or lower for the v1 platform-safe path.");
    }

    Ok(stream_video)
}

fn is_true_4k_stream_output(video: &VideoSettings) -> bool {
    video.width >= 3840 || video.height >= 2160
}

fn validate_true_4k_stream_profile(
    params: &StartSessionParams,
    stream_video: &VideoSettings,
) -> Result<()> {
    if !matches!(stream_video.preset, VideoPreset::StreamYoutube4k30) {
        bail!("True 4K streaming requires the YouTube 4K30 stream profile.");
    }
    require_video_profile(stream_video, 3840, 2160, 30, 30_000)?;
    if !params.output.record_enabled
        || !matches!(params.output.video.preset, VideoPreset::Record4k30)
    {
        bail!(
            "YouTube 4K30 streaming requires the Record 4K30 local recording profile during v1 acceptance."
        );
    }
    let target_outputs = resolved_enabled_stream_output_videos(params)?;
    let true_4k_targets: Vec<&VideoSettings> = target_outputs
        .iter()
        .filter(|video| is_true_4k_stream_output(video))
        .collect();
    if true_4k_targets.is_empty() {
        bail!("YouTube 4K30 streaming requires at least one enabled YouTube 4K destination.");
    }
    let streaming = params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
        .context("YouTube 4K30 streaming requires modern streaming settings.")?;
    for target in enabled_streaming_targets(params) {
        let target_video = stream_target_output_video(streaming, target);
        if is_true_4k_stream_output(&target_video) {
            if target.platform != StreamPlatform::Youtube {
                bail!("True 4K streaming requires a YouTube destination.");
            }
            if !matches!(target_video.preset, VideoPreset::StreamYoutube4k30) {
                bail!("True 4K streaming requires the YouTube 4K30 stream profile.");
            }
            require_video_profile(&target_video, 3840, 2160, 30, 30_000)?;
        } else if target_video.width > 1920
            || target_video.height > 1080
            || target_video.bitrate_kbps > 6000
        {
            bail!(
                "Mixed 4K streaming requires non-YouTube destinations to use stream-safe 1080p output."
            );
        }
    }
    if compositor_encoder_bridge_disabled(
        params.output.record_enabled,
        params.output.stream_enabled,
    ) {
        bail!(
            "YouTube 4K30 streaming requires the VideoToolbox encoder bridge path. Remove encoder bridge legacy/disabled overrides for this mode."
        );
    }
    let bridge_video_output = recording_encoder_bridge_video_output(
        params.output.record_enabled,
        params.output.stream_enabled,
    );
    ensure_encoded_bridge_video_output(bridge_video_output)?;
    Ok(())
}

fn enabled_streaming_targets(params: &StartSessionParams) -> Vec<&StreamTargetSettings> {
    params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
        .map(|streaming| {
            streaming
                .targets
                .iter()
                .filter(|target| target.enabled)
                .collect()
        })
        .unwrap_or_default()
}

fn video_preset_defaults(preset: VideoPreset) -> VideoSettings {
    match preset {
        VideoPreset::Tutorial1080p30 => VideoSettings {
            preset,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        },
        VideoPreset::Tutorial1440p30 => VideoSettings {
            preset,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        },
        VideoPreset::Record4k30 => VideoSettings {
            preset,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        },
        VideoPreset::Record4k60Experimental => VideoSettings {
            preset,
            width: 3840,
            height: 2160,
            fps: 60,
            bitrate_kbps: 50_000,
        },
        VideoPreset::StreamSafe1080p30 => VideoSettings {
            preset,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        },
        VideoPreset::StreamSafe1080p60 => VideoSettings {
            preset,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 6000,
        },
        VideoPreset::StreamYoutube4k30 => VideoSettings {
            preset,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        },
        VideoPreset::Stream1080p60 => VideoSettings {
            preset,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 9000,
        },
        VideoPreset::Custom => VideoSettings {
            preset,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        },
    }
}

fn validate_named_video_profile(video: &VideoSettings) -> Result<()> {
    match video.preset {
        VideoPreset::Record4k30 => require_video_profile(video, 3840, 2160, 30, 30_000),
        VideoPreset::Record4k60Experimental => require_video_profile(video, 3840, 2160, 60, 50_000),
        VideoPreset::StreamSafe1080p30 => require_video_profile(video, 1920, 1080, 30, 6000),
        VideoPreset::StreamSafe1080p60 => require_video_profile(video, 1920, 1080, 60, 6000),
        VideoPreset::StreamYoutube4k30 => require_video_profile(video, 3840, 2160, 30, 30_000),
        _ => Ok(()),
    }
}

fn require_video_profile(
    video: &VideoSettings,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
) -> Result<()> {
    if video.width != width
        || video.height != height
        || video.fps != fps
        || video.bitrate_kbps != bitrate_kbps
    {
        bail!(
            "Video preset {:?} must be {}x{}@{} {}kbps; edit values under the custom preset.",
            video.preset,
            width,
            height,
            fps,
            bitrate_kbps
        );
    }
    Ok(())
}

fn is_4k_video(video: &VideoSettings) -> bool {
    video.width >= 3840 || video.height >= 2160
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
        output_video: None,
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

fn resolve_stream_target(
    streaming: &StreamingSettings,
    target: &StreamTargetSettings,
) -> Result<StreamTarget> {
    let server = target.server_url.trim().trim_end_matches('/');
    if server.is_empty() {
        bail!("{} RTMP URL is missing", target.label);
    }
    let output_video = Some(stream_target_output_video(streaming, target));
    if matches!(target.url_mode, Some(StreamUrlMode::FullUrl)) {
        return Ok(StreamTarget {
            url: server.to_string(),
            redacted_url: redact_stream_url(server),
            target_id: target.id.clone(),
            platform: target.platform,
            label: target.label.clone(),
            output_video,
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
        output_video,
    })
}

fn stream_target_output_video(
    streaming: &StreamingSettings,
    target: &StreamTargetSettings,
) -> VideoSettings {
    let output_preset = target.output_preset.clone().unwrap_or_else(|| {
        if streaming.default_output_preset == VideoPreset::StreamYoutube4k30
            && target.platform != StreamPlatform::Youtube
        {
            VideoPreset::StreamSafe1080p30
        } else {
            streaming.default_output_preset.clone()
        }
    });
    let mut video = video_preset_defaults(output_preset.clone());
    video.bitrate_kbps = target.output_bitrate_kbps.unwrap_or_else(|| {
        if output_preset == streaming.default_output_preset {
            streaming.default_bitrate_kbps
        } else {
            video.bitrate_kbps
        }
    });
    video
}

/// Resolves every enabled stream target, partitioning into the destinations that are
/// ready (complete credentials) and the enabled-but-incomplete ones that get skipped
/// for this session. Never errors — callers decide whether an empty `ready` set is
/// fatal — so the skipped set can be surfaced to the user (M5).
fn resolve_stream_targets(streaming: &StreamingSettings) -> StreamTargetResolution {
    let mut resolution = StreamTargetResolution::default();
    for target in streaming.targets.iter().filter(|target| target.enabled) {
        match resolve_stream_target(streaming, target) {
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

/// The slave index a recording leg occupies when the stream targets share the same
/// tee as the MKV. Split-output record+stream writes the recording separately, so
/// its stream tee starts at slave #0 even though local recording is enabled.
fn tee_slave_offset(stream_tee_has_recording_leg: bool) -> usize {
    usize::from(stream_tee_has_recording_leg)
}

/// Builds the initial per-target runtime snapshot — ready destinations as `Live`,
/// skipped ones as `NotConfigured` with their reason — plus a map from tee slave
/// index to snapshot position so a per-slave stderr failure can be attributed to the
/// right target. The map is empty for the plain (non-tee) single-stream output.
#[allow(clippy::type_complexity)]
fn build_stream_runtime(
    ready: &[StreamTarget],
    skipped: &[SkippedStreamTarget],
    stream_tee_has_recording_leg: bool,
) -> (
    Vec<StreamTargetRuntime>,
    Vec<Option<usize>>,
    Vec<(String, usize)>,
) {
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

    // Only a tee labels its slaves by index. Two or more stream legs always tee; a
    // single stream alongside a shared recording tee also reports slave indexes
    // (MKV onfail=abort + one flv leg). A lone stream with no recording in that tee
    // is a plain flv output with no per-slave reporting.
    let tee_used = ready.len() > 1 || (stream_tee_has_recording_leg && !ready.is_empty());
    let mut slave_positions = Vec::new();
    if tee_used {
        let offset = tee_slave_offset(stream_tee_has_recording_leg);
        slave_positions = vec![None; ready.len() + offset];
        for position in 0..ready.len() {
            slave_positions[position + offset] = Some(position);
        }
    }
    // Per-target fifo-muxer outputs (plan 023) report failures by URL.
    let url_positions = ready
        .iter()
        .enumerate()
        .map(|(position, target)| (target.url.clone(), position))
        .collect();
    (runtime, slave_positions, url_positions)
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct FifoOutputFailure {
    url: String,
    reason: String,
}

/// Parses an FFmpeg `fifo` muxer failure line, e.g.
/// `[fifo @ 0x..] Error opening rtmp://host/app/key: Connection refused`.
/// Stream targets ride per-target fifo-muxer outputs (plan 023 L1), so a
/// failing leg is attributed by URL instead of a tee slave index.
fn parse_fifo_output_failure(line: &str) -> Option<FifoOutputFailure> {
    let tag = line.find("[fifo @")?;
    let rest = &line[tag..];
    let marker = "Error opening ";
    let start = rest.find(marker)? + marker.len();
    let (url, reason) = rest[start..].rsplit_once(": ")?;
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(FifoOutputFailure {
        url: url.to_string(),
        reason: reason.trim().trim_end_matches('.').to_string(),
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
    use_encoder_bridge: bool,
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
            native_screen_recording_path_message(use_encoder_bridge),
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
            if use_encoder_bridge {
                HealthLevel::Info
            } else {
                HealthLevel::Warn
            },
            if use_encoder_bridge {
                "window-screencapturekit-discovery"
            } else {
                "window-capture-fallback"
            },
            native_window_recording_path_message(use_encoder_bridge),
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
            native_camera_recording_path_message(use_encoder_bridge),
        )?;
    }

    if camera_circle_mask_applies(&params.layout) {
        emit_health_event(
            state,
            Some(session_id),
            HealthLevel::Info,
            "camera-shape-circle",
            camera_circle_recording_path_message(use_encoder_bridge),
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

fn native_screen_recording_path_message(use_encoder_bridge: bool) -> &'static str {
    if use_encoder_bridge {
        "Screen source was discovered with native ScreenCaptureKit. Recording uses the protected compositor encoder bridge."
    } else {
        "Screen source was discovered with native ScreenCaptureKit. Recording still uses the FFmpeg AVFoundation fallback bridge until the native video bridge lands."
    }
}

fn native_window_recording_path_message(use_encoder_bridge: bool) -> &'static str {
    if use_encoder_bridge {
        "Window source was selected with native ScreenCaptureKit discovery. Recording uses the protected compositor encoder bridge."
    } else {
        "Window source was selected with native ScreenCaptureKit discovery, but this phase records the primary display through the FFmpeg AVFoundation fallback bridge."
    }
}

fn native_camera_recording_path_message(use_encoder_bridge: bool) -> &'static str {
    if use_encoder_bridge {
        "Camera source was discovered with native AVFoundation and selected by unique ID. Recording uses the protected compositor encoder bridge."
    } else {
        "Camera source was discovered with native AVFoundation and selected by unique ID. Recording still uses the FFmpeg AVFoundation fallback bridge until the native camera frame bridge lands."
    }
}

fn camera_circle_recording_path_message(use_encoder_bridge: bool) -> &'static str {
    if use_encoder_bridge {
        "Circle camera shape is applied by the compositor recording path."
    } else {
        "Circle camera shape is applied with an FFmpeg alpha mask in the current preview/recording path."
    }
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

/// FFmpeg `-progress`/stats output: either the combined `frame= ... speed=`
/// status line or a single `key=value` counter. These arrive multiple times
/// per second and must stay out of the bounded log ring buffer.
pub(crate) fn is_ffmpeg_progress_noise(line: &str) -> bool {
    const PROGRESS_KEYS: [&str; 12] = [
        "frame",
        "fps",
        "bitrate",
        "total_size",
        "out_time_us",
        "out_time_ms",
        "out_time",
        "dup_frames",
        "drop_frames",
        "speed",
        "progress",
        "elapsed",
    ];
    let line = line.trim();
    if line.starts_with("frame=") && line.contains("speed=") {
        return true;
    }
    let Some((key, _)) = line.split_once('=') else {
        return false;
    };
    let key = key.trim();
    PROGRESS_KEYS.contains(&key) || key.starts_with("stream_") && key.ends_with("_q")
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
    use crate::capture_input::AVFOUNDATION_VIDEO_PIXEL_FORMAT;
    use crate::protocol::EntitlementSource;
    use crate::protocol::PreviewSurfaceState;
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransform, LayoutPreset,
        LayoutSettings, OutputSettings, PreviewLiveParams, PreviewSurfaceBacking, RtmpSettings,
        Scene, SceneOutput, SceneOutputKind, SceneSource, SceneSourceKind, SceneTransform,
        SourceSelection,
    };
    use crate::storage::Database;
    use crate::streaming::{
        PlatformAccount, PlatformAccountStatus, StreamAuthMode, StreamMode, StreamPlatform,
        StreamTargetState, default_stream_targets,
    };
    use tokio::sync::broadcast;

    // Plan 030 S1: progress spam flooded the 200-entry log ring during the
    // 2026-07-08 X incident, evicting every useful entry in ~60s. The filter
    // must catch both the combined status line and per-key counters while
    // letting real FFmpeg errors through.
    #[test]
    fn ffmpeg_progress_noise_filter_catches_stats_but_not_errors() {
        assert!(is_ffmpeg_progress_noise(
            "frame= 2224 fps= 29 q=-1.0 q=-1.0 size=   73984KiB time=00:01:16.00 bitrate=7974.7kbits/s speed=0.998x elapsed=0:01:16.12    frame=2224"
        ));
        for line in [
            "fps=29.21",
            "stream_0_0_q=-1.0",
            "stream_1_0_q=-1.0",
            "bitrate=7974.7kbits/s",
            "total_size=75759616",
            "out_time_us=76000011",
            "out_time=00:01:16.000011",
            "dup_frames=0",
            "drop_frames=0",
            "speed=0.998x",
            "progress=continue",
        ] {
            assert!(is_ffmpeg_progress_noise(line), "should filter: {line}");
        }
        for line in [
            "FFmpeg did not stop promptly after stdin quit command; sending SIGTERM.",
            "[rtmp @ 0x7f8] Connection refused",
            "Error writing trailer: Broken pipe",
            "Conversion failed!",
            "x=1", // unknown key=value stays visible
        ] {
            assert!(!is_ffmpeg_progress_noise(line), "should keep: {line}");
        }
    }

    // Plan 021 F3 (external tester: "gave it mic permissions but it's not
    // recording audio"): the silent-mic verdict must catch BOTH failure shapes —
    // a device that never delivers frames, and CoreAudio's silent zeros for a
    // TCC-unauthorized process (frames advance, every sample is 0).
    #[test]
    fn silent_mic_verdict_catches_no_frames_and_all_silence() {
        assert_eq!(silent_mic_verdict(0, 0.0), Some(SilentMicKind::NoFrames));
        // No frames wins even if a stale peak value lingered.
        assert_eq!(silent_mic_verdict(0, 0.8), Some(SilentMicKind::NoFrames));
        assert_eq!(
            silent_mic_verdict(48_000, 0.0),
            Some(SilentMicKind::AllSilence)
        );
        assert_eq!(
            silent_mic_verdict(48_000, MIC_SILENT_PEAK_EPSILON / 2.0),
            Some(SilentMicKind::AllSilence)
        );
        // Real audio, however quiet, is not a silent track.
        assert_eq!(silent_mic_verdict(48_000, 0.002), None);
        assert_eq!(silent_mic_verdict(48_000, 0.9), None);
    }

    #[test]
    fn session_title_renders_in_the_target_zone_not_utc() {
        use chrono::{FixedOffset, TimeZone};
        // UTC 10:13 in a +02:00 zone must read 12:13 — the by-eye finding was
        // a UTC title sitting next to Library's local 12:13 date column.
        let started_at = Utc.with_ymd_and_hms(2026, 7, 6, 10, 13, 0).unwrap();
        let plus_two = FixedOffset::east_opt(2 * 3600).unwrap();
        assert_eq!(
            session_title(&started_at, &plus_two),
            "Session 2026-07-06 12:13"
        );
        assert_eq!(session_title(&started_at, &Utc), "Session 2026-07-06 10:13");
    }

    #[test]
    fn screen_overlay_writer_honors_stop_before_writing_frame() {
        let path = std::env::temp_dir().join(format!(
            "videorc-screen-overlay-stop-{}.rgba",
            Uuid::new_v4()
        ));
        let mut file = File::create(&path).expect("create overlay test file");
        let stop = AtomicBool::new(true);

        let wrote_frame =
            write_screen_overlay_frame(&mut file, &[1, 2, 3, 4], &stop).expect("write frame");

        assert!(!wrote_frame);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn screen_overlay_writer_writes_complete_frame_when_running() {
        let path = std::env::temp_dir().join(format!(
            "videorc-screen-overlay-write-{}.rgba",
            Uuid::new_v4()
        ));
        let mut file = File::create(&path).expect("create overlay test file");
        let stop = AtomicBool::new(false);
        let frame = vec![7; 256];

        let wrote_frame =
            write_screen_overlay_frame(&mut file, &frame, &stop).expect("write frame");
        drop(file);

        assert!(wrote_frame);
        assert_eq!(std::fs::read(&path).unwrap(), frame);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn preflight_failure_report_includes_owner_and_context() {
        let report = format_preflight_failure_report(&PreflightFailureReport {
            owner: "camera source cadence",
            reason: "camera sample PTS cadence did not settle",
            width: 1920,
            height: 1080,
            target_fps: 30,
            require_camera: true,
            require_screen: true,
            compositor_backend: "metal",
            compositor_cpu_fallback_frames: 0,
            encode_backend: "hardware-videotoolbox",
            camera_frame_age_ms: Some(420),
            camera_sample_pts_gap_p95_ms: Some(180.0),
            screen_frame_age_ms: Some(33),
            maintenance_active: false,
        });
        assert!(report.contains("camera source cadence"));
        assert!(report.contains("Reason: camera sample PTS cadence did not settle"));
        assert!(report.contains("1920x1080 @ 30fps"));
        assert!(report.contains("Camera: frame age 420ms"));
        assert!(report.contains("metal"));
        assert!(report.contains("hardware-videotoolbox"));
    }

    #[test]
    fn preflight_failure_report_omits_camera_line_when_camera_not_required() {
        let report = format_preflight_failure_report(&PreflightFailureReport {
            owner: "compositor startup",
            reason: "compositor did not produce ready frames",
            width: 2560,
            height: 1440,
            target_fps: 30,
            require_camera: false,
            require_screen: true,
            compositor_backend: "cpu-fallback",
            compositor_cpu_fallback_frames: 12,
            encode_backend: "software-x264",
            camera_frame_age_ms: None,
            camera_sample_pts_gap_p95_ms: None,
            screen_frame_age_ms: Some(50),
            maintenance_active: true,
        });
        assert!(!report.contains("Camera:"));
        assert!(report.contains("Screen/window: frame age 50ms"));
        assert!(report.contains("Maintenance job active during start: yes"));
        assert!(report.contains("cpu-fallback"));
    }

    #[test]
    fn preflight_backend_labels_map_enum_variants() {
        assert_eq!(
            compositor_backend_label(Some(CompositorBackend::Metal)),
            "metal"
        );
        assert_eq!(
            compositor_backend_label(Some(CompositorBackend::CpuFallback)),
            "cpu-fallback"
        );
        assert_eq!(compositor_backend_label(None), "unknown");
        assert_eq!(
            encode_backend_label(Some(EncodeBackend::HardwareVideotoolbox)),
            "hardware-videotoolbox"
        );
        assert_eq!(
            encode_backend_label(Some(EncodeBackend::HardwareMediaFoundation)),
            "hardware-mediafoundation"
        );
        assert_eq!(
            encode_backend_label(Some(EncodeBackend::SoftwareX264)),
            "software-x264"
        );
        assert_eq!(encode_backend_label(None), "unknown");
    }

    #[test]
    fn h264_encoder_args_are_platform_specific() {
        let video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6_000,
        };

        let mut macos_args = Vec::new();
        append_h264_encoding_args_for_platform(&mut macos_args, &video, FfmpegH264Platform::Macos);
        assert_eq!(arg_value(&macos_args, "-c:v"), Some("h264_videotoolbox"));
        assert_eq!(arg_value(&macos_args, "-pix_fmt"), Some("yuv420p"));
        assert_eq!(arg_value(&macos_args, "-allow_sw"), Some("1"));
        assert_eq!(arg_value(&macos_args, "-realtime"), Some("1"));
        assert_eq!(arg_value(&macos_args, "-prio_speed"), Some("1"));

        let mut windows_args = Vec::new();
        append_h264_encoding_args_for_platform(
            &mut windows_args,
            &video,
            FfmpegH264Platform::Windows,
        );
        assert_eq!(arg_value(&windows_args, "-c:v"), Some("h264_mf"));
        assert_eq!(arg_value(&windows_args, "-pix_fmt"), Some("nv12"));
        assert_eq!(arg_value(&windows_args, "-allow_sw"), None);
        assert_eq!(arg_value(&windows_args, "-realtime"), None);
        assert_eq!(arg_value(&windows_args, "-prio_speed"), None);

        let mut fallback_args = Vec::new();
        append_h264_encoding_args_for_platform(
            &mut fallback_args,
            &video,
            FfmpegH264Platform::Other,
        );
        assert_eq!(arg_value(&fallback_args, "-c:v"), Some("libx264"));
        assert_eq!(arg_value(&fallback_args, "-pix_fmt"), Some("yuv420p"));
        assert_eq!(arg_value(&fallback_args, "-preset"), Some("ultrafast"));
        assert_eq!(arg_value(&fallback_args, "-tune"), Some("zerolatency"));

        for args in [&macos_args, &windows_args, &fallback_args] {
            assert_eq!(arg_value(args, "-b:v"), Some("6000k"));
            assert_eq!(arg_value(args, "-maxrate"), Some("6000k"));
            assert_eq!(arg_value(args, "-bufsize"), Some("12000k"));
            assert_eq!(arg_value(args, "-g"), Some("60"));
            assert_eq!(
                arg_value(args, "-force_key_frames"),
                Some("expr:gte(t,n_forced*2)")
            );
            assert_eq!(arg_value(args, "-flags"), Some("+global_header"));
        }
    }

    #[test]
    fn h264_encoder_backends_are_platform_specific() {
        assert_eq!(
            ffmpeg_h264_encoder(FfmpegH264Platform::Macos).backend,
            EncodeBackend::HardwareVideotoolbox
        );
        assert_eq!(
            ffmpeg_h264_encoder(FfmpegH264Platform::Windows).backend,
            EncodeBackend::HardwareMediaFoundation
        );
        assert_eq!(
            ffmpeg_h264_encoder(FfmpegH264Platform::Other).backend,
            EncodeBackend::SoftwareX264
        );
    }

    #[test]
    fn recording_startup_frame_gap_budget_scales_with_target_fps() {
        #[cfg(target_os = "macos")]
        {
            // 2.1 × 33.3ms ≈ 70 → 71ms ceil
            assert_eq!(
                recording_startup_frame_gap_budget(30),
                Duration::from_millis(71)
            );
            assert_eq!(
                recording_startup_frame_gap_budget(60),
                Duration::from_millis(36)
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            // 6.0 × 33.3ms = 200ms — covers on-box Windows 172ms compose gaps
            assert_eq!(
                recording_startup_frame_gap_budget(30),
                Duration::from_millis(200)
            );
            // 6.0 × 16.7ms ≈ 100ms, but the 200ms floor wins (gaps are wall-clock).
            assert_eq!(
                recording_startup_frame_gap_budget(60),
                Duration::from_millis(200)
            );
            // The exact tester numbers that used to fail under the 71ms/150ms budgets.
            assert!(recording_startup_frame_gap_budget(30) > Duration::from_millis(172));
        }
    }

    #[tokio::test]
    async fn recording_startup_scene_lease_blocks_concurrent_commits_until_released() {
        let state = test_state();
        let layout = base_params(true, false).layout;
        let recording_scene = scene_with_sources(vec![scene_source(
            "source:recording",
            SceneSourceKind::TestPattern,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);

        let startup = commit_recording_startup_scene_at_time(
            &state,
            &recording_scene,
            layout.clone(),
            None,
            1_000,
        )
        .await;
        assert_eq!(startup.scene_revision, 1_000);

        let competing_state = state.clone();
        let competing_scene = scene_with_sources(vec![scene_source(
            "source:competing",
            SceneSourceKind::TestPattern,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        let competing = tokio::spawn(async move {
            crate::live_layout::commit_scene_with_layout(
                &competing_state,
                &competing_scene,
                layout,
                None,
            )
            .await
            .expect("competing scene commit")
        });

        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(
            !competing.is_finished(),
            "another scene writer must not replace the startup revision before proof"
        );
        assert_eq!(
            state.compositor.lock().await.status.scene_revision,
            Some(startup.scene_revision)
        );

        drop(startup);
        let committed = timeout(Duration::from_secs(1), competing)
            .await
            .expect("competing commit should resume after startup proof")
            .expect("competing commit task");
        assert!(committed.scene_revision > 1_000);
    }

    fn base_params(record_enabled: bool, stream_enabled: bool) -> StartSessionParams {
        StartSessionParams {
            captions: None,
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
                camera_corner_radius_pct: 12,
                camera_aspect: crate::protocol::CameraAspect::Source,
                camera_margin: 32,
                camera_fit: CameraFit::Fill,
                camera_mirror: false,
                camera_zoom: 100,
                camera_offset_x: 0,
                camera_offset_y: 0,
                side_by_side_split: SideBySideSplit::SeventyThirty,
                side_by_side_camera_side: SideBySideCameraSide::Right,
            },
            scene: None,
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
            audio: AudioSettings {
                microphone_sync_offset_ms: 0,
                ..Default::default()
            },
            streaming: None,
        }
    }

    fn repair_job_for_path(path: String) -> RepairJob {
        RepairJob::pending(
            "job".to_string(),
            path,
            &QualityExpectations {
                intended_fps: Some(30.0),
                expect_audio: true,
            },
            "t0".to_string(),
        )
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn duplicate_capture_sources_report_live_native_preview_overlap() {
        let capture = CaptureInputs {
            video: VideoInput::MacScreen { index: 3 },
            camera_index: Some(0),
            microphone: None,
        };

        let sources = duplicate_capture_sources_for_statuses(
            &capture,
            PreviewCameraState::Live,
            Some("camera:avfoundation:0"),
            PreviewScreenState::Live,
            Some(PreviewScreenSourceKind::Screen),
            Some("screen:avfoundation:3"),
        );

        assert_eq!(
            sources,
            vec![
                "camera:avfoundation:0".to_string(),
                "screen:avfoundation:3".to_string()
            ]
        );
    }

    #[test]
    fn duplicate_capture_sources_ignore_idle_preview_sources() {
        let capture = CaptureInputs {
            video: VideoInput::MacScreen { index: 3 },
            camera_index: Some(0),
            microphone: None,
        };

        let sources = duplicate_capture_sources_for_statuses(
            &capture,
            PreviewCameraState::DeviceMissing,
            Some("camera:avfoundation:0"),
            PreviewScreenState::SourceMissing,
            Some(PreviewScreenSourceKind::Screen),
            Some("screen:avfoundation:3"),
        );

        assert!(sources.is_empty());
    }

    #[test]
    fn stale_repair_job_reason_detects_missing_file() {
        let job = repair_job_for_path("/definitely/missing/videorc-recording.mp4".to_string());

        let reason = stale_repair_job_reason(&job).expect("missing file is stale");

        assert!(reason.contains("missing"));
    }

    #[test]
    fn stale_repair_job_reason_detects_existing_temp_smoke_output() {
        let dir = std::env::temp_dir().join(format!("videorc-dev-smoke-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("videorc-session-test.mp4");
        std::fs::write(&file, b"not a real video").unwrap();
        let job = repair_job_for_path(file.display().to_string());

        let reason = stale_repair_job_reason(&job).expect("temp smoke file is stale");

        assert!(reason.contains("temporary smoke output"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_repair_job_reason_keeps_existing_non_temp_file() {
        let dir = std::env::temp_dir().join(format!("videorc-user-output-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("recording.mp4");
        std::fs::write(&file, b"not a real video").unwrap();
        let job = repair_job_for_path(file.display().to_string());

        assert!(stale_repair_job_reason(&job).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scene_transform(x: f64, y: f64, width: f64, height: f64) -> SceneTransform {
        SceneTransform {
            x,
            y,
            width,
            height,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        }
    }

    fn scene_source(
        id: &str,
        kind: SceneSourceKind,
        transform: SceneTransform,
        visible: bool,
    ) -> SceneSource {
        SceneSource {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            device_id: None,
            transform: transform.clone(),
            default_transform: transform,
            visible,
            locked: false,
        }
    }

    fn scene_with_sources(sources: Vec<SceneSource>) -> Scene {
        Scene {
            id: "scene:test".to_string(),
            name: "Test scene".to_string(),
            sources,
            outputs: vec![SceneOutput {
                id: "output:recording".to_string(),
                kind: SceneOutputKind::Recording,
                width: default_video_settings().width,
                height: default_video_settings().height,
                fps: default_video_settings().fps,
            }],
            background: None,
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
    fn resolves_target_output_profiles_for_mixed_youtube_4k_streaming() {
        let mut streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;

        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let youtube = targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        let twitch = targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();

        assert_eq!(
            youtube.output_video,
            Some(VideoSettings {
                preset: VideoPreset::StreamYoutube4k30,
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            })
        );
        assert_eq!(
            twitch.output_video,
            Some(VideoSettings {
                preset: VideoPreset::StreamSafe1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            })
        );
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
                account_label: "Videorc Channel".to_string(),
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

        hydrate_stream_key_secret_refs_from_credentials(
            &mut streaming,
            &credentials,
            |secret_ref| {
                assert_eq!(secret_ref, "platform:youtube:UC123:stream-key");
                Ok("secret-youtube-key".to_string())
            },
        )
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
    fn manual_stream_targets_hydrate_key_from_target_secret_ref() {
        let mut streaming =
            streaming_for(&[(StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "")]);
        let twitch = streaming
            .targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch.auth_mode = StreamAuthMode::ManualRtmp;
        twitch.stream_key_secret_ref = Some("manual:twitch:stream-key".to_string());
        twitch.stream_key_present = true;

        hydrate_stream_key_secret_refs_from_credentials(&mut streaming, &[], |secret_ref| {
            assert_eq!(secret_ref, "manual:twitch:stream-key");
            Ok("secret-twitch-key".to_string())
        })
        .unwrap();

        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].url,
            "rtmp://live.twitch.tv/app/secret-twitch-key"
        );
        assert!(!targets[0].redacted_url.contains("secret-twitch-key"));
        let twitch = streaming
            .targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        assert_eq!(twitch.stream_key, "secret-twitch-key");
        assert!(twitch.stream_key_present);
        assert_eq!(
            twitch.stream_key_secret_ref.as_deref(),
            Some("manual:twitch:stream-key")
        );
    }

    #[test]
    fn stream_target_secret_refs_must_hydrate_before_start_validation() {
        let mut params = base_params(false, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
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
        youtube.stream_key_secret_ref = Some("platform:youtube:UC123:stream-key".to_string());
        youtube.stream_key_present = true;
        params.streaming = Some(streaming);
        let snapshot = entitlements::basic_entitlements();

        let unhydrated_error = validate_session_entitlements(&params, &snapshot)
            .expect_err("saved secret refs are not enough until their raw values are hydrated")
            .to_string();
        assert!(
            unhydrated_error.contains("No streaming destination is ready"),
            "validation should explain that no hydrated destination is ready: {unhydrated_error}"
        );

        hydrate_stream_key_secret_refs_from_credentials(
            params.streaming.as_mut().unwrap(),
            &[],
            |secret_ref| {
                assert_eq!(secret_ref, "platform:youtube:UC123:stream-key");
                Ok("secret-youtube-key".to_string())
            },
        )
        .unwrap();

        validate_session_entitlements(&params, &snapshot).unwrap();
        validate_outputs(&params).unwrap();
    }

    #[test]
    fn full_url_stream_targets_hydrate_url_from_target_secret_ref() {
        let mut streaming = streaming_for(&[(StreamPlatform::Custom, "", "")]);
        let custom = streaming
            .targets
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Custom)
            .unwrap();
        custom.url_mode = Some(StreamUrlMode::FullUrl);
        custom.stream_key_secret_ref = Some("stream-target:custom:manual-stream-key".to_string());
        custom.stream_key_present = true;

        hydrate_stream_key_secret_refs_from_credentials(&mut streaming, &[], |secret_ref| {
            assert_eq!(secret_ref, "stream-target:custom:manual-stream-key");
            Ok("rtmp://example.test/live/full-url-secret".to_string())
        })
        .unwrap();

        let targets = stream_targets_from_streaming(&streaming).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].url, "rtmp://example.test/live/full-url-secret");
        assert_eq!(targets[0].redacted_url, "rtmp://example.test/live/••••");
        let custom = streaming
            .targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Custom)
            .unwrap();
        assert_eq!(
            custom.server_url,
            "rtmp://example.test/live/full-url-secret"
        );
        assert_eq!(custom.stream_key, "");
        assert!(custom.stream_key_present);
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

    // Plan 023: per-target fifo-muxer legs report failures by URL.
    #[test]
    fn parses_fifo_output_failure_lines() {
        let failure = parse_fifo_output_failure(
            "[fifo @ 0x7ef042a80] Error opening rtmp://127.0.0.1:11937/live/smoke-offline: Connection refused",
        )
        .unwrap();
        assert_eq!(failure.url, "rtmp://127.0.0.1:11937/live/smoke-offline");
        assert_eq!(failure.reason, "Connection refused");

        assert!(parse_fifo_output_failure("[flv @ 0x1] Error opening rtmp://x: nope").is_none());
        assert!(parse_fifo_output_failure("[fifo @ 0x1] something else").is_none());
    }

    #[test]
    fn build_stream_runtime_maps_slaves_after_recording_leg() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw"),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (runtime, slaves, _) =
            build_stream_runtime(&resolution.ready, &resolution.skipped, true);
        assert_eq!(runtime.len(), 2);
        assert!(runtime.iter().all(|t| t.state == StreamTargetState::Live));
        // Slave #0 is the MKV (onfail=abort); the two stream legs are #1 and #2.
        assert_eq!(slaves.first().copied().flatten(), None);
        assert_eq!(slaves.get(1).copied().flatten(), Some(0));
        assert_eq!(slaves.get(2).copied().flatten(), Some(1));
    }

    #[test]
    fn build_stream_runtime_maps_split_output_stream_tee_from_zero() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw"),
            (StreamPlatform::X, "rtmp://x.example/app", "x"),
            (
                StreamPlatform::Custom,
                "rtmp://custom.example/app",
                "custom",
            ),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (_, slaves, _) = build_stream_runtime(&resolution.ready, &resolution.skipped, false);
        assert_eq!(slaves.first().copied().flatten(), Some(0));
        assert_eq!(slaves.get(1).copied().flatten(), Some(1));
        assert_eq!(slaves.get(2).copied().flatten(), Some(2));
        assert_eq!(slaves.get(3).copied().flatten(), Some(3));
    }

    #[test]
    fn build_stream_runtime_stream_only_multi_starts_at_zero() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw"),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (_, slaves, _) = build_stream_runtime(&resolution.ready, &resolution.skipped, false);
        assert_eq!(slaves.first().copied().flatten(), Some(0));
        assert_eq!(slaves.get(1).copied().flatten(), Some(1));
    }

    #[test]
    fn build_stream_runtime_single_stream_only_has_no_slave_map() {
        let streaming = streaming_for(&[(StreamPlatform::Twitch, "rtmp://live.twitch/app", "tw")]);
        let resolution = resolve_stream_targets(&streaming);
        // A lone stream with no recording is a plain flv output: no per-slave reporting.
        let (runtime, slaves, _) =
            build_stream_runtime(&resolution.ready, &resolution.skipped, false);
        assert_eq!(runtime.len(), 1);
        assert!(slaves.is_empty());
        // ...but the same single stream *with* a recording tees (MKV + one leg).
        let (_, with_rec, _) = build_stream_runtime(&resolution.ready, &resolution.skipped, true);
        assert_eq!(with_rec.get(1).copied().flatten(), Some(0));
    }

    #[test]
    fn build_stream_runtime_marks_skipped_targets_not_configured() {
        let streaming = streaming_for(&[
            (StreamPlatform::Youtube, "rtmp://a.youtube/live2", "yt"),
            (StreamPlatform::Twitch, "rtmp://live.twitch/app", ""),
        ]);
        let resolution = resolve_stream_targets(&streaming);
        let (runtime, _, _) = build_stream_runtime(&resolution.ready, &resolution.skipped, true);
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
        params.layout.camera_shape = CameraShape::Circle;
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
        assert!(!filter.contains("geq="));
        assert!(!filter.contains("format=rgba"));
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

    #[test]
    fn windows_screen_input_can_be_primary_recording_input() {
        let params = base_params(true, false);
        let mut args = Vec::new();
        let layout = append_input_args(
            &mut args,
            &CaptureInputs {
                video: VideoInput::WindowsScreen {
                    backend: crate::capture_input::WindowsScreenCaptureBackend::Ddagrab {
                        output_index: 1,
                    },
                },
                camera_index: None,
                microphone: Some(MicrophoneInput::WindowsDshow {
                    device_name: "Microphone Array".to_string(),
                }),
            },
            true,
            &params.output.video,
            None,
        );

        assert_eq!(layout.video_input_index, 0);
        assert_eq!(layout.camera_input_index, None);
        assert_eq!(layout.audio_inputs.len(), 1);
        assert_eq!(layout.audio_inputs[0].input_index, 1);
        assert!(args.iter().any(|arg| arg.contains("ddagrab=output_idx=1")));
        assert!(args.contains(&"audio=Microphone Array".to_string()));
    }

    #[test]
    fn windows_camera_input_can_be_primary_recording_input() {
        let params = base_params(true, false);
        let mut args = Vec::new();
        let layout = append_input_args(
            &mut args,
            &CaptureInputs {
                video: VideoInput::WindowsCamera {
                    device_name: "USB Camera".to_string(),
                },
                camera_index: None,
                microphone: None,
            },
            false,
            &params.output.video,
            None,
        );

        assert_eq!(layout.video_input_index, 0);
        assert!(layout.camera_input_index.is_none());
        assert!(args.contains(&"dshow".to_string()));
        assert!(args.contains(&"video=USB Camera".to_string()));
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

    #[tokio::test]
    async fn stale_test_pattern_flag_does_not_override_selected_screen_input() {
        let mut params = base_params(true, false);
        params.sources.test_pattern = true;

        let capture = resolve_capture_inputs("ffmpeg", &params).await;

        assert_eq!(capture.video, VideoInput::MacScreen { index: 3 });
    }

    #[tokio::test]
    async fn selected_windows_screen_and_microphone_resolve_to_windows_inputs() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::ScreenOnly;
        params.sources.screen_id = Some("screen:dxgi:00000000000003f1:2".to_string());
        params.sources.microphone_id =
            Some("microphone:windows-dshow:4d6963726f70686f6e65204172726179".to_string());

        let capture = resolve_capture_inputs("ffmpeg", &params).await;

        assert_eq!(
            capture.video,
            VideoInput::WindowsScreen {
                backend: WindowsScreenCaptureBackend::Ddagrab { output_index: 2 },
            }
        );
        assert_eq!(capture.camera_index, None);
        assert_eq!(
            capture.microphone,
            Some(MicrophoneInput::WindowsDshow {
                device_name: "Microphone Array".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn camera_only_resolves_windows_camera_as_primary_video_input() {
        let mut params = base_params(true, false);
        params.layout.layout_preset = LayoutPreset::CameraOnly;
        params.sources.camera_id = Some("camera:windows-dshow:5553422043616d657261".to_string());
        params.sources.microphone_id = None;

        let capture = resolve_capture_inputs("ffmpeg", &params).await;

        assert_eq!(
            capture.video,
            VideoInput::WindowsCamera {
                device_name: "USB Camera".to_string(),
            }
        );
        assert!(capture.camera_index.is_none());
        assert!(capture.microphone.is_none());
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

    fn assert_current_h264_encoder_args(args: &[String]) {
        let platform = current_ffmpeg_h264_platform();
        let encoder = ffmpeg_h264_encoder(platform);
        assert_eq!(arg_value(args, "-c:v"), Some(encoder.codec));
        match platform {
            FfmpegH264Platform::Macos => {
                assert_eq!(arg_value(args, "-allow_sw"), Some("1"));
                assert_eq!(arg_value(args, "-realtime"), Some("1"));
                assert_eq!(arg_value(args, "-prio_speed"), Some("1"));
            }
            FfmpegH264Platform::Windows => {
                assert_eq!(arg_value(args, "-allow_sw"), None);
                assert_eq!(arg_value(args, "-realtime"), None);
                assert_eq!(arg_value(args, "-prio_speed"), None);
                assert_eq!(encoder.backend, EncodeBackend::HardwareMediaFoundation);
            }
            FfmpegH264Platform::Other => {
                assert_eq!(arg_value(args, "-allow_sw"), None);
                assert_eq!(arg_value(args, "-realtime"), None);
                assert_eq!(arg_value(args, "-prio_speed"), None);
                assert_eq!(arg_value(args, "-preset"), Some("ultrafast"));
                assert_eq!(arg_value(args, "-tune"), Some("zerolatency"));
            }
        }
    }

    #[test]
    fn bridge_recording_args_use_raw_yuv_video_and_existing_audio() {
        let params = base_params(true, false);
        let fifo_path = Path::new("/tmp/videorc-bridge-input.yuv");
        let args = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            fifo_path,
            EncoderBridgeVideoOutput::RawYuv420p,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                fifo_path.display().to_string(),
                "sine=frequency=880:sample_rate=48000".to_string()
            ]
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
            Some("yuv420p")
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-video_size"),
            Some("2560x1440")
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-framerate"),
            Some("30")
        );
        assert_eq!(
            input_arg_value(
                &args,
                &fifo_path.display().to_string(),
                "-thread_queue_size"
            ),
            Some("16"),
            "live raw video must have its own demux queue when device audio is also active"
        );
        assert_eq!(
            input_arg_value(
                &args,
                &fifo_path.display().to_string(),
                "-use_wallclock_as_timestamps"
            ),
            None,
            "rawvideo carries no per-frame timestamps, so it must retain its declared CFR timeline"
        );
        assert!(!input_has_arg(
            &args,
            "sine=frequency=880:sample_rate=48000",
            "-re"
        ));
        assert!(args.iter().any(|arg| arg == "[v_main]"));
        assert!(!args.iter().any(|arg| arg == "[preview]"));
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert_current_h264_encoder_args(&args);
        assert_eq!(arg_value(&args, "-c:a"), Some("pcm_s16le"));
        assert!(args.iter().any(|arg| arg == "-shortest"));

        let filter = arg_value(&args, "-filter_complex").unwrap();
        assert_eq!(filter, "[0:v]fps=30[v_main]");
        assert!(!args.iter().any(|arg| arg == "pipe:1"));
        assert!(!args.iter().any(|arg| arg == "pipe:0"));
    }

    #[test]
    fn bridge_recording_args_can_copy_videotoolbox_h264_fifo() {
        let params = base_params(true, false);
        let fifo_path = Path::new("/tmp/videorc-bridge-input.h264");
        let args = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            fifo_path,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                "sine=frequency=880:sample_rate=48000".to_string(),
                fifo_path.display().to_string()
            ]
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
            Some("h264")
        );
        assert_eq!(
            input_arg_value(
                &args,
                &fifo_path.display().to_string(),
                "-use_wallclock_as_timestamps"
            ),
            Some("1")
        );
        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-fflags"
        ));
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-framerate"),
            Some("30")
        );

        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-pix_fmt"
        ));
        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-video_size"
        ));
        assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
        assert_eq!(arg_value(&args, "-c:a"), Some("pcm_s16le"));
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "1:v")
        );
        assert!(args.iter().any(|arg| arg == "0:a?"));
        assert!(args.iter().any(|arg| arg == "-shortest"));
        assert!(arg_value(&args, "-filter_complex").is_none());
        assert!(arg_value(&args, "-allow_sw").is_none());
        assert!(arg_value(&args, "-realtime").is_none());
        assert!(arg_value(&args, "-prio_speed").is_none());
    }

    #[test]
    fn bridge_recording_args_can_copy_timestamped_videotoolbox_h264_mpegts_fifo() {
        let params = base_params(true, false);
        let fifo_path = Path::new("/tmp/videorc-bridge-input.ts");
        let args = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            fifo_path,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                "sine=frequency=880:sample_rate=48000".to_string(),
                fifo_path.display().to_string()
            ]
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
            Some("mpegts")
        );
        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-use_wallclock_as_timestamps"
        ));
        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-framerate"
        ));
        assert!(!input_has_arg(
            &args,
            &fifo_path.display().to_string(),
            "-pix_fmt"
        ));
        assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
        assert_eq!(arg_value(&args, "-c:a"), Some("pcm_s16le"));
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "1:v")
        );
        assert!(args.iter().any(|arg| arg == "0:a?"));
        assert!(args.iter().any(|arg| arg == "-shortest"));
        assert!(arg_value(&args, "-filter_complex").is_none());
        assert!(arg_value(&args, "-allow_sw").is_none());
        assert!(arg_value(&args, "-realtime").is_none());
        assert!(arg_value(&args, "-prio_speed").is_none());
    }

    #[test]
    fn bridge_recording_h264_mpegts_opens_native_audio_before_video_fifo() {
        let params = base_params(true, false);
        let fifo_path = Path::new("/tmp/videorc-bridge-input.ts");
        let audio_fifo_path = PathBuf::from("/tmp/videorc-audio-test.f32le");
        let args = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: Some(MicrophoneInput::CoreAudio {
                    device_id: 42,
                    fifo_path: Some(audio_fifo_path.clone()),
                }),
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            fifo_path,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                audio_fifo_path.display().to_string(),
                fifo_path.display().to_string()
            ]
        );
        assert_eq!(
            input_arg_value(&args, &audio_fifo_path.display().to_string(), "-f"),
            Some("f32le")
        );
        assert_eq!(
            input_arg_value(
                &args,
                &audio_fifo_path.display().to_string(),
                "-thread_queue_size"
            ),
            Some("1024")
        );
        assert_eq!(
            input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
            Some("mpegts")
        );
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "1:v")
        );
        assert!(args.iter().any(|arg| arg == "0:a?"));
        assert_eq!(
            arg_value(&args, "-af"),
            Some("aresample=async=1:first_pts=0")
        );
    }

    #[test]
    fn bridge_stream_only_args_use_default_video_output_and_flv_output() {
        let params = base_params(false, true);
        let fifo_path = Path::new("/tmp/videorc-bridge-stream.h264");
        let video_output = select_encoder_bridge_video_output(
            None,
            params.output.record_enabled,
            params.output.stream_enabled,
        );
        let targets = vec![build_stream_url(&params.output.rtmp).unwrap()];
        let args = bridge_compositor_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            None,
            &targets,
            fifo_path,
            video_output,
        )
        .unwrap();

        // Plan 023 L1: streaming shapes default to MpegTs (real encoder PTS);
        // targets ride fifo-muxer-wrapped FLV outputs (failure-isolated).
        #[cfg(target_os = "macos")]
        assert_eq!(
            video_output,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(video_output, EncoderBridgeVideoOutput::RawYuv420p);
        assert!(!args.contains(&"tee".to_string()));
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/abc123".to_string()));
        assert!(args.iter().any(|arg| arg == "-shortest"));
        assert!(!args.iter().any(|arg| arg == "[preview]"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
            // FLV's H264 tag, forced: wrappers clone the mpegts tag verbatim.
            assert_eq!(arg_value(&args, "-tag:v"), Some("7"));
            assert!(
                args.windows(2)
                    .any(|window| window[0] == "-f" && window[1] == "fifo"),
                "single RTMP target must be fifo-muxer wrapped: {args:?}"
            );
            assert_eq!(arg_value(&args, "-fifo_format"), Some("flv"));
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
                Some("mpegts")
            );
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-probesize"),
                Some("65536")
            );
            assert_eq!(
                input_arg_value(
                    &args,
                    &fifo_path.display().to_string(),
                    "-use_wallclock_as_timestamps"
                ),
                None
            );
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                None
            );
            assert_eq!(arg_value(&args, "-filter_complex"), None);
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(
                arg_value(&args, "-c:v"),
                Some(ffmpeg_h264_encoder(current_ffmpeg_h264_platform()).codec)
            );
            assert_eq!(arg_value(&args, "-allow_sw"), None);
            assert_eq!(arg_value(&args, "-realtime"), None);
            assert_eq!(arg_value(&args, "-prio_speed"), None);
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                Some("yuv420p")
            );
        }
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn bridge_stream_only_multistream_tees_flv_targets() {
        let params = base_params(false, true);
        let fifo_path = Path::new("/tmp/videorc-bridge-multistream.h264");
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let video_output = select_encoder_bridge_video_output(
            None,
            params.output.record_enabled,
            params.output.stream_enabled,
        );
        let args = bridge_compositor_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            None,
            &targets,
            fifo_path,
            video_output,
        )
        .unwrap();

        // Plan 023 L1: MpegTs default; each target is its OWN fifo-muxer
        // output — tee cannot carry mpegts inputs to flv slaves (tag [27]).
        #[cfg(target_os = "macos")]
        assert_eq!(
            video_output,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(video_output, EncoderBridgeVideoOutput::RawYuv420p);
        assert!(!args.contains(&"tee".to_string()));
        assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/yt".to_string()));
        assert!(args.contains(&"rtmp://live.twitch.tv/app/tw".to_string()));
        assert_eq!(
            args.windows(2)
                .filter(|window| window[0] == "-f" && window[1] == "fifo")
                .count(),
            2,
            "every RTMP target must be an isolated fifo-muxer output: {args:?}"
        );
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
            assert_eq!(arg_value(&args, "-tag:v"), Some("7"));
            assert_eq!(arg_value(&args, "-filter_complex"), None);
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
                Some("mpegts")
            );
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                None
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(
                arg_value(&args, "-c:v"),
                Some(ffmpeg_h264_encoder(current_ffmpeg_h264_platform()).codec)
            );
            assert_eq!(arg_value(&args, "-allow_sw"), None);
            assert_eq!(arg_value(&args, "-realtime"), None);
            assert_eq!(arg_value(&args, "-prio_speed"), None);
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                Some("yuv420p")
            );
        }
        assert!(args.iter().any(|arg| arg == "-shortest"));
    }

    #[test]
    fn bridge_record_and_stream_tees_mkv_and_flv_targets() {
        let params = base_params(true, true);
        let fifo_path = Path::new("/tmp/videorc-bridge-record-stream.h264");
        let video_output = select_encoder_bridge_video_output(
            None,
            params.output.record_enabled,
            params.output.stream_enabled,
        );
        let streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let args = bridge_compositor_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-record-stream.mkv")),
            &targets,
            fifo_path,
            video_output,
        )
        .unwrap();

        // Record+stream defaults to MpegTs like every other shape (plan 023 L1:
        // the Annex-B stopgap wallclock-stamped recordings into slideshows).
        #[cfg(target_os = "macos")]
        assert_eq!(
            video_output,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(video_output, EncoderBridgeVideoOutput::RawYuv420p);
        #[cfg(target_os = "macos")]
        {
            // File output + one fifo-muxer FLV output per target — no tee
            // (mpegts→flv slaves reject the forwarded codec tag) and a
            // refused target can never abort the local recording.
            assert!(!args.contains(&"tee".to_string()));
            assert!(args.contains(&"/tmp/videorc-bridge-record-stream.mkv".to_string()));
            assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/yt".to_string()));
            assert!(args.contains(&"rtmp://live.twitch.tv/app/tw".to_string()));
            assert_eq!(
                args.windows(2)
                    .filter(|window| window[0] == "-f" && window[1] == "fifo")
                    .count(),
                2
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert!(args.contains(&"tee".to_string()));
            let tee = args.iter().find(|arg| arg.contains("[f=matroska")).unwrap();
            assert!(tee.contains("[f=matroska:onfail=abort]/tmp/videorc-bridge-record-stream.mkv"));
            assert_eq!(tee.matches("[f=flv").count(), 2);
        }
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        assert!(args.iter().any(|arg| arg == "-shortest"));
        assert!(!args.iter().any(|arg| arg == "[preview]"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(arg_value(&args, "-c:v"), Some("copy"));
            assert_eq!(arg_value(&args, "-filter_complex"), None);
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-f"),
                Some("mpegts")
            );
            // Minimal probing is load-bearing on FIFO inputs (LVF2).
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-probesize"),
                Some("65536")
            );
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-fflags"),
                None,
                "streaming MPEG-TS FIFO must preserve its initial keyframe"
            );
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                None
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(
                arg_value(&args, "-c:v"),
                Some(ffmpeg_h264_encoder(current_ffmpeg_h264_platform()).codec)
            );
            assert_eq!(arg_value(&args, "-allow_sw"), None);
            assert_eq!(arg_value(&args, "-realtime"), None);
            assert_eq!(arg_value(&args, "-prio_speed"), None);
            assert_eq!(
                input_arg_value(&args, &fifo_path.display().to_string(), "-pix_fmt"),
                Some("yuv420p")
            );
        }
    }

    #[test]
    fn split_output_bridge_args_use_separate_record_and_stream_encoded_inputs() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming.clone());
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let recording_fifo_path = Path::new("/tmp/videorc-bridge-recording-output.h264");
        let stream_fifo_path = Path::new("/tmp/videorc-bridge-stream-output.h264");
        let stream_output = recording_compositor_stream_output(
            &params,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        )
        .unwrap()
        .expect("split stream output");

        let args = bridge_compositor_split_output_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-record-stream-split.mkv")),
            &targets,
            recording_fifo_path,
            stream_fifo_path,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
            stream_output,
        )
        .unwrap();

        assert_eq!(
            ffmpeg_inputs(&args),
            vec![
                "sine=frequency=880:sample_rate=48000".to_string(),
                recording_fifo_path.display().to_string(),
                stream_fifo_path.display().to_string(),
            ]
        );
        assert_eq!(
            input_arg_value(&args, &recording_fifo_path.display().to_string(), "-f"),
            Some("mpegts")
        );
        assert_eq!(
            input_arg_value(&args, &stream_fifo_path.display().to_string(), "-f"),
            Some("mpegts")
        );
        // MpegTs carries real encoder PTS — no -framerate synthesis and no
        // wallclock stamping on either FIFO (plan 023: the wallclock path
        // wrote duplicate-PTS slideshow recordings).
        assert_eq!(
            input_arg_value(
                &args,
                &recording_fifo_path.display().to_string(),
                "-use_wallclock_as_timestamps"
            ),
            None
        );
        assert_eq!(
            input_arg_value(&args, &stream_fifo_path.display().to_string(), "-probesize"),
            Some("65536")
        );
        assert!(args.windows(2).any(|pair| pair == ["-map", "1:v"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "2:v"]));
        // File output + one fifo-muxer FLV output per target (plan 023 L1) —
        // three copy outputs total, no tee.
        assert_eq!(args.iter().filter(|arg| *arg == "-c:v").count(), 3);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "copy").count(), 3);
        assert!(args.contains(&"/tmp/videorc-bridge-record-stream-split.mkv".to_string()));
        assert!(!args.contains(&"tee".to_string()));
        assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/yt".to_string()));
        assert!(args.contains(&"rtmp://live.twitch.tv/app/tw".to_string()));
        assert_eq!(
            args.windows(2)
                .filter(|window| window[0] == "-f" && window[1] == "fifo")
                .count(),
            2,
            "every stream target must be an isolated fifo-muxer output: {args:?}"
        );
        assert_eq!(
            input_arg_value(&args, &recording_fifo_path.display().to_string(), "-f"),
            Some("mpegts")
        );
        assert_eq!(
            input_arg_value(
                &args,
                &recording_fifo_path.display().to_string(),
                "-probesize"
            ),
            Some("65536")
        );
        assert_eq!(
            input_arg_value(&args, &recording_fifo_path.display().to_string(), "-fflags"),
            None,
            "non-seekable MPEG-TS input must retain its first GOP; -fflags nobuffer drops it"
        );
        assert_eq!(
            input_arg_value(&args, &stream_fifo_path.display().to_string(), "-fflags"),
            None,
            "both split MPEG-TS FIFOs must preserve their first GOP"
        );
        assert_eq!(arg_value(&args, "-filter_complex"), None);
    }

    #[test]
    fn split_output_bridge_routes_mixed_youtube_4k_and_twitch_1080p_outputs() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming.clone());
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let recording_fifo_path = Path::new("/tmp/videorc-bridge-recording-output.h264");
        let stream_fifo_path = Path::new("/tmp/videorc-bridge-stream-output.h264");
        let stream_output = recording_compositor_stream_output(
            &params,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
        )
        .unwrap()
        .expect("1080p companion stream output");

        assert_eq!(
            stream_output,
            CompositorAuxiliaryOutput {
                width: 1920,
                height: 1080,
                frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            }
        );

        let args = bridge_compositor_split_output_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-record-stream-mixed.mkv")),
            &targets,
            recording_fifo_path,
            stream_fifo_path,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            stream_output,
        )
        .unwrap();

        assert!(!args.contains(&"tee".to_string()));
        assert!(args.contains(&"/tmp/videorc-bridge-record-stream-mixed.mkv".to_string()));
        assert!(args.contains(&"rtmp://a.rtmp.youtube.com/live2/yt".to_string()));
        assert!(args.contains(&"rtmp://live.twitch.tv/app/tw".to_string()));
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair == &["-map", "1:v"])
                .count(),
            2
        );
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair == &["-map", "2:v"])
                .count(),
            1
        );
        assert_eq!(args.iter().filter(|arg| *arg == "-c:v").count(), 3);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "copy").count(), 3);
    }

    #[test]
    fn split_output_bridge_args_reject_raw_video_input() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming.clone());
        let targets = stream_targets_from_streaming(&streaming).unwrap();
        let stream_output = CompositorAuxiliaryOutput {
            width: 1920,
            height: 1080,
            frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
        };

        let error = bridge_compositor_split_output_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-record-stream-split.mkv")),
            &targets,
            Path::new("/tmp/videorc-bridge-recording-output.yuv"),
            Path::new("/tmp/videorc-bridge-stream-output.h264"),
            EncoderBridgeVideoOutput::RawYuv420p,
            stream_output,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("encoded VideoToolbox H.264"), "{error}");
    }

    #[test]
    fn bridge_source_guard_requires_ready_native_sources() {
        let test_pattern = scene_with_sources(vec![scene_source(
            "source:test",
            SceneSourceKind::TestPattern,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        assert!(recording_encoder_bridge_sources_ready(
            &test_pattern,
            false,
            false,
            false
        ));

        let camera = scene_with_sources(vec![scene_source(
            "source:camera",
            SceneSourceKind::Camera,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        assert!(!recording_encoder_bridge_sources_ready(
            &camera, false, false, false
        ));
        assert!(recording_encoder_bridge_sources_ready(
            &camera, false, true, false
        ));

        let screen = scene_with_sources(vec![scene_source(
            "source:screen",
            SceneSourceKind::Screen,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        assert!(!recording_encoder_bridge_sources_ready(
            &screen, false, false, false
        ));
        assert!(recording_encoder_bridge_sources_ready(
            &screen, false, false, true
        ));
        assert!(recording_encoder_bridge_sources_ready(
            &screen, true, false, false
        ));

        // A takeover screen row only counts when its image file actually exists.
        assert!(!stream_screen_image_usable(None));
        let mut takeover = crate::protocol::StreamScreen {
            id: "screen-1".to_string(),
            name: "Takeover".to_string(),
            image_path: "/nonexistent/videorc-test-takeover.png".to_string(),
            thumbnail_path: None,
            sort_order: 0,
            status: crate::protocol::StreamScreenStatus::Ready,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert!(!stream_screen_image_usable(Some(&takeover)));
        let image_dir = std::env::temp_dir().join(format!("videorc-takeover-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&image_dir).expect("create takeover dir");
        let image_path = image_dir.join("takeover.png");
        std::fs::write(&image_path, b"png").expect("write takeover image");
        takeover.image_path = image_path.to_string_lossy().into_owned();
        assert!(stream_screen_image_usable(Some(&takeover)));
        let _ = std::fs::remove_dir_all(&image_dir);

        assert!(encoder_bridge_recording_disabled(Some("legacy")));
        assert!(encoder_bridge_streaming_disabled(Some("off")));
        assert!(encoder_bridge_disabled_setting(Some("0")));
        assert!(!encoder_bridge_recording_disabled(None));
        let default_output = default_encoder_bridge_video_output();
        assert_eq!(
            parse_encoder_bridge_video_output(None, default_output),
            default_output
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("  "), default_output),
            default_output
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("raw-yuv420p"), default_output),
            EncoderBridgeVideoOutput::RawYuv420p
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("raw"), default_output),
            EncoderBridgeVideoOutput::RawYuv420p
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("debug-typo"), default_output),
            default_output
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("videotoolbox-h264"), default_output),
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some(" annex-b "), default_output),
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some("videotoolbox-h264-mpegts"), default_output),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        assert_eq!(
            parse_encoder_bridge_video_output(Some(" mpeg-ts "), default_output),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        // Plan 023 L1: record+stream defaults to MpegTs — the Annex-B
        // stopgap is env-opt-in only.
        #[cfg(target_os = "macos")]
        assert_eq!(
            select_encoder_bridge_video_output(None, true, true),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            select_encoder_bridge_video_output(None, true, true),
            EncoderBridgeVideoOutput::RawYuv420p
        );
        assert_eq!(
            select_encoder_bridge_video_output(None, true, false),
            default_output
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            select_encoder_bridge_video_output(None, false, true),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            select_encoder_bridge_video_output(None, false, true),
            EncoderBridgeVideoOutput::RawYuv420p
        );
        assert_eq!(
            select_encoder_bridge_video_output(Some("mpeg-ts"), true, true),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
        );
    }

    // Rounded camera bubble (2026-07-06): the FFmpeg mask derives from the same
    // constants as the CPU/Metal paths — radius = pct% of min(w,h), SDF on the
    // full box. Pin the generated filter so a refactor cannot silently drift
    // the recording leg away from the previews.
    #[test]
    fn rounded_alpha_mask_filter_uses_min_side_radius_sdf() {
        // 200x100 box at 20% → radius 20, inner half extents (80, 30).
        let filter = rounded_alpha_mask_filter(200, 100, 20);
        assert!(filter.contains("geq="), "{filter}");
        assert!(filter.contains("abs(X-100.000)-80.000"), "{filter}");
        assert!(filter.contains("abs(Y-50.000)-30.000"), "{filter}");
        assert!(filter.contains("400.000"), "radius² term: {filter}");

        // Radius clamps at 50% (a pill) even if the pct is out of range.
        let clamped = rounded_alpha_mask_filter(100, 100, 400);
        assert!(clamped.contains("2500.000"), "{clamped}");
    }

    #[test]
    fn camera_rounded_mask_pct_only_applies_to_screen_camera_rounded() {
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = LayoutPreset::ScreenCamera;
        layout.camera_shape = CameraShape::Rounded;
        layout.camera_corner_radius_pct = 18;
        assert_eq!(camera_rounded_mask_pct(&layout), Some(18));

        layout.camera_shape = CameraShape::Circle;
        assert_eq!(camera_rounded_mask_pct(&layout), None);

        layout.camera_shape = CameraShape::Rounded;
        layout.layout_preset = LayoutPreset::SideBySide;
        assert_eq!(camera_rounded_mask_pct(&layout), None);
    }

    #[test]
    fn native_source_health_copy_matches_selected_recording_path() {
        assert!(native_screen_recording_path_message(true).contains("protected compositor"));
        assert!(native_camera_recording_path_message(true).contains("protected compositor"));
        assert!(camera_circle_recording_path_message(true).contains("compositor recording path"));
        assert!(
            native_screen_recording_path_message(false).contains("FFmpeg AVFoundation fallback")
        );
        assert!(
            native_window_recording_path_message(false).contains("FFmpeg AVFoundation fallback")
        );
    }

    #[test]
    fn camera_cadence_guard_requires_fresh_stable_sample_pts() {
        let threshold = camera_cadence_ready_threshold_ms(30);

        assert!(threshold > 69.0 && threshold < 71.0);
        // macOS AVFoundation path: gated on the per-sample PTS cadence.
        assert!(camera_cadence_ready(
            Some(33.3),
            Some(30.0),
            Some(40),
            threshold
        ));
        assert!(camera_cadence_ready(
            Some(66.7),
            Some(30.0),
            Some(40),
            threshold
        ));
        assert!(!camera_cadence_ready(
            Some(83.3),
            Some(30.0),
            Some(40),
            threshold
        ));
        assert!(!camera_cadence_ready(
            Some(33.3),
            Some(30.0),
            Some(300),
            threshold
        ));
    }

    #[test]
    fn camera_cadence_guard_falls_back_to_callback_cadence_without_sample_pts() {
        // The Windows FFmpeg/dshow path reports no per-sample PTS, so the gate
        // must not require it — otherwise recording is blocked forever (the
        // tester's "cadence did not settle, sample PTS p95 n/a"). It falls back
        // to a fresh, sustained callback cadence within a lenient budget.
        let threshold = camera_cadence_ready_threshold_ms(30);

        // The exact tester numbers: no sample PTS, callback p95 76.9ms, age 37ms.
        assert!(camera_cadence_ready(None, Some(76.9), Some(37), threshold));
        // A truly stalled camera (callback p95 far over the lenient budget) or
        // stale frames still block.
        assert!(!camera_cadence_ready(
            None,
            Some(200.0),
            Some(37),
            threshold
        ));
        assert!(!camera_cadence_ready(
            None,
            Some(76.9),
            Some(300),
            threshold
        ));
        // No frames and no callback cadence at all is not ready.
        assert!(!camera_cadence_ready(None, None, Some(40), threshold));
        assert!(!camera_cadence_ready(None, Some(76.9), None, threshold));
    }

    #[test]
    fn recording_startup_barrier_requires_visible_real_scene_sources() {
        let test_pattern = scene_with_sources(vec![scene_source(
            "source:test",
            SceneSourceKind::TestPattern,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        assert_eq!(
            recording_startup_source_requirements(&test_pattern),
            CompositorStartupSourceRequirements {
                require_real_source: false,
                require_camera_source: false,
                require_screen_source: false,
            }
        );

        let screen_camera = scene_with_sources(vec![
            scene_source(
                "source:screen",
                SceneSourceKind::Screen,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            scene_source(
                "source:camera",
                SceneSourceKind::Camera,
                scene_transform(0.7, 0.7, 0.25, 0.25),
                true,
            ),
            scene_source(
                "source:hidden-window",
                SceneSourceKind::Window,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                false,
            ),
        ]);
        assert_eq!(
            recording_startup_source_requirements(&screen_camera),
            CompositorStartupSourceRequirements {
                require_real_source: true,
                require_camera_source: true,
                require_screen_source: true,
            }
        );
    }

    #[tokio::test]
    async fn bridge_compositor_uses_recording_fps_without_native_surface() {
        let state = test_state();
        let video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };

        assert_eq!(recording_compositor_target_fps(&state, &video).await, 30);
    }

    #[tokio::test]
    async fn bridge_compositor_uses_recording_fps_for_electron_surface() {
        let state = test_state();
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.status.transport = PreviewTransport::ElectronProofSurface;
            surface.status.backing = PreviewSurfaceBacking::ElectronBrowserWindow;
            surface.status.target_fps = 60;
        }
        let video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };

        assert_eq!(recording_compositor_target_fps(&state, &video).await, 30);
    }

    #[tokio::test]
    async fn bridge_compositor_uses_recording_fps_when_native_preview_is_live() {
        let state = test_state();
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.status.transport = PreviewTransport::NativeSurface;
            surface.status.backing = PreviewSurfaceBacking::CaMetalLayer;
            surface.status.target_fps = 60;
        }
        let video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        };

        assert_eq!(recording_compositor_target_fps(&state, &video).await, 30);
    }

    #[test]
    fn capture_audio_filter_keeps_mic_processing_stable() {
        assert!(CAPTURE_AUDIO_FILTER.contains("aresample=async=1:first_pts=0"));
        assert!(!CAPTURE_AUDIO_FILTER.contains("volume="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("dynaudnorm="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("alimiter="));
        assert!(!CAPTURE_AUDIO_FILTER.contains("volume=24dB"));
    }

    fn microphone_input_layout(microphone_graph_gain: bool) -> InputLayout {
        InputLayout {
            video_input_index: 0,
            camera_input_index: None,
            screen_overlay_input_index: None,
            audio_inputs: vec![AudioInput {
                input_index: 1,
                track: microphone_audio_track(),
                channels: NATIVE_AUDIO_CHANNELS,
            }],
            microphone_graph_gain,
        }
    }

    // The native CoreAudio path applies gain/mute in-process; the ffmpeg-owned
    // dshow mic (Windows) records the raw signal, so gain/mute must ride the
    // filter graph or the mute toggle silently records live audio.
    #[test]
    fn capture_audio_filter_applies_graph_gain_only_for_ffmpeg_owned_mics() {
        let audio = AudioSettings {
            microphone_gain_db: 6.5,
            microphone_muted: false,
            microphone_sync_offset_ms: 0,
        };

        let native = capture_audio_filter(&microphone_input_layout(false), &audio);
        assert!(
            !native.contains("volume="),
            "native mic path must not double-apply gain: {native}"
        );

        let graph = capture_audio_filter(&microphone_input_layout(true), &audio);
        assert!(
            graph.contains("volume=6.5dB"),
            "ffmpeg-owned mic must carry gain in the graph: {graph}"
        );
    }

    #[test]
    fn capture_audio_filter_mutes_ffmpeg_owned_mics_with_silence_not_track_loss() {
        let audio = AudioSettings {
            microphone_gain_db: 6.5,
            microphone_muted: true,
            microphone_sync_offset_ms: 0,
        };

        let filter = capture_audio_filter(&microphone_input_layout(true), &audio);
        assert!(
            filter.contains("volume=0"),
            "muted ffmpeg-owned mic must record digital silence: {filter}"
        );
        assert!(
            !filter.contains("6.5dB"),
            "mute must win over gain, matching the native in-process path: {filter}"
        );
        assert!(
            filter.contains(CAPTURE_AUDIO_FILTER),
            "resample contract stays regardless of gain handling: {filter}"
        );
    }

    #[test]
    fn default_recordings_dir_uses_videorc_media_folder() {
        let path = default_recordings_dir();
        let media_component = if cfg!(target_os = "windows") {
            "Videos"
        } else {
            "Movies"
        };

        assert!(path.iter().any(|c| c == media_component));
        assert!(path.ends_with(PathBuf::from("Videorc").join("Recordings")));
    }

    // Regression (2026-07-06): a Settings value of "~/Movies/…" was used as a
    // LITERAL relative path — ffmpeg resolved it against the backend cwd and
    // wrote two recordings INSIDE the signed app bundle
    // (/Applications/Videorc.app/Contents/~/…). Tilde must expand; anything
    // still relative must be refused, never written relative to cwd.
    #[test]
    fn output_directory_expands_tilde_and_refuses_relative_paths() {
        let expanded = expand_user_path("~/Movies/Videorc");
        assert!(expanded.is_absolute());
        assert!(expanded.ends_with(PathBuf::from("Movies").join("Videorc")));
        assert!(!expanded.iter().any(|component| component == "~"));

        let resolved = resolve_output_directory(Some("~/Movies/Videorc")).unwrap();
        assert!(resolved.is_absolute());

        let error = resolve_output_directory(Some("Movies/Videorc")).unwrap_err();
        assert!(error.to_string().contains("not a full path"), "{error}");

        assert_eq!(
            resolve_output_directory(Some("  ")).unwrap(),
            default_recordings_dir()
        );
        assert_eq!(
            resolve_output_directory(None).unwrap(),
            default_recordings_dir()
        );

        // Absolute paths pass through untouched. ("/tmp/…" is not absolute
        // on Windows — no drive letter — so the fixture is per-platform.)
        let absolute_fixture = if cfg!(target_os = "windows") {
            r"C:\videorc-out"
        } else {
            "/tmp/videorc-out"
        };
        assert_eq!(
            resolve_output_directory(Some(absolute_fixture)).unwrap(),
            PathBuf::from(absolute_fixture)
        );
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
                transport: PreviewTransport::LatestJpegPolling,
                backing: PreviewSurfaceBacking::None,
                target_fps: Some(IDLE_PREVIEW_FPS),
                width: Some(IDLE_PREVIEW_WIDTH),
                height: Some(IDLE_PREVIEW_HEIGHT),
                url: Some("http://127.0.0.1:1234/preview/live.mjpeg?token=test".to_string()),
                message: Some("Starting explicit JPEG polling fallback preview.".to_string()),
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
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(arg_value(&args, "-ar"), Some("48000"));
        assert_eq!(arg_value(&args, "-ac"), Some("2"));
        assert_eq!(arg_value(&args, "-c:a"), Some("aac"));
        assert_eq!(arg_value(&args, "-b:a"), Some("160k"));
        assert_current_h264_encoder_args(&args);
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
    fn record_only_scene_filter_uses_committed_source_visibility() {
        let mut params = base_params(true, false);
        params.scene = Some(scene_with_sources(vec![
            scene_source(
                "screen",
                SceneSourceKind::Screen,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            scene_source(
                "camera",
                SceneSourceKind::Camera,
                scene_transform(0.7, 0.7, 0.25, 0.25),
                false,
            ),
        ]));

        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[],
            None,
        )
        .unwrap();

        let filter = arg_value(&args, "-filter_complex").unwrap();
        assert!(filter.contains("scene_canvas0"));
        assert!(filter.contains("[0:v]setpts=PTS-STARTPTS"));
        assert!(!filter.contains("[1:v]setpts=PTS-STARTPTS"));
        assert!(filter.contains("[v]split=2[v_main][v_preview]"));
    }

    #[test]
    fn scene_filter_with_background_insets_screen_like_sources_to_eighty_percent_stage() {
        let mut params = base_params(true, false);
        params.output.video.width = 100;
        params.output.video.height = 100;
        let mut scene = scene_with_sources(vec![
            scene_source(
                "screen",
                SceneSourceKind::Screen,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            scene_source(
                "camera",
                SceneSourceKind::Camera,
                scene_transform(0.75, 0.7, 0.2, 0.2),
                true,
            ),
        ]);
        scene.background = Some(EffectiveSceneBackground {
            asset_id: "builtin-bg-01".to_string(),
            managed_asset_path: "/Users/me/Application Support/Videorc/code-demo.webp".to_string(),
            fit: BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
        });
        params.scene = Some(scene);

        let filter = recording_video_filter(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: None,
            },
            &InputLayout {
                video_input_index: 0,
                camera_input_index: Some(1),
                screen_overlay_input_index: None,
                audio_inputs: Vec::new(),
                microphone_graph_gain: false,
            },
            &params,
            false,
        );

        assert!(
            filter
                .contains("movie=filename='/Users/me/Application Support/Videorc/code-demo.webp'")
        );
        assert!(filter.contains("scale=100:100:force_original_aspect_ratio=increase,crop=100:100"));
        assert!(filter.contains("[0:v]setpts=PTS-STARTPTS"));
        // Screen CONTAINS within the stage (letterbox, never crop the screen).
        assert!(filter.contains("scale=80:80:force_original_aspect_ratio=decrease"));
        assert!(filter.contains("overlay=x=10:y=10"));
        assert!(filter.contains("[1:v]setpts=PTS-STARTPTS"));
        assert!(filter.contains("scale=20:20"));
        assert!(filter.contains("overlay=x=75:y=70"));
    }

    #[test]
    fn scene_filter_without_background_keeps_sources_full_canvas() {
        // The user-facing contract for "Remove from scene": with no digital
        // background there is no inset stage — the recording fills the full
        // canvas (screen back to 100%, camera at its uncompressed transform).
        let mut params = base_params(true, false);
        params.output.video.width = 100;
        params.output.video.height = 100;
        let mut scene = scene_with_sources(vec![
            scene_source(
                "screen",
                SceneSourceKind::Screen,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            scene_source(
                "camera",
                SceneSourceKind::Camera,
                scene_transform(0.75, 0.7, 0.2, 0.2),
                true,
            ),
        ]);
        scene.background = None;
        params.scene = Some(scene);

        let filter = recording_video_filter(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: None,
            },
            &InputLayout {
                video_input_index: 0,
                camera_input_index: Some(1),
                screen_overlay_input_index: None,
                audio_inputs: Vec::new(),
                microphone_graph_gain: false,
            },
            &params,
            false,
        );

        assert!(!filter.contains("movie=filename="));
        // Screen CONTAINS at full canvas (letterbox, never crop the screen —
        // cover used to hide the Dock on screens whose aspect differs from the
        // output canvas).
        assert!(filter.contains("scale=100:100:force_original_aspect_ratio=decrease"));
        assert!(filter.contains("overlay=x=0:y=0"));
        assert!(filter.contains("scale=20:20"));
        assert!(filter.contains("overlay=x=75:y=70"));
    }

    #[test]
    fn background_visibility_scales_the_recording_stage() {
        let mut params = base_params(true, false);
        params.output.video.width = 100;
        params.output.video.height = 100;
        let base_scene = scene_with_sources(vec![scene_source(
            "screen",
            SceneSourceKind::Screen,
            scene_transform(0.0, 0.0, 1.0, 1.0),
            true,
        )]);
        let background = |visibility: f64| EffectiveSceneBackground {
            asset_id: "builtin-bg-01".to_string(),
            managed_asset_path: "/Users/me/Application Support/Videorc/code-demo.webp".to_string(),
            fit: BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: visibility,
        };
        let filter_at = |visibility: f64| {
            let mut scene = base_scene.clone();
            scene.background = Some(background(visibility));
            let mut params = params.clone();
            params.scene = Some(scene);
            recording_video_filter(
                &CaptureInputs {
                    video: VideoInput::MacScreen { index: 3 },
                    camera_index: None,
                    microphone: None,
                },
                &InputLayout {
                    video_input_index: 0,
                    camera_input_index: None,
                    screen_overlay_input_index: None,
                    audio_inputs: Vec::new(),
                    microphone_graph_gain: false,
                },
                &params,
                false,
            )
        };

        // Visibility 0: the background still renders, but the recording fills
        // the full canvas over it.
        let invisible = filter_at(0.0);
        assert!(invisible.contains("movie=filename="));
        assert!(invisible.contains("scale=100:100:force_original_aspect_ratio=decrease"));
        assert!(invisible.contains("overlay=x=0:y=0"));

        // Visibility 40: a 60% stage inset by 20% per side.
        let prominent = filter_at(40.0);
        assert!(prominent.contains("scale=60:60:force_original_aspect_ratio=decrease"));
        assert!(prominent.contains("overlay=x=20:y=20"));
    }

    #[test]
    fn stream_only_scene_filter_uses_committed_source_order() {
        let mut params = base_params(false, true);
        params.scene = Some(scene_with_sources(vec![
            scene_source(
                "camera",
                SceneSourceKind::Camera,
                scene_transform(0.0, 0.0, 0.5, 1.0),
                true,
            ),
            scene_source(
                "screen",
                SceneSourceKind::Screen,
                scene_transform(0.5, 0.0, 0.5, 1.0),
                true,
            ),
        ]));

        let args = ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::MacScreen { index: 3 },
                camera_index: Some(0),
                microphone: None,
            },
            &params,
            None,
            &[build_stream_url(&params.output.rtmp).unwrap()],
            None,
        )
        .unwrap();

        assert_eq!(arg_value(&args, "-f"), Some("avfoundation"));
        assert!(args.iter().any(|arg| arg == "flv"));

        let filter = arg_value(&args, "-filter_complex").unwrap();
        let camera_layer = filter.find("[1:v]setpts=PTS-STARTPTS").unwrap();
        let screen_layer = filter.find("[0:v]setpts=PTS-STARTPTS").unwrap();
        let first_overlay = filter.find("[scene_canvas0][scene_layer0]").unwrap();
        let second_overlay = filter.find("[scene_canvas1][scene_layer1]").unwrap();
        assert!(camera_layer < screen_layer, "{filter}");
        assert!(first_overlay < second_overlay, "{filter}");
        assert!(filter.contains("[v]split=2[v_main][v_preview]"));
    }

    #[test]
    fn record_and_stream_scene_filter_preserves_overlay_fifo_and_tee_output() {
        let mut params = base_params(true, true);
        params.scene = Some(scene_with_sources(vec![
            scene_source(
                "screen",
                SceneSourceKind::Screen,
                scene_transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            scene_source(
                "camera",
                SceneSourceKind::Camera,
                scene_transform(0.75, 0.72, 0.2, 0.2),
                true,
            ),
        ]));
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
                microphone: None,
            },
            &params,
            Some(Path::new("/tmp/videorc-test.mkv")),
            &[build_stream_url(&params.output.rtmp).unwrap()],
            Some(&overlay),
        )
        .unwrap();

        assert!(args.contains(&"tee".to_string()));
        assert_eq!(
            ffmpeg_inputs(&args),
            vec!["3:none", "0:none", "/tmp/videorc-screen-overlay-test.rgba"]
        );

        let filter = arg_value(&args, "-filter_complex").unwrap();
        assert!(filter.contains("scene_canvas0"));
        assert!(filter.contains("[0:v]setpts=PTS-STARTPTS"));
        assert!(filter.contains("[1:v]setpts=PTS-STARTPTS"));
        assert!(filter.contains("[v][2:v]overlay=x=0:y=0"));
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
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
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
            Some("1024")
        );
        assert!(args.iter().any(|arg| arg == "1:a?"));
        assert_eq!(
            arg_value(&args, "-af"),
            Some("aresample=async=1:first_pts=0")
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

        params.audio.microphone_sync_offset_ms = -120;
        let trimmed = ffmpeg_args(
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
            Some("adelay=120:all=1,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
        assert_eq!(
            arg_value(&trimmed, "-af"),
            Some(
                "atrim=start=0.120,asetpts=PTS-STARTPTS,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0"
            )
        );
        assert_eq!(
            arg_value(&disabled, "-af"),
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
    }

    #[test]
    fn default_microphone_sync_offset_compensates_capture_latency() {
        let mut params = base_params(true, false);
        params.audio = AudioSettings::default();
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

        // Default offset is 0 (alignment is structural via the video epoch), so the
        // chain carries the channel/resample processing only — no compensating trim.
        assert_eq!(
            arg_value(&args, "-af"),
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
        );
    }

    #[test]
    fn default_microphone_sync_offset_applies_to_native_coreaudio_fifo() {
        // A/V alignment is structural (the audio FIFO writer trims to the encoder
        // bridge's first-frame epoch), so the DEFAULT offset is 0 and the filter
        // chain must carry no compensating trim/delay — the offset is a pure manual
        // trim that only appears when a user sets it.
        let mut params = base_params(true, false);
        params.audio = AudioSettings::default();
        let args = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: Some(MicrophoneInput::CoreAudio {
                    device_id: 42,
                    fifo_path: Some(PathBuf::from("/tmp/videorc-audio-test.f32le")),
                }),
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            Path::new("/tmp/videorc-bridge-input.ts"),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        )
        .unwrap();

        assert_eq!(
            arg_value(&args, "-af"),
            Some("aresample=async=1:first_pts=0")
        );

        // An explicit user trim still flows into the chain.
        params.audio.microphone_sync_offset_ms = -250;
        let trimmed = bridge_recording_ffmpeg_args(
            &CaptureInputs {
                video: VideoInput::TestPattern,
                camera_index: None,
                microphone: Some(MicrophoneInput::CoreAudio {
                    device_id: 42,
                    fifo_path: Some(PathBuf::from("/tmp/videorc-audio-test.f32le")),
                }),
            },
            &params,
            Some(Path::new("/tmp/videorc-bridge-test.mkv")),
            Path::new("/tmp/videorc-bridge-input.ts"),
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        )
        .unwrap();
        assert_eq!(
            arg_value(&trimmed, "-af"),
            Some("atrim=start=0.250,asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0")
        );
    }

    #[test]
    fn stream_output_audio_settings_apply_stream_only_egress_advance() {
        assert_eq!(STREAM_OUTPUT_AUDIO_ADVANCE_MS, 130);
        let audio = AudioSettings::default();
        let adjusted = stream_output_audio_settings(&audio);
        assert_eq!(audio.microphone_sync_offset_ms, 0);
        assert_eq!(
            adjusted.microphone_sync_offset_ms,
            -STREAM_OUTPUT_AUDIO_ADVANCE_MS
        );

        let mut tuned = AudioSettings::default();
        tuned.microphone_sync_offset_ms = 80;
        assert_eq!(
            stream_output_audio_settings(&tuned).microphone_sync_offset_ms,
            80 - STREAM_OUTPUT_AUDIO_ADVANCE_MS
        );

        let mut near_min = AudioSettings::default();
        near_min.microphone_sync_offset_ms = MICROPHONE_SYNC_OFFSET_MIN_MS + 10;
        assert_eq!(
            stream_output_audio_settings(&near_min).microphone_sync_offset_ms,
            MICROPHONE_SYNC_OFFSET_MIN_MS
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
        assert!(args.iter().any(|arg| arg.contains("pad=640:360")));
        assert!(args.iter().any(|arg| arg == "-an"));
        assert!(args.iter().any(|arg| arg == "mjpeg"));
        assert_eq!(arg_value(&args, "-q:v"), Some("6"));
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
        assert!(args.iter().any(|arg| arg.contains("fps=10")));
        assert!(args.iter().any(|arg| arg.contains("setpts=PTS-STARTPTS")));
        assert!(args.iter().any(|arg| arg == "[preview]"));
        assert_eq!(arg_value(&args, "-q:v"), Some("4"));
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

        assert_eq!(session.output.video.width, IDLE_PREVIEW_WIDTH);
        assert_eq!(session.output.video.height, IDLE_PREVIEW_HEIGHT);
        assert_eq!(session.output.video.fps, 30);
        assert_eq!(session.output.video.bitrate_kbps, 1500);
    }

    #[test]
    fn recording_camera_overlay_scales_to_match_idle_preview_size() {
        let recording = base_params(true, false);
        let capture = CaptureInputs {
            video: VideoInput::MacScreen { index: 3 },
            camera_index: Some(0),
            microphone: None,
        };
        let input_layout = InputLayout {
            video_input_index: 0,
            camera_input_index: Some(1),
            screen_overlay_input_index: None,
            audio_inputs: Vec::new(),
            microphone_graph_gain: false,
        };
        let recording_filter = recording_video_filter(&capture, &input_layout, &recording, true);
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
            Some("pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0")
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
    fn scene_camera_circle_mask_only_applies_to_screen_camera_layout() {
        let mut params = base_params(true, false);
        params.layout.camera_shape = CameraShape::Circle;
        let transform = SceneTransform {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };

        let screen_camera = scene_source_layer_filter(
            1,
            "camera",
            &SceneSourceKind::Camera,
            &transform,
            1280,
            720,
            &params,
        );
        assert!(screen_camera.contains("geq="));

        params.layout.layout_preset = LayoutPreset::CameraOnly;
        let camera_only = scene_source_layer_filter(
            0,
            "camera",
            &SceneSourceKind::Camera,
            &transform,
            1280,
            720,
            &params,
        );
        assert!(!camera_only.contains("geq="));

        params.layout.layout_preset = LayoutPreset::SideBySide;
        let side_by_side = scene_source_layer_filter(
            1,
            "camera",
            &SceneSourceKind::Camera,
            &transform,
            640,
            720,
            &params,
        );
        assert!(!side_by_side.contains("geq="));
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

        let capture = CaptureInputs {
            video: VideoInput::MacScreen { index: 3 },
            camera_index: Some(0),
            microphone: None,
        };
        let input_layout = InputLayout {
            video_input_index: 0,
            camera_input_index: Some(1),
            screen_overlay_input_index: None,
            audio_inputs: Vec::new(),
            microphone_graph_gain: false,
        };
        let recording = recording_video_filter(&capture, &input_layout, &params, false);
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
    fn entitlement_guard_allows_local_recording_in_basic_mode() {
        let params = base_params(true, false);
        let snapshot = entitlements::basic_entitlements();

        validate_session_entitlements(&params, &snapshot).unwrap();
    }

    #[test]
    fn entitlement_guard_allows_one_basic_livestream() {
        let mut params = base_params(false, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
        let snapshot = entitlements::basic_entitlements();

        validate_session_entitlements(&params, &snapshot).unwrap();
    }

    #[test]
    fn entitlement_guard_blocks_basic_multistreaming() {
        let mut params = base_params(false, true);
        params.streaming = Some(streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "youtube-key",
            ),
            (
                StreamPlatform::Twitch,
                "rtmp://live.twitch.tv/app",
                "twitch-key",
            ),
        ]));
        let snapshot = entitlements::basic_entitlements();
        let error = validate_session_entitlements(&params, &snapshot)
            .expect_err("Basic should allow only one ready livestream destination");

        assert!(error.to_string().contains("Multistreaming requires"));
    }

    #[test]
    fn entitlement_guard_allows_livestreaming_with_developer_override() {
        let mut params = base_params(false, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
        let snapshot = entitlements::developer_test_entitlements();

        validate_session_entitlements(&params, &snapshot).unwrap();
    }

    #[test]
    fn entitlement_guard_allows_multistreaming_with_developer_override() {
        let mut params = base_params(false, true);
        params.streaming = Some(streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "youtube-key",
            ),
            (
                StreamPlatform::Twitch,
                "rtmp://live.twitch.tv/app",
                "twitch-key",
            ),
        ]));
        let snapshot = entitlements::developer_test_entitlements();

        validate_session_entitlements(&params, &snapshot).unwrap();
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn entitlement_guard_blocks_true_4k_streaming_on_basic() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "youtube-key",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);
        let snapshot = entitlements::basic_entitlements();
        let error = validate_session_entitlements(&params, &snapshot)
            .expect_err("Basic streams HD only — true 4K streaming is Premium");

        assert!(
            error
                .to_string()
                .contains("allows livestreaming up to 1920x1080"),
            "{error}"
        );
    }

    // 4K streaming is a Premium feature (2026-07-06): premium streams up to
    // 4K30; only basic stays HD. Recording is never the blocker — every tier
    // records 4K.
    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn entitlement_guard_allows_true_4k_streaming_on_premium() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "youtube-key",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);
        let snapshot = entitlements::premium_entitlements(EntitlementSource::Creem);

        validate_session_entitlements(&params, &snapshot).unwrap();
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn entitlement_guard_allows_true_4k_streaming_with_developer_override() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "youtube-key",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);
        let snapshot = entitlements::developer_test_entitlements();

        validate_session_entitlements(&params, &snapshot).unwrap();
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

    #[test]
    fn accepts_record_4k30_for_local_recording() {
        let mut params = base_params(true, false);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };

        validate_outputs(&params).unwrap();
    }

    #[test]
    fn accepts_record_4k60_only_as_experimental_local_recording() {
        let mut params = base_params(true, false);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k60Experimental,
            width: 3840,
            height: 2160,
            fps: 60,
            bitrate_kbps: 50_000,
        };

        validate_outputs(&params).unwrap();

        params.output.video.preset = VideoPreset::Custom;
        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(error.contains("4K60 is experimental"), "{error}");
    }

    #[test]
    fn split_output_profiles_resolve_4k_record_and_1080p_stream() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        let profiles = resolve_split_output_profiles(&params).unwrap();

        assert_eq!(profiles.recording.as_ref().unwrap().width, 3840);
        assert_eq!(profiles.recording.as_ref().unwrap().height, 2160);
        assert_eq!(
            profiles.stream,
            Some(VideoSettings {
                preset: VideoPreset::StreamSafe1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            })
        );
    }

    #[test]
    fn split_output_compositor_stream_output_uses_stream_safe_dimensions_for_videotoolbox() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        let output = recording_compositor_stream_output(
            &params,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
        )
        .unwrap();

        assert_eq!(
            output,
            Some(CompositorAuxiliaryOutput {
                width: 1920,
                height: 1080,
                frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            })
        );
    }

    #[test]
    fn comment_highlight_requires_a_composited_stream_leg() {
        assert!(!comment_highlight_available(
            &base_params(true, false),
            true
        ));
        assert!(!comment_highlight_available(
            &base_params(false, true),
            false
        ));
        assert!(!comment_highlight_available(
            &base_params(true, true),
            false
        ));
        assert!(comment_highlight_available(&base_params(false, true), true));
        assert!(comment_highlight_available(&base_params(true, true), true));
    }

    #[test]
    fn caption_burn_in_forces_a_same_profile_stream_leg() {
        // Same-profile record+stream normally shares frames (no aux leg);
        // burn-in must force a separate stream leg so the recording stays clean.
        // No StreamingSettings → the stream output IS the recording profile.
        let mut params = base_params(true, true);
        params.streaming = None;

        let without_burn_in = recording_compositor_stream_output(
            &params,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
        )
        .unwrap();
        assert_eq!(without_burn_in, None);

        params.captions = Some(crate::protocol::CaptionsSessionParams {
            burn_in_enabled: true,
            ..Default::default()
        });
        let with_burn_in = recording_compositor_stream_output(
            &params,
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
        )
        .unwrap();
        assert_eq!(
            with_burn_in,
            Some(CompositorAuxiliaryOutput {
                width: params.output.video.width,
                height: params.output.video.height,
                frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            })
        );
    }

    #[test]
    fn split_output_compositor_stream_output_requires_record_stream_and_videotoolbox() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        assert_eq!(
            recording_compositor_stream_output(&params, EncoderBridgeVideoOutput::RawYuv420p)
                .unwrap(),
            None
        );

        let mut stream_only = params.clone();
        stream_only.output.record_enabled = false;
        assert_eq!(
            recording_compositor_stream_output(
                &stream_only,
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            )
            .unwrap(),
            None
        );

        let mut same_size = base_params(true, true);
        same_size.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
        let mut same_size_streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        same_size_streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        same_size_streaming.default_bitrate_kbps = 6000;
        same_size.streaming = Some(same_size_streaming);
        assert_eq!(
            recording_compositor_stream_output(
                &same_size,
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn split_output_profiles_reject_stream_preset_above_1080p() {
        let mut params = base_params(true, true);
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::Tutorial1440p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        let error = resolve_split_output_profiles(&params)
            .unwrap_err()
            .to_string();

        assert!(error.contains("1080p or lower"), "{error}");
    }

    #[test]
    fn split_output_profiles_reject_stream_bitrate_above_platform_limit() {
        let mut params = base_params(true, true);
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 9000;
        params.streaming = Some(streaming);

        let error = resolve_split_output_profiles(&params)
            .unwrap_err()
            .to_string();

        assert!(error.contains("6000 kbps or lower"), "{error}");
    }

    #[test]
    fn split_output_profiles_resolve_1080p_stream_only() {
        let mut params = base_params(false, true);
        let mut streaming =
            streaming_for(&[(StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw")]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p60;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        let profiles = resolve_split_output_profiles(&params).unwrap();

        assert!(profiles.recording.is_none());
        assert_eq!(
            profiles.stream,
            Some(VideoSettings {
                preset: VideoPreset::StreamSafe1080p60,
                width: 1920,
                height: 1080,
                fps: 60,
                bitrate_kbps: 6000,
            })
        );
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn split_output_profiles_resolve_youtube_4k30_true_stream() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);

        let profiles = resolve_split_output_profiles(&params).unwrap();

        assert_eq!(
            profiles.stream,
            Some(VideoSettings {
                preset: VideoPreset::StreamYoutube4k30,
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            })
        );
        assert_eq!(
            recording_compositor_stream_output(
                &params,
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            )
            .unwrap(),
            None
        );
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn split_output_profiles_allow_youtube_4k_with_twitch_1080p_companion() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);

        let profiles = resolve_split_output_profiles(&params).unwrap();

        assert_eq!(
            profiles.stream,
            Some(VideoSettings {
                preset: VideoPreset::StreamYoutube4k30,
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            })
        );
        assert_eq!(
            recording_compositor_stream_output(
                &params,
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            )
            .unwrap(),
            Some(CompositorAuxiliaryOutput {
                width: 1920,
                height: 1080,
                frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            })
        );
        validate_outputs(&params).unwrap();
    }

    #[test]
    fn video_profile_policy_characterizes_plan_006_v1_boundaries() {
        // Plans 005/006 accepted split-output behavior: 4K local recording may
        // stream only through an explicit <=1080p output profile, while
        // stream-only/custom 4K remains blocked for v1.
        let mut stream_only_4k = base_params(false, true);
        stream_only_4k.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let error = validate_outputs(&stream_only_4k).unwrap_err().to_string();
        assert!(error.contains("4K livestreaming is not enabled"), "{error}");

        let mut high_bitrate_stream = base_params(false, true);
        high_bitrate_stream.output.video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 9000,
        };
        let error = validate_outputs(&high_bitrate_stream)
            .unwrap_err()
            .to_string();
        assert!(error.contains("6000 kbps or lower"), "{error}");

        let mut record_only_4k = base_params(true, false);
        record_only_4k.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        validate_outputs(&record_only_4k).unwrap();

        assert_eq!(
            parse_encoder_bridge_video_output(
                Some("raw"),
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            EncoderBridgeVideoOutput::RawYuv420p
        );
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_4k_record_with_stream_safe_split_output_profile() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p30;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        validate_outputs(&params).unwrap();
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_youtube_4k30_stream_with_record_4k30_profile() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);

        validate_outputs(&params).unwrap();
    }

    // macOS-only: pins the VideoToolbox encoded split-output bridge. Windows
    // has no encoded bridge output yet (RawYuv420p default; plan 019 / the
    // windows-port recording-path decision owns the Windows behavior).
    #[cfg(target_os = "macos")]
    #[test]
    fn allows_youtube_4k30_stream_when_twitch_uses_safe_companion_profile() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[
            (
                StreamPlatform::Youtube,
                "rtmp://a.rtmp.youtube.com/live2",
                "yt",
            ),
            (StreamPlatform::Twitch, "rtmp://live.twitch.tv/app", "tw"),
        ]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);

        validate_outputs(&params).unwrap();
        let targets = stream_targets_from_streaming(params.streaming.as_ref().unwrap()).unwrap();
        let youtube = targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Youtube)
            .unwrap();
        let twitch = targets
            .iter()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        assert_eq!(
            youtube.output_video,
            Some(VideoSettings {
                preset: VideoPreset::StreamYoutube4k30,
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            })
        );
        assert_eq!(
            twitch.output_video,
            Some(VideoSettings {
                preset: VideoPreset::StreamSafe1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            })
        );
    }

    #[test]
    fn rejects_youtube_4k30_stream_without_local_recording_acceptance_profile() {
        let mut params = base_params(false, true);
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamYoutube4k30;
        streaming.default_bitrate_kbps = 30_000;
        params.streaming = Some(streaming);

        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(
            error.contains("requires the Record 4K30 local recording profile"),
            "{error}"
        );
    }

    #[test]
    fn rejects_4k_custom_rtmp_livestream_without_split_profile() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };

        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(error.contains("4K livestreaming is not enabled"), "{error}");
    }

    #[test]
    fn rejects_4k_record_with_stream_fps_above_recording_fps() {
        let mut params = base_params(true, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 3840,
            height: 2160,
            fps: 30,
            bitrate_kbps: 30_000,
        };
        let mut streaming = streaming_for(&[(
            StreamPlatform::Youtube,
            "rtmp://a.rtmp.youtube.com/live2",
            "yt",
        )]);
        streaming.default_output_preset = VideoPreset::StreamSafe1080p60;
        streaming.default_bitrate_kbps = 6000;
        params.streaming = Some(streaming);

        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(error.contains("stream FPS no higher"), "{error}");
    }

    #[test]
    fn accepts_stream_safe_1080p_profiles_for_streaming() {
        let mut params = base_params(false, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        };
        validate_outputs(&params).unwrap();

        params.output.video = VideoSettings {
            preset: VideoPreset::StreamSafe1080p60,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 6000,
        };
        validate_outputs(&params).unwrap();
    }

    #[test]
    fn rejects_streaming_bitrate_above_platform_safe_limit() {
        let mut params = base_params(false, true);
        params.output.video = VideoSettings {
            preset: VideoPreset::Custom,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 9000,
        };

        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(error.contains("6000 kbps or lower"), "{error}");
    }

    #[test]
    fn rejects_named_profile_with_edited_dimensions() {
        let mut params = base_params(true, false);
        params.output.video = VideoSettings {
            preset: VideoPreset::Record4k30,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 30_000,
        };

        let error = validate_outputs(&params).unwrap_err().to_string();
        assert!(error.contains("must be 3840x2160@30"), "{error}");
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
