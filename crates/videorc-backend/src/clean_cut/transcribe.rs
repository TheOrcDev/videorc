//! Chunked verbatim transcription through `POST /api/ai/transcripts/chunks`
//! (docs/clean-cut-contract.md, part A), resumable per chunk.
//!
//! Layout under `<Artifacts>/<sessionId>/clean-cut/`:
//!
//! - `audio-16k.wav`: the recording's first audio track as PCM s16le mono
//!   16 kHz, extracted once.
//! - `chunks/plan.json`: the source identity, probe facts and the window
//!   plan the chunks were cut from. A different source identity invalidates
//!   everything below it.
//! - `chunks/<index>.json`: one transcribed chunk, chunk-relative times. A
//!   crash, quit or a used-up allowance resumes at the first missing index.
//! - `transcript.words.json`: the stitched transcript (`version: 1`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::job::{
    ERROR_ANALYSIS, ERROR_FFMPEG, ERROR_FILE_MISSING, ERROR_NETWORK, ERROR_NO_AUDIO,
    ERROR_PREMIUM_REQUIRED, ERROR_PROBE, ERROR_PROCESSING, ERROR_SIGNED_OUT, JobFailure,
    PhaseOutcome, WorkerContext, set_job_state,
};
use super::rules::{
    CHUNK_MAX_BYTES, CHUNK_UPLOAD_ATTEMPTS, CHUNK_UPLOADS_IN_FLIGHT, FILLER_LEXICON,
};
use super::silence::{ChunkWindow, WavInfo, open_wav, plan_chunk_windows};
use crate::atomic_file::replace_file;
use crate::captions::encode_wav_16k_mono;
use crate::ffmpeg::{default_ffmpeg_path, ffprobe_path_for};
use crate::process_job::{output_owned_std_with_timeout, spawn_owned_std};
use crate::protocol::{CleanCutFrameRate, CleanCutJobState, CleanCutSourceIdentity};
use crate::storage::{PersistedCleanCutJob, default_artifacts_dir};
use crate::videorc_api::{
    AiApiFailure, TranscriptChunkRequest, TranscriptChunkResponse, TranscriptChunkWord,
};

pub const TRANSCRIPT_VERSION: u32 = 1;
pub const PLAN_VERSION: u32 = 1;
pub const CHUNK_VERSION: u32 = 1;
const CHUNKS_DIR: &str = "chunks";
const AUDIO_FILE: &str = "audio-16k.wav";
const PLAN_FILE: &str = "plan.json";
const TRANSCRIPT_FILE: &str = "transcript.words.json";
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FFMPEG_STDERR_BYTES: usize = 16 * 1024;
/// Progress shares of the whole job: extraction and probe come first, the
/// uploads are most of it, stitching and analysis follow.
const PROGRESS_EXTRACT: f64 = 0.02;
const PROGRESS_PROBE: f64 = 0.04;
const PROGRESS_UPLOAD_START: f64 = 0.05;
const PROGRESS_UPLOAD_SPAN: f64 = 0.80;
const PROGRESS_STITCHED: f64 = 0.86;

/// One word of the stitched transcript, in recording time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Tagged by the server or matched by the local lexicon. Written only
    /// when true.
    #[serde(default, skip_serializing_if = "is_false")]
    pub filler: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `transcript.words.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFile {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default)]
    pub words: Vec<TranscriptWord>,
}

/// `chunks/plan.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPlanFile {
    pub version: u32,
    pub source_identity: CleanCutSourceIdentity,
    /// The container duration from ffprobe (the cut list's `durationMs`).
    pub duration_ms: u64,
    /// The extracted audio's length; the windows cover exactly this.
    pub audio_duration_ms: u64,
    pub frame_rate: CleanCutFrameRate,
    #[serde(default)]
    pub windows: Vec<ChunkWindow>,
}

/// `chunks/<index>.json`: the server's words, chunk-relative.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkResultFile {
    pub version: u32,
    pub chunk_index: u32,
    pub chunk_start_ms: u64,
    pub chunk_end_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default)]
    pub words: Vec<TranscriptChunkWord>,
}

/// What the transcription phase hands to the cut-list phase.
#[derive(Debug, Clone)]
pub struct TranscriptBundle {
    pub transcript: TranscriptFile,
    pub plan: ChunkPlanFile,
    pub dir: PathBuf,
}

// --- Files ------------------------------------------------------------------

pub fn clean_cut_dir(session_id: &str) -> PathBuf {
    default_artifacts_dir().join(session_id).join("clean-cut")
}

pub fn audio_path(dir: &Path) -> PathBuf {
    dir.join(AUDIO_FILE)
}

pub fn plan_path(dir: &Path) -> PathBuf {
    dir.join(CHUNKS_DIR).join(PLAN_FILE)
}

pub fn chunk_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(CHUNKS_DIR).join(format!("{index}.json"))
}

pub fn transcript_file_path(dir: &Path) -> PathBuf {
    dir.join(TRANSCRIPT_FILE)
}

/// `None` for a missing or unparsable file: both mean "redo this step".
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Write beside the target, then rename over it: a crash leaves either the
/// old file or the new one, never a torn one.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension("json.tmp");
    std::fs::write(&staging, serde_json::to_vec(value)?)
        .with_context(|| format!("Could not write {}", staging.display()))?;
    replace_file(&staging, path)
        .with_context(|| format!("Could not publish {}", path.display()))?;
    Ok(())
}

/// The windows whose chunk file is missing, stale or from another plan.
pub fn missing_chunk_indices(dir: &Path, windows: &[ChunkWindow]) -> Vec<u32> {
    windows
        .iter()
        .filter(|window| {
            read_json::<ChunkResultFile>(&chunk_path(dir, window.index)).is_none_or(|chunk| {
                chunk.version != CHUNK_VERSION
                    || chunk.chunk_index != window.index
                    || chunk.chunk_start_ms != window.start_ms
                    || chunk.chunk_end_ms != window.end_ms
            })
        })
        .map(|window| window.index)
        .collect()
}

/// Drop every derived file for a session whose source changed. Best effort.
pub fn reset_artifacts(dir: &Path) {
    let _ = std::fs::remove_file(audio_path(dir));
    let _ = std::fs::remove_file(transcript_file_path(dir));
    let _ = std::fs::remove_dir_all(dir.join(CHUNKS_DIR));
}

// --- Words --------------------------------------------------------------------

pub fn normalize_word(text: &str) -> String {
    text.trim()
        .chars()
        .filter(|character| character.is_alphanumeric() || *character == '\'')
        .collect::<String>()
        .to_lowercase()
}

/// The English v1 lexicon, after lowercasing and stripping punctuation.
pub fn is_filler(text: &str) -> bool {
    let normalized = normalize_word(text);
    !normalized.is_empty() && FILLER_LEXICON.contains(&normalized.as_str())
}

/// Offset each chunk's words by its window start and split every overlap at
/// its midpoint: a word belongs to the earlier chunk when its own midpoint
/// lies before the overlap's midpoint, to the later chunk otherwise. Words
/// come out sorted by start.
pub fn stitch(windows: &[ChunkWindow], chunks: &[ChunkResultFile]) -> TranscriptFile {
    let mut words = Vec::new();
    let mut language = None;
    for (position, window) in windows.iter().enumerate() {
        let Some(chunk) = chunks
            .iter()
            .find(|chunk| chunk.chunk_index == window.index)
        else {
            continue;
        };
        if language.is_none() {
            language = chunk
                .language
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
        }
        let lower = position
            .checked_sub(1)
            .and_then(|previous| windows.get(previous))
            .map(|previous| overlap_midpoint(previous, window))
            .unwrap_or(0);
        let upper = windows
            .get(position + 1)
            .map(|next| overlap_midpoint(window, next))
            .unwrap_or(u64::MAX);
        for word in &chunk.words {
            let text = word.text.trim();
            if text.is_empty() {
                continue;
            }
            let start_ms = window.start_ms + round_ms(word.start_ms);
            let end_ms = (window.start_ms + round_ms(word.end_ms)).max(start_ms);
            let midpoint = start_ms + (end_ms - start_ms) / 2;
            if !(lower..upper).contains(&midpoint) {
                continue;
            }
            words.push(TranscriptWord {
                text: text.to_string(),
                start_ms,
                end_ms,
                confidence: word.confidence.map(|value| value.clamp(0.0, 1.0)),
                filler: word.filler == Some(true) || is_filler(text),
            });
        }
    }
    words.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    TranscriptFile {
        version: TRANSCRIPT_VERSION,
        language,
        words,
    }
}

fn overlap_midpoint(earlier: &ChunkWindow, later: &ChunkWindow) -> u64 {
    let overlap_start = later.start_ms.min(earlier.end_ms);
    overlap_start + (earlier.end_ms.saturating_sub(overlap_start)) / 2
}

fn round_ms(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.round() as u64
    } else {
        0
    }
}

// --- Failures -----------------------------------------------------------------

/// A chunk upload failure as a job failure: known codes get plain copy and
/// stay the job's `error_code`; unknown codes keep the server's message.
pub fn map_chunk_failure(failure: &AiApiFailure) -> JobFailure {
    map_api_failure(failure)
}

/// The analysis job's create and poll failures, same table.
pub fn map_job_failure(failure: &AiApiFailure) -> JobFailure {
    map_api_failure(failure)
}

fn map_api_failure(failure: &AiApiFailure) -> JobFailure {
    match failure {
        AiApiFailure::Transport { .. } => JobFailure::new(
            ERROR_NETWORK,
            "Could not reach Videorc. Check your connection and start Clean cut again; it \
             resumes where it stopped.",
        ),
        AiApiFailure::Http {
            status,
            code,
            message,
        } => {
            let code: &str = code.as_str();
            let (mapped_code, plain): (&str, String) = match code {
                "unauthorized" => (
                    ERROR_SIGNED_OUT,
                    "Sign in to continue the clean cut.".into(),
                ),
                "premium-required" | "cloud-ai-premium-required" => {
                    (ERROR_PREMIUM_REQUIRED, "Clean cut needs Premium.".into())
                }
                "ai-access-blocked" | "ai-user-disabled" => {
                    (code, "Cloud AI is not available for this account.".into())
                }
                "ai-disabled" | "clean-cut-disabled" => (
                    code,
                    "Clean cut is paused on the server. Try again later.".into(),
                ),
                "clean-cut-provider-unconfigured" => (
                    code,
                    "The transcription service is not set up yet. Try again later.".into(),
                ),
                "clean-cut-monthly-quota-exhausted" => (
                    code,
                    "This month's Clean cut minutes are used up. Start it again next month; it \
                     resumes where it stopped."
                        .into(),
                ),
                "clean-cut-provider-error" => (
                    code,
                    "The transcription service failed. Start Clean cut again to retry.".into(),
                ),
                "invalid-transcript-chunk" => (code, "The server rejected an audio chunk.".into()),
                "invalid-ai-job" => (
                    code,
                    format!("The server rejected the analysis request: {message}"),
                ),
                "clean-cut-daily-quota-exhausted" | "ai-daily-quota-exhausted" => (
                    code,
                    "Today's Clean cut analyses are used up. Try again tomorrow.".into(),
                ),
                "ai-monthly-quota-exhausted" => {
                    (code, "This month's cloud AI jobs are used up.".into())
                }
                _ if *status == 401 => (
                    ERROR_SIGNED_OUT,
                    "Sign in to continue the clean cut.".into(),
                ),
                _ if *status == 404 => {
                    (ERROR_ANALYSIS, "The server lost track of this job.".into())
                }
                _ => (code, message.clone()),
            };
            JobFailure::new(mapped_code, plain)
        }
    }
}

// --- Source -------------------------------------------------------------------

/// Path, size and mtime: enough to notice the quality gate rewriting the MP4
/// in place, cheap enough to check before every heavy step.
pub fn capture_source_identity(path: &Path) -> Result<CleanCutSourceIdentity> {
    let metadata =
        std::fs::metadata(path).with_context(|| format!("Could not read {}", path.display()))?;
    if !metadata.is_file() {
        bail!("{} is not a file", path.display());
    }
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|since_epoch| i64::try_from(since_epoch.as_millis()).ok());
    Ok(CleanCutSourceIdentity {
        path: path.display().to_string(),
        size_bytes: metadata.len(),
        modified_unix_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceProbe {
    pub frame_rate: CleanCutFrameRate,
    pub duration_ms: Option<u64>,
}

/// `num/den` (or a bare integer) reduced; `None` for zero or garbage.
pub fn parse_frame_rate(value: &str) -> Option<CleanCutFrameRate> {
    let value = value.trim();
    let (num, den) = match value.split_once('/') {
        Some((num, den)) => (
            num.trim().parse::<u64>().ok()?,
            den.trim().parse::<u64>().ok()?,
        ),
        None => (value.parse::<u64>().ok()?, 1),
    };
    if num == 0 || den == 0 {
        return None;
    }
    let divisor = gcd(num, den);
    Some(CleanCutFrameRate {
        num: u32::try_from(num / divisor).ok()?,
        den: u32::try_from(den / divisor).ok()?,
    })
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a.max(1)
}

/// `ffprobe -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate,duration:format=duration -of json`.
pub fn parse_probe_json(json: &str) -> std::result::Result<SourceProbe, String> {
    #[derive(Deserialize)]
    struct Output {
        #[serde(default)]
        streams: Vec<Stream>,
        format: Option<Format>,
    }
    #[derive(Deserialize)]
    struct Stream {
        r_frame_rate: Option<String>,
        avg_frame_rate: Option<String>,
        duration: Option<String>,
    }
    #[derive(Deserialize)]
    struct Format {
        duration: Option<String>,
    }

    let output: Output =
        serde_json::from_str(json).map_err(|error| format!("invalid ffprobe json: {error}"))?;
    let stream = output
        .streams
        .first()
        .ok_or_else(|| "the recording has no video stream".to_string())?;
    let frame_rate = stream
        .r_frame_rate
        .as_deref()
        .and_then(parse_frame_rate)
        .or_else(|| stream.avg_frame_rate.as_deref().and_then(parse_frame_rate))
        .ok_or_else(|| "the video stream has no frame rate".to_string())?;
    let duration_ms = output
        .format
        .and_then(|format| format.duration)
        .or_else(|| stream.duration.clone())
        .and_then(|duration| duration.trim().parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| (duration * 1_000.0).round() as u64);
    Ok(SourceProbe {
        frame_rate,
        duration_ms,
    })
}

pub fn probe_source_blocking(
    ffprobe_path: &str,
    source: &Path,
) -> std::result::Result<SourceProbe, JobFailure> {
    let mut command = Command::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate,duration:format=duration",
        "-of",
        "json",
        &source.display().to_string(),
    ]);
    let output = output_owned_std_with_timeout(&mut command, PROBE_TIMEOUT)
        .map_err(|error| JobFailure::new(ERROR_PROBE, format!("Could not run ffprobe: {error}")))?;
    if !output.status.success() {
        return Err(JobFailure::new(
            ERROR_PROBE,
            format!(
                "ffprobe failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    parse_probe_json(&String::from_utf8_lossy(&output.stdout)).map_err(|error| {
        JobFailure::new(
            ERROR_PROBE,
            format!("Could not read the recording's frame rate: {error}"),
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractOutcome {
    Done,
    Interrupted,
}

/// Twice the recording's length, never under two minutes.
pub fn extraction_timeout(duration_ms: Option<i64>) -> Duration {
    let duration = duration_ms
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
    Duration::from_millis(duration.saturating_mul(2)).max(Duration::from_secs(120))
}

/// First audio track to PCM s16le mono 16 kHz, through an owned child that is
/// killed on interrupt or timeout. Writes `<destination>.part` and renames.
pub fn extract_audio_blocking(
    ffmpeg_path: &str,
    source: &Path,
    destination: &Path,
    timeout: Duration,
    is_interrupted: &dyn Fn() -> bool,
) -> std::result::Result<ExtractOutcome, JobFailure> {
    let staging = destination.with_extension("wav.part");
    let _ = std::fs::remove_file(&staging);
    let mut command = Command::new(ffmpeg_path);
    command
        .args([
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &source.display().to_string(),
            "-vn",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            &staging.display().to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_std(&mut command).map_err(|error| {
        JobFailure::new(ERROR_FFMPEG, format!("Could not start FFmpeg: {error}"))
    })?;
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || read_bounded_tail(stderr));
    let deadline = Instant::now() + timeout;
    loop {
        if is_interrupted() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&staging);
            return Ok(ExtractOutcome::Interrupted);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let tail = stderr_reader.join().unwrap_or_default();
                if !status.success() {
                    let _ = std::fs::remove_file(&staging);
                    let detail = String::from_utf8_lossy(&tail).trim().to_string();
                    if detail.contains("matches no streams") {
                        return Err(JobFailure::new(
                            ERROR_NO_AUDIO,
                            "This recording has no audio track.",
                        ));
                    }
                    return Err(JobFailure::new(
                        ERROR_FFMPEG,
                        format!("FFmpeg could not extract the audio ({status}): {detail}"),
                    ));
                }
                replace_file(&staging, destination).map_err(|error| {
                    JobFailure::new(
                        ERROR_FFMPEG,
                        format!("Could not publish the extracted audio: {error}"),
                    )
                })?;
                return Ok(ExtractOutcome::Done);
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&staging);
                return Err(JobFailure::new(
                    ERROR_FFMPEG,
                    "FFmpeg took too long to extract the audio.",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&staging);
                return Err(JobFailure::new(
                    ERROR_FFMPEG,
                    format!("Could not wait for FFmpeg: {error}"),
                ));
            }
        }
    }
}

pub(super) fn read_bounded_tail<R: Read>(reader: Option<R>) -> Vec<u8> {
    let mut tail = Vec::new();
    let Some(mut reader) = reader else {
        return tail;
    };
    let mut chunk = [0_u8; 4 * 1024];
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > MAX_FFMPEG_STDERR_BYTES {
            tail.drain(..tail.len() - MAX_FFMPEG_STDERR_BYTES);
        }
    }
    tail
}

// --- The phase ----------------------------------------------------------------

fn processing(message: impl Into<String>) -> JobFailure {
    JobFailure::new(ERROR_PROCESSING, message)
}

fn upload_progress(done: usize, total: usize) -> f64 {
    if total == 0 {
        return PROGRESS_UPLOAD_START + PROGRESS_UPLOAD_SPAN;
    }
    PROGRESS_UPLOAD_START + PROGRESS_UPLOAD_SPAN * (done.min(total) as f64 / total as f64)
}

/// Make sure the session has a stitched transcript, doing only the missing
/// steps. Holds the caller's maintenance slot for the whole phase: the
/// extraction is FFmpeg work and the uploads must never run while a capture
/// is live (decision 18).
pub async fn ensure_transcript(
    ctx: &WorkerContext<'_>,
    persisted: &mut PersistedCleanCutJob,
) -> PhaseOutcome<TranscriptBundle> {
    let session_id = persisted.job.source_session_id.clone();
    let dir = clean_cut_dir(&session_id);
    if let Err(error) = std::fs::create_dir_all(dir.join(CHUNKS_DIR)) {
        return PhaseOutcome::Failed(processing(format!(
            "Could not create the Clean cut folder: {error}"
        )));
    }

    let source = match ctx.state.database.clean_cut_source(&session_id) {
        Ok(Some(source)) => source,
        Ok(None) => {
            return PhaseOutcome::Failed(JobFailure::new(
                ERROR_FILE_MISSING,
                "The recording is no longer in the Library.",
            ));
        }
        Err(error) => {
            return PhaseOutcome::Failed(processing(format!(
                "Could not read the recording: {error}"
            )));
        }
    };
    let Some(mp4_path) = source
        .mp4_path
        .as_deref()
        .filter(|path| Path::new(path).is_file())
    else {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_FILE_MISSING,
            "The recording file is missing on disk.",
        ));
    };
    let source_path = PathBuf::from(mp4_path);
    let identity = match capture_source_identity(&source_path) {
        Ok(identity) => identity,
        Err(error) => {
            return PhaseOutcome::Failed(JobFailure::new(
                ERROR_FILE_MISSING,
                format!("The recording file could not be read: {error}"),
            ));
        }
    };

    // Bind the identity now, while the slot is held. Earlier chunks made from
    // a different file (the quality gate repaired it in place) are stale.
    let mut plan: Option<ChunkPlanFile> =
        read_json(&plan_path(&dir)).filter(|plan: &ChunkPlanFile| plan.version == PLAN_VERSION);
    if plan
        .as_ref()
        .is_some_and(|plan| plan.source_identity != identity)
    {
        ctx.state.emit_log(
            "info",
            format!(
                "Clean cut: the recording for {session_id} changed; starting its transcript over."
            ),
        );
        reset_artifacts(&dir);
        plan = None;
    }
    persisted.source_identity_json = serde_json::to_string(&identity).ok();

    // Fast path: everything is already on disk.
    if let Some(plan) = plan.as_ref() {
        let transcript_path = transcript_file_path(&dir);
        if let Some(transcript) = read_json::<TranscriptFile>(&transcript_path)
            .filter(|transcript| transcript.version == TRANSCRIPT_VERSION)
        {
            persisted.job.transcript_path = Some(transcript_path.display().to_string());
            set_job_state(
                ctx.state,
                persisted,
                CleanCutJobState::Transcribing,
                Some("stitch"),
                PROGRESS_STITCHED,
            );
            return PhaseOutcome::Done(TranscriptBundle {
                transcript,
                plan: plan.clone(),
                dir,
            });
        }
    }

    // Audio, once.
    let audio = audio_path(&dir);
    if !audio.is_file() {
        set_job_state(
            ctx.state,
            persisted,
            CleanCutJobState::Transcribing,
            Some("extract-audio"),
            PROGRESS_EXTRACT,
        );
        let probe = ctx.interrupt_probe();
        let ffmpeg = default_ffmpeg_path();
        let timeout = extraction_timeout(source.duration_ms);
        let (source_for_task, audio_for_task) = (source_path.clone(), audio.clone());
        let extracted = tokio::task::spawn_blocking(move || {
            extract_audio_blocking(&ffmpeg, &source_for_task, &audio_for_task, timeout, &probe)
        })
        .await;
        match extracted {
            Ok(Ok(ExtractOutcome::Done)) => {}
            Ok(Ok(ExtractOutcome::Interrupted)) => {
                return ctx
                    .interrupts()
                    .check()
                    .unwrap_or(PhaseOutcome::CapturePreempted);
            }
            Ok(Err(failure)) => return PhaseOutcome::Failed(failure),
            Err(error) => {
                return PhaseOutcome::Failed(processing(format!(
                    "The audio extraction task failed: {error}"
                )));
            }
        }
    }

    // The plan, once per source identity.
    let plan = match plan {
        Some(plan) => plan,
        None => {
            set_job_state(
                ctx.state,
                persisted,
                CleanCutJobState::Transcribing,
                Some("probe"),
                PROGRESS_PROBE,
            );
            let ffprobe = ffprobe_path_for(&default_ffmpeg_path());
            let source_for_task = source_path.clone();
            let probed = tokio::task::spawn_blocking(move || {
                probe_source_blocking(&ffprobe, &source_for_task)
            })
            .await;
            let probe = match probed {
                Ok(Ok(probe)) => probe,
                Ok(Err(failure)) => return PhaseOutcome::Failed(failure),
                Err(error) => {
                    return PhaseOutcome::Failed(processing(format!(
                        "The probe task failed: {error}"
                    )));
                }
            };
            if let Some(outcome) = ctx.interrupts().check() {
                return outcome;
            }
            let audio_for_task = audio.clone();
            let measured = tokio::task::spawn_blocking(move || {
                let wav = open_wav(&audio_for_task)?;
                let frames = wav.rms_frames()?;
                Ok::<_, anyhow::Error>((wav.duration_ms(), frames))
            })
            .await;
            let (audio_duration_ms, frames) = match measured {
                Ok(Ok(measured)) => measured,
                Ok(Err(error)) => {
                    return PhaseOutcome::Failed(processing(format!(
                        "Could not read the extracted audio: {error}"
                    )));
                }
                Err(error) => {
                    return PhaseOutcome::Failed(processing(format!(
                        "The audio analysis task failed: {error}"
                    )));
                }
            };
            if audio_duration_ms == 0 {
                return PhaseOutcome::Failed(JobFailure::new(
                    ERROR_NO_AUDIO,
                    "This recording's audio track is empty.",
                ));
            }
            let plan = ChunkPlanFile {
                version: PLAN_VERSION,
                source_identity: identity.clone(),
                duration_ms: probe
                    .duration_ms
                    .filter(|duration| *duration > 0)
                    .unwrap_or(audio_duration_ms),
                audio_duration_ms,
                frame_rate: probe.frame_rate,
                windows: plan_chunk_windows(&frames, audio_duration_ms),
            };
            if let Err(error) = write_json_atomic(&plan_path(&dir), &plan) {
                return PhaseOutcome::Failed(processing(format!(
                    "Could not save the chunk plan: {error}"
                )));
            }
            plan
        }
    };

    // Uploads: at most two in flight, each persisted as it lands, resumable
    // at the first missing index.
    let wav = match open_wav(&audio) {
        Ok(wav) => wav,
        Err(error) => {
            return PhaseOutcome::Failed(processing(format!(
                "Could not open the extracted audio: {error}"
            )));
        }
    };
    let total = plan.windows.len();
    let mut missing = missing_chunk_indices(&dir, &plan.windows);
    let mut done = total.saturating_sub(missing.len());
    set_job_state(
        ctx.state,
        persisted,
        CleanCutJobState::Transcribing,
        Some("upload"),
        upload_progress(done, total),
    );
    while !missing.is_empty() {
        if let Some(outcome) = ctx.interrupts().check() {
            return outcome;
        }
        let take = missing.len().min(CHUNK_UPLOADS_IN_FLIGHT);
        let batch: Vec<u32> = missing.drain(..take).collect();
        let interrupts = ctx.interrupts();
        let uploads = upload_batch(ctx, &session_id, &plan, &wav, &batch);
        let results = tokio::select! {
            results = uploads => results,
            outcome = interrupts.wait() => return outcome,
        };
        let results = match results {
            Ok(results) => results,
            Err(failure) => return PhaseOutcome::Failed(failure),
        };
        let mut first_failure = None;
        for (window, result) in results {
            match result {
                Ok(response) => {
                    let chunk = ChunkResultFile {
                        version: CHUNK_VERSION,
                        chunk_index: window.index,
                        chunk_start_ms: window.start_ms,
                        chunk_end_ms: window.end_ms,
                        language: response.language,
                        words: response.words,
                    };
                    if let Err(error) = write_json_atomic(&chunk_path(&dir, window.index), &chunk) {
                        return PhaseOutcome::Failed(processing(format!(
                            "Could not save transcript chunk {}: {error}",
                            window.index
                        )));
                    }
                    done += 1;
                }
                Err(failure) => {
                    if first_failure.is_none() {
                        first_failure = Some(failure);
                    }
                }
            }
        }
        set_job_state(
            ctx.state,
            persisted,
            CleanCutJobState::Transcribing,
            Some("upload"),
            upload_progress(done, total),
        );
        if let Some(failure) = first_failure {
            ctx.state.emit_log(
                "warn",
                format!(
                    "Clean cut transcript chunk failed for {session_id}: {}",
                    failure.message()
                ),
            );
            return PhaseOutcome::Failed(map_chunk_failure(&failure));
        }
    }

    // Stitch.
    set_job_state(
        ctx.state,
        persisted,
        CleanCutJobState::Transcribing,
        Some("stitch"),
        upload_progress(total, total),
    );
    let chunks: Vec<ChunkResultFile> = plan
        .windows
        .iter()
        .filter_map(|window| read_json(&chunk_path(&dir, window.index)))
        .collect();
    if chunks.len() != total {
        return PhaseOutcome::Failed(processing(
            "Some transcript chunks are missing. Start Clean cut again to redo them.",
        ));
    }
    let transcript = stitch(&plan.windows, &chunks);
    let transcript_path = transcript_file_path(&dir);
    if let Err(error) = write_json_atomic(&transcript_path, &transcript) {
        return PhaseOutcome::Failed(processing(format!(
            "Could not save the transcript: {error}"
        )));
    }
    persisted.job.transcript_path = Some(transcript_path.display().to_string());
    set_job_state(
        ctx.state,
        persisted,
        CleanCutJobState::Transcribing,
        Some("stitch"),
        PROGRESS_STITCHED,
    );
    PhaseOutcome::Done(TranscriptBundle {
        transcript,
        plan,
        dir,
    })
}

type ChunkUploadResult = (
    ChunkWindow,
    std::result::Result<TranscriptChunkResponse, AiApiFailure>,
);

/// Build the WAV bytes for each window, then upload up to two at once.
async fn upload_batch(
    ctx: &WorkerContext<'_>,
    session_id: &str,
    plan: &ChunkPlanFile,
    wav: &WavInfo,
    indices: &[u32],
) -> std::result::Result<Vec<ChunkUploadResult>, JobFailure> {
    let mut requests = Vec::with_capacity(indices.len());
    for index in indices {
        let window = plan
            .windows
            .iter()
            .find(|window| window.index == *index)
            .cloned()
            .ok_or_else(|| processing(format!("Chunk {index} is not in the plan.")))?;
        let wav_for_task = wav.clone();
        let (start_ms, end_ms) = (window.start_ms, window.end_ms);
        let samples =
            tokio::task::spawn_blocking(move || wav_for_task.read_samples_ms(start_ms, end_ms))
                .await
                .map_err(|error| processing(format!("The chunk read task failed: {error}")))?
                .map_err(|error| processing(format!("Could not read chunk audio: {error}")))?;
        let bytes = encode_wav_16k_mono(&samples);
        if bytes.len() > CHUNK_MAX_BYTES {
            return Err(processing(format!(
                "Chunk {index} is {} bytes, over the {CHUNK_MAX_BYTES} byte limit.",
                bytes.len()
            )));
        }
        requests.push((
            window,
            TranscriptChunkRequest {
                session_client_id: session_id.to_string(),
                chunk_index: *index,
                chunk_start_ms: start_ms,
                language: None,
                wav: bytes,
            },
        ));
    }

    let mut results = Vec::with_capacity(requests.len());
    let mut pending = requests.into_iter();
    while let Some((first_window, first_request)) = pending.next() {
        match pending.next() {
            Some((second_window, second_request)) => {
                let (first, second) = tokio::join!(
                    upload_with_retries(ctx, first_request),
                    upload_with_retries(ctx, second_request)
                );
                results.push((first_window, first));
                results.push((second_window, second));
            }
            None => {
                let first = upload_with_retries(ctx, first_request).await;
                results.push((first_window, first));
            }
        }
    }
    Ok(results)
}

async fn upload_with_retries(
    ctx: &WorkerContext<'_>,
    request: TranscriptChunkRequest,
) -> std::result::Result<TranscriptChunkResponse, AiApiFailure> {
    let mut attempt = 1_u32;
    loop {
        match ctx
            .client
            .transcribe_transcript_chunk(ctx.token, request.clone())
            .await
        {
            Ok(response) => return Ok(response),
            Err(failure) if failure.is_retryable() && attempt < CHUNK_UPLOAD_ATTEMPTS => {
                tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
                attempt += 1;
            }
            Err(failure) => return Err(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(index: u32, start_ms: u64, end_ms: u64) -> ChunkWindow {
        ChunkWindow {
            index,
            start_ms,
            end_ms,
        }
    }

    fn chunk(window: &ChunkWindow, words: &[(&str, f64, f64)]) -> ChunkResultFile {
        ChunkResultFile {
            version: CHUNK_VERSION,
            chunk_index: window.index,
            chunk_start_ms: window.start_ms,
            chunk_end_ms: window.end_ms,
            language: Some("en".to_string()),
            words: words
                .iter()
                .map(|(text, start_ms, end_ms)| TranscriptChunkWord {
                    text: text.to_string(),
                    start_ms: *start_ms,
                    end_ms: *end_ms,
                    confidence: Some(0.9),
                    filler: None,
                })
                .collect(),
        }
    }

    #[test]
    fn stitching_offsets_words_and_splits_each_overlap_at_its_midpoint() {
        let windows = vec![
            window(0, 0, 115_000),
            window(1, 114_000, 231_500),
            window(2, 230_500, 300_000),
        ];
        // The overlap of chunks 0 and 1 is 114 000..115 000; its midpoint is
        // 114 500. Both chunks heard the same two words inside it.
        let chunk0 = chunk(
            &windows[0],
            &[
                ("So", 50.0, 300.0),
                ("today", 114_200.0, 114_400.0),
                ("um", 114_700.0, 114_900.0),
            ],
        );
        let chunk1 = chunk(
            &windows[1],
            &[
                ("today", 200.0, 400.0),
                ("Um,", 700.0, 900.0),
                ("we", 1_200.0, 1_400.0),
            ],
        );
        let chunk2 = chunk(&windows[2], &[("done.", 1_000.0, 1_300.0)]);
        // Order of the chunk files must not matter.
        let transcript = stitch(&windows, &[chunk2, chunk0, chunk1]);

        let texts: Vec<&str> = transcript
            .words
            .iter()
            .map(|word| word.text.as_str())
            .collect();
        assert_eq!(texts, ["So", "today", "Um,", "we", "done."]);
        assert_eq!(transcript.words[1].start_ms, 114_200);
        assert_eq!(
            transcript.words[2].start_ms, 114_700,
            "the later chunk owns the second half"
        );
        assert!(
            transcript.words[2].filler,
            "lexicon match survives punctuation and case"
        );
        assert!(!transcript.words[3].filler);
        assert_eq!(transcript.words[4].start_ms, 231_500);
        assert_eq!(transcript.language.as_deref(), Some("en"));
        assert_eq!(transcript.version, TRANSCRIPT_VERSION);
        let json = serde_json::to_value(&transcript).unwrap();
        assert!(
            json["words"][0].get("filler").is_none(),
            "filler is written only when true"
        );
        assert_eq!(json["words"][2]["filler"], serde_json::json!(true));
    }

    #[test]
    fn server_filler_tags_and_the_lexicon_both_count() {
        let windows = vec![window(0, 0, 5_000)];
        let mut tagged = chunk(&windows[0], &[("well", 0.0, 200.0), ("hmm", 300.0, 500.0)]);
        tagged.words[0].filler = Some(true);
        let transcript = stitch(&windows, &[tagged]);
        assert!(transcript.words[0].filler, "the server's tag is kept");
        assert!(transcript.words[1].filler, "the lexicon tags hmm");
        assert!(is_filler("Uh,"));
        assert!(is_filler("UMM"));
        assert!(!is_filler("umbrella"));
        assert!(!is_filler(""));
        assert_eq!(normalize_word(" Don't! "), "don't");
    }

    #[test]
    fn resume_starts_at_the_first_missing_chunk() {
        let dir =
            std::env::temp_dir().join(format!("videorc-clean-cut-resume-{}", uuid::Uuid::new_v4()));
        let windows: Vec<ChunkWindow> = (0..4)
            .map(|index| {
                window(
                    index,
                    u64::from(index) * 100_000,
                    u64::from(index) * 100_000 + 101_000,
                )
            })
            .collect();
        assert_eq!(missing_chunk_indices(&dir, &windows), vec![0, 1, 2, 3]);

        write_json_atomic(&chunk_path(&dir, 0), &chunk(&windows[0], &[])).unwrap();
        write_json_atomic(&chunk_path(&dir, 2), &chunk(&windows[2], &[])).unwrap();
        assert_eq!(missing_chunk_indices(&dir, &windows), vec![1, 3]);

        // A chunk from another plan (different start) or version is redone.
        let mut stale = chunk(&windows[1], &[]);
        stale.chunk_start_ms += 1;
        write_json_atomic(&chunk_path(&dir, 1), &stale).unwrap();
        let mut old = chunk(&windows[3], &[]);
        old.version = 0;
        write_json_atomic(&chunk_path(&dir, 3), &old).unwrap();
        assert_eq!(missing_chunk_indices(&dir, &windows), vec![1, 3]);
        assert!(!chunk_path(&dir, 1).with_extension("json.tmp").exists());

        reset_artifacts(&dir);
        assert_eq!(missing_chunk_indices(&dir, &windows), vec![0, 1, 2, 3]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn server_error_codes_become_plain_job_failures() {
        let http = |status: u16, code: &str, message: &str| AiApiFailure::Http {
            status,
            code: code.to_string(),
            message: message.to_string(),
        };
        let quota = map_chunk_failure(&http(429, "clean-cut-monthly-quota-exhausted", "x"));
        assert_eq!(quota.code, "clean-cut-monthly-quota-exhausted");
        assert!(quota.message.contains("resumes"));
        assert_eq!(
            map_chunk_failure(&http(503, "clean-cut-disabled", "x")).code,
            "clean-cut-disabled"
        );
        assert_eq!(
            map_chunk_failure(&http(503, "clean-cut-provider-unconfigured", "x")).code,
            "clean-cut-provider-unconfigured"
        );
        assert_eq!(
            map_chunk_failure(&http(403, "premium-required", "x")).code,
            ERROR_PREMIUM_REQUIRED
        );
        assert_eq!(
            map_chunk_failure(&http(401, "unauthorized", "x")).code,
            ERROR_SIGNED_OUT
        );
        assert_eq!(
            map_chunk_failure(&http(401, "something-new", "x")).code,
            ERROR_SIGNED_OUT,
            "any 401 means signed out"
        );
        let unknown = map_chunk_failure(&http(418, "teapot", "I am a teapot."));
        assert_eq!(unknown.code, "teapot");
        assert_eq!(
            unknown.message, "I am a teapot.",
            "unknown codes keep the server message"
        );
        let network = map_chunk_failure(&AiApiFailure::Transport {
            message: "dns".to_string(),
        });
        assert_eq!(network.code, ERROR_NETWORK);
        let invalid = map_job_failure(&http(400, "invalid-ai-job", "segments[3].text is empty"));
        assert_eq!(invalid.code, "invalid-ai-job");
        assert!(invalid.message.contains("segments[3].text is empty"));
        assert_eq!(
            map_job_failure(&http(429, "clean-cut-daily-quota-exhausted", "x")).code,
            "clean-cut-daily-quota-exhausted"
        );
        assert!(http(502, "clean-cut-provider-error", "x").is_retryable());
        assert!(!http(429, "clean-cut-monthly-quota-exhausted", "x").is_retryable());
    }

    #[test]
    fn frame_rates_and_probe_output_parse() {
        assert_eq!(
            parse_frame_rate("30000/1001"),
            Some(CleanCutFrameRate {
                num: 30_000,
                den: 1_001
            })
        );
        assert_eq!(
            parse_frame_rate("60/2"),
            Some(CleanCutFrameRate { num: 30, den: 1 })
        );
        assert_eq!(
            parse_frame_rate("25"),
            Some(CleanCutFrameRate { num: 25, den: 1 })
        );
        assert_eq!(parse_frame_rate("0/0"), None);
        assert_eq!(parse_frame_rate("junk"), None);

        let probe = parse_probe_json(
            r#"{"streams":[{"r_frame_rate":"30000/1001","avg_frame_rate":"29970/1000","duration":"10.5"}],"format":{"duration":"10.600000"}}"#,
        )
        .unwrap();
        assert_eq!(
            probe.frame_rate,
            CleanCutFrameRate {
                num: 30_000,
                den: 1_001
            }
        );
        assert_eq!(
            probe.duration_ms,
            Some(10_600),
            "the container duration wins"
        );
        let fallback = parse_probe_json(
            r#"{"streams":[{"r_frame_rate":"0/0","avg_frame_rate":"30/1","duration":"4.0"}]}"#,
        )
        .unwrap();
        assert_eq!(fallback.frame_rate, CleanCutFrameRate { num: 30, den: 1 });
        assert_eq!(fallback.duration_ms, Some(4_000));
        assert!(parse_probe_json(r#"{"streams":[]}"#).is_err());
        assert_eq!(extraction_timeout(Some(10_000)), Duration::from_secs(120));
        assert_eq!(
            extraction_timeout(Some(3_600_000)),
            Duration::from_secs(7_200)
        );
    }

    #[test]
    fn upload_progress_spans_the_middle_of_the_job() {
        assert!((upload_progress(0, 10) - 0.05).abs() < 1e-9);
        assert!((upload_progress(5, 10) - 0.45).abs() < 1e-9);
        assert!((upload_progress(10, 10) - 0.85).abs() < 1e-9);
        assert!((upload_progress(0, 0) - 0.85).abs() < 1e-9);
    }
}
