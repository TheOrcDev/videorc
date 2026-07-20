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

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::process_job::spawn_owned_std;

pub const MAINTENANCE_CANCELLED: &str = "maintenance cancelled";
pub const STRICT_AV_SKEW_HARD_FAIL_MS: f64 = 150.0;
pub const STRICT_MAX_AUDIO_GAP_MS: f64 = 20.0;
pub const STRICT_AUDIO_GAP_TOLERANCE_MS: f64 = 5.0;
pub const STRICT_MAX_REPEATED_FRAME_RUN: usize = 2;
pub const STRICT_MAX_FREEZE_SECONDS: f64 = 0.100;

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

fn never_cancelled() -> bool {
    false
}

fn check_cancelled(is_cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    if is_cancelled() {
        Err(MAINTENANCE_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

fn run_output_cancellable(
    command: &mut Command,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Output, String> {
    check_cancelled(is_cancelled)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child =
        spawn_owned_std(command).map_err(|error| format!("could not spawn process: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = stdout.map(|mut stream| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            bytes
        })
    });
    let stderr_reader = stderr.map(|mut stream| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            bytes
        })
    });

    loop {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.map(|reader| reader.join());
            let _ = stderr_reader.map(|reader| reader.join());
            return Err(MAINTENANCE_CANCELLED.to_string());
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader
                    .map(|reader| reader.join().unwrap_or_default())
                    .unwrap_or_default();
                let stderr = stderr_reader
                    .map(|reader| reader.join().unwrap_or_default())
                    .unwrap_or_default();
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.map(|reader| reader.join());
                let _ = stderr_reader.map(|reader| reader.join());
                return Err(format!("could not wait for process: {error}"));
            }
        }
    }
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
    probe_media_cancellable(ffprobe_path, file_path, &never_cancelled)
}

/// Runs FFprobe on a file and parses the result, killing the process if cancellation
/// is requested by the capture-first maintenance coordinator.
pub fn probe_media_cancellable(
    ffprobe_path: &str,
    file_path: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<MediaProbe, String> {
    let mut command = Command::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file_path,
    ]);
    let output = run_output_cancellable(&mut command, is_cancelled)
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
    /// Maximum tolerable A/V skew before hard-failing the recording (ms).
    pub av_skew_ms: f64,
    /// Relative difference between average and nominal fps that counts as variable
    /// frame rate (e.g. 0.01 = 1%).
    pub vfr_tolerance: f64,
    /// Relative difference between observed and expected frame counts that counts as
    /// dropped-frame evidence (e.g. 0.02 = 2%).
    pub frame_count_tolerance: f64,
    /// RMS level (dB) at or below which an audio channel counts as silent.
    pub silence_db: f64,
    /// Minimum freeze duration (seconds) that counts as a user-visible freeze.
    pub min_freeze_seconds: f64,
    /// Maximum allowed exact decoded-frame run before repeated frames fail the gate.
    pub max_repeated_frame_run: usize,
    /// Maximum allowed audio packet PTS gap before audio fails the gate.
    pub max_audio_gap_ms: f64,
    /// Tolerance for normal packet-duration rounding jitter in audio PTS gap checks.
    pub audio_gap_tolerance_ms: f64,
}

impl Default for QualityThresholds {
    fn default() -> Self {
        Self {
            av_skew_ms: STRICT_AV_SKEW_HARD_FAIL_MS,
            vfr_tolerance: 0.01,
            frame_count_tolerance: 0.02,
            silence_db: -70.0,
            min_freeze_seconds: STRICT_MAX_FREEZE_SECONDS,
            max_repeated_frame_run: STRICT_MAX_REPEATED_FRAME_RUN,
            max_audio_gap_ms: STRICT_MAX_AUDIO_GAP_MS,
            audio_gap_tolerance_ms: STRICT_AUDIO_GAP_TOLERANCE_MS,
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
    /// One or more user-visible long freezes (repeated/frozen frames), corroborated
    /// by exact decoded-frame repeats — a real pipeline defect.
    FrozenSegments {
        count: usize,
        longest_seconds: f64,
    },
    /// freezedetect similarity hits with zero exact frame repeats: legitimately
    /// still content (a person holding still, a static screen), NOT a pipeline
    /// freeze. Informational only — never affects the verdict, never repaired.
    LowMotionSegments {
        count: usize,
        longest_seconds: f64,
    },
    /// One or more exact decoded-frame repeat bursts.
    RepeatedFrames {
        bursts: usize,
        max_run: usize,
    },
    /// A packet timestamp gap in the final audio stream.
    AudioGap {
        count: usize,
        max_ms: f64,
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
    let mut skew: Option<f64> = None;
    if let (Some(video_start), Some(audio_start)) = (video.start_time, audio.start_time) {
        skew = Some((video_start - audio_start).abs() * 1000.0);
    }
    if let (Some(video_duration), Some(audio_duration)) = (video.duration, audio.duration) {
        let delayed_audio_skew = (video_duration - audio_duration).max(0.0) * 1000.0;
        skew = Some(skew.map_or(delayed_audio_skew, |current| {
            current.max(delayed_audio_skew)
        }));
    }
    skew
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
    analyze_audio_balance_cancellable(ffmpeg_path, file_path, &never_cancelled)
}

pub fn analyze_audio_balance_cancellable(
    ffmpeg_path: &str,
    file_path: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<ChannelLevel>, String> {
    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-hide_banner",
        "-nostats",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        file_path,
        "-map",
        "0:a:0",
        "-af",
        "astats=metadata=1:reset=0",
        "-f",
        "null",
        "-",
    ]);
    let output = run_output_cancellable(&mut command, is_cancelled)
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

/// Freezes over `min_freeze_seconds` — the user-visible long freezes.
pub fn long_freezes(segments: &[FreezeSegment], min_freeze_seconds: f64) -> Vec<FreezeSegment> {
    segments
        .iter()
        .filter(|segment| segment.duration > min_freeze_seconds)
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
    detect_freezes_cancellable(
        ffmpeg_path,
        file_path,
        noise_db,
        min_freeze_seconds,
        &never_cancelled,
    )
}

pub fn detect_freezes_cancellable(
    ffmpeg_path: &str,
    file_path: &str,
    noise_db: f64,
    min_freeze_seconds: f64,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<FreezeSegment>, String> {
    let filter = format!("freezedetect=n={noise_db}dB:d={min_freeze_seconds}");
    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-hide_banner",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        file_path,
        "-map",
        "0:v:0",
        "-vf",
        &filter,
        "-f",
        "null",
        "-",
    ]);
    let output = run_output_cancellable(&mut command, is_cancelled)
        .map_err(|error| format!("could not run freezedetect: {error}"))?;
    Ok(parse_freezedetect(&String::from_utf8_lossy(&output.stderr)))
}

/// Parse FFmpeg `-f framemd5` output into an ordered sequence of decoded-frame hashes.
pub fn parse_framemd5_hashes(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            line.split(',')
                .next_back()
                .map(|hash| hash.trim().to_string())
        })
        .collect()
}

/// One run of consecutive byte-identical decoded frames (frame indices).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepeatedFrameBurst {
    pub start_index: usize,
    pub run: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepeatedFrameSummary {
    pub max_run: usize,
    pub bursts: usize,
    /// The positions of every burst over the threshold, so freeze segments can be
    /// corroborated against exact-repeat evidence (see [`corroborated_freezes`]).
    pub burst_runs: Vec<RepeatedFrameBurst>,
}

pub fn repeated_frame_summary(hashes: &[String], threshold: usize) -> RepeatedFrameSummary {
    if hashes.is_empty() {
        return RepeatedFrameSummary {
            max_run: 0,
            bursts: 0,
            burst_runs: Vec::new(),
        };
    }

    let mut max_run = 1;
    let mut current_run = 1;
    let mut run_start = 0;
    let mut burst_runs = Vec::new();
    for index in 1..hashes.len() {
        if hashes[index] == hashes[index - 1] {
            current_run += 1;
        } else {
            if current_run > threshold {
                burst_runs.push(RepeatedFrameBurst {
                    start_index: run_start,
                    run: current_run,
                });
            }
            max_run = max_run.max(current_run);
            run_start = index;
            current_run = 1;
        }
    }
    if current_run > threshold {
        burst_runs.push(RepeatedFrameBurst {
            start_index: run_start,
            run: current_run,
        });
    }
    max_run = max_run.max(current_run);

    RepeatedFrameSummary {
        max_run,
        bursts: burst_runs.len(),
        burst_runs,
    }
}

/// Splits freezedetect segments into pipeline-proven and similarity-only.
///
/// A freeze segment only proves a *pipeline* freeze when a run of byte-identical
/// decoded frames (framemd5) overlaps it — a live camera or screen source never
/// produces exact repeats on its own. Similarity-only segments are characteristic
/// of legitimately still content (a person holding still, a static screen, flat
/// walls denoised by the encoder) and must not be treated as defects.
///
/// Returns `(corroborated, similarity_only)`. Burst windows get one frame
/// interval of slack on each side. Without a usable fps the bursts cannot be
/// placed in time, so every freeze is conservatively similarity-only.
///
/// 2026-07 lesson: the "4K feels laggy" incident file was a technically perfect
/// 23.976p transfer — 465 freezedetect hits, zero exact repeats — yet the gate
/// called it "not 100%" and planned an interpolation repair.
pub fn corroborated_freezes(
    freezes: &[FreezeSegment],
    bursts: &[RepeatedFrameBurst],
    fps: Option<f64>,
) -> (Vec<FreezeSegment>, Vec<FreezeSegment>) {
    let Some(fps) = fps.filter(|fps| fps.is_finite() && *fps > 0.0) else {
        return (Vec::new(), freezes.to_vec());
    };
    if bursts.is_empty() {
        return (Vec::new(), freezes.to_vec());
    }
    let frame_interval = 1.0 / fps;
    let windows: Vec<(f64, f64)> = bursts
        .iter()
        .map(|burst| {
            (
                burst.start_index as f64 * frame_interval - frame_interval,
                (burst.start_index + burst.run) as f64 * frame_interval + frame_interval,
            )
        })
        .collect();
    let mut corroborated = Vec::new();
    let mut similarity_only = Vec::new();
    for freeze in freezes {
        let start = freeze.start;
        let end = freeze.start + freeze.duration;
        if windows
            .iter()
            .any(|(window_start, window_end)| *window_start <= end && *window_end >= start)
        {
            corroborated.push(*freeze);
        } else {
            similarity_only.push(*freeze);
        }
    }
    (corroborated, similarity_only)
}

pub fn detect_repeated_frames_cancellable(
    ffmpeg_path: &str,
    file_path: &str,
    threshold: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<RepeatedFrameSummary, String> {
    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-hide_banner",
        "-nostats",
        "-threads",
        "1",
        "-i",
        file_path,
        "-an",
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-",
    ]);
    let output = run_output_cancellable(&mut command, is_cancelled)
        .map_err(|error| format!("could not run framemd5: {error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!(
            "framemd5 failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(repeated_frame_summary(
        &parse_framemd5_hashes(&String::from_utf8_lossy(&output.stdout)),
        threshold,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioPacket {
    pub pts_time: f64,
    pub duration_time: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioGapSummary {
    pub count: usize,
    pub max_gap_ms: f64,
}

pub fn parse_audio_packets(output: &str) -> Vec<AudioPacket> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut fields = line.split(',');
            let pts_time = fields.next()?.trim().parse::<f64>().ok()?;
            let duration_time = fields.next()?.trim().parse::<f64>().ok()?;
            (pts_time.is_finite() && duration_time.is_finite()).then_some(AudioPacket {
                pts_time,
                duration_time,
            })
        })
        .collect()
}

pub fn audio_gap_summary(packets: &[AudioPacket], tolerance_ms: f64) -> AudioGapSummary {
    let mut packets = packets.to_vec();
    packets.sort_by(|left, right| left.pts_time.total_cmp(&right.pts_time));

    let mut count = 0;
    let mut max_gap_ms = 0.0_f64;
    for index in 1..packets.len() {
        let previous = packets[index - 1];
        let current = packets[index];
        let expected = previous.duration_time.max(0.0);
        let actual = current.pts_time - previous.pts_time;
        let gap_ms = (actual - expected) * 1000.0;
        if gap_ms > tolerance_ms {
            count += 1;
            max_gap_ms = max_gap_ms.max(gap_ms);
        }
    }

    AudioGapSummary { count, max_gap_ms }
}

pub fn detect_audio_gaps_cancellable(
    ffprobe_path: &str,
    file_path: &str,
    tolerance_ms: f64,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<AudioGapSummary, String> {
    let mut command = Command::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "csv=p=0",
        file_path,
    ]);
    let output = run_output_cancellable(&mut command, is_cancelled)
        .map_err(|error| format!("could not run ffprobe audio packet scan: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "audio packet scan failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(audio_gap_summary(
        &parse_audio_packets(&String::from_utf8_lossy(&output.stdout)),
        tolerance_ms,
    ))
}

// --- Repair strategy selection (slice 5) ---

// --- Repair video encoder capability ---
//
// Transcode-style repairs must only use an encoder the *resolved* FFmpeg binary
// actually ships. The bundled FFmpeg is LGPL-only (no GPL libx264) on every
// platform, so the encoder is probed from `ffmpeg -encoders` instead of assumed;
// dev PATH builds (e.g. Homebrew) still get libx264.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepairVideoEncoder {
    /// Software x264 (GPL; dev/full builds only). Best quality control via CRF.
    Libx264,
    /// Apple VideoToolbox H.264 (the bundled macOS LGPL build).
    H264VideoToolbox,
    /// Windows MediaFoundation H.264 (the bundled Windows LGPL build).
    H264MediaFoundation,
}

impl RepairVideoEncoder {
    /// The encoder name as listed by `ffmpeg -encoders`.
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            RepairVideoEncoder::Libx264 => "libx264",
            RepairVideoEncoder::H264VideoToolbox => "h264_videotoolbox",
            RepairVideoEncoder::H264MediaFoundation => "h264_mf",
        }
    }

    /// Encoder + quality args targeting visually-lossless output. Each encoder
    /// gets its own quality knob — `-crf` only exists on libx264, which is why
    /// the old hardcoded `libx264 -crf 18` failed on every bundled build with
    /// "Unrecognized option 'crf'".
    fn encode_args(self) -> Vec<String> {
        let args: &[&str] = match self {
            RepairVideoEncoder::Libx264 => &[
                "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-threads", "1",
            ],
            RepairVideoEncoder::H264VideoToolbox => {
                &["-c:v", "h264_videotoolbox", "-q:v", "65", "-allow_sw", "1"]
            }
            RepairVideoEncoder::H264MediaFoundation => &[
                "-c:v",
                "h264_mf",
                "-rate_control",
                "quality",
                "-quality",
                "90",
            ],
        };
        let mut args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
        args
    }
}

/// Preference order for repair transcodes: quality-controllable software x264
/// first, then the platform hardware encoders the LGPL bundles ship.
const REPAIR_ENCODER_PREFERENCE: [RepairVideoEncoder; 3] = [
    RepairVideoEncoder::Libx264,
    RepairVideoEncoder::H264VideoToolbox,
    RepairVideoEncoder::H264MediaFoundation,
];

/// Parses encoder names from `ffmpeg -hide_banner -encoders` output. Lines look
/// like ` V....D libx264   H.264 / AVC ...`; the first token is the capability
/// flags field, the second is the encoder name.
pub fn parse_encoder_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let mut tokens = line.split_whitespace();
            let flags = tokens.next()?;
            let name = tokens.next()?;
            let is_flags_field = !flags.is_empty()
                && flags.chars().all(|c| "VASFXBDET.".contains(c))
                && flags.contains(|c| c != '.');
            if is_flags_field && name != "=" {
                Some(name.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Picks the best repair encoder among the names an FFmpeg binary advertises.
pub fn select_repair_encoder(available: &[String]) -> Option<RepairVideoEncoder> {
    REPAIR_ENCODER_PREFERENCE
        .into_iter()
        .find(|encoder| available.iter().any(|name| name == encoder.ffmpeg_name()))
}

fn repair_encoder_cache() -> &'static Mutex<HashMap<String, Option<RepairVideoEncoder>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<RepairVideoEncoder>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Probes (and caches, per binary path) the repair encoder the resolved FFmpeg
/// actually supports. `None` means transcode-style repairs are unavailable on
/// this build — callers must skip them honestly instead of launching an FFmpeg
/// command that is guaranteed to fail.
pub fn probe_repair_encoder(ffmpeg_path: &str) -> Option<RepairVideoEncoder> {
    let cache = repair_encoder_cache();
    {
        let cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.get(ffmpeg_path) {
            return *cached;
        }
    }
    let probed = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            select_repair_encoder(&parse_encoder_names(&String::from_utf8_lossy(
                &output.stdout,
            )))
        });
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.insert(ffmpeg_path.to_string(), probed);
    probed
}

/// Whether any issue is something a viewer notices immediately (a missing stream),
/// as opposed to analyzer-grade pacing/skew residuals. Drives whether a "not 100%"
/// verdict warrants interrupting the user or just a Library/Diagnostics record.
pub fn has_user_impacting_issue(issues: &[QualityIssue]) -> bool {
    issues.iter().any(|issue| {
        matches!(
            issue,
            QualityIssue::MissingVideo | QualityIssue::MissingAudio
        )
    })
}

/// Whether any issue in a report would need a video transcode (as opposed to a
/// stream-copy or audio-only repair) to fix.
pub fn needs_transcode_repair(issues: &[QualityIssue]) -> bool {
    issues.iter().any(|issue| {
        matches!(
            issue,
            QualityIssue::VariableFrameRate { .. }
                | QualityIssue::DroppedFrames { .. }
                | QualityIssue::FrozenSegments { .. }
                | QualityIssue::RepeatedFrames { .. }
        )
    })
}

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
    /// The capability-probed encoder for transcode repairs (ignored on copy/remux
    /// plans). Selection guarantees it is real whenever `video` needs a transcode.
    pub video_encoder: RepairVideoEncoder,
}

/// Selects the max-quality FFmpeg repair plan, or `None` when nothing can/should be
/// repaired (already clean, or only FFmpeg-unrepairable issues like a missing stream).
/// Quality-first: dropped/frozen frames get motion interpolation, plain VFR gets a CFR
/// transcode, one-sided audio is centered, and A/V skew is resynced.
pub fn select_repair_plan(
    report: &QualityReport,
    probe: &MediaProbe,
    expectations: &QualityExpectations,
    encoder: Option<RepairVideoEncoder>,
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
            // Transcode-style repairs need a real H.264 encoder in the resolved
            // FFmpeg. Without one (LGPL bundle without a probed hardware encoder),
            // skip them honestly — never plan a command guaranteed to fail.
            QualityIssue::DroppedFrames { .. }
            | QualityIssue::FrozenSegments { .. }
            | QualityIssue::RepeatedFrames { .. } => {
                if encoder.is_some() {
                    video = VideoRepair::Interpolate;
                    repairable = true;
                }
            }
            QualityIssue::VariableFrameRate { .. } => {
                if encoder.is_some() {
                    if video == VideoRepair::Copy {
                        video = VideoRepair::CfrTranscode;
                    }
                    repairable = true;
                }
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
            // FFmpeg-only repair cannot synthesise a missing stream, and still
            // content (low motion) is not a defect to repair.
            QualityIssue::MissingVideo
            | QualityIssue::MissingAudio
            | QualityIssue::AudioGap { .. }
            | QualityIssue::LowMotionSegments { .. } => {}
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
        // Only read when `video` transcodes, and transcodes are only planned when
        // the probe found an encoder; the fallback value is never executed.
        video_encoder: encoder.unwrap_or(RepairVideoEncoder::Libx264),
    })
}

/// Signed A/V offset in ms (positive = audio starts after video), from stream start
/// times, used to pick the resync direction.
fn signed_av_offset_ms(probe: &MediaProbe) -> Option<f64> {
    let video = probe.video.as_ref()?;
    let audio = probe.audio.first()?;
    Some((audio.start_time? - video.start_time?) * 1000.0)
}

/// Builds the FFmpeg command for a repair plan. Re-encodes target visually lossless
/// via the plan's capability-probed encoder; audio repairs re-encode to AAC. Resync
/// trims a late audio start or delays an early one.
pub fn build_repair_args(input: &str, output: &str, plan: &RepairPlan) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-filter_threads".to_string(),
        "1".to_string(),
        "-filter_complex_threads".to_string(),
        "1".to_string(),
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
        args.extend(["-vf".to_string(), video_filters.join(",")]);
        args.extend(plan.video_encoder.encode_args());
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

// --- Combined analysis + scan-first batch repair (slice 7) ---

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "m4v"];

/// Recomputes a verdict from a full issue list. Missing streams and audio packet
/// gaps need review; video cadence issues and one-sided audio are repairable.
fn verdict_for(issues: &[QualityIssue]) -> QualityVerdict {
    // Low-motion segments are informational (still content, not a defect) and
    // never move the verdict away from Clean.
    let significant: Vec<&QualityIssue> = issues
        .iter()
        .filter(|issue| !matches!(issue, QualityIssue::LowMotionSegments { .. }))
        .collect();
    if significant.is_empty() {
        return QualityVerdict::Clean;
    }
    let needs_review = significant.iter().any(|issue| {
        matches!(
            issue,
            QualityIssue::MissingVideo | QualityIssue::MissingAudio | QualityIssue::AudioGap { .. }
        )
    });
    if needs_review {
        QualityVerdict::NeedsReview
    } else {
        QualityVerdict::Repairable
    }
}

/// Folds the audio-balance and freeze passes into a base (ffprobe-derived) report and
/// recomputes the verdict.
pub fn combine_report(
    mut base: QualityReport,
    one_sided_silent_channel: Option<usize>,
    corroborated_freeze_segments: &[FreezeSegment],
    similarity_only_freeze_segments: &[FreezeSegment],
    repeated_frames: Option<RepeatedFrameSummary>,
    audio_gaps: Option<AudioGapSummary>,
    thresholds: &QualityThresholds,
) -> QualityReport {
    if let Some(silent_channel) = one_sided_silent_channel {
        base.issues
            .push(QualityIssue::OneSidedAudio { silent_channel });
    }
    if !corroborated_freeze_segments.is_empty() {
        let longest = corroborated_freeze_segments
            .iter()
            .map(|segment| segment.duration)
            .fold(0.0_f64, f64::max);
        base.issues.push(QualityIssue::FrozenSegments {
            count: corroborated_freeze_segments.len(),
            longest_seconds: longest,
        });
    }
    if !similarity_only_freeze_segments.is_empty() {
        let longest = similarity_only_freeze_segments
            .iter()
            .map(|segment| segment.duration)
            .fold(0.0_f64, f64::max);
        base.issues.push(QualityIssue::LowMotionSegments {
            count: similarity_only_freeze_segments.len(),
            longest_seconds: longest,
        });
    }
    if let Some(repeated_frames) = repeated_frames
        && repeated_frames.max_run > thresholds.max_repeated_frame_run
    {
        base.issues.push(QualityIssue::RepeatedFrames {
            bursts: repeated_frames.bursts,
            max_run: repeated_frames.max_run,
        });
    }
    if let Some(audio_gaps) = audio_gaps
        && audio_gaps.max_gap_ms > thresholds.max_audio_gap_ms
    {
        base.issues.push(QualityIssue::AudioGap {
            count: audio_gaps.count,
            max_ms: audio_gaps.max_gap_ms,
        });
    }
    base.verdict = verdict_for(&base.issues);
    base
}

/// Lists the video recordings directly in a folder, skipping hidden files and the
/// backup directory, sorted by path.
pub fn list_recording_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|error| format!("could not read {}: {error}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if let Some(ext) = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            && VIDEO_EXTENSIONS.contains(&ext.as_str())
        {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// Runs every analysis pass (ffprobe metadata, astats channel balance, freezedetect)
/// and returns the probe plus the combined quality report.
pub fn analyze_recording(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    file_path: &str,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> Result<(MediaProbe, QualityReport), String> {
    analyze_recording_cancellable(
        ffmpeg_path,
        ffprobe_path,
        file_path,
        thresholds,
        expectations,
        &never_cancelled,
    )
}

pub fn analyze_recording_cancellable(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    file_path: &str,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(MediaProbe, QualityReport), String> {
    let probe = probe_media_cancellable(ffprobe_path, file_path, is_cancelled)?;
    let base = classify_quality(&probe, thresholds, expectations);

    let one_sided = if probe.audio.is_empty() {
        None
    } else {
        let levels = match analyze_audio_balance_cancellable(ffmpeg_path, file_path, is_cancelled) {
            Ok(levels) => levels,
            Err(error) if error.contains(MAINTENANCE_CANCELLED) => return Err(error),
            Err(_) => Vec::new(),
        };
        detect_one_sided_audio(&levels, thresholds.silence_db)
    };
    let audio_gaps = if probe.audio.is_empty() {
        None
    } else {
        Some(detect_audio_gaps_cancellable(
            ffprobe_path,
            file_path,
            thresholds.audio_gap_tolerance_ms,
            is_cancelled,
        )?)
    };
    let freezes = if probe.video.is_some() {
        let segments = detect_freezes_cancellable(
            ffmpeg_path,
            file_path,
            -60.0,
            thresholds.min_freeze_seconds,
            is_cancelled,
        )?;
        long_freezes(&segments, thresholds.min_freeze_seconds)
    } else {
        Vec::new()
    };
    let repeated_frames = if probe.video.is_some() {
        Some(detect_repeated_frames_cancellable(
            ffmpeg_path,
            file_path,
            thresholds.max_repeated_frame_run,
            is_cancelled,
        )?)
    } else {
        None
    };

    // A freezedetect hit only counts as a pipeline freeze when exact decoded-frame
    // repeats overlap it; the rest is still content (see corroborated_freezes).
    let container_fps = probe
        .video
        .as_ref()
        .and_then(|video| video.avg_fps.or(video.nominal_fps));
    let (corroborated, similarity_only) = corroborated_freezes(
        &freezes,
        repeated_frames
            .as_ref()
            .map(|summary| summary.burst_runs.as_slice())
            .unwrap_or(&[]),
        container_fps,
    );

    let report = combine_report(
        base,
        one_sided,
        &corroborated,
        &similarity_only,
        repeated_frames,
        audio_gaps,
        thresholds,
    );
    Ok((probe, report))
}

/// One recording's assessment from a batch scan (no files are modified by scanning).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingAssessment {
    pub path: String,
    pub report: QualityReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<RepairPlan>,
}

/// The result of repairing one recording.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum RepairOutcome {
    AlreadyClean {
        path: String,
    },
    Repaired {
        path: String,
        interpolated: bool,
    },
    /// The repaired output failed the quality gate; the original is kept (not 100%).
    NotImproved {
        path: String,
        reason: String,
    },
    Failed {
        path: String,
        reason: String,
    },
}

/// Scans a folder: lists recordings and analyzes each, without modifying anything.
/// Files that cannot be probed are skipped.
pub fn scan_recordings(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    dir: &Path,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> Result<Vec<RecordingAssessment>, String> {
    let mut assessments = Vec::new();
    let encoder = probe_repair_encoder(ffmpeg_path);
    for file in list_recording_files(dir)? {
        let path = file.to_string_lossy().to_string();
        if let Ok((probe, report)) =
            analyze_recording(ffmpeg_path, ffprobe_path, &path, thresholds, expectations)
        {
            let plan = select_repair_plan(&report, &probe, expectations, encoder);
            assessments.push(RecordingAssessment { path, report, plan });
        }
    }
    Ok(assessments)
}

/// The hidden temp path the repaired output is written to, beside the original (so the
/// final atomic rename stays on one filesystem).
fn repair_temp_path(original: &Path) -> PathBuf {
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("recording");
    let ext = original
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("mp4");
    let mut temp = original.to_path_buf();
    temp.set_file_name(format!(".{stem}.videorc-repair.{ext}"));
    temp
}

/// Repairs one assessed recording, quality-gated: writes the repaired temp, re-analyzes
/// it, and only atomically replaces the original (after backup) when the repair reaches
/// a clean verdict. A failing repair leaves the original visible and reports why.
pub fn repair_recording(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    assessment: &RecordingAssessment,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> RepairOutcome {
    repair_recording_cancellable(
        ffmpeg_path,
        ffprobe_path,
        assessment,
        thresholds,
        expectations,
        &never_cancelled,
    )
}

pub fn repair_recording_cancellable(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    assessment: &RecordingAssessment,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
    is_cancelled: &dyn Fn() -> bool,
) -> RepairOutcome {
    let path = assessment.path.clone();
    let Some(plan) = &assessment.plan else {
        return RepairOutcome::AlreadyClean { path };
    };

    let original = Path::new(&path);
    let temp = repair_temp_path(original);
    let temp_str = temp.to_string_lossy().to_string();

    let mut command = Command::new(ffmpeg_path);
    command.args(build_repair_args(&path, &temp_str, plan));
    let run = run_output_cancellable(&mut command, is_cancelled);
    match run {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            let _ = fs::remove_file(&temp);
            return RepairOutcome::Failed {
                path,
                reason: format!(
                    "ffmpeg repair failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            };
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return RepairOutcome::Failed {
                path,
                reason: format!("could not run ffmpeg: {error}"),
            };
        }
    }

    let interpolated = plan.interpolated;
    let result = safe_replace(original, &temp, |candidate| {
        let candidate_path = candidate.to_string_lossy();
        let (_, report) = analyze_recording_cancellable(
            ffmpeg_path,
            ffprobe_path,
            &candidate_path,
            thresholds,
            expectations,
            is_cancelled,
        )?;
        if report.verdict == QualityVerdict::Clean {
            Ok(())
        } else {
            Err(format!(
                "repaired output is still not 100%: {:?}",
                report.issues
            ))
        }
    });

    match result {
        Ok(_) => RepairOutcome::Repaired { path, interpolated },
        Err(SafeReplaceError::ValidationFailed(reason)) => {
            RepairOutcome::NotImproved { path, reason }
        }
        Err(error) => RepairOutcome::Failed {
            path,
            reason: error.to_string(),
        },
    }
}

/// Repairs an assessed batch sequentially (quality-first, one at a time to avoid
/// overloading the machine).
pub fn repair_batch(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    assessments: &[RecordingAssessment],
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> Vec<RepairOutcome> {
    assessments
        .iter()
        .map(|assessment| {
            repair_recording(
                ffmpeg_path,
                ffprobe_path,
                assessment,
                thresholds,
                expectations,
            )
        })
        .collect()
}

// --- Batch repair report (slice 12) ---

/// One line in a batch repair report: a file's pre-repair verdict and issues paired
/// with what the repair actually did. This is the record stored with the session so
/// Diagnostics and Recording history can explain exactly why a file was accepted,
/// repaired, or left at "not 100%".
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepairReportEntry {
    pub path: String,
    pub verdict: QualityVerdict,
    pub issues: Vec<QualityIssue>,
    pub outcome: RepairOutcome,
}

/// Roll-up counts across a batch repair run.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepairSummary {
    pub total: usize,
    pub already_clean: usize,
    pub repaired: usize,
    /// Subset of `repaired` whose video used motion interpolation (drives the
    /// transparent "interpolated frames" badge).
    pub interpolated: usize,
    pub not_improved: usize,
    pub failed: usize,
}

/// The full markdown/JSON-serialisable report for one batch repair run.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchRepairReport {
    pub summary: RepairSummary,
    pub entries: Vec<RepairReportEntry>,
}

/// The visible path an outcome refers to, regardless of which variant it is.
fn outcome_path(outcome: &RepairOutcome) -> &str {
    match outcome {
        RepairOutcome::AlreadyClean { path }
        | RepairOutcome::Repaired { path, .. }
        | RepairOutcome::NotImproved { path, .. }
        | RepairOutcome::Failed { path, .. } => path,
    }
}

/// Pairs each scanned assessment with its repair outcome (same order as
/// [`repair_batch`] produces) and rolls up the summary counts. Outcomes without a
/// matching assessment still appear (with an empty issue list) so nothing is dropped.
pub fn build_repair_report(
    assessments: &[RecordingAssessment],
    outcomes: &[RepairOutcome],
) -> BatchRepairReport {
    let mut summary = RepairSummary {
        total: outcomes.len(),
        ..RepairSummary::default()
    };
    let mut entries = Vec::with_capacity(outcomes.len());

    for (index, outcome) in outcomes.iter().enumerate() {
        match outcome {
            RepairOutcome::AlreadyClean { .. } => summary.already_clean += 1,
            RepairOutcome::Repaired { interpolated, .. } => {
                summary.repaired += 1;
                if *interpolated {
                    summary.interpolated += 1;
                }
            }
            RepairOutcome::NotImproved { .. } => summary.not_improved += 1,
            RepairOutcome::Failed { .. } => summary.failed += 1,
        }

        let assessment = assessments.get(index);
        entries.push(RepairReportEntry {
            path: outcome_path(outcome).to_string(),
            verdict: assessment
                .map(|a| a.report.verdict)
                .unwrap_or(QualityVerdict::NeedsReview),
            issues: assessment
                .map(|a| a.report.issues.clone())
                .unwrap_or_default(),
            outcome: outcome.clone(),
        });
    }

    BatchRepairReport { summary, entries }
}

fn verdict_label(verdict: QualityVerdict) -> &'static str {
    match verdict {
        QualityVerdict::Clean => "clean",
        QualityVerdict::Repairable => "repairable",
        QualityVerdict::NeedsReview => "needs review",
    }
}

/// A plain-English one-liner for a single quality issue (for the markdown report).
fn describe_issue(issue: &QualityIssue) -> String {
    match issue {
        QualityIssue::MissingVideo => "missing video stream".to_string(),
        QualityIssue::MissingAudio => "missing audio stream".to_string(),
        QualityIssue::VariableFrameRate {
            avg_fps,
            nominal_fps,
        } => format!("variable frame rate (avg {avg_fps:.2} fps vs nominal {nominal_fps:.2} fps)"),
        QualityIssue::DroppedFrames { observed, expected } => {
            format!("dropped frames ({observed} of ~{expected} expected)")
        }
        QualityIssue::AvSkew { ms } => format!("A/V skew of {ms:.0} ms"),
        QualityIssue::OneSidedAudio { silent_channel } => {
            format!("one-sided audio (channel {silent_channel} silent)")
        }
        QualityIssue::FrozenSegments {
            count,
            longest_seconds,
        } => format!("{count} long freeze segment(s), longest {longest_seconds:.1}s"),
        QualityIssue::LowMotionSegments {
            count,
            longest_seconds,
        } => format!(
            "{count} low-motion segment(s), longest {longest_seconds:.1}s — no exact frame \
             repeats, likely a still subject (not a pipeline freeze)"
        ),
        QualityIssue::RepeatedFrames { bursts, max_run } => {
            format!("{bursts} repeated-frame burst(s), max run {max_run}")
        }
        QualityIssue::AudioGap { count, max_ms } => {
            format!("{count} audio packet gap(s), largest {max_ms:.0} ms")
        }
    }
}

/// A plain-English one-liner for a repair outcome (for the markdown report).
fn describe_outcome(outcome: &RepairOutcome) -> String {
    match outcome {
        RepairOutcome::AlreadyClean { .. } => "already clean — no changes".to_string(),
        RepairOutcome::Repaired {
            interpolated: true, ..
        } => "repaired (interpolated frames)".to_string(),
        RepairOutcome::Repaired { .. } => "repaired".to_string(),
        RepairOutcome::NotImproved { reason, .. } => {
            format!("kept original, not 100%: {reason}")
        }
        RepairOutcome::Failed { reason, .. } => format!("failed: {reason}"),
    }
}

/// Renders a human-readable markdown repair report (plain summary first, then a
/// per-file section with verdict, issues, and outcome).
pub fn render_markdown_report(report: &BatchRepairReport) -> String {
    let summary = &report.summary;
    let mut out = String::new();
    out.push_str("# Videorc Repair Report\n\n");
    out.push_str("## Summary\n\n");
    out.push_str(&format!("- Files scanned: {}\n", summary.total));
    out.push_str(&format!("- Already clean: {}\n", summary.already_clean));
    out.push_str(&format!(
        "- Repaired: {} ({} with interpolated frames)\n",
        summary.repaired, summary.interpolated
    ));
    out.push_str(&format!("- Not 100%: {}\n", summary.not_improved));
    out.push_str(&format!("- Failed: {}\n", summary.failed));
    out.push_str("\n## Files\n");
    if report.entries.is_empty() {
        out.push_str("\n_No recordings found._\n");
    }
    for entry in &report.entries {
        out.push_str(&format!("\n### {}\n", entry.path));
        out.push_str(&format!("- Verdict: {}\n", verdict_label(entry.verdict)));
        if entry.issues.is_empty() {
            out.push_str("- Issues: none\n");
        } else {
            out.push_str("- Issues:\n");
            for issue in &entry.issues {
                out.push_str(&format!("  - {}\n", describe_issue(issue)));
            }
        }
        out.push_str(&format!(
            "- Outcome: {}\n",
            describe_outcome(&entry.outcome)
        ));
    }
    out
}

/// Renders the report as pretty JSON (for Diagnostics / session storage).
pub fn render_json_report(report: &BatchRepairReport) -> Result<String, String> {
    serde_json::to_string_pretty(report)
        .map_err(|error| format!("could not serialize repair report: {error}"))
}

/// Writes the markdown and JSON reports into `dir`, returning `(markdown, json)` paths.
pub fn write_repair_reports(
    dir: &Path,
    report: &BatchRepairReport,
) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(dir).map_err(|error| format!("could not create report dir: {error}"))?;
    let md_path = dir.join("videorc-repair-report.md");
    let json_path = dir.join("videorc-repair-report.json");
    fs::write(&md_path, render_markdown_report(report))
        .map_err(|error| format!("could not write markdown report: {error}"))?;
    fs::write(&json_path, render_json_report(report)?)
        .map_err(|error| format!("could not write json report: {error}"))?;
    Ok((md_path, json_path))
}

// --- Post-recording quality gate (slice 8) ---

/// The post-recording quality-gate result for one finalized file. This is the backend
/// decision; the renderer-facing status strings (`checking`/`repairing`/`ready`/
/// `not-100%`/`cancelled`) are mapped in the protocol slice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GateStatus {
    /// Passed every objective gate as-is.
    Ready { path: String },
    /// Failed the gate but was repaired in place (backup kept) and now passes.
    Repaired { path: String, interpolated: bool },
    /// Could not be brought to 100%; the original visible file is kept, with reasons.
    /// `needs_attention` marks verdicts a user would actually notice (a missing
    /// stream) as opposed to pacing/skew residuals only visible to the analyzer.
    NotHundredPercent {
        path: String,
        reasons: Vec<String>,
        #[serde(default)]
        needs_attention: bool,
    },
    /// The gate itself could not run (e.g. the file could not be probed).
    Failed { path: String, reason: String },
}

/// Plain-English reasons for a set of issues (drives the "not 100%" warning copy).
pub fn issue_reasons(issues: &[QualityIssue]) -> Vec<String> {
    issues.iter().map(describe_issue).collect()
}

/// Runs the post-recording quality gate on a finalized file: analyze it, and if it is
/// not already clean, attempt the backup-safe repair. The visible file is only ever
/// replaced by a validated better version, so a failed gate never makes things worse —
/// it keeps the original and reports exactly why it is not 100%.
pub fn gate_recording(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    file_path: &str,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
) -> GateStatus {
    gate_recording_cancellable(
        ffmpeg_path,
        ffprobe_path,
        file_path,
        thresholds,
        expectations,
        &never_cancelled,
    )
}

pub fn gate_recording_cancellable(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    file_path: &str,
    thresholds: &QualityThresholds,
    expectations: &QualityExpectations,
    is_cancelled: &dyn Fn() -> bool,
) -> GateStatus {
    let path = file_path.to_string();
    let (probe, report) = match analyze_recording_cancellable(
        ffmpeg_path,
        ffprobe_path,
        file_path,
        thresholds,
        expectations,
        is_cancelled,
    ) {
        Ok(result) => result,
        Err(reason) => return GateStatus::Failed { path, reason },
    };

    if report.verdict == QualityVerdict::Clean {
        return GateStatus::Ready { path };
    }

    let encoder = probe_repair_encoder(ffmpeg_path);
    let Some(plan) = select_repair_plan(&report, &probe, expectations, encoder) else {
        let mut reasons = issue_reasons(&report.issues);
        if encoder.is_none() && needs_transcode_repair(&report.issues) {
            // Explicit diagnostics over a silent skip: say why no repair ran.
            reasons.push(
                "automatic repair unavailable: this FFmpeg build has no H.264 encoder".to_string(),
            );
        }
        return GateStatus::NotHundredPercent {
            path,
            reasons,
            needs_attention: has_user_impacting_issue(&report.issues),
        };
    };

    let assessment = RecordingAssessment {
        path: path.clone(),
        report: report.clone(),
        plan: Some(plan),
    };
    match repair_recording_cancellable(
        ffmpeg_path,
        ffprobe_path,
        &assessment,
        thresholds,
        expectations,
        is_cancelled,
    ) {
        RepairOutcome::AlreadyClean { path } => GateStatus::Ready { path },
        RepairOutcome::Repaired { path, interpolated } => {
            GateStatus::Repaired { path, interpolated }
        }
        RepairOutcome::NotImproved { path, reason } => {
            let mut reasons = issue_reasons(&report.issues);
            reasons.push(reason);
            GateStatus::NotHundredPercent {
                path,
                reasons,
                needs_attention: has_user_impacting_issue(&report.issues),
            }
        }
        RepairOutcome::Failed { path, reason } => GateStatus::Failed { path, reason },
    }
}

// --- Persistent repair jobs (slice 9) ---

/// Lifecycle of a persisted repair job. `Cancelled` and `Failed` are terminal and never
/// imply the file is good — only `Completed` carries the actual repair outcome, and even
/// then the outcome itself says whether the file reached 100%.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepairJobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl RepairJobStatus {
    /// The string persisted in the `status` column (stable, queryable).
    pub fn as_str(self) -> &'static str {
        match self {
            RepairJobStatus::Pending => "pending",
            RepairJobStatus::Running => "running",
            RepairJobStatus::Completed => "completed",
            RepairJobStatus::Failed => "failed",
            RepairJobStatus::Cancelled => "cancelled",
        }
    }

    /// Parses a persisted status string, defaulting unknown values to `Pending` so a job
    /// is retried rather than silently lost.
    pub fn from_db(value: &str) -> RepairJobStatus {
        match value {
            "running" => RepairJobStatus::Running,
            "completed" => RepairJobStatus::Completed,
            "failed" => RepairJobStatus::Failed,
            "cancelled" => RepairJobStatus::Cancelled,
            _ => RepairJobStatus::Pending,
        }
    }

    /// Whether a job in this state should be picked up and resumed on next launch. A job
    /// caught mid-run (`Running`) when the app quit is resumable — it is re-analyzed and
    /// re-run from scratch, which is safe because repair is backup-then-validate.
    pub fn is_resumable(self) -> bool {
        matches!(self, RepairJobStatus::Pending | RepairJobStatus::Running)
    }
}

/// A persisted repair job: enough to resume the work after an app restart. The repair
/// plan is intentionally NOT stored — on resume the file is re-analyzed so the plan
/// always reflects the file's current state. The `outcome` is kept as opaque JSON for
/// history/reporting without coupling the schema to the outcome enum's shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepairJob {
    pub id: String,
    pub file_path: String,
    pub status: RepairJobStatus,
    pub intended_fps: Option<f64>,
    pub expect_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl RepairJob {
    /// A fresh pending job for a file, stamping both timestamps with `now`.
    pub fn pending(
        id: String,
        file_path: String,
        expectations: &QualityExpectations,
        now: String,
    ) -> RepairJob {
        RepairJob {
            id,
            file_path,
            status: RepairJobStatus::Pending,
            intended_fps: expectations.intended_fps,
            expect_audio: expectations.expect_audio,
            outcome: None,
            reason: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// The analyzer expectations this job was created with.
    pub fn expectations(&self) -> QualityExpectations {
        QualityExpectations {
            intended_fps: self.intended_fps,
            expect_audio: self.expect_audio,
        }
    }

    pub fn mark_running(&mut self, now: String) {
        self.status = RepairJobStatus::Running;
        self.updated_at = now;
    }

    /// Records a finished repair outcome and moves the job to `Completed`. The outcome
    /// itself still reports whether the file reached 100%.
    pub fn complete(&mut self, outcome: &RepairOutcome, now: String) {
        self.status = RepairJobStatus::Completed;
        self.outcome = serde_json::to_value(outcome).ok();
        self.reason = None;
        self.updated_at = now;
    }

    /// Records a finished post-recording gate verdict and moves the job to `Completed`.
    /// The job ran to completion even when the verdict is "not 100%" or "failed" — that
    /// is a property of the file, captured in the stored outcome, not of the job.
    pub fn complete_with_gate(&mut self, status: &GateStatus, now: String) {
        self.status = RepairJobStatus::Completed;
        self.outcome = serde_json::to_value(status).ok();
        self.reason = None;
        self.updated_at = now;
    }

    pub fn fail(&mut self, reason: String, now: String) {
        self.status = RepairJobStatus::Failed;
        self.reason = Some(reason);
        self.updated_at = now;
    }

    pub fn defer(&mut self, reason: String, now: String) {
        self.status = RepairJobStatus::Pending;
        self.outcome = None;
        self.reason = Some(reason);
        self.updated_at = now;
    }

    /// Cancels the job. Cancellation NEVER marks the file as good — it only records the
    /// cancelled state and clears any provisional outcome so nothing reads as success.
    pub fn cancel(&mut self, now: String) {
        self.status = RepairJobStatus::Cancelled;
        self.outcome = None;
        self.updated_at = now;
    }

    pub fn cancel_with_reason(&mut self, reason: String, now: String) {
        self.status = RepairJobStatus::Cancelled;
        self.outcome = None;
        self.reason = Some(reason);
        self.updated_at = now;
    }
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
    fn default_thresholds_match_strict_final_file_gate() {
        let thresholds = thresholds();
        assert_eq!(thresholds.av_skew_ms, STRICT_AV_SKEW_HARD_FAIL_MS);
        assert_eq!(thresholds.max_audio_gap_ms, STRICT_MAX_AUDIO_GAP_MS);
        assert_eq!(
            thresholds.audio_gap_tolerance_ms,
            STRICT_AUDIO_GAP_TOLERANCE_MS
        );
        assert_eq!(
            thresholds.max_repeated_frame_run,
            STRICT_MAX_REPEATED_FRAME_RUN
        );
        assert_eq!(thresholds.min_freeze_seconds, STRICT_MAX_FREEZE_SECONDS);
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
        // Audio starts 500 ms after video → 500 ms skew > 150 ms.
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
        // 100 ms skew is under the 150 ms hard-fail gate.
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
    fn duration_skew_is_not_hidden_by_equal_start_times() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"14.300","nb_frames":"429","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"13.909","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());

        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(report.issues.iter().any(|issue| matches!(
            issue,
            QualityIssue::AvSkew { ms } if (*ms - 391.0).abs() < 1.0
        )));
    }

    #[test]
    fn audio_only_muxer_tail_is_not_classified_as_av_skew() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"8.100","nb_frames":"243","start_time":"0.0"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"duration":"8.298","start_time":"0.0"}
        ]}"#;
        let probe = parse_ffprobe_json(json).unwrap();
        let report = classify_quality(&probe, &thresholds(), &QualityExpectations::default());

        assert_eq!(report.verdict, QualityVerdict::Clean);
        assert!(
            !report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::AvSkew { .. }))
        );
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

    #[test]
    fn strict_freeze_threshold_flags_sub_two_second_freezes() {
        let base = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        let freezes = [FreezeSegment {
            start: 0.5,
            duration: 1.6,
        }];
        let report = combine_report(base, None, &freezes, &[], None, None, &thresholds());

        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(report.issues.iter().any(|issue| matches!(
            issue,
            QualityIssue::FrozenSegments {
                count: 1,
                longest_seconds
            } if (*longest_seconds - 1.6).abs() < 0.001
        )));
    }

    #[test]
    fn similarity_only_freezes_stay_informational_and_clean() {
        // The 2026-07 incident shape: freezedetect hits, zero exact repeats — a
        // still subject, not a pipeline freeze. Verdict stays Clean, no repair.
        let base = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        let similarity_only = [FreezeSegment {
            start: 55.1,
            duration: 2.1,
        }];
        let report = combine_report(base, None, &[], &similarity_only, None, None, &thresholds());

        assert_eq!(report.verdict, QualityVerdict::Clean);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::LowMotionSegments { count: 1, .. }))
        );
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
            Some(RepairVideoEncoder::Libx264),
        );
        assert!(plan.is_none(), "still content must never be repaired");
    }

    #[test]
    fn corroborated_freezes_split_on_exact_repeat_overlap() {
        let freezes = [
            FreezeSegment {
                start: 10.0,
                duration: 0.5,
            },
            FreezeSegment {
                start: 42.0,
                duration: 1.0,
            },
        ];
        // 30fps: frames 300..315 span 10.0s..10.5s — overlaps the first freeze only.
        let bursts = [RepeatedFrameBurst {
            start_index: 300,
            run: 15,
        }];
        let (corroborated, similarity_only) = corroborated_freezes(&freezes, &bursts, Some(30.0));
        assert_eq!(corroborated, vec![freezes[0]]);
        assert_eq!(similarity_only, vec![freezes[1]]);

        // No exact repeats at all -> everything is similarity-only.
        let (corroborated, similarity_only) = corroborated_freezes(&freezes, &[], Some(30.0));
        assert!(corroborated.is_empty());
        assert_eq!(similarity_only.len(), 2);

        // Without a usable fps the bursts cannot be placed in time.
        let (corroborated, similarity_only) = corroborated_freezes(&freezes, &bursts, None);
        assert!(corroborated.is_empty());
        assert_eq!(similarity_only.len(), 2);
    }

    #[test]
    fn parses_framemd5_and_summarizes_repeated_frame_bursts() {
        let output = "#format: frame checksums\n\
            0, 0, 0, 1, 1, aaa\n\
            0, 1, 1, 1, 1, aaa\n\
            0, 2, 2, 1, 1, aaa\n\
            0, 3, 3, 1, 1, bbb\n";
        let hashes = parse_framemd5_hashes(output);
        assert_eq!(hashes, vec!["aaa", "aaa", "aaa", "bbb"]);
        assert_eq!(
            repeated_frame_summary(&hashes, STRICT_MAX_REPEATED_FRAME_RUN),
            RepeatedFrameSummary {
                max_run: 3,
                bursts: 1,
                burst_runs: vec![RepeatedFrameBurst {
                    start_index: 0,
                    run: 3
                }]
            }
        );
    }

    #[test]
    fn audio_gap_summary_detects_packet_pts_gaps() {
        let packets = parse_audio_packets(
            "0.000000,0.021000\n0.021000,0.021000\n0.300000,0.021000\n0.321000,0.021000\n",
        );
        let gaps = audio_gap_summary(&packets, STRICT_AUDIO_GAP_TOLERANCE_MS);

        assert_eq!(gaps.count, 1);
        assert!(gaps.max_gap_ms > 250.0);
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
            Some(RepairVideoEncoder::Libx264),
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
            Some(RepairVideoEncoder::Libx264),
        )
        .unwrap();
        assert_eq!(plan.video, VideoRepair::Interpolate);
        assert!(plan.interpolated);
    }

    #[test]
    fn repeated_frames_select_interpolation() {
        let report = report_with(vec![QualityIssue::RepeatedFrames {
            bursts: 1,
            max_run: 7,
        }]);
        let plan = select_repair_plan(
            &report,
            &probe_for_strategy(),
            &QualityExpectations::default(),
            Some(RepairVideoEncoder::Libx264),
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
            Some(RepairVideoEncoder::Libx264),
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
            Some(RepairVideoEncoder::Libx264),
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
                &QualityExpectations::default(),
                Some(RepairVideoEncoder::Libx264),
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
                &QualityExpectations::default(),
                Some(RepairVideoEncoder::Libx264),
            )
            .is_none()
        );

        let audio_gap = QualityReport {
            verdict: QualityVerdict::NeedsReview,
            issues: vec![QualityIssue::AudioGap {
                count: 1,
                max_ms: 80.0,
            }],
        };
        assert!(
            select_repair_plan(
                &audio_gap,
                &probe_for_strategy(),
                &QualityExpectations::default(),
                Some(RepairVideoEncoder::Libx264),
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
            video_encoder: RepairVideoEncoder::Libx264,
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
            video_encoder: RepairVideoEncoder::Libx264,
        };
        let args = build_repair_args("in.mp4", "out.mp4", &plan);
        assert!(args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"));
        assert!(args.iter().any(|arg| arg == "pan=stereo|c0=c0|c1=c0"));
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
    }

    #[test]
    fn parses_encoder_names_from_ffmpeg_output() {
        let output = "Encoders:\n V..... = Video\n A..... = Audio\n ------\n \
                      V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n \
                      V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n \
                      A....D aac                  AAC (Advanced Audio Coding)\n";
        let names = parse_encoder_names(output);
        assert!(names.iter().any(|name| name == "h264_videotoolbox"));
        assert!(names.iter().any(|name| name == "libx264"));
        assert!(names.iter().any(|name| name == "aac"));
        assert!(!names.iter().any(|name| name == "Encoders:"));
    }

    #[test]
    fn encoder_preference_is_x264_then_platform_hardware() {
        let full = vec![
            "aac".to_string(),
            "h264_videotoolbox".to_string(),
            "libx264".to_string(),
        ];
        assert_eq!(
            select_repair_encoder(&full),
            Some(RepairVideoEncoder::Libx264)
        );

        let lgpl_macos = vec!["aac".to_string(), "h264_videotoolbox".to_string()];
        assert_eq!(
            select_repair_encoder(&lgpl_macos),
            Some(RepairVideoEncoder::H264VideoToolbox)
        );

        let lgpl_windows = vec!["aac".to_string(), "h264_mf".to_string()];
        assert_eq!(
            select_repair_encoder(&lgpl_windows),
            Some(RepairVideoEncoder::H264MediaFoundation)
        );

        assert_eq!(select_repair_encoder(&["aac".to_string()]), None);
    }

    #[test]
    fn no_encoder_skips_transcode_repairs_honestly() {
        // Transcode-only issues: no encoder → no plan (no guaranteed-to-fail command).
        let vfr = report_with(vec![QualityIssue::VariableFrameRate {
            avg_fps: 24.0,
            nominal_fps: 30.0,
        }]);
        assert!(
            select_repair_plan(
                &vfr,
                &probe_for_strategy(),
                &QualityExpectations::default(),
                None,
            )
            .is_none()
        );

        // Mixed issues: the audio-only repair still runs; video stays a stream copy.
        let mixed = report_with(vec![
            QualityIssue::DroppedFrames {
                observed: 250,
                expected: 300,
            },
            QualityIssue::AvSkew { ms: 500.0 },
        ]);
        let plan = select_repair_plan(
            &mixed,
            &probe_for_strategy(),
            &QualityExpectations::default(),
            None,
        )
        .unwrap();
        assert_eq!(plan.video, VideoRepair::Copy);
        assert!(matches!(plan.audio, AudioRepair::Resync { .. }));
        assert!(!plan.interpolated);
    }

    #[test]
    fn transcode_args_never_use_crf_off_libx264() {
        for (encoder, name) in [
            (RepairVideoEncoder::H264VideoToolbox, "h264_videotoolbox"),
            (RepairVideoEncoder::H264MediaFoundation, "h264_mf"),
        ] {
            let plan = RepairPlan {
                video: VideoRepair::CfrTranscode,
                audio: AudioRepair::Copy,
                target_fps: 30.0,
                interpolated: false,
                video_encoder: encoder,
            };
            let args = build_repair_args("in.mp4", "out.mp4", &plan);
            assert!(
                args.windows(2).any(|w| w[0] == "-c:v" && w[1] == name),
                "expected {name} in {args:?}"
            );
            assert!(
                !args.iter().any(|arg| arg == "-crf"),
                "-crf leaked into {name} args: {args:?}"
            );
            assert!(
                args.windows(2)
                    .any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p")
            );
        }
    }

    #[test]
    fn transcode_needing_issues_are_classified() {
        assert!(needs_transcode_repair(&[QualityIssue::VariableFrameRate {
            avg_fps: 24.0,
            nominal_fps: 30.0,
        }]));
        assert!(needs_transcode_repair(&[QualityIssue::FrozenSegments {
            count: 1,
            longest_seconds: 0.5,
        }]));
        assert!(!needs_transcode_repair(&[QualityIssue::AvSkew {
            ms: 300.0
        }]));
        assert!(!needs_transcode_repair(&[QualityIssue::MissingAudio]));
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

    #[test]
    fn combine_report_folds_one_sided_and_freezes() {
        let base = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        let freezes = [FreezeSegment {
            start: 5.0,
            duration: 3.5,
        }];
        let report = combine_report(base, Some(2), &freezes, &[], None, None, &thresholds());
        assert_eq!(report.verdict, QualityVerdict::Repairable);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::OneSidedAudio { silent_channel: 2 }))
        );
        assert!(
            report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::FrozenSegments { count: 1, .. }))
        );
    }

    #[test]
    fn combine_report_stays_clean_without_extras() {
        let base = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        let report = combine_report(base, None, &[], &[], None, None, &thresholds());
        assert_eq!(report.verdict, QualityVerdict::Clean);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn combine_report_folds_repeated_frames_and_audio_gaps() {
        let base = QualityReport {
            verdict: QualityVerdict::Clean,
            issues: vec![],
        };
        let report = combine_report(
            base,
            None,
            &[],
            &[],
            Some(RepeatedFrameSummary {
                max_run: 7,
                bursts: 1,
                burst_runs: vec![RepeatedFrameBurst {
                    start_index: 10,
                    run: 7,
                }],
            }),
            Some(AudioGapSummary {
                count: 1,
                max_gap_ms: 80.0,
            }),
            &thresholds(),
        );

        assert_eq!(report.verdict, QualityVerdict::NeedsReview);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::RepeatedFrames { max_run: 7, .. }))
        );
        assert!(report
            .issues
            .iter()
            .any(|issue| matches!(issue, QualityIssue::AudioGap { max_ms, .. } if (*max_ms - 80.0).abs() < 0.001)));
    }

    #[test]
    fn lists_only_video_files_skipping_hidden_and_backups() {
        let dir = scratch_dir("list");
        fs::write(dir.join("a.mp4"), b"x").unwrap();
        fs::write(dir.join("b.mkv"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join(".hidden.mp4"), b"x").unwrap();
        fs::create_dir_all(dir.join(".videorc-backups")).unwrap();
        fs::write(dir.join(".videorc-backups").join("a.mp4"), b"x").unwrap();

        let files = list_recording_files(&dir).unwrap();
        let names: Vec<_> = files
            .iter()
            .filter_map(|path| path.file_name()?.to_str())
            .collect();
        assert_eq!(names, vec!["a.mp4", "b.mkv"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// End-to-end fixture proof (slice 13): build a real one-sided stereo recording
    /// (right channel silent) with FFmpeg, confirm the analyzer flags it, repair it
    /// through the quality-gated backup/replace, and confirm the visible file is now
    /// centered with the original safely backed up and restorable. Ignored by default
    /// (spawns ffmpeg + writes files); run with `--ignored`.
    #[test]
    #[ignore = "builds ffmpeg fixtures and repairs them; run with --ignored"]
    fn repairs_a_one_sided_recording_end_to_end() {
        let dir = scratch_dir("fixture-one-sided");
        let original = dir.join("one_sided.mp4");

        let built = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                // Right channel silenced → one-sided.
                "-filter_complex",
                "[1:a]pan=stereo|c0=c0|c1=0*c0[a]",
                "-map",
                "0:v",
                "-map",
                "[a]",
                "-t",
                "2",
                "-r",
                "30",
                "-vsync",
                "cfr",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ac",
                "2",
            ])
            .arg(&original)
            .status()
            .expect("ffmpeg should be on PATH for this ignored test");
        assert!(built.success(), "fixture build failed");

        let thresholds = QualityThresholds::default();
        let expectations = QualityExpectations::default();
        let original_str = original.to_string_lossy().to_string();

        // Analyze → one-sided is detected and the plan centers the active channel.
        let (probe, report) = analyze_recording(
            "ffmpeg",
            "ffprobe",
            &original_str,
            &thresholds,
            &expectations,
        )
        .unwrap();
        assert!(
            report
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::OneSidedAudio { .. })),
            "expected one-sided audio, got {:?}",
            report.issues
        );
        let plan = select_repair_plan(
            &report,
            &probe,
            &expectations,
            Some(RepairVideoEncoder::Libx264),
        )
        .unwrap();
        assert!(matches!(plan.audio, AudioRepair::CenterChannel { .. }));

        // Repair (quality-gated backup/replace).
        let assessment = RecordingAssessment {
            path: original_str.clone(),
            report,
            plan: Some(plan),
        };
        let outcome =
            repair_recording("ffmpeg", "ffprobe", &assessment, &thresholds, &expectations);
        assert!(
            matches!(outcome, RepairOutcome::Repaired { .. }),
            "expected Repaired, got {outcome:?}"
        );

        // The visible file is now centered, and the original is backed up + restorable.
        let (_, after) = analyze_recording(
            "ffmpeg",
            "ffprobe",
            &original_str,
            &thresholds,
            &expectations,
        )
        .unwrap();
        assert!(
            !after
                .issues
                .iter()
                .any(|issue| matches!(issue, QualityIssue::OneSidedAudio { .. })),
            "still one-sided after repair: {:?}",
            after.issues
        );
        assert!(backup_path_for(&original).unwrap().exists(), "backup kept");
        assert!(restore_from_backup(&original).unwrap(), "restore works");

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Slice 12: batch repair report ---

    fn assessment(
        path: &str,
        verdict: QualityVerdict,
        issues: Vec<QualityIssue>,
    ) -> RecordingAssessment {
        RecordingAssessment {
            path: path.to_string(),
            report: QualityReport { verdict, issues },
            plan: None,
        }
    }

    #[test]
    fn build_report_rolls_up_summary_counts() {
        let assessments = vec![
            assessment("/m/a.mp4", QualityVerdict::Clean, vec![]),
            assessment(
                "/m/b.mp4",
                QualityVerdict::Repairable,
                vec![QualityIssue::OneSidedAudio { silent_channel: 1 }],
            ),
            assessment(
                "/m/c.mp4",
                QualityVerdict::Repairable,
                vec![QualityIssue::DroppedFrames {
                    observed: 10,
                    expected: 100,
                }],
            ),
            assessment(
                "/m/d.mp4",
                QualityVerdict::NeedsReview,
                vec![QualityIssue::MissingAudio],
            ),
        ];
        let outcomes = vec![
            RepairOutcome::AlreadyClean {
                path: "/m/a.mp4".to_string(),
            },
            RepairOutcome::Repaired {
                path: "/m/b.mp4".to_string(),
                interpolated: false,
            },
            RepairOutcome::Repaired {
                path: "/m/c.mp4".to_string(),
                interpolated: true,
            },
            RepairOutcome::NotImproved {
                path: "/m/d.mp4".to_string(),
                reason: "missing audio".to_string(),
            },
        ];

        let report = build_repair_report(&assessments, &outcomes);
        assert_eq!(
            report.summary,
            RepairSummary {
                total: 4,
                already_clean: 1,
                repaired: 2,
                interpolated: 1,
                not_improved: 1,
                failed: 0,
            }
        );
        assert_eq!(report.entries.len(), 4);
        // Each entry pairs the pre-repair verdict + issues with the outcome.
        assert_eq!(report.entries[1].verdict, QualityVerdict::Repairable);
        assert_eq!(
            report.entries[1].issues,
            vec![QualityIssue::OneSidedAudio { silent_channel: 1 }]
        );
    }

    #[test]
    fn markdown_report_describes_each_file() {
        let report = build_repair_report(
            &[assessment(
                "/m/one-sided.mp4",
                QualityVerdict::Repairable,
                vec![QualityIssue::OneSidedAudio { silent_channel: 1 }],
            )],
            &[RepairOutcome::Repaired {
                path: "/m/one-sided.mp4".to_string(),
                interpolated: false,
            }],
        );
        let md = render_markdown_report(&report);
        assert!(md.contains("# Videorc Repair Report"));
        assert!(md.contains("- Files scanned: 1"));
        assert!(md.contains("- Repaired: 1"));
        assert!(md.contains("### /m/one-sided.mp4"));
        assert!(md.contains("one-sided audio (channel 1 silent)"));
        assert!(md.contains("Outcome: repaired"));
    }

    #[test]
    fn markdown_report_flags_interpolation_and_not_100() {
        let report = build_repair_report(
            &[
                assessment(
                    "/m/stutter.mp4",
                    QualityVerdict::Repairable,
                    vec![QualityIssue::DroppedFrames {
                        observed: 50,
                        expected: 300,
                    }],
                ),
                assessment(
                    "/m/broken.mp4",
                    QualityVerdict::NeedsReview,
                    vec![QualityIssue::MissingVideo],
                ),
            ],
            &[
                RepairOutcome::Repaired {
                    path: "/m/stutter.mp4".to_string(),
                    interpolated: true,
                },
                RepairOutcome::NotImproved {
                    path: "/m/broken.mp4".to_string(),
                    reason: "still not 100%".to_string(),
                },
            ],
        );
        let md = render_markdown_report(&report);
        assert!(md.contains("repaired (interpolated frames)"));
        assert!(md.contains("(1 with interpolated frames)"));
        assert!(md.contains("kept original, not 100%: still not 100%"));
    }

    #[test]
    fn markdown_report_handles_empty_batch() {
        let report = build_repair_report(&[], &[]);
        assert_eq!(report.summary.total, 0);
        let md = render_markdown_report(&report);
        assert!(md.contains("- Files scanned: 0"));
        assert!(md.contains("_No recordings found._"));
    }

    #[test]
    fn json_report_is_camel_case_and_parses_back() {
        let report = build_repair_report(
            &[assessment(
                "/m/a.mp4",
                QualityVerdict::Repairable,
                vec![QualityIssue::AvSkew { ms: 320.0 }],
            )],
            &[RepairOutcome::Repaired {
                path: "/m/a.mp4".to_string(),
                interpolated: false,
            }],
        );
        let json = render_json_report(&report).unwrap();
        assert!(json.contains("\"alreadyClean\""));
        assert!(json.contains("\"notImproved\""));
        // RepairOutcome is internally tagged on "status" (kebab-case).
        assert!(json.contains("\"status\": \"repaired\""));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["summary"]["repaired"], 1);
        assert_eq!(parsed["entries"][0]["path"], "/m/a.mp4");
    }

    #[test]
    fn write_repair_reports_writes_markdown_and_json() {
        let dir = scratch_dir("report-write");
        let report = build_repair_report(
            &[assessment("/m/a.mp4", QualityVerdict::Clean, vec![])],
            &[RepairOutcome::AlreadyClean {
                path: "/m/a.mp4".to_string(),
            }],
        );
        let (md_path, json_path) = write_repair_reports(&dir, &report).unwrap();
        assert!(md_path.exists());
        assert!(json_path.exists());
        assert!(
            fs::read_to_string(&md_path)
                .unwrap()
                .contains("# Videorc Repair Report")
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&json_path).unwrap()).unwrap();
        assert_eq!(parsed["summary"]["alreadyClean"], 1);
        let _ = fs::remove_dir_all(&dir);
    }

    // --- Slice 8: post-recording quality gate ---

    #[test]
    fn issue_reasons_are_human_readable() {
        let reasons = issue_reasons(&[
            QualityIssue::OneSidedAudio { silent_channel: 1 },
            QualityIssue::AvSkew { ms: 300.0 },
        ]);
        assert_eq!(reasons.len(), 2);
        assert!(reasons[0].contains("one-sided audio"));
        assert!(reasons[1].contains("A/V skew"));
    }

    #[test]
    fn gate_reports_failed_when_the_file_cannot_be_probed() {
        let status = gate_recording(
            "videorc-ffmpeg-missing",
            "videorc-ffprobe-missing",
            "/nonexistent/recording.mp4",
            &QualityThresholds::default(),
            &QualityExpectations {
                intended_fps: None,
                expect_audio: true,
            },
        );
        assert!(
            matches!(status, GateStatus::Failed { .. }),
            "got {status:?}"
        );
    }

    #[test]
    #[ignore = "spawns ffmpeg/ffprobe to build and gate a real clean recording"]
    fn gate_passes_a_clean_recording() {
        let dir = scratch_dir("gate-clean");
        let path = dir.join("clean.mp4");
        let built = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "fixture build failed: {}",
            String::from_utf8_lossy(&built.stderr)
        );

        let status = gate_recording(
            "ffmpeg",
            "ffprobe",
            path.to_str().unwrap(),
            &QualityThresholds::default(),
            &QualityExpectations {
                intended_fps: Some(30.0),
                expect_audio: true,
            },
        );
        assert!(matches!(status, GateStatus::Ready { .. }), "got {status:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "spawns ffmpeg/ffprobe to build and gate a one-sided recording"]
    fn gate_repairs_a_one_sided_recording() {
        let dir = scratch_dir("gate-one-sided");
        let path = dir.join("one-sided.mp4");
        let built = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "1",
                "-af",
                "pan=stereo|c0=c0|c1=0*c0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "fixture build failed: {}",
            String::from_utf8_lossy(&built.stderr)
        );

        let status = gate_recording(
            "ffmpeg",
            "ffprobe",
            path.to_str().unwrap(),
            &QualityThresholds::default(),
            &QualityExpectations {
                intended_fps: Some(30.0),
                expect_audio: true,
            },
        );
        assert!(
            matches!(status, GateStatus::Repaired { .. }),
            "got {status:?}"
        );
        assert!(backup_path_for(&path).unwrap().exists(), "backup kept");
        let _ = fs::remove_dir_all(&dir);
    }

    // --- Slice 9: persistent repair jobs ---

    fn sample_expectations() -> QualityExpectations {
        QualityExpectations {
            intended_fps: Some(30.0),
            expect_audio: true,
        }
    }

    #[test]
    fn job_status_db_strings_round_trip() {
        for status in [
            RepairJobStatus::Pending,
            RepairJobStatus::Running,
            RepairJobStatus::Completed,
            RepairJobStatus::Failed,
            RepairJobStatus::Cancelled,
        ] {
            assert_eq!(RepairJobStatus::from_db(status.as_str()), status);
        }
        // Unknown values default to Pending so a job is retried, never lost.
        assert_eq!(RepairJobStatus::from_db("bogus"), RepairJobStatus::Pending);
    }

    #[test]
    fn only_pending_and_running_jobs_are_resumable() {
        assert!(RepairJobStatus::Pending.is_resumable());
        assert!(RepairJobStatus::Running.is_resumable());
        assert!(!RepairJobStatus::Completed.is_resumable());
        assert!(!RepairJobStatus::Failed.is_resumable());
        assert!(!RepairJobStatus::Cancelled.is_resumable());
    }

    #[test]
    fn job_lifecycle_running_then_complete_records_outcome() {
        let mut job = RepairJob::pending(
            "job-1".to_string(),
            "/m/a.mp4".to_string(),
            &sample_expectations(),
            "t0".to_string(),
        );
        assert_eq!(job.status, RepairJobStatus::Pending);
        assert_eq!(job.expectations().intended_fps, Some(30.0));
        assert!(job.expectations().expect_audio);

        job.mark_running("t1".to_string());
        assert_eq!(job.status, RepairJobStatus::Running);

        job.complete(
            &RepairOutcome::Repaired {
                path: "/m/a.mp4".to_string(),
                interpolated: false,
            },
            "t2".to_string(),
        );
        assert_eq!(job.status, RepairJobStatus::Completed);
        assert_eq!(job.updated_at, "t2");
        let outcome = job.outcome.expect("outcome stored");
        assert_eq!(outcome["status"], "repaired");
    }

    #[test]
    fn cancelling_a_job_never_reads_as_good() {
        let mut job = RepairJob::pending(
            "job-2".to_string(),
            "/m/b.mp4".to_string(),
            &sample_expectations(),
            "t0".to_string(),
        );
        // Even after a provisional outcome was recorded, cancelling clears it so nothing
        // downstream can mistake the file for repaired.
        job.complete(
            &RepairOutcome::Repaired {
                path: "/m/b.mp4".to_string(),
                interpolated: false,
            },
            "t1".to_string(),
        );
        job.cancel("t2".to_string());
        assert_eq!(job.status, RepairJobStatus::Cancelled);
        assert!(
            job.outcome.is_none(),
            "cancel clears any provisional outcome"
        );
        assert!(!job.status.is_resumable());
    }

    #[test]
    fn deferring_a_job_keeps_it_resumable_without_success_outcome() {
        let mut job = RepairJob::pending(
            "job-deferred".to_string(),
            "/m/deferred.mp4".to_string(),
            &sample_expectations(),
            "t0".to_string(),
        );
        job.mark_running("t1".to_string());
        job.outcome = Some(serde_json::json!({ "status": "ready" }));

        job.defer("capture started".to_string(), "t2".to_string());

        assert_eq!(job.status, RepairJobStatus::Pending);
        assert!(job.outcome.is_none());
        assert_eq!(job.reason.as_deref(), Some("capture started"));
        assert!(job.status.is_resumable());
    }

    #[test]
    fn cancelling_with_reason_records_terminal_reason() {
        let mut job = RepairJob::pending(
            "job-cancelled".to_string(),
            "/m/missing.mp4".to_string(),
            &sample_expectations(),
            "t0".to_string(),
        );

        job.cancel_with_reason("missing temp file".to_string(), "t1".to_string());

        assert_eq!(job.status, RepairJobStatus::Cancelled);
        assert_eq!(job.reason.as_deref(), Some("missing temp file"));
        assert!(!job.status.is_resumable());
    }

    #[test]
    fn job_serializes_camel_case_with_kebab_status() {
        let mut job = RepairJob::pending(
            "job-3".to_string(),
            "/m/c.mp4".to_string(),
            &sample_expectations(),
            "t0".to_string(),
        );
        job.fail("ffmpeg exploded".to_string(), "t1".to_string());
        let json = serde_json::to_string(&job).unwrap();
        assert!(json.contains("\"filePath\":\"/m/c.mp4\""));
        assert!(json.contains("\"expectAudio\":true"));
        assert!(json.contains("\"status\":\"failed\""));
        assert!(json.contains("\"reason\":\"ffmpeg exploded\""));

        let parsed: RepairJob = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, job);
    }
}
