//! Live captions: taps microphone PCM off the native audio pipeline and
//! transcribes it through videorc-web, streaming-first (S2): the gateway
//! realtime WebSocket (voice-model input-audio transcription events, ~1s
//! behind speech, partial + final updates) with automatic fallback to ~3s
//! chunked batch transcription (`/api/ai/captions/chunks` → grok-stt)
//! whenever streaming is unavailable. Transcripts broadcast to renderer
//! clients and accumulate as chunk records for the SRT + burned copy.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use anyhow::{Result, bail};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc, watch};

use crate::audio::AudioFrame;
use crate::process_job::spawn_owned_tokio;
use crate::state::AppState;
use crate::videorc_api::{
    CAPTION_CHUNK_UPLOAD_TIMEOUT, CaptionChunkFailure, CaptionChunkResponse, VideorcApiClient,
};

pub const CAPTION_SAMPLE_RATE: u32 = 16_000;
pub const CAPTION_CHUNK_SECONDS: f64 = 3.0;
/// Bounded frame queue between the realtime audio thread and the session task.
/// At ~93 CoreAudio callbacks/s, 256 frames ≈ 2.7s of cushion.
const TAP_CHANNEL_CAPACITY: usize = 256;
/// A provider must acknowledge the requested transcription configuration before
/// the coordinator can claim that captions are listening.
const REALTIME_CONFIG_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);
/// A connected transport without frames is not a working caption path. Native
/// mute still produces digital-silence frames, so this detects unsupported or
/// disconnected capture paths without treating intentional mute as failure.
const CAPTION_AUDIO_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// Once the caption bus has produced frames, native mute/silence must keep
/// producing them. A gap this long means the producer/path itself stalled.
const CAPTION_AUDIO_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// Speech energy or provider VAD without any transcript is a silent-socket
/// failure. Chunked transcription is slower but preferable to false readiness.
const TRANSCRIPT_WATCHDOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CAPTION_FINAL_TRANSCRIPT_GRACE: std::time::Duration = std::time::Duration::from_millis(1_500);
/// Configuration acknowledgement alone is not transport health. A socket earns
/// a fresh retry budget only after a transcript or this sustained ready+audio
/// interval, which prevents accepting-then-closing gateways from spinning.
const REALTIME_RECONNECT_HEALTHY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
/// One in-flight upload plus eight queued chunks buffers roughly 27 seconds of
/// chunked caption audio without ever stalling the realtime producer.
const MAX_BUFFERED_CAPTION_CHUNKS: usize = 8;
/// Once the renderer has started returning cue frames, only inactivity is a
/// failure. A fixed whole-request deadline breaks long 4K recordings where
/// hundreds of healthy sequential renders can legitimately take minutes.
const CAPTION_CUE_RENDER_INACTIVITY_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);
/// Scheduling/filesystem headroom after the bounded sequence of chunk upload
/// request timeouts during capture finalization.
const CAPTION_FINAL_UPLOAD_OVERHEAD: std::time::Duration = std::time::Duration::from_secs(2);
/// Capture stop preserves only the upload already in flight and the final
/// sub-chunk remainder. Older queued backlog is explicitly dropped with health
/// truth so normal recording finalization stays near twenty seconds.
const CAPTION_FINAL_UPLOAD_COUNT: usize = 2;
const MAX_REALTIME_RECONNECTS: u8 = 2;

fn caption_final_upload_grace(upload_count: usize) -> std::time::Duration {
    let upload_count = u32::try_from(upload_count.max(1)).unwrap_or(u32::MAX);
    CAPTION_CHUNK_UPLOAD_TIMEOUT
        .saturating_mul(upload_count)
        .saturating_add(CAPTION_FINAL_UPLOAD_OVERHEAD)
}

fn caption_contract_test_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("VIDEORC_CAPTION_CONTRACT_TEST")
            .ok()
            .is_some_and(|value| value == "1")
}

/// The transport-only smoke has no recording pipeline, so it opts into an
/// idle provider session separately from the debug audio-injection gate. The
/// renderer/compositor smoke keeps this unset and must prove a real active
/// capture before captions start.
fn caption_contract_idle_session_enabled() -> bool {
    caption_contract_test_enabled()
        && std::env::var("VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE")
            .ok()
            .is_some_and(|value| value == "1")
}

// ---------------------------------------------------------------------------
// Tap: the audio FIFO writer thread offers every mic frame here. Fast path is
// one relaxed atomic load when captions are off; when on, a non-blocking
// try_send that drops the frame rather than ever stalling the audio thread.
// ---------------------------------------------------------------------------

static TAP_ACTIVE: AtomicBool = AtomicBool::new(false);
static TAP_FRAMES_SEEN: AtomicU64 = AtomicU64::new(0);
static TAP_FRAMES_DROPPED: AtomicU64 = AtomicU64::new(0);
/// Audio intentionally evicted from the bounded chunk queue, in milliseconds.
/// Zero in normal operation; non-zero is exposed in status and health events.
static CAPTION_AUDIO_MILLIS_DROPPED: AtomicU64 = AtomicU64::new(0);
static TAP_CLOCK_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
/// 1-based monotonic microseconds since `TAP_CLOCK_EPOCH`; zero means no frame
/// has entered the current caption bus. Updated on the producer fast path.
static TAP_LAST_FRAME_MICROS: AtomicU64 = AtomicU64::new(0);
static TAP: std::sync::Mutex<Option<mpsc::Sender<AudioFrame>>> = std::sync::Mutex::new(None);
/// Serializes caption control transitions across every backend WebSocket.
/// Without this guard a start racing sign-out could clone the bearer between
/// teardown and credential removal, then install a fresh provider task.
static CAPTION_CONTROL: Mutex<()> = Mutex::const_new(());

pub fn offer_caption_frame(frame: &AudioFrame) {
    offer_caption_frame_to_tap(
        frame,
        &TAP_ACTIVE,
        &TAP_FRAMES_SEEN,
        &TAP_FRAMES_DROPPED,
        &TAP_LAST_FRAME_MICROS,
        &TAP,
    );
}

fn offer_caption_frame_to_tap(
    frame: &AudioFrame,
    active: &AtomicBool,
    frames_seen: &AtomicU64,
    frames_dropped: &AtomicU64,
    last_frame_micros: &AtomicU64,
    tap: &std::sync::Mutex<Option<mpsc::Sender<AudioFrame>>>,
) {
    if !active.load(Ordering::Relaxed) {
        return;
    }
    let Ok(guard) = tap.try_lock() else {
        frames_dropped.fetch_add(1, Ordering::Relaxed);
        return;
    };
    if let Some(sender) = guard.as_ref() {
        match sender.try_send(frame.clone()) {
            Ok(()) => {
                frames_seen.fetch_add(1, Ordering::Relaxed);
                last_frame_micros.store(caption_bus_clock_micros(), Ordering::Release);
            }
            Err(_) => {
                frames_dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn round_trip_caption_audio_test_frame(frame: &AudioFrame) -> AudioFrame {
    let active = AtomicBool::new(true);
    let frames_seen = AtomicU64::new(0);
    let frames_dropped = AtomicU64::new(0);
    let last_frame_micros = AtomicU64::new(0);
    let (sender, mut receiver) = mpsc::channel(1);
    let tap = std::sync::Mutex::new(Some(sender));
    offer_caption_frame_to_tap(
        frame,
        &active,
        &frames_seen,
        &frames_dropped,
        &last_frame_micros,
        &tap,
    );
    assert_eq!(frames_seen.load(Ordering::Relaxed), 1);
    assert_eq!(frames_dropped.load(Ordering::Relaxed), 0);
    assert!(last_frame_micros.load(Ordering::Acquire) > 0);
    receiver
        .try_recv()
        .expect("caption test bus should receive the offered frame")
}

fn caption_bus_clock_micros() -> u64 {
    let epoch = TAP_CLOCK_EPOCH.get_or_init(std::time::Instant::now);
    let elapsed = epoch.elapsed().as_micros().min(u128::from(u64::MAX - 1)) as u64;
    elapsed + 1
}

fn caption_audio_seconds_dropped() -> f64 {
    CAPTION_AUDIO_MILLIS_DROPPED.load(Ordering::Relaxed) as f64 / 1_000.0
}

/// Debug-only contract seam used by the maintained fake-Gateway smoke. It
/// enters through the same bounded post-controls audio bus as a native mic.
/// Release builds have no RPC exposing this function, and the env gate is
/// checked again here to prevent accidental use in an ordinary dev session.
#[cfg(debug_assertions)]
pub async fn inject_caption_contract_test_audio(duration_ms: u64) -> Result<u64> {
    if !caption_contract_test_enabled() {
        bail!("Caption contract test audio is disabled.");
    }
    if !TAP_ACTIVE.load(Ordering::Relaxed) {
        bail!("Start the caption contract session before injecting audio.");
    }
    let duration_ms = duration_ms.clamp(20, 5_000);
    let frames = duration_ms.div_ceil(20);
    let samples_per_channel = (48_000_u64 * 20 / 1_000) as usize;
    let before = TAP_FRAMES_SEEN.load(Ordering::Relaxed);
    for frame_index in 0..frames {
        let mut samples = Vec::with_capacity(samples_per_channel * 2);
        for sample_index in 0..samples_per_channel {
            let absolute = frame_index as usize * samples_per_channel + sample_index;
            let phase = absolute as f32 * 440.0 * std::f32::consts::TAU / 48_000.0;
            let sample = phase.sin() * 0.12;
            samples.extend_from_slice(&[sample, sample]);
        }
        offer_caption_frame(&AudioFrame {
            timestamp_micros: frame_index * 20_000,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 2,
            samples,
        });
        tokio::task::yield_now().await;
    }
    Ok(TAP_FRAMES_SEEN
        .load(Ordering::Relaxed)
        .saturating_sub(before))
}

fn install_tap() -> mpsc::Receiver<AudioFrame> {
    let (sender, receiver) = mpsc::channel(TAP_CHANNEL_CAPACITY);
    TAP_FRAMES_SEEN.store(0, Ordering::Relaxed);
    TAP_FRAMES_DROPPED.store(0, Ordering::Relaxed);
    CAPTION_AUDIO_MILLIS_DROPPED.store(0, Ordering::Relaxed);
    TAP_LAST_FRAME_MICROS.store(0, Ordering::Release);
    TAP_CLOCK_EPOCH.get_or_init(std::time::Instant::now);
    *TAP.lock().expect("caption tap lock") = Some(sender);
    TAP_ACTIVE.store(true, Ordering::Relaxed);
    receiver
}

fn remove_tap() {
    TAP_ACTIVE.store(false, Ordering::Relaxed);
    *TAP.lock().expect("caption tap lock") = None;
}

// ---------------------------------------------------------------------------
// DSP: 48kHz interleaved f32 (mono or stereo) → 16kHz mono s16le.
// ---------------------------------------------------------------------------

/// Downmix interleaved samples to mono and decimate 3:1 (48kHz → 16kHz) with a
/// 3-sample boxcar average as a cheap anti-alias low-pass — speech-grade, which
/// is all a caption model needs. Returns an empty vec for unsupported input
/// (only 48kHz, 1–2 channels are produced by the native pipeline).
pub fn downmix_resample_to_16k_mono(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<i16> {
    if sample_rate != 48_000 || !(1..=2).contains(&channels) {
        return Vec::new();
    }
    let channels = usize::from(channels);
    let mono: Vec<f32> = samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    mono.chunks_exact(3)
        .map(|window| {
            let value = (window[0] + window[1] + window[2]) / 3.0;
            (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
        })
        .collect()
}

/// Minimal 44-byte-header PCM WAV (16kHz mono s16le) — what the caption route
/// uploads as `audio/wav`.
pub fn encode_wav_16k_mono(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let byte_rate = CAPTION_SAMPLE_RATE * 2;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1_u16.to_le_bytes()); // mono
    wav.extend_from_slice(&CAPTION_SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

// ---------------------------------------------------------------------------
// Chunk records: every transcribed chunk is remembered (text + word timing +
// audio offset) so the post-recording pass can render perfectly-synced
// captions. The tap only receives frames while a session's audio pipeline
// runs and those frames are already epoch-trimmed, so offsets anchor to the
// recording start. A new session restarts the audio unit (frame timestamps
// regress), which resets the anchor and the pending buffer.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub text: String,
    pub start_second: f64,
    pub end_second: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionChunkRecord {
    pub seq: u64,
    /// Seconds from the recording epoch to this chunk's first sample.
    pub offset_seconds: f64,
    pub duration_seconds: f64,
    pub text: String,
    /// Word timing RELATIVE TO THE CHUNK (add offset_seconds for absolute).
    pub segments: Vec<CaptionSegment>,
    /// Which capture pipeline (recording) this transcript belongs to. The
    /// caption session outlives recordings; transcripts that land AFTER a new
    /// recording started must never leak into it (previous video's last words
    /// at t≈0 of the next). Stamped by the session, filtered at finalize.
    #[serde(skip_serializing)]
    pub capture_epoch: u64,
    /// Stable realtime provider utterance identity. Batch chunks do not have
    /// one. Repeated completion events for the same item upsert this record so
    /// SRT and captioned-copy output contain one canonical cue.
    #[serde(skip_serializing)]
    pub provider_item_id: Option<String>,
}

fn upsert_caption_record(chunks: &mut Vec<CaptionChunkRecord>, record: CaptionChunkRecord) -> bool {
    let existing = record
        .provider_item_id
        .as_ref()
        .and_then(|provider_item_id| {
            chunks.iter_mut().find(|candidate| {
                candidate.capture_epoch == record.capture_epoch
                    && candidate.provider_item_id.as_ref() == Some(provider_item_id)
            })
        });
    if let Some(existing) = existing {
        *existing = record;
        false
    } else {
        chunks.push(record);
        true
    }
}

/// A frame timestamp lower than the last one means the capture pipeline
/// restarted (new session): reset the chunk anchor.
pub fn caption_anchor_should_reset(last_timestamp: Option<u64>, current: u64) -> bool {
    last_timestamp.is_some_and(|last| current < last)
}

/// An absolute cue window derived from one chunk record.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCue {
    pub seq: u64,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
}

/// Cue windows shared by every caption renderer (SRT, overlay track): cue per
/// chunk, timed by word segments (chunk-window fallback), sorted, ends
/// clamped to the next cue so captions never stack.
pub fn caption_cues(chunks: &[CaptionChunkRecord]) -> Vec<CaptionCue> {
    let mut cues = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let text = chunk.text.trim();
        if text.is_empty() {
            continue;
        }
        let (start, end) = chunk_cue_window(chunk);
        cues.push(CaptionCue {
            seq: chunk.seq,
            start_seconds: start,
            end_seconds: end,
            text: text.to_string(),
        });
    }
    cues.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    for index in 0..cues.len().saturating_sub(1) {
        let next_start = cues[index + 1].start_seconds;
        if cues[index].end_seconds > next_start {
            cues[index].end_seconds = next_start;
        }
    }
    cues
}

/// Render chunk records as SubRip.
pub fn render_srt(chunks: &[CaptionChunkRecord]) -> String {
    let mut srt = String::new();
    for (index, cue) in caption_cues(chunks).iter().enumerate() {
        srt.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            format_srt_timestamp(cue.start_seconds),
            format_srt_timestamp(cue.end_seconds.max(cue.start_seconds + 0.001)),
            cue.text
        ));
    }
    srt
}

/// Caption text size for the burned copy (mirrors the renderer knob).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionTextSize {
    S,
    #[default]
    M,
    L,
}

/// Visual preset captured with each session. The renderer owns the actual
/// recipe, while Rust persists the stable identity for artifact/session parity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionStyleId {
    #[default]
    Classic,
    Glass,
    LowerThird,
    HighContrast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyleSnapshot {
    pub position: CaptionOverlayPosition,
    pub text_size: CaptionTextSize,
    pub style_id: CaptionStyleId,
    pub style_revision: u64,
    pub output_width: u32,
    pub output_height: u32,
}

impl Default for CaptionStyleSnapshot {
    fn default() -> Self {
        Self {
            position: CaptionOverlayPosition::Bottom,
            text_size: CaptionTextSize::M,
            style_id: CaptionStyleId::Classic,
            style_revision: 0,
            output_width: 0,
            output_height: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCaptionStyleParams {
    pub position: CaptionOverlayPosition,
    pub text_size: CaptionTextSize,
    pub style_id: CaptionStyleId,
    pub style_revision: u64,
}

#[derive(Debug, thiserror::Error)]
#[error("Caption style revision {received} is stale; current revision is {current}.")]
struct StaleCaptionStyleRevision {
    received: u64,
    current: u64,
}

pub fn caption_style_error_code(error: &anyhow::Error) -> &'static str {
    if error.downcast_ref::<StaleCaptionStyleRevision>().is_some() {
        "captions-style-stale"
    } else {
        "captions-style-invalid"
    }
}

/// Which caption products the user selected for this session. `Recording`
/// means a non-destructive aligned `(captioned)` copy; the source recording is
/// never a live burn target.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionBurnTarget {
    #[default]
    Off,
    Stream,
    Recording,
    Both,
}

impl CaptionBurnTarget {
    pub fn burns_stream(self) -> bool {
        matches!(self, CaptionBurnTarget::Stream | CaptionBurnTarget::Both)
    }

    pub fn requests_captioned_copy(self) -> bool {
        matches!(self, CaptionBurnTarget::Recording | CaptionBurnTarget::Both)
    }
}

/// Per-leg overlay plan for a session shape (pure; unit-tested matrix).
/// The primary leg is the source recording whenever recording is enabled and
/// therefore always stays clean. A captioned stream in a combined session uses
/// the auxiliary leg, forcing a same-profile split when profiles otherwise
/// match. `captioned_copy` is fulfilled after finalization from the clean source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionOverlayLegPlan {
    pub primary: bool,
    pub aux: bool,
    pub force_same_profile_split: bool,
    pub captioned_copy: bool,
}

pub fn caption_overlay_leg_plan(
    record_enabled: bool,
    stream_enabled: bool,
    target: CaptionBurnTarget,
) -> CaptionOverlayLegPlan {
    let none = CaptionOverlayLegPlan {
        primary: false,
        aux: false,
        force_same_profile_split: false,
        captioned_copy: false,
    };
    if target == CaptionBurnTarget::Off {
        return none;
    }
    match (record_enabled, stream_enabled) {
        (false, false) => none,
        // Record only: preserve the clean source and fulfill Recording with a
        // post-recording copy.
        (true, false) => CaptionOverlayLegPlan {
            primary: false,
            aux: false,
            force_same_profile_split: false,
            captioned_copy: target.requests_captioned_copy(),
        },
        // Stream only: the primary leg IS the stream.
        (false, true) => CaptionOverlayLegPlan {
            primary: target.burns_stream(),
            aux: false,
            force_same_profile_split: false,
            captioned_copy: false,
        },
        // Record + stream: primary = clean source recording, aux = stream.
        (true, true) => CaptionOverlayLegPlan {
            primary: false,
            aux: target.burns_stream(),
            force_same_profile_split: target.burns_stream(),
            captioned_copy: target.requests_captioned_copy(),
        },
    }
}

/// Per-leg plan for the comment-highlight overlay (Comments upgrade S2). The
/// highlight is a STREAM-facing feature: it burns on whichever leg viewers
/// watch — the aux leg when the session runs a split stream leg, else the
/// primary leg when that leg carries the stream. Record-only sessions never
/// burn a highlight. (When record+stream share one leg, viewers and the
/// recording share pixels; the highlight lands on both — stated in the UI.)
pub fn highlight_overlay_leg_plan(
    record_enabled: bool,
    stream_enabled: bool,
    has_split_stream_leg: bool,
) -> (bool, bool) {
    if !stream_enabled {
        return (false, false);
    }
    if has_split_stream_leg {
        (false, true)
    } else {
        let _ = record_enabled;
        (true, false)
    }
}

/// `Recording.mp4` → `Recording (captioned).mp4`.
pub fn captioned_copy_path(recording: &std::path::Path) -> std::path::PathBuf {
    let stem = recording
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let extension = recording
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    recording.with_file_name(format!("{stem} (captioned).{extension}"))
}

fn chunk_cue_window(chunk: &CaptionChunkRecord) -> (f64, f64) {
    let first = chunk.segments.first().map(|segment| segment.start_second);
    let last = chunk.segments.last().map(|segment| segment.end_second);
    match (first, last) {
        (Some(first), Some(last)) if last > first => (
            chunk.offset_seconds + first.max(0.0),
            chunk.offset_seconds + last.min(chunk.duration_seconds.max(last)),
        ),
        _ => (
            chunk.offset_seconds,
            chunk.offset_seconds + chunk.duration_seconds,
        ),
    }
}

fn format_srt_timestamp(seconds: f64) -> String {
    let clamped = seconds.max(0.0);
    let total_millis = (clamped * 1000.0).round() as u64;
    let hours = total_millis / 3_600_000;
    let minutes = (total_millis % 3_600_000) / 60_000;
    let secs = (total_millis % 60_000) / 1000;
    let millis = total_millis % 1000;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

/// Every capture owns a fresh transcript epoch. Purging at the boundary is
/// authoritative even if a previous FFmpeg session failed before artifact
/// generation, so its canonical cues can never be drained into the next file.
fn advance_caption_capture_epoch_and_purge(coordinator: &mut CaptionsCoordinator) -> usize {
    let discarded = coordinator.chunks.len();
    coordinator.chunks.clear();
    coordinator.capture_epoch = coordinator.capture_epoch.saturating_add(1);
    coordinator.sequence.reset();
    coordinator.finalized_style = None;
    discarded
}

/// Failed captures have no valid artifact owner. The caption provider task is
/// joined before this hook runs, then all canonical cues are discarded and the
/// epoch advances so no failed-session text can be attributed to a later run.
pub async fn discard_failed_caption_capture(state: &AppState) -> usize {
    let mut coordinator = state.captions.lock().await;
    advance_caption_capture_epoch_and_purge(&mut coordinator)
}

#[derive(Debug, Clone)]
pub struct FinalizedCaptionArtifact {
    pub chunks: Vec<CaptionChunkRecord>,
    style: CaptionStyleSnapshot,
    artifact_generation: u64,
}

fn take_finalized_caption_artifact(
    coordinator: &mut CaptionsCoordinator,
) -> FinalizedCaptionArtifact {
    let epoch = coordinator.capture_epoch;
    let chunks =
        caption_records_for_session_end(std::mem::take(&mut coordinator.chunks), epoch, true);
    FinalizedCaptionArtifact {
        chunks,
        style: caption_style_for_final_artifact(
            coordinator.finalized_style.take(),
            coordinator.style,
        ),
        artifact_generation: coordinator.artifact_generation,
    }
}

pub async fn take_finalized_caption_artifact_for_capture(
    state: &AppState,
) -> FinalizedCaptionArtifact {
    let mut coordinator = state.captions.lock().await;
    take_finalized_caption_artifact(&mut coordinator)
}

pub fn caption_records_for_session_end(
    records: Vec<CaptionChunkRecord>,
    epoch: u64,
    retain_for_artifact: bool,
) -> Vec<CaptionChunkRecord> {
    if !retain_for_artifact {
        return Vec::new();
    }
    filter_caption_records_for_epoch(records, epoch)
}

/// Keep only records from the capture epoch being finalized; stragglers from
/// a previous recording (uploads/finals that landed after the new one began)
/// are dropped — never attributed to the wrong video.
pub fn filter_caption_records_for_epoch(
    records: Vec<CaptionChunkRecord>,
    epoch: u64,
) -> Vec<CaptionChunkRecord> {
    let before = records.len();
    let kept: Vec<CaptionChunkRecord> = records
        .into_iter()
        .filter(|record| record.capture_epoch == epoch)
        .collect();
    if kept.len() != before {
        tracing::info!(
            "Dropped {} caption record(s) from a previous recording.",
            before - kept.len()
        );
    }
    kept
}

/// Session-stop hook (recording finalize path): drain the chunks recorded
/// during this session and write the `.srt` sidecar next to the recording.
/// Returns an owned artifact bundle so a later capture cannot replace its
/// chunks, frozen style, or privacy generation before the burned-copy request
/// is registered. Never fails the session — problems downgrade to warnings.
pub async fn write_caption_artifacts(
    state: &AppState,
    session_id: &str,
    recording_path: &std::path::Path,
    artifact: FinalizedCaptionArtifact,
) -> FinalizedCaptionArtifact {
    if artifact.chunks.is_empty() {
        return artifact;
    }
    let srt = render_srt(&artifact.chunks);
    if srt.is_empty() {
        return artifact;
    }
    let srt_path = recording_path.with_extension("srt");
    // Serialize publication with the sign-out generation boundary. If
    // sign-out wins, this artifact is stale and writes nothing. If this write
    // wins, sign-out cannot return until the transcript file is fully present.
    let write_result = {
        let coordinator = state.captions.lock().await;
        if coordinator.artifact_generation != artifact.artifact_generation {
            return artifact;
        }
        tokio::fs::write(&srt_path, &srt).await
    };
    match write_result {
        Ok(()) => {
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Info,
                "captions-srt-written",
                &format!("Captions saved to {}.", srt_path.display()),
            );
        }
        Err(error) => {
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-srt-failed",
                &format!("Could not write captions sidecar: {error}"),
            );
        }
    }
    artifact
}

/// Build the ffconcat playlist for the caption track: transparent gap frames
/// alternating with cue frames, exact durations from the cue windows.
/// Entries are bare filenames — the list resolves relative to its own
/// location inside the frames dir, so no path escaping is ever needed.
pub fn build_caption_track_concat(cues: &[CaptionCue], blank_seq: u64) -> String {
    let mut list = String::from("ffconcat version 1.0\n");
    let mut cursor = 0.0_f64;
    for cue in cues {
        let start = cue.start_seconds.max(cursor);
        let end = cue.end_seconds.max(start + 0.05);
        if start > cursor {
            list.push_str(&format!(
                "file '{blank_seq}.png'\nduration {:.3}\n",
                start - cursor
            ));
        }
        list.push_str(&format!(
            "file '{}.png'\nduration {:.3}\n",
            cue.seq,
            end - start
        ));
        cursor = end;
    }
    // Concat-demuxer slideshow convention: the final entry's duration is
    // unreliable, so close with a short blank and repeat it.
    list.push_str(&format!("file '{blank_seq}.png'\nduration 0.100\n"));
    list.push_str(&format!("file '{blank_seq}.png'\n"));
    list
}

/// Kick off the cue-frame render round-trip (R2): ask the renderer for one
/// full-frame transparent PNG per cue (plus the blank gap frame), collect
/// them under `<recording>.captions-frames/`, and hand off to the overlay
/// burn when complete. A watchdog degrades to SRT-only if frames don't
/// arrive (renderer closed, error) — the session is never affected.
pub async fn begin_caption_cue_render(
    state: &AppState,
    session_id: &str,
    ffmpeg_path: &str,
    recording_path: &std::path::Path,
    artifact: &FinalizedCaptionArtifact,
) {
    let cues = caption_cues(&artifact.chunks);
    if cues.is_empty() {
        return;
    }
    let frames_dir = recording_path.with_extension("captions-frames");
    if let Err(error) = tokio::fs::create_dir_all(&frames_dir).await {
        let _ = crate::recording::emit_health_event(
            state,
            Some(session_id),
            crate::protocol::HealthLevel::Warn,
            "captions-burn-failed",
            &format!("Could not prepare caption frames: {error}"),
        );
        return;
    }

    let request_id = format!("cues-{}", uuid::Uuid::new_v4().simple());
    {
        let mut coordinator = state.captions.lock().await;
        if coordinator.artifact_generation != artifact.artifact_generation {
            drop(coordinator);
            let _ = tokio::fs::remove_dir_all(&frames_dir).await;
            return;
        }
        let mut expected: std::collections::BTreeSet<u64> =
            cues.iter().map(|cue| cue.seq).collect();
        expected.insert(CAPTION_BLANK_FRAME_SEQ);
        coordinator.pending_cue_renders.insert(
            request_id.clone(),
            PendingCueRender {
                session_id: session_id.to_string(),
                ffmpeg_path: ffmpeg_path.to_string(),
                recording_path: recording_path.to_path_buf(),
                frames_dir: frames_dir.clone(),
                cues: cues.clone(),
                expected,
                received: std::collections::BTreeSet::new(),
                artifact_generation: artifact.artifact_generation,
                last_progress_at: tokio::time::Instant::now(),
                watchdog_active: false,
            },
        );
        coordinator
            .pending_cue_render_order
            .push_back(request_id.clone());
        // Transcript-bearing emission is part of the same privacy-generation
        // critical section as registration. Sign-out either observes and
        // purges this request, or wins first and suppresses the event.
        state.emit_event(
            "captions.cues.render-request",
            serde_json::json!({
                "requestId": request_id,
                "canvasWidth": artifact.style.output_width.max(2),
                "canvasHeight": artifact.style.output_height.max(2),
                "position": artifact.style.position,
                "textSize": artifact.style.text_size,
                "styleId": artifact.style.style_id,
                "styleRevision": artifact.style.style_revision,
                "blankSeq": CAPTION_BLANK_FRAME_SEQ,
                "cues": cues
                    .iter()
                    .map(|cue| serde_json::json!({ "seq": cue.seq, "text": cue.text }))
                    .collect::<Vec<_>>(),
            }),
        );
    }

    // Progress watchdog: a many-cue 4K render may legitimately exceed thirty
    // seconds in total. It only degrades when no new requested frame arrives
    // for the full inactivity interval.
    let watchdog_state = state.clone();
    let watchdog_request = request_id.clone();
    tokio::spawn(async move {
        loop {
            let watchdog = {
                let mut coordinator = watchdog_state.captions.lock().await;
                pending_cue_render_watchdog_state(
                    &mut coordinator,
                    &watchdog_request,
                    tokio::time::Instant::now(),
                )
            };
            let deadline = match watchdog {
                CueRenderWatchdogState::Missing => return,
                CueRenderWatchdogState::Queued => {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
                CueRenderWatchdogState::ActiveUntil(deadline) => deadline,
            };
            tokio::time::sleep_until(deadline).await;
            let pending = {
                let mut coordinator = watchdog_state.captions.lock().await;
                if coordinator.pending_cue_render_order.front() != Some(&watchdog_request) {
                    continue;
                }
                let Some(pending) = coordinator.pending_cue_renders.get(&watchdog_request) else {
                    return;
                };
                if cue_render_is_inactive(pending.last_progress_at, tokio::time::Instant::now()) {
                    let pending = remove_pending_cue_render(&mut coordinator, &watchdog_request);
                    if let Some(pending) = pending.as_ref() {
                        // Keep the generation coordinator locked until private
                        // frame cleanup finishes, so sign-out cannot miss an
                        // already-removed request and return ahead of deletion.
                        let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
                    }
                    pending
                } else {
                    None
                }
            };
            let Some(pending) = pending else {
                continue;
            };
            let _ = crate::recording::emit_health_event(
                &watchdog_state,
                Some(&pending.session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-burn-failed",
                "Caption frame rendering stopped making progress; the .srt sidecar is still available.",
            );
            return;
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CueRenderWatchdogState {
    Missing,
    Queued,
    ActiveUntil(tokio::time::Instant),
}

fn pending_cue_render_watchdog_state(
    coordinator: &mut CaptionsCoordinator,
    request_id: &str,
    now: tokio::time::Instant,
) -> CueRenderWatchdogState {
    let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id) else {
        return CueRenderWatchdogState::Missing;
    };
    if coordinator
        .pending_cue_render_order
        .front()
        .map(String::as_str)
        != Some(request_id)
    {
        return CueRenderWatchdogState::Queued;
    }
    if !pending.watchdog_active {
        pending.watchdog_active = true;
        pending.last_progress_at = now;
    }
    CueRenderWatchdogState::ActiveUntil(cue_render_inactivity_deadline(pending.last_progress_at))
}

fn cue_render_inactivity_deadline(last_progress_at: tokio::time::Instant) -> tokio::time::Instant {
    last_progress_at + CAPTION_CUE_RENDER_INACTIVITY_TIMEOUT
}

fn cue_render_is_inactive(
    last_progress_at: tokio::time::Instant,
    now: tokio::time::Instant,
) -> bool {
    now.saturating_duration_since(last_progress_at) >= CAPTION_CUE_RENDER_INACTIVITY_TIMEOUT
}

/// One rendered cue frame from the renderer. Returns whether the request is
/// now complete (which triggers the overlay burn).
pub async fn submit_caption_cue_frame(
    state: &AppState,
    request_id: &str,
    seq: u64,
    png_base64: &str,
) -> Result<bool> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| anyhow::anyhow!("Caption frame payload is not valid base64."))?;
    if bytes.is_empty() || bytes.len() > OVERLAY_MAX_ENCODED_BYTES {
        bail!("Caption frame payload size is out of range.");
    }

    let (completed, finished_burn_tasks) = {
        let mut coordinator = state.captions.lock().await;
        let watchdog_active = coordinator
            .pending_cue_render_order
            .front()
            .map(String::as_str)
            == Some(request_id);
        let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id) else {
            bail!("Caption frame request is stale.");
        };
        if !pending.expected.contains(&seq) {
            bail!("Caption frame seq {seq} was not requested.");
        }
        let path = pending.frames_dir.join(format!("{seq}.png"));
        std::fs::write(&path, &bytes)
            .map_err(|error| anyhow::anyhow!("Could not store caption frame: {error}"))?;
        if pending.received.insert(seq) {
            pending.last_progress_at = tokio::time::Instant::now();
            pending.watchdog_active = watchdog_active;
        }
        if pending.received == pending.expected {
            let pending = remove_pending_cue_render(&mut coordinator, request_id)
                .expect("completed caption render remains installed");
            let finished = take_finished_caption_burn_tasks(&mut coordinator);
            register_caption_overlay_burn(state.clone(), pending, &mut coordinator);
            (true, finished)
        } else {
            (false, Vec::new())
        }
    };

    for task in finished_burn_tasks {
        let _ = task.join.await;
    }
    Ok(completed)
}

/// Burn the aligned captions into a `(captioned)` copy of the recording:
/// renderer-supplied full-frame cue PNGs play as a concat track and composite
/// with the CORE `overlay` filter — works with the bundled dependency-free
/// ffmpeg (no libass). Runs through the idle-aware ffmpeg coordinator; the
/// original file is never touched; failures degrade to SRT-only with a
/// health warning. Not restart-resumable (v1).
fn register_caption_overlay_burn(
    state: AppState,
    pending: PendingCueRender,
    coordinator: &mut CaptionsCoordinator,
) {
    debug_assert_eq!(
        pending.artifact_generation, coordinator.artifact_generation,
        "sign-out must take a pending render before it can register a burn task"
    );
    let output_path = captioned_copy_path(&pending.recording_path);
    let frames_dir = pending.frames_dir.clone();
    let (cancel, cancel_receiver) = watch::channel(false);
    let task_state = state.clone();
    let join = tokio::spawn(async move {
        run_caption_overlay_burn(task_state, pending, cancel_receiver).await;
    });
    coordinator.caption_burn_tasks.push(CaptionBurnTask {
        cancel,
        join,
        output_path,
        frames_dir,
    });
}

fn take_finished_caption_burn_tasks(coordinator: &mut CaptionsCoordinator) -> Vec<CaptionBurnTask> {
    let mut active = Vec::with_capacity(coordinator.caption_burn_tasks.len());
    let mut finished = Vec::new();
    for task in std::mem::take(&mut coordinator.caption_burn_tasks) {
        if task.join.is_finished() {
            finished.push(task);
        } else {
            active.push(task);
        }
    }
    coordinator.caption_burn_tasks = active;
    finished
}

fn remove_pending_cue_render(
    coordinator: &mut CaptionsCoordinator,
    request_id: &str,
) -> Option<PendingCueRender> {
    let pending = coordinator.pending_cue_renders.remove(request_id)?;
    coordinator
        .pending_cue_render_order
        .retain(|queued| queued != request_id);
    Some(pending)
}

fn take_pending_caption_frame_dirs(
    coordinator: &mut CaptionsCoordinator,
) -> Vec<std::path::PathBuf> {
    coordinator.pending_cue_render_order.clear();
    std::mem::take(&mut coordinator.pending_cue_renders)
        .into_values()
        .map(|pending| pending.frames_dir)
        .collect()
}

async fn wait_for_caption_burn_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
}

fn caption_burn_cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow()
}

fn caption_burn_can_publish_ready(
    cancelled: bool,
    artifact_generation: u64,
    current_generation: u64,
) -> bool {
    !cancelled && artifact_generation == current_generation
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptionBurnInterruption {
    RetryAfterCapture,
    CancelForSignOut,
}

fn caption_burn_interruption(
    sign_out_cancelled: bool,
    capture_cancelled: bool,
) -> Option<CaptionBurnInterruption> {
    if sign_out_cancelled {
        Some(CaptionBurnInterruption::CancelForSignOut)
    } else if capture_cancelled {
        Some(CaptionBurnInterruption::RetryAfterCapture)
    } else {
        None
    }
}

async fn run_caption_overlay_burn(
    state: AppState,
    pending: PendingCueRender,
    mut sign_out_cancel: watch::Receiver<bool>,
) {
    let output_path = captioned_copy_path(&pending.recording_path);
    let outcome = async {
        if caption_burn_cancelled(&sign_out_cancel) {
            return Err("signed out; captioned copy cancelled".to_string());
        }
        let list = build_caption_track_concat(&pending.cues, CAPTION_BLANK_FRAME_SEQ);
        let list_path = pending.frames_dir.join("track.ffconcat");
        tokio::fs::write(&list_path, &list)
            .await
            .map_err(|error| format!("could not write the caption track list: {error}"))?;

        // Wait out the same idle window as the quality gates, then hold the
        // maintenance permit so the encode never competes with a capture. Both
        // waits are interruptible at the sign-out privacy boundary.
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
            _ = wait_for_caption_burn_cancel(&mut sign_out_cancel) => {
                return Err("signed out; captioned copy cancelled".to_string());
            }
        }
        // A new capture preempts maintenance, but does not invalidate a
        // finalized artifact. Drop the partial output and reacquire the next
        // idle permit until the burn completes. Sign-out remains terminal.
        'retry_after_capture: loop {
            let maintenance = tokio::select! {
                maintenance = state.ffmpeg_work.begin_maintenance_when_idle() => maintenance,
                _ = wait_for_caption_burn_cancel(&mut sign_out_cancel) => {
                    return Err("signed out; captioned copy cancelled".to_string());
                }
            };
            let capture_cancel = maintenance.cancel_token();
            if caption_burn_cancelled(&sign_out_cancel) {
                return Err("signed out; captioned copy cancelled".to_string());
            }
            state.emit_log(
                "info",
                format!("Burning captions into {}.", output_path.display()),
            );

            let mut command = tokio::process::Command::new(&pending.ffmpeg_path);
            command
                .arg("-y")
                .arg("-i")
                .arg(&pending.recording_path)
                .arg("-f")
                .arg("concat")
                .arg("-i")
                .arg(&list_path)
                .arg("-filter_complex")
                .arg("[0:v][1:v]overlay=eof_action=pass")
                .arg("-c:a")
                .arg("copy")
                .arg(&output_path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            command.kill_on_drop(true);
            let mut child = spawn_owned_tokio(&mut command).map_err(|error| {
                format!("could not start ffmpeg for the captioned copy: {error}")
            })?;

            loop {
                match caption_burn_interruption(
                    caption_burn_cancelled(&sign_out_cancel),
                    capture_cancel.is_cancelled(),
                ) {
                    Some(CaptionBurnInterruption::CancelForSignOut) => {
                        let _ = child.kill().await;
                        return Err("signed out; captioned copy cancelled".to_string());
                    }
                    Some(CaptionBurnInterruption::RetryAfterCapture) => {
                        let _ = child.kill().await;
                        let _ = tokio::fs::remove_file(&output_path).await;
                        state.emit_log(
                            "info",
                            "Captioned copy paused for a new capture; it will resume when capture is idle.",
                        );
                        continue 'retry_after_capture;
                    }
                    None => {}
                }
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => return Err(format!("ffmpeg exited with {status}")),
                    Ok(None) => {
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
                            _ = wait_for_caption_burn_cancel(&mut sign_out_cancel) => {
                                let _ = child.kill().await;
                                return Err("signed out; captioned copy cancelled".to_string());
                            }
                        }
                    }
                    Err(error) => return Err(format!("could not wait for ffmpeg: {error}")),
                }
            }
        }
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
    match outcome {
        Ok(()) => {
            // Hold the generation lock through publication. Either this event
            // wins before sign-out advances the generation, or sign-out wins
            // and this task removes the output without publishing readiness.
            let coordinator = state.captions.lock().await;
            let publish_ready = caption_burn_can_publish_ready(
                caption_burn_cancelled(&sign_out_cancel),
                pending.artifact_generation,
                coordinator.artifact_generation,
            );
            if publish_ready {
                let _ = crate::recording::emit_health_event(
                    &state,
                    Some(&pending.session_id),
                    crate::protocol::HealthLevel::Info,
                    "captions-burned-copy-ready",
                    &format!("Captioned copy saved to {}.", output_path.display()),
                );
            }
            drop(coordinator);
            if !publish_ready {
                let _ = tokio::fs::remove_file(&output_path).await;
            }
        }
        Err(reason) => {
            let _ = tokio::fs::remove_file(&output_path).await;
            if !reason.starts_with("signed out") {
                let _ = crate::recording::emit_health_event(
                    &state,
                    Some(&pending.session_id),
                    crate::protocol::HealthLevel::Warn,
                    "captions-burn-failed",
                    &format!(
                        "Captioned copy was not created ({reason}); the .srt sidecar is still available."
                    ),
                );
            }
        }
    }
}

async fn cancel_and_join_caption_burn_tasks(tasks: Vec<CaptionBurnTask>) {
    let tasks = tasks
        .into_iter()
        .map(|task| {
            let cancelled = !task.join.is_finished();
            if cancelled {
                let _ = task.cancel.send(true);
            }
            (task, cancelled)
        })
        .collect::<Vec<_>>();

    for (task, cancelled) in tasks {
        let _ = task.join.await;
        let _ = tokio::fs::remove_dir_all(&task.frames_dir).await;
        if cancelled {
            let _ = tokio::fs::remove_file(&task.output_path).await;
        }
    }
}

async fn remove_pending_caption_frame_dirs(frames_dirs: Vec<std::path::PathBuf>) {
    for frames_dir in frames_dirs {
        if let Err(error) = tokio::fs::remove_dir_all(&frames_dir).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                "Could not remove caption frame cache {}: {error}",
                frames_dir.display()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Burn-in overlay: a pre-rendered caption bar (RGBA) the compositor composites
// into the STREAM leg. Session-transient — set/cleared by the renderer as
// captions flow; never persisted, never part of scene config. Fail-safe per
// the background rule: bad image data is rejected and the previous overlay
// (if any) stays; a session is never touched by overlay errors.
// ---------------------------------------------------------------------------

/// Max decoded dimensions / encoded bytes for one caption bar. A 4K-width
/// two-line bar is ~3840×400; these caps leave headroom without letting the
/// RPC become an arbitrary-image firehose.
const OVERLAY_MAX_WIDTH: u32 = 4096;
const OVERLAY_MAX_HEIGHT: u32 = 2048;
const OVERLAY_MAX_ENCODED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionOverlayPosition {
    Top,
    #[default]
    Bottom,
}

#[derive(Debug, Clone)]
pub struct CaptionOverlay {
    pub rgba: Arc<Vec<u8>>,
    pub bgra: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub position: CaptionOverlayPosition,
    pub revision: u64,
}

pub type CaptionOverlaySlot = Arc<std::sync::Mutex<Option<CaptionOverlay>>>;

pub fn new_caption_overlay_slot() -> CaptionOverlaySlot {
    Arc::new(std::sync::Mutex::new(None))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionOverlayTarget {
    Primary,
    Auxiliary,
}

#[derive(Clone, Default)]
pub struct CaptionOverlaySlots {
    inner: Arc<std::sync::Mutex<CaptionOverlaySlotsState>>,
}

#[derive(Default)]
struct CaptionOverlaySlotsState {
    primary: CaptionOverlayTargetState,
    auxiliary: CaptionOverlayTargetState,
}

#[derive(Default)]
struct CaptionOverlayTargetState {
    overlay: Option<CaptionOverlay>,
    revision: u64,
    style_revision: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct CaptionOverlaySlotsSnapshot {
    pub primary: Option<CaptionOverlay>,
    pub auxiliary: Option<CaptionOverlay>,
}

pub fn new_caption_overlay_slots() -> CaptionOverlaySlots {
    CaptionOverlaySlots::default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOverlayInfo {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOverlayTargetInfo {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub revision: u64,
    pub style_revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOverlayTargetsInfo {
    /// Compatibility field used by existing renderer/smoke callers.
    pub active: bool,
    pub primary: CaptionOverlayTargetInfo,
    pub auxiliary: CaptionOverlayTargetInfo,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCaptionOverlayParams {
    pub png_base64: String,
    #[serde(default)]
    pub position: CaptionOverlayPosition,
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
    #[serde(default)]
    pub style_revision: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCaptionOverlayParams {
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
    #[serde(default)]
    pub style_revision: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
#[error(
    "Caption overlay style revision {received} is stale for {target:?}; current revision is {current}."
)]
struct StaleCaptionOverlayRevision {
    target: CaptionOverlayTarget,
    received: u64,
    current: u64,
}

pub fn caption_overlay_error_code(error: &anyhow::Error) -> &'static str {
    if error
        .downcast_ref::<StaleCaptionOverlayRevision>()
        .is_some()
    {
        "captions-overlay-stale"
    } else {
        "captions-overlay-invalid"
    }
}

/// Decode + validate a caption bar and install it in the overlay slot.
/// Rejects oversized or undecodable payloads without touching the current
/// overlay. Pure with respect to the slot — unit-tested directly.
pub fn install_caption_overlay(
    slot: &CaptionOverlaySlot,
    png_base64: &str,
    position: CaptionOverlayPosition,
) -> Result<CaptionOverlayInfo> {
    let decoded = decode_caption_overlay(png_base64)?;
    let mut guard = slot.lock().expect("caption overlay lock");
    let revision = guard.as_ref().map_or(1, |overlay| overlay.revision + 1);
    *guard = Some(CaptionOverlay {
        rgba: decoded.rgba,
        bgra: decoded.bgra,
        width: decoded.width,
        height: decoded.height,
        position,
        revision,
    });
    Ok(CaptionOverlayInfo {
        active: true,
        width: decoded.width,
        height: decoded.height,
        revision,
    })
}

struct DecodedCaptionOverlay {
    rgba: Arc<Vec<u8>>,
    bgra: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

fn decode_caption_overlay(png_base64: &str) -> Result<DecodedCaptionOverlay> {
    use base64::Engine as _;

    let encoded_len = png_base64.len();
    if encoded_len == 0 || encoded_len > (OVERLAY_MAX_ENCODED_BYTES / 3) * 4 + 4 {
        bail!("Caption overlay payload is empty or too large.");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| anyhow::anyhow!("Caption overlay payload is not valid base64."))?;
    if bytes.len() > OVERLAY_MAX_ENCODED_BYTES {
        bail!("Caption overlay image is too large.");
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|_| anyhow::anyhow!("Caption overlay image could not be decoded."))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width > OVERLAY_MAX_WIDTH || height > OVERLAY_MAX_HEIGHT {
        bail!("Caption overlay dimensions are out of range ({width}x{height}).");
    }

    let rgba = Arc::new(image.into_raw());
    let bgra = Arc::new(
        rgba.chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect(),
    );
    Ok(DecodedCaptionOverlay {
        rgba,
        bgra,
        width,
        height,
    })
}

pub fn clear_caption_overlay(slot: &CaptionOverlaySlot) -> CaptionOverlayInfo {
    let mut guard = slot.lock().expect("caption overlay lock");
    let revision = guard.as_ref().map_or(0, |overlay| overlay.revision);
    *guard = None;
    CaptionOverlayInfo {
        active: false,
        width: 0,
        height: 0,
        revision,
    }
}

pub fn current_caption_overlay(slot: &CaptionOverlaySlot) -> Option<CaptionOverlay> {
    slot.lock().expect("caption overlay lock").clone()
}

pub fn install_caption_overlays(
    slots: &CaptionOverlaySlots,
    params: SetCaptionOverlayParams,
) -> Result<CaptionOverlayTargetsInfo> {
    let decoded = decode_caption_overlay(&params.png_base64)?;
    let mut guard = slots.inner.lock().expect("caption overlay slots lock");
    validate_overlay_style_revision(&guard, params.target, params.style_revision)?;

    if params
        .target
        .is_none_or(|target| target == CaptionOverlayTarget::Primary)
    {
        install_decoded_caption_overlay(
            &mut guard.primary,
            &decoded,
            params.position,
            params.style_revision,
        );
    }
    if params
        .target
        .is_none_or(|target| target == CaptionOverlayTarget::Auxiliary)
    {
        install_decoded_caption_overlay(
            &mut guard.auxiliary,
            &decoded,
            params.position,
            params.style_revision,
        );
    }
    Ok(caption_overlay_targets_info(&guard))
}

pub fn clear_caption_overlays(
    slots: &CaptionOverlaySlots,
    params: ClearCaptionOverlayParams,
) -> Result<CaptionOverlayTargetsInfo> {
    let mut guard = slots.inner.lock().expect("caption overlay slots lock");
    validate_overlay_style_revision(&guard, params.target, params.style_revision)?;
    if params
        .target
        .is_none_or(|target| target == CaptionOverlayTarget::Primary)
    {
        clear_caption_overlay_target(&mut guard.primary, params.style_revision);
    }
    if params
        .target
        .is_none_or(|target| target == CaptionOverlayTarget::Auxiliary)
    {
        clear_caption_overlay_target(&mut guard.auxiliary, params.style_revision);
    }
    Ok(caption_overlay_targets_info(&guard))
}

pub fn current_caption_overlays(slots: &CaptionOverlaySlots) -> CaptionOverlaySlotsSnapshot {
    let guard = slots.inner.lock().expect("caption overlay slots lock");
    CaptionOverlaySlotsSnapshot {
        primary: guard.primary.overlay.clone(),
        auxiliary: guard.auxiliary.overlay.clone(),
    }
}

pub fn caption_overlay_targets_metadata(slots: &CaptionOverlaySlots) -> CaptionOverlayTargetsInfo {
    let guard = slots.inner.lock().expect("caption overlay slots lock");
    caption_overlay_targets_info(&guard)
}

fn validate_overlay_style_revision(
    state: &CaptionOverlaySlotsState,
    target: Option<CaptionOverlayTarget>,
    requested: Option<u64>,
) -> Result<()> {
    let Some(received) = requested else {
        return Ok(());
    };
    for (candidate_target, candidate) in [
        (CaptionOverlayTarget::Primary, &state.primary),
        (CaptionOverlayTarget::Auxiliary, &state.auxiliary),
    ] {
        if target.is_some_and(|target| target != candidate_target) {
            continue;
        }
        if let Some(current) = candidate.style_revision
            && received < current
        {
            return Err(StaleCaptionOverlayRevision {
                target: candidate_target,
                received,
                current,
            }
            .into());
        }
    }
    Ok(())
}

fn install_decoded_caption_overlay(
    target: &mut CaptionOverlayTargetState,
    decoded: &DecodedCaptionOverlay,
    position: CaptionOverlayPosition,
    style_revision: Option<u64>,
) {
    target.revision = target.revision.saturating_add(1);
    if let Some(style_revision) = style_revision {
        target.style_revision = Some(style_revision);
    }
    target.overlay = Some(CaptionOverlay {
        rgba: decoded.rgba.clone(),
        bgra: decoded.bgra.clone(),
        width: decoded.width,
        height: decoded.height,
        position,
        revision: target.revision,
    });
}

fn clear_caption_overlay_target(
    target: &mut CaptionOverlayTargetState,
    style_revision: Option<u64>,
) {
    if let Some(style_revision) = style_revision {
        target.style_revision = Some(style_revision);
    }
    target.overlay = None;
}

fn caption_overlay_targets_info(state: &CaptionOverlaySlotsState) -> CaptionOverlayTargetsInfo {
    let primary = caption_overlay_target_info(&state.primary);
    let auxiliary = caption_overlay_target_info(&state.auxiliary);
    CaptionOverlayTargetsInfo {
        active: primary.active || auxiliary.active,
        primary,
        auxiliary,
    }
}

fn caption_overlay_target_info(state: &CaptionOverlayTargetState) -> CaptionOverlayTargetInfo {
    CaptionOverlayTargetInfo {
        active: state.overlay.is_some(),
        width: state.overlay.as_ref().map_or(0, |overlay| overlay.width),
        height: state.overlay.as_ref().map_or(0, |overlay| overlay.height),
        revision: state.revision,
        style_revision: state.style_revision.unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Session state machine.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionsState {
    Idle,
    /// Persisted opt-in is on, but no capture session owns the audio bus.
    Ready,
    /// Preflight/transport setup is in progress; never present this as live.
    Starting,
    /// Provider configuration is acknowledged and caption audio frames flow.
    Listening,
    /// Realtime transport is reconnecting within its bounded retry budget.
    Reconnecting,
    /// Chunked fallback is working at higher latency.
    Degraded,
    /// Captions cannot start without a user/deployment/platform change.
    Blocked,
    /// Reserved for unexpected coordinator failures rather than actionable
    /// auth/config/audio-path blockers.
    #[allow(dead_code)]
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionsTransport {
    Realtime,
    Chunked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionAudioSource {
    Microphone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsStatus {
    pub state: CaptionsState,
    pub desired_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<CaptionsTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_source: Option<CaptionAudioSource>,
    pub audio_frames_seen: u64,
    pub dropped_audio_frames: u64,
    pub dropped_audio_seconds: f64,
    pub provider_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_client_id: Option<String>,
}

impl CaptionsStatus {
    pub fn idle() -> Self {
        Self {
            state: CaptionsState::Idle,
            desired_enabled: false,
            transport: None,
            audio_source: None,
            audio_frames_seen: 0,
            dropped_audio_frames: 0,
            dropped_audio_seconds: 0.0,
            provider_ready: false,
            reason_code: None,
            message: None,
            remaining_seconds: None,
            session_client_id: None,
        }
    }

    fn ready() -> Self {
        Self {
            state: CaptionsState::Ready,
            desired_enabled: true,
            transport: None,
            audio_source: Some(CaptionAudioSource::Microphone),
            audio_frames_seen: 0,
            dropped_audio_frames: 0,
            dropped_audio_seconds: 0.0,
            provider_ready: false,
            reason_code: None,
            message: Some("Captions will start with the next capture session.".to_string()),
            remaining_seconds: None,
            session_client_id: None,
        }
    }

    fn active(state: CaptionsState, transport: CaptionsTransport, session_client_id: &str) -> Self {
        Self {
            state,
            desired_enabled: true,
            transport: Some(transport),
            audio_source: Some(CaptionAudioSource::Microphone),
            audio_frames_seen: TAP_FRAMES_SEEN.load(Ordering::Relaxed),
            dropped_audio_frames: TAP_FRAMES_DROPPED.load(Ordering::Relaxed),
            dropped_audio_seconds: caption_audio_seconds_dropped(),
            provider_ready: false,
            reason_code: None,
            message: None,
            remaining_seconds: None,
            session_client_id: Some(session_client_id.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionUpdateKind {
    /// Streaming hypothesis for an utterance still in flight — REPLACES the
    /// previous partial with the same seq.
    Partial,
    /// Settled text (chunked transcription is always final).
    Final,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsUpdate {
    pub session_client_id: String,
    pub seq: u64,
    pub kind: CaptionUpdateKind,
    pub text: String,
    pub chunk_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionContractTestSnapshot {
    pub status: CaptionsStatus,
    pub chunk_count: usize,
    pub canonical_cues: Vec<CaptionContractTestCue>,
    pub dropped_audio_frames: u64,
    pub overlays: CaptionOverlayTargetsInfo,
}

#[cfg(debug_assertions)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionContractTestCue {
    pub seq: u64,
    pub text: String,
    pub capture_epoch: u64,
}

#[derive(Default)]
pub struct CaptionsCoordinator {
    task: Option<tokio::task::JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
    status: Option<CaptionsStatus>,
    desired_enabled: bool,
    language: Option<String>,
    /// Transcribed chunks awaiting the post-recording pass (drained +
    /// epoch-filtered at session stop).
    chunks: Vec<CaptionChunkRecord>,
    /// Bumped by the caption session on every capture-pipeline restart
    /// (frame-timestamp regression); finalize keeps only current-epoch
    /// records.
    capture_epoch: u64,
    /// One allocator per capture, shared by every off/on provider runtime.
    /// Artifact cue-frame filenames use `seq`, so toggling captions must not
    /// restart this namespace until a genuinely new capture begins.
    sequence: CaptionSequence,
    /// Live style plus the end-of-capture snapshot used for the one-style
    /// captioned copy. The frozen copy cannot drift during MP4 export.
    style: CaptionStyleSnapshot,
    finalized_style: Option<CaptionStyleSnapshot>,
    /// In-flight cue-frame render requests (R2), retained independently across
    /// back-to-back captures. The renderer serializes them, but submissions are
    /// keyed so a newer request can never replace or stale an older artifact.
    pending_cue_renders: std::collections::BTreeMap<String, PendingCueRender>,
    /// Renderer requests are emitted eagerly but processed as a mutable FIFO.
    /// Only the head spends inactivity budget; queued requests start a fresh
    /// watchdog window when promoted.
    pending_cue_render_order: std::collections::VecDeque<String>,
    /// Burn jobs remain owned until joined. Sign-out cancels every in-flight
    /// job before credentials are removed, preventing a transcript-bearing
    /// output from appearing after the privacy boundary.
    caption_burn_tasks: Vec<CaptionBurnTask>,
    /// Invalidates a frame-complete request racing sign-out before it can
    /// install its burn task in `caption_burn_tasks`.
    artifact_generation: u64,
}

pub struct PendingCueRender {
    pub session_id: String,
    pub ffmpeg_path: String,
    pub recording_path: std::path::PathBuf,
    pub frames_dir: std::path::PathBuf,
    pub cues: Vec<CaptionCue>,
    pub expected: std::collections::BTreeSet<u64>,
    pub received: std::collections::BTreeSet<u64>,
    artifact_generation: u64,
    last_progress_at: tokio::time::Instant,
    watchdog_active: bool,
}

struct CaptionBurnTask {
    cancel: watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
    output_path: std::path::PathBuf,
    frames_dir: std::path::PathBuf,
}

/// The blank (fully transparent) gap frame's pseudo-seq in a render request.
pub const CAPTION_BLANK_FRAME_SEQ: u64 = 0;

/// Stash the caption style + output size for this session (used by the
/// burned copy's cue frames).
pub async fn set_caption_session_style(
    state: &AppState,
    position: CaptionOverlayPosition,
    text_size: CaptionTextSize,
    style_id: CaptionStyleId,
    style_revision: u64,
    output_width: u32,
    output_height: u32,
) {
    let mut coordinator = state.captions.lock().await;
    let discarded = advance_caption_capture_epoch_and_purge(&mut coordinator);
    if discarded > 0 {
        tracing::info!("Discarded {discarded} stale caption cue(s) at the new capture boundary.");
    }
    coordinator.style = CaptionStyleSnapshot {
        position,
        text_size,
        style_id,
        style_revision,
        output_width,
        output_height,
    };
}

pub async fn update_caption_style(
    state: &AppState,
    params: SetCaptionStyleParams,
) -> Result<CaptionStyleSnapshot> {
    let mut coordinator = state.captions.lock().await;
    coordinator.style = apply_caption_style_update(coordinator.style, params)?;
    Ok(coordinator.style)
}

fn apply_caption_style_update(
    current: CaptionStyleSnapshot,
    params: SetCaptionStyleParams,
) -> Result<CaptionStyleSnapshot> {
    if params.style_revision < current.style_revision {
        return Err(StaleCaptionStyleRevision {
            received: params.style_revision,
            current: current.style_revision,
        }
        .into());
    }
    Ok(CaptionStyleSnapshot {
        position: params.position,
        text_size: params.text_size,
        style_id: params.style_id,
        style_revision: params.style_revision,
        ..current
    })
}

fn caption_style_for_final_artifact(
    finalized: Option<CaptionStyleSnapshot>,
    current: CaptionStyleSnapshot,
) -> CaptionStyleSnapshot {
    finalized.unwrap_or(current)
}

pub type CaptionsSlot = Arc<Mutex<CaptionsCoordinator>>;

pub fn new_captions_slot() -> CaptionsSlot {
    Arc::new(Mutex::new(CaptionsCoordinator::default()))
}

#[cfg(test)]
pub struct CaptionSignOutTestProbe {
    frames_received: Arc<AtomicU64>,
    task_finished: Arc<AtomicBool>,
}

#[cfg(test)]
struct CaptionTestTaskFinished(Arc<AtomicBool>);

#[cfg(test)]
impl Drop for CaptionTestTaskFinished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[cfg(test)]
impl CaptionSignOutTestProbe {
    pub fn frames_received(&self) -> u64 {
        self.frames_received.load(Ordering::Acquire)
    }

    pub fn task_finished(&self) -> bool {
        self.task_finished.load(Ordering::Acquire)
    }
}

/// Deterministic opt-out probe: audio can be queued while the consumer is
/// paused, then the test releases it only after the stop boundary has taken
/// ownership of the task. A privacy stop must exit without consuming any of
/// those queued frames; capture finalization is the only draining boundary.
#[cfg(test)]
pub struct CaptionQueuedAudioTestProbe {
    frames_received: Arc<AtomicU64>,
    task_started: Arc<AtomicBool>,
    release_consumer: Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
impl CaptionQueuedAudioTestProbe {
    pub fn frames_received(&self) -> u64 {
        self.frames_received.load(Ordering::Acquire)
    }

    pub fn task_started(&self) -> bool {
        self.task_started.load(Ordering::Acquire)
    }

    pub fn release(&self) {
        self.release_consumer.add_permits(1);
    }
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub struct CaptionSignOutTestSnapshot {
    pub task_present: bool,
    pub stop_present: bool,
    pub desired_enabled: bool,
    pub language_present: bool,
    pub chunk_count: usize,
    pub finalized_style_present: bool,
    pub tap_active: bool,
    pub primary_overlay_active: bool,
    pub auxiliary_overlay_active: bool,
}

/// Installs a deterministic active caption task without touching account
/// secrets or the network. The command-dispatch regression uses this seam to
/// prove that sign-out joins the task and disconnects the real global tap.
#[cfg(test)]
pub async fn install_caption_sign_out_test_session(state: &AppState) -> CaptionSignOutTestProbe {
    let mut receiver = install_tap();
    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = stop.clone();
    let frames_received = Arc::new(AtomicU64::new(0));
    let task_frames_received = frames_received.clone();
    let task_finished = Arc::new(AtomicBool::new(false));
    let task_finished_signal = task_finished.clone();
    let task = tokio::spawn(async move {
        // Cancellation is also completion. The guard makes the probe observe
        // abort+join as finished before credential removal.
        let _finished = CaptionTestTaskFinished(task_finished_signal);
        loop {
            if task_stop.load(Ordering::Acquire) {
                break;
            }
            match tokio::time::timeout(std::time::Duration::from_millis(10), receiver.recv()).await
            {
                Ok(Some(_)) => {
                    task_frames_received.fetch_add(1, Ordering::AcqRel);
                }
                Ok(None) => break,
                Err(_) => {}
            }
        }
    });

    {
        let mut coordinator = state.captions.lock().await;
        coordinator.task = Some(task);
        coordinator.stop = Some(stop);
        coordinator.desired_enabled = true;
        coordinator.language = Some("en".to_string());
        let capture_epoch = coordinator.capture_epoch;
        coordinator.chunks.push(CaptionChunkRecord {
            seq: 1,
            offset_seconds: 0.0,
            duration_seconds: 1.0,
            text: "private caption".to_string(),
            segments: Vec::new(),
            capture_epoch,
            provider_item_id: Some("private-item".to_string()),
        });
        coordinator.finalized_style = Some(coordinator.style);
        coordinator.status = Some(CaptionsStatus::active(
            CaptionsState::Listening,
            CaptionsTransport::Realtime,
            "captions-sign-out-test",
        ));
    }

    {
        let mut overlays = state
            .caption_overlay
            .inner
            .lock()
            .expect("caption overlay slots lock");
        let overlay = CaptionOverlay {
            rgba: Arc::new(vec![255, 255, 255, 255]),
            bgra: Arc::new(vec![255, 255, 255, 255]),
            width: 1,
            height: 1,
            position: CaptionOverlayPosition::Bottom,
            revision: 1,
        };
        overlays.primary.overlay = Some(overlay.clone());
        overlays.primary.revision = 1;
        overlays.auxiliary.overlay = Some(overlay);
        overlays.auxiliary.revision = 1;
    }

    CaptionSignOutTestProbe {
        frames_received,
        task_finished,
    }
}

#[cfg(test)]
pub async fn install_caption_queued_audio_test_session(
    state: &AppState,
) -> CaptionQueuedAudioTestProbe {
    let mut receiver = install_tap();
    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = stop.clone();
    let frames_received = Arc::new(AtomicU64::new(0));
    let task_frames_received = frames_received.clone();
    let task_started = Arc::new(AtomicBool::new(false));
    let task_started_signal = task_started.clone();
    let release_consumer = Arc::new(tokio::sync::Semaphore::new(0));
    let task_release_consumer = release_consumer.clone();
    let task = tokio::spawn(async move {
        task_started_signal.store(true, Ordering::Release);
        let Ok(_permit) = task_release_consumer.acquire().await else {
            return;
        };
        while !task_stop.load(Ordering::Acquire) {
            let Some(_frame) = receiver.recv().await else {
                break;
            };
            task_frames_received.fetch_add(1, Ordering::AcqRel);
        }
    });

    {
        let mut coordinator = state.captions.lock().await;
        coordinator.task = Some(task);
        coordinator.stop = Some(stop);
        coordinator.desired_enabled = true;
        coordinator.status = Some(CaptionsStatus::active(
            CaptionsState::Listening,
            CaptionsTransport::Realtime,
            "captions-queued-audio-test",
        ));
    }

    CaptionQueuedAudioTestProbe {
        frames_received,
        task_started,
        release_consumer,
    }
}

#[cfg(test)]
pub async fn caption_task_detached_for_test(state: &AppState) -> bool {
    state.captions.lock().await.task.is_none()
}

#[cfg(test)]
pub async fn caption_sign_out_test_snapshot(state: &AppState) -> CaptionSignOutTestSnapshot {
    let coordinator = state.captions.lock().await;
    let overlays = current_caption_overlays(&state.caption_overlay);
    CaptionSignOutTestSnapshot {
        task_present: coordinator.task.is_some(),
        stop_present: coordinator.stop.is_some(),
        desired_enabled: coordinator.desired_enabled,
        language_present: coordinator.language.is_some(),
        chunk_count: coordinator.chunks.len(),
        finalized_style_present: coordinator.finalized_style.is_some(),
        tap_active: TAP_ACTIVE.load(Ordering::Acquire),
        primary_overlay_active: overlays.primary.is_some(),
        auxiliary_overlay_active: overlays.auxiliary.is_some(),
    }
}

pub async fn captions_status(state: &AppState) -> CaptionsStatus {
    let mut status = state
        .captions
        .lock()
        .await
        .status
        .clone()
        .unwrap_or_else(CaptionsStatus::idle);
    if matches!(
        status.state,
        CaptionsState::Starting
            | CaptionsState::Listening
            | CaptionsState::Reconnecting
            | CaptionsState::Degraded
    ) {
        status.audio_frames_seen = TAP_FRAMES_SEEN.load(Ordering::Relaxed);
        status.dropped_audio_frames = TAP_FRAMES_DROPPED.load(Ordering::Relaxed);
        status.dropped_audio_seconds = caption_audio_seconds_dropped();
    }
    status
}

#[cfg(debug_assertions)]
pub async fn caption_contract_test_snapshot(
    state: &AppState,
) -> Result<CaptionContractTestSnapshot> {
    if !caption_contract_test_enabled() {
        bail!("Caption contract test snapshot is disabled.");
    }
    let status = captions_status(state).await;
    let coordinator = state.captions.lock().await;
    let chunk_count = coordinator.chunks.len();
    let canonical_cues = coordinator
        .chunks
        .iter()
        .map(|chunk| CaptionContractTestCue {
            seq: chunk.seq,
            text: chunk.text.clone(),
            capture_epoch: chunk.capture_epoch,
        })
        .collect();
    drop(coordinator);
    Ok(CaptionContractTestSnapshot {
        status,
        chunk_count,
        canonical_cues,
        dropped_audio_frames: TAP_FRAMES_DROPPED.load(Ordering::Relaxed),
        overlays: caption_overlay_targets_metadata(&state.caption_overlay),
    })
}

fn set_status(state: &AppState, coordinator: &mut CaptionsCoordinator, status: CaptionsStatus) {
    coordinator.status = Some(status.clone());
    state.emit_event("captions.status", status);
}

/// Fire-and-forget status update from inside the session task (which cannot
/// hold the coordinator lock while the RPC handler might).
async fn publish_status(state: &AppState, status: CaptionsStatus) {
    let mut coordinator = state.captions.lock().await;
    coordinator.status = Some(status.clone());
    drop(coordinator);
    state.emit_event("captions.status", status);
}

pub async fn start_captions(state: &AppState, language: Option<String>) -> Result<CaptionsStatus> {
    let _control = CAPTION_CONTROL.lock().await;
    let Some(bearer) = crate::account::stored_session_token() else {
        bail!("Sign in to use live captions.");
    };
    let client = VideorcApiClient::new()?;
    let language = normalize_caption_language(language);
    let capture_elapsed_seconds = crate::recording::active_capture_elapsed_seconds(state).await;
    let capture_active =
        capture_elapsed_seconds.is_some() || caption_contract_idle_session_enabled();

    let mut coordinator = state.captions.lock().await;
    coordinator.desired_enabled = true;
    coordinator.language = language.clone();
    if !capture_active {
        if let Some(task) = coordinator.task.take() {
            task.abort();
        }
        coordinator.stop = None;
        remove_tap();
        let status = CaptionsStatus::ready();
        set_status(state, &mut coordinator, status.clone());
        return Ok(status);
    }
    if let (Some(task), Some(status)) = (coordinator.task.as_ref(), coordinator.status.as_ref())
        && !task.is_finished()
        && matches!(
            status.state,
            CaptionsState::Starting
                | CaptionsState::Listening
                | CaptionsState::Reconnecting
                | CaptionsState::Degraded
        )
    {
        return Ok(status.clone());
    }
    if let Some(task) = coordinator.task.take() {
        task.abort();
    }
    remove_tap();

    let session_client_id = format!("captions-{}", uuid::Uuid::new_v4().simple());
    let sequence = coordinator.sequence.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let receiver = install_tap();
    let mut status = CaptionsStatus::active(
        CaptionsState::Starting,
        CaptionsTransport::Realtime,
        &session_client_id,
    );
    status.message = Some("Connecting live captions…".to_string());
    set_status(state, &mut coordinator, status.clone());

    let task_state = state.clone();
    let task_stop = stop.clone();
    coordinator.task = Some(tokio::spawn(run_caption_session(CaptionSession {
        bearer,
        client,
        language,
        receiver,
        capture_elapsed_seconds: capture_elapsed_seconds.unwrap_or(0.0),
        session_client_id,
        sequence,
        state: task_state,
        stop: task_stop,
    })));
    coordinator.stop = Some(stop);

    Ok(status)
}

pub async fn stop_captions(state: &AppState) -> CaptionsStatus {
    let _control = CAPTION_CONTROL.lock().await;
    // Explicit opt-out is a privacy boundary: do not transcribe audio already
    // queued behind the user's click. Graceful draining is reserved for the
    // capture-finalization path below so its last settled cue can reach SRT.
    finish_caption_task(state, false, false).await;
    let status = {
        let mut coordinator = state.captions.lock().await;
        coordinator.desired_enabled = false;
        coordinator.language = None;
        remove_tap();
        let status = CaptionsStatus::idle();
        coordinator.status = Some(status.clone());
        status
    };
    publish_caption_boundary(state, &status, "stopped");
    status
}

/// Sign-out is a privacy boundary, not a graceful recording boundary. Stop
/// and join the provider task before the caller removes its credentials, then
/// purge every in-memory transcript/session artifact and both compositor bars.
pub async fn stop_captions_for_sign_out(
    state: &AppState,
    clear_credentials: impl FnOnce(),
) -> CaptionsStatus {
    let _control = CAPTION_CONTROL.lock().await;
    finish_caption_task(state, false, false).await;
    let pending_frames_dirs;
    let caption_burn_tasks;
    let status = {
        let mut coordinator = state.captions.lock().await;
        coordinator.desired_enabled = false;
        coordinator.language = None;
        coordinator.chunks.clear();
        coordinator.capture_epoch = coordinator.capture_epoch.saturating_add(1);
        coordinator.finalized_style = None;
        coordinator.artifact_generation = coordinator.artifact_generation.saturating_add(1);
        pending_frames_dirs = take_pending_caption_frame_dirs(&mut coordinator);
        caption_burn_tasks = std::mem::take(&mut coordinator.caption_burn_tasks);
        remove_tap();
        TAP_FRAMES_SEEN.store(0, Ordering::Release);
        TAP_FRAMES_DROPPED.store(0, Ordering::Release);
        let status = CaptionsStatus::idle();
        coordinator.status = Some(status.clone());
        status
    };
    remove_pending_caption_frame_dirs(pending_frames_dirs).await;
    cancel_and_join_caption_burn_tasks(caption_burn_tasks).await;
    publish_caption_boundary(state, &status, "signed-out");
    clear_credentials();
    status
}

/// Stop and join the provider task before backend shutdown takes ownership of
/// the active recording. Taking `state.recording` makes its monitor return
/// before ordinary capture finalization, so shutdown cannot rely on that path
/// to remove the microphone tap. Preferences and artifact cues remain intact
/// for the separate artifact teardown below.
pub async fn shutdown_caption_runtime(state: &AppState) {
    let _control = CAPTION_CONTROL.lock().await;
    finish_caption_task(state, true, false).await;
    TAP_FRAMES_SEEN.store(0, Ordering::Release);
    TAP_FRAMES_DROPPED.store(0, Ordering::Release);
    let status = {
        let mut coordinator = state.captions.lock().await;
        let status = if coordinator.desired_enabled {
            CaptionsStatus::ready()
        } else {
            CaptionsStatus::idle()
        };
        coordinator.status = Some(status.clone());
        status
    };
    publish_caption_boundary(state, &status, "backend-shutdown");
}

/// Graceful backend shutdown owns the same artifact teardown as sign-out, but
/// leaves account credentials and user caption preferences untouched. Runtime
/// exit cannot abandon private frame caches or a partial `(captioned)` copy.
pub async fn shutdown_caption_artifacts(state: &AppState) {
    let (pending_frames_dirs, caption_burn_tasks) = {
        let mut coordinator = state.captions.lock().await;
        coordinator.chunks.clear();
        coordinator.finalized_style = None;
        coordinator.artifact_generation = coordinator.artifact_generation.saturating_add(1);
        (
            take_pending_caption_frame_dirs(&mut coordinator),
            std::mem::take(&mut coordinator.caption_burn_tasks),
        )
    };
    remove_pending_caption_frame_dirs(pending_frames_dirs).await;
    cancel_and_join_caption_burn_tasks(caption_burn_tasks).await;
}

/// Capture sessions own caption audio. Closing the tap lets queued frames drain
/// and gives realtime VAD a bounded window to settle the last utterance before
/// artifact generation drains canonical cues.
pub async fn finish_captions_for_capture(state: &AppState) -> CaptionsStatus {
    let _control = CAPTION_CONTROL.lock().await;
    {
        let mut coordinator = state.captions.lock().await;
        let style = coordinator.style;
        coordinator.finalized_style = Some(style);
    }
    finish_caption_task(state, true, true).await;
    let status = {
        let mut coordinator = state.captions.lock().await;
        let status = if coordinator.desired_enabled {
            CaptionsStatus::ready()
        } else {
            CaptionsStatus::idle()
        };
        set_status(state, &mut coordinator, status.clone());
        status
    };
    // Canonical chunks remain in the coordinator until artifact generation
    // drains them, but live compositor/readers must not retain the last cue.
    clear_caption_presentation(state, "capture-ended");
    status
}

async fn finish_caption_task(
    state: &AppState,
    preserve_desired: bool,
    drain_final_transcript: bool,
) {
    let (task, stop) = {
        let mut coordinator = state.captions.lock().await;
        if !preserve_desired {
            coordinator.desired_enabled = false;
        }
        (coordinator.task.take(), coordinator.stop.take())
    };
    if !drain_final_transcript && let Some(stop) = stop.as_ref() {
        stop.store(true, Ordering::Release);
    }
    remove_tap();
    let Some(mut task) = task else {
        return;
    };
    if !drain_final_transcript {
        // Cancellation drops the receiver and any in-flight upload future at
        // once. Waiting for a cooperative loop turn could otherwise let a
        // queued chunk reach the provider after the user opted out.
        task.abort();
        let _ = task.await;
        return;
    }
    // At close the chunked path keeps the current request plus only the final
    // sub-chunk remainder, discarding older backlog with explicit health truth.
    // Budget one full HTTP timeout for each of those two permitted attempts.
    let final_upload_grace = caption_final_upload_grace(CAPTION_FINAL_UPLOAD_COUNT);
    if tokio::time::timeout(final_upload_grace, &mut task)
        .await
        .is_err()
    {
        if let Some(stop) = stop.as_ref() {
            stop.store(true, Ordering::Release);
        }
        task.abort();
        let _ = task.await;
    }
}

pub async fn block_captions_for_audio_path(state: &AppState, message: impl Into<String>) {
    block_captions(state, "audio-path-unsupported", message).await;
}

pub async fn block_captions(state: &AppState, reason_code: &str, message: impl Into<String>) {
    let _control = CAPTION_CONTROL.lock().await;
    // A block is terminal for this runtime. Discard pending PCM just like an
    // explicit opt-out; only a normal capture end may drain final audio.
    finish_caption_task(state, true, false).await;
    let status = {
        let mut coordinator = state.captions.lock().await;
        coordinator.desired_enabled = true;
        let mut status = CaptionsStatus::ready();
        status.state = CaptionsState::Blocked;
        status.reason_code = Some(reason_code.to_string());
        status.message = Some(message.into());
        coordinator.status = Some(status.clone());
        status
    };
    publish_caption_boundary(state, &status, "blocked");
}

fn publish_caption_boundary(state: &AppState, status: &CaptionsStatus, reason: &str) {
    state.emit_event("captions.status", status);
    clear_caption_presentation(state, reason);
}

fn clear_caption_presentation(state: &AppState, reason: &str) {
    if let Err(error) =
        clear_caption_overlays(&state.caption_overlay, ClearCaptionOverlayParams::default())
    {
        tracing::warn!("Could not clear caption overlays at the {reason} boundary: {error:#}");
    }
    state.emit_event("captions.cleared", serde_json::json!({ "reason": reason }));
}

fn normalize_caption_language(language: Option<String>) -> Option<String> {
    language
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
}

struct CaptionSession {
    bearer: String,
    client: VideorcApiClient,
    language: Option<String>,
    receiver: mpsc::Receiver<AudioFrame>,
    capture_elapsed_seconds: f64,
    session_client_id: String,
    sequence: CaptionSequence,
    state: AppState,
    stop: Arc<AtomicBool>,
}

/// Session-wide caption sequence shared by every provider transport.
///
/// `session_client_id` intentionally survives a realtime-to-chunked fallback,
/// so its sequence must survive too: renderers use that pair as both their
/// ordering watermark and cue identity.
#[derive(Clone, Default)]
struct CaptionSequence {
    last: Arc<AtomicU64>,
}

impl CaptionSequence {
    fn next(&self) -> u64 {
        self.last.fetch_add(1, Ordering::Relaxed).saturating_add(1)
    }

    fn reset(&self) {
        self.last.store(0, Ordering::Relaxed);
    }
}

/// Capture-relative audio timeline shared across realtime and chunked
/// transports. Its initial base supports captions enabled mid-session; audio
/// consumed before a fallback advances the same cursor used by chunked cues.
struct CaptionTimeline {
    capture_base_seconds: f64,
    processed_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptionAudioPathFailure {
    Unavailable,
    Stalled,
    Disconnected,
}

impl CaptionAudioPathFailure {
    fn reason_code(self) -> &'static str {
        match self {
            Self::Unavailable => "audio-path-unavailable",
            Self::Stalled => "audio-path-stalled",
            Self::Disconnected => "audio-path-disconnected",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Unavailable => {
                "Captions received no microphone frames. Select a supported microphone capture path and try again."
            }
            Self::Stalled => {
                "The live-caption microphone path stopped delivering frames. Reconnect or reselect the microphone, then restart captions."
            }
            Self::Disconnected => {
                "The live-caption microphone path disconnected while capture was active. Reconnect or reselect the microphone, then restart captions."
            }
        }
    }
}

struct CaptionAudioHeartbeat {
    started_at: std::time::Instant,
    last_frame_at: Option<std::time::Instant>,
}

impl CaptionAudioHeartbeat {
    fn new(started_at: std::time::Instant) -> Self {
        Self {
            started_at,
            last_frame_at: None,
        }
    }

    fn record_frame(&mut self, received_at: std::time::Instant) {
        self.last_frame_at = Some(received_at);
    }

    fn refresh_from_caption_bus(&mut self) {
        let tick = TAP_LAST_FRAME_MICROS.load(Ordering::Acquire);
        let Some(epoch) = TAP_CLOCK_EPOCH.get().copied().filter(|_| tick > 0) else {
            return;
        };
        let observed_at = epoch + std::time::Duration::from_micros(tick - 1);
        if self
            .last_frame_at
            .is_none_or(|last_frame_at| observed_at > last_frame_at)
        {
            self.last_frame_at = Some(observed_at);
        }
    }

    fn has_seen_frame(&self) -> bool {
        self.last_frame_at.is_some()
    }

    fn failure_at(&self, now: std::time::Instant) -> Option<CaptionAudioPathFailure> {
        let (anchor, timeout, failure) = match self.last_frame_at {
            Some(last_frame_at) => (
                last_frame_at,
                CAPTION_AUDIO_STALL_TIMEOUT,
                CaptionAudioPathFailure::Stalled,
            ),
            None => (
                self.started_at,
                CAPTION_AUDIO_READY_TIMEOUT,
                CaptionAudioPathFailure::Unavailable,
            ),
        };
        (now.saturating_duration_since(anchor) >= timeout).then_some(failure)
    }
}

impl CaptionTimeline {
    fn new(capture_base_seconds: f64) -> Self {
        Self {
            capture_base_seconds: if capture_base_seconds.is_finite() {
                capture_base_seconds.max(0.0)
            } else {
                0.0
            },
            processed_seconds: 0.0,
        }
    }

    fn current_seconds(&self) -> f64 {
        self.capture_base_seconds + self.processed_seconds
    }

    fn advance_seconds(&mut self, seconds: f64) {
        self.processed_seconds += seconds.max(0.0);
    }

    fn reset_capture(&mut self) {
        self.capture_base_seconds = 0.0;
        self.processed_seconds = 0.0;
    }
}

/// Provider-specific wire details live behind this adapter. The coordinator
/// consumes stable caption-domain events and does not construct or inspect raw
/// Gateway JSON anywhere else.
struct GatewayRealtimeCaptionTransport;

#[derive(Debug, Clone, PartialEq)]
enum RealtimeCaptionEvent {
    ConfigurationAcknowledged,
    SpeechStarted {
        item_id: String,
        audio_start_ms: Option<f64>,
    },
    Partial {
        item_id: String,
        transcript: String,
    },
    Completed {
        item_id: String,
        transcript: String,
    },
    Error(RealtimeTransportFailure),
    AssistantResponse,
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeFailureKind {
    Terminal,
    Retryable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RealtimeTransportFailure {
    kind: RealtimeFailureKind,
    code: String,
    message: String,
}

#[derive(Debug, Clone, Copy)]
struct RealtimeCaptionTimeline {
    capture_base_seconds: f64,
    ms_at_anchor: f64,
    socket_audio_base_ms: f64,
    ms_sent: f64,
    capture_epoch: u64,
}

impl RealtimeCaptionTimeline {
    fn cue_offset_seconds(&self, audio_start_ms: Option<f64>) -> f64 {
        let absolute_start_ms = audio_start_ms
            .map(|relative| self.socket_audio_base_ms + relative)
            .unwrap_or(self.ms_sent);
        self.capture_base_seconds + ((absolute_start_ms - self.ms_at_anchor) / 1000.0).max(0.0)
    }

    fn cue_end_seconds(&self, offset_seconds: f64) -> f64 {
        (self.capture_base_seconds + (self.ms_sent - self.ms_at_anchor) / 1000.0)
            .max(offset_seconds + 0.5)
    }
}

impl GatewayRealtimeCaptionTransport {
    fn configure(language: Option<&str>) -> serde_json::Value {
        let mut transcription = serde_json::json!({ "enabled": true });
        if let Some(language) = language {
            transcription["language"] = serde_json::Value::String(language.to_string());
        }
        serde_json::json!({
            "type": "session.update",
            "session": {
                // `create_response: false` is the important guard: server VAD
                // must transcribe input without
                // starting an assistant turn whose audio Videorc would discard.
                "input_audio_format": "pcm16",
                "input_audio_transcription": transcription,
                "turn_detection": {
                    "type": "server_vad",
                    "create_response": false,
                    "interrupt_response": false
                }
            }
        })
    }

    fn append_audio(pcm_s16le: &[u8]) -> serde_json::Value {
        use base64::Engine as _;
        serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(pcm_s16le),
        })
    }

    fn parse(event: &serde_json::Value) -> RealtimeCaptionEvent {
        let event_type = event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let raw_type = event
            .get("rawType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();

        if matches!(event_type, "session-updated" | "session.updated")
            || (event_type == "custom" && raw_type == "session.updated")
        {
            return RealtimeCaptionEvent::ConfigurationAcknowledged;
        }
        if event_type == "error" || raw_type == "error" {
            return RealtimeCaptionEvent::Error(parse_realtime_error(event));
        }
        if event_type.starts_with("response-") || raw_type.starts_with("response.") {
            return RealtimeCaptionEvent::AssistantResponse;
        }
        if event_type == "speech-started" {
            let item_id = realtime_item_id(event);
            if item_id.is_empty() {
                return RealtimeCaptionEvent::Ignored;
            }
            return RealtimeCaptionEvent::SpeechStarted {
                item_id,
                audio_start_ms: event
                    .get("audioStartMs")
                    .or_else(|| event.pointer("/raw/audio_start_ms"))
                    .and_then(serde_json::Value::as_f64),
            };
        }
        if event_type == "input-transcription-delta"
            || (event_type == "custom"
                && matches!(
                    raw_type,
                    "conversation.item.input_audio_transcription.updated"
                        | "conversation.item.input_audio_transcription.delta"
                ))
        {
            let item_id = realtime_item_id(event);
            let transcript = realtime_transcript(event, true);
            if item_id.is_empty() || transcript.is_empty() {
                return RealtimeCaptionEvent::Ignored;
            }
            return RealtimeCaptionEvent::Partial {
                item_id,
                transcript,
            };
        }
        if event_type == "input-transcription-completed"
            || (event_type == "custom"
                && raw_type == "conversation.item.input_audio_transcription.completed")
        {
            let item_id = realtime_item_id(event);
            let transcript = realtime_transcript(event, false);
            if item_id.is_empty() || transcript.is_empty() {
                return RealtimeCaptionEvent::Ignored;
            }
            return RealtimeCaptionEvent::Completed {
                item_id,
                transcript,
            };
        }
        RealtimeCaptionEvent::Ignored
    }
}

fn realtime_item_id(event: &serde_json::Value) -> String {
    event
        .get("itemId")
        .or_else(|| event.get("item_id"))
        .or_else(|| event.pointer("/raw/item_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn realtime_transcript(event: &serde_json::Value, allow_delta: bool) -> String {
    event
        .get("transcript")
        .or_else(|| allow_delta.then(|| event.get("delta")).flatten())
        .or_else(|| event.pointer("/raw/transcript"))
        .or_else(|| allow_delta.then(|| event.pointer("/raw/delta")).flatten())
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_realtime_error(event: &serde_json::Value) -> RealtimeTransportFailure {
    let code = event
        .pointer("/error/code")
        .or_else(|| event.pointer("/raw/error/code"))
        .or_else(|| event.get("code"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("realtime-provider-error")
        .to_string();
    let message = event
        .pointer("/error/message")
        .or_else(|| event.pointer("/raw/error/message"))
        .or_else(|| event.get("message"))
        .and_then(serde_json::Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("The realtime caption provider reported an error.")
        .to_string();
    let haystack = format!("{code} {message}").to_ascii_lowercase();
    let terminal = [
        "auth",
        "unauthor",
        "forbidden",
        "permission",
        "api_key",
        "quota",
        "rate_limit",
        "billing",
        "model_not_found",
        "invalid_model",
        "invalid_session",
        "configuration",
        "not_configured",
    ]
    .iter()
    .any(|needle| haystack.contains(needle));
    RealtimeTransportFailure {
        kind: if terminal {
            RealtimeFailureKind::Terminal
        } else {
            RealtimeFailureKind::Retryable
        },
        code,
        message,
    }
}

fn classify_realtime_close(code: u16, reason: &str) -> RealtimeTransportFailure {
    let terminal = matches!(code, 1008 | 4001 | 4003 | 4401 | 4403 | 4429);
    RealtimeTransportFailure {
        kind: if terminal {
            RealtimeFailureKind::Terminal
        } else {
            RealtimeFailureKind::Retryable
        },
        code: format!("realtime-close-{code}"),
        message: if reason.trim().is_empty() {
            format!("Realtime caption socket closed with code {code}.")
        } else {
            format!("Realtime caption socket closed with code {code}: {reason}")
        },
    }
}

fn pcm_has_speech_energy(samples: &[i16]) -> bool {
    if samples.is_empty() {
        return false;
    }
    let mean_square = samples
        .iter()
        .map(|sample| {
            let normalized = f64::from(*sample) / f64::from(i16::MAX);
            normalized * normalized
        })
        .sum::<f64>()
        / samples.len() as f64;
    mean_square.sqrt() >= 0.015
}

/// Streaming-first: try the gateway realtime transport (S2) and fall back to
/// chunked transcription whenever streaming is unavailable — the caption
/// session always works, streaming just makes it ~1s instead of ~4s.
async fn run_caption_session(mut session: CaptionSession) {
    let sequence = session.sequence.clone();
    let mut timeline = CaptionTimeline::new(session.capture_elapsed_seconds);
    let mut audio_heartbeat = CaptionAudioHeartbeat::new(std::time::Instant::now());
    let ended_normally = match run_realtime_caption_session(
        &mut session,
        &sequence,
        &mut timeline,
        &mut audio_heartbeat,
    )
    .await
    {
        RealtimeOutcome::Ended => true,
        RealtimeOutcome::Fallback(reason) => {
            tracing::info!(
                "Streaming captions unavailable ({reason}); using chunked transcription."
            );
            let mut status = CaptionsStatus::active(
                CaptionsState::Degraded,
                CaptionsTransport::Chunked,
                &session.session_client_id,
            );
            status.reason_code = Some("realtime-fallback".to_string());
            status.message = Some(format!("Captions on with higher delay — {reason}"));
            publish_status(&session.state, status).await;
            run_chunked_caption_session(
                &mut session,
                &sequence,
                &mut timeline,
                &mut audio_heartbeat,
            )
            .await
        }
        RealtimeOutcome::Terminal => false,
    };
    if ended_normally {
        remove_tap();
        let desired_enabled = session.state.captions.lock().await.desired_enabled;
        publish_status(
            &session.state,
            if desired_enabled {
                CaptionsStatus::ready()
            } else {
                CaptionsStatus::idle()
            },
        )
        .await;
    }
}

enum RealtimeOutcome {
    /// Session stopped normally (stop flag / tap removed).
    Ended,
    /// Streaming can't run (no key, mint failed, socket rejected) — chunk instead.
    Fallback(String),
    /// Auth/premium/quota failure already published; end the session.
    Terminal,
}

/// Streaming caption transport (S2): gateway realtime WebSocket against the
/// voice model, using its input-audio transcription events (grok-stt itself
/// is not WS-enabled on the gateway — spike 2026-07-02). Mic PCM streams up
/// as pcm16 append events; `…transcription.updated` events become PARTIAL
/// captions (~1s behind speech) and `…transcription.completed` become FINAL
/// captions + chunk records for the SRT/burned copy. Tokens are short-lived
/// (≤300s): the loop reminting + reconnects transparently, reports streamed
/// seconds to the usage route, and degrades per R0 on socket loss.
async fn run_realtime_caption_session(
    session: &mut CaptionSession,
    sequence: &CaptionSequence,
    timeline: &mut CaptionTimeline,
    audio_heartbeat: &mut CaptionAudioHeartbeat,
) -> RealtimeOutcome {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::Message;

    let mut ever_connected = false;
    let mut retry_budget = RealtimeRetryBudget::default();
    // Utterance bookkeeping: item id → (caption seq, audio offset seconds).
    let mut items: std::collections::HashMap<String, (u64, f64)> = std::collections::HashMap::new();
    // Recording-epoch anchoring (same idea as chunked): mono ms sent since the
    // capture pipeline (re)started. speech_started's audio_start_ms is
    // relative to the WS stream, so remember the stream ms at each anchor.
    let mut ms_sent: f64 = 0.0;
    let mut ms_at_anchor: f64 = 0.0;
    let mut last_frame_timestamp: Option<u64> = None;
    let mut unreported_ms: f64 = 0.0;
    let mut reconnecting = false;
    let mut capture_epoch = session.state.captions.lock().await.capture_epoch;

    'reconnect: loop {
        if session.stop.load(Ordering::Relaxed) {
            return RealtimeOutcome::Ended;
        }

        let token = match session
            .client
            .mint_caption_realtime_token(&session.bearer, &session.session_client_id)
            .await
        {
            Ok(token) => token,
            Err(CaptionChunkFailure::Terminal { code, message }) => {
                tracing::warn!("Live captions stopped ({code}): {message}");
                remove_tap();
                publish_blocked_status(session, &code, &message, CaptionsTransport::Realtime).await;
                return RealtimeOutcome::Terminal;
            }
            Err(CaptionChunkFailure::Transient { code, message }) => {
                if let Some(code) = code.as_deref() {
                    tracing::warn!(reason_code = code, "Realtime caption token request failed.");
                }
                if !ever_connected {
                    return RealtimeOutcome::Fallback(message);
                }
                let Some(wait) = retry_budget.retry_delay() else {
                    return RealtimeOutcome::Fallback(message);
                };
                signal_reconnecting(session, &mut reconnecting, &message).await;
                tokio::time::sleep(wait).await;
                continue 'reconnect;
            }
        };

        let mut request = match token.url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => return RealtimeOutcome::Fallback(format!("bad realtime url: {error}")),
        };
        let protocols = format!("ai-gateway-realtime.v1, ai-gateway-auth.{}", token.token);
        match protocols.parse() {
            Ok(value) => {
                request
                    .headers_mut()
                    .insert("Sec-WebSocket-Protocol", value);
            }
            Err(_) => return RealtimeOutcome::Fallback("bad realtime token".to_string()),
        }

        let (mut ws, _) = match tokio_tungstenite::connect_async(request).await {
            Ok(connected) => connected,
            Err(error) => {
                let message = format!("realtime connect failed: {error}");
                if !ever_connected {
                    return RealtimeOutcome::Fallback(message);
                }
                let Some(wait) = retry_budget.retry_delay() else {
                    return RealtimeOutcome::Fallback(message);
                };
                signal_reconnecting(session, &mut reconnecting, &message).await;
                tokio::time::sleep(wait).await;
                continue 'reconnect;
            }
        };
        ever_connected = true;
        tracing::info!("Streaming captions connected ({}).", token.model);

        let configure = GatewayRealtimeCaptionTransport::configure(session.language.as_deref());
        if ws
            .send(Message::Text(configure.to_string().into()))
            .await
            .is_err()
        {
            let message = "realtime socket closed while configuring captions";
            let Some(wait) = retry_budget.retry_delay() else {
                return RealtimeOutcome::Fallback(message.to_string());
            };
            signal_reconnecting(session, &mut reconnecting, message).await;
            tokio::time::sleep(wait).await;
            continue 'reconnect;
        }

        if reconnecting {
            reconnecting = false;
            let _ = crate::recording::emit_health_event(
                &session.state,
                None,
                crate::protocol::HealthLevel::Info,
                "captions-upload-recovered",
                "Streaming captions reconnected.",
            );
        }
        let connected_at = tokio::time::Instant::now();
        let socket_audio_base_ms = ms_sent;
        let mut provider_ready = false;
        let mut listening_published = false;
        let mut speech_watchdog_since: Option<tokio::time::Instant> = None;

        // Refresh well before the token expires (60s of headroom against the
        // server-reported expiry, else 240s for the ≤300s default TTL).
        let refresh_in = token
            .expires_at
            .map(|expires_at| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since| since.as_secs())
                    .unwrap_or(0);
                expires_at
                    .saturating_sub(now)
                    .saturating_sub(60)
                    .clamp(30, 600)
            })
            .unwrap_or(240);
        let refresh_at = tokio::time::Instant::now() + std::time::Duration::from_secs(refresh_in);
        let mut report_tick = tokio::time::interval(std::time::Duration::from_secs(60));
        report_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        report_tick.reset();
        let mut watchdog_tick = tokio::time::interval(std::time::Duration::from_millis(250));
        watchdog_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        watchdog_tick.reset();

        loop {
            if session.stop.load(Ordering::Relaxed) {
                let _ = ws.send(Message::Close(None)).await;
                report_usage(session, &mut unreported_ms).await;
                return RealtimeOutcome::Ended;
            }
            tokio::select! {
                maybe_frame = session.receiver.recv() => {
                    let Some(frame) = maybe_frame else {
                        if let Some(failure) = caption_disconnect_failure(
                            caption_session_expects_audio(session).await,
                        ) {
                            publish_caption_audio_failure(
                                session,
                                CaptionsTransport::Realtime,
                                failure,
                            )
                            .await;
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Terminal;
                        }
                        // Server VAD owns commit. The provider documents manual
                        // input_audio_buffer.commit as invalid while VAD is on,
                        // so simply keep reading for a bounded final-transcript
                        // grace after the post-controls audio bus closes.
                        let drain_until = tokio::time::Instant::now() + CAPTION_FINAL_TRANSCRIPT_GRACE;
                        while let Ok(Some(Ok(Message::Text(text)))) =
                            tokio::time::timeout_at(drain_until, ws.next()).await
                        {
                            let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else {
                                continue;
                            };
                            let parsed = GatewayRealtimeCaptionTransport::parse(&event);
                            if matches!(
                                &parsed,
                                RealtimeCaptionEvent::SpeechStarted { .. }
                                    | RealtimeCaptionEvent::Partial { .. }
                                    | RealtimeCaptionEvent::Completed { .. }
                            ) {
                                handle_realtime_event(
                                    session,
                                    parsed,
                                    &mut items,
                                    sequence,
                                    RealtimeCaptionTimeline {
                                        capture_base_seconds: timeline.capture_base_seconds,
                                        ms_at_anchor,
                                        socket_audio_base_ms,
                                        ms_sent,
                                        capture_epoch,
                                    },
                                )
                                .await;
                            }
                        }
                        let _ = ws.send(Message::Close(None)).await;
                        report_usage(session, &mut unreported_ms).await;
                        return RealtimeOutcome::Ended;
                    };
                    audio_heartbeat.record_frame(std::time::Instant::now());
                    if caption_anchor_should_reset(last_frame_timestamp, frame.timestamp_micros) {
                        // New recording: re-anchor, forget in-flight
                        // utterances (their transcripts belong to the
                        // previous video), and advance the capture epoch.
                        ms_at_anchor = ms_sent;
                        timeline.reset_capture();
                        sequence.reset();
                        items.clear();
                        let mut coordinator = session.state.captions.lock().await;
                        coordinator.capture_epoch += 1;
                        capture_epoch = coordinator.capture_epoch;
                    }
                    last_frame_timestamp = Some(frame.timestamp_micros);
                    let mono = downmix_resample_to_16k_mono(
                        &frame.samples,
                        frame.channels,
                        frame.sample_rate,
                    );
                    if mono.is_empty() {
                        continue;
                    }
                    if provider_ready
                        && speech_watchdog_since.is_none()
                        && pcm_has_speech_energy(&mono)
                    {
                        speech_watchdog_since = Some(tokio::time::Instant::now());
                    }
                    let frame_seconds = mono.len() as f64 / f64::from(CAPTION_SAMPLE_RATE);
                    ms_sent += frame_seconds * 1000.0;
                    unreported_ms += frame_seconds * 1000.0;
                    timeline.advance_seconds(frame_seconds);
                    let mut bytes = Vec::with_capacity(mono.len() * 2);
                    for sample in &mono {
                        bytes.extend_from_slice(&sample.to_le_bytes());
                    }
                    let event = GatewayRealtimeCaptionTransport::append_audio(&bytes);
                    if ws.send(Message::Text(event.to_string().into())).await.is_err() {
                        if retry_budget.retry_delay().is_none() {
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback("realtime socket repeatedly dropped".to_string());
                        }
                        signal_reconnecting(session, &mut reconnecting, "realtime socket dropped").await;
                        continue 'reconnect;
                    }
                    publish_listening_if_ready(
                        session,
                        provider_ready,
                        audio_heartbeat.has_seen_frame(),
                        &mut listening_published,
                        token.remaining_seconds,
                    )
                    .await;
                }
                maybe_message = ws.next() => {
                    let Some(message) = maybe_message else {
                        if retry_budget.retry_delay().is_none() {
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback("realtime socket repeatedly closed".to_string());
                        }
                        signal_reconnecting(session, &mut reconnecting, "realtime socket closed").await;
                        continue 'reconnect;
                    };
                    let message = match message {
                        Ok(message) => message,
                        Err(error) => {
                            let reason = format!("realtime socket error: {error}");
                            if retry_budget.retry_delay().is_none() {
                                report_usage(session, &mut unreported_ms).await;
                                return RealtimeOutcome::Fallback(reason);
                            }
                            signal_reconnecting(session, &mut reconnecting, &reason).await;
                            continue 'reconnect;
                        }
                    };
                    if let Message::Close(frame) = message {
                        let failure = frame
                            .map(|frame| classify_realtime_close(u16::from(frame.code), &frame.reason))
                            .unwrap_or_else(|| classify_realtime_close(1006, "socket ended without a close frame"));
                        if failure.kind == RealtimeFailureKind::Terminal {
                            publish_blocked_status(
                                session,
                                &failure.code,
                                &failure.message,
                                CaptionsTransport::Realtime,
                            )
                            .await;
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Terminal;
                        }
                        if retry_budget.retry_delay().is_none() {
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback(failure.message);
                        }
                        signal_reconnecting(session, &mut reconnecting, &failure.message).await;
                        continue 'reconnect;
                    }
                    let Message::Text(text) = message else { continue };
                    let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let parsed = GatewayRealtimeCaptionTransport::parse(&event);
                    match &parsed {
                        RealtimeCaptionEvent::ConfigurationAcknowledged => {
                            provider_ready = true;
                            retry_budget.observe(
                                RealtimeHealthEvidence::ConfigurationAcknowledged,
                            );
                        }
                        RealtimeCaptionEvent::SpeechStarted { .. } => {
                            // Receiving VAD proves the configured input pipeline
                            // is active even if an older provider omits the ack.
                            provider_ready = true;
                            retry_budget.observe(RealtimeHealthEvidence::SpeechStarted);
                            speech_watchdog_since.get_or_insert_with(tokio::time::Instant::now);
                        }
                        RealtimeCaptionEvent::Partial { .. }
                        | RealtimeCaptionEvent::Completed { .. } => {
                            provider_ready = true;
                            speech_watchdog_since = None;
                            retry_budget.observe(RealtimeHealthEvidence::Transcript);
                        }
                        RealtimeCaptionEvent::Error(failure) => {
                            if failure.kind == RealtimeFailureKind::Terminal {
                                publish_blocked_status(
                                    session,
                                    &failure.code,
                                    &failure.message,
                                    CaptionsTransport::Realtime,
                                )
                                .await;
                                report_usage(session, &mut unreported_ms).await;
                                return RealtimeOutcome::Terminal;
                            }
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback(failure.message.clone());
                        }
                        RealtimeCaptionEvent::AssistantResponse => {
                            let message = "Realtime caption model generated an assistant response; switching to transcription-only fallback.";
                            let _ = crate::recording::emit_health_event(
                                &session.state,
                                None,
                                crate::protocol::HealthLevel::Warn,
                                "captions-assistant-response-generated",
                                message,
                            );
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback(message.to_string());
                        }
                        RealtimeCaptionEvent::Ignored => {}
                    }
                    handle_realtime_event(
                        session,
                        parsed,
                        &mut items,
                        sequence,
                        RealtimeCaptionTimeline {
                            capture_base_seconds: timeline.capture_base_seconds,
                            ms_at_anchor,
                            socket_audio_base_ms,
                            ms_sent,
                            capture_epoch,
                        },
                    )
                    .await;
                    publish_listening_if_ready(
                        session,
                        provider_ready,
                        audio_heartbeat.has_seen_frame(),
                        &mut listening_published,
                        token.remaining_seconds,
                    )
                    .await;
                }
                _ = tokio::time::sleep_until(refresh_at) => {
                    // Token expiring: reconnect with a fresh one (audio pauses
                    // for the handshake, ~100-300ms).
                    let _ = ws.send(Message::Close(None)).await;
                    continue 'reconnect;
                }
                _ = report_tick.tick() => {
                    report_usage(session, &mut unreported_ms).await;
                }
                _ = watchdog_tick.tick() => {
                    let elapsed = connected_at.elapsed();
                    audio_heartbeat.refresh_from_caption_bus();
                    if !provider_ready && elapsed >= REALTIME_CONFIG_ACK_TIMEOUT {
                        let _ = ws.send(Message::Close(None)).await;
                        report_usage(session, &mut unreported_ms).await;
                        return RealtimeOutcome::Fallback(
                            "realtime provider did not acknowledge the caption configuration".to_string(),
                        );
                    }
                    if provider_ready
                        && audio_heartbeat.has_seen_frame()
                        && elapsed >= REALTIME_RECONNECT_HEALTHY_INTERVAL
                    {
                        retry_budget.observe(RealtimeHealthEvidence::StableInterval);
                    }
                    if provider_ready
                        && let Some(failure) =
                            audio_heartbeat.failure_at(std::time::Instant::now())
                    {
                        if caption_session_expects_audio(session).await {
                            publish_caption_audio_failure(
                                session,
                                CaptionsTransport::Realtime,
                                failure,
                            )
                            .await;
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Terminal;
                        }
                        let _ = ws.send(Message::Close(None)).await;
                        report_usage(session, &mut unreported_ms).await;
                        return RealtimeOutcome::Ended;
                    }
                    if speech_watchdog_since
                        .is_some_and(|started| started.elapsed() >= TRANSCRIPT_WATCHDOG_TIMEOUT)
                    {
                        let message = "speech reached the realtime socket but no transcript arrived";
                        let _ = crate::recording::emit_health_event(
                            &session.state,
                            None,
                            crate::protocol::HealthLevel::Warn,
                            "captions-transcript-watchdog",
                            "Realtime captions detected speech without a transcript; switching to chunked fallback.",
                        );
                        report_usage(session, &mut unreported_ms).await;
                        return RealtimeOutcome::Fallback(message.to_string());
                    }
                }
            }
        }
    }
}

async fn signal_reconnecting(session: &CaptionSession, reconnecting: &mut bool, message: &str) {
    if *reconnecting {
        return;
    }
    *reconnecting = true;
    tracing::warn!("Streaming captions reconnecting: {message}");
    let _ = crate::recording::emit_health_event(
        &session.state,
        None,
        crate::protocol::HealthLevel::Warn,
        "captions-upload-failed",
        &format!("Streaming captions interrupted; reconnecting. {message}"),
    );
    let mut status = CaptionsStatus::active(
        CaptionsState::Reconnecting,
        CaptionsTransport::Realtime,
        &session.session_client_id,
    );
    status.reason_code = Some("realtime-reconnecting".to_string());
    status.message = Some(format!("Captions reconnecting — {message}"));
    publish_status(&session.state, status).await;
}

async fn caption_session_expects_audio(session: &CaptionSession) -> bool {
    if session.stop.load(Ordering::Acquire) {
        return false;
    }
    let desired_enabled = session.state.captions.lock().await.desired_enabled;
    if !desired_enabled {
        return false;
    }
    if caption_contract_idle_session_enabled() {
        return true;
    }
    session.state.recording.lock().await.is_some()
}

fn caption_disconnect_failure(audio_expected: bool) -> Option<CaptionAudioPathFailure> {
    audio_expected.then_some(CaptionAudioPathFailure::Disconnected)
}

async fn publish_caption_audio_failure(
    session: &CaptionSession,
    transport: CaptionsTransport,
    failure: CaptionAudioPathFailure,
) {
    publish_blocked_status(session, failure.reason_code(), failure.message(), transport).await;
}

async fn publish_listening_if_ready(
    session: &CaptionSession,
    provider_ready: bool,
    audio_seen: bool,
    listening_published: &mut bool,
    remaining_seconds: Option<u64>,
) {
    if !provider_ready || !audio_seen || *listening_published {
        return;
    }
    *listening_published = true;
    let mut status = CaptionsStatus::active(
        CaptionsState::Listening,
        CaptionsTransport::Realtime,
        &session.session_client_id,
    );
    status.provider_ready = true;
    status.remaining_seconds = remaining_seconds;
    publish_status(&session.state, status).await;
}

async fn publish_blocked_status(
    session: &CaptionSession,
    reason_code: &str,
    message: &str,
    transport: CaptionsTransport,
) {
    remove_tap();
    let mut status = CaptionsStatus::active(
        CaptionsState::Blocked,
        transport,
        &session.session_client_id,
    );
    status.reason_code = Some(reason_code.to_string());
    status.message = Some(message.to_string());
    publish_blocked_presentation(&session.state, status).await;
}

async fn publish_blocked_presentation(state: &AppState, status: CaptionsStatus) {
    let mut coordinator = state.captions.lock().await;
    coordinator.status = Some(status.clone());
    drop(coordinator);
    publish_caption_boundary(state, &status, "blocked");
}

#[cfg(test)]
pub async fn publish_terminal_caption_failure_for_test(state: &AppState) {
    let mut status = CaptionsStatus::active(
        CaptionsState::Blocked,
        CaptionsTransport::Realtime,
        "captions-terminal-failure-test",
    );
    status.reason_code = Some("audio-path-stalled".to_string());
    status.message = Some("Caption audio stopped arriving.".to_string());
    publish_blocked_presentation(state, status).await;
}

async fn report_usage(session: &CaptionSession, unreported_ms: &mut f64) {
    let seconds = (*unreported_ms / 1000.0).floor() as u64;
    if seconds == 0 {
        return;
    }
    *unreported_ms -= seconds as f64 * 1000.0;
    let client = session.client.clone();
    let bearer = session.bearer.clone();
    let session_client_id = session.session_client_id.clone();
    tokio::spawn(async move {
        if let Err(error) = client
            .report_caption_usage(&bearer, &session_client_id, seconds)
            .await
        {
            tracing::warn!("Caption usage report failed: {error}");
        }
    });
}

/// Route one gateway realtime event into caption updates + chunk records.
async fn handle_realtime_event(
    session: &CaptionSession,
    event: RealtimeCaptionEvent,
    items: &mut std::collections::HashMap<String, (u64, f64)>,
    sequence: &CaptionSequence,
    timeline: RealtimeCaptionTimeline,
) {
    match event {
        RealtimeCaptionEvent::SpeechStarted {
            item_id,
            audio_start_ms,
        } => {
            let offset = timeline.cue_offset_seconds(audio_start_ms);
            realtime_item_entry(items, sequence, &item_id, offset);
        }
        RealtimeCaptionEvent::Partial {
            item_id,
            transcript,
        } => {
            // Unknown item = its speech started before a recording boundary
            // (we cleared it) — the transcript belongs to the previous video.
            let Some(&(item_seq, _)) = items.get(&item_id) else {
                return;
            };
            session.state.emit_event(
                "captions.update",
                CaptionsUpdate {
                    session_client_id: session.session_client_id.clone(),
                    seq: item_seq,
                    kind: CaptionUpdateKind::Partial,
                    text: transcript,
                    chunk_seconds: 0,
                    remaining_seconds: None,
                },
            );
        }
        RealtimeCaptionEvent::Completed {
            item_id,
            transcript,
        } => {
            // Same boundary rule as partials: cleared items never resurrect.
            let Some(&(item_seq, offset)) = items.get(&item_id) else {
                return;
            };
            let end = timeline.cue_end_seconds(offset);
            let inserted = {
                let mut coordinator = session.state.captions.lock().await;
                upsert_caption_record(
                    &mut coordinator.chunks,
                    CaptionChunkRecord {
                        seq: item_seq,
                        offset_seconds: offset,
                        duration_seconds: (end - offset).clamp(0.5, 30.0),
                        text: transcript.clone(),
                        segments: Vec::new(),
                        capture_epoch: timeline.capture_epoch,
                        provider_item_id: Some(item_id.clone()),
                    },
                )
            };
            if !inserted {
                tracing::debug!(
                    provider_item_id = %item_id,
                    "Coalesced a repeated realtime caption completion."
                );
            }
            session.state.emit_event(
                "captions.update",
                CaptionsUpdate {
                    session_client_id: session.session_client_id.clone(),
                    seq: item_seq,
                    kind: CaptionUpdateKind::Final,
                    text: transcript,
                    chunk_seconds: (end - offset).ceil() as u64,
                    remaining_seconds: None,
                },
            );
        }
        RealtimeCaptionEvent::ConfigurationAcknowledged
        | RealtimeCaptionEvent::Error(_)
        | RealtimeCaptionEvent::AssistantResponse
        | RealtimeCaptionEvent::Ignored => {}
    }
}

fn realtime_item_entry(
    items: &mut std::collections::HashMap<String, (u64, f64)>,
    sequence: &CaptionSequence,
    item_id: &str,
    offset: f64,
) -> (u64, f64) {
    *items
        .entry(item_id.to_string())
        .or_insert_with(|| (sequence.next(), offset))
}

#[derive(Debug)]
struct BufferedCaptionChunk {
    samples: Vec<i16>,
    seq: u64,
    offset_seconds: f64,
    duration_seconds: f64,
    capture_epoch: u64,
}

struct CaptionChunkBuffer {
    chunk_samples: usize,
    max_pending: usize,
    pcm: Vec<i16>,
    pending: std::collections::VecDeque<BufferedCaptionChunk>,
}

impl CaptionChunkBuffer {
    fn new(chunk_samples: usize, max_pending: usize) -> Self {
        Self {
            chunk_samples: chunk_samples.max(1),
            max_pending: max_pending.max(1),
            pcm: Vec::with_capacity(chunk_samples.saturating_mul(2)),
            pending: std::collections::VecDeque::new(),
        }
    }

    /// Returns seconds evicted from the bounded queue. In ordinary operation
    /// this is zero: the receiver keeps draining while one HTTP upload waits.
    fn push_samples(
        &mut self,
        samples: Vec<i16>,
        capture_epoch: u64,
        sequence: &CaptionSequence,
        timeline: &mut CaptionTimeline,
    ) -> f64 {
        self.pcm.extend(samples);
        let mut dropped_seconds = 0.0;
        while self.pcm.len() >= self.chunk_samples {
            let chunk = self.pcm.drain(..self.chunk_samples).collect();
            dropped_seconds +=
                self.enqueue_back(Self::stamp_chunk(chunk, capture_epoch, sequence, timeline));
        }
        dropped_seconds
    }

    #[cfg(test)]
    fn flush_remainder(
        &mut self,
        capture_epoch: u64,
        sequence: &CaptionSequence,
        timeline: &mut CaptionTimeline,
    ) -> f64 {
        if self.pcm.is_empty() {
            return 0.0;
        }
        let remainder = std::mem::take(&mut self.pcm);
        let stamped = Self::stamp_chunk(remainder, capture_epoch, sequence, timeline);
        self.enqueue_back(stamped)
    }

    /// At capture stop, stale queued backlog must not hold recording
    /// finalization through the full queue. Preserve exactly one tail nearest
    /// the stop boundary: prefer the sub-chunk PCM remainder, otherwise retain
    /// the newest queued full chunk when speech ended on an exact boundary.
    /// The caller reports every older discarded second.
    fn prepare_final_remainder(
        &mut self,
        capture_epoch: u64,
        sequence: &CaptionSequence,
        timeline: &mut CaptionTimeline,
    ) -> f64 {
        let tail = if !self.pcm.is_empty() {
            let remainder = std::mem::take(&mut self.pcm);
            Some(Self::stamp_chunk(
                remainder,
                capture_epoch,
                sequence,
                timeline,
            ))
        } else {
            self.pending.pop_back()
        };
        let dropped_seconds = self
            .pending
            .drain(..)
            .map(|chunk| chunk.duration_seconds)
            .sum();
        if let Some(tail) = tail {
            self.pending.push_back(tail);
        }
        dropped_seconds
    }

    fn stamp_chunk(
        samples: Vec<i16>,
        capture_epoch: u64,
        sequence: &CaptionSequence,
        timeline: &mut CaptionTimeline,
    ) -> BufferedCaptionChunk {
        let duration_seconds = samples.len() as f64 / f64::from(CAPTION_SAMPLE_RATE);
        let offset_seconds = timeline.current_seconds();
        timeline.advance_seconds(duration_seconds);
        BufferedCaptionChunk {
            samples,
            seq: sequence.next(),
            offset_seconds,
            duration_seconds,
            capture_epoch,
        }
    }

    fn enqueue_back(&mut self, chunk: BufferedCaptionChunk) -> f64 {
        let dropped_seconds = if self.pending.len() >= self.max_pending {
            self.pending
                .pop_front()
                .map_or(0.0, |dropped| dropped.duration_seconds)
        } else {
            0.0
        };
        self.pending.push_back(chunk);
        dropped_seconds
    }

    fn requeue_front(&mut self, chunk: BufferedCaptionChunk) -> f64 {
        let dropped_seconds = if self.pending.len() >= self.max_pending {
            self.pending
                .pop_back()
                .map_or(0.0, |dropped| dropped.duration_seconds)
        } else {
            0.0
        };
        self.pending.push_front(chunk);
        dropped_seconds
    }

    fn pop_front(&mut self) -> Option<BufferedCaptionChunk> {
        self.pending.pop_front()
    }

    fn clear(&mut self) {
        self.pcm.clear();
        self.pending.clear();
    }

    fn is_empty(&self) -> bool {
        self.pcm.is_empty() && self.pending.is_empty()
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending.len()
    }

    #[cfg(test)]
    fn drain_pending(&mut self) -> Vec<BufferedCaptionChunk> {
        self.pending.drain(..).collect()
    }
}

type CaptionChunkUploadResult = (
    BufferedCaptionChunk,
    std::result::Result<CaptionChunkResponse, CaptionChunkFailure>,
);
type CaptionChunkUploadFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = CaptionChunkUploadResult> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptionChunkTransientAction {
    RetryWithBackoff { wait: std::time::Duration },
    DropAndContinueFinalDrain,
}

#[derive(Debug)]
struct CaptionChunkTransientTransition {
    action: CaptionChunkTransientAction,
    dropped_seconds: f64,
}

fn apply_caption_chunk_transient_failure(
    receiver_open: bool,
    chunk: BufferedCaptionChunk,
    buffer: &mut CaptionChunkBuffer,
    backoff: &mut Option<std::time::Duration>,
    next_upload_allowed_at: &mut tokio::time::Instant,
    now: tokio::time::Instant,
) -> CaptionChunkTransientTransition {
    if receiver_open {
        let wait = next_caption_backoff(*backoff);
        *backoff = Some(wait);
        *next_upload_allowed_at = now + wait;
        CaptionChunkTransientTransition {
            action: CaptionChunkTransientAction::RetryWithBackoff { wait },
            dropped_seconds: buffer.requeue_front(chunk),
        }
    } else {
        *backoff = None;
        *next_upload_allowed_at = now;
        CaptionChunkTransientTransition {
            action: CaptionChunkTransientAction::DropAndContinueFinalDrain,
            dropped_seconds: chunk.duration_seconds,
        }
    }
}

fn prepare_caption_final_drain(
    buffer: &mut CaptionChunkBuffer,
    capture_epoch: u64,
    sequence: &CaptionSequence,
    timeline: &mut CaptionTimeline,
    backoff: &mut Option<std::time::Duration>,
    next_upload_allowed_at: &mut tokio::time::Instant,
    now: tokio::time::Instant,
) -> f64 {
    *backoff = None;
    *next_upload_allowed_at = now;
    buffer.prepare_final_remainder(capture_epoch, sequence, timeline)
}

fn begin_caption_chunk_upload(
    session: &CaptionSession,
    chunk: BufferedCaptionChunk,
) -> CaptionChunkUploadFuture {
    let client = session.client.clone();
    let bearer = session.bearer.clone();
    let session_client_id = session.session_client_id.clone();
    let language = session.language.clone();
    let wav = encode_wav_16k_mono(&chunk.samples);
    Box::pin(async move {
        let result = client
            .transcribe_caption_chunk(&bearer, &session_client_id, wav, language.as_deref())
            .await;
        (chunk, result)
    })
}

async fn await_caption_chunk_upload(
    upload: &mut Option<CaptionChunkUploadFuture>,
) -> CaptionChunkUploadResult {
    match upload {
        Some(upload) => upload.await,
        None => std::future::pending().await,
    }
}

async fn run_chunked_caption_session(
    session: &mut CaptionSession,
    sequence: &CaptionSequence,
    timeline: &mut CaptionTimeline,
    audio_heartbeat: &mut CaptionAudioHeartbeat,
) -> bool {
    let chunk_samples = (f64::from(CAPTION_SAMPLE_RATE) * CAPTION_CHUNK_SECONDS) as usize;
    let mut buffer = CaptionChunkBuffer::new(chunk_samples, MAX_BUFFERED_CAPTION_CHUNKS);
    let mut in_flight: Option<CaptionChunkUploadFuture> = None;
    let mut receiver_open = true;
    let mut capture_epoch = session.state.captions.lock().await.capture_epoch;
    let mut last_frame_timestamp: Option<u64> = None;
    // Transient failures requeue the same stamped chunk. Audio continues into
    // the bounded queue while the request or backoff waits, so ordinary slow
    // uploads never starve the tap receiver.
    let mut backoff: Option<std::time::Duration> = None;
    let mut next_upload_allowed_at = tokio::time::Instant::now();
    let mut degraded_reason: Option<String> = None;
    let mut provider_confirmed = false;
    let mut last_reported_tap_drops = TAP_FRAMES_DROPPED.load(Ordering::Relaxed);
    let mut heartbeat_tick = tokio::time::interval(std::time::Duration::from_millis(250));
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat_tick.reset();

    loop {
        if session.stop.load(Ordering::Relaxed) {
            // Sign-out/privacy teardown cancels the owned upload future by
            // dropping this session task. Graceful capture stop leaves the stop
            // flag clear and closes the receiver so queued audio can flush.
            return false;
        }

        if in_flight.is_none()
            && tokio::time::Instant::now() >= next_upload_allowed_at
            && let Some(chunk) = buffer.pop_front()
        {
            in_flight = Some(begin_caption_chunk_upload(session, chunk));
        }
        if !receiver_open && in_flight.is_none() && buffer.is_empty() {
            break;
        }

        tokio::select! {
            maybe_frame = session.receiver.recv(), if receiver_open => {
                let Some(frame) = maybe_frame else {
                    if let Some(failure) = caption_disconnect_failure(
                        caption_session_expects_audio(session).await,
                    ) {
                        publish_caption_audio_failure(
                            session,
                            CaptionsTransport::Chunked,
                            failure,
                        )
                        .await;
                        return false;
                    }
                    receiver_open = false;
                    let dropped_seconds = prepare_caption_final_drain(
                        &mut buffer,
                        capture_epoch,
                        sequence,
                        timeline,
                        &mut backoff,
                        &mut next_upload_allowed_at,
                        tokio::time::Instant::now(),
                    );
                    if dropped_seconds > 0.0 {
                        surface_chunked_audio_drop(
                            session,
                            dropped_seconds,
                            0,
                            provider_confirmed,
                        )
                        .await;
                    }
                    continue;
                };
                audio_heartbeat.record_frame(std::time::Instant::now());
                if caption_anchor_should_reset(last_frame_timestamp, frame.timestamp_micros) {
                    // A new capture owns a new artifact namespace. Any old
                    // pending chunks are cross-session work and cannot be
                    // attributed to this recording.
                    buffer.clear();
                    timeline.reset_capture();
                    sequence.reset();
                    let mut coordinator = session.state.captions.lock().await;
                    coordinator.capture_epoch += 1;
                    capture_epoch = coordinator.capture_epoch;
                }
                last_frame_timestamp = Some(frame.timestamp_micros);
                let dropped_seconds = buffer.push_samples(
                    downmix_resample_to_16k_mono(
                        &frame.samples,
                        frame.channels,
                        frame.sample_rate,
                    ),
                    capture_epoch,
                    sequence,
                    timeline,
                );
                if dropped_seconds > 0.0 {
                    surface_chunked_audio_drop(
                        session,
                        dropped_seconds,
                        0,
                        provider_confirmed,
                    )
                    .await;
                }
            }
            (chunk, result) = await_caption_chunk_upload(&mut in_flight) => {
                in_flight = None;
                match result {
                    Ok(response) => {
                        let recovered = degraded_reason.take().is_some();
                        if recovered {
                            let _ = crate::recording::emit_health_event(
                                &session.state,
                                None,
                                crate::protocol::HealthLevel::Info,
                                "captions-upload-recovered",
                                "Caption uploads recovered; live captions resumed.",
                            );
                        }
                        if recovered || !provider_confirmed {
                            provider_confirmed = true;
                            let mut status = CaptionsStatus::active(
                                CaptionsState::Degraded,
                                CaptionsTransport::Chunked,
                                &session.session_client_id,
                            );
                            status.provider_ready = true;
                            status.reason_code = Some("realtime-fallback".to_string());
                            status.message = Some("Captions on with higher delay.".to_string());
                            status.remaining_seconds = Some(response.remaining_seconds);
                            publish_status(&session.state, status).await;
                        }
                        backoff = None;
                        next_upload_allowed_at = tokio::time::Instant::now();
                        if !response.text.trim().is_empty() {
                            let current_epoch = {
                                let mut coordinator = session.state.captions.lock().await;
                                coordinator.chunks.push(CaptionChunkRecord {
                                    seq: chunk.seq,
                                    offset_seconds: chunk.offset_seconds,
                                    duration_seconds: chunk.duration_seconds,
                                    text: response.text.trim().to_string(),
                                    segments: response.segments.clone(),
                                    capture_epoch: chunk.capture_epoch,
                                    provider_item_id: None,
                                });
                                coordinator.capture_epoch
                            };
                            if chunk.capture_epoch == current_epoch {
                                session.state.emit_event(
                                    "captions.update",
                                    CaptionsUpdate {
                                        session_client_id: session.session_client_id.clone(),
                                        seq: chunk.seq,
                                        kind: CaptionUpdateKind::Final,
                                        text: response.text.trim().to_string(),
                                        chunk_seconds: response.chunk_seconds,
                                        remaining_seconds: Some(response.remaining_seconds),
                                    },
                                );
                            } else {
                                tracing::info!(
                                    "Suppressed a caption update from a previous recording (epoch {} < {}).",
                                    chunk.capture_epoch,
                                    current_epoch,
                                );
                            }
                        }
                    }
                    Err(CaptionChunkFailure::Terminal { code, message }) => {
                        tracing::warn!("Live captions stopped ({code}): {message}");
                        publish_blocked_status(
                            session,
                            &code,
                            &message,
                            CaptionsTransport::Chunked,
                        )
                        .await;
                        return false;
                    }
                    Err(CaptionChunkFailure::Transient { message, .. }) => {
                        let transition = apply_caption_chunk_transient_failure(
                            receiver_open,
                            chunk,
                            &mut buffer,
                            &mut backoff,
                            &mut next_upload_allowed_at,
                            tokio::time::Instant::now(),
                        );
                        if transition.dropped_seconds > 0.0 {
                            surface_chunked_audio_drop(
                                session,
                                transition.dropped_seconds,
                                0,
                                provider_confirmed,
                            )
                            .await;
                        }
                        let CaptionChunkTransientAction::RetryWithBackoff {
                            wait: next_backoff,
                        } = transition.action
                        else {
                            tracing::warn!(
                                "Final caption chunk upload failed; continuing with the remaining capture-end queue: {message}"
                            );
                            continue;
                        };
                        tracing::warn!(
                            "Live caption chunk failed (retrying in {}s): {message}",
                            next_backoff.as_secs()
                        );
                        if degraded_reason.as_deref() != Some(message.as_str()) {
                            let _ = crate::recording::emit_health_event(
                                &session.state,
                                None,
                                crate::protocol::HealthLevel::Warn,
                                "captions-upload-failed",
                                &format!("Caption upload failed; retrying with backoff. {message}"),
                            );
                            let mut status = CaptionsStatus::active(
                                CaptionsState::Degraded,
                                CaptionsTransport::Chunked,
                                &session.session_client_id,
                            );
                            status.provider_ready = provider_confirmed;
                            status.reason_code = Some("chunk-upload-retrying".to_string());
                            status.message = Some(format!("Captions retrying — {message}"));
                            publish_status(&session.state, status).await;
                            degraded_reason = Some(message);
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(next_upload_allowed_at),
                if in_flight.is_none()
                    && tokio::time::Instant::now() < next_upload_allowed_at
                    && !buffer.is_empty() => {}
            _ = heartbeat_tick.tick(), if receiver_open => {
                audio_heartbeat.refresh_from_caption_bus();
                if let Some(failure) = audio_heartbeat.failure_at(std::time::Instant::now()) {
                    if caption_session_expects_audio(session).await {
                        publish_caption_audio_failure(
                            session,
                            CaptionsTransport::Chunked,
                            failure,
                        )
                        .await;
                        return false;
                    }
                    receiver_open = false;
                    let dropped_seconds = prepare_caption_final_drain(
                        &mut buffer,
                        capture_epoch,
                        sequence,
                        timeline,
                        &mut backoff,
                        &mut next_upload_allowed_at,
                        tokio::time::Instant::now(),
                    );
                    if dropped_seconds > 0.0 {
                        surface_chunked_audio_drop(
                            session,
                            dropped_seconds,
                            0,
                            provider_confirmed,
                        )
                        .await;
                    }
                }
                let tap_drops = TAP_FRAMES_DROPPED.load(Ordering::Relaxed);
                let new_tap_drops = tap_drops.saturating_sub(last_reported_tap_drops);
                if new_tap_drops > 0 {
                    last_reported_tap_drops = tap_drops;
                    surface_chunked_audio_drop(
                        session,
                        0.0,
                        new_tap_drops,
                        provider_confirmed,
                    )
                    .await;
                }
            }
        }
    }

    true
}

async fn surface_chunked_audio_drop(
    session: &CaptionSession,
    dropped_seconds: f64,
    dropped_frames: u64,
    provider_confirmed: bool,
) {
    if dropped_seconds > 0.0 {
        let dropped_ms = (dropped_seconds * 1_000.0).ceil() as u64;
        CAPTION_AUDIO_MILLIS_DROPPED.fetch_add(dropped_ms, Ordering::Relaxed);
    }
    let detail = match (dropped_seconds > 0.0, dropped_frames > 0) {
        (true, true) => format!(
            "Live captions skipped {dropped_seconds:.1}s of buffered audio and {dropped_frames} microphone frame(s)."
        ),
        (true, false) => {
            format!(
                "Live captions skipped {dropped_seconds:.1}s because the upload buffer was full."
            )
        }
        (false, true) => {
            format!(
                "Live captions dropped {dropped_frames} microphone frame(s) before transcription."
            )
        }
        (false, false) => return,
    };
    let _ = crate::recording::emit_health_event(
        &session.state,
        None,
        crate::protocol::HealthLevel::Warn,
        "captions-audio-dropped",
        &detail,
    );
    let mut status = CaptionsStatus::active(
        CaptionsState::Degraded,
        CaptionsTransport::Chunked,
        &session.session_client_id,
    );
    status.provider_ready = provider_confirmed;
    status.reason_code = Some("captions-audio-dropped".to_string());
    status.message = Some(detail);
    publish_status(&session.state, status).await;
}

/// Exponential backoff for transient upload failures: 2s doubling to a 30s
/// cap. Pure and unit-tested.
pub fn next_caption_backoff(current: Option<std::time::Duration>) -> std::time::Duration {
    const FIRST: std::time::Duration = std::time::Duration::from_secs(2);
    const CAP: std::time::Duration = std::time::Duration::from_secs(30);
    match current {
        None => FIRST,
        Some(previous) => (previous * 2).min(CAP),
    }
}

fn next_realtime_retry_delay(
    attempts: &mut u8,
    backoff: &mut Option<std::time::Duration>,
) -> Option<std::time::Duration> {
    *attempts = attempts.saturating_add(1);
    if *attempts > MAX_REALTIME_RECONNECTS {
        return None;
    }
    let wait = next_caption_backoff(*backoff);
    *backoff = Some(wait);
    Some(wait)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeHealthEvidence {
    ConfigurationAcknowledged,
    SpeechStarted,
    Transcript,
    StableInterval,
}

#[derive(Default)]
struct RealtimeRetryBudget {
    attempts: u8,
    backoff: Option<std::time::Duration>,
}

impl RealtimeRetryBudget {
    fn retry_delay(&mut self) -> Option<std::time::Duration> {
        next_realtime_retry_delay(&mut self.attempts, &mut self.backoff)
    }

    fn observe(&mut self, evidence: RealtimeHealthEvidence) {
        if matches!(
            evidence,
            RealtimeHealthEvidence::Transcript | RealtimeHealthEvidence::StableInterval
        ) {
            self.attempts = 0;
            self.backoff = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_caption_app_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            0,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn resample_decimates_48k_stereo_to_16k_mono() {
        // 6 stereo frames (12 samples) at 48kHz -> 2 mono samples at 16kHz.
        let samples: Vec<f32> = vec![
            0.3, 0.1, // frame 1 -> mono 0.2
            0.3, 0.1, // frame 2 -> mono 0.2
            0.3, 0.1, // frame 3 -> mono 0.2
            -0.6, -0.2, // frame 4 -> mono -0.4
            -0.6, -0.2, // frame 5 -> mono -0.4
            -0.6, -0.2, // frame 6 -> mono -0.4
        ];
        let output = downmix_resample_to_16k_mono(&samples, 2, 48_000);
        assert_eq!(output.len(), 2);
        assert!((f32::from(output[0]) / f32::from(i16::MAX) - 0.2).abs() < 0.001);
        assert!((f32::from(output[1]) / f32::from(i16::MAX) + 0.4).abs() < 0.001);
    }

    #[test]
    fn resample_handles_mono_input_and_clamps_overdrive() {
        let output = downmix_resample_to_16k_mono(&[2.0, 2.0, 2.0], 1, 48_000);
        assert_eq!(output, vec![i16::MAX]);
    }

    #[test]
    fn resample_rejects_unexpected_formats() {
        assert!(downmix_resample_to_16k_mono(&[0.0; 12], 2, 44_100).is_empty());
        assert!(downmix_resample_to_16k_mono(&[0.0; 12], 6, 48_000).is_empty());
    }

    #[test]
    fn realtime_adapter_serializes_transcription_only_session_and_audio() {
        let configure = GatewayRealtimeCaptionTransport::configure(Some("es"));
        assert_eq!(configure["type"], "session.update");
        assert_eq!(
            configure["session"]["turn_detection"]["create_response"],
            false
        );
        assert_eq!(
            configure["session"]["turn_detection"]["interrupt_response"],
            false
        );
        assert_eq!(
            configure["session"]["input_audio_transcription"]["language"],
            "es"
        );

        let append = GatewayRealtimeCaptionTransport::append_audio(&[0, 1, 2, 3]);
        assert_eq!(append["type"], "input_audio_buffer.append");
        assert_eq!(append["audio"], "AAECAw==");
    }

    #[test]
    fn realtime_adapter_parses_normalized_and_provider_events() {
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "session-updated"
            })),
            RealtimeCaptionEvent::ConfigurationAcknowledged
        );
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "custom",
                "rawType": "session.updated",
                "raw": {}
            })),
            RealtimeCaptionEvent::ConfigurationAcknowledged
        );
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "speech-started",
                "itemId": "item-1",
                "raw": { "audio_start_ms": 125 }
            })),
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "item-1".to_string(),
                audio_start_ms: Some(125.0),
            }
        );
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "custom",
                "rawType": "conversation.item.input_audio_transcription.updated",
                "raw": { "item_id": "item-1", "transcript": "hola" }
            })),
            RealtimeCaptionEvent::Partial {
                item_id: "item-1".to_string(),
                transcript: "hola".to_string(),
            }
        );
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "input-transcription-completed",
                "itemId": "item-1",
                "transcript": "hola mundo"
            })),
            RealtimeCaptionEvent::Completed {
                item_id: "item-1".to_string(),
                transcript: "hola mundo".to_string(),
            }
        );
    }

    #[test]
    fn realtime_adapter_classifies_errors_and_assistant_responses() {
        let auth = GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
            "type": "error",
            "error": { "code": "invalid_api_key", "message": "bad client secret" }
        }));
        assert!(matches!(
            auth,
            RealtimeCaptionEvent::Error(RealtimeTransportFailure {
                kind: RealtimeFailureKind::Terminal,
                ..
            })
        ));
        let outage = GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
            "type": "error",
            "error": { "code": "provider_unavailable", "message": "try again" }
        }));
        assert!(matches!(
            outage,
            RealtimeCaptionEvent::Error(RealtimeTransportFailure {
                kind: RealtimeFailureKind::Retryable,
                ..
            })
        ));
        assert_eq!(
            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                "type": "response-audio-delta"
            })),
            RealtimeCaptionEvent::AssistantResponse
        );
        assert_eq!(
            classify_realtime_close(1008, "policy").kind,
            RealtimeFailureKind::Terminal
        );
        assert_eq!(
            classify_realtime_close(1013, "retry later").kind,
            RealtimeFailureKind::Retryable
        );
    }

    #[test]
    fn realtime_repeated_completions_upsert_one_canonical_cue() {
        let mut chunks = Vec::new();
        let first = CaptionChunkRecord {
            seq: 7,
            offset_seconds: 1.0,
            duration_seconds: 1.0,
            text: "hello".to_string(),
            segments: Vec::new(),
            capture_epoch: 3,
            provider_item_id: Some("item-7".to_string()),
        };
        assert!(upsert_caption_record(&mut chunks, first.clone()));
        let mut revised = first;
        revised.duration_seconds = 1.8;
        revised.text = "hello everyone".to_string();
        assert!(!upsert_caption_record(&mut chunks, revised));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "hello everyone");
        assert_eq!(chunks[0].duration_seconds, 1.8);

        let next_epoch = CaptionChunkRecord {
            capture_epoch: 4,
            text: "new capture".to_string(),
            ..chunks[0].clone()
        };
        assert!(upsert_caption_record(&mut chunks, next_epoch));
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn realtime_final_then_chunk_fallback_keeps_monotonic_unique_sequences() {
        let mut sequence = CaptionSequence::default();
        let mut realtime_items = std::collections::HashMap::new();

        let (realtime_seq, offset) =
            realtime_item_entry(&mut realtime_items, &mut sequence, "item-1", 0.25);
        assert_eq!(realtime_seq, 1);
        assert_eq!(
            realtime_item_entry(&mut realtime_items, &mut sequence, "item-1", 0.5),
            (realtime_seq, offset),
            "provider revisions keep the canonical realtime cue identity"
        );

        let mut chunks = Vec::new();
        assert!(upsert_caption_record(
            &mut chunks,
            CaptionChunkRecord {
                seq: realtime_seq,
                offset_seconds: offset,
                duration_seconds: 1.0,
                text: "realtime final".to_string(),
                segments: Vec::new(),
                capture_epoch: 0,
                provider_item_id: Some("item-1".to_string()),
            },
        ));
        assert!(!upsert_caption_record(
            &mut chunks,
            CaptionChunkRecord {
                seq: realtime_seq,
                offset_seconds: offset,
                duration_seconds: 1.2,
                text: "realtime final revised".to_string(),
                segments: Vec::new(),
                capture_epoch: 0,
                provider_item_id: Some("item-1".to_string()),
            },
        ));

        // This is the allocator used by `run_chunked_caption_session` after
        // `run_realtime_caption_session` falls back under the same client id.
        let fallback_chunk_seq = sequence.next();
        chunks.push(CaptionChunkRecord {
            seq: fallback_chunk_seq,
            offset_seconds: 3.0,
            duration_seconds: CAPTION_CHUNK_SECONDS,
            text: "fallback chunk".to_string(),
            segments: Vec::new(),
            capture_epoch: 0,
            provider_item_id: None,
        });

        assert_eq!(fallback_chunk_seq, 2);
        assert!(fallback_chunk_seq > realtime_seq);
        assert_eq!(
            caption_cues(&chunks)
                .into_iter()
                .map(|cue| cue.seq)
                .collect::<Vec<_>>(),
            vec![1, 2],
            "the canonical artifact and renderer keys stay unique across fallback"
        );
    }

    #[test]
    fn mid_session_timeline_stays_capture_relative_across_chunk_fallback() {
        let mut timeline = CaptionTimeline::new(42.0);
        let realtime = RealtimeCaptionTimeline {
            capture_base_seconds: timeline.capture_base_seconds,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 1_500.0,
            capture_epoch: 0,
        };

        assert_eq!(realtime.cue_offset_seconds(Some(500.0)), 42.5);
        assert_eq!(realtime.cue_end_seconds(42.5), 43.5);

        // Realtime consumed 1.5 seconds before degrading. Chunked starts from
        // that same cursor, not from zero or from the original enable instant.
        timeline.advance_seconds(1.5);
        assert_eq!(timeline.current_seconds(), 43.5);
        timeline.advance_seconds(CAPTION_CHUNK_SECONDS);
        assert_eq!(timeline.current_seconds(), 46.5);

        // A genuine new capture timestamp regression remains the only reset.
        timeline.reset_capture();
        assert_eq!(timeline.current_seconds(), 0.0);
    }

    #[test]
    fn local_speech_watchdog_ignores_silence_and_detects_voice_energy() {
        assert!(!pcm_has_speech_energy(&vec![0; 1_600]));
        assert!(pcm_has_speech_energy(&vec![2_000; 1_600]));
    }

    #[test]
    fn first_frame_then_stall_is_not_masked_by_lifetime_frame_count() {
        let started_at = std::time::Instant::now();
        let mut heartbeat = CaptionAudioHeartbeat::new(started_at);
        heartbeat.record_frame(started_at + std::time::Duration::from_secs(1));

        assert_eq!(
            heartbeat.failure_at(started_at + std::time::Duration::from_secs(8)),
            None
        );
        assert_eq!(
            heartbeat.failure_at(started_at + std::time::Duration::from_secs(9)),
            Some(CaptionAudioPathFailure::Stalled),
            "one historical frame must not keep an active path healthy forever"
        );
    }

    #[test]
    fn silent_frames_keep_caption_audio_heartbeat_healthy() {
        let started_at = std::time::Instant::now();
        let mut heartbeat = CaptionAudioHeartbeat::new(started_at);
        for second in [1, 7, 13, 19] {
            // Heartbeat is intentionally independent of sample energy: native
            // mute and ordinary quiet still deliver healthy digital-silence frames.
            heartbeat.record_frame(started_at + std::time::Duration::from_secs(second));
        }
        assert_eq!(
            heartbeat.failure_at(started_at + std::time::Duration::from_secs(26)),
            None
        );
    }

    #[test]
    fn receiver_disconnect_blocks_only_while_caption_audio_is_expected() {
        assert_eq!(
            caption_disconnect_failure(true),
            Some(CaptionAudioPathFailure::Disconnected)
        );
        assert_eq!(
            caption_disconnect_failure(false),
            None,
            "capture teardown and explicit caption stop close the bus intentionally"
        );
    }

    #[test]
    fn wav_header_describes_16k_mono_s16le() {
        let wav = encode_wav_16k_mono(&[0, 1, -1]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1); // channels
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16); // bits/sample
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 6); // data bytes
        assert_eq!(wav.len(), 44 + 6);
    }

    fn encode_test_png(width: u32, height: u32) -> String {
        use base64::Engine as _;
        let mut png = Vec::new();
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([255, 0, 0, 128]));
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("test png encodes");
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    #[test]
    fn caption_leg_plan_matrix() {
        use CaptionBurnTarget::*;
        let plan = caption_overlay_leg_plan;
        let expected =
            |primary, aux, force_same_profile_split, captioned_copy| CaptionOverlayLegPlan {
                primary,
                aux,
                force_same_profile_split,
                captioned_copy,
            };

        // Record-only: no live overlay ever touches the source recording.
        assert_eq!(plan(true, false, Off), expected(false, false, false, false));
        assert_eq!(
            plan(true, false, Stream),
            expected(false, false, false, false)
        );
        assert_eq!(
            plan(true, false, Recording),
            expected(false, false, false, true)
        );
        assert_eq!(plan(true, false, Both), expected(false, false, false, true));

        // Stream-only: the primary leg is the stream; recording selection is
        // inert because there is no source recording from which to make a copy.
        assert_eq!(plan(false, true, Off), expected(false, false, false, false));
        assert_eq!(
            plan(false, true, Stream),
            expected(true, false, false, false)
        );
        assert_eq!(
            plan(false, true, Recording),
            expected(false, false, false, false)
        );
        assert_eq!(plan(false, true, Both), expected(true, false, false, false));

        // Combined: the source recording remains clean. Any captioned stream
        // uses one auxiliary leg (never primary + aux), even at the same profile.
        assert_eq!(plan(true, true, Off), expected(false, false, false, false));
        assert_eq!(plan(true, true, Stream), expected(false, true, true, false));
        assert_eq!(
            plan(true, true, Recording),
            expected(false, false, false, true)
        );
        assert_eq!(plan(true, true, Both), expected(false, true, true, true));

        assert_eq!(
            plan(false, false, Both),
            expected(false, false, false, false)
        );
    }

    #[test]
    fn highlight_leg_plan_follows_the_stream_leg() {
        // Record-only: no viewers, no highlight.
        assert_eq!(
            highlight_overlay_leg_plan(true, false, false),
            (false, false)
        );
        // Stream-only: the primary leg IS the stream.
        assert_eq!(
            highlight_overlay_leg_plan(false, true, false),
            (true, false)
        );
        // Record + split stream leg: highlight rides the aux (stream) leg only.
        assert_eq!(highlight_overlay_leg_plan(true, true, true), (false, true));
        // Record + stream sharing one leg: viewers and recording share pixels.
        assert_eq!(highlight_overlay_leg_plan(true, true, false), (true, false));
        // Idle sessions never burn.
        assert_eq!(
            highlight_overlay_leg_plan(false, false, false),
            (false, false)
        );
    }

    #[test]
    fn epoch_filter_drops_records_from_previous_recordings() {
        let mut previous = chunk(1, 118.0, "last words of the old video", &[]);
        previous.capture_epoch = 3;
        let mut current = chunk(2, 0.4, "first words of the new video", &[]);
        current.capture_epoch = 4;
        let kept = filter_caption_records_for_epoch(vec![previous, current], 4);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].text, "first words of the new video");
        assert_eq!(filter_caption_records_for_epoch(Vec::new(), 7), Vec::new());
    }

    #[test]
    fn failed_capture_cues_are_purged_before_the_next_capture_epoch() {
        let mut coordinator = CaptionsCoordinator::default();
        advance_caption_capture_epoch_and_purge(&mut coordinator);
        let failed_epoch = coordinator.capture_epoch;
        let mut failed = chunk(1, 0.0, "private words from failed capture A", &[]);
        failed.capture_epoch = failed_epoch;
        coordinator.chunks.push(failed);

        assert_eq!(advance_caption_capture_epoch_and_purge(&mut coordinator), 1);
        assert!(coordinator.chunks.is_empty());
        assert!(coordinator.capture_epoch > failed_epoch);

        // Capture B gets another authoritative boundary and only its own epoch
        // can survive artifact filtering.
        advance_caption_capture_epoch_and_purge(&mut coordinator);
        let successful_epoch = coordinator.capture_epoch;
        let mut successful = chunk(1, 0.0, "capture B", &[]);
        successful.capture_epoch = successful_epoch;
        coordinator.chunks.push(successful.clone());
        let drained = filter_caption_records_for_epoch(
            std::mem::take(&mut coordinator.chunks),
            successful_epoch,
        );
        assert_eq!(drained, vec![successful]);
        assert_ne!(failed_epoch, successful_epoch);
    }

    #[test]
    fn drained_artifact_keeps_its_epoch_style_and_generation_across_capture_start() {
        let mut coordinator = CaptionsCoordinator::default();
        coordinator.capture_epoch = 12;
        coordinator.artifact_generation = 7;
        let frozen_style = CaptionStyleSnapshot {
            position: CaptionOverlayPosition::Top,
            text_size: CaptionTextSize::L,
            style_id: CaptionStyleId::HighContrast,
            style_revision: 42,
            output_width: 3_840,
            output_height: 2_160,
        };
        coordinator.finalized_style = Some(frozen_style);
        let mut finalized = chunk(3, 1.25, "owned by capture twelve", &[]);
        finalized.capture_epoch = 12;
        coordinator.chunks.push(finalized.clone());

        let artifact = take_finalized_caption_artifact(&mut coordinator);
        advance_caption_capture_epoch_and_purge(&mut coordinator);
        coordinator.style = CaptionStyleSnapshot {
            style_revision: 43,
            output_width: 1_920,
            output_height: 1_080,
            ..CaptionStyleSnapshot::default()
        };

        assert_eq!(artifact.chunks, vec![finalized]);
        assert_eq!(artifact.style, frozen_style);
        assert_eq!(artifact.artifact_generation, 7);
        assert_eq!(coordinator.capture_epoch, 13);
        assert_ne!(artifact.style, coordinator.style);
    }

    #[tokio::test]
    async fn stale_privacy_generation_cannot_publish_srt_or_renderer_cues() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-generation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let recording_path = root.join("recording.mp4");
        let srt_path = recording_path.with_extension("srt");
        let frames_dir = recording_path.with_extension("captions-frames");
        let state = test_caption_app_state();
        state.captions.lock().await.artifact_generation = 2;
        let mut events = state.events.subscribe();
        let stale = FinalizedCaptionArtifact {
            chunks: vec![chunk(1, 0.0, "private stale cue", &[])],
            style: CaptionStyleSnapshot {
                output_width: 1_920,
                output_height: 1_080,
                ..CaptionStyleSnapshot::default()
            },
            artifact_generation: 1,
        };

        let stale = write_caption_artifacts(&state, "stale", &recording_path, stale).await;
        begin_caption_cue_render(&state, "stale", "ffmpeg", &recording_path, &stale).await;
        assert!(!srt_path.exists());
        assert!(!frames_dir.exists());
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .all(|event| event.event != "captions.cues.render-request"),
            "a request invalidated by sign-out generation must emit no cue text"
        );

        let current = FinalizedCaptionArtifact {
            chunks: vec![chunk(2, 0.0, "current cue", &[])],
            style: stale.style,
            artifact_generation: 2,
        };
        let current = write_caption_artifacts(&state, "current", &recording_path, current).await;
        assert!(
            srt_path.exists(),
            "a current-generation SRT is fully published before write returns"
        );
        begin_caption_cue_render(&state, "current", "ffmpeg", &recording_path, &current).await;
        let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(emitted.iter().any(|event| {
            event.event == "captions.cues.render-request"
                && event.payload["cues"][0]["text"] == "current cue"
        }));

        shutdown_caption_artifacts(&state).await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn stream_only_caption_text_is_dropped_while_recorded_sessions_retain_current_epoch() {
        let mut previous = chunk(1, 0.0, "previous", &[]);
        previous.capture_epoch = 2;
        let mut current = chunk(2, 0.0, "current", &[]);
        current.capture_epoch = 3;

        let retained =
            caption_records_for_session_end(vec![previous.clone(), current.clone()], 3, true);
        assert_eq!(retained, vec![current]);
        assert!(caption_records_for_session_end(vec![previous], 2, false).is_empty());
    }

    #[test]
    fn live_style_update_preserves_canvas_and_rejects_stale_revisions() {
        let current = CaptionStyleSnapshot {
            position: CaptionOverlayPosition::Bottom,
            text_size: CaptionTextSize::M,
            style_id: CaptionStyleId::Glass,
            style_revision: 4,
            output_width: 3_840,
            output_height: 2_160,
        };
        let updated = apply_caption_style_update(
            current,
            SetCaptionStyleParams {
                position: CaptionOverlayPosition::Top,
                text_size: CaptionTextSize::L,
                style_id: CaptionStyleId::HighContrast,
                style_revision: 5,
            },
        )
        .unwrap();
        assert_eq!(
            (updated.output_width, updated.output_height),
            (3_840, 2_160)
        );
        assert_eq!(updated.style_id, CaptionStyleId::HighContrast);
        assert_eq!(updated.style_revision, 5);

        let later_ui_edit = CaptionStyleSnapshot {
            style_id: CaptionStyleId::Classic,
            style_revision: 6,
            ..updated
        };
        assert_eq!(
            caption_style_for_final_artifact(Some(updated), later_ui_edit),
            updated,
            "the style frozen at capture stop owns the whole captioned copy"
        );

        let stale = apply_caption_style_update(
            updated,
            SetCaptionStyleParams {
                position: CaptionOverlayPosition::Bottom,
                text_size: CaptionTextSize::S,
                style_id: CaptionStyleId::Classic,
                style_revision: 4,
            },
        )
        .unwrap_err();
        assert_eq!(caption_style_error_code(&stale), "captions-style-stale");
    }

    #[test]
    fn caption_backoff_doubles_to_a_thirty_second_cap() {
        use std::time::Duration;
        let first = next_caption_backoff(None);
        assert_eq!(first, Duration::from_secs(2));
        let second = next_caption_backoff(Some(first));
        assert_eq!(second, Duration::from_secs(4));
        let mut current = second;
        for _ in 0..10 {
            current = next_caption_backoff(Some(current));
        }
        assert_eq!(current, Duration::from_secs(30));
    }

    #[test]
    fn configuration_send_failures_exhaust_realtime_retry_budget() {
        use std::time::Duration;

        let mut attempts = 0;
        let mut backoff = None;
        assert_eq!(
            next_realtime_retry_delay(&mut attempts, &mut backoff),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            next_realtime_retry_delay(&mut attempts, &mut backoff),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            next_realtime_retry_delay(&mut attempts, &mut backoff),
            None,
            "an accepting-then-closing gateway must fall back instead of spinning"
        );
    }

    #[test]
    fn configuration_ack_then_close_still_exhausts_realtime_retry_budget() {
        use std::time::Duration;

        let mut budget = RealtimeRetryBudget::default();
        assert_eq!(budget.retry_delay(), Some(Duration::from_secs(2)));

        // A socket accepting configuration is not proof that transcription is
        // healthy. Repeated ack-then-close cycles must remain bounded.
        budget.observe(RealtimeHealthEvidence::ConfigurationAcknowledged);
        assert_eq!(budget.retry_delay(), Some(Duration::from_secs(4)));
        budget.observe(RealtimeHealthEvidence::ConfigurationAcknowledged);
        assert_eq!(budget.retry_delay(), None);

        // A real transcript or a sustained healthy interval earns a fresh
        // reconnect budget.
        budget.observe(RealtimeHealthEvidence::Transcript);
        assert_eq!(budget.retry_delay(), Some(Duration::from_secs(2)));
        budget.observe(RealtimeHealthEvidence::StableInterval);
        assert_eq!(budget.retry_delay(), Some(Duration::from_secs(2)));
    }

    #[test]
    fn chunk_buffer_drains_while_upload_is_pending_and_flushes_final_remainder() {
        let sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(0.0);
        let mut buffer = CaptionChunkBuffer::new(4, 4);

        assert_eq!(
            buffer.push_samples(vec![1, 2, 3, 4], 7, &sequence, &mut timeline),
            0.0
        );
        let in_flight = buffer.pop_front().expect("first chunk starts uploading");
        assert_eq!(in_flight.seq, 1);

        // The first upload is still pending. New conversation must continue
        // entering the bounded queue instead of backing up the tap receiver.
        assert_eq!(
            buffer.push_samples(
                vec![5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
                7,
                &sequence,
                &mut timeline,
            ),
            0.0
        );
        assert_eq!(buffer.pending_len(), 2);
        assert_eq!(buffer.flush_remainder(7, &sequence, &mut timeline), 0.0);

        let queued = buffer.drain_pending();
        assert_eq!(
            queued.iter().map(|chunk| chunk.seq).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(queued.last().map(|chunk| chunk.samples.len()), Some(2));
        assert!(
            queued
                .last()
                .is_some_and(|chunk| chunk.duration_seconds < 3.0)
        );
    }

    #[test]
    fn final_drain_budget_covers_two_near_timeout_uploads_and_remains_bounded() {
        let two_uploads = caption_final_upload_grace(2);
        assert_eq!(
            two_uploads,
            CAPTION_CHUNK_UPLOAD_TIMEOUT
                .saturating_mul(2)
                .saturating_add(CAPTION_FINAL_UPLOAD_OVERHEAD)
        );
        assert!(two_uploads > std::time::Duration::from_secs(20));
        assert_eq!(
            caption_final_upload_grace(CAPTION_FINAL_UPLOAD_COUNT),
            std::time::Duration::from_secs(22),
            "capture stop is bounded to the in-flight upload plus final remainder"
        );
    }

    #[test]
    fn capture_close_drops_failed_uploads_without_starving_the_final_remainder() {
        let sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(0.0);
        let mut policy_buffer = CaptionChunkBuffer::new(4, 4);
        policy_buffer.push_samples(vec![1; 8], 3, &sequence, &mut timeline);
        let failed = policy_buffer
            .pop_front()
            .expect("first upload fails transiently");
        let failed_duration = failed.duration_seconds;
        let now = tokio::time::Instant::now();
        let mut backoff = None;
        let mut next_upload_allowed_at = now;
        let open_transition = apply_caption_chunk_transient_failure(
            true,
            failed,
            &mut policy_buffer,
            &mut backoff,
            &mut next_upload_allowed_at,
            now,
        );
        assert_eq!(
            open_transition.action,
            CaptionChunkTransientAction::RetryWithBackoff {
                wait: std::time::Duration::from_secs(2)
            }
        );
        assert_eq!(backoff, Some(std::time::Duration::from_secs(2)));
        assert_eq!(
            next_upload_allowed_at,
            now + std::time::Duration::from_secs(2)
        );

        let failed_at_close = policy_buffer
            .pop_front()
            .expect("retry is at the front of the queue");
        backoff = Some(std::time::Duration::from_secs(30));
        next_upload_allowed_at = now + std::time::Duration::from_secs(30);
        let closed_at = now + std::time::Duration::from_secs(1);
        let closed_transition = apply_caption_chunk_transient_failure(
            false,
            failed_at_close,
            &mut policy_buffer,
            &mut backoff,
            &mut next_upload_allowed_at,
            closed_at,
        );
        assert_eq!(
            closed_transition.action,
            CaptionChunkTransientAction::DropAndContinueFinalDrain
        );
        assert_eq!(closed_transition.dropped_seconds, failed_duration);
        assert_eq!(backoff, None, "capture close clears retry backoff");
        assert_eq!(
            next_upload_allowed_at, closed_at,
            "the next unique queued chunk is eligible immediately"
        );
        assert_eq!(
            policy_buffer.pop_front().map(|chunk| chunk.seq),
            Some(2),
            "the failed close-time chunk is not requeued ahead of the remainder"
        );

        let final_sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(0.0);
        let mut buffer = CaptionChunkBuffer::new(4, MAX_BUFFERED_CAPTION_CHUNKS);
        buffer.push_samples(vec![1; 4], 3, &final_sequence, &mut timeline);
        let in_flight = buffer.pop_front().expect("one upload is in flight");
        assert_eq!(in_flight.seq, 1);

        // Fill all eight queue slots while the first upload is near timeout,
        // then close with a short final remainder. Stop drops the old backlog,
        // preserves the tail, clears backoff, and leaves only two attempts.
        buffer.push_samples(
            vec![2; MAX_BUFFERED_CAPTION_CHUNKS * 4 + 2],
            3,
            &final_sequence,
            &mut timeline,
        );
        let mut final_backoff = Some(std::time::Duration::from_secs(30));
        let mut final_next_upload = now + std::time::Duration::from_secs(30);
        let closed_at = now + std::time::Duration::from_secs(5);
        let dropped = prepare_caption_final_drain(
            &mut buffer,
            3,
            &final_sequence,
            &mut timeline,
            &mut final_backoff,
            &mut final_next_upload,
            closed_at,
        );
        assert!(dropped > 0.0, "older queued backlog is surfaced as dropped");
        assert_eq!(final_backoff, None);
        assert_eq!(final_next_upload, closed_at);
        assert_eq!(1 + buffer.pending_len(), CAPTION_FINAL_UPLOAD_COUNT);
        let queued = buffer.drain_pending();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued.last().map(|chunk| chunk.samples.len()), Some(2));
    }

    #[test]
    fn capture_close_exact_boundary_preserves_the_newest_full_chunk() {
        let sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(0.0);
        let mut buffer = CaptionChunkBuffer::new(4, MAX_BUFFERED_CAPTION_CHUNKS);
        buffer.push_samples(vec![1; 4], 9, &sequence, &mut timeline);
        let in_flight = buffer.pop_front().expect("one upload is in flight");
        assert_eq!(in_flight.seq, 1);

        // Three exact full chunks arrive while that upload is pending. There is
        // no PCM remainder, so the newest full chunk (seq 4) owns the last words.
        buffer.push_samples(vec![2; 12], 9, &sequence, &mut timeline);
        assert!(buffer.pcm.is_empty());
        let now = tokio::time::Instant::now();
        let mut backoff = Some(std::time::Duration::from_secs(30));
        let mut next_upload_allowed_at = now + std::time::Duration::from_secs(30);
        let dropped = prepare_caption_final_drain(
            &mut buffer,
            9,
            &sequence,
            &mut timeline,
            &mut backoff,
            &mut next_upload_allowed_at,
            now,
        );

        assert_eq!(
            dropped,
            8.0 / f64::from(CAPTION_SAMPLE_RATE),
            "only the two older queued full chunks are discarded"
        );
        let retained = buffer.drain_pending();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].seq, 4);
        assert_eq!(retained[0].samples.len(), 4);
        assert_eq!(1 + retained.len(), CAPTION_FINAL_UPLOAD_COUNT);
        assert_eq!(backoff, None);
        assert_eq!(next_upload_allowed_at, now);
    }

    #[test]
    fn caption_sequence_survives_off_on_runtime_restarts_until_capture_reset() {
        let capture_sequence = CaptionSequence::default();
        let first_runtime = capture_sequence.clone();
        assert_eq!(first_runtime.next(), 1);
        assert_eq!(first_runtime.next(), 2);

        // Turning captions off and back on creates another provider runtime,
        // but the recording still owns one monotonic artifact namespace.
        let second_runtime = capture_sequence.clone();
        assert_eq!(second_runtime.next(), 3);

        capture_sequence.reset();
        assert_eq!(capture_sequence.next(), 1);
    }

    #[test]
    fn anchor_resets_only_on_timestamp_regression() {
        assert!(!caption_anchor_should_reset(None, 0));
        assert!(!caption_anchor_should_reset(Some(10), 10));
        assert!(!caption_anchor_should_reset(Some(10), 11));
        assert!(caption_anchor_should_reset(Some(10), 3));
    }

    fn chunk(
        seq: u64,
        offset: f64,
        text: &str,
        segments: &[(&str, f64, f64)],
    ) -> CaptionChunkRecord {
        CaptionChunkRecord {
            seq,
            offset_seconds: offset,
            duration_seconds: 3.0,
            text: text.to_string(),
            segments: segments
                .iter()
                .map(|(word, start, end)| CaptionSegment {
                    text: (*word).to_string(),
                    start_second: *start,
                    end_second: *end,
                })
                .collect(),
            capture_epoch: 0,
            provider_item_id: None,
        }
    }

    #[test]
    fn srt_uses_segment_timing_and_absolute_offsets() {
        let srt = render_srt(&[
            chunk(
                1,
                0.0,
                "Hello viewers",
                &[("Hello", 0.10, 0.50), ("viewers", 0.60, 1.20)],
            ),
            chunk(
                2,
                3.0,
                "welcome back",
                &[("welcome", 0.05, 0.40), ("back", 0.50, 0.90)],
            ),
        ]);
        assert_eq!(
            srt,
            "1\n00:00:00,100 --> 00:00:01,200\nHello viewers\n\n\
             2\n00:00:03,050 --> 00:00:03,900\nwelcome back\n\n"
        );
    }

    #[test]
    fn chunk_buffer_is_bounded_and_reports_evicted_audio() {
        let sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(0.0);
        let mut buffer = CaptionChunkBuffer::new(4, 2);

        let dropped = buffer.push_samples(
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            1,
            &sequence,
            &mut timeline,
        );

        assert!(dropped > 0.0, "bounded overflow must be observable");
        assert_eq!(buffer.pending_len(), 2);
        assert_eq!(
            buffer
                .drain_pending()
                .into_iter()
                .map(|chunk| chunk.seq)
                .collect::<Vec<_>>(),
            vec![2, 3],
            "the queue evicts the oldest audio so live captions can catch up"
        );
    }

    #[test]
    fn srt_falls_back_to_the_chunk_window_and_clamps_overlaps() {
        let srt = render_srt(&[
            // No segments: full chunk window 6.0-9.0…
            chunk(1, 6.0, "no timing here", &[]),
            // …but the next cue starts at 8.5, so the first must clamp.
            chunk(2, 8.0, "overlapping", &[("overlapping", 0.5, 1.5)]),
        ]);
        assert_eq!(
            srt,
            "1\n00:00:06,000 --> 00:00:08,500\nno timing here\n\n\
             2\n00:00:08,500 --> 00:00:09,500\noverlapping\n\n"
        );
    }

    #[test]
    fn srt_skips_empty_chunks_entirely() {
        assert_eq!(render_srt(&[chunk(1, 0.0, "   ", &[])]), "");
        assert_eq!(render_srt(&[]), "");
    }

    #[test]
    fn concat_track_alternates_gaps_and_cues_with_exact_durations() {
        let cues = caption_cues(&[
            chunk(
                3,
                3.0,
                "hello there",
                &[("hello", 0.10, 0.60), ("there", 0.70, 1.20)],
            ),
            chunk(7, 9.0, "again", &[("again", 0.05, 0.80)]),
        ]);
        let list = build_caption_track_concat(&cues, 0);
        assert_eq!(
            list,
            "ffconcat version 1.0\n\
             file '0.png'\nduration 3.100\n\
             file '3.png'\nduration 1.100\n\
             file '0.png'\nduration 4.850\n\
             file '7.png'\nduration 0.750\n\
             file '0.png'\nduration 0.100\n\
             file '0.png'\n"
        );
    }

    #[test]
    fn concat_track_handles_back_to_back_cues_and_zero_length_windows() {
        let cues = vec![
            CaptionCue {
                seq: 1,
                start_seconds: 0.0,
                end_seconds: 3.0,
                text: "a".into(),
            },
            CaptionCue {
                seq: 2,
                start_seconds: 3.0,
                end_seconds: 3.0, // degenerate window gets a minimum duration
                text: "b".into(),
            },
        ];
        let list = build_caption_track_concat(&cues, 0);
        // No gap entry between back-to-back cues; degenerate cue gets 50ms.
        assert_eq!(
            list,
            "ffconcat version 1.0\n\
             file '1.png'\nduration 3.000\n\
             file '2.png'\nduration 0.050\n\
             file '0.png'\nduration 0.100\n\
             file '0.png'\n"
        );
    }

    #[test]
    fn cue_render_watchdog_allows_hundreds_of_frames_while_progress_continues() {
        let started_at = tokio::time::Instant::now();
        let mut last_progress_at = started_at;
        let mut received = std::collections::BTreeSet::new();

        for seq in 1..=400_u64 {
            let now = started_at + std::time::Duration::from_secs(seq * 20);
            if received.insert(seq) {
                assert!(
                    !cue_render_is_inactive(last_progress_at, now),
                    "unique cue {seq} arrived before the inactivity deadline"
                );
                last_progress_at = now;
            }
        }

        assert!(last_progress_at.duration_since(started_at) > std::time::Duration::from_secs(30));
        assert!(!cue_render_is_inactive(
            last_progress_at,
            cue_render_inactivity_deadline(last_progress_at) - std::time::Duration::from_millis(1),
        ));
        let duplicate_at = last_progress_at + std::time::Duration::from_secs(29);
        assert!(!received.insert(400), "duplicate frames are not progress");
        assert!(!cue_render_is_inactive(last_progress_at, duplicate_at));
        assert!(cue_render_is_inactive(
            last_progress_at,
            duplicate_at + std::time::Duration::from_secs(1),
        ));
    }

    fn pending_render_for_test(request_id: &str, artifact_generation: u64) -> PendingCueRender {
        PendingCueRender {
            session_id: format!("session-{request_id}"),
            ffmpeg_path: "ffmpeg".to_string(),
            recording_path: std::path::PathBuf::from(format!("/{request_id}.mp4")),
            frames_dir: std::path::PathBuf::from(format!("/{request_id}.captions-frames")),
            cues: vec![CaptionCue {
                seq: 1,
                start_seconds: 0.0,
                end_seconds: 1.0,
                text: request_id.to_string(),
            }],
            expected: [1, CAPTION_BLANK_FRAME_SEQ].into_iter().collect(),
            received: std::collections::BTreeSet::new(),
            artifact_generation,
            last_progress_at: tokio::time::Instant::now(),
            watchdog_active: false,
        }
    }

    #[test]
    fn back_to_back_finalized_render_requests_are_retained_independently() {
        let mut coordinator = CaptionsCoordinator::default();
        coordinator
            .pending_cue_renders
            .insert("first".to_string(), pending_render_for_test("first", 4));
        coordinator
            .pending_cue_render_order
            .push_back("first".to_string());

        // A new capture advances transcript ownership but must not replace a
        // finalized recording's renderer request.
        advance_caption_capture_epoch_and_purge(&mut coordinator);
        coordinator
            .pending_cue_renders
            .insert("second".to_string(), pending_render_for_test("second", 4));
        coordinator
            .pending_cue_render_order
            .push_back("second".to_string());

        assert_eq!(coordinator.pending_cue_renders.len(), 2);
        coordinator
            .pending_cue_renders
            .get_mut("first")
            .unwrap()
            .received
            .insert(1);
        assert!(
            coordinator
                .pending_cue_renders
                .get("second")
                .unwrap()
                .received
                .is_empty(),
            "each request keeps independent frame progress"
        );
        assert_eq!(
            remove_pending_cue_render(&mut coordinator, "first")
                .unwrap()
                .artifact_generation,
            4
        );
        assert!(coordinator.pending_cue_renders.contains_key("second"));
        assert_eq!(
            coordinator
                .pending_cue_render_order
                .front()
                .map(String::as_str),
            Some("second")
        );
    }

    #[test]
    fn queued_render_starts_a_fresh_watchdog_window_when_promoted() {
        let mut coordinator = CaptionsCoordinator::default();
        for request_id in ["first", "second"] {
            coordinator.pending_cue_renders.insert(
                request_id.to_string(),
                pending_render_for_test(request_id, 5),
            );
            coordinator
                .pending_cue_render_order
                .push_back(request_id.to_string());
        }
        let started_at = tokio::time::Instant::now();
        assert_eq!(
            pending_cue_render_watchdog_state(&mut coordinator, "second", started_at),
            CueRenderWatchdogState::Queued
        );
        assert_eq!(
            pending_cue_render_watchdog_state(&mut coordinator, "first", started_at),
            CueRenderWatchdogState::ActiveUntil(cue_render_inactivity_deadline(started_at))
        );

        remove_pending_cue_render(&mut coordinator, "first").unwrap();
        let promoted_at = started_at + std::time::Duration::from_secs(90);
        assert_eq!(
            pending_cue_render_watchdog_state(&mut coordinator, "second", promoted_at),
            CueRenderWatchdogState::ActiveUntil(cue_render_inactivity_deadline(promoted_at)),
            "time spent waiting in the renderer FIFO is not inactivity"
        );
    }

    #[test]
    fn privacy_teardown_takes_every_pending_render_cache() {
        let mut coordinator = CaptionsCoordinator::default();
        for request_id in ["first", "second"] {
            coordinator.pending_cue_renders.insert(
                request_id.to_string(),
                pending_render_for_test(request_id, 8),
            );
            coordinator
                .pending_cue_render_order
                .push_back(request_id.to_string());
        }

        let mut frames_dirs = take_pending_caption_frame_dirs(&mut coordinator);
        frames_dirs.sort();
        assert_eq!(
            frames_dirs,
            vec![
                std::path::PathBuf::from("/first.captions-frames"),
                std::path::PathBuf::from("/second.captions-frames"),
            ]
        );
        assert!(coordinator.pending_cue_renders.is_empty());
        assert!(coordinator.pending_cue_render_order.is_empty());
    }

    #[test]
    fn capture_preemption_retries_caption_burn_but_sign_out_is_terminal() {
        assert_eq!(
            caption_burn_interruption(false, true),
            Some(CaptionBurnInterruption::RetryAfterCapture)
        );
        assert_eq!(
            caption_burn_interruption(true, true),
            Some(CaptionBurnInterruption::CancelForSignOut),
            "privacy cancellation wins when capture and sign-out race"
        );
        assert_eq!(caption_burn_interruption(false, false), None);
    }

    #[tokio::test]
    async fn backend_shutdown_joins_burns_and_removes_every_private_artifact() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-shutdown-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let pending_frames = root.join("pending.captions-frames");
        let burn_frames = root.join("burn.captions-frames");
        let partial_output = root.join("recording (captioned).mp4");
        tokio::fs::create_dir_all(&pending_frames).await.unwrap();
        tokio::fs::create_dir_all(&burn_frames).await.unwrap();
        tokio::fs::write(pending_frames.join("1.png"), b"pending private frame")
            .await
            .unwrap();
        tokio::fs::write(burn_frames.join("1.png"), b"burn private frame")
            .await
            .unwrap();
        tokio::fs::write(&partial_output, b"partial captioned copy")
            .await
            .unwrap();

        let state = test_caption_app_state();
        let (cancel, mut cancel_receiver) = watch::channel(false);
        let joined = Arc::new(AtomicBool::new(false));
        let task_joined = joined.clone();
        let join = tokio::spawn(async move {
            wait_for_caption_burn_cancel(&mut cancel_receiver).await;
            task_joined.store(true, Ordering::Release);
        });
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.artifact_generation = 11;
            let mut pending = pending_render_for_test("pending", 11);
            pending.frames_dir = pending_frames.clone();
            coordinator
                .pending_cue_renders
                .insert("pending".to_string(), pending);
            coordinator
                .pending_cue_render_order
                .push_back("pending".to_string());
            coordinator.caption_burn_tasks.push(CaptionBurnTask {
                cancel,
                join,
                output_path: partial_output.clone(),
                frames_dir: burn_frames.clone(),
            });
        }

        shutdown_caption_artifacts(&state).await;

        let coordinator = state.captions.lock().await;
        assert_eq!(coordinator.artifact_generation, 12);
        assert!(coordinator.pending_cue_renders.is_empty());
        assert!(coordinator.pending_cue_render_order.is_empty());
        assert!(coordinator.caption_burn_tasks.is_empty());
        drop(coordinator);
        assert!(joined.load(Ordering::Acquire));
        assert!(!pending_frames.exists());
        assert!(!burn_frames.exists());
        assert!(!partial_output.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn caption_burn_cancellation_joins_and_removes_partial_private_artifacts() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-burn-cancel-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let frames_dir = root.join("recording.captions-frames");
        let output_path = root.join("recording (captioned).mp4");
        tokio::fs::create_dir_all(&frames_dir).await.unwrap();
        tokio::fs::write(frames_dir.join("1.png"), b"private frame")
            .await
            .unwrap();
        tokio::fs::write(&output_path, b"partial private output")
            .await
            .unwrap();

        let (cancel, mut cancel_receiver) = watch::channel(false);
        let finished = Arc::new(AtomicBool::new(false));
        let task_finished = finished.clone();
        let join = tokio::spawn(async move {
            wait_for_caption_burn_cancel(&mut cancel_receiver).await;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            task_finished.store(true, Ordering::Release);
        });
        cancel_and_join_caption_burn_tasks(vec![CaptionBurnTask {
            cancel,
            join,
            output_path: output_path.clone(),
            frames_dir: frames_dir.clone(),
        }])
        .await;

        assert!(
            finished.load(Ordering::Acquire),
            "privacy teardown returns only after the burn task has joined"
        );
        assert!(!output_path.exists());
        assert!(!frames_dir.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn caption_burn_ready_requires_the_current_privacy_generation() {
        assert!(caption_burn_can_publish_ready(false, 7, 7));
        assert!(!caption_burn_can_publish_ready(true, 7, 7));
        assert!(!caption_burn_can_publish_ready(false, 7, 8));
    }

    #[test]
    fn captioned_copy_path_appends_suffix() {
        assert_eq!(
            captioned_copy_path(std::path::Path::new("/tmp/Recording 12.mp4")),
            std::path::PathBuf::from("/tmp/Recording 12 (captioned).mp4")
        );
    }

    #[test]
    fn caption_segment_parses_web_camel_case() {
        let segment: CaptionSegment =
            serde_json::from_str(r#"{"text":"Hello","startSecond":0.02,"endSecond":0.42}"#)
                .expect("segment parses");
        assert_eq!(
            segment,
            CaptionSegment {
                text: "Hello".to_string(),
                start_second: 0.02,
                end_second: 0.42
            }
        );
    }

    #[test]
    fn overlay_installs_decodes_and_revs() {
        let slot = new_caption_overlay_slot();
        let info = install_caption_overlay(
            &slot,
            &encode_test_png(4, 2),
            CaptionOverlayPosition::Bottom,
        )
        .expect("valid overlay installs");
        assert!(info.active);
        assert_eq!((info.width, info.height), (4, 2));
        assert_eq!(info.revision, 1);

        let overlay = current_caption_overlay(&slot).expect("overlay present");
        assert_eq!(overlay.rgba.len(), 4 * 2 * 4);
        assert_eq!(overlay.bgra.len(), overlay.rgba.len());
        for (rgba, bgra) in overlay
            .rgba
            .chunks_exact(4)
            .zip(overlay.bgra.chunks_exact(4))
        {
            assert_eq!(bgra, &[rgba[2], rgba[1], rgba[0], rgba[3]]);
        }
        assert_eq!(overlay.position, CaptionOverlayPosition::Bottom);

        let second =
            install_caption_overlay(&slot, &encode_test_png(6, 2), CaptionOverlayPosition::Top)
                .expect("replacement installs");
        assert_eq!(second.revision, 2);
    }

    #[test]
    fn overlay_rejects_garbage_and_keeps_previous() {
        let slot = new_caption_overlay_slot();
        install_caption_overlay(
            &slot,
            &encode_test_png(4, 2),
            CaptionOverlayPosition::Bottom,
        )
        .expect("valid overlay installs");

        assert!(
            install_caption_overlay(&slot, "not base64!!!", CaptionOverlayPosition::Bottom)
                .is_err()
        );
        assert!(install_caption_overlay(&slot, "", CaptionOverlayPosition::Bottom).is_err());
        {
            use base64::Engine as _;
            let not_an_image = base64::engine::general_purpose::STANDARD.encode(b"plain bytes");
            assert!(
                install_caption_overlay(&slot, &not_an_image, CaptionOverlayPosition::Bottom)
                    .is_err()
            );
        }

        let survivor = current_caption_overlay(&slot).expect("previous overlay kept");
        assert_eq!((survivor.width, survivor.height), (4, 2));
        assert_eq!(survivor.revision, 1);
    }

    #[test]
    fn overlay_rejects_out_of_range_dimensions_and_clears() {
        let slot = new_caption_overlay_slot();
        assert!(
            install_caption_overlay(
                &slot,
                &encode_test_png(4200, 2),
                CaptionOverlayPosition::Top
            )
            .is_err()
        );

        install_caption_overlay(
            &slot,
            &encode_test_png(4, 2),
            CaptionOverlayPosition::Bottom,
        )
        .expect("valid overlay installs");
        let cleared = clear_caption_overlay(&slot);
        assert!(!cleared.active);
        assert!(current_caption_overlay(&slot).is_none());
    }

    #[test]
    fn per_output_overlays_keep_distinct_4k_and_1080p_rasters() {
        let slots = new_caption_overlay_slots();
        install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(3_840, 320),
                position: CaptionOverlayPosition::Bottom,
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(5),
            },
        )
        .unwrap();
        let info = install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(1_920, 180),
                position: CaptionOverlayPosition::Top,
                target: Some(CaptionOverlayTarget::Auxiliary),
                style_revision: Some(5),
            },
        )
        .unwrap();
        assert!(info.active);
        assert_eq!((info.primary.width, info.primary.height), (3_840, 320));
        assert_eq!((info.auxiliary.width, info.auxiliary.height), (1_920, 180));

        let snapshot = current_caption_overlays(&slots);
        assert_eq!(snapshot.primary.unwrap().width, 3_840);
        assert_eq!(snapshot.auxiliary.unwrap().width, 1_920);
    }

    #[test]
    fn overlay_style_revision_rejects_stale_but_allows_same_revision_text_updates() {
        let slots = new_caption_overlay_slots();
        let first = install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(640, 100),
                position: CaptionOverlayPosition::Bottom,
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(9),
            },
        )
        .unwrap();
        let same_style_new_text = install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(700, 110),
                position: CaptionOverlayPosition::Bottom,
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(9),
            },
        )
        .unwrap();
        assert_eq!(
            first.primary.revision + 1,
            same_style_new_text.primary.revision
        );
        assert_eq!(same_style_new_text.primary.width, 700);

        let stale = install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(800, 120),
                position: CaptionOverlayPosition::Top,
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(8),
            },
        )
        .unwrap_err();
        assert_eq!(caption_overlay_error_code(&stale), "captions-overlay-stale");
        let survivor = current_caption_overlays(&slots).primary.unwrap();
        assert_eq!(
            (survivor.width, survivor.position),
            (700, CaptionOverlayPosition::Bottom)
        );

        let stale_clear = clear_caption_overlays(
            &slots,
            ClearCaptionOverlayParams {
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(7),
            },
        )
        .unwrap_err();
        assert_eq!(
            caption_overlay_error_code(&stale_clear),
            "captions-overlay-stale"
        );
        assert!(current_caption_overlays(&slots).primary.is_some());
    }

    #[test]
    fn missing_overlay_target_sets_and_clears_both_for_legacy_callers() {
        let slots = new_caption_overlay_slots();
        let set = install_caption_overlays(
            &slots,
            SetCaptionOverlayParams {
                png_base64: encode_test_png(800, 140),
                position: CaptionOverlayPosition::Bottom,
                target: None,
                style_revision: None,
            },
        )
        .unwrap();
        assert!(set.active);
        assert!(set.primary.active && set.auxiliary.active);

        let primary_clear = clear_caption_overlays(
            &slots,
            ClearCaptionOverlayParams {
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: None,
            },
        )
        .unwrap();
        assert!(primary_clear.active, "auxiliary is still active");
        assert!(!primary_clear.primary.active && primary_clear.auxiliary.active);

        let cleared = clear_caption_overlays(&slots, ClearCaptionOverlayParams::default()).unwrap();
        assert!(!cleared.active);
        assert!(!cleared.primary.active && !cleared.auxiliary.active);
    }

    #[test]
    fn overlay_and_style_rpc_params_use_the_documented_wire_contract() {
        let set: SetCaptionOverlayParams = serde_json::from_value(serde_json::json!({
            "pngBase64": "payload",
            "position": "top",
            "styleRevision": 3
        }))
        .unwrap();
        assert_eq!(
            set.target, None,
            "missing target is the legacy all-targets form"
        );
        assert_eq!(set.position, CaptionOverlayPosition::Top);
        assert_eq!(set.style_revision, Some(3));

        let clear: ClearCaptionOverlayParams = serde_json::from_value(serde_json::json!({
            "target": "auxiliary",
            "styleRevision": 4
        }))
        .unwrap();
        assert_eq!(clear.target, Some(CaptionOverlayTarget::Auxiliary));
        assert_eq!(clear.style_revision, Some(4));

        let style: SetCaptionStyleParams = serde_json::from_value(serde_json::json!({
            "position": "bottom",
            "textSize": "l",
            "styleId": "lower-third",
            "styleRevision": 5
        }))
        .unwrap();
        assert_eq!(style.text_size, CaptionTextSize::L);
        assert_eq!(style.style_id, CaptionStyleId::LowerThird);
        assert_eq!(style.style_revision, 5);
    }

    #[test]
    fn tap_offer_is_a_noop_when_inactive() {
        // Must never panic or block from the audio thread when captions are off.
        offer_caption_frame(&AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 2,
            samples: vec![0.0; 128],
        });
    }
}
