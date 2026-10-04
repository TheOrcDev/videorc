//! Render the cut list into a new MP4 (plan 119 S13, decisions 17 and 18).
//!
//! One FFmpeg pass. The kept ranges are the complement of the enabled
//! removals, in frame units. Each range becomes `trim=start_frame:end_frame`
//! on a `split` of the decoded video and `atrim=start_sample:end_sample` on
//! an `asplit` of every audio track, with `afade`s of `JOIN_FADE_MS` at the
//! internal joins only, then one `concat=n=N:v=1:a=K`. Audio cut points come
//! from the same frame indices: a segment starts at the sample nearest its
//! frame boundary, and its length is the difference of the cumulative
//! kept-frame boundaries converted once, so the output audio totals exactly
//! `frame_to_sample(kept_frames)` samples however many cuts there are (the
//! sum telescopes; no per-cut rounding ever accumulates). Video is exact by
//! construction: `trim` selects frames by index.
//!
//! Scaling: every range is a `split` output, a `trim`, an `atrim` per audio
//! track and a `concat` input, so one pass carries at most
//! `RENDER_MAX_KEPT_RANGES` ranges (2 000, about a two-hour talk with a cut
//! every 4 s); more is refused with a plain message. A graph over
//! `RENDER_GRAPH_INLINE_MAX_BYTES` is written to a script file next to the
//! staging file and passed as `-/filter_complex <file>` (the FFmpeg 7+ form;
//! `-filter_complex_script` is deprecated in the bundled 8.1), so the
//! command line never carries 400 KB of filters.
//!
//! The encoder follows the recording table per platform: macOS
//! `h264_videotoolbox`; Windows `h264_mf`, then `libopenh264`; Linux
//! `h264_vaapi` when the recording path's render-node probe accepted a
//! device, then `libopenh264`. A later encoder in the chain is tried when an
//! earlier one fails. The bitrate matches the source, size and frame rate
//! are kept, the BT.709 video-range tags are written, the MP4 gets
//! `+faststart`, audio is AAC at the source rate. Before publishing, ffprobe
//! must agree: same stream counts, dimensions and frame rate, and video and
//! audio durations within one frame of the kept duration.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::BufRead;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::edl::{frame_to_ms, ms_to_frame};
use super::job::{
    ERROR_FFMPEG_UNSUPPORTED, ERROR_FILE_MISSING, ERROR_INSUFFICIENT_SPACE, ERROR_PROBE,
    ERROR_PROCESSING, ERROR_RENDER_FAILED, ERROR_RENDER_INVALID, ERROR_RENDER_TOO_MANY_CUTS,
    EVENT_STATUS, Interrupts, JobControl, JobFailure, PhaseOutcome, persist_and_emit,
    set_job_state,
};
use super::rules::{
    JOIN_FADE_MS, RENDER_DURATION_TOLERANCE_FRAMES, RENDER_FORMAT_BITRATE_PER_MILLE,
    RENDER_FREE_SPACE_TENTHS, RENDER_GRAPH_INLINE_MAX_BYTES, RENDER_MAX_AUDIO_KBPS,
    RENDER_MAX_KEPT_RANGES, RENDER_MIN_VIDEO_KBPS, RENDER_PROGRESS_INTERVAL_MS,
};
use super::srt::write_retimed_srt;
use super::transcribe::{capture_source_identity, parse_frame_rate, read_bounded_tail};
use crate::atomic_file::replace_file;
use crate::ffmpeg::{default_ffmpeg_path, ffprobe_path_for};
use crate::ffmpeg_work::MaintenanceCancelToken;
use crate::h264_profile::{h264_high_level_label, h264_vaapi_level_arg};
use crate::process_job::{output_owned_std_with_timeout, spawn_owned_std};
use crate::protocol::{
    CleanCutEdl, CleanCutFrameRate, CleanCutJobState, CleanCutMode, LinuxVaapiArgProfile,
};
use crate::state::AppState;
use crate::storage::PersistedCleanCutJob;

pub const RENDER_RECORD_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const CAPABILITY_TIMEOUT: Duration = Duration::from_secs(30);
/// The staging file sits next to the destination so the final rename never
/// crosses a volume.
const STAGING_MARKER: &str = "videorc-partial";

// --- Kept ranges ----------------------------------------------------------------

/// One kept span of the source, as frame indices on its grid (`end_frame`
/// exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeptRange {
    pub start_frame: u64,
    pub end_frame: u64,
}

/// The complement of the enabled removals over the whole recording, in frame
/// units. Overlapping removals merge; disabled suggestions do not cut.
pub fn kept_ranges(edl: &CleanCutEdl) -> Vec<KeptRange> {
    let total_frames = ms_to_frame(edl.duration_ms, edl.frame_rate);
    let mut removed: Vec<(u64, u64)> = edl
        .removals
        .iter()
        .filter(|removal| removal.enabled)
        .map(|removal| {
            (
                removal.start_frame.min(total_frames),
                removal.end_frame.min(total_frames),
            )
        })
        .filter(|(start, end)| end > start)
        .collect();
    removed.sort_unstable();
    let mut kept = Vec::new();
    let mut cursor = 0_u64;
    for (start, end) in removed {
        if start > cursor {
            kept.push(KeptRange {
                start_frame: cursor,
                end_frame: start,
            });
        }
        cursor = cursor.max(end);
    }
    if cursor < total_frames {
        kept.push(KeptRange {
            start_frame: cursor,
            end_frame: total_frames,
        });
    }
    kept
}

pub fn kept_frames(ranges: &[KeptRange]) -> u64 {
    ranges
        .iter()
        .map(|range| range.end_frame.saturating_sub(range.start_frame))
        .sum()
}

/// The sample index nearest the boundary of frame `frame` on the source
/// grid: `round(frame * den * rate / num)`, exact in 128-bit integers.
pub fn frame_to_sample(frame: u64, frame_rate: CleanCutFrameRate, sample_rate: u32) -> u64 {
    let num = u128::from(frame_rate.num.max(1));
    let numerator = u128::from(frame) * u128::from(frame_rate.den) * u128::from(sample_rate);
    u64::try_from((numerator + num / 2) / num).unwrap_or(u64::MAX)
}

/// One kept span of an audio track, in samples (`end_sample` exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSegment {
    pub start_sample: u64,
    pub end_sample: u64,
}

/// Audio cut points for the kept ranges on one track's sample grid. A
/// segment starts at the sample nearest its frame boundary; its length is the
/// difference between the cumulative kept-frame boundaries before and after
/// it, each converted once. The total therefore equals
/// `frame_to_sample(kept_frames)` exactly (the sum telescopes), and every end
/// sits within one sample of the true source boundary.
pub fn audio_segments(
    ranges: &[KeptRange],
    frame_rate: CleanCutFrameRate,
    sample_rate: u32,
) -> Vec<AudioSegment> {
    let mut out = Vec::with_capacity(ranges.len());
    let mut cumulative_frames = 0_u64;
    for range in ranges {
        let frames = range.end_frame.saturating_sub(range.start_frame);
        let before = frame_to_sample(cumulative_frames, frame_rate, sample_rate);
        let after = frame_to_sample(cumulative_frames + frames, frame_rate, sample_rate);
        let start_sample = frame_to_sample(range.start_frame, frame_rate, sample_rate);
        out.push(AudioSegment {
            start_sample,
            end_sample: start_sample + (after - before),
        });
        cumulative_frames += frames;
    }
    out
}

// --- Source and output facts ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderVideoInfo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: CleanCutFrameRate,
    /// Bits per second, when the container says.
    pub bit_rate: Option<u64>,
    pub nb_frames: Option<u64>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderAudioInfo {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_rate: Option<u64>,
    pub duration_ms: Option<u64>,
}

/// What the render needs to know about a file: the first video stream and
/// every audio stream, plus the container's duration and bitrate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderProbe {
    pub video: RenderVideoInfo,
    pub audio: Vec<RenderAudioInfo>,
    pub format_duration_ms: Option<u64>,
    pub format_bit_rate: Option<u64>,
}

/// `ffprobe -show_format -show_streams -of json`.
pub fn parse_render_probe(json: &str) -> Result<RenderProbe, String> {
    #[derive(Deserialize)]
    struct Output {
        #[serde(default)]
        streams: Vec<Stream>,
        format: Option<Format>,
    }
    #[derive(Deserialize)]
    struct Stream {
        codec_type: Option<String>,
        codec_name: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        r_frame_rate: Option<String>,
        avg_frame_rate: Option<String>,
        bit_rate: Option<String>,
        nb_frames: Option<String>,
        duration: Option<String>,
        sample_rate: Option<String>,
        channels: Option<u32>,
    }
    #[derive(Deserialize)]
    struct Format {
        duration: Option<String>,
        bit_rate: Option<String>,
    }

    let output: Output =
        serde_json::from_str(json).map_err(|error| format!("invalid ffprobe json: {error}"))?;
    let video = output
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| "the file has no video stream".to_string())?;
    let frame_rate = video
        .r_frame_rate
        .as_deref()
        .and_then(parse_frame_rate)
        .or_else(|| video.avg_frame_rate.as_deref().and_then(parse_frame_rate))
        .ok_or_else(|| "the video stream has no frame rate".to_string())?;
    let (width, height) = match (video.width, video.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => (width, height),
        _ => return Err("the video stream has no dimensions".to_string()),
    };
    let audio = output
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
        .map(|stream| {
            Ok(RenderAudioInfo {
                codec: stream.codec_name.clone().unwrap_or_default(),
                sample_rate: parse_u64(stream.sample_rate.as_deref())
                    .and_then(|rate| u32::try_from(rate).ok())
                    .filter(|rate| *rate > 0)
                    .ok_or_else(|| "an audio stream has no sample rate".to_string())?,
                channels: stream.channels.unwrap_or(0).max(1),
                bit_rate: parse_u64(stream.bit_rate.as_deref()).filter(|rate| *rate > 0),
                duration_ms: seconds_to_ms(stream.duration.as_deref()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let format = output.format.as_ref();
    Ok(RenderProbe {
        video: RenderVideoInfo {
            codec: video.codec_name.clone().unwrap_or_default(),
            width,
            height,
            frame_rate,
            bit_rate: parse_u64(video.bit_rate.as_deref()).filter(|rate| *rate > 0),
            nb_frames: parse_u64(video.nb_frames.as_deref()),
            duration_ms: seconds_to_ms(video.duration.as_deref()),
        },
        audio,
        format_duration_ms: seconds_to_ms(format.and_then(|format| format.duration.as_deref())),
        format_bit_rate: parse_u64(format.and_then(|format| format.bit_rate.as_deref()))
            .filter(|rate| *rate > 0),
    })
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

fn seconds_to_ms(value: Option<&str>) -> Option<u64> {
    let seconds = value?.trim().parse::<f64>().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then(|| (seconds * 1_000.0).round() as u64)
}

/// The output video bitrate: the source stream's, else 95% of the container's
/// (which includes audio), never under `RENDER_MIN_VIDEO_KBPS`.
pub fn video_bitrate_kbps(probe: &RenderProbe) -> u32 {
    let from_stream = probe.video.bit_rate.map(|bits| bits / 1_000);
    let from_format = probe
        .format_bit_rate
        .map(|bits| bits * RENDER_FORMAT_BITRATE_PER_MILLE / 1_000 / 1_000);
    let kbps = from_stream.or(from_format).unwrap_or(0);
    u32::try_from(kbps)
        .unwrap_or(u32::MAX)
        .max(RENDER_MIN_VIDEO_KBPS)
}

/// AAC per track: `RENDER_MAX_AUDIO_KBPS`, or the source track's bitrate when
/// that is lower (never under 32 kbps).
pub fn audio_bitrate_kbps(track: &RenderAudioInfo) -> u32 {
    track
        .bit_rate
        .map(|bits| u32::try_from(bits / 1_000).unwrap_or(u32::MAX))
        .filter(|kbps| *kbps > 0)
        .map(|kbps| kbps.clamp(32, RENDER_MAX_AUDIO_KBPS))
        .unwrap_or(RENDER_MAX_AUDIO_KBPS)
}

// --- The filter graph -----------------------------------------------------------------

/// The graph text and the labels the command maps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterGraph {
    pub text: String,
    pub video_label: String,
    pub audio_labels: Vec<String>,
}

/// Build the one-pass graph described in the module doc. `pixel_format` is
/// what the chosen encoder takes; `hardware_upload` adds VAAPI's `hwupload`
/// after the format conversion.
pub fn build_filter_graph(
    ranges: &[KeptRange],
    frame_rate: CleanCutFrameRate,
    audio: &[RenderAudioInfo],
    fade_ms: u64,
    pixel_format: &str,
    hardware_upload: bool,
) -> FilterGraph {
    let count = ranges.len();
    let mut chains: Vec<String> = Vec::new();
    if count > 1 {
        let outputs: String = (0..count).map(|index| format!("[v{index}]")).collect();
        chains.push(format!("[0:v]split={count}{outputs}"));
    }
    for (index, range) in ranges.iter().enumerate() {
        let input = if count > 1 {
            format!("[v{index}]")
        } else {
            "[0:v]".to_string()
        };
        chains.push(format!(
            "{input}trim=start_frame={}:end_frame={},setpts=PTS-STARTPTS[tv{index}]",
            range.start_frame, range.end_frame
        ));
    }
    let fade_seconds = fade_ms as f64 / 1_000.0;
    for (track, info) in audio.iter().enumerate() {
        let segments = audio_segments(ranges, frame_rate, info.sample_rate);
        if count > 1 {
            let outputs: String = (0..count)
                .map(|index| format!("[a{track}_{index}]"))
                .collect();
            chains.push(format!("[0:a:{track}]asplit={count}{outputs}"));
        }
        let fade_samples = fade_ms * u64::from(info.sample_rate) / 1_000;
        for (index, segment) in segments.iter().enumerate() {
            let input = if count > 1 {
                format!("[a{track}_{index}]")
            } else {
                format!("[0:a:{track}]")
            };
            let length = segment.end_sample.saturating_sub(segment.start_sample);
            let mut chain = format!(
                "atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS",
                segment.start_sample, segment.end_sample
            );
            // Fades belong to internal joins only: never at the very start of
            // the output or at its very end, and never on a segment too short
            // to hold both.
            if fade_ms > 0 && count > 1 && length >= fade_samples.saturating_mul(2) {
                if index > 0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={fade_seconds:.3}"));
                }
                if index + 1 < count {
                    let start = (length - fade_samples) as f64 / f64::from(info.sample_rate);
                    chain.push_str(&format!(",afade=t=out:st={start:.6}:d={fade_seconds:.3}"));
                }
            }
            chains.push(format!("{input}{chain}[ta{track}_{index}]"));
        }
    }
    let mut concat_inputs = String::new();
    for index in 0..count {
        concat_inputs.push_str(&format!("[tv{index}]"));
        for track in 0..audio.len() {
            concat_inputs.push_str(&format!("[ta{track}_{index}]"));
        }
    }
    let audio_labels: Vec<String> = (0..audio.len()).map(|track| format!("ca{track}")).collect();
    let concat_outputs: String = std::iter::once("[cv]".to_string())
        .chain(audio_labels.iter().map(|label| format!("[{label}]")))
        .collect();
    chains.push(format!(
        "{concat_inputs}concat=n={count}:v=1:a={}{concat_outputs}",
        audio.len()
    ));
    let tail = if hardware_upload {
        format!("format={pixel_format},hwupload")
    } else {
        format!("format={pixel_format}")
    };
    chains.push(format!("[cv]{tail}[outv]"));
    FilterGraph {
        text: chains.join(";"),
        video_label: "outv".to_string(),
        audio_labels,
    }
}

/// How the graph reaches FFmpeg.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphArgument {
    Inline(String),
    /// `-/filter_complex <file>`: the option value read from a file.
    ScriptFile(PathBuf),
}

pub fn graph_needs_script(text: &str) -> bool {
    text.len() > RENDER_GRAPH_INLINE_MAX_BYTES
}

// --- Encoders -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderPlatform {
    Macos,
    Windows,
    Linux,
}

pub fn current_render_platform() -> Option<RenderPlatform> {
    if cfg!(target_os = "macos") {
        Some(RenderPlatform::Macos)
    } else if cfg!(target_os = "windows") {
        Some(RenderPlatform::Windows)
    } else if cfg!(target_os = "linux") {
        Some(RenderPlatform::Linux)
    } else {
        None
    }
}

/// One H.264 encoder the render may use, from the recording table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderEncoder {
    VideoToolbox,
    MediaFoundation,
    OpenH264,
    Vaapi {
        device: PathBuf,
        profile: LinuxVaapiArgProfile,
    },
}

impl RenderEncoder {
    pub fn codec(&self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::MediaFoundation => "h264_mf",
            Self::OpenH264 => "libopenh264",
            Self::Vaapi { .. } => "h264_vaapi",
        }
    }

    /// The pixel format the graph converts to before the encoder.
    pub fn pixel_format(&self) -> &'static str {
        match self {
            Self::VideoToolbox | Self::OpenH264 => "yuv420p",
            Self::MediaFoundation | Self::Vaapi { .. } => "nv12",
        }
    }

    pub fn hardware_upload(&self) -> bool {
        matches!(self, Self::Vaapi { .. })
    }
}

/// The encoders to try, in order, for one platform. `vaapi` is the device and
/// profile the recording path's probe accepted, when it did.
pub fn encoder_chain(
    platform: RenderPlatform,
    vaapi: Option<(PathBuf, LinuxVaapiArgProfile)>,
) -> Vec<RenderEncoder> {
    match platform {
        RenderPlatform::Macos => vec![RenderEncoder::VideoToolbox],
        RenderPlatform::Windows => vec![RenderEncoder::MediaFoundation, RenderEncoder::OpenH264],
        RenderPlatform::Linux => {
            let mut chain = Vec::new();
            if let Some((device, profile)) = vaapi {
                chain.push(RenderEncoder::Vaapi { device, profile });
            }
            chain.push(RenderEncoder::OpenH264);
            chain
        }
    }
}

/// Filters every render uses; `hwupload` joins them for VAAPI.
pub const REQUIRED_FILTERS: [&str; 9] = [
    "split", "trim", "setpts", "asplit", "atrim", "asetpts", "afade", "concat", "format",
];

/// The second whitespace-separated token of every line: the name column of
/// `ffmpeg -filters` (` .. trim  V->V ...`) and `ffmpeg -encoders`
/// (` V....D h264_videotoolbox ...`).
pub fn listed_names(output: &str) -> HashSet<String> {
    output
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .map(str::to_string)
        .collect()
}

/// The capability gaps of one FFmpeg for this render: `filter:<name>` and
/// `encoder:<name>` entries. The video encoders of `chain` are assessed
/// together: only when none of them is present is the chain a gap.
pub fn missing_capabilities(
    filters_output: &str,
    encoders_output: &str,
    chain: &[RenderEncoder],
) -> Vec<String> {
    let filters = listed_names(filters_output);
    let encoders = listed_names(encoders_output);
    let mut missing: Vec<String> = REQUIRED_FILTERS
        .iter()
        .filter(|name| !filters.contains(**name))
        .map(|name| format!("filter:{name}"))
        .collect();
    if chain
        .iter()
        .any(|encoder| encoder.hardware_upload() && !filters.contains("hwupload"))
    {
        missing.push("filter:hwupload".to_string());
    }
    if !encoders.contains("aac") {
        missing.push("encoder:aac".to_string());
    }
    if !chain.is_empty()
        && !chain
            .iter()
            .any(|encoder| encoders.contains(encoder.codec()))
    {
        missing.push(format!(
            "encoder:{}",
            chain
                .iter()
                .map(RenderEncoder::codec)
                .collect::<Vec<_>>()
                .join("|")
        ));
    }
    missing
}

/// The encoders of `chain` this FFmpeg lists, in chain order.
pub fn available_encoders(encoders_output: &str, chain: &[RenderEncoder]) -> Vec<RenderEncoder> {
    let encoders = listed_names(encoders_output);
    chain
        .iter()
        .filter(|encoder| encoders.contains(encoder.codec()))
        .cloned()
        .collect()
}

fn ffmpeg_listing(ffmpeg_path: &str, flag: &str) -> Result<String, JobFailure> {
    let mut command = Command::new(ffmpeg_path);
    command.args(["-hide_banner", flag]);
    let output =
        output_owned_std_with_timeout(&mut command, CAPABILITY_TIMEOUT).map_err(|error| {
            JobFailure::new(
                ERROR_FFMPEG_UNSUPPORTED,
                format!("Could not ask the bundled FFmpeg for its capabilities: {error}"),
            )
        })?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// Like Noise Cleanup's `require_ffmpeg_capabilities`: the job fails with
/// `ffmpeg-unsupported` naming the gap instead of FFmpeg failing mid-render.
/// Returns the encoders of `chain` that are actually present.
fn require_render_capabilities(
    ffmpeg_path: &str,
    chain: &[RenderEncoder],
) -> Result<Vec<RenderEncoder>, JobFailure> {
    let filters = ffmpeg_listing(ffmpeg_path, "-filters")?;
    let encoders = ffmpeg_listing(ffmpeg_path, "-encoders")?;
    let missing = missing_capabilities(&filters, &encoders, chain);
    if !missing.is_empty() {
        return Err(JobFailure::new(
            ERROR_FFMPEG_UNSUPPORTED,
            format!(
                "The bundled FFmpeg cannot render a clean cut (missing {}).",
                missing.join(", ")
            ),
        ));
    }
    Ok(available_encoders(&encoders, chain))
}

/// libopenh264 threads across slices only; four is the measured cap
/// (`recording.rs`).
pub fn openh264_slices(parallelism: usize) -> usize {
    parallelism.clamp(1, 4)
}

/// The whole FFmpeg command line for one encoder, minus the binary.
#[allow(clippy::too_many_arguments)]
pub fn build_render_args(
    source: &Path,
    staging: &Path,
    graph: &GraphArgument,
    labels: &FilterGraph,
    encoder: &RenderEncoder,
    probe: &RenderProbe,
    software_slices: usize,
) -> Vec<String> {
    let frame_rate = probe.video.frame_rate;
    let fps = (frame_rate.num + frame_rate.den / 2) / frame_rate.den.max(1);
    let kbps = video_bitrate_kbps(probe);
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostats".into(),
    ];
    if let RenderEncoder::Vaapi { device, .. } = encoder {
        args.extend(["-vaapi_device".to_string(), device.display().to_string()]);
    }
    args.extend(["-i".to_string(), source.display().to_string()]);
    match graph {
        GraphArgument::Inline(text) => args.extend(["-filter_complex".to_string(), text.clone()]),
        GraphArgument::ScriptFile(path) => {
            args.extend(["-/filter_complex".to_string(), path.display().to_string()])
        }
    }
    args.extend(["-map".to_string(), format!("[{}]", labels.video_label)]);
    for label in &labels.audio_labels {
        args.extend(["-map".to_string(), format!("[{label}]")]);
    }
    args.extend(["-c:v".to_string(), encoder.codec().to_string()]);
    let level = h264_high_level_label(probe.video.width, probe.video.height, fps.max(1));
    match encoder {
        RenderEncoder::VideoToolbox => {
            // Offline: no `-realtime`, no speed priority; VideoToolbox spends
            // its headroom on quality. `-allow_sw` keeps machines without the
            // hardware encoder rendering.
            args.extend(["-allow_sw".to_string(), "1".to_string()]);
            if let Some(level) = level {
                args.extend([
                    "-profile:v".to_string(),
                    "high".to_string(),
                    "-level".to_string(),
                    level.to_string(),
                ]);
            }
        }
        RenderEncoder::MediaFoundation => {
            // Media Foundation exposes neither profile nor level; the archive
            // scenario with unconstrained VBR is the file-render posture.
            args.extend([
                "-hw_encoding".to_string(),
                "1".to_string(),
                "-rate_control".to_string(),
                "u_vbr".to_string(),
                "-scenario".to_string(),
                "archive".to_string(),
            ]);
        }
        RenderEncoder::OpenH264 => {
            // Never skip a frame: the frame count must equal the kept frames.
            let slices = software_slices.max(1).to_string();
            args.extend([
                "-rc_mode".to_string(),
                "bitrate".to_string(),
                "-allow_skip_frames".to_string(),
                "0".to_string(),
                "-threads".to_string(),
                slices.clone(),
                "-slices".to_string(),
                slices,
            ]);
            if let Some(level) = level {
                args.extend([
                    "-profile:v".to_string(),
                    "high".to_string(),
                    "-level".to_string(),
                    level.to_string(),
                ]);
            }
        }
        RenderEncoder::Vaapi { profile, .. } => {
            // No B-frames on any VAAPI session (`recording.rs`); the compat
            // profile is constant bitrate.
            let rc_mode = match profile {
                LinuxVaapiArgProfile::Standard => "VBR",
                LinuxVaapiArgProfile::Compat => "CBR",
            };
            args.extend([
                "-rc_mode".to_string(),
                rc_mode.to_string(),
                "-bf".to_string(),
                "0".to_string(),
            ]);
            if let Some(level) = level {
                args.extend([
                    "-profile:v".to_string(),
                    "high".to_string(),
                    "-level".to_string(),
                    h264_vaapi_level_arg(level),
                ]);
            }
        }
    }
    args.extend([
        "-b:v".to_string(),
        format!("{kbps}k"),
        "-maxrate".to_string(),
        format!("{kbps}k"),
        "-bufsize".to_string(),
        format!("{}k", kbps.saturating_mul(2)),
        "-g".to_string(),
        fps.max(1).saturating_mul(2).to_string(),
        "-colorspace".to_string(),
        "bt709".to_string(),
        "-color_primaries".to_string(),
        "bt709".to_string(),
        "-color_trc".to_string(),
        "bt709".to_string(),
        "-color_range".to_string(),
        "tv".to_string(),
    ]);
    // VideoToolbox builds the VUI from the frames; the others need the SPS
    // rewritten so ffprobe reports BT.709 (`recording.rs`).
    if !matches!(encoder, RenderEncoder::VideoToolbox) {
        args.extend([
            "-bsf:v".to_string(),
            "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"
                .to_string(),
        ]);
    }
    args.extend([
        "-fps_mode".to_string(),
        "cfr".to_string(),
        "-r".to_string(),
        format!("{}/{}", frame_rate.num, frame_rate.den),
    ]);
    for (track, info) in probe.audio.iter().enumerate() {
        args.extend([
            format!("-c:a:{track}"),
            "aac".to_string(),
            format!("-b:a:{track}"),
            format!("{}k", audio_bitrate_kbps(info)),
            format!("-ar:a:{track}"),
            info.sample_rate.to_string(),
        ]);
    }
    args.extend([
        "-movflags".to_string(),
        "+faststart".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        staging.display().to_string(),
    ]);
    args
}

/// `out_time_us=…` (FFmpeg also spells it `out_time_ms`, in microseconds) as
/// a share of the kept duration, held under 1 until the file is validated.
pub fn progress_fraction(line: &str, kept_duration_ms: u64) -> Option<f64> {
    let (key, value) = line.trim().split_once('=')?;
    if !matches!(key, "out_time_us" | "out_time_ms") || kept_duration_ms == 0 {
        return None;
    }
    let micros = value.trim().parse::<f64>().ok()?;
    if !micros.is_finite() || micros < 0.0 {
        return None;
    }
    Some(((micros / 1_000.0) / kept_duration_ms as f64).clamp(0.0, 0.99))
}

// --- Validation -------------------------------------------------------------------

/// Decision 17: the output must carry the source's stream counts, dimensions
/// and frame rate, and its video and every audio track must last the kept
/// duration within `RENDER_DURATION_TOLERANCE_FRAMES`.
pub fn validate_output(
    source: &RenderProbe,
    output: &RenderProbe,
    kept_frames: u64,
) -> Result<(), String> {
    let frame_rate = source.video.frame_rate;
    if output.video.frame_rate != frame_rate {
        return Err(format!(
            "frame rate {}/{} instead of {}/{}",
            output.video.frame_rate.num,
            output.video.frame_rate.den,
            frame_rate.num,
            frame_rate.den
        ));
    }
    if (output.video.width, output.video.height) != (source.video.width, source.video.height) {
        return Err(format!(
            "size {}x{} instead of {}x{}",
            output.video.width, output.video.height, source.video.width, source.video.height
        ));
    }
    if output.audio.len() != source.audio.len() {
        return Err(format!(
            "{} audio track(s) instead of {}",
            output.audio.len(),
            source.audio.len()
        ));
    }
    let kept_ms = frame_to_ms(kept_frames, frame_rate);
    let tolerance_ms = frame_to_ms(RENDER_DURATION_TOLERANCE_FRAMES, frame_rate).max(1) + 1;
    if let Some(frames) = output.video.nb_frames
        && frames.abs_diff(kept_frames) > RENDER_DURATION_TOLERANCE_FRAMES
    {
        return Err(format!("{frames} video frames instead of {kept_frames}"));
    }
    let video_ms = output
        .video
        .duration_ms
        .or_else(|| {
            output
                .video
                .nb_frames
                .map(|frames| frame_to_ms(frames, frame_rate))
        })
        .or(output.format_duration_ms)
        .ok_or_else(|| "the output has no video duration".to_string())?;
    if video_ms.abs_diff(kept_ms) > tolerance_ms {
        return Err(format!(
            "video lasts {video_ms} ms instead of the kept {kept_ms} ms"
        ));
    }
    for (track, info) in output.audio.iter().enumerate() {
        let audio_ms = info
            .duration_ms
            .or(output.format_duration_ms)
            .ok_or_else(|| format!("audio track {track} has no duration"))?;
        if audio_ms.abs_diff(kept_ms) > tolerance_ms {
            return Err(format!(
                "audio track {track} lasts {audio_ms} ms instead of the kept {kept_ms} ms"
            ));
        }
    }
    Ok(())
}

// --- Names, space, records ----------------------------------------------------------

pub fn output_suffix(mode: CleanCutMode) -> &'static str {
    match mode {
        CleanCutMode::Clean => " (Clean cut)",
        CleanCutMode::Condensed => " (Condensed)",
    }
}

pub fn output_title(source_title: &str, mode: CleanCutMode) -> String {
    format!("{}{}", source_title.trim(), output_suffix(mode))
}

/// `"<source stem> (Clean cut).mp4"` next to the source; ` 2`, ` 3`, ... when
/// that name is taken by a file the Library does not own for this cut.
pub fn output_path_for(
    source: &Path,
    mode: CleanCutMode,
    mut is_taken: impl FnMut(&Path) -> bool,
) -> Option<PathBuf> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Recording");
    let suffix = output_suffix(mode);
    (0..10_000_u32)
        .map(|attempt| {
            if attempt == 0 {
                source.with_file_name(format!("{stem}{suffix}.mp4"))
            } else {
                source.with_file_name(format!("{stem}{suffix} {}.mp4", attempt + 1))
            }
        })
        .find(|candidate| !is_taken(candidate))
}

/// `.<stem>.<job id>.videorc-partial.mp4` next to the destination.
pub fn staging_path_for(destination: &Path, job_id: &str) -> PathBuf {
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    destination.with_file_name(format!(".{stem}.{job_id}.{STAGING_MARKER}.mp4"))
}

/// Free space the render needs: `RENDER_FREE_SPACE_TENTHS / 10` of the source.
pub fn required_free_space(source_size: u64) -> u64 {
    source_size.saturating_mul(RENDER_FREE_SPACE_TENTHS) / 10
}

/// `clean_cut_jobs.render_json`: where this job writes and publishes, kept
/// on Clean cut's own row so startup can sweep a stray partial file without
/// touching the shared Library journal (see `complete_clean_cut_derivative`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderRecord {
    pub version: u32,
    pub staging_path: String,
    pub final_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_session_id: Option<String>,
    pub revision: u32,
}

impl RenderRecord {
    pub fn from_persisted(persisted: &PersistedCleanCutJob) -> Option<Self> {
        persisted
            .render_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<RenderRecord>(json).ok())
            .filter(|record| record.version == RENDER_RECORD_VERSION)
    }
}

/// Startup: a partial file a dead process left behind is removed; the
/// requeued render writes a fresh one. Best effort.
pub fn remove_stale_staging(record: &RenderRecord) {
    let staging = Path::new(&record.staging_path);
    if staging
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains(STAGING_MARKER))
    {
        let _ = std::fs::remove_file(staging);
        let _ = std::fs::remove_file(staging.with_extension("filtergraph.txt"));
    }
}

// --- The phase ------------------------------------------------------------------------

/// How a render turn ended when it did not fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderOutcome {
    Published {
        output_session_id: String,
        output_path: PathBuf,
        duration_ms: i64,
    },
    /// The cut list changed while this revision rendered: render again.
    Superseded,
    /// The recording no longer matches the cut list: rebuild from the
    /// transcript.
    SourceChanged,
}

enum RenderRun {
    Finished,
    Interrupted,
    Failed(String),
}

fn processing(message: impl Into<String>) -> JobFailure {
    JobFailure::new(ERROR_PROCESSING, message)
}

fn probe_file(ffprobe_path: &str, path: &Path) -> Result<RenderProbe, String> {
    let mut command = Command::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        &path.display().to_string(),
    ]);
    let output = output_owned_std_with_timeout(&mut command, PROBE_TIMEOUT)
        .map_err(|error| format!("could not run ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_render_probe(&String::from_utf8_lossy(&output.stdout))
}

/// Run FFmpeg through an owned child, forwarding `-progress` as job progress
/// and killing it on cancel, shutdown or a waiting capture.
fn run_render_ffmpeg(
    state: &AppState,
    mut snapshot: PersistedCleanCutJob,
    ffmpeg_path: &str,
    args: &[String],
    kept_duration_ms: u64,
    is_interrupted: &dyn Fn() -> bool,
) -> RenderRun {
    let mut command = Command::new(ffmpeg_path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match spawn_owned_std(&mut command) {
        Ok(child) => child,
        Err(error) => return RenderRun::Failed(format!("Could not start FFmpeg: {error}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (progress_tx, progress_rx) = std::sync::mpsc::channel::<String>();
    let stdout_reader = thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = progress_tx.send(line);
            }
        }
    });
    let stderr_reader = thread::spawn(move || read_bounded_tail(stderr));
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_progress = 0.0_f64;
    let status = loop {
        if is_interrupted() {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        while let Ok(line) = progress_rx.try_recv() {
            if let Some(progress) = progress_fraction(&line, kept_duration_ms)
                && progress > last_progress
                && last_emit.elapsed() >= Duration::from_millis(RENDER_PROGRESS_INTERVAL_MS)
            {
                last_progress = progress;
                last_emit = Instant::now();
                set_job_state(
                    state,
                    &mut snapshot,
                    CleanCutJobState::Rendering,
                    Some("render"),
                    progress,
                );
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return RenderRun::Failed(format!("Could not wait for FFmpeg: {error}"));
            }
        }
    };
    let _ = stdout_reader.join();
    let tail = stderr_reader.join().unwrap_or_default();
    match status {
        None => RenderRun::Interrupted,
        Some(status) if status.success() => RenderRun::Finished,
        Some(status) => RenderRun::Failed(format!(
            "FFmpeg exited with {status}: {}",
            String::from_utf8_lossy(&tail).trim()
        )),
    }
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

/// `ready → rendering → validating → completed`, with the slot held by the
/// caller. `persisted` is the row as the caller read it after taking the
/// slot; it is kept in step with the database and the status event.
pub async fn render_phase(
    state: &AppState,
    control: &Arc<JobControl>,
    maintenance: &MaintenanceCancelToken,
    persisted: &mut PersistedCleanCutJob,
    edl: CleanCutEdl,
) -> PhaseOutcome<RenderOutcome> {
    let job_id = persisted.job.id.clone();
    let revision = persisted.job.edl_revision;
    let mode = persisted.job.mode;
    let source_session_id = persisted.job.source_session_id.clone();
    persisted.job.error_code = None;
    persisted.job.error_message = None;
    set_job_state(
        state,
        persisted,
        CleanCutJobState::Rendering,
        Some("render"),
        0.0,
    );
    let interrupts = Interrupts {
        control: control.as_ref(),
        maintenance: Some(maintenance),
    };

    // The source row and file, as the cut list described them.
    let source = match state.database.clean_cut_source(&source_session_id) {
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
    match capture_source_identity(&source_path) {
        Ok(identity) if identity == edl.source_identity => {}
        Ok(_) => return PhaseOutcome::Done(RenderOutcome::SourceChanged),
        Err(error) => {
            return PhaseOutcome::Failed(JobFailure::new(
                ERROR_FILE_MISSING,
                format!("The recording file could not be read: {error}"),
            ));
        }
    }

    // What stays.
    let ranges = kept_ranges(&edl);
    if ranges.is_empty() {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_RENDER_INVALID,
            "Every frame is removed; there is nothing to render.",
        ));
    }
    if ranges.len() > RENDER_MAX_KEPT_RANGES {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_RENDER_TOO_MANY_CUTS,
            format!(
                "This cut list keeps {} separate pieces; one render carries at most {RENDER_MAX_KEPT_RANGES}. Turn off a kind of cut, such as Silences, and render again.",
                ranges.len(),
            ),
        ));
    }
    let kept_frames_total = kept_frames(&ranges);
    let kept_ms = frame_to_ms(kept_frames_total, edl.frame_rate);

    // Probe the source, check the bundled FFmpeg, pick the encoders.
    let ffmpeg_path = default_ffmpeg_path();
    let ffprobe_path = ffprobe_path_for(&ffmpeg_path);
    let Some(platform) = current_render_platform() else {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_FFMPEG_UNSUPPORTED,
            "Clean cut cannot render on this platform.",
        ));
    };
    let decision = crate::recording::background_h264_encode_decision(&ffmpeg_path).await;
    let chain = encoder_chain(
        platform,
        decision
            .vaapi_device
            .map(|device| (device, decision.vaapi_arg_profile)),
    );
    let prepared = {
        let (ffmpeg, ffprobe, path, chain) = (
            ffmpeg_path.clone(),
            ffprobe_path.clone(),
            source_path.clone(),
            chain.clone(),
        );
        tokio::task::spawn_blocking(
            move || -> Result<(RenderProbe, Vec<RenderEncoder>), JobFailure> {
                let probe = probe_file(&ffprobe, &path).map_err(|error| {
                    JobFailure::new(
                        ERROR_PROBE,
                        format!("Could not read the recording: {error}"),
                    )
                })?;
                let encoders = require_render_capabilities(&ffmpeg, &chain)?;
                Ok((probe, encoders))
            },
        )
        .await
    };
    let (probe, encoders) = match prepared {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(failure)) => return PhaseOutcome::Failed(failure),
        Err(error) => {
            return PhaseOutcome::Failed(processing(format!("The probe task failed: {error}")));
        }
    };
    if let Some(outcome) = interrupts.check() {
        return outcome;
    }
    if probe.video.frame_rate != edl.frame_rate {
        // Same bytes, different grid: the cut list cannot be trusted and a
        // rebuild would reach the same grid, so this is a plain failure.
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_RENDER_INVALID,
            format!(
                "The recording's frame rate ({}/{}) does not match the cut list ({}/{}). Start Clean cut again.",
                probe.video.frame_rate.num,
                probe.video.frame_rate.den,
                edl.frame_rate.num,
                edl.frame_rate.den
            ),
        ));
    }

    // Where it goes: the derived row an earlier render published, else a
    // fresh name next to the source.
    let adopted = match state
        .database
        .clean_cut_adoptable_output(&source_session_id, mode)
    {
        Ok(adopted) => adopted,
        Err(error) => {
            return PhaseOutcome::Failed(processing(format!(
                "Could not look up the earlier clean cut: {error}"
            )));
        }
    };
    let fresh_destination = |state: &AppState| {
        output_path_for(&source_path, mode, |candidate| {
            candidate.exists()
                || state
                    .database
                    .session_media_path_registered(&candidate.display().to_string())
                    .unwrap_or(true)
        })
    };
    let (output_session_id, destination) = match adopted {
        Some((id, Some(path)))
            if Path::new(&path).parent() == source_path.parent()
                && Path::new(&path)
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4")) =>
        {
            (id, PathBuf::from(path))
        }
        Some((id, _)) => match fresh_destination(state) {
            Some(path) => (id, path),
            None => {
                return PhaseOutcome::Failed(processing(
                    "Could not find a free name for the clean cut.",
                ));
            }
        },
        None => match fresh_destination(state) {
            Some(path) => (uuid::Uuid::new_v4().to_string(), path),
            None => {
                return PhaseOutcome::Failed(processing(
                    "Could not find a free name for the clean cut.",
                ));
            }
        },
    };
    let staging = staging_path_for(&destination, &job_id);
    let script_path = staging.with_extension("filtergraph.txt");
    let _ = std::fs::remove_file(&staging);
    let _ = std::fs::remove_file(&script_path);

    // Room for it.
    let source_size = file_size(&source_path).unwrap_or(edl.source_identity.size_bytes);
    if let Some(parent) = destination.parent()
        && let Some(available) = crate::noise_cleanup::available_space(parent)
        && available < required_free_space(source_size)
    {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_INSUFFICIENT_SPACE,
            format!(
                "Not enough free space for the clean cut: it needs about {} MB free next to the recording.",
                required_free_space(source_size) / (1024 * 1024)
            ),
        ));
    }

    // Record the render before the first byte is written.
    let record = RenderRecord {
        version: RENDER_RECORD_VERSION,
        staging_path: staging.display().to_string(),
        final_path: destination.display().to_string(),
        output_session_id: Some(output_session_id.clone()),
        revision,
    };
    persisted.render_json = serde_json::to_string(&record).ok();
    persist_and_emit(state, persisted);

    // One pass per encoder until one succeeds.
    let slices =
        openh264_slices(std::thread::available_parallelism().map_or(1, |count| count.get()));
    let mut succeeded = None;
    let mut last_failure: Option<String> = None;
    for encoder in &encoders {
        let graph = build_filter_graph(
            &ranges,
            edl.frame_rate,
            &probe.audio,
            JOIN_FADE_MS,
            encoder.pixel_format(),
            encoder.hardware_upload(),
        );
        let argument = if graph_needs_script(&graph.text) {
            if let Err(error) = std::fs::write(&script_path, &graph.text) {
                return PhaseOutcome::Failed(processing(format!(
                    "Could not write the filter graph: {error}"
                )));
            }
            GraphArgument::ScriptFile(script_path.clone())
        } else {
            GraphArgument::Inline(graph.text.clone())
        };
        let args = build_render_args(
            &source_path,
            &staging,
            &argument,
            &graph,
            encoder,
            &probe,
            slices,
        );
        let run = {
            let (state, snapshot, ffmpeg) = (state.clone(), persisted.clone(), ffmpeg_path.clone());
            let (control, maintenance) = (control.clone(), maintenance.clone());
            tokio::task::spawn_blocking(move || {
                let interrupted = move || control.should_interrupt() || maintenance.is_cancelled();
                run_render_ffmpeg(&state, snapshot, &ffmpeg, &args, kept_ms, &interrupted)
            })
            .await
        };
        let _ = std::fs::remove_file(&script_path);
        match run {
            Ok(RenderRun::Finished) => {
                succeeded = Some(encoder.clone());
                break;
            }
            Ok(RenderRun::Interrupted) => {
                let _ = std::fs::remove_file(&staging);
                return interrupts.check().unwrap_or(PhaseOutcome::CapturePreempted);
            }
            Ok(RenderRun::Failed(detail)) => {
                let _ = std::fs::remove_file(&staging);
                state.emit_log(
                    "warn",
                    format!(
                        "Clean cut render with {} failed for {source_session_id}: {detail}",
                        encoder.codec(),
                    ),
                );
                last_failure = Some(format!("{}: {detail}", encoder.codec()));
            }
            Err(error) => {
                let _ = std::fs::remove_file(&staging);
                return PhaseOutcome::Failed(processing(format!(
                    "The render task failed: {error}"
                )));
            }
        }
    }
    let Some(encoder) = succeeded else {
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_RENDER_FAILED,
            format!(
                "FFmpeg could not render the clean cut ({}).",
                last_failure.unwrap_or_else(|| "no usable encoder".to_string())
            ),
        ));
    };

    // Validate before anything is published.
    set_job_state(
        state,
        persisted,
        CleanCutJobState::Validating,
        Some("validate"),
        0.99,
    );
    let output_probe = {
        let (ffprobe, path) = (ffprobe_path.clone(), staging.clone());
        tokio::task::spawn_blocking(move || probe_file(&ffprobe, &path)).await
    };
    let output_probe = match output_probe {
        Ok(Ok(probe)) => probe,
        Ok(Err(error)) => {
            let _ = std::fs::remove_file(&staging);
            return PhaseOutcome::Failed(JobFailure::new(
                ERROR_RENDER_INVALID,
                format!("The rendered file could not be read back: {error}"),
            ));
        }
        Err(error) => {
            let _ = std::fs::remove_file(&staging);
            return PhaseOutcome::Failed(processing(format!("The probe task failed: {error}")));
        }
    };
    if let Err(reason) = validate_output(&probe, &output_probe, kept_frames_total) {
        let _ = std::fs::remove_file(&staging);
        return PhaseOutcome::Failed(JobFailure::new(
            ERROR_RENDER_INVALID,
            format!("The rendered file did not check out ({reason}). Render again."),
        ));
    }
    // The source must still be what the cut list describes, and the list
    // must still be the revision that was rendered.
    match capture_source_identity(&source_path) {
        Ok(identity) if identity == edl.source_identity => {}
        _ => {
            let _ = std::fs::remove_file(&staging);
            return PhaseOutcome::Done(RenderOutcome::SourceChanged);
        }
    }
    match state.database.clean_cut_job(&job_id) {
        Ok(Some(current)) if current.job.edl_revision == revision => {}
        Ok(Some(_)) => {
            let _ = std::fs::remove_file(&staging);
            return PhaseOutcome::Done(RenderOutcome::Superseded);
        }
        Ok(None) | Err(_) => {
            let _ = std::fs::remove_file(&staging);
            return PhaseOutcome::Failed(processing("The Clean cut job disappeared."));
        }
    }
    if let Some(outcome) = interrupts.check() {
        let _ = std::fs::remove_file(&staging);
        return outcome;
    }

    // Publish: flush, rename over the final name, write the SRT beside it.
    if let Err(error) = OpenOptions::new()
        .read(true)
        .open(&staging)
        .and_then(|file| file.sync_all())
        .and_then(|()| replace_file(&staging, &destination))
    {
        let _ = std::fs::remove_file(&staging);
        return PhaseOutcome::Failed(processing(format!(
            "Could not publish the clean cut: {error}"
        )));
    }
    let _ = crate::session_ops::sync_session_file_parent(&destination);
    match write_retimed_srt(
        &source_path,
        &destination,
        persisted.job.transcript_path.as_deref(),
        &ranges,
        edl.frame_rate,
    ) {
        Ok(_) => {}
        Err(error) => state.emit_log(
            "warn",
            format!(
                "Clean cut could not write the re-timed captions for {}: {error}",
                destination.display()
            ),
        ),
    }

    // The derived row, in one transaction with the job's completion.
    let title = output_title(&source.title, mode);
    let size = i64::try_from(file_size(&destination).unwrap_or(0)).unwrap_or(i64::MAX);
    let duration_ms = i64::try_from(kept_ms).unwrap_or(i64::MAX);
    match state.database.complete_clean_cut_derivative(
        &job_id,
        &source_session_id,
        &output_session_id,
        &title,
        &source.title,
        &destination.display().to_string(),
        Some(duration_ms),
        size,
    ) {
        Ok(true) => {
            if let Ok(Some(fresh)) = state.database.clean_cut_job(&job_id) {
                *persisted = fresh;
            }
            state.emit_event(EVENT_STATUS, &persisted.job);
            state.emit_log(
                "info",
                format!(
                    "Clean cut rendered {source_session_id} with {} into {} ({kept_ms} ms kept).",
                    encoder.codec(),
                    destination.display(),
                ),
            );
            PhaseOutcome::Done(RenderOutcome::Published {
                output_session_id,
                output_path: destination,
                duration_ms,
            })
        }
        Ok(false) => {
            let _ = std::fs::remove_file(&destination);
            let _ = std::fs::remove_file(destination.with_extension("srt"));
            PhaseOutcome::Failed(JobFailure::new(
                ERROR_FILE_MISSING,
                "The recording is no longer in the Library.",
            ))
        }
        Err(error) => {
            PhaseOutcome::Failed(processing(format!("Could not save the clean cut: {error}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CleanCutRemoval, CleanCutRemovalKind, CleanCutSourceIdentity};

    const FPS30: CleanCutFrameRate = CleanCutFrameRate { num: 30, den: 1 };
    const NTSC: CleanCutFrameRate = CleanCutFrameRate {
        num: 30_000,
        den: 1_001,
    };

    fn removal(id: &str, start_frame: u64, end_frame: u64, enabled: bool) -> CleanCutRemoval {
        CleanCutRemoval {
            id: id.to_string(),
            start_ms: frame_to_ms(start_frame, FPS30),
            end_ms: frame_to_ms(end_frame, FPS30),
            start_frame,
            end_frame,
            kind: CleanCutRemovalKind::Silence,
            reason: String::new(),
            confidence: None,
            enabled,
        }
    }

    fn edl_with(
        removals: Vec<CleanCutRemoval>,
        duration_ms: u64,
        frame_rate: CleanCutFrameRate,
    ) -> CleanCutEdl {
        CleanCutEdl {
            version: 1,
            source_identity: CleanCutSourceIdentity {
                path: "talk.mp4".to_string(),
                size_bytes: 1,
                modified_unix_ms: None,
            },
            frame_rate,
            duration_ms,
            removals,
            stats: crate::protocol::CleanCutEdlStats {
                by_kind: Vec::new(),
                kept_ms: 0,
            },
        }
    }

    fn audio(sample_rate: u32) -> RenderAudioInfo {
        RenderAudioInfo {
            codec: "aac".to_string(),
            sample_rate,
            channels: 2,
            bit_rate: Some(160_000),
            duration_ms: None,
        }
    }

    fn probe_1080p30(audio_tracks: usize) -> RenderProbe {
        RenderProbe {
            video: RenderVideoInfo {
                codec: "h264".to_string(),
                width: 1920,
                height: 1080,
                frame_rate: FPS30,
                bit_rate: Some(6_000_000),
                nb_frames: Some(1_800),
                duration_ms: Some(60_000),
            },
            audio: (0..audio_tracks).map(|_| audio(48_000)).collect(),
            format_duration_ms: Some(60_000),
            format_bit_rate: Some(6_200_000),
        }
    }

    #[test]
    fn kept_ranges_are_the_complement_of_enabled_removals_in_frames() {
        let edl = edl_with(
            vec![
                removal("r1", 0, 30, true),
                removal("r2", 300, 330, true),
                removal("r3", 320, 400, true),
                removal("r4", 500, 600, false),
                removal("r5", 1_770, 1_800, true),
            ],
            60_000,
            FPS30,
        );
        let ranges = kept_ranges(&edl);
        assert_eq!(
            ranges,
            vec![
                KeptRange {
                    start_frame: 30,
                    end_frame: 300
                },
                KeptRange {
                    start_frame: 400,
                    end_frame: 1_770
                },
            ],
            "overlapping removals merge, disabled suggestions do not cut, head and tail vanish"
        );
        assert_eq!(kept_frames(&ranges), 1_800 - 30 - 100 - 30);
        assert_eq!(
            kept_ranges(&edl_with(Vec::new(), 60_000, FPS30)),
            vec![KeptRange {
                start_frame: 0,
                end_frame: 1_800
            }]
        );
        assert!(
            kept_ranges(&edl_with(
                vec![removal("all", 0, 1_800, true)],
                60_000,
                FPS30
            ))
            .is_empty()
        );
        // A removal past the end is clamped to the recording.
        assert_eq!(
            kept_ranges(&edl_with(
                vec![removal("late", 1_700, 9_999, true)],
                60_000,
                FPS30
            )),
            vec![KeptRange {
                start_frame: 0,
                end_frame: 1_700
            }]
        );
    }

    #[test]
    fn audio_segments_total_exactly_the_kept_duration_over_500_cuts() {
        // 500 kept slivers of 7 frames on the NTSC grid at 48 kHz: the
        // sample-exact boundary of 7 frames is 11 211.2 samples, so a naive
        // per-cut rounding drifts by up to 0.5 samples per boundary.
        let ranges: Vec<KeptRange> = (0..500)
            .map(|index| KeptRange {
                start_frame: index * 100,
                end_frame: index * 100 + 7,
            })
            .collect();
        let segments = audio_segments(&ranges, NTSC, 48_000);
        assert_eq!(segments.len(), 500);
        let total_samples: u64 = segments
            .iter()
            .map(|segment| segment.end_sample - segment.start_sample)
            .sum();
        let kept = kept_frames(&ranges);
        assert_eq!(kept, 3_500);
        assert_eq!(
            total_samples,
            frame_to_sample(kept, NTSC, 48_000),
            "the sum telescopes to the exact total"
        );
        assert_eq!(frame_to_sample(kept, NTSC, 48_000), 5_605_600);
        for (segment, range) in segments.iter().zip(&ranges) {
            assert_eq!(
                segment.start_sample,
                frame_to_sample(range.start_frame, NTSC, 48_000),
                "every start is the nearest sample to its frame boundary"
            );
            let exact_end = frame_to_sample(range.end_frame, NTSC, 48_000);
            assert!(
                segment.end_sample.abs_diff(exact_end) <= 1,
                "an end sits within one sample of the true boundary"
            );
        }
        // Whole-sample grids are exact at every boundary.
        let even = audio_segments(&ranges, FPS30, 48_000);
        for (segment, range) in even.iter().zip(&ranges) {
            assert_eq!(segment.start_sample, range.start_frame * 1_600);
            assert_eq!(segment.end_sample, range.end_frame * 1_600);
        }
        assert_eq!(frame_to_sample(1, NTSC, 48_000), 1_602, "1601.6 rounds up");
        assert_eq!(frame_to_sample(0, NTSC, 48_000), 0);
    }

    #[test]
    fn the_filter_graph_trims_by_frame_fades_only_at_internal_joins_and_concats_every_track() {
        let ranges = vec![
            KeptRange {
                start_frame: 30,
                end_frame: 300,
            },
            KeptRange {
                start_frame: 400,
                end_frame: 1_770,
            },
            KeptRange {
                start_frame: 1_780,
                end_frame: 1_800,
            },
        ];
        let graph = build_filter_graph(
            &ranges,
            FPS30,
            &[audio(48_000), audio(44_100)],
            10,
            "yuv420p",
            false,
        );
        let chains: Vec<&str> = graph.text.split(';').collect();
        assert_eq!(chains[0], "[0:v]split=3[v0][v1][v2]");
        assert_eq!(
            chains[1],
            "[v0]trim=start_frame=30:end_frame=300,setpts=PTS-STARTPTS[tv0]"
        );
        assert_eq!(
            chains[3],
            "[v2]trim=start_frame=1780:end_frame=1800,setpts=PTS-STARTPTS[tv2]"
        );
        assert_eq!(chains[4], "[0:a:0]asplit=3[a0_0][a0_1][a0_2]");
        // First segment: no fade in, a fade out at the join.
        assert_eq!(
            chains[5],
            "[a0_0]atrim=start_sample=48000:end_sample=480000,asetpts=PTS-STARTPTS,afade=t=out:st=8.990000:d=0.010[ta0_0]"
        );
        // Middle segment: both fades.
        assert!(chains[6].starts_with(
            "[a0_1]atrim=start_sample=640000:end_sample=2832000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.010,afade=t=out:st="
        ));
        // Last segment: a fade in only.
        assert_eq!(
            chains[7],
            "[a0_2]atrim=start_sample=2848000:end_sample=2880000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.010[ta0_2]"
        );
        assert_eq!(chains[8], "[0:a:1]asplit=3[a1_0][a1_1][a1_2]");
        assert!(chains[9].starts_with("[a1_0]atrim=start_sample=44100:end_sample=441000,"));
        assert_eq!(
            chains[12],
            "[tv0][ta0_0][ta1_0][tv1][ta0_1][ta1_1][tv2][ta0_2][ta1_2]concat=n=3:v=1:a=2[cv][ca0][ca1]"
        );
        assert_eq!(chains[13], "[cv]format=yuv420p[outv]");
        assert_eq!(chains.len(), 14);
        assert_eq!(graph.video_label, "outv");
        assert_eq!(graph.audio_labels, vec!["ca0", "ca1"]);
        assert_eq!(
            graph.text.matches("afade").count(),
            8,
            "two tracks, two internal joins, a fade on each side of each join"
        );

        // One range: no split, no fades, still a concat for uniform mapping;
        // VAAPI uploads after the format conversion.
        let single = build_filter_graph(&ranges[..1], FPS30, &[audio(48_000)], 10, "nv12", true);
        assert_eq!(
            single.text,
            "[0:v]trim=start_frame=30:end_frame=300,setpts=PTS-STARTPTS[tv0];[0:a:0]atrim=start_sample=48000:end_sample=480000,asetpts=PTS-STARTPTS[ta0_0];[tv0][ta0_0]concat=n=1:v=1:a=1[cv][ca0];[cv]format=nv12,hwupload[outv]"
        );
        // No audio tracks: video only.
        let silent = build_filter_graph(&ranges[..2], FPS30, &[], 10, "yuv420p", false);
        assert!(silent.text.contains("concat=n=2:v=1:a=0[cv]"));
        assert!(silent.audio_labels.is_empty());
        assert!(!silent.text.contains("atrim"));
        // A sliver shorter than two fades gets no fade.
        let sliver = build_filter_graph(
            &[
                KeptRange {
                    start_frame: 0,
                    end_frame: 30,
                },
                KeptRange {
                    start_frame: 60,
                    end_frame: 60,
                },
                KeptRange {
                    start_frame: 90,
                    end_frame: 120,
                },
            ],
            FPS30,
            &[audio(48_000)],
            10,
            "yuv420p",
            false,
        );
        assert!(sliver.text.contains(
            "[a0_1]atrim=start_sample=96000:end_sample=96000,asetpts=PTS-STARTPTS[ta0_1]"
        ));
    }

    #[test]
    fn long_graphs_go_to_a_script_file_and_short_ones_stay_inline() {
        let few: Vec<KeptRange> = (0..4)
            .map(|index| KeptRange {
                start_frame: index * 100,
                end_frame: index * 100 + 50,
            })
            .collect();
        let short = build_filter_graph(&few, FPS30, &[audio(48_000)], 10, "yuv420p", false);
        assert!(
            !graph_needs_script(&short.text),
            "{} bytes",
            short.text.len()
        );
        let many: Vec<KeptRange> = (0..40)
            .map(|index| KeptRange {
                start_frame: index * 100,
                end_frame: index * 100 + 50,
            })
            .collect();
        let long = build_filter_graph(&many, FPS30, &[audio(48_000)], 10, "yuv420p", false);
        assert!(graph_needs_script(&long.text), "{} bytes", long.text.len());
        // About 200 bytes per range with one track: 2 000 ranges fit a script
        // file comfortably and the per-range cost never grows with N.
        let per_range = long.text.len() / 40;
        assert!(per_range < 320, "{per_range} bytes per range");

        let probe = probe_1080p30(1);
        let inline = build_render_args(
            Path::new("in.mp4"),
            Path::new(".out.partial.mp4"),
            &GraphArgument::Inline("graph".to_string()),
            &short,
            &RenderEncoder::VideoToolbox,
            &probe,
            4,
        );
        assert!(
            inline
                .windows(2)
                .any(|pair| pair == ["-filter_complex", "graph"])
        );
        let script = build_render_args(
            Path::new("in.mp4"),
            Path::new(".out.partial.mp4"),
            &GraphArgument::ScriptFile(PathBuf::from("graph.txt")),
            &long,
            &RenderEncoder::VideoToolbox,
            &probe,
            4,
        );
        assert!(
            script
                .windows(2)
                .any(|pair| pair == ["-/filter_complex", "graph.txt"])
        );
        assert!(!script.iter().any(|arg| arg == "-filter_complex_script"));
    }

    fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    }

    #[test]
    fn encoder_chains_follow_the_recording_table_per_platform() {
        assert_eq!(
            encoder_chain(RenderPlatform::Macos, None),
            vec![RenderEncoder::VideoToolbox]
        );
        assert_eq!(
            encoder_chain(RenderPlatform::Windows, None),
            vec![RenderEncoder::MediaFoundation, RenderEncoder::OpenH264]
        );
        assert_eq!(
            encoder_chain(RenderPlatform::Linux, None),
            vec![RenderEncoder::OpenH264],
            "no accepted render node means software only"
        );
        let device = PathBuf::from("/dev/dri/renderD128");
        assert_eq!(
            encoder_chain(
                RenderPlatform::Linux,
                Some((device.clone(), LinuxVaapiArgProfile::Compat))
            ),
            vec![
                RenderEncoder::Vaapi {
                    device,
                    profile: LinuxVaapiArgProfile::Compat
                },
                RenderEncoder::OpenH264
            ]
        );
        #[cfg(target_os = "macos")]
        assert_eq!(current_render_platform(), Some(RenderPlatform::Macos));
        #[cfg(target_os = "windows")]
        assert_eq!(current_render_platform(), Some(RenderPlatform::Windows));
        #[cfg(target_os = "linux")]
        assert_eq!(current_render_platform(), Some(RenderPlatform::Linux));
        assert_eq!(openh264_slices(1), 1);
        assert_eq!(openh264_slices(12), 4);
    }

    #[test]
    fn render_args_match_the_source_and_tag_bt709_per_encoder() {
        let probe = probe_1080p30(2);
        let graph = build_filter_graph(
            &[KeptRange {
                start_frame: 0,
                end_frame: 1_800,
            }],
            FPS30,
            &probe.audio,
            10,
            "yuv420p",
            false,
        );
        let args = build_render_args(
            Path::new("/rec/talk.mp4"),
            Path::new("/rec/.talk (Clean cut).job.videorc-partial.mp4"),
            &GraphArgument::Inline(graph.text.clone()),
            &graph,
            &RenderEncoder::VideoToolbox,
            &probe,
            4,
        );
        assert_eq!(args[0], "-y");
        assert_eq!(arg_value(&args, "-i"), Some("/rec/talk.mp4"));
        assert_eq!(arg_value(&args, "-c:v"), Some("h264_videotoolbox"));
        assert_eq!(arg_value(&args, "-allow_sw"), Some("1"));
        assert!(
            !args.iter().any(|arg| arg == "-realtime"),
            "offline renders are not paced"
        );
        assert_eq!(arg_value(&args, "-b:v"), Some("6000k"));
        assert_eq!(arg_value(&args, "-maxrate"), Some("6000k"));
        assert_eq!(arg_value(&args, "-bufsize"), Some("12000k"));
        assert_eq!(arg_value(&args, "-g"), Some("60"));
        assert_eq!(arg_value(&args, "-profile:v"), Some("high"));
        assert_eq!(arg_value(&args, "-level"), Some("4.0"));
        assert_eq!(arg_value(&args, "-colorspace"), Some("bt709"));
        assert_eq!(arg_value(&args, "-color_primaries"), Some("bt709"));
        assert_eq!(arg_value(&args, "-color_trc"), Some("bt709"));
        assert_eq!(arg_value(&args, "-color_range"), Some("tv"));
        assert_eq!(arg_value(&args, "-fps_mode"), Some("cfr"));
        assert_eq!(arg_value(&args, "-r"), Some("30/1"));
        assert_eq!(arg_value(&args, "-movflags"), Some("+faststart"));
        assert_eq!(arg_value(&args, "-progress"), Some("pipe:1"));
        assert_eq!(arg_value(&args, "-c:a:0"), Some("aac"));
        assert_eq!(
            arg_value(&args, "-b:a:0"),
            Some("160k"),
            "the source's 160k is under the 192k cap"
        );
        assert_eq!(arg_value(&args, "-ar:a:1"), Some("48000"));
        assert_eq!(args.iter().filter(|arg| *arg == "-map").count(), 3);
        assert!(
            !args.iter().any(|arg| arg == "-bsf:v"),
            "VideoToolbox writes its own VUI"
        );
        assert_eq!(
            args.last().map(String::as_str),
            Some("/rec/.talk (Clean cut).job.videorc-partial.mp4")
        );
        let (i_index, graph_index) = (
            args.iter().position(|arg| arg == "-i").unwrap(),
            args.iter()
                .position(|arg| arg == "-filter_complex")
                .unwrap(),
        );
        assert!(i_index < graph_index, "the input comes before the graph");

        let software = build_render_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            &GraphArgument::Inline(graph.text.clone()),
            &graph,
            &RenderEncoder::OpenH264,
            &probe,
            3,
        );
        assert_eq!(arg_value(&software, "-c:v"), Some("libopenh264"));
        assert_eq!(
            arg_value(&software, "-allow_skip_frames"),
            Some("0"),
            "every kept frame is encoded"
        );
        assert_eq!(arg_value(&software, "-slices"), Some("3"));
        assert!(
            arg_value(&software, "-bsf:v")
                .unwrap()
                .starts_with("h264_metadata=")
        );

        let vaapi = build_render_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            &GraphArgument::Inline(graph.text.clone()),
            &graph,
            &RenderEncoder::Vaapi {
                device: PathBuf::from("/dev/dri/renderD128"),
                profile: LinuxVaapiArgProfile::Standard,
            },
            &probe,
            4,
        );
        assert_eq!(
            arg_value(&vaapi, "-vaapi_device"),
            Some("/dev/dri/renderD128")
        );
        assert!(
            vaapi.iter().position(|arg| arg == "-vaapi_device").unwrap()
                < vaapi.iter().position(|arg| arg == "-i").unwrap()
        );
        assert_eq!(arg_value(&vaapi, "-c:v"), Some("h264_vaapi"));
        assert_eq!(arg_value(&vaapi, "-rc_mode"), Some("VBR"));
        assert_eq!(arg_value(&vaapi, "-bf"), Some("0"));
        assert_eq!(
            arg_value(&vaapi, "-level"),
            Some("4"),
            "VAAPI spells 4.0 as 4"
        );

        let media_foundation = build_render_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            &GraphArgument::Inline(graph.text.clone()),
            &graph,
            &RenderEncoder::MediaFoundation,
            &probe,
            4,
        );
        assert_eq!(arg_value(&media_foundation, "-c:v"), Some("h264_mf"));
        assert_eq!(arg_value(&media_foundation, "-hw_encoding"), Some("1"));
        assert!(
            !media_foundation.iter().any(|arg| arg == "-profile:v"),
            "Media Foundation exposes no profile option"
        );
    }

    #[test]
    fn bitrates_follow_the_source_with_floors_and_caps() {
        let mut probe = probe_1080p30(1);
        assert_eq!(video_bitrate_kbps(&probe), 6_000);
        probe.video.bit_rate = None;
        assert_eq!(
            video_bitrate_kbps(&probe),
            5_890,
            "95% of the container's 6.2 Mbps"
        );
        probe.format_bit_rate = None;
        assert_eq!(video_bitrate_kbps(&probe), RENDER_MIN_VIDEO_KBPS);
        probe.video.bit_rate = Some(900_000);
        assert_eq!(
            video_bitrate_kbps(&probe),
            RENDER_MIN_VIDEO_KBPS,
            "the floor holds"
        );
        let mut track = audio(48_000);
        assert_eq!(audio_bitrate_kbps(&track), 160);
        track.bit_rate = Some(320_000);
        assert_eq!(audio_bitrate_kbps(&track), 192, "capped");
        track.bit_rate = None;
        assert_eq!(audio_bitrate_kbps(&track), 192);
        track.bit_rate = Some(8_000);
        assert_eq!(audio_bitrate_kbps(&track), 32, "floored");
    }

    #[test]
    fn probe_json_parses_streams_and_the_container() {
        let probe = parse_render_probe(
            r#"{"streams":[
                {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30000/1001","avg_frame_rate":"29970/1000","bit_rate":"6000000","nb_frames":"1798","duration":"60.026633"},
                {"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"bit_rate":"160000","duration":"60.021333"},
                {"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":1}
            ],"format":{"duration":"60.050000","bit_rate":"6200000"}}"#,
        )
        .unwrap();
        assert_eq!(probe.video.frame_rate, NTSC);
        assert_eq!((probe.video.width, probe.video.height), (1920, 1080));
        assert_eq!(probe.video.bit_rate, Some(6_000_000));
        assert_eq!(probe.video.nb_frames, Some(1_798));
        assert_eq!(probe.video.duration_ms, Some(60_027));
        assert_eq!(probe.audio.len(), 2);
        assert_eq!(probe.audio[0].sample_rate, 48_000);
        assert_eq!(probe.audio[0].duration_ms, Some(60_021));
        assert_eq!(probe.audio[1].channels, 1);
        assert_eq!(probe.audio[1].bit_rate, None);
        assert_eq!(probe.format_duration_ms, Some(60_050));
        assert_eq!(probe.format_bit_rate, Some(6_200_000));
        assert!(
            parse_render_probe(r#"{"streams":[{"codec_type":"audio","sample_rate":"48000"}]}"#)
                .is_err()
        );
        assert!(
            parse_render_probe(
                r#"{"streams":[{"codec_type":"video","width":1920,"height":1080}]}"#
            )
            .is_err(),
            "no frame rate"
        );
        assert!(parse_render_probe(r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"r_frame_rate":"30/1"},{"codec_type":"audio"}]}"#).is_err(), "an audio track without a rate");
    }

    #[test]
    fn validation_accepts_one_frame_and_rejects_shape_changes() {
        let source = probe_1080p30(1);
        let kept = 1_000_u64; // 33 333 ms at 30 fps
        let mut output = RenderProbe {
            video: RenderVideoInfo {
                codec: "h264".to_string(),
                width: 1920,
                height: 1080,
                frame_rate: FPS30,
                bit_rate: None,
                nb_frames: Some(1_000),
                duration_ms: Some(33_333),
            },
            audio: vec![RenderAudioInfo {
                codec: "aac".to_string(),
                sample_rate: 48_000,
                channels: 2,
                bit_rate: None,
                duration_ms: Some(33_355),
            }],
            format_duration_ms: Some(33_355),
            format_bit_rate: None,
        };
        validate_output(&source, &output, kept).unwrap();
        output.audio[0].duration_ms = Some(33_333 + 34);
        validate_output(&source, &output, kept).unwrap();
        output.audio[0].duration_ms = Some(33_333 + 35);
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("audio track 0")
        );
        output.audio[0].duration_ms = Some(33_340);
        output.video.nb_frames = Some(1_002);
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("video frames")
        );
        output.video.nb_frames = Some(1_001);
        output.video.duration_ms = Some(33_366);
        validate_output(&source, &output, kept).unwrap();
        output.video.duration_ms = Some(33_400);
        assert!(validate_output(&source, &output, kept).is_err());
        output.video.duration_ms = Some(33_333);
        output.video.nb_frames = None;
        output.audio.push(audio(48_000));
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("audio track(s)")
        );
        output.audio.pop();
        output.video.width = 1280;
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("size")
        );
        output.video.width = 1920;
        output.video.frame_rate = NTSC;
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("frame rate")
        );
        output.video.frame_rate = FPS30;
        output.video.duration_ms = None;
        output.format_duration_ms = None;
        assert!(
            validate_output(&source, &output, kept)
                .unwrap_err()
                .contains("no video duration")
        );
    }

    #[test]
    fn output_names_add_a_counter_only_for_files_nobody_owns() {
        let source = Path::new("/rec/My talk.mp4");
        assert_eq!(
            output_path_for(source, CleanCutMode::Clean, |_| false),
            Some(PathBuf::from("/rec/My talk (Clean cut).mp4"))
        );
        assert_eq!(
            output_path_for(source, CleanCutMode::Condensed, |_| false),
            Some(PathBuf::from("/rec/My talk (Condensed).mp4"))
        );
        let taken = [
            PathBuf::from("/rec/My talk (Clean cut).mp4"),
            PathBuf::from("/rec/My talk (Clean cut) 2.mp4"),
        ];
        assert_eq!(
            output_path_for(source, CleanCutMode::Clean, |candidate| taken
                .contains(&candidate.to_path_buf())),
            Some(PathBuf::from("/rec/My talk (Clean cut) 3.mp4"))
        );
        assert_eq!(output_path_for(source, CleanCutMode::Clean, |_| true), None);
        assert_eq!(
            output_title(" My talk ", CleanCutMode::Clean),
            "My talk (Clean cut)"
        );
        assert_eq!(
            output_title("Stream", CleanCutMode::Condensed),
            "Stream (Condensed)"
        );
        assert_eq!(
            staging_path_for(Path::new("/rec/My talk (Clean cut).mp4"), "job-1"),
            PathBuf::from("/rec/.My talk (Clean cut).job-1.videorc-partial.mp4")
        );
        assert_eq!(required_free_space(1_000), 1_200);
        assert_eq!(
            required_free_space(u64::MAX),
            u64::MAX / 10,
            "saturates instead of wrapping"
        );
    }

    #[test]
    fn progress_comes_from_out_time_against_the_kept_duration() {
        assert_eq!(progress_fraction("out_time_us=15000000", 30_000), Some(0.5));
        assert_eq!(progress_fraction("out_time_ms=15000000", 30_000), Some(0.5));
        assert_eq!(
            progress_fraction("out_time_us=45000000", 30_000),
            Some(0.99),
            "held under one until validated"
        );
        assert_eq!(progress_fraction("frame=12", 30_000), None);
        assert_eq!(progress_fraction("out_time_us=1", 0), None);
        assert_eq!(progress_fraction("out_time_us=-5", 30_000), None);
    }

    #[test]
    fn capability_gaps_name_filters_and_the_whole_encoder_chain() {
        let filters = "Filters:\n .. trim V->V Pick\n .. atrim A->A Pick\n .. concat N->N Cat\n T. afade A->A Fade\n .. split V->N Split\n .. asplit A->N Split\n .. setpts V->V Set\n .. asetpts A->A Set\n .. format V->V Convert\n .. hwupload V->V Upload";
        let encoders = "Encoders:\n V....D h264_videotoolbox VideoToolbox\n A....D aac AAC";
        assert!(missing_capabilities(filters, encoders, &[RenderEncoder::VideoToolbox]).is_empty());
        let windows = [RenderEncoder::MediaFoundation, RenderEncoder::OpenH264];
        assert_eq!(
            missing_capabilities(filters, encoders, &windows),
            vec!["encoder:h264_mf|libopenh264"],
            "a chain is a gap only when none of its encoders exists"
        );
        let with_openh264 = format!("{encoders}\n V..... libopenh264 OpenH264");
        assert!(missing_capabilities(filters, &with_openh264, &windows).is_empty());
        assert_eq!(
            available_encoders(&with_openh264, &windows),
            vec![RenderEncoder::OpenH264]
        );
        let no_afade = filters.replace(" T. afade A->A Fade\n", "");
        assert_eq!(
            missing_capabilities(&no_afade, encoders, &[RenderEncoder::VideoToolbox]),
            vec!["filter:afade"]
        );
        let vaapi = RenderEncoder::Vaapi {
            device: PathBuf::from("/dev/dri/renderD128"),
            profile: LinuxVaapiArgProfile::Standard,
        };
        let no_upload = filters.replace("\n .. hwupload V->V Upload", "");
        assert_eq!(
            missing_capabilities(
                &no_upload,
                "Encoders:\n V..... h264_vaapi V\n A....D aac AAC",
                std::slice::from_ref(&vaapi)
            ),
            vec!["filter:hwupload"]
        );
        assert_eq!(
            missing_capabilities(
                filters,
                "Encoders:\n V..... h264_vaapi V",
                std::slice::from_ref(&vaapi)
            ),
            vec!["encoder:aac"]
        );
        assert!(listed_names(" V....D h264_mf  MediaFoundation").contains("h264_mf"));
        assert!(!listed_names("Encoders:").contains("Encoders:"));
    }

    #[test]
    fn render_records_round_trip_and_stale_staging_is_swept_only_by_marker() {
        let record = RenderRecord {
            version: RENDER_RECORD_VERSION,
            staging_path: "/rec/.talk (Clean cut).job.videorc-partial.mp4".to_string(),
            final_path: "/rec/talk (Clean cut).mp4".to_string(),
            output_session_id: None,
            revision: 2,
        };
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("outputSessionId"), "absent, never null");
        let back: RenderRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, record);

        let dir =
            std::env::temp_dir().join(format!("videorc-clean-cut-render-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let staging = staging_path_for(&dir.join("talk (Clean cut).mp4"), "job-1");
        std::fs::write(&staging, b"partial").unwrap();
        std::fs::write(staging.with_extension("filtergraph.txt"), b"graph").unwrap();
        let final_path = dir.join("talk (Clean cut).mp4");
        std::fs::write(&final_path, b"published").unwrap();
        remove_stale_staging(&RenderRecord {
            version: RENDER_RECORD_VERSION,
            staging_path: staging.display().to_string(),
            final_path: final_path.display().to_string(),
            output_session_id: Some("out".to_string()),
            revision: 0,
        });
        assert!(!staging.exists());
        assert!(!staging.with_extension("filtergraph.txt").exists());
        assert!(final_path.exists(), "the published file is never swept");
        // A record naming a file without the marker is never removed.
        remove_stale_staging(&RenderRecord {
            version: RENDER_RECORD_VERSION,
            staging_path: final_path.display().to_string(),
            final_path: final_path.display().to_string(),
            output_session_id: None,
            revision: 0,
        });
        assert!(final_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
