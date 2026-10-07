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

#[cfg(test)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceIsoTeardownTiming {
    session_id: String,
    role: RecordingRole,
    phase: &'static str,
    at_ms: f64,
}

#[cfg(test)]
static SOURCE_ISO_TEARDOWN_TRACE: std::sync::Mutex<Vec<SourceIsoTeardownTiming>> =
    std::sync::Mutex::new(Vec::new());

#[cfg(test)]
fn test_trace_teardown(session_id: &str, role: RecordingRole, phase: &'static str) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var_os("VIDEORC_SOURCE_ISO_RUNTIME_DIR").is_some()) {
        return;
    }
    let at_ms = crate::encoder_bridge::test_source_iso_trace_ms(Instant::now());
    let mut trace = SOURCE_ISO_TEARDOWN_TRACE
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if trace.len() < 128 {
        trace.push(SourceIsoTeardownTiming {
            session_id: session_id.into(),
            role,
            phase,
            at_ms,
        });
    }
}

#[cfg(test)]
pub(crate) fn test_take_source_iso_teardown_trace() -> Vec<SourceIsoTeardownTiming> {
    std::mem::take(
        &mut *SOURCE_ISO_TEARDOWN_TRACE
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    )
}

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
    track_shift_ms: i32,
) -> Result<Vec<String>> {
    let mut args = crate::recording::bridge_ffmpeg_base_args();
    // A path created after preflight must never be overwritten.
    for arg in &mut args {
        if arg == "-y" {
            *arg = "-n".into();
        }
    }
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
        let filter = iso_audio_timing_filter(track_shift_ms)
            .map_or_else(|| "apad".into(), |filter| format!("{filter},apad"));
        let filter = format!("{filter},{ISO_PCM_PACKET_FILTER}");
        args.extend(["-af".to_string(), filter]);
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
    configure_iso_local_muxer(&mut args, output_mkv, fps)?;
    Ok(args)
}

/// Native H264 may omit SPS VUI timing. A bounded MPEG-TS probe can then
/// mistake its 90kHz timestamp timebase for the Matroska DefaultDuration.
/// Output -r with stream copy declares the known nominal cadence without
/// changing encoded access units or their PTS/DTS. Target the literal local
/// file boundary: encoded Shared/split graphs use separate FLV outputs, not
/// tee, so destination stream parameters remain untouched. Flush packets and
/// close a cluster at least every500ms: a crash must preserve decodable media,
/// not merely an unwritten AVIO buffer or a header without a complete cluster.
pub(crate) fn configure_iso_local_muxer(
    args: &mut Vec<String>,
    output: &Path,
    fps: u32,
) -> Result<()> {
    anyhow::ensure!(fps > 0, "Separate recording frame rate must be positive");
    let output = crate::recording::ffmpeg_file_path(output);
    let index = args
        .iter()
        .position(|arg| arg == &output)
        .context("Separate recording local output is missing from the muxer graph")?;
    anyhow::ensure!(
        args[..index]
            .windows(2)
            .rev()
            .find(|pair| pair[0] == "-c:v")
            .is_some_and(|pair| pair[1] == "copy"),
        "Separate recording nominal frame rate requires a stream-copy output"
    );
    args.splice(
        index..index,
        [
            "-r:v".to_string(),
            fps.to_string(),
            "-flush_packets".into(),
            "1".into(),
            "-cluster_time_limit".into(),
            "500".into(),
        ],
    );
    Ok(())
}

/// The bus already applies source gain/mute/delay. Only its common residual
/// track shift remains, exactly as on the Combined file.
fn iso_audio_timing_filter(track_shift_ms: i32) -> Option<String> {
    match track_shift_ms.cmp(&0) {
        std::cmp::Ordering::Less => Some(format!(
            "atrim=start={:.3},asetpts=PTS-STARTPTS",
            f64::from(track_shift_ms.saturating_abs()) / 1000.0,
        )),
        std::cmp::Ordering::Greater => Some(format!("adelay={track_shift_ms}:all=1")),
        std::cmp::Ordering::Equal => None,
    }
}

/// PCM frames from the FIFO can contain 4096 samples (85ms). FFmpeg's
/// shortest queue discards a whole frame crossing video EOF. Split after all
/// timing/processing/padding so the loss is bounded to 10ms at 48kHz without
/// changing samples, gain, or timestamps. AAC stream outputs are untouched.
pub(crate) const ISO_PCM_PACKET_FILTER: &str = "asetnsamples=n=480:p=0";

pub(crate) fn bound_combined_iso_pcm_packets(args: &mut [String]) {
    for codec in 0..args.len().saturating_sub(1) {
        if args[codec] == "-c:a"
            && args[codec + 1] == "pcm_s16le"
            && let Some(filter) = (0..codec).rev().find(|&index| args[index] == "-af")
        {
            args[filter + 1].push(',');
            args[filter + 1].push_str(ISO_PCM_PACKET_FILTER);
        }
    }
}

/// Only output tags change: internal bus identity remains microphone.
pub(crate) fn stamp_combined_audio_metadata(args: &mut Vec<String>) {
    let mut index = 1;
    while index < args.len() {
        if args[index] == "title=Microphone" && args[index - 1].starts_with("-metadata:s:a:") {
            args[index] = "title=Mix".into();
            let key = args[index - 1].clone();
            args.splice(index + 1..index + 1, [key, "handler_name=Mix".into()]);
            index += 2;
        }
        index += 1;
    }
}

/// One ISO role's writers.
pub struct SourceIsoWriter {
    pub role: RecordingRole,
    pub mkv_path: PathBuf,
    intended_mkv_path: PathBuf,
    video_fifo: PathBuf,
    video_fifo_owned: bool,
    audio_fifo: Option<PathBuf>,
    bridge: Option<EncoderBridgeRecordingSession>,
    child: Option<tokio::process::Child>,
    pid: u32,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    #[cfg(all(test, unix))]
    reader_resume_task: Option<tokio::task::JoinHandle<()>>,
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
    session_id: String,
    ffmpeg_path: String,
    fps: u32,
    track_shift_ms: i32,
    epoch: Arc<std::sync::OnceLock<Instant>>,
    keep_original_media: bool,
    stop: Arc<std::sync::atomic::AtomicBool>,
    stop_at: Arc<std::sync::OnceLock<Instant>>,
    supervisors: Vec<(RecordingRole, tokio::task::JoinHandle<()>)>,
    #[cfg(test)]
    abort_done: Option<tokio::sync::oneshot::Sender<bool>>,
    #[cfg(test)]
    owned_pids: Vec<u32>,
}

/// What the stop path learned about one role's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedSourceIsoRole {
    pub role: RecordingRole,
    pub mkv_path: PathBuf,
    /// `Ok` when the muxer exited 0 within the grace; `Err(reason)` otherwise
    /// (the file is kept as recovery media and the row is marked failed).
    pub outcome: std::result::Result<(), String>,
    pub duration_ms: Option<i64>,
    pub fps: u32,
    pub end_reason: Option<String>,
    pub expect_audio: bool,
    pub muxer_exit_code: Option<i32>,
}

/// Inputs shared by ISO construction and the Combined startup barrier.
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
    pub track_shift_ms: i32,
    pub keep_original_media: bool,
    pub start_barrier: Option<Arc<crate::encoder_bridge::RecordingStartBarrier>>,
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
        if let Err(error) = crate::fifo::create_audio_new(&path) {
            taps.abort_all();
            for prior in [taps.microphone.as_ref(), taps.system.as_ref()]
                .into_iter()
                .flatten()
            {
                let _ = crate::fifo::cleanup(prior.path());
            }
            return Err(error.into());
        }
        let tap = SourceAudioTap::spawn(path, role.as_str());
        match role {
            RecordingRole::Camera => taps.microphone = Some(tap),
            RecordingRole::Screen => taps.system = Some(tap),
            RecordingRole::Combined => {}
        }
    }
    Ok(taps)
}

/// The PCM FIFO a role's muxer reads: the microphone tap for the Camera file,
/// the system tap for the Screen file. The Combined muxer reads the bus FIFO,
/// never a tap.
pub(crate) fn role_audio_fifo(taps: &SourceAudioTaps, role: RecordingRole) -> Option<PathBuf> {
    let tap = match role {
        RecordingRole::Camera => taps.microphone.as_ref(),
        RecordingRole::Screen => taps.system.as_ref(),
        RecordingRole::Combined => None,
    };
    tap.map(|tap| tap.path().to_path_buf())
}

/// Synchronously constructs every ISO writer under an armed cleanup guard.
/// The caller constructs Combined and awaits the shared readiness barrier.
/// On failure every started writer is torn down; the caller rejects startup
/// (an armed ISO take that silently became Combined-only is the one thing
/// this feature must never do).
pub fn start_source_iso_writers(
    params: SourceIsoStartParams<'_>,
    taps: Arc<SourceAudioTaps>,
) -> Result<SourceIsoStartGuard> {
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
        track_shift_ms,
        keep_original_media,
        start_barrier,
    } = params;
    // Install cancellation ownership before allocating the first role resource.
    let mut guard = SourceIsoStartGuard::new(
        SourceIsoRuntime {
            writers: Vec::new(),
            taps: taps.clone(),
            session_id: session_id.to_string(),
            ffmpeg_path: ffmpeg_path.to_string(),
            fps: video.fps,
            track_shift_ms,
            epoch: video_epoch.clone(),
            keep_original_media,
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stop_at: start_barrier.as_ref().map_or_else(
                || Arc::new(std::sync::OnceLock::new()),
                |barrier| barrier.stop_boundary(),
            ),
            supervisors: Vec::new(),
            #[cfg(test)]
            abort_done: None,
            #[cfg(test)]
            owned_pids: Vec::new(),
        },
        state,
    );
    let writers = &mut guard.runtime.as_mut().expect("armed guard").writers;
    let result: Result<()> = (|| {
        for role in plan.iso_roles() {
            let mkv_path = recording_role_mkv_path(combined_mkv_path, role);
            if mkv_path.exists() {
                bail!(
                    "Refusing to start the {} recording because {} already exists",
                    role.as_str(),
                    mkv_path.display()
                );
            }
            // FFmpeg writes inside a private directory. A concurrently created
            // public sibling cannot be overwritten or mistaken for our media.
            let intended_mkv_path = mkv_path;
            let directory = intended_mkv_path
                .parent()
                .context("ISO output parent")?
                .join(format!(".videorc-iso-{}", uuid::Uuid::new_v4()));
            #[cfg(unix)]
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(not(unix))]
            let builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&directory)?;
            if let Err(error) = crate::session_ops::sync_session_file_parent(&directory) {
                let _ = std::fs::remove_dir(&directory);
                return Err(error.into());
            }
            let mkv_path = directory.join(
                intended_mkv_path
                    .file_name()
                    .context("ISO output filename")?,
            );
            if let Err(error) = state
                .database
                .set_source_iso_capture_path(&format!("{session_id}-{}", role.as_str()), &mkv_path)
            {
                let _ = std::fs::remove_dir(&directory);
                return Err(error);
            }
            let video_fifo = iso_video_fifo_path(session_id, role);
            writers.push(SourceIsoWriter {
                role,
                mkv_path: mkv_path.clone(),
                intended_mkv_path,
                video_fifo: video_fifo.clone(),
                video_fifo_owned: false,
                audio_fifo: role_audio_fifo(&taps, role),
                bridge: None,
                child: None,
                pid: 0,
                stderr_task: None,
                #[cfg(all(test, unix))]
                reader_resume_task: None,
            });
            crate::fifo::create_new(&video_fifo)
                .with_context(|| format!("Could not create the {} video FIFO", role.as_str()))?;
            writers
                .last_mut()
                .expect("registered writer")
                .video_fifo_owned = true;
            let audio_fifo = role_audio_fifo(&taps, role);
            let args = iso_muxer_ffmpeg_args(
                &video_fifo,
                audio_fifo.as_deref(),
                video_output,
                video.fps,
                role,
                &mkv_path,
                track_shift_ms,
            )?;
            let mut command = tokio::process::Command::new(ffmpeg_path);
            command
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
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
            let writer = writers.last_mut().expect("registered before spawn");
            writer.child = Some(child);
            writer.pid = pid;
            writer.stderr_task = stderr_task;
            #[cfg(all(test, unix))]
            if role == RecordingRole::Camera
                && let Ok(delay) = std::env::var("VIDEORC_SOURCE_ISO_RUNTIME_READER_DELAY_MS")
                && let Ok(delay) = delay.parse::<u64>()
            {
                // The actual owned FFmpeg reader is stopped before encoders
                // release their origin. waitpid proves the stop boundary;
                // the duration below deliberately injects a late FIFO reader.
                anyhow::ensure!(
                    unsafe { libc::kill(pid as i32, libc::SIGSTOP) } == 0,
                    "stop owned ISO reader"
                );
                let mut status = 0;
                anyhow::ensure!(
                    unsafe { libc::waitpid(pid as i32, &mut status, libc::WUNTRACED) }
                        == pid as i32
                        && libc::WIFSTOPPED(status),
                    "acknowledge stopped ISO reader"
                );
                let epoch = video_epoch.clone();
                writer.reader_resume_task = Some(tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(3), async {
                        while epoch.get().is_none() {
                            tokio::task::yield_now().await;
                        }
                    })
                    .await;
                    tokio::time::sleep(Duration::from_millis(delay.min(1000))).await;
                    unsafe {
                        libc::kill(pid as i32, libc::SIGCONT);
                    }
                }));
            }
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
                start_barrier.clone(),
            )
            .with_context(|| {
                format!(
                    "Could not start the {} encoder bridge",
                    writer.role.as_str()
                )
            })?;
            writer.bridge = Some(bridge);
        }
        Ok(())
    })();
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
            Ok(guard)
        }
        Err(error) => Err(error),
    }
}

impl SourceIsoRuntime {
    /// Signals every ISO bridge to stop (closing its video FIFO at writer
    /// exit, which ends the muxer through `-shortest`). Non-blocking; the
    /// monitor finishes the teardown.
    pub fn request_stop(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        for writer in &self.writers {
            if let Some(bridge) = writer.bridge.as_ref() {
                bridge.stop();
            }
        }
    }

    pub(crate) fn request_stop_at(&self, boundary: Instant) -> Instant {
        let boundary = *self.stop_at.get_or_init(|| boundary);
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        boundary
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
        if let Some(tap) = &self.taps.microphone {
            tap.request_abort();
        }
        if let Some(tap) = &self.taps.system {
            tap.request_abort();
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
        #[cfg(test)]
        let mut children_reaped = true;
        for writer in self.writers.iter_mut() {
            if let Some(child) = writer.child.as_mut() {
                let reaped = matches!(
                    tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
                    Ok(Ok(_))
                );
                if !reaped {
                    state.emit_log("warn", "An aborted ISO muxer did not acknowledge termination within the cleanup deadline.");
                }
                #[cfg(test)]
                {
                    children_reaped &= reaped;
                }
            }
            if let Some(task) = writer.stderr_task.take() {
                task.abort();
            }
            // Preserve uncertain partial media: durable reservations own recovery.
        }
        self.taps.abort_all();
        self.cleanup_fifos();
        #[cfg(test)]
        if let Some(done) = self.abort_done.take() {
            let _ = done.send(children_reaped);
        }
    }

    fn cleanup_fifos(&self) {
        for writer in &self.writers {
            if writer.video_fifo_owned {
                let _ = crate::fifo::cleanup(&writer.video_fifo);
            }
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
        for (role, task) in self.supervisors.drain(..) {
            if let Err(error) = task.await {
                let message = format!(
                    "{} recording supervisor failed: {error}",
                    role.title_suffix()
                );
                let id = format!("{}-{}", self.session_id, role.as_str());
                if let Ok(finalization) = crate::storage::SessionFinalization::new(
                    &id,
                    "failed",
                    Some(chrono::Utc::now().to_rfc3339()),
                    None,
                    None,
                    &crate::diagnostics::idle_diagnostics(),
                ) {
                    let finalization =
                        finalization.with_finalization_state("failed", Some(message.clone()));
                    let _ = crate::recording::persist_finalization_or_recovery(
                        state,
                        &finalization,
                        &mut None,
                    );
                }
                state.emit_log("error", message);
            }
        }
        self.cleanup_fifos();
        crate::live_layout::reconcile_source_iso_capture_demand(state).await;
        // Role supervisors persist and register exports before completing.
        Vec::new()
    }

    #[cfg(test)]
    pub(crate) fn test_owned_pids(&self) -> &[u32] {
        &self.owned_pids
    }

    fn supervise(&mut self, state: &AppState) {
        #[cfg(test)]
        {
            self.owned_pids = self.writers.iter().map(|writer| writer.pid).collect();
        }
        for writer in self.writers.drain(..) {
            let state = state.clone();
            let taps = self.taps.clone();
            let stop = self.stop.clone();
            let stop_at = self.stop_at.clone();
            let epoch = self.epoch.clone();
            let session_id = self.session_id.clone();
            let ffmpeg_path = self.ffmpeg_path.clone();
            let fps = self.fps;
            let track_shift_ms = self.track_shift_ms;
            let keep_original_media = self.keep_original_media;
            self.supervisors.push((
                writer.role,
                tokio::spawn(async move {
                    let role = supervise_role(
                        writer,
                        &state,
                        &session_id,
                        taps,
                        stop,
                        stop_at,
                        epoch,
                        fps,
                        track_shift_ms,
                        &ffmpeg_path,
                    )
                    .await;
                    let ended_at = chrono::Utc::now().to_rfc3339();
                    crate::live_layout::reconcile_source_iso_capture_demand(&state).await;
                    #[cfg(test)]
                    test_trace_teardown(&session_id, role.role, "capture-reconciled");
                    #[cfg(test)]
                    let traced_role = role.role;
                    commit_finished_source_iso_roles(
                        &state,
                        &session_id,
                        vec![role],
                        &ffmpeg_path,
                        &ended_at,
                        None,
                        keep_original_media,
                    );
                    #[cfg(test)]
                    test_trace_teardown(&session_id, traced_role, "role-committed");
                }),
            ));
        }
    }
}

impl Drop for SourceIsoRuntime {
    fn drop(&mut self) {
        // Detached supervisors retain their own state/taps/children and finish
        // bounded cleanup even if the active owner is cancelled while stopping.
        self.request_stop();
    }
}

impl Drop for SourceIsoWriter {
    fn drop(&mut self) {
        #[cfg(all(test, unix))]
        if let Some(task) = self.reader_resume_task.take() {
            task.abort();
        }
        if let Some(bridge) = self.bridge.as_ref() {
            bridge.stop();
        }
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                });
            }
        }
    }
}

fn role_audio_tap(taps: &SourceAudioTaps, role: RecordingRole) -> Option<&SourceAudioTap> {
    match role {
        RecordingRole::Camera => taps.microphone.as_ref(),
        RecordingRole::Screen => taps.system.as_ref(),
        RecordingRole::Combined => None,
    }
}

pub(crate) fn source_iso_audio_boundary_frames(
    role: RecordingRole,
    elapsed: Duration,
    track_shift_ms: i32,
) -> u64 {
    let buffered_delay = if role == RecordingRole::Screen {
        Duration::from_millis(track_shift_ms.saturating_neg().max(0) as u64)
    } else {
        Duration::ZERO
    };
    // Match the bus's sample-end boundary exactly, including its partial last
    // sample. Video cadence is not an allowance for discarding captured PCM.
    ((elapsed + buffered_delay).as_nanos() * 48_000).div_ceil(1_000_000_000) as u64
}

pub(crate) async fn wait_for_source_iso_audio_boundary(
    tap: &SourceAudioTap,
    required_frames: u64,
) -> std::result::Result<(), String> {
    tap.end_at_frame(required_frames);
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut readiness = tokio::time::interval(Duration::from_millis(5));
        while tap.offered_frames() < required_frames {
            if let Some(error) = tap.terminal_failure() {
                return Err(error);
            }
            readiness.tick().await;
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|_| {
        Err("Audio bus ended before the role's required stop samples arrived".into())
    })
}

#[allow(clippy::too_many_arguments)]
async fn supervise_role(
    mut writer: SourceIsoWriter,
    state: &AppState,
    session_id: &str,
    taps: Arc<SourceAudioTaps>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    stop_at: Arc<std::sync::OnceLock<Instant>>,
    epoch: Arc<std::sync::OnceLock<Instant>>,
    fps: u32,
    track_shift_ms: i32,
    ffmpeg_path: &str,
) -> FinishedSourceIsoRole {
    let mut failure = None;
    let mut end_reason = None;
    let mut ended_at = None;
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    loop {
        tick.tick().await;
        #[cfg(test)]
        if writer.role == RecordingRole::Camera
            && epoch
                .get()
                .is_some_and(|origin| origin.elapsed() > Duration::from_secs(1))
        {
            match std::env::var("VIDEORC_SOURCE_ISO_RUNTIME_FAILURE").as_deref() {
                Ok("bridge") => {
                    if let Some(bridge) = writer.bridge.as_ref() {
                        bridge.test_terminal_failure(
                            "Injected ISO encoder failure after real encoded frames",
                        );
                    }
                }
                Ok("early-eof") => {
                    if let Some(bridge) = writer.bridge.as_ref() {
                        bridge.stop();
                    }
                }
                _ => {}
            }
        }
        // Inspect failure before Stop so a simultaneous Stop cannot erase it.
        if let Some(error) = writer
            .bridge
            .as_ref()
            .and_then(|bridge| bridge.terminal_failure())
        {
            failure = Some(format!(
                "{} encoder failed: {error}",
                writer.role.title_suffix()
            ));
            break;
        }
        if let Some(error) =
            role_audio_tap(&taps, writer.role).and_then(SourceAudioTap::terminal_failure)
        {
            failure = Some(format!(
                "{} audio failed: {error}",
                writer.role.title_suffix()
            ));
            break;
        }
        if let Some(child) = writer.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) if !stop.load(std::sync::atomic::Ordering::Acquire) => {
                    failure = Some(format!(
                        "{} muxer exited before Stop ({status})",
                        writer.role.title_suffix()
                    ));
                    break;
                }
                Err(error) => {
                    failure = Some(format!(
                        "{} muxer failed: {error}",
                        writer.role.title_suffix()
                    ));
                    break;
                }
                _ => {}
            }
        }
        let source_snapshot = state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot(session_id)
            .ok();
        if let Some(snapshot) = source_snapshot
            .as_ref()
            .filter(|snapshot| snapshot.pending.is_none())
        {
            let source_key = match writer.role {
                RecordingRole::Camera => snapshot
                    .confirmed
                    .camera_id
                    .as_ref()
                    .map(crate::source_registry::SourceKey::camera),
                RecordingRole::Screen => snapshot
                    .confirmed
                    .window_id
                    .as_ref()
                    .map(crate::source_registry::SourceKey::window)
                    .or_else(|| {
                        snapshot
                            .confirmed
                            .screen_id
                            .as_ref()
                            .map(crate::source_registry::SourceKey::screen)
                    }),
                RecordingRole::Combined => None,
            };
            let terminal = source_key.as_ref().is_some_and(|key| {
                state
                    .capture_recovery
                    .try_lock()
                    .is_ok_and(|recovery| recovery.source_failed_after_recovery(key))
            });
            if terminal {
                failure = Some(format!(
                    "{} capture failed after source recovery",
                    writer.role.title_suffix()
                ));
                break;
            }
        }
        let removed = state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .source_removed_at(session_id, writer.role == RecordingRole::Camera);
        if let Some(boundary) =
            removed.filter(|removed_at| stop_at.get().is_none_or(|stop_at| removed_at <= stop_at))
        {
            ended_at = Some(boundary);
            end_reason = Some(format!(
                "{} recording ended because its selected source was removed.",
                writer.role.title_suffix()
            ));
            break;
        }
        // A committed removal keeps its earlier boundary even when Stop was
        // requested before this supervisor's next observation.
        if stop.load(std::sync::atomic::Ordering::Acquire) {
            ended_at = stop_at.get().copied();
            break;
        }
    }
    if let Some(reason) = failure.as_ref() {
        let _ = crate::recording::emit_health_event(
            state,
            Some(session_id),
            crate::protocol::HealthLevel::Warn,
            HEALTH_ROLE_FAILED,
            reason,
        );
    }
    #[cfg(test)]
    test_trace_teardown(session_id, writer.role, "boundary-observed");
    let elapsed = epoch.get().map(|epoch| {
        ended_at
            .unwrap_or_else(Instant::now)
            .saturating_duration_since(*epoch)
    });
    let duration_ms = elapsed.map(|elapsed| elapsed.as_millis() as i64);
    if let Some(bridge) = writer.bridge.as_ref() {
        if failure.is_none()
            && let Some(boundary) = ended_at
        {
            bridge.stop_at(boundary);
        } else {
            bridge.stop();
        }
    }
    // The bus intentionally trails capture by its playout delay. Keep this
    // role's tap open until the real samples covering its source boundary have
    // arrived; closing at Stop would replace the last ~150ms with apad silence.
    if failure.is_none()
        && let (Some(tap), Some(elapsed)) = (role_audio_tap(&taps, writer.role), elapsed)
    {
        let required_frames =
            source_iso_audio_boundary_frames(writer.role, elapsed, track_shift_ms);
        if let Err(error) = wait_for_source_iso_audio_boundary(tap, required_frames).await {
            failure.get_or_insert(error);
        }
    }
    #[cfg(test)]
    test_trace_teardown(session_id, writer.role, "after-audio-coverage");
    let role = writer.role;
    let closing_taps = taps.clone();
    let tap_close = tokio::task::spawn_blocking(move || match role {
        RecordingRole::Camera => closing_taps.microphone.as_ref().map(SourceAudioTap::close),
        RecordingRole::Screen => closing_taps.system.as_ref().map(SourceAudioTap::close),
        RecordingRole::Combined => None,
    });
    if let Some(bridge) = writer.bridge.take() {
        let report = tokio::task::spawn_blocking(move || {
            bridge.stop_and_reap_until(Instant::now() + ISO_BRIDGE_TEARDOWN_GRACE)
        })
        .await;
        match report {
            Ok(report) => {
                if let Some(error) = report.terminal_failure {
                    failure.get_or_insert(error);
                }
                if !report.reaped {
                    failure.get_or_insert("Encoder writer could not be reaped".into());
                }
            }
            Err(error) => {
                failure.get_or_insert(format!("Encoder teardown failed: {error}"));
            }
        }
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-bridge-reap");
    if let Err(error) = tap_close.await {
        failure.get_or_insert(format!("Audio teardown failed: {error}"));
    }
    if let Some(error) =
        role_audio_tap(&taps, writer.role).and_then(SourceAudioTap::terminal_failure)
    {
        failure.get_or_insert(error);
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-audio-close");
    let mut muxer_exit_code = None;
    if let Some(child) = writer.child.as_mut() {
        match tokio::time::timeout(ISO_MUXER_EXIT_GRACE, child.wait()).await {
            Ok(Ok(status)) if status.success() => {
                muxer_exit_code = status.code();
            }
            Ok(Ok(status)) => {
                muxer_exit_code = status.code();
                failure.get_or_insert(format!(
                    "{} muxer exited with {status}",
                    role.title_suffix()
                ));
            }
            Ok(Err(error)) => {
                failure.get_or_insert(format!(
                    "Could not reap {} muxer: {error}",
                    role.title_suffix()
                ));
            }
            Err(_) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                failure.get_or_insert(format!(
                    "{} muxer exceeded its stop deadline",
                    role.title_suffix()
                ));
            }
        }
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-muxer-reap");
    if let Some(task) = writer.stderr_task.take() {
        task.abort();
    }
    if writer.video_fifo_owned {
        let _ = crate::fifo::cleanup(&writer.video_fifo);
    }
    if let Some(path) = &writer.audio_fifo {
        let _ = crate::fifo::cleanup(path);
    }
    if failure.is_none() {
        let actual = tokio::time::timeout(
            Duration::from_secs(5),
            crate::session_ops::probe_duration_ms(ffmpeg_path, &writer.mkv_path),
        )
        .await;
        match actual {
            Ok(Some(actual))
                if actual > 0 && duration_ms.is_none_or(|expected| actual + 250 >= expected) => {}
            Ok(Some(actual)) => {
                failure = Some(format!(
                    "{} artifact ended at {actual}ms, before its expected {}ms boundary",
                    role.title_suffix(),
                    duration_ms.unwrap_or_default()
                ));
            }
            _ => {
                failure = Some(format!(
                    "{} artifact duration could not be verified",
                    role.title_suffix()
                ));
            }
        }
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-duration-probe");
    // Bind closed content before any publication-path change. A crash between
    // no-replace rename publication and DB commit still has the same durable object.
    if let Err(error) = state
        .database
        .bind_source_iso_capture(&format!("{session_id}-{}", role.as_str()), &writer.mkv_path)
    {
        failure.get_or_insert(format!(
            "Could not bind {} recovery media: {error}",
            role.title_suffix()
        ));
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-ownership-bind");
    // Publish without replacement, then bind the exact created object to its
    // durable row. Failed media stays at its private capture path for recovery.
    if failure.is_none() {
        let publish = crate::storage::capture_session_file_bound_identity(&writer.mkv_path)
            .and_then(|identity| identity.context("Closed ISO identity"))
            .and_then(|identity| {
                crate::session_ops::publish_identity_bound_session_file(
                    &writer.mkv_path,
                    &writer.intended_mkv_path,
                    &identity,
                )
            });
        match publish {
            Ok(()) => {
                let capture_path = writer.mkv_path.clone();
                writer.mkv_path = writer.intended_mkv_path.clone();
                if let Err(error) = state.database.set_source_iso_capture_path(
                    &format!("{session_id}-{}", role.as_str()),
                    &writer.mkv_path,
                ) {
                    failure = Some(format!(
                        "Could not persist published {} path: {error}",
                        role.title_suffix()
                    ));
                    writer.mkv_path = capture_path;
                } else {
                    if let Some(parent) = capture_path.parent() {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
            }
            Err(error) => {
                failure = Some(format!(
                    "Could not publish {} without replacing another file: {error}",
                    role.title_suffix()
                ));
            }
        }
    }
    #[cfg(test)]
    test_trace_teardown(session_id, role, "after-publication");
    if let Some(reason) = end_reason.as_ref() {
        let _ = crate::recording::emit_health_event(
            state,
            Some(session_id),
            crate::protocol::HealthLevel::Warn,
            "separate-source-recordings-source-removed",
            reason,
        );
        let _ = state.database.add_session_log(
            &format!("{session_id}-{}", role.as_str()),
            crate::protocol::HealthLevel::Warn,
            "source-removed",
            reason,
            None,
        );
    }
    FinishedSourceIsoRole {
        role,
        mkv_path: writer.mkv_path.clone(),
        outcome: failure.map_or(Ok(()), Err),
        duration_ms,
        fps,
        end_reason,
        expect_audio: role_audio_tap(&taps, role).is_some(),
        muxer_exit_code,
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

#[cfg(test)]
pub(crate) struct SourceIsoStartReceipt {
    pub pids: Vec<u32>,
    pub fifos: Vec<PathBuf>,
    pub reaped: tokio::sync::oneshot::Receiver<bool>,
}
#[cfg(test)]
struct SourceIsoStartPause {
    point: String,
    entered: tokio::sync::oneshot::Sender<SourceIsoStartReceipt>,
}
#[cfg(test)]
static SOURCE_ISO_START_PAUSE: std::sync::Mutex<Option<SourceIsoStartPause>> =
    std::sync::Mutex::new(None);
#[cfg(test)]
pub(crate) fn test_pause_next_source_iso_start(
    point: &str,
) -> tokio::sync::oneshot::Receiver<SourceIsoStartReceipt> {
    let (entered, receipt) = tokio::sync::oneshot::channel();
    *SOURCE_ISO_START_PAUSE.lock().unwrap() = Some(SourceIsoStartPause {
        point: point.into(),
        entered,
    });
    receipt
}

impl SourceIsoStartGuard {
    pub fn new(runtime: SourceIsoRuntime, state: &AppState) -> Self {
        Self {
            runtime: Some(runtime),
            state: state.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) async fn test_pause(&mut self, point: &str, combined_pid: u32) {
        let pause = {
            let mut slot = SOURCE_ISO_START_PAUSE.lock().unwrap();
            if slot.as_ref().is_some_and(|pause| {
                pause.point == point || (pause.point == "precommit-failure" && point == "precommit")
            }) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            let runtime = self.runtime.as_mut().expect("armed runtime");
            let (done, reaped) = tokio::sync::oneshot::channel();
            runtime.abort_done = Some(done);
            let mut pids = vec![combined_pid];
            pids.extend(runtime.writers.iter().map(|writer| writer.pid));
            let fifos = runtime
                .writers
                .iter()
                .flat_map(|writer| {
                    std::iter::once(writer.video_fifo.clone()).chain(writer.audio_fifo.clone())
                })
                .collect();
            let _ = pause.entered.send(SourceIsoStartReceipt {
                pids,
                fifos,
                reaped,
            });
            if pause.point == "precommit-failure" {
                runtime
                    .writers
                    .iter()
                    .find(|writer| writer.role == RecordingRole::Camera)
                    .and_then(|writer| writer.bridge.as_ref())
                    .expect("armed Camera bridge")
                    .test_terminal_failure("Injected known ISO failure at precommit");
                return;
            }
            std::future::pending::<()>().await;
        }
    }

    /// Synchronous final check: no await may separate this from ownership
    /// transfer into ActiveRecording. Known startup failures fail the take.
    pub(crate) fn validate_health(&mut self) -> Result<()> {
        let runtime = self.runtime.as_mut().expect("armed guard");
        for writer in &mut runtime.writers {
            if let Some(error) = role_audio_tap(&runtime.taps, writer.role)
                .and_then(SourceAudioTap::terminal_failure)
            {
                bail!(
                    "{} audio tap failed during startup: {error}",
                    writer.role.title_suffix()
                );
            }
            if let Some(error) = writer
                .bridge
                .as_ref()
                .and_then(EncoderBridgeRecordingSession::terminal_failure)
            {
                bail!(
                    "{} encoder failed during startup: {error}",
                    writer.role.title_suffix()
                );
            }
            if let Some(child) = writer.child.as_mut()
                && let Some(status) = child
                    .try_wait()
                    .context("Inspect ISO muxer before startup commit")?
            {
                bail!(
                    "{} muxer exited during startup ({status})",
                    writer.role.title_suffix()
                );
            }
        }
        Ok(())
    }

    pub async fn wait_until_ready(&mut self) -> Result<()> {
        self.validate_health()?;
        for writer in &mut self.runtime.as_mut().expect("armed guard").writers {
            if let Some(bridge) = writer.bridge.as_mut() {
                bridge.wait_until_ready().await?;
            }
        }
        self.validate_health()
    }

    /// Ownership transfer: the session now owns stop/finish.
    pub fn commit(mut self) -> SourceIsoRuntime {
        let mut runtime = self
            .runtime
            .take()
            .expect("SourceIsoStartGuard committed twice");
        runtime.supervise(&self.state);
        runtime
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

/// Advances already-reserved ISO rows and queues their MKV→MP4 finalization.
/// Role supervisors call this independently; the monitor also uses it for
/// any roles returned during session teardown.
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
        let wall_duration_ms = role.duration_ms.or(wall_duration_ms);
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
        let mut diagnostics = crate::diagnostics::idle_diagnostics();
        diagnostics.target_fps = Some(f64::from(role.fps));
        // Preserve the stop cause alongside the row even after a restart.
        let finalization = crate::storage::SessionFinalization::new(
            &iso_session_id,
            status,
            Some(ended_at.to_string()),
            None,
            wall_duration_ms,
            &diagnostics,
        )
        .map(|mut finalization| {
            let mut json: serde_json::Value =
                serde_json::from_str(&finalization.diagnostics_json).unwrap_or_default();
            json["sourceIsoExpectedAudio"] = serde_json::json!(role.expect_audio);
            json["sourceIsoMuxerExitCode"] = serde_json::json!(role.muxer_exit_code);
            if let Some(reason) = role.end_reason.as_ref() {
                json["sourceIsoEndReason"] = serde_json::json!(reason);
                json["sourceIsoOutcome"] = serde_json::json!("source-removed");
                json["sourceIsoEndOffsetMs"] = serde_json::json!(wall_duration_ms);
            }
            finalization.diagnostics_json = json.to_string();
            finalization.with_finalization_state(finalization_state, finalization_error.clone())
        });
        let persisted = finalization
            .map_err(|error| error.to_string())
            .and_then(|finalization| {
                crate::recording::persist_finalization_or_recovery(state, &finalization, &mut None)
            });
        if let Err(error) = persisted {
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
                    final_diagnostics: diagnostics,
                    finalized_caption_artifact: None,
                    captioned_copy_requested: false,
                    post_recording_gate: Some(crate::recording::PostRecordingGate {
                        intended_fps: Some(f64::from(role.fps)),
                        expect_audio: role.expect_audio,
                    }),
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
        "Separate source recording writers ended; each Library file shows its export or recovery status.",
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

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test".into(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_iso_constructor_retains_foreign_fifo_and_cleans_failed_directory_reservation() {
        for reserve in [false, true] {
            let state = test_state();
            let params = base_params();
            let id = format!("iso-constructor-{}", uuid::Uuid::new_v4());
            let directory = std::env::temp_dir().join(&id);
            std::fs::create_dir(&directory).unwrap();
            let combined = directory.join("take.mkv");
            state
                .database
                .create_session(&crate::storage::NewSession {
                    id: id.clone(),
                    title: "Constructor failure".into(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                    mode: "record".into(),
                    output_path: Some(combined.display().to_string()),
                    container: Some("mkv".into()),
                    stream_preset: None,
                    sources: params.sources.clone(),
                    layout: params.layout.clone(),
                    output: params.output.clone(),
                })
                .unwrap();
            if reserve {
                state
                    .database
                    .reserve_source_iso_sessions(
                        &id,
                        &[
                            (
                                "screen",
                                "Screen",
                                recording_role_mkv_path(&combined, RecordingRole::Screen)
                                    .display()
                                    .to_string(),
                            ),
                            (
                                "camera",
                                "Camera",
                                recording_role_mkv_path(&combined, RecordingRole::Camera)
                                    .display()
                                    .to_string(),
                            ),
                        ],
                    )
                    .unwrap();
            }
            let foreign = iso_video_fifo_path(&id, RecordingRole::Screen);
            std::fs::write(&foreign, b"foreign FIFO pathname").unwrap();
            let result = start_source_iso_writers(
                SourceIsoStartParams {
                    state: &state,
                    session_id: &id,
                    plan: SourceIsoPlan::from_settings(
                        params.output.separate_source_recordings.as_ref().unwrap(),
                    )
                    .unwrap(),
                    combined_mkv_path: &combined,
                    ffmpeg_path: "must-never-spawn",
                    video: &params.output.video,
                    video_output: EncoderBridgeVideoOutput::RawYuv420p,
                    frame_stores: CompositorSourceIsoFrameStores {
                        batches: Arc::new(
                            crate::compositor::source_iso_batch::SourceIsoBatchStore::default(),
                        ),
                        screen: Arc::new(std::sync::Mutex::new(
                            crate::frame_store::FrameStore::new(2),
                        )),
                        camera: Arc::new(std::sync::Mutex::new(
                            crate::frame_store::FrameStore::new(2),
                        )),
                    },
                    video_epoch: Arc::new(Default::default()),
                    bitrate_kbps: 8000,
                    track_shift_ms: 0,
                    keep_original_media: true,
                    start_barrier: None,
                },
                Arc::new(SourceAudioTaps::default()),
            );
            assert!(result.is_err());
            assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign FIFO pathname");
            if !reserve {
                assert_eq!(
                    std::fs::read_dir(&directory).unwrap().count(),
                    0,
                    "failed DB reservation leaves no private directory"
                );
            }
            tokio::task::yield_now().await;
            assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign FIFO pathname");
            std::fs::remove_file(foreign).unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn source_iso_second_tap_creation_failure_retires_first_without_deleting_collision() {
        let id = format!("tap-failure-{}", uuid::Uuid::new_v4());
        let screen = iso_audio_fifo_path(&id, RecordingRole::Screen);
        let camera = iso_audio_fifo_path(&id, RecordingRole::Camera);
        std::fs::write(&camera, b"foreign file").unwrap();
        let plan = SourceIsoPlan {
            keep_combined: true,
            roles: vec![RecordingRole::Screen, RecordingRole::Camera],
        };
        assert!(prepare_source_audio_taps(&id, &plan).is_err());
        assert!(!screen.exists());
        assert_eq!(std::fs::read(&camera).unwrap(), b"foreign file");
        std::fs::remove_file(camera).unwrap();
    }

    #[test]
    fn source_iso_child_process_fixture() {
        if std::env::var_os("VIDEORC_ISO_CHILD_FIXTURE").is_none() {
            return;
        }
        use std::io::{Read, Write};
        println!("ISO_CHILD_READY");
        std::io::stdout().flush().unwrap();
        let mut bytes = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut bytes);
        std::process::exit(0);
    }

    async fn fixture_child() -> tokio::process::Child {
        use tokio::io::AsyncBufReadExt;
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "source_iso::tests::source_iso_child_process_fixture",
                "--nocapture",
            ])
            .env("VIDEORC_ISO_CHILD_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let ready = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(line) = lines.next_line().await? {
                if line == "ISO_CHILD_READY" {
                    return Ok::<_, std::io::Error>(());
                }
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "fixture ended before readiness",
            ))
        })
        .await;
        if !matches!(ready, Ok(Ok(()))) {
            let _ = child.start_kill();
            let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            assert!(
                matches!(reaped, Ok(Ok(_))),
                "fixture child reaped after readiness failure"
            );
        }
        ready
            .expect("bounded child readiness")
            .expect("explicit child readiness");
        child
    }

    #[tokio::test]
    async fn source_iso_guard_cancellation_reaps_owned_child_and_bridge() {
        let state = test_state();
        let child = fixture_child().await;
        let (bridge, stopped, release) = EncoderBridgeRecordingSession::blocked_for_lifecycle_test(
            "source-iso-cancellation",
            EncoderBridgeOutputRole::Recording,
        );
        let (done, finished) = tokio::sync::oneshot::channel();
        let runtime = SourceIsoRuntime {
            writers: vec![SourceIsoWriter {
                role: RecordingRole::Screen,
                mkv_path: PathBuf::from("/nonexistent-iso-owned-file"),
                intended_mkv_path: PathBuf::from("/nonexistent-iso-public-file"),
                video_fifo: crate::fifo::transport_path(&format!(
                    "absent-{}",
                    uuid::Uuid::new_v4()
                )),
                video_fifo_owned: false,
                audio_fifo: None,
                bridge: Some(bridge),
                pid: child.id().unwrap(),
                child: Some(child),
                stderr_task: None,
                #[cfg(all(test, unix))]
                reader_resume_task: None,
            }],
            taps: Arc::new(SourceAudioTaps::default()),
            session_id: "source-iso-cancellation".into(),
            ffmpeg_path: "ffmpeg".into(),
            fps: 30,
            track_shift_ms: 0,
            epoch: Arc::new(Default::default()),
            keep_original_media: true,
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            stop_at: Arc::new(std::sync::OnceLock::new()),
            supervisors: Vec::new(),
            abort_done: Some(done),
            owned_pids: Vec::new(),
        };
        let guard = SourceIsoStartGuard::new(runtime, &state);
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = guard;
            let _ = entered.send(());
            std::future::pending::<()>().await;
        });
        waiting.await.unwrap();
        task.abort();
        let _ = task.await;
        let signalled = stopped.load(std::sync::atomic::Ordering::Acquire);
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), finished)
                .await
                .expect("bounded owned cleanup")
                .unwrap(),
            "every child wait must acknowledge reaping"
        );
        assert!(signalled, "cancellation synchronously stopped bridge");
    }

    #[test]
    fn residual_audio_shift_is_applied_without_source_processing() {
        assert_eq!(
            iso_audio_timing_filter(-120).as_deref(),
            Some("atrim=start=0.120,asetpts=PTS-STARTPTS")
        );
        assert_eq!(iso_audio_timing_filter(0), None);
        assert_eq!(
            iso_audio_timing_filter(120).as_deref(),
            Some("adelay=120:all=1")
        );
        assert_eq!(
            iso_audio_timing_filter(-500).as_deref(),
            Some("atrim=start=0.500,asetpts=PTS-STARTPTS")
        );
    }

    #[test]
    fn source_iso_pcm_packet_bound_preserves_shift_and_aac_stream_filters() {
        let filter = "atrim=start=0.120,asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0,apad";
        let mut args = [
            "-af",
            filter,
            "-c:a",
            "pcm_s16le",
            "out.mkv",
            "-af",
            filter,
            "-c:a",
            "aac",
            "rtmp://stream",
        ]
        .map(String::from);
        bound_combined_iso_pcm_packets(&mut args);
        assert_eq!(args[1], format!("{filter},{ISO_PCM_PACKET_FILTER}"));
        assert_eq!(args[6], filter);
    }

    #[test]
    fn combined_output_metadata_keeps_internal_audio_identity() {
        let mut args = vec![
            "-metadata:s:a:0".into(),
            "title=Microphone".into(),
            "out.mkv".into(),
        ];
        stamp_combined_audio_metadata(&mut args);
        assert_eq!(
            args,
            [
                "-metadata:s:a:0",
                "title=Mix",
                "-metadata:s:a:0",
                "handler_name=Mix",
                "out.mkv"
            ]
        );
    }

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
            0,
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
            joined.ends_with("-shortest -f matroska -r:v 60 -flush_packets 1 -cluster_time_limit 500 /tmp/out-camera.mkv"),
            "{joined}"
        );
        assert!(
            joined.contains("-af apad,asetnsamples=n=480:p=0"),
            "video EOF owns the silent audio tail"
        );
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
            0,
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
            0,
        )
        .expect_err("raw YUV cannot be stream-copied");
        assert!(
            format!("{error:#}").contains("encoded VideoToolbox"),
            "{error:#}"
        );
    }
}
