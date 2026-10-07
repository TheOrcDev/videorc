//! Separate source recordings (Plan 157): optional Screen + Camera ISO takes
//! from one capture session.
//!
//! One capture graph, extra writers. The compositor renders two more legs
//! (Screen alone, Camera alone) into their own frame stores; each leg gets its
//! own VideoToolbox encoder bridge and its own FFmpeg muxer. The session audio
//! bus offers every written chunk's ingredients to two PCM taps: the processed
//! microphone (→ Camera file) and the gained system contribution (→ Screen
//! file). The Combined master, preview and every stream leg are untouched.
//!
//! Pure contract helpers (validation, naming, FFmpeg args) live at the top so
//! they can be unit tested; the runtime that owns the writers follows.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::compositor::CompositorSourceIsoFrameStores;
use crate::encoder_bridge::{
    EncoderBridgeOutputRole, EncoderBridgeRecordingSession, EncoderBridgeVideoOutput,
    begin_encoder_bridge_shutdown, start_synthetic_recording_bridge,
};
use crate::protocol::{
    OutputSettings, SeparateSourceRecordingsSettings, SourceSelection, StartSessionParams,
    VideoSettings,
};
use crate::source_audio_tap::{SourceAudioTap, SourceAudioTaps};
use crate::state::AppState;

/// Stable refusal codes for session-start validation (also mirrored in TS).
pub const REFUSAL_RECORD_DISABLED: &str = "separate-source-recordings-record-disabled";
pub const REFUSAL_MISSING_CAMERA: &str = "separate-source-recordings-missing-camera";
pub const REFUSAL_MISSING_SCREEN: &str = "separate-source-recordings-missing-screen";
pub const REFUSAL_DROP_COMBINED: &str = "separate-source-recordings-drop-combined-unsupported";
/// Health code when a session asked for ISO legs but the capture path cannot
/// carry them (legacy FFmpeg capture, raw YUV bridge, Windows D3D11 pump).
pub const HEALTH_UNAVAILABLE: &str = "separate-source-recordings-unavailable";
pub const HEALTH_STARTED: &str = "separate-source-recordings-started";
pub const HEALTH_FINISHED: &str = "separate-source-recordings-finished";
pub const HEALTH_ROLE_FAILED: &str = "separate-source-recordings-role-failed";

/// How long the stop path waits for an ISO muxer to flush after its video
/// FIFO hit EOF before it is killed and the file kept as recovery media.
const ISO_MUXER_EXIT_GRACE: Duration = Duration::from_secs(20);
const ISO_BRIDGE_TEARDOWN_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingRole {
    Combined,
    Screen,
    Camera,
}

impl RecordingRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Combined => "combined",
            Self::Screen => "screen",
            Self::Camera => "camera",
        }
    }

    /// Library title suffix for a sibling row.
    pub const fn title_suffix(self) -> &'static str {
        match self {
            Self::Combined => "Combined",
            Self::Screen => "Screen",
            Self::Camera => "Camera",
        }
    }

    /// The audio track each ISO file carries.
    const fn audio_track_title(self) -> &'static str {
        match self {
            Self::Combined => "Mix",
            Self::Screen => "System audio",
            Self::Camera => "Microphone",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIsoPlan {
    pub keep_combined: bool,
    pub roles: Vec<RecordingRole>,
}

impl SourceIsoPlan {
    pub fn from_settings(settings: &SeparateSourceRecordingsSettings) -> Option<Self> {
        if !settings.enabled {
            return None;
        }
        let mut roles = Vec::with_capacity(3);
        if settings.keep_combined {
            roles.push(RecordingRole::Combined);
        }
        roles.push(RecordingRole::Screen);
        roles.push(RecordingRole::Camera);
        Some(Self {
            keep_combined: settings.keep_combined,
            roles,
        })
    }

    /// The ISO roles (never Combined).
    pub fn iso_roles(&self) -> impl Iterator<Item = RecordingRole> + '_ {
        self.roles
            .iter()
            .copied()
            .filter(|role| *role != RecordingRole::Combined)
    }
}

/// Validate ISO settings against the rest of the start params.
///
/// When ISO is off this is a no-op. When on, local recording must be enabled,
/// both a camera and a screen/window source must be selected, and the
/// Combined master must be kept (decision D1; dropping it is a protocol
/// reservation, not a shipped behavior — refuse rather than silently keep).
pub fn validate_separate_source_recordings(params: &StartSessionParams) -> Result<()> {
    let settings = separate_settings(&params.output);
    if !settings.enabled {
        return Ok(());
    }
    if !params.output.record_enabled {
        bail!(
            "{REFUSAL_RECORD_DISABLED}: Separate source recordings need local recording turned on."
        );
    }
    if !settings.keep_combined {
        bail!(
            "{REFUSAL_DROP_COMBINED}: Separate source recordings always keep the Combined recording in this release."
        );
    }
    validate_source_eligibility(&params.sources)?;
    Ok(())
}

pub fn validate_source_eligibility(sources: &SourceSelection) -> Result<()> {
    let has_camera = sources
        .camera_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    let has_screen = sources
        .screen_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
        || sources
            .window_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty());
    if !has_camera {
        bail!(
            "{REFUSAL_MISSING_CAMERA}: Separate source recordings need a camera and a screen or window."
        );
    }
    if !has_screen {
        bail!(
            "{REFUSAL_MISSING_SCREEN}: Separate source recordings need a camera and a screen or window."
        );
    }
    Ok(())
}

pub fn separate_settings(output: &OutputSettings) -> SeparateSourceRecordingsSettings {
    output.separate_source_recordings.unwrap_or_default()
}

pub fn armed_plan(output: &OutputSettings) -> Option<SourceIsoPlan> {
    SourceIsoPlan::from_settings(&separate_settings(output))
}

/// MKV path for one ISO role beside the Combined file. Combined keeps the
/// legacy name (every startup/ownership check keys on it); the ISO files
/// insert the role before the extension so the three sort together.
pub fn recording_role_mkv_path(combined_mkv_path: &Path, role: RecordingRole) -> PathBuf {
    if role == RecordingRole::Combined {
        return combined_mkv_path.to_path_buf();
    }
    let stem = combined_mkv_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("videorc-session");
    combined_mkv_path.with_file_name(format!("{stem}-{}.mkv", role.as_str()))
}

fn iso_video_fifo_path(session_id: &str, role: RecordingRole) -> PathBuf {
    crate::fifo::transport_path(&format!(
        "videorc-iso-{}-encoder-bridge-{session_id}.h264",
        role.as_str()
    ))
}

fn iso_audio_fifo_path(session_id: &str, role: RecordingRole) -> PathBuf {
    crate::fifo::transport_path(&format!(
        "videorc-iso-{}-audio-{session_id}.f32le",
        role.as_str()
    ))
}

/// FFmpeg argv for one ISO muxer: PCM tap first (so FFmpeg opens it before
/// draining video, as the Combined muxer does), then the encoded bridge FIFO,
/// stream copy + PCM, `-shortest` so video EOF ends the file.
pub(crate) fn iso_muxer_ffmpeg_args(
    video_fifo: &Path,
    audio_fifo: Option<&Path>,
    video_output: EncoderBridgeVideoOutput,
    fps: u32,
    role: RecordingRole,
    output_mkv: &Path,
) -> Result<Vec<String>> {
    let mut args = crate::recording::bridge_ffmpeg_base_args();
    let mut next_input_index = 0;
    let audio_input_index = audio_fifo.map(|path| {
        args.extend([
            "-thread_queue_size".to_string(),
            "1024".to_string(),
            "-f".to_string(),
            "f32le".to_string(),
            "-ar".to_string(),
            "48000".to_string(),
            "-ac".to_string(),
            "2".to_string(),
            "-i".to_string(),
            crate::recording::ffmpeg_file_path(path),
        ]);
        let index = next_input_index;
        next_input_index += 1;
        index
    });
    let video_input_index = crate::recording::append_bridge_encoded_video_input_args(
        &mut args,
        &mut next_input_index,
        video_fifo,
        video_output,
        fps,
        crate::recording::ENCODED_RECORDING_INPUT_THREAD_QUEUE_PACKETS,
    )
    .context("Separate source recordings need an encoded VideoToolbox bridge")?;
    args.extend([
        "-map".to_string(),
        format!("{video_input_index}:v:0"),
        "-c:v".to_string(),
        "copy".to_string(),
    ]);
    if let Some(audio_input_index) = audio_input_index {
        args.extend([
            "-map".to_string(),
            format!("{audio_input_index}:a?"),
            // `title` is what MKV players show; `handler_name` is the tag the
            // MP4 export (`-c:a aac`, stream metadata copied) writes into the
            // `hdlr` box, so the role survives finalization.
            "-metadata:s:a:0".to_string(),
            format!("title={}", role.audio_track_title()),
            "-metadata:s:a:0".to_string(),
            format!("handler_name={}", role.audio_track_title()),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
        ]);
    }
    args.extend([
        "-shortest".to_string(),
        "-f".to_string(),
        "matroska".to_string(),
        crate::recording::ffmpeg_file_path(output_mkv),
    ]);
    Ok(args)
}

/// One ISO role's writers.
pub struct SourceIsoWriter {
    pub role: RecordingRole,
    pub mkv_path: PathBuf,
    video_fifo: PathBuf,
    audio_fifo: Option<PathBuf>,
    bridge: Option<EncoderBridgeRecordingSession>,
    child: Option<tokio::process::Child>,
    pid: u32,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for SourceIsoWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SourceIsoWriter")
            .field("role", &self.role)
            .field("mkv_path", &self.mkv_path)
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

/// Everything an ISO-armed session owns beyond the Combined pipeline.
#[derive(Debug)]
pub struct SourceIsoRuntime {
    pub writers: Vec<SourceIsoWriter>,
    pub taps: Arc<SourceAudioTaps>,
}

/// What the stop path learned about one role's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedSourceIsoRole {
    pub role: RecordingRole,
    pub mkv_path: PathBuf,
    /// `Ok` when the muxer exited 0 within the grace; `Err(reason)` otherwise
    /// (the file is kept as recovery media and the row is marked failed).
    pub outcome: std::result::Result<(), String>,
}

/// Inputs the start path hands over once the Combined bridges are ready.
pub struct SourceIsoStartParams<'a> {
    pub state: &'a AppState,
    pub session_id: &'a str,
    pub plan: SourceIsoPlan,
    pub combined_mkv_path: &'a Path,
    pub ffmpeg_path: &'a str,
    pub video: &'a VideoSettings,
    pub video_output: EncoderBridgeVideoOutput,
    pub frame_stores: CompositorSourceIsoFrameStores,
    pub video_epoch: Arc<std::sync::OnceLock<Instant>>,
    pub bitrate_kbps: u32,
}

/// Creates the PCM taps for the roles the plan records. Called BEFORE the
/// audio bus is attached so the bus can be handed the taps immediately.
pub fn prepare_source_audio_taps(
    session_id: &str,
    plan: &SourceIsoPlan,
) -> Result<SourceAudioTaps> {
    let mut taps = SourceAudioTaps::default();
    for role in plan.iso_roles() {
        let path = iso_audio_fifo_path(session_id, role);
        crate::audio::create_native_audio_fifo(&path)?;
        let tap = SourceAudioTap::spawn(path, role.as_str());
        match role {
            RecordingRole::Camera => taps.microphone = Some(tap),
            RecordingRole::Screen => taps.system = Some(tap),
            RecordingRole::Combined => {}
        }
    }
    Ok(taps)
}

/// Spawns the muxers and bridges for every ISO role and waits for the
/// bridges' first-frame readiness. On any failure every started writer is
/// torn down and the error returned; the caller fails the session start
/// (an armed ISO take that silently became Combined-only is the one thing
/// this feature must never do).
pub async fn start_source_iso_writers(
    params: SourceIsoStartParams<'_>,
    taps: Arc<SourceAudioTaps>,
) -> Result<SourceIsoRuntime> {
    let SourceIsoStartParams {
        state,
        session_id,
        plan,
        combined_mkv_path,
        ffmpeg_path,
        video,
        video_output,
        frame_stores,
        video_epoch,
        bitrate_kbps,
    } = params;
    let mut writers = Vec::new();
    let result: Result<()> = async {
        for role in plan.iso_roles() {
            let mkv_path = recording_role_mkv_path(combined_mkv_path, role);
            if mkv_path.exists() {
                bail!(
                    "Refusing to start the {} recording because {} already exists",
                    role.as_str(),
                    mkv_path.display()
                );
            }
            let video_fifo = iso_video_fifo_path(session_id, role);
            crate::fifo::cleanup(&video_fifo).ok();
            crate::fifo::create(&video_fifo)
                .with_context(|| format!("Could not create the {} video FIFO", role.as_str()))?;
            let audio_fifo = match role {
                RecordingRole::Camera => {
                    taps.microphone.as_ref().map(|tap| tap.path().to_path_buf())
                }
                RecordingRole::Screen => taps.system.as_ref().map(|tap| tap.path().to_path_buf()),
                RecordingRole::Combined => None,
            };
            let args = iso_muxer_ffmpeg_args(
                &video_fifo,
                audio_fifo.as_deref(),
                video_output,
                video.fps,
                role,
                &mkv_path,
            )?;
            let mut command = tokio::process::Command::new(ffmpeg_path);
            command
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            let mut child = crate::process_job::spawn_owned_tokio(&mut command)
                .with_context(|| format!("Could not start the {} muxer", role.as_str()))?;
            let pid = child.id().unwrap_or_default();
            let stderr_task = child.stderr.take().map(|stderr| {
                let state = state.clone();
                let label = role.as_str();
                tokio::spawn(async move {
                    use tokio::io::AsyncBufReadExt;
                    let mut lines = tokio::io::BufReader::new(stderr).lines();
                    let mut emitted = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        // `-progress pipe:2` is chatty; keep warnings only.
                        if line.contains('=') && !line.contains("rror") && !line.contains("arning")
                        {
                            continue;
                        }
                        if emitted < 50 {
                            emitted += 1;
                            state.emit_log("warn", format!("ISO {label} muxer: {line}"));
                        }
                    }
                })
            });
            writers.push(SourceIsoWriter {
                role,
                mkv_path,
                video_fifo,
                audio_fifo,
                bridge: None,
                child: Some(child),
                pid,
                stderr_task,
            });
        }
        // Bridges after every muxer exists: a bridge writer blocks on its
        // FIFO until the reader opens, and FFmpeg opens all inputs up front.
        for writer in writers.iter_mut() {
            let store = match writer.role {
                RecordingRole::Screen => frame_stores.screen.clone(),
                RecordingRole::Camera => frame_stores.camera.clone(),
                RecordingRole::Combined => unreachable!("iso_roles never yields Combined"),
            };
            let diagnostics_context = crate::recording::encoder_bridge_diagnostics_context(
                EncoderBridgeOutputRole::Recording,
                Some(video),
                None,
                video_output,
                false,
            );
            let bridge = start_synthetic_recording_bridge(
                state.clone(),
                session_id.to_string(),
                video.fps,
                video.width,
                video.height,
                writer.video_fifo.clone(),
                Some(store),
                None,
                #[cfg(target_os = "windows")]
                None,
                #[cfg(target_os = "windows")]
                None,
                video_output,
                Some(bitrate_kbps),
                Default::default(),
                false,
                diagnostics_context,
                video_epoch.clone(),
            )
            .with_context(|| {
                format!(
                    "Could not start the {} encoder bridge",
                    writer.role.as_str()
                )
            })?;
            writer.bridge = Some(bridge);
        }
        for writer in writers.iter_mut() {
            if let Some(bridge) = writer.bridge.as_mut() {
                bridge.wait_until_ready().await.with_context(|| {
                    format!(
                        "The {} encoder bridge never became ready",
                        writer.role.as_str()
                    )
                })?;
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            let roles = writers
                .iter()
                .map(|writer| writer.role.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            state.emit_log(
                "info",
                format!("Separate source recordings armed for session {session_id}: {roles}."),
            );
            Ok(SourceIsoRuntime { writers, taps })
        }
        Err(error) => {
            let runtime = SourceIsoRuntime { writers, taps };
            runtime.abort(state).await;
            Err(error)
        }
    }
}

impl SourceIsoRuntime {
    /// Signals every ISO bridge to stop (closing its video FIFO at writer
    /// exit, which ends the muxer through `-shortest`). Non-blocking; the
    /// monitor finishes the teardown.
    pub fn request_stop(&self) {
        for writer in &self.writers {
            if let Some(bridge) = writer.bridge.as_ref() {
                bridge.stop();
            }
        }
    }

    /// Synchronous part of a partial-start abort: muxers get SIGKILL now so
    /// a dropped guard never leaks a writing FFmpeg, bridges are asked to
    /// stop, taps stop, and the partial files/FIFOs go. Bridge reaping
    /// (async) follows in `abort`.
    fn abort_sync(&mut self) {
        for writer in self.writers.iter_mut() {
            if let Some(child) = writer.child.as_mut() {
                let _ = child.start_kill();
            }
            if let Some(bridge) = writer.bridge.as_ref() {
                bridge.stop();
            }
            if let Some(task) = writer.stderr_task.take() {
                task.abort();
            }
        }
        self.taps.abort_all();
        for writer in &self.writers {
            let _ = std::fs::remove_file(&writer.mkv_path);
        }
        self.cleanup_fifos();
    }

    /// Partial-start failure: kill muxers, reap bridges, drop FIFOs.
    async fn abort(mut self, state: &AppState) {
        for writer in self.writers.iter_mut() {
            if let Some(child) = writer.child.as_mut() {
                let _ = child.start_kill();
            }
        }
        let bridges = self
            .writers
            .iter_mut()
            .filter_map(|writer| writer.bridge.take())
            .collect::<Vec<_>>();
        if let Some(batch) = begin_encoder_bridge_shutdown(bridges, ISO_BRIDGE_TEARDOWN_GRACE) {
            let _ = crate::recording::finish_recording_encoder_bridge_teardown(
                state,
                Some(batch),
                "source-iso-partial-start-failure",
            )
            .await;
        }
        for writer in self.writers.iter_mut() {
            if let Some(child) = writer.child.as_mut() {
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
            if let Some(task) = writer.stderr_task.take() {
                task.abort();
            }
            let _ = std::fs::remove_file(&writer.mkv_path);
        }
        self.taps.abort_all();
        self.cleanup_fifos();
    }

    fn cleanup_fifos(&self) {
        for writer in &self.writers {
            let _ = crate::fifo::cleanup(&writer.video_fifo);
            if let Some(audio_fifo) = writer.audio_fifo.as_ref() {
                let _ = crate::fifo::cleanup(audio_fifo);
            }
        }
    }

    /// Stop-path teardown, after the Combined FFmpeg exited: reap the ISO
    /// bridges (video EOF), close the PCM taps (audio EOF; the bus has
    /// already stopped writing), wait (bounded) for each muxer to flush, and
    /// report per-role outcomes for the Library rows.
    pub async fn finish(mut self, state: &AppState) -> Vec<FinishedSourceIsoRole> {
        self.request_stop();
        let bridges = self
            .writers
            .iter_mut()
            .filter_map(|writer| writer.bridge.take())
            .collect::<Vec<_>>();
        if let Some(batch) = begin_encoder_bridge_shutdown(bridges, ISO_BRIDGE_TEARDOWN_GRACE) {
            let _ = crate::recording::finish_recording_encoder_bridge_teardown(
                state,
                Some(batch),
                "source-iso-recording-process-exit",
            )
            .await;
        }
        // Both inputs must reach EOF before `-shortest` can let the muxer
        // write its index and exit; an open audio FIFO would hold it.
        let taps = self.taps.clone();
        let (microphone, system) = tokio::task::spawn_blocking(move || taps.close_all())
            .await
            .unwrap_or((None, None));
        let mut finished = Vec::with_capacity(self.writers.len());
        for writer in self.writers.iter_mut() {
            let outcome = match writer.child.as_mut() {
                Some(child) => match tokio::time::timeout(ISO_MUXER_EXIT_GRACE, child.wait()).await
                {
                    Ok(Ok(status)) if status.success() => Ok(()),
                    Ok(Ok(status)) => Err(format!(
                        "The {} muxer exited with {status}",
                        writer.role.as_str()
                    )),
                    Ok(Err(error)) => Err(format!(
                        "Could not wait for the {} muxer: {error}",
                        writer.role.as_str()
                    )),
                    Err(_) => {
                        let _ = child.start_kill();
                        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                        Err(format!(
                            "The {} muxer did not finish within {}s after Stop and was killed; the file was kept as recovery media.",
                            writer.role.as_str(),
                            ISO_MUXER_EXIT_GRACE.as_secs()
                        ))
                    }
                },
                None => Err(format!(
                    "The {} muxer was never started",
                    writer.role.as_str()
                )),
            };
            if let Some(task) = writer.stderr_task.take() {
                let _ = tokio::time::timeout(Duration::from_millis(500), task).await;
            }
            finished.push(FinishedSourceIsoRole {
                role: writer.role,
                mkv_path: writer.mkv_path.clone(),
                outcome,
            });
        }
        let describe = |report: Option<crate::source_audio_tap::SourceAudioTapReport>| {
            report.map_or_else(
                || "off".to_string(),
                |report| {
                    format!(
                        "{} chunks, {} dropped",
                        report.offered_chunks, report.dropped_chunks
                    )
                },
            )
        };
        state.emit_log(
            "info",
            format!(
                "Separate source recordings finished: microphone tap {}; system tap {}.",
                describe(microphone),
                describe(system)
            ),
        );
        self.cleanup_fifos();
        finished
    }
}

/// Holds a started runtime until the session commits it into
/// `ActiveRecording`. Any exit before `commit` (an error branch that returns
/// early, or the start future being cancelled mid-await) aborts the writers
/// from `Drop`: muxers are killed synchronously and the bridge reap runs on
/// the process runtime, so no ISO FFmpeg or partial file outlives a failed
/// start. Explicit abort calls on each error branch alone would not cover
/// cancellation.
pub struct SourceIsoStartGuard {
    runtime: Option<SourceIsoRuntime>,
    state: AppState,
}

impl SourceIsoStartGuard {
    pub fn new(runtime: SourceIsoRuntime, state: &AppState) -> Self {
        Self {
            runtime: Some(runtime),
            state: state.clone(),
        }
    }

    /// Ownership transfer: the session now owns stop/finish.
    pub fn commit(mut self) -> SourceIsoRuntime {
        self.runtime
            .take()
            .expect("SourceIsoStartGuard committed twice")
    }
}

impl Drop for SourceIsoStartGuard {
    fn drop(&mut self) {
        let Some(mut runtime) = self.runtime.take() else {
            return;
        };
        self.state.emit_log(
            "warn",
            "Separate source recordings were started but the session did not commit; aborting the ISO writers.",
        );
        runtime.abort_sync();
        // The bridge reap and child wait are async; outside a runtime the
        // synchronous kill above is the whole cleanup (Drop must not panic).
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let state = self.state.clone();
            handle.spawn(async move { runtime.abort(&state).await });
        }
    }
}

/// Commits the ISO rows beside the Combined row and queues their MKV→MP4
/// finalization. Called from the monitor right after the Combined row is
/// committed, so the Library shows the whole take at once.
pub fn commit_finished_source_iso_roles(
    state: &AppState,
    combined_session_id: &str,
    finished: Vec<FinishedSourceIsoRole>,
    ffmpeg_path: &str,
    ended_at: &str,
    wall_duration_ms: Option<i64>,
    keep_original_media: bool,
) {
    if finished.is_empty() {
        return;
    }
    if let Err(error) = state.database.set_session_take_role(
        combined_session_id,
        combined_session_id,
        RecordingRole::Combined.as_str(),
    ) {
        state.emit_log(
            "warn",
            format!("Could not tag the Combined row with its take: {error:#}"),
        );
    }
    for role in finished {
        let iso_session_id = format!("{combined_session_id}-{}", role.role.as_str());
        let mkv_exists = role.mkv_path.exists();
        let (status, finalization_state, finalization_error) = match (&role.outcome, mkv_exists) {
            (Ok(()), true) => (
                "completed",
                crate::recording_finalization::FINALIZATION_STATE_FINALIZING,
                None,
            ),
            (Ok(()), false) => (
                "failed",
                crate::recording_finalization::FINALIZATION_STATE_FAILED,
                Some(format!(
                    "The {} file was missing after Stop.",
                    role.role.as_str()
                )),
            ),
            (Err(reason), _) => (
                if mkv_exists { "completed" } else { "failed" },
                crate::recording_finalization::FINALIZATION_STATE_FAILED,
                Some(reason.clone()),
            ),
        };
        if let Err(error) = state.database.create_source_iso_session(
            combined_session_id,
            &iso_session_id,
            role.role.as_str(),
            role.role.title_suffix(),
            &role.mkv_path.display().to_string(),
            ended_at,
            wall_duration_ms,
            status,
            finalization_state,
            finalization_error.as_deref(),
        ) {
            state.emit_log(
                "warn",
                format!(
                    "Could not save the {} recording row for {}: {error:#}",
                    role.role.as_str(),
                    role.mkv_path.display()
                ),
            );
            continue;
        }
        if let Some(reason) = finalization_error {
            let _ = crate::recording::emit_health_event(
                state,
                Some(combined_session_id),
                crate::protocol::HealthLevel::Warn,
                HEALTH_ROLE_FAILED,
                &reason,
            );
            continue;
        }
        let output_ownership = crate::storage::capture_session_file_bound_identity(&role.mkv_path)
            .ok()
            .flatten();
        let export_permit = state.ffmpeg_work.begin_background_export();
        let control = state.recording_finalization.register(&iso_session_id);
        crate::recording_finalization::emit_finalization_event(
            state,
            &iso_session_id,
            crate::protocol::RecordingFinalizationState::Finalizing,
            crate::recording_finalization::FinalizationEventDetail {
                progress_percent: Some(0),
                output_path: Some(role.mkv_path.display().to_string()),
                ..Default::default()
            },
        );
        tokio::spawn(crate::recording::run_recording_finalization_job(
            state.clone(),
            crate::recording::PendingRecordingFinalizationJob {
                request: crate::recording::RecordingFinalizationRequest {
                    session_id: iso_session_id,
                    ffmpeg_path: ffmpeg_path.to_string(),
                    input_mkv: role.mkv_path,
                    output_ownership,
                    keep_original_media,
                    ended_at: ended_at.to_string(),
                    wall_duration_ms,
                    final_diagnostics: crate::diagnostics::idle_diagnostics(),
                    finalized_caption_artifact: None,
                    captioned_copy_requested: false,
                    post_recording_gate: None,
                    pipeline_reported_freezes: false,
                },
                control,
                export_permit,
            },
        ));
    }
    let _ = crate::recording::emit_health_event(
        state,
        Some(combined_session_id),
        crate::protocol::HealthLevel::Info,
        HEALTH_FINISHED,
        "Separate source recordings saved; exporting their MP4s in the background.",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        AudioSettings, LayoutPreset, OutputSettings, RtmpPreset, RtmpSettings,
        SeparateSourceRecordingsSettings, SourceSelection, StartSessionParams, VideoPreset,
        VideoSettings, default_layout_settings,
    };

    fn base_params() -> StartSessionParams {
        let mut layout = default_layout_settings();
        layout.layout_preset = LayoutPreset::ScreenCamera;
        StartSessionParams {
            sources: SourceSelection {
                screen_id: Some("screen:1".into()),
                window_id: None,
                camera_id: Some("camera:1".into()),
                microphone_id: None,
                test_pattern: false,
            },
            layout,
            scene: None,
            output: OutputSettings {
                record_enabled: true,
                stream_enabled: false,
                output_directory: None,
                ffmpeg_path: None,
                keep_original_mkv: false,
                separate_source_recordings: Some(SeparateSourceRecordingsSettings {
                    enabled: true,
                    keep_combined: true,
                }),
                video: VideoSettings {
                    preset: VideoPreset::Tutorial1080p30,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 8000,
                },
                rtmp: RtmpSettings {
                    preset: RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
            audio: AudioSettings::default(),
            streaming: None,
            captions: None,
            simulcast: None,
            requested_at_ms: None,
            purpose: Default::default(),
        }
    }

    #[test]
    fn disabled_iso_always_validates() {
        let mut params = base_params();
        params.output.separate_source_recordings = Some(SeparateSourceRecordingsSettings {
            enabled: false,
            keep_combined: true,
        });
        params.sources.camera_id = None;
        assert!(validate_separate_source_recordings(&params).is_ok());
    }

    #[test]
    fn iso_requires_local_recording() {
        let mut params = base_params();
        params.output.record_enabled = false;
        let err = validate_separate_source_recordings(&params)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains(REFUSAL_RECORD_DISABLED), "{err}");
    }

    #[test]
    fn iso_requires_camera() {
        let mut params = base_params();
        params.sources.camera_id = None;
        let err = validate_separate_source_recordings(&params)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains(REFUSAL_MISSING_CAMERA), "{err}");
    }

    #[test]
    fn iso_requires_screen_or_window() {
        let mut params = base_params();
        params.sources.screen_id = None;
        params.sources.window_id = None;
        let err = validate_separate_source_recordings(&params)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains(REFUSAL_MISSING_SCREEN), "{err}");
    }

    #[test]
    fn iso_refuses_to_drop_the_combined_master() {
        let mut params = base_params();
        params.output.separate_source_recordings = Some(SeparateSourceRecordingsSettings {
            enabled: true,
            keep_combined: false,
        });
        let err = validate_separate_source_recordings(&params)
            .expect_err("must refuse")
            .to_string();
        assert!(err.contains(REFUSAL_DROP_COMBINED), "{err}");
    }

    #[test]
    fn window_counts_as_screen_role() {
        let mut params = base_params();
        params.sources.screen_id = None;
        params.sources.window_id = Some("window:1".into());
        assert!(validate_separate_source_recordings(&params).is_ok());
    }

    #[test]
    fn plan_keeps_combined_and_lists_both_iso_roles() {
        let plan = SourceIsoPlan::from_settings(&SeparateSourceRecordingsSettings {
            enabled: true,
            keep_combined: true,
        })
        .expect("plan");
        assert_eq!(
            plan.roles,
            vec![
                RecordingRole::Combined,
                RecordingRole::Screen,
                RecordingRole::Camera
            ]
        );
        assert_eq!(
            plan.iso_roles().collect::<Vec<_>>(),
            vec![RecordingRole::Screen, RecordingRole::Camera]
        );
        assert!(
            SourceIsoPlan::from_settings(&SeparateSourceRecordingsSettings::default()).is_none()
        );
    }

    #[test]
    fn iso_paths_sit_beside_the_combined_file() {
        let combined = Path::new("/tmp/videorc-session-20261006-120000-abc.mkv");
        assert_eq!(
            recording_role_mkv_path(combined, RecordingRole::Combined),
            combined
        );
        assert_eq!(
            recording_role_mkv_path(combined, RecordingRole::Screen),
            Path::new("/tmp/videorc-session-20261006-120000-abc-screen.mkv")
        );
        assert_eq!(
            recording_role_mkv_path(combined, RecordingRole::Camera),
            Path::new("/tmp/videorc-session-20261006-120000-abc-camera.mkv")
        );
    }

    #[test]
    fn settings_round_trip_default_omitted() {
        let settings = SeparateSourceRecordingsSettings::default();
        assert!(!settings.enabled);
        assert!(settings.keep_combined);
        let json = serde_json::to_string(&settings).unwrap();
        let back: SeparateSourceRecordingsSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
        let output: OutputSettings = serde_json::from_str(
            r#"{"recordEnabled":true,"streamEnabled":false,"keepOriginalMkv":false,
                "video":{"preset":"tutorial-1080p30","width":1920,"height":1080,"fps":30,"bitrateKbps":8000},
                "rtmp":{"preset":"custom","serverUrl":"","streamKey":""},
                "separateSourceRecordings":{"enabled":true}}"#,
        )
        .unwrap();
        let settings = separate_settings(&output);
        assert!(
            settings.enabled && settings.keep_combined,
            "keepCombined defaults true"
        );
    }

    #[test]
    fn iso_muxer_args_copy_video_and_carry_one_pcm_track() {
        let args = iso_muxer_ffmpeg_args(
            Path::new("/tmp/v.h264"),
            Some(Path::new("/tmp/a.f32le")),
            EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            60,
            RecordingRole::Camera,
            Path::new("/tmp/out-camera.mkv"),
        )
        .unwrap();
        let joined = args.join(" ");
        assert!(
            joined.contains("-f f32le -ar 48000 -ac 2 -i /tmp/a.f32le"),
            "{joined}"
        );
        assert!(
            joined.contains("-use_wallclock_as_timestamps 1 -f h264 -framerate 60 -i /tmp/v.h264"),
            "{joined}"
        );
        assert!(joined.contains("-map 1:v:0 -c:v copy"), "{joined}");
        assert!(
            joined.contains(
                "-map 0:a? -metadata:s:a:0 title=Microphone -metadata:s:a:0 handler_name=Microphone -c:a pcm_s16le"
            ),
            "{joined}"
        );
        assert!(
            joined.ends_with("-shortest -f matroska /tmp/out-camera.mkv"),
            "{joined}"
        );
        assert!(!joined.contains("-af"), "no mixing filter on an ISO leg");
    }

    #[test]
    fn iso_muxer_args_without_audio_have_no_audio_map() {
        let args = iso_muxer_ffmpeg_args(
            Path::new("/tmp/v.h264"),
            None,
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
            30,
            RecordingRole::Screen,
            Path::new("/tmp/out-screen.mkv"),
        )
        .unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-f mpegts -i /tmp/v.h264"), "{joined}");
        assert!(joined.contains("-map 0:v:0 -c:v copy"), "{joined}");
        assert!(!joined.contains("-c:a"), "{joined}");
    }

    #[test]
    fn iso_muxer_args_refuse_raw_yuv() {
        let error = iso_muxer_ffmpeg_args(
            Path::new("/tmp/v.yuv"),
            None,
            EncoderBridgeVideoOutput::RawYuv420p,
            30,
            RecordingRole::Screen,
            Path::new("/tmp/out.mkv"),
        )
        .expect_err("raw YUV cannot be stream-copied");
        assert!(
            format!("{error:#}").contains("encoded VideoToolbox"),
            "{error:#}"
        );
    }
}
