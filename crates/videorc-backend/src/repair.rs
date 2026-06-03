//! Recording quality analyzer — slice 1 of the recording lag cleanup & repair plan.
//!
//! Parses FFprobe JSON (`-show_format -show_streams -of json`) into a normalized
//! [`MediaProbe`], then classifies a recording against the plan's objective gates:
//! constant frame rate, no dropped-frame evidence, A/V skew under threshold, and the
//! presence of the streams a recording is expected to have. This is the pure,
//! deterministic core — repair-strategy selection, the backup/replace primitive, the
//! post-recording gate, and the UI are later slices. Introduced ahead of its wiring,
//! hence `allow(dead_code)`.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

// --- Raw FFprobe JSON ---

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    nb_frames: Option<String>,
    start_time: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    sample_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

// --- Normalized probe ---

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    /// Average frame rate over the file (FFprobe `avg_frame_rate`).
    pub avg_fps: Option<f64>,
    /// Nominal/base frame rate (FFprobe `r_frame_rate`).
    pub nominal_fps: Option<f64>,
    pub nb_frames: Option<u64>,
    pub duration: Option<f64>,
    pub start_time: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub codec: String,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<u32>,
    pub duration: Option<f64>,
    pub start_time: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub format_duration: Option<f64>,
    pub video: Option<VideoStreamInfo>,
    pub audio: Vec<AudioStreamInfo>,
}

/// Parses FFprobe `-show_format -show_streams -of json` output into a [`MediaProbe`],
/// taking the first video stream and every audio stream and converting fraction
/// frame-rates / string durations into numbers. Malformed numeric fields become
/// `None` rather than failing the whole parse.
pub fn parse_ffprobe_json(json: &str) -> Result<MediaProbe, String> {
    let raw: FfprobeOutput =
        serde_json::from_str(json).map_err(|error| format!("invalid ffprobe json: {error}"))?;

    let video = raw
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .map(|stream| VideoStreamInfo {
            codec: stream.codec_name.clone().unwrap_or_default(),
            width: stream.width.unwrap_or(0),
            height: stream.height.unwrap_or(0),
            avg_fps: stream.avg_frame_rate.as_deref().and_then(parse_fraction),
            nominal_fps: stream.r_frame_rate.as_deref().and_then(parse_fraction),
            nb_frames: stream.nb_frames.as_deref().and_then(parse_u64),
            duration: stream.duration.as_deref().and_then(parse_f64),
            start_time: stream.start_time.as_deref().and_then(parse_f64),
        });

    let audio = raw
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
        .map(|stream| AudioStreamInfo {
            codec: stream.codec_name.clone().unwrap_or_default(),
            channels: stream.channels.unwrap_or(0),
            channel_layout: stream.channel_layout.clone(),
            sample_rate: stream
                .sample_rate
                .as_deref()
                .and_then(parse_u64)
                .map(|v| v as u32),
            duration: stream.duration.as_deref().and_then(parse_f64),
            start_time: stream.start_time.as_deref().and_then(parse_f64),
        })
        .collect();

    Ok(MediaProbe {
        format_duration: raw
            .format
            .and_then(|format| format.duration)
            .as_deref()
            .and_then(parse_f64),
        video,
        audio,
    })
}

/// Runs FFprobe on a file and parses the result.
pub fn probe_media(ffprobe_path: &str, file_path: &str) -> Result<MediaProbe, String> {
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            file_path,
        ])
        .output()
        .map_err(|error| format!("could not run ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_ffprobe_json(&String::from_utf8_lossy(&output.stdout))
}

fn parse_fraction(value: &str) -> Option<f64> {
    let (num, den) = value.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 {
        return None;
    }
    let fps = num / den;
    if fps.is_finite() && fps > 0.0 {
        Some(fps)
    } else {
        None
    }
}

fn parse_f64(value: &str) -> Option<f64> {
    let parsed: f64 = value.trim().parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

fn parse_u64(value: &str) -> Option<u64> {
    value.trim().parse().ok()
}

// --- Quality classification ---

/// Tunable thresholds for the objective quality gates.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityThresholds {
    /// Maximum tolerable A/V skew before flagging a resync (ms).
    pub av_skew_ms: f64,
    /// Relative difference between average and nominal fps that counts as variable
    /// frame rate (e.g. 0.01 = 1%).
    pub vfr_tolerance: f64,
    /// Relative difference between observed and expected frame counts that counts as
    /// dropped-frame evidence (e.g. 0.02 = 2%).
    pub frame_count_tolerance: f64,
    /// RMS level (dB) at or below which an audio channel counts as silent.
    pub silence_db: f64,
    /// Minimum freeze duration (seconds) that counts as a user-visible long freeze.
    pub min_freeze_seconds: f64,
}

impl Default for QualityThresholds {
    fn default() -> Self {
        Self {
            av_skew_ms: 250.0,
            vfr_tolerance: 0.01,
            frame_count_tolerance: 0.02,
            silence_db: -70.0,
            min_freeze_seconds: 2.0,
        }
    }
}

/// What a recording is expected to contain, so the analyzer doesn't penalise a
/// legitimately screen-only (no-mic) capture for "missing audio".
#[derive(Debug, Clone, Copy)]
pub struct QualityExpectations {
    /// The session's intended fps (from metadata) used to judge frame pacing; falls
    /// back to the file's nominal fps when `None`.
    pub intended_fps: Option<f64>,
    /// Whether a microphone/audio source was selected for this recording.
    pub expect_audio: bool,
}

impl Default for QualityExpectations {
    fn default() -> Self {
        Self {
            intended_fps: None,
            expect_audio: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum QualityIssue {
    MissingVideo,
    MissingAudio,
    VariableFrameRate {
        avg_fps: f64,
        nominal_fps: f64,
    },
    DroppedFrames {
        observed: u64,
        expected: u64,
    },
    AvSkew {
        ms: f64,
    },
    /// A multi-channel stream where one channel carries signal and another is silent
    /// (the classic one-sided USB-mic capture).
    OneSidedAudio {
        silent_channel: usize,
    },
    /// One or more user-visible long freezes (repeated/frozen frames).
    FrozenSegments {
        count: usize,
        longest_seconds: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QualityVerdict {
    /// Passes every objective gate — deliverable as-is.
    Clean,
    /// Has only issues an FFmpeg-only repair can fix.
    Repairable,
    /// Best-effort only; surface as "not 100%" with reasons (e.g. missing streams).
    NeedsReview,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub verdict: QualityVerdict,
    pub issues: Vec<QualityIssue>,
}

/// Classifies a probed recording against the objective gates. Frame pacing (VFR) and
/// A/V skew are repairable; missing streams need review. Frozen-segment and one-sided
/// audio detection (which need frame/signal analysis, not just metadata) are added in
/// later slices.
pub fn classify_quality(
    probe: &MediaProbe,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> QualityReport {
    let mut issues = Vec::new();
    let mut repairable = false;
    let mut needs_review = false;

    let Some(video) = &probe.video else {
        return QualityReport {
            verdict: QualityVerdict::NeedsReview,
            issues: vec![QualityIssue::MissingVideo],
        };
    };

    // Variable frame rate: average diverges from the nominal/base rate.
    if let (Some(avg), Some(nominal)) = (video.avg_fps, video.nominal_fps)
        && nominal > 0.0
        && (avg - nominal).abs() / nominal > thresholds.vfr_tolerance
    {
        issues.push(QualityIssue::VariableFrameRate {
            avg_fps: avg,
            nominal_fps: nominal,
        });
        repairable = true;
    }

    // Dropped-frame evidence: observed frame count vs duration × fps.
    let pacing_fps = expectations
        .intended_fps
        .or(video.avg_fps)
        .or(video.nominal_fps);
    if let (Some(nb), Some(duration), Some(fps)) = (video.nb_frames, video.duration, pacing_fps) {
        let expected = (duration * fps).round() as u64;
        if expected > 0 {
            let diff = nb.abs_diff(expected);
            if (diff as f64) / (expected as f64) > thresholds.frame_count_tolerance {
                issues.push(QualityIssue::DroppedFrames {
                    observed: nb,
                    expected,
                });
                repairable = true;
            }
        }
    }

    // Audio presence + A/V skew.
    if probe.audio.is_empty() {
        if expectations.expect_audio {
            issues.push(QualityIssue::MissingAudio);
            needs_review = true;
        }
    } else if let Some(ms) = av_skew_ms(video, &probe.audio[0])
        && ms > thresholds.av_skew_ms
    {
        issues.push(QualityIssue::AvSkew { ms });
        repairable = true;
    }

    let verdict = if needs_review {
        QualityVerdict::NeedsReview
    } else if repairable {
        QualityVerdict::Repairable
    } else {
        QualityVerdict::Clean
    };
    QualityReport { verdict, issues }
}

/// A/V skew in milliseconds, preferring stream start-time offset, falling back to a
/// duration mismatch.
fn av_skew_ms(video: &VideoStreamInfo, audio: &AudioStreamInfo) -> Option<f64> {
    if let (Some(video_start), Some(audio_start)) = (video.start_time, audio.start_time) {
        return Some((video_start - audio_start).abs() * 1000.0);
    }
    if let (Some(video_duration), Some(audio_duration)) = (video.duration, audio.duration) {
        return Some((video_duration - audio_duration).abs() * 1000.0);
    }
    None
}

// --- Audio channel balance (slice 2: one-sided mic detection) ---

/// The RMS level of one audio channel, from FFmpeg `astats`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChannelLevel {
    pub channel: usize,
    pub rms_db: f64,
}

/// Parses per-channel RMS levels from FFmpeg `astats` output (printed to stderr). A
/// silent channel reports `RMS level dB: -inf`, which becomes `f64::NEG_INFINITY`.
/// Each `Channel: N` line opens a block; the first `RMS level dB:` after it is that
/// channel's level.
pub fn parse_astats_levels(output: &str) -> Vec<ChannelLevel> {
    let mut levels = Vec::new();
    let mut current: Option<usize> = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.split("Channel:").nth(1) {
            current = rest.trim().parse::<usize>().ok();
        } else if let (Some(channel), Some(rest)) = (current, line.split("RMS level dB:").nth(1)) {
            let value = rest.trim();
            let rms_db = if value.eq_ignore_ascii_case("-inf") {
                f64::NEG_INFINITY
            } else {
                value.parse::<f64>().unwrap_or(f64::NEG_INFINITY)
            };
            levels.push(ChannelLevel { channel, rms_db });
            current = None;
        }
    }
    levels
}

/// Returns the index of a silent channel when the stream is one-sided: at least two
/// channels, one at/below `silence_db` while another carries signal above it. An
/// entirely-silent stream is missing/broken audio, not one-sided, so returns `None`.
pub fn detect_one_sided_audio(levels: &[ChannelLevel], silence_db: f64) -> Option<usize> {
    if levels.len() < 2 {
        return None;
    }
    let has_signal = levels.iter().any(|level| level.rms_db > silence_db);
    if !has_signal {
        return None;
    }
    levels
        .iter()
        .find(|level| level.rms_db <= silence_db)
        .map(|level| level.channel)
}

/// Runs FFmpeg `astats` over a file's first audio stream and returns per-channel RMS
/// levels. astats writes to stderr even on a successful pass.
pub fn analyze_audio_balance(
    ffmpeg_path: &str,
    file_path: &str,
) -> Result<Vec<ChannelLevel>, String> {
    let output = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-nostats",
            "-i",
            file_path,
            "-map",
            "0:a:0",
            "-af",
            "astats=metadata=1:reset=0",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|error| format!("could not run ffmpeg astats: {error}"))?;
    Ok(parse_astats_levels(&String::from_utf8_lossy(
        &output.stderr,
    )))
}

// --- Freeze / repeated-frame detection (slice 4) ---

/// A frozen segment of video (a stretch of repeated/identical frames).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FreezeSegment {
    pub start: f64,
    pub duration: f64,
}

/// Parses freeze segments from FFmpeg `freezedetect` output. Each freeze emits a
/// `freeze_start: T` line followed by a `freeze_duration: D` line (the `freeze_end`
/// line is ignored).
pub fn parse_freezedetect(output: &str) -> Vec<FreezeSegment> {
    let mut segments = Vec::new();
    let mut pending_start: Option<f64> = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.split("freeze_start:").nth(1) {
            pending_start = rest.trim().parse::<f64>().ok();
        } else if let Some(rest) = line.split("freeze_duration:").nth(1)
            && let (Some(start), Ok(duration)) = (pending_start.take(), rest.trim().parse::<f64>())
        {
            segments.push(FreezeSegment { start, duration });
        }
    }
    segments
}

/// Freezes at or beyond `min_freeze_seconds` — the user-visible long freezes.
pub fn long_freezes(segments: &[FreezeSegment], min_freeze_seconds: f64) -> Vec<FreezeSegment> {
    segments
        .iter()
        .filter(|segment| segment.duration >= min_freeze_seconds)
        .copied()
        .collect()
}

/// Runs FFmpeg `freezedetect` over a file's video stream and returns the freeze
/// segments it reports (printed to stderr at info level).
pub fn detect_freezes(
    ffmpeg_path: &str,
    file_path: &str,
    noise_db: f64,
    min_freeze_seconds: f64,
) -> Result<Vec<FreezeSegment>, String> {
    let filter = format!("freezedetect=n={noise_db}dB:d={min_freeze_seconds}");
    let output = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-i",
            file_path,
            "-map",
            "0:v:0",
            "-vf",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|error| format!("could not run freezedetect: {error}"))?;
    Ok(parse_freezedetect(&String::from_utf8_lossy(&output.stderr)))
}

// --- Repair strategy selection (slice 5) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoRepair {
    /// Video is good; stream-copy it untouched.
    Copy,
    /// Frames are good but container timestamps are bad; copy + regenerate timestamps.
    CleanRemux,
    /// Variable/wrong frame rate; re-encode to a constant rate (visually lossless).
    CfrTranscode,
    /// Dropped/missing frames cause visible stutter; motion-interpolate to fill them.
    Interpolate,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum AudioRepair {
    /// Audio is good; stream-copy it.
    Copy,
    /// One-sided mic: duplicate the active channel to both (0-indexed for `pan`).
    CenterChannel { source_channel: usize },
    /// A/V skew: shift audio to realign (positive = audio starts after video).
    Resync { offset_ms: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    pub video: VideoRepair,
    pub audio: AudioRepair,
    pub target_fps: f64,
    /// True when interpolation was used (drives the transparent "interpolated" badge).
    pub interpolated: bool,
}

/// Selects the max-quality FFmpeg repair plan, or `None` when nothing can/should be
/// repaired (already clean, or only FFmpeg-unrepairable issues like a missing stream).
/// Quality-first: dropped/frozen frames get motion interpolation, plain VFR gets a CFR
/// transcode, one-sided audio is centered, and A/V skew is resynced.
pub fn select_repair_plan(
    report: &QualityReport,
    probe: &MediaProbe,
    expectations: &QualityExpectations,
) -> Option<RepairPlan> {
    let target_fps = expectations
        .intended_fps
        .or_else(|| probe.video.as_ref().and_then(|video| video.nominal_fps))
        .or_else(|| probe.video.as_ref().and_then(|video| video.avg_fps))
        .unwrap_or(30.0);

    let mut video = VideoRepair::Copy;
    let mut audio = AudioRepair::Copy;
    let mut repairable = false;

    for issue in &report.issues {
        match issue {
            QualityIssue::DroppedFrames { .. } | QualityIssue::FrozenSegments { .. } => {
                video = VideoRepair::Interpolate;
                repairable = true;
            }
            QualityIssue::VariableFrameRate { .. } => {
                if video == VideoRepair::Copy {
                    video = VideoRepair::CfrTranscode;
                }
                repairable = true;
            }
            QualityIssue::OneSidedAudio { silent_channel } => {
                // astats channels are 1-indexed; the active (source) channel for `pan`
                // is 0-indexed. For stereo: silent ch 1 -> source c1, silent ch 2 -> c0.
                let source_channel = usize::from(*silent_channel == 1);
                audio = AudioRepair::CenterChannel { source_channel };
                repairable = true;
            }
            QualityIssue::AvSkew { .. } => {
                if matches!(audio, AudioRepair::Copy) {
                    let offset_ms = signed_av_offset_ms(probe).unwrap_or(0.0);
                    audio = AudioRepair::Resync { offset_ms };
                }
                repairable = true;
            }
            // FFmpeg-only repair cannot synthesise a missing stream.
            QualityIssue::MissingVideo | QualityIssue::MissingAudio => {}
        }
    }

    if !repairable {
        return None;
    }
    let interpolated = video == VideoRepair::Interpolate;
    Some(RepairPlan {
        video,
        audio,
        target_fps,
        interpolated,
    })
}

/// Signed A/V offset in ms (positive = audio starts after video), from stream start
/// times, used to pick the resync direction.
fn signed_av_offset_ms(probe: &MediaProbe) -> Option<f64> {
    let video = probe.video.as_ref()?;
    let audio = probe.audio.first()?;
    Some((audio.start_time? - video.start_time?) * 1000.0)
}

/// Builds the FFmpeg command for a repair plan. Re-encodes are visually lossless
/// (libx264 CRF 18); audio repairs re-encode to AAC. Resync trims a late audio start or
/// delays an early one.
pub fn build_repair_args(input: &str, output: &str, plan: &RepairPlan) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        input.to_string(),
    ];

    let mut video_filters: Vec<String> = Vec::new();
    match plan.video {
        VideoRepair::Copy => args.extend(["-c:v".to_string(), "copy".to_string()]),
        VideoRepair::CleanRemux => args.extend([
            "-c:v".to_string(),
            "copy".to_string(),
            "-fflags".to_string(),
            "+genpts".to_string(),
        ]),
        VideoRepair::CfrTranscode => video_filters.push(format!("fps={}", plan.target_fps)),
        VideoRepair::Interpolate => video_filters.push(format!(
            "minterpolate=fps={}:mi_mode=mci:mc_mode=aobmc",
            plan.target_fps
        )),
    }

    let mut audio_filters: Vec<String> = Vec::new();
    let mut audio_copy = false;
    match &plan.audio {
        AudioRepair::Copy => audio_copy = true,
        AudioRepair::CenterChannel { source_channel } => {
            audio_filters.push(format!(
                "pan=stereo|c0=c{source_channel}|c1=c{source_channel}"
            ));
        }
        AudioRepair::Resync { offset_ms } => {
            if *offset_ms >= 0.0 {
                // Audio starts late → trim its leading offset to realign with video.
                let seconds = offset_ms / 1000.0;
                audio_filters.push(format!("atrim=start={seconds},asetpts=PTS-STARTPTS"));
            } else {
                // Audio starts early → delay it.
                let ms = offset_ms.abs().round() as i64;
                audio_filters.push(format!("adelay={ms}:all=1"));
            }
        }
    }

    if !video_filters.is_empty() {
        args.extend([
            "-vf".to_string(),
            video_filters.join(","),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-crf".to_string(),
            "18".to_string(),
            "-preset".to_string(),
            "medium".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]);
    }
    if audio_copy {
        args.extend(["-c:a".to_string(), "copy".to_string()]);
    } else if !audio_filters.is_empty() {
        args.extend([
            "-af".to_string(),
            audio_filters.join(","),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
        ]);
    }
    args.push(output.to_string());
    args
}

// --- Safe backup-then-atomic-replace (slice 6) ---

/// The hidden persistent backup directory name, kept beside each recording.
pub const BACKUP_DIR: &str = ".videorc-backups";

#[derive(Debug)]
pub enum SafeReplaceError {
    /// The repaired output did not pass validation; the original was left untouched.
    ValidationFailed(String),
    /// A filesystem operation failed (e.g. a locked file during replace).
    Io(String),
    /// The original path has no parent/filename.
    InvalidPath,
}

impl std::fmt::Display for SafeReplaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SafeReplaceError::ValidationFailed(reason) => {
                write!(f, "repaired output failed validation: {reason}")
            }
            SafeReplaceError::Io(reason) => write!(f, "{reason}"),
            SafeReplaceError::InvalidPath => write!(f, "invalid recording path"),
        }
    }
}

/// The hidden persistent backup path for an original recording:
/// `<dir>/.videorc-backups/<filename>`.
pub fn backup_path_for(original: &Path) -> Option<PathBuf> {
    let dir = original.parent()?;
    let name = original.file_name()?;
    Some(dir.join(BACKUP_DIR).join(name))
}

/// Atomically replaces `original` with `repaired_temp` — but only after `repaired_temp`
/// passes `validate`. The original is first copied to its hidden persistent backup, so
/// it can always be restored. On validation failure the original is left untouched and
/// the temp removed. The replace is an atomic rename, so `repaired_temp` must live on
/// the same filesystem (the caller writes it beside the original). Returns the backup
/// path on success.
pub fn safe_replace<V>(
    original: &Path,
    repaired_temp: &Path,
    validate: V,
) -> Result<PathBuf, SafeReplaceError>
where
    V: FnOnce(&Path) -> Result<(), String>,
{
    if let Err(reason) = validate(repaired_temp) {
        let _ = fs::remove_file(repaired_temp);
        return Err(SafeReplaceError::ValidationFailed(reason));
    }

    let backup = backup_path_for(original).ok_or(SafeReplaceError::InvalidPath)?;
    if let Some(backup_dir) = backup.parent() {
        fs::create_dir_all(backup_dir).map_err(|error| SafeReplaceError::Io(error.to_string()))?;
    }
    fs::copy(original, &backup)
        .map_err(|error| SafeReplaceError::Io(format!("backup failed: {error}")))?;

    fs::rename(repaired_temp, original)
        .map_err(|error| SafeReplaceError::Io(format!("replace failed: {error}")))?;
    Ok(backup)
}

/// Restores an original recording from its hidden backup, returning `false` if no
/// backup exists. Backups persist until the user deletes them, so this stays available.
pub fn restore_from_backup(original: &Path) -> Result<bool, SafeReplaceError> {
    let backup = backup_path_for(original).ok_or(SafeReplaceError::InvalidPath)?;
    if !backup.exists() {
        return Ok(false);
    }
    fs::copy(&backup, original).map_err(|error| SafeReplaceError::Io(error.to_string()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEAN_JSON: &str = r#"{
        "streams": [
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"10.000000",
             "nb_frames":"300","start_time":"0.000000"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"channel_layout":"stereo",
             "sample_rate":"48000","duration":"10.000000","start_time":"0.000000"}
        ],
        "format": {"duration":"10.000000"}
    }"#;

    fn thresholds() -> QualityThresholds {
        QualityThresholds::default()
    }

    #[test]
    fn parses_clean_probe() {
        let probe = parse_ffprobe_json(CLEAN_JSON).unwrap();
        assert_eq!(probe.format_duration, Some(10.0));
        let video = probe.video.unwrap();
        assert_eq!(video.codec, "h264");
        assert_eq!((video.width, video.height), (1920, 1080));
        assert_eq!(video.avg_fps, Some(30.0));
        assert_eq!(video.nominal_fps, Some(30.0));
        assert_eq!(video.nb_frames, Some(300));
        assert_eq!(probe.audio.len(), 1);
        assert_eq!(probe.audio[0].channels, 2);
        assert_eq!(probe.audio[0].sample_rate, Some(48000));
    }

    #[test]
    fn parses_ntsc_and_invalid_fractions() {
        assert_eq!(parse_fraction("30/1"), Some(30.0));
        assert!((parse_fraction("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_fraction("0/0"), None);
        assert_eq!(parse_fraction("0/1"), None);
        assert_eq!(parse_fraction("notafraction"), None);
    }

    #[test]
    fn clean_recording_passes_every_gate() {
        let probe = parse_ffprobe_json(CLEAN_JSON).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::Clean);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn variable_frame_rate_is_repairable() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"24/1","duration":"10.0","nb_frames":"240","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"10.0","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(matches!(
            report.issues[0],
            QualityIssue::VariableFrameRate { .. }
        ));
    }

    #[test]
    fn dropped_frames_detected_from_count_vs_duration() {
        // 30fps × 10s should be ~300 frames; 250 is well short.
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"10.0","nb_frames":"250","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"10.0","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(report.issues.iter().any(|issue| matches!(
            issue,
            QualityIssue::DroppedFrames {
                observed: 250,
                expected: 300
            }
        )));
    }

    #[test]
    fn av_skew_above_threshold_is_repairable() {
        // Audio starts 500 ms after video → 500 ms skew > 250 ms.
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"10.0","nb_frames":"300","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"10.0","start_time":"0.5"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(report.issues.iter().any(|issue| matches!(
            issue,
            QualityIssue::AvSkew { ms } if (*ms - 500.0).abs() < 1.0
        )));
    }

    #[test]
    fn small_av_skew_passes() {
        // 100 ms skew is under the 250 ms gate.
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"10.0","nb_frames":"300","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"10.0","start_time":"0.1"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::Clean);
    }

    #[test]
    fn missing_video_needs_review() {
        let json = r#"{"streams":[
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"10.0","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::NeedsReview);
        assert_eq!(report.issues, vec![QualityIssue::MissingVideo]);
    }

    #[test]
    fn missing_audio_only_flagged_when_expected() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"10.0","nb_frames":"300","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();

        // A screen-only capture (no mic expected) is clean without audio.
        let lenient = QualityExpectations {
            expect_audio: false,
            ..QualityExpectations::default()
        };
        assert_eq!(
            classify_quality(&probe, &thresholds(), &lenient).verdict,
            QualityVerdict::Clean
        );

        // When audio was expected, its absence needs review.
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());
        assert_eq!(report.verdict, QualityVerdict::NeedsReview);
        assert_eq!(report.issues, vec![QualityIssue::MissingAudio]);
    }

    #[test]
    fn report_serializes_to_tagged_json() {
        let report = QualityReport {
            verdict: QualityVerdict::Repairable,
            issues: vec![QualityIssue::AvSkew { ms: 500.0 }],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"verdict\":\"repairable\""));
        assert!(json.contains("\"kind\":\"av-skew\""));
    }

    const ASTATS_ONE_SIDED: &str = "[astats] Channel: 1\n[astats] DC offset: 0.0\n\
        [astats] RMS level dB: -21.345\n[astats] Peak level dB: -6.0\n\
        [astats] Channel: 2\n[astats] RMS level dB: -inf\n[astats] Peak level dB: -inf\n\
        [astats] Overall\n[astats] RMS level dB: -24.1\n";

    #[test]
    fn parses_per_channel_rms_levels() {
        let levels = parse_astats_levels(ASTATS_ONE_SIDED);
        assert_eq!(levels.len(), 2, "the overall block is not a channel");
        assert_eq!(levels[0].channel, 1);
        assert!((levels[0].rms_db - (-21.345)).abs() < 0.001);
        assert_eq!(levels[1].channel, 2);
        assert_eq!(levels[1].rms_db, f64::NEG_INFINITY);
    }

    #[test]
    fn detects_one_sided_mic() {
        let levels = parse_astats_levels(ASTATS_ONE_SIDED);
        assert_eq!(detect_one_sided_audio(&levels, -70.0), Some(2));
    }

    #[test]
    fn balanced_stereo_is_not_one_sided() {
        let levels = [
            ChannelLevel {
                channel: 1,
                rms_db: -20.0,
            },
            ChannelLevel {
                channel: 2,
                rms_db: -22.0,
            },
        ];
        assert_eq!(detect_one_sided_audio(&levels, -70.0), None);
    }

    #[test]
    fn fully_silent_stereo_is_not_one_sided() {
        // Both silent => missing/broken audio (handled elsewhere), not "one-sided".
        let levels = [
            ChannelLevel {
                channel: 1,
                rms_db: f64::NEG_INFINITY,
            },
            ChannelLevel {
                channel: 2,
                rms_db: -95.0,
            },
        ];
        assert_eq!(detect_one_sided_audio(&levels, -70.0), None);
    }

    #[test]
    fn mono_is_never_one_sided() {
        let levels = [ChannelLevel {
            channel: 1,
            rms_db: -20.0,
        }];
        assert_eq!(detect_one_sided_audio(&levels, -70.0), None);
    }

    const FREEZEDETECT_OUTPUT: &str = "[freezedetect] lavfi.freezedetect.freeze_start: 5\n\
        [freezedetect] lavfi.freezedetect.freeze_duration: 3.5\n\
        [freezedetect] lavfi.freezedetect.freeze_end: 8.5\n\
        [freezedetect] lavfi.freezedetect.freeze_start: 20\n\
        [freezedetect] lavfi.freezedetect.freeze_duration: 1.0\n\
        [freezedetect] lavfi.freezedetect.freeze_end: 21.0\n";

    #[test]
    fn parses_freeze_segments() {
        let segments = parse_freezedetect(FREEZEDETECT_OUTPUT);
        assert_eq!(segments.len(), 2);
        assert_eq!(
            segments[0],
            FreezeSegment {
                start: 5.0,
                duration: 3.5
            }
        );
        assert_eq!(
            segments[1],
            FreezeSegment {
                start: 20.0,
                duration: 1.0
            }
        );
    }

    #[test]
    fn long_freezes_filters_by_duration() {
        let segments = parse_freezedetect(FREEZEDETECT_OUTPUT);
        let long = long_freezes(&segments, 2.0);
        assert_eq!(long.len(), 1, "only the 3.5s freeze is long");
        assert_eq!(long[0].duration, 3.5);
    }

    fn probe_for_strategy() -> MediaProbe {
        MediaProbe {
            format_duration: Some(10.0),
            video: Some(VideoStreamInfo {
                codec: "h264".to_string(),
                width: 1920,
                height: 1080,
                avg_fps: Some(30.0),
                nominal_fps: Some(30.0),
                nb_frames: Some(300),
                duration: Some(10.0),
                start_time: Some(0.0),
            }),
            audio: vec![AudioStreamInfo {
                codec: "aac".to_string(),
                channels: 2,
                channel_layout: Some("stereo".to_string()),
                sample_rate: Some(48000),
                duration: Some(10.0),
                start_time: Some(0.5),
            }],
        }
    }

    fn report_with(issues: Vec<QualityIssue>) -> QualityReport {
        QualityReport {
            verdict: QualityVerdict::Repairable,
            issues,
        }
    }

    #[test]
    fn vfr_selects_cfr_transcode() {
        let report = report_with(vec![QualityIssue::VariableFrameRate {
            avg_fps: 24.0,
            nominal_fps: 30.0,
        }]);
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
        )
        .unwrap();
        assert_eq!(plan.video, VideoRepair::CfrTranscode);
        assert_eq!(plan.audio, AudioRepair::Copy);
        assert!(!plan.interpolated);
        assert_eq!(plan.target_fps, 30.0);
    }

    #[test]
    fn dropped_frames_select_interpolation() {
        let report = report_with(vec![QualityIssue::DroppedFrames {
            observed: 250,
            expected: 300,
        }]);
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
        )
        .unwrap();
        assert_eq!(plan.video, VideoRepair::Interpolate);
        assert!(plan.interpolated);
    }

    #[test]
    fn one_sided_audio_centers_active_channel() {
        // Silent astats channel 2 -> active source channel c0.
        let report = report_with(vec![QualityIssue::OneSidedAudio { silent_channel: 2 }]);
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
        )
        .unwrap();
        assert_eq!(plan.audio, AudioRepair::CenterChannel { source_channel: 0 });
    }

    #[test]
    fn skew_selects_signed_resync() {
        // Probe audio starts 0.5s after video → +500 ms (audio late).
        let report = report_with(vec![QualityIssue::AvSkew { ms: 500.0 }]);
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
        )
        .unwrap();
        assert!(matches!(
            plan.audio,
            AudioRepair::Resync { offset_ms } if (offset_ms - 500.0).abs() < 1.0
        ));
    }

    #[test]
    fn clean_or_missing_stream_needs_no_repair() {
        let clean = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        assert!(
            select_repair_plan(
                &clean,
                &probe_for_strategy(),
                &QualityExpectations::default()
            )
            .is_none()
        );

        let missing = QualityReport {
            verdict: QualityVerdict::NeedsReview,
            issues: vec![QualityIssue::MissingVideo],
        };
        assert!(
            select_repair_plan(
                &missing,
                &probe_for_strategy(),
                &QualityExpectations::default()
            )
            .is_none()
        );
    }

    #[test]
    fn build_args_for_cfr_transcode() {
        let plan = RepairPlan {
            video: VideoRepair::CfrTranscode,
            audio: AudioRepair::Copy,
            target_fps: 30.0,
            interpolated: false,
        };
        let args = build_repair_args("in.mp4", "out.mp4", &plan);
        assert!(args.iter().any(|arg| arg == "fps=30"));
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(args.windows(2).any(|w| w[0] == "-crf" && w[1] == "18"));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "copy"));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn build_args_for_channel_repair_uses_pan() {
        let plan = RepairPlan {
            video: VideoRepair::Copy,
            audio: AudioRepair::CenterChannel { source_channel: 0 },
            target_fps: 30.0,
            interpolated: false,
        };
        let args = build_repair_args("in.mp4", "out.mp4", &plan);
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"));
        assert!(args.iter().any(|arg| arg == "pan=stereo|c0=c0|c1=c0"));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("videorc-repair-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn derives_hidden_backup_path() {
        let backup = backup_path_for(Path::new("/movies/Videorc/rec.mp4")).unwrap();
        assert_eq!(
            backup,
            Path::new("/movies/Videorc/.videorc-backups/rec.mp4")
        );
    }

    #[test]
    fn safe_replace_backs_up_then_replaces_on_valid_output() {
        let dir = scratch_dir("replace-valid");
        let original = dir.join("rec.mp4");
        let temp = dir.join("rec.repaired.mp4");
        fs::write(&original, b"ORIGINAL").unwrap();
        fs::write(&temp, b"REPAIRED").unwrap();

        let backup = safe_replace(&original, &temp, |_| Ok(())).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"REPAIRED");
        assert_eq!(fs::read(&backup).unwrap(), b"ORIGINAL");
        assert!(!temp.exists(), "temp consumed by the rename");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_replace_keeps_original_when_validation_fails() {
        let dir = scratch_dir("replace-invalid");
        let original = dir.join("rec.mp4");
        let temp = dir.join("rec.repaired.mp4");
        fs::write(&original, b"ORIGINAL").unwrap();
        fs::write(&temp, b"BROKEN").unwrap();

        let result = safe_replace(&original, &temp, |_| Err("still not 100%".to_string()));
        assert!(matches!(result, Err(SafeReplaceError::ValidationFailed(_))));
        assert_eq!(
            fs::read(&original).unwrap(),
            b"ORIGINAL",
            "original untouched"
        );
        assert!(!temp.exists(), "failed temp removed");
        assert!(
            !backup_path_for(&original).unwrap().exists(),
            "no backup is written before validation passes"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_brings_back_the_original() {
        let dir = scratch_dir("restore");
        let original = dir.join("rec.mp4");
        let temp = dir.join("rec.repaired.mp4");
        fs::write(&original, b"ORIGINAL").unwrap();
        fs::write(&temp, b"REPAIRED").unwrap();
        safe_replace(&original, &temp, |_| Ok(())).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"REPAIRED");

        assert!(restore_from_backup(&original).unwrap());
        assert_eq!(
            fs::read(&original).unwrap(),
            b"ORIGINAL",
            "restored from backup"
        );

        // A file that was never repaired has no backup.
        let other = dir.join("never-repaired.mp4");
        fs::write(&other, b"X").unwrap();
        assert!(!restore_from_backup(&other).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
