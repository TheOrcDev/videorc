//! Live captions: taps microphone PCM off the native audio pipeline and
//! transcribes it through videorc-web, streaming-first (S2): the gateway
//! realtime WebSocket (voice-model input-audio transcription events, ~1s
//! behind speech, partial + final updates) with automatic fallback to ~3s
//! chunked batch transcription (`/api/ai/captions/chunks` → grok-stt)
//! whenever streaming is unavailable. Transcripts broadcast to renderer
//! clients and accumulate as chunk records for the SRT + burned copy.

use std::ffi::OsString;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc, watch};

use crate::audio::AudioFrame;
use crate::overlay_layout::{
    OverlayAuxLeg, OverlayItem, OverlayOrientation, OverlayRect, OverlaySnap, overlay_leg_plan,
    overlay_snap_rect,
};
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
const CAPTION_START_SHUTDOWN_MESSAGE: &str =
    "Live captions start rejected because backend shutdown is already in progress.";
const CAPTION_START_SIGN_OUT_MESSAGE: &str = "Live captions start rejected because account sign-out is still cleaning up private caption data.";
const CAPTION_CANCEL_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const CAPTION_ABORT_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const CAPTION_PRIVATE_IO_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const CAPTION_PRIVATE_DIRECTORY_KIND: &str = "cue-frame-directory";
const CAPTION_PRIVATE_PARTIAL_FILE_KIND: &str = "caption-burn-partial";
const CAPTION_PRIVATE_OWNER_MARKER: &str = ".videorc-caption-owner";

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
#[cfg(test)]
static CAPTION_LIFECYCLE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub fn caption_lifecycle_test_lock() -> &'static tokio::sync::Mutex<()> {
    &CAPTION_LIFECYCLE_TEST_LOCK
}
/// Audio intentionally evicted from the bounded chunk queue, in milliseconds.
/// Zero in normal operation; non-zero is exposed in status and health events.
static CAPTION_AUDIO_MILLIS_DROPPED: AtomicU64 = AtomicU64::new(0);
static TAP_CLOCK_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
/// 1-based monotonic microseconds since `TAP_CLOCK_EPOCH`; zero means no frame
/// has entered the current caption bus. Updated on the producer fast path.
static TAP_LAST_FRAME_MICROS: AtomicU64 = AtomicU64::new(0);
static TAP: std::sync::Mutex<Option<mpsc::Sender<AudioFrame>>> = std::sync::Mutex::new(None);
// Only the explicit debug producer uses this sample clock and serialization.
// TAP protects its reset and every cursor advance/send; the captured sender
// identifies the installed tap without retaining another owner registry.
#[cfg(debug_assertions)]
static CAPTION_CONTRACT_AUDIO_CURSOR: AtomicU64 = AtomicU64::new(0);
#[cfg(debug_assertions)]
static CAPTION_CONTRACT_AUDIO_SERIAL: Mutex<()> = Mutex::const_new(());
/// Serializes caption control transitions across every backend WebSocket.
/// Without this guard a start racing sign-out could clone the bearer between
/// teardown and credential removal, then install a fresh provider task.
static CAPTION_CONTROL: Mutex<()> = Mutex::const_new(());
/// Serializes sign-out attempts without blocking ordinary capture-finalization
/// caption control while private artifact cleanup is in progress.
static CAPTION_SIGN_OUT_SERIAL: Mutex<()> = Mutex::const_new(());

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
        offer_caption_frame_to_sender(
            frame,
            sender,
            frames_seen,
            frames_dropped,
            last_frame_micros,
        );
    }
}

fn offer_caption_frame_to_sender(
    frame: &AudioFrame,
    sender: &mpsc::Sender<AudioFrame>,
    frames_seen: &AtomicU64,
    frames_dropped: &AtomicU64,
    last_frame_micros: &AtomicU64,
) {
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
    produce_caption_contract_test_audio(duration_ms).await
}
#[cfg(debug_assertions)]
pub async fn inject_caption_contract_test_quiet(duration_ms: u64) -> Result<u64> {
    if !caption_contract_test_enabled() {
        bail!("Caption contract test audio is disabled.")
    }
    produce_caption_contract_test_audio_at_peak(duration_ms, 0.0).await
}

// Kept separate from the RPC env guard so the maintained tests can exercise
// the actual debug producer and installed tap without changing global env.
#[cfg(debug_assertions)]
async fn produce_caption_contract_test_audio(duration_ms: u64) -> Result<u64> {
    produce_caption_contract_test_audio_at_peak(duration_ms, 0.12).await
}
#[cfg(debug_assertions)]
async fn produce_caption_contract_test_audio_at_peak(
    duration_ms: u64,
    raw_peak: f32,
) -> Result<u64> {
    // Capture the exact sender before awaiting serialization. A queued
    // request belongs to this tap, not whichever tap exists when it resumes.
    let sender = {
        let guard = TAP
            .lock()
            .map_err(|_| anyhow::anyhow!("Caption contract audio tap lock is unavailable."))?;
        guard
            .as_ref()
            .filter(|_| TAP_ACTIVE.load(Ordering::Relaxed))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("Start the caption contract session before injecting audio.")
            })?
    };
    let _producer_guard = CAPTION_CONTRACT_AUDIO_SERIAL.lock().await;
    {
        let guard = TAP
            .lock()
            .map_err(|_| anyhow::anyhow!("Caption contract audio tap lock is unavailable."))?;
        if !TAP_ACTIVE.load(Ordering::Relaxed)
            || !guard
                .as_ref()
                .is_some_and(|current| current.same_channel(&sender))
        {
            bail!("Caption contract audio tap was retired during injection.");
        }
    }
    let duration_ms = duration_ms.clamp(20, 5_000);
    let frames = duration_ms.div_ceil(20);
    let samples_per_channel = (48_000_u64 * 20 / 1_000) as usize;
    let before = TAP_FRAMES_SEEN.load(Ordering::Relaxed);
    let producer_started_at = std::time::Instant::now();
    for frame_index in 0..frames {
        let mut samples = Vec::with_capacity(samples_per_channel * 2);
        for sample_index in 0..samples_per_channel {
            let absolute = frame_index as usize * samples_per_channel + sample_index;
            let phase = absolute as f32 * 440.0 * std::f32::consts::TAU / 48_000.0;
            let sample = phase.sin() * raw_peak;
            samples.extend_from_slice(&[sample, sample]);
        }
        // Native frames represent completed PCM buffers. Pace this debug
        // producer by its sample clock too: stamping a 20ms buffer immediately
        // after grant would truthfully make its first samples pre-grant.
        let buffer_end =
            producer_started_at + std::time::Duration::from_millis((frame_index + 1) * 20);
        tokio::time::sleep_until(tokio::time::Instant::from_std(buffer_end)).await;
        let mut frame = AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 2,
            samples,
        };
        {
            let guard = TAP
                .lock()
                .map_err(|_| anyhow::anyhow!("Caption contract audio tap lock is unavailable."))?;
            let current = guard
                .as_ref()
                .filter(|current| {
                    TAP_ACTIVE.load(Ordering::Relaxed) && current.same_channel(&sender)
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("Caption contract audio tap was retired during injection.")
                })?;
            let cursor = CAPTION_CONTRACT_AUDIO_CURSOR.load(Ordering::Relaxed);
            let next = cursor
                .checked_add(20_000)
                .ok_or_else(|| anyhow::anyhow!("Caption contract sample clock is exhausted."))?;
            frame.timestamp_micros = cursor;
            CAPTION_CONTRACT_AUDIO_CURSOR.store(next, Ordering::Relaxed);
            offer_caption_frame_to_sender(
                &frame,
                current,
                &TAP_FRAMES_SEEN,
                &TAP_FRAMES_DROPPED,
                &TAP_LAST_FRAME_MICROS,
            );
        }
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
    {
        let mut guard = TAP.lock().expect("caption tap lock");
        #[cfg(debug_assertions)]
        CAPTION_CONTRACT_AUDIO_CURSOR.store(0, Ordering::Relaxed);
        *guard = Some(sender);
    }
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
    mono.as_chunks::<3>()
        .0
        .iter()
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
    /// Captions were presenting when this record landed (plan 068 D1). The
    /// SRT, which the Buddy report's moments read, keeps every record; the cue
    /// render and the burned copy use presented records only.
    #[serde(skip_serializing)]
    pub presented: bool,
}

fn upsert_caption_record(chunks: &mut Vec<CaptionChunkRecord>, record: CaptionChunkRecord) -> bool {
    let existing = chunks.iter_mut().find(|candidate| {
        candidate.capture_epoch == record.capture_epoch
            && match (&candidate.provider_item_id, &record.provider_item_id) {
                (Some(left), Some(right)) => left == right,
                (None, None) => candidate.seq == record.seq,
                _ => false,
            }
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

/// Per-leg caption plan for a session shape, a thin wrapper over the one
/// overlay leg plan (`overlay_layout::overlay_leg_plan`, plan 164 D12).
/// Captions map `burnTarget` onto the two switches with one caption-only
/// rule: the source recording is never a LIVE burn target. `Recording`
/// means a post-recording `(captioned)` copy, so the live plan runs with
/// `show_in_recording = false` and `captioned_copy` is fulfilled after
/// finalization from the clean source. A captioned stream in a combined
/// session therefore needs the auxiliary leg (`force_same_profile_split`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionOverlayLegPlan {
    pub primary: bool,
    pub aux: bool,
    pub force_same_profile_split: bool,
    pub captioned_copy: bool,
}

#[cfg(test)]
pub fn caption_overlay_leg_plan(
    record_enabled: bool,
    stream_enabled: bool,
    target: CaptionBurnTarget,
) -> CaptionOverlayLegPlan {
    caption_overlay_leg_plan_with_vertical_leg(record_enabled, stream_enabled, target, false)
}

/// `caption_overlay_leg_plan` for a session that may run the dual-orientation
/// vertical leg. That leg owns the auxiliary output, and horizontal viewers
/// share the primary leg with the recording, so a stream-burning target burns
/// BOTH legs: the horizontal bar on the primary, a portrait bar on the
/// vertical aux. The recording then carries the captions itself (it shares
/// the horizontal pixels), so no second captioned copy is rendered: it would
/// burn the bar twice. Owner decision 2026-09-29 (plan 077).
pub fn caption_overlay_leg_plan_with_vertical_leg(
    record_enabled: bool,
    stream_enabled: bool,
    target: CaptionBurnTarget,
    vertical_leg: bool,
) -> CaptionOverlayLegPlan {
    let aux_leg = if vertical_leg {
        OverlayAuxLeg::VerticalSimulcast
    } else {
        OverlayAuxLeg::None
    };
    let live = overlay_leg_plan(
        record_enabled,
        stream_enabled,
        aux_leg,
        target.burns_stream(),
        false,
    );
    CaptionOverlayLegPlan {
        primary: live.primary,
        aux: live.aux,
        force_same_profile_split: live.needs_split,
        captioned_copy: record_enabled && target.requests_captioned_copy() && !live.primary,
    }
}

/// What a session's auxiliary compositor leg carries, as far as the
/// comment-highlight card is concerned. The same enum serves every overlay.
#[cfg(test)]
pub use crate::overlay_layout::OverlayAuxLeg as HighlightAuxLeg;

/// Per-leg plan for the comment-highlight overlay with the pre-plan-164
/// switches (`showOnStream: true, showInRecording: false`): it burns on every
/// leg viewers watch, and when record+stream share one leg it lands on both
/// (the D13 shared-leg fallback). Sessions read the streamer's switches
/// through `overlay_layout::overlay_session_plans`; this wrapper keeps the
/// shipped default reachable for callers without a layout.
#[cfg(test)]
pub fn highlight_overlay_leg_plan(
    record_enabled: bool,
    stream_enabled: bool,
    aux_leg: HighlightAuxLeg,
) -> (bool, bool) {
    let plan = overlay_leg_plan(record_enabled, stream_enabled, aux_leg, true, false);
    let plan = if plan.needs_split {
        plan.shared_leg_fallback()
    } else {
        plan
    };
    (plan.primary, plan.aux)
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

fn caption_burn_staging_path(recording: &std::path::Path, owner_token: &str) -> std::path::PathBuf {
    let final_path = captioned_copy_path(recording);
    let final_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording-captioned.mp4");
    final_path.with_file_name(format!(".{final_name}.{owner_token}.partial"))
}

fn caption_burn_ffmpeg_args(
    recording_path: &std::path::Path,
    list_path: &std::path::Path,
    private_output_path: &std::path::Path,
) -> [OsString; 14] {
    [
        OsString::from("-y"),
        OsString::from("-i"),
        recording_path.as_os_str().to_owned(),
        OsString::from("-f"),
        OsString::from("concat"),
        OsString::from("-i"),
        list_path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from("[0:v][1:v]overlay=eof_action=pass"),
        OsString::from("-c:a"),
        OsString::from("copy"),
        // Private staging deliberately ends in `.partial`, so FFmpeg cannot
        // infer the output muxer from the filename.
        OsString::from("-f"),
        OsString::from("mp4"),
        private_output_path.as_os_str().to_owned(),
    ]
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

impl FinalizedCaptionArtifact {
    /// Records that landed while captions presented: the only ones the cue
    /// render and burned copy may use (plan 068 D1).
    pub fn presented_chunks(&self) -> Vec<CaptionChunkRecord> {
        self.chunks
            .iter()
            .filter(|chunk| chunk.presented)
            .cloned()
            .collect()
    }

    pub fn presented_chunk_count(&self) -> usize {
        self.chunks.iter().filter(|chunk| chunk.presented).count()
    }
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
    write_caption_artifacts_with_writer(
        state,
        session_id,
        recording_path,
        artifact,
        |path, contents| async move { tokio::fs::write(path, contents).await },
    )
    .await
}

async fn write_caption_artifacts_with_writer<Write, WriteFuture>(
    state: &AppState,
    session_id: &str,
    recording_path: &std::path::Path,
    artifact: FinalizedCaptionArtifact,
    write: Write,
) -> FinalizedCaptionArtifact
where
    Write: FnOnce(std::path::PathBuf, String) -> WriteFuture,
    WriteFuture: std::future::Future<Output = std::io::Result<()>>,
{
    if artifact.chunks.is_empty() {
        return artifact;
    }
    let srt = render_srt(&artifact.chunks);
    if srt.is_empty() {
        return artifact;
    }
    let srt_path = recording_path.with_extension("srt");
    match publish_caption_srt(state, &srt_path, artifact.artifact_generation, srt, write).await {
        Ok(true) => {
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Info,
                "captions-srt-written",
                &format!("Captions saved to {}.", srt_path.display()),
            );
        }
        Ok(false) => {}
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

async fn publish_caption_srt<Write, WriteFuture>(
    state: &AppState,
    srt_path: &std::path::Path,
    artifact_generation: u64,
    srt: String,
    write: Write,
) -> Result<bool>
where
    Write: FnOnce(std::path::PathBuf, String) -> WriteFuture,
    WriteFuture: std::future::Future<Output = std::io::Result<()>>,
{
    let publication = {
        let coordinator = state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress
            || coordinator.artifact_generation != artifact_generation
        {
            return Ok(false);
        }
        coordinator.artifact_publication.clone()
    };
    let _publication = publication.lock().await;
    let publication_is_stale = {
        let coordinator = state.captions.lock().await;
        coordinator.privacy_teardown_in_progress
            || coordinator.artifact_generation != artifact_generation
    };
    if publication_is_stale {
        return Ok(false);
    }

    let nonce = uuid::Uuid::new_v4().simple();
    let file_name = srt_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("captions.srt");
    let staging_path = srt_path.with_file_name(format!(".{file_name}.{nonce}.partial"));
    let previous_path = srt_path.with_file_name(format!(".{file_name}.{nonce}.previous"));
    if let Err(error) = write(staging_path.clone(), srt).await {
        retire_private_caption_file(state, &staging_path).await;
        return Err(error).context("Could not stage captions sidecar");
    }

    let publication_is_stale = {
        let coordinator = state.captions.lock().await;
        coordinator.privacy_teardown_in_progress
            || coordinator.artifact_generation != artifact_generation
    };
    if publication_is_stale {
        retire_private_caption_file(state, &staging_path).await;
        return Ok(false);
    }
    let staging_identity = match crate::storage::capture_session_file_object_identity(&staging_path)
        .and_then(|identity| {
            identity.context("Staged captions sidecar disappeared before publication")
        }) {
        Ok(identity) => identity,
        Err(error) => {
            retire_private_caption_file(state, &staging_path).await;
            return Err(error);
        }
    };
    let had_previous = match srt_path.try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            retire_private_caption_file(state, &staging_path).await;
            return Err(error).with_context(|| {
                format!("Could not inspect captions sidecar {}", srt_path.display())
            });
        }
    };
    if had_previous
        && let Err(error) =
            crate::session_ops::rename_session_file_no_replace(srt_path, &previous_path)
    {
        retire_private_caption_file(state, &staging_path).await;
        return Err(error).with_context(|| {
            format!("Could not preserve captions sidecar {}", srt_path.display())
        });
    }
    if let Err(error) = crate::atomic_file::replace_file(&staging_path, srt_path) {
        if had_previous
            && crate::session_ops::rename_session_file_no_replace(&previous_path, srt_path).is_err()
        {
            mark_caption_privacy_io_failed(state).await;
        }
        retire_private_caption_file(state, &staging_path).await;
        return Err(error).context("Could not publish captions sidecar");
    }

    let generation_is_current = {
        let coordinator = state.captions.lock().await;
        !coordinator.privacy_teardown_in_progress
            && coordinator.artifact_generation == artifact_generation
    };
    if !generation_is_current {
        let published_removed =
            retire_owned_private_caption_file(state, srt_path, &staging_identity).await;
        if had_previous
            && (!published_removed
                || crate::session_ops::rename_session_file_no_replace(&previous_path, srt_path)
                    .is_err())
        {
            mark_caption_privacy_io_failed(state).await;
        }
        return Ok(false);
    }

    if had_previous && !retire_private_caption_file(state, &previous_path).await {
        return Err(anyhow::anyhow!(
            "Could not retire the previous captions sidecar after publication"
        ));
    }
    Ok(true)
}

async fn retire_private_caption_file(state: &AppState, path: &std::path::Path) -> bool {
    match tokio::fs::remove_file(path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            tracing::warn!(path = %path.display(), "Could not retire private caption file: {error}");
            mark_caption_privacy_io_failed(state).await;
            false
        }
    }
}

async fn retire_owned_private_caption_file(
    state: &AppState,
    path: &std::path::Path,
    expected: &crate::storage::SessionFileObjectIdentity,
) -> bool {
    match crate::storage::capture_session_file_object_identity(path) {
        Ok(None) => true,
        Ok(Some(identity)) if &identity == expected => {
            retire_private_caption_file(state, path).await
        }
        Ok(Some(_)) | Err(_) => {
            mark_caption_privacy_io_failed(state).await;
            false
        }
    }
}

async fn mark_caption_privacy_io_failed(state: &AppState) {
    let mut coordinator = state.captions.lock().await;
    coordinator.privacy_teardown_in_progress = true;
    coordinator.privacy_teardown_failed = true;
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
/// them under a request-unique private directory, and hand off to the overlay
/// burn when complete. A watchdog degrades to SRT-only if frames don't
/// arrive (renderer closed, error) — the session is never affected.
pub async fn begin_caption_cue_render(
    state: &AppState,
    session_id: &str,
    ffmpeg_path: &str,
    recording_path: &std::path::Path,
    artifact: &FinalizedCaptionArtifact,
) {
    let request_id = match begin_caption_cue_render_with_preparer(
        state,
        session_id,
        ffmpeg_path,
        recording_path,
        artifact,
        |frames_dir, owner_token| async move {
            create_owned_caption_frame_dir(&frames_dir, &owner_token).await
        },
    )
    .await
    {
        Ok(Some(request_id)) => request_id,
        Ok(None) => return,
        Err(error) => {
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-burn-failed",
                &format!("Could not prepare caption frames: {error}"),
            );
            return;
        }
    };

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
            let session_id = match cleanup_expired_caption_render(
                &watchdog_state,
                &watchdog_request,
                tokio::time::Instant::now(),
                |frames_dir, owner_token| async move {
                    remove_owned_caption_frame_dir(&frames_dir, &owner_token).await
                },
            )
            .await
            {
                ExpiredCaptionRenderCleanup::Missing => return,
                ExpiredCaptionRenderCleanup::StillActive => continue,
                ExpiredCaptionRenderCleanup::Removed(pending) => pending.session_id,
                ExpiredCaptionRenderCleanup::CleanupFailed(session_id) => session_id,
            };
            let _ = crate::recording::emit_health_event(
                &watchdog_state,
                Some(&session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-burn-failed",
                "Caption frame rendering stopped making progress; the .srt sidecar is still available.",
            );
            return;
        }
    });
}

async fn begin_caption_cue_render_with_preparer<Prepare, PrepareFuture>(
    state: &AppState,
    session_id: &str,
    ffmpeg_path: &str,
    recording_path: &std::path::Path,
    artifact: &FinalizedCaptionArtifact,
    prepare: Prepare,
) -> Result<Option<String>>
where
    Prepare: FnOnce(std::path::PathBuf, String) -> PrepareFuture,
    PrepareFuture: std::future::Future<Output = std::io::Result<()>>,
{
    // Listen-only records never reach the compositor's cue frames.
    let cues = caption_cues(&artifact.presented_chunks());
    if cues.is_empty() {
        return Ok(None);
    }
    let request_id = format!("cues-{}", uuid::Uuid::new_v4().simple());
    let frames_dir = caption_frame_request_dir(recording_path, &request_id);
    let cleanup_ledger_id = format!("caption-frames-{request_id}");
    let owner_token = request_id.clone();
    let frame_io = state.captions.lock().await.private_frame_io.clone();
    let _frame_io = frame_io.lock().await;
    {
        let coordinator = state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress
            || coordinator.artifact_generation != artifact.artifact_generation
        {
            return Ok(None);
        }
    }
    state.database.register_caption_private_artifact(
        &crate::storage::CaptionPrivateArtifactRecord {
            id: cleanup_ledger_id.clone(),
            kind: CAPTION_PRIVATE_DIRECTORY_KIND.to_string(),
            path: frames_dir.display().to_string(),
            owner_token: owner_token.clone(),
            published_path: None,
            object_identity: None,
        },
    )?;
    if let Err(error) = prepare(frames_dir.clone(), owner_token.clone()).await {
        if remove_owned_caption_frame_dir(&frames_dir, &owner_token)
            .await
            .is_ok()
        {
            let _ = state
                .database
                .remove_caption_private_artifact(&cleanup_ledger_id);
        }
        return Err(error).context("Could not create the owned caption frame directory");
    }

    let mut coordinator = state.captions.lock().await;
    if coordinator.privacy_teardown_in_progress
        || coordinator.artifact_generation != artifact.artifact_generation
    {
        drop(coordinator);
        if remove_owned_caption_frame_dir(&frames_dir, &owner_token)
            .await
            .is_ok()
        {
            state
                .database
                .remove_caption_private_artifact(&cleanup_ledger_id)?;
        }
        return Ok(None);
    }
    let mut expected: std::collections::BTreeSet<u64> = cues.iter().map(|cue| cue.seq).collect();
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
            frame_writes_in_flight: std::collections::BTreeSet::new(),
            artifact_generation: artifact.artifact_generation,
            last_progress_at: tokio::time::Instant::now(),
            watchdog_active: false,
            cleanup_in_progress: false,
            cleanup_path: None,
            owner_token,
            cleanup_ledger_id,
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
    Ok(Some(request_id))
}

fn caption_frame_request_dir(
    recording_path: &std::path::Path,
    request_id: &str,
) -> std::path::PathBuf {
    let recording_name = recording_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("recording");
    recording_path.with_file_name(format!(".{recording_name}.{request_id}.caption-frames"))
}

async fn create_owned_caption_frame_dir(
    frames_dir: &std::path::Path,
    owner_token: &str,
) -> std::io::Result<()> {
    tokio::fs::create_dir(frames_dir).await?;
    let marker_path = frames_dir.join(CAPTION_PRIVATE_OWNER_MARKER);
    let marker_result = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker_path)
        .await;
    match marker_result {
        Ok(mut marker) => {
            use tokio::io::AsyncWriteExt as _;
            marker.write_all(owner_token.as_bytes()).await?;
            marker.sync_all().await
        }
        Err(error) => {
            let _ = tokio::fs::remove_dir(frames_dir).await;
            Err(error)
        }
    }
}

async fn remove_owned_caption_frame_dir(
    frames_dir: &std::path::Path,
    owner_token: &str,
) -> std::io::Result<()> {
    let metadata = match tokio::fs::symlink_metadata(frames_dir).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "caption frame ownership path is not an owned directory",
        ));
    }
    let marker = tokio::fs::read(frames_dir.join(CAPTION_PRIVATE_OWNER_MARKER)).await?;
    if marker != owner_token.as_bytes() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "caption frame ownership marker does not match",
        ));
    }
    tokio::fs::remove_dir_all(frames_dir).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CueRenderWatchdogState {
    Missing,
    Queued,
    ActiveUntil(tokio::time::Instant),
}

enum ExpiredCaptionRenderCleanup {
    Missing,
    StillActive,
    Removed(Box<PendingCueRender>),
    CleanupFailed(String),
}

async fn cleanup_expired_caption_render<Cleanup, CleanupFuture>(
    state: &AppState,
    request_id: &str,
    now: tokio::time::Instant,
    cleanup: Cleanup,
) -> ExpiredCaptionRenderCleanup
where
    Cleanup: FnOnce(std::path::PathBuf, String) -> CleanupFuture,
    CleanupFuture: std::future::Future<Output = std::io::Result<()>>,
{
    let frame_io = state.captions.lock().await.private_frame_io.clone();
    let _frame_io = frame_io.lock().await;
    let (frames_dir, cleanup_path, artifact_generation, session_id, owner_token, cleanup_ledger_id) = {
        let mut coordinator = state.captions.lock().await;
        if coordinator
            .pending_cue_render_order
            .front()
            .map(String::as_str)
            != Some(request_id)
        {
            return if coordinator.pending_cue_renders.contains_key(request_id) {
                ExpiredCaptionRenderCleanup::StillActive
            } else {
                ExpiredCaptionRenderCleanup::Missing
            };
        }
        let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id) else {
            return ExpiredCaptionRenderCleanup::Missing;
        };
        if pending.cleanup_in_progress {
            return ExpiredCaptionRenderCleanup::Missing;
        }
        if !cue_render_is_inactive(pending.last_progress_at, now) {
            return ExpiredCaptionRenderCleanup::StillActive;
        }
        let frames_name = pending
            .frames_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("caption-frames");
        let cleanup_path = pending.frames_dir.with_file_name(format!(
            ".{frames_name}.{}.retiring",
            uuid::Uuid::new_v4().simple()
        ));
        pending.cleanup_in_progress = true;
        pending.cleanup_path = Some(cleanup_path.clone());
        let plan = (
            pending.frames_dir.clone(),
            cleanup_path,
            pending.artifact_generation,
            pending.session_id.clone(),
            pending.owner_token.clone(),
            pending.cleanup_ledger_id.clone(),
        );
        coordinator
            .pending_cue_render_order
            .retain(|queued| queued != request_id);
        plan
    };

    // Move the exact directory we reserved to a unique quarantine before the
    // potentially slow recursive delete. A replacement created at the public
    // path can no longer be deleted by this old watchdog generation.
    let cleanup_result =
        match crate::session_ops::rename_session_file_no_replace(&frames_dir, &cleanup_path) {
            Ok(()) => cleanup(cleanup_path.clone(), owner_token.clone()).await,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match cleanup(cleanup_path.clone(), owner_token.clone()).await {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    result => result,
                }
            }
            Err(error) => Err(error),
        };
    let cleanup_result = cleanup_result.and_then(|()| {
        state
            .database
            .remove_caption_private_artifact(&cleanup_ledger_id)
            .map(|_| ())
            .map_err(std::io::Error::other)
    });
    let mut coordinator = state.captions.lock().await;
    if let Err(error) = cleanup_result {
        tracing::warn!(
            request_id,
            "Could not remove expired private caption frame cache: {error}"
        );
        return ExpiredCaptionRenderCleanup::CleanupFailed(session_id);
    }
    let Some(current) = coordinator.pending_cue_renders.get(request_id) else {
        return ExpiredCaptionRenderCleanup::Missing;
    };
    if current.artifact_generation != artifact_generation
        || !current.cleanup_in_progress
        || current.cleanup_path.as_ref() != Some(&cleanup_path)
    {
        return ExpiredCaptionRenderCleanup::Missing;
    }
    ExpiredCaptionRenderCleanup::Removed(Box::new(
        coordinator
            .pending_cue_renders
            .remove(request_id)
            .expect("expired caption render remains reserved for cleanup"),
    ))
}

fn pending_cue_render_watchdog_state(
    coordinator: &mut CaptionsCoordinator,
    request_id: &str,
    now: tokio::time::Instant,
) -> CueRenderWatchdogState {
    let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id) else {
        return CueRenderWatchdogState::Missing;
    };
    if pending.cleanup_in_progress {
        return CueRenderWatchdogState::Missing;
    }
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
    submit_caption_cue_frame_with_writer(state, request_id, seq, bytes, |path, bytes| async move {
        tokio::fs::write(path, bytes).await
    })
    .await
}

async fn submit_caption_cue_frame_with_writer<Write, WriteFuture>(
    state: &AppState,
    request_id: &str,
    seq: u64,
    bytes: Vec<u8>,
    write: Write,
) -> Result<bool>
where
    Write: FnOnce(std::path::PathBuf, Vec<u8>) -> WriteFuture,
    WriteFuture: std::future::Future<Output = std::io::Result<()>>,
{
    let frame_io = state.captions.lock().await.private_frame_io.clone();
    let _frame_io = frame_io.lock().await;
    let (path, staging_path, artifact_generation) = {
        let mut coordinator = state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress {
            bail!("Caption frame request is stale.");
        }
        let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id) else {
            bail!("Caption frame request is stale.");
        };
        if pending.cleanup_in_progress {
            bail!("Caption frame request is expiring.");
        }
        if !pending.expected.contains(&seq) {
            bail!("Caption frame seq {seq} was not requested.");
        }
        if pending.received.contains(&seq) {
            return Ok(false);
        }
        if !pending.frame_writes_in_flight.insert(seq) {
            bail!("Caption frame seq {seq} is already being stored.");
        }
        let path = pending.frames_dir.join(format!("{seq}.png"));
        let staging_path = pending
            .frames_dir
            .join(format!(".{seq}.{}.partial", uuid::Uuid::new_v4().simple()));
        (path, staging_path, pending.artifact_generation)
    };

    // File creation can block on a sick disk. The reservation above keeps the
    // logical request stable without retaining the coordinator lock.
    if let Err(error) = write(staging_path.clone(), bytes).await {
        release_caption_frame_reservation(state, request_id, seq, artifact_generation).await;
        retire_private_caption_file(state, &staging_path).await;
        return Err(error).context("Could not stage caption frame");
    }
    let staging_identity = match crate::storage::capture_session_file_object_identity(&staging_path)
        .and_then(|identity| {
            identity.context("Staged caption frame disappeared before publication")
        }) {
        Ok(identity) => identity,
        Err(error) => {
            release_caption_frame_reservation(state, request_id, seq, artifact_generation).await;
            retire_private_caption_file(state, &staging_path).await;
            return Err(error);
        }
    };

    let request_is_current = {
        let mut coordinator = state.captions.lock().await;
        let privacy_teardown_in_progress = coordinator.privacy_teardown_in_progress;
        match coordinator.pending_cue_renders.get_mut(request_id) {
            Some(pending)
                if !privacy_teardown_in_progress
                    && pending.artifact_generation == artifact_generation
                    && !pending.cleanup_in_progress =>
            {
                true
            }
            Some(pending) => {
                pending.frame_writes_in_flight.remove(&seq);
                false
            }
            None => false,
        }
    };
    if !request_is_current {
        retire_private_caption_file(state, &staging_path).await;
        bail!("Caption frame request became stale while its frame was stored.");
    }
    if let Err(error) = crate::session_ops::rename_session_file_no_replace(&staging_path, &path) {
        release_caption_frame_reservation(state, request_id, seq, artifact_generation).await;
        retire_private_caption_file(state, &staging_path).await;
        return Err(error).context("Could not publish caption frame");
    }

    let installed = {
        let mut coordinator = state.captions.lock().await;
        let privacy_teardown_in_progress = coordinator.privacy_teardown_in_progress;
        let watchdog_active = coordinator
            .pending_cue_render_order
            .front()
            .map(String::as_str)
            == Some(request_id);
        match coordinator.pending_cue_renders.get_mut(request_id) {
            Some(pending)
                if !privacy_teardown_in_progress
                    && pending.artifact_generation == artifact_generation
                    && !pending.cleanup_in_progress =>
            {
                pending.frame_writes_in_flight.remove(&seq);
                if pending.received.insert(seq) {
                    pending.last_progress_at = tokio::time::Instant::now();
                    pending.watchdog_active = watchdog_active;
                }
                let completed = pending.received == pending.expected;
                if completed {
                    let pending = remove_pending_cue_render(&mut coordinator, request_id)
                        .expect("completed caption render remains installed");
                    let finished = take_finished_caption_burn_tasks(&mut coordinator);
                    register_caption_overlay_burn(state.clone(), pending, &mut coordinator);
                    Some((true, finished))
                } else {
                    Some((false, Vec::new()))
                }
            }
            Some(pending) => {
                pending.frame_writes_in_flight.remove(&seq);
                None
            }
            None => None,
        }
    };

    let Some((completed, finished_burn_tasks)) = installed else {
        retire_owned_private_caption_file(state, &path, &staging_identity).await;
        bail!("Caption frame request became stale while its frame was published.");
    };

    for task in finished_burn_tasks {
        let _ = task.join.await;
    }
    Ok(completed)
}

async fn release_caption_frame_reservation(
    state: &AppState,
    request_id: &str,
    seq: u64,
    artifact_generation: u64,
) {
    let mut coordinator = state.captions.lock().await;
    if let Some(pending) = coordinator.pending_cue_renders.get_mut(request_id)
        && pending.artifact_generation == artifact_generation
    {
        pending.frame_writes_in_flight.remove(&seq);
    }
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
    let owner_token = format!("caption-burn-{}", uuid::Uuid::new_v4().simple());
    let cleanup_ledger_id = owner_token.clone();
    let output_path = caption_burn_staging_path(&pending.recording_path, &owner_token);
    let frames_dir = pending.frames_dir.clone();
    let (cancel, cancel_receiver) = watch::channel(false);
    let task_state = state.clone();
    let task_output_path = output_path.clone();
    let task_cleanup_ledger_id = cleanup_ledger_id.clone();
    let join = tokio::spawn(async move {
        run_caption_overlay_burn(
            task_state,
            pending,
            cancel_receiver,
            task_output_path,
            task_cleanup_ledger_id,
        )
        .await;
    });
    coordinator.caption_burn_tasks.push(CaptionBurnTask {
        cancel,
        join,
        output_path,
        frames_dir,
        cleanup_ledger_id,
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
    let mut frames_dirs = std::collections::BTreeSet::new();
    for pending in std::mem::take(&mut coordinator.pending_cue_renders).into_values() {
        frames_dirs.insert(pending.frames_dir);
        if let Some(cleanup_path) = pending.cleanup_path {
            frames_dirs.insert(cleanup_path);
        }
    }
    frames_dirs.into_iter().collect()
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
    private_output_path: std::path::PathBuf,
    cleanup_ledger_id: String,
) {
    let output_path = captioned_copy_path(&pending.recording_path);
    if let Err(error) = state.database.register_caption_private_artifact(
        &crate::storage::CaptionPrivateArtifactRecord {
            id: cleanup_ledger_id.clone(),
            kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
            path: private_output_path.display().to_string(),
            owner_token: cleanup_ledger_id.clone(),
            published_path: None,
            object_identity: None,
        },
    ) {
        tracing::error!(
            "Could not register private caption burn ownership before encoding: {error:#}"
        );
        mark_caption_privacy_io_failed(&state).await;
        return;
    }
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
                .args(caption_burn_ffmpeg_args(
                    &pending.recording_path,
                    &list_path,
                    &private_output_path,
                ))
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
                        let _ = tokio::fs::remove_file(&private_output_path).await;
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

    if remove_owned_caption_frame_dir(&pending.frames_dir, &pending.owner_token)
        .await
        .is_ok()
    {
        let _ = state
            .database
            .remove_caption_private_artifact(&pending.cleanup_ledger_id);
    } else {
        mark_caption_privacy_io_failed(&state).await;
    }
    match outcome {
        Ok(()) => {
            if let Err(error) = publish_caption_burn_output(
                &state,
                &pending,
                &sign_out_cancel,
                &private_output_path,
                &output_path,
                &cleanup_ledger_id,
            )
            .await
            {
                let _ = crate::recording::emit_health_event(
                    &state,
                    Some(&pending.session_id),
                    crate::protocol::HealthLevel::Warn,
                    "captions-burn-failed",
                    &format!(
                        "Captioned copy could not be published ({error:#}); the .srt sidecar is still available."
                    ),
                );
            }
        }
        Err(reason) => {
            if retire_private_caption_file(&state, &private_output_path).await {
                let _ = state
                    .database
                    .remove_caption_private_artifact(&cleanup_ledger_id);
            }
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

async fn publish_caption_burn_output(
    state: &AppState,
    pending: &PendingCueRender,
    sign_out_cancel: &watch::Receiver<bool>,
    private_output_path: &std::path::Path,
    output_path: &std::path::Path,
    cleanup_ledger_id: &str,
) -> Result<bool> {
    let publication = state.captions.lock().await.artifact_publication.clone();
    let _publication = publication.lock().await;
    let generation_is_current = {
        let coordinator = state.captions.lock().await;
        caption_burn_can_publish_ready(
            caption_burn_cancelled(sign_out_cancel),
            pending.artifact_generation,
            coordinator.artifact_generation,
        ) && !coordinator.privacy_teardown_in_progress
    };
    if !generation_is_current {
        if retire_private_caption_file(state, private_output_path).await {
            state
                .database
                .remove_caption_private_artifact(cleanup_ledger_id)?;
        }
        return Ok(false);
    }

    let identity = crate::storage::capture_session_file_object_identity(private_output_path)?
        .context("Caption burn staging output disappeared before publication")?;
    state.database.update_caption_private_artifact_publication(
        cleanup_ledger_id,
        output_path,
        &identity,
    )?;
    crate::atomic_file::replace_file(private_output_path, output_path)
        .context("Could not publish the captioned copy")?;

    let still_current = {
        let coordinator = state.captions.lock().await;
        caption_burn_can_publish_ready(
            caption_burn_cancelled(sign_out_cancel),
            pending.artifact_generation,
            coordinator.artifact_generation,
        ) && !coordinator.privacy_teardown_in_progress
    };
    if !still_current {
        if retire_owned_private_caption_file(state, output_path, &identity).await {
            state
                .database
                .remove_caption_private_artifact(cleanup_ledger_id)?;
        }
        return Ok(false);
    }

    // The publication lane and second generation check are the adoption
    // receipt. Only after them may durable truth claim this path is ready.
    let _ = crate::recording::emit_health_event(
        state,
        Some(&pending.session_id),
        crate::protocol::HealthLevel::Info,
        "captions-burned-copy-ready",
        &format!("Captioned copy saved to {}.", output_path.display()),
    );
    state
        .database
        .remove_caption_private_artifact(cleanup_ledger_id)?;
    Ok(true)
}

struct CaptionBurnCleanupResult {
    complete: bool,
    unfinished: Vec<CaptionBurnTask>,
}

async fn cancel_and_join_caption_burn_tasks(
    state: &AppState,
    tasks: Vec<CaptionBurnTask>,
) -> CaptionBurnCleanupResult {
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

    // Every task receives cancellation before any join. Shared deadlines keep
    // teardown bounded as one contract even when several prior captures have
    // finished cue rendering at once.
    let cancel_deadline = tokio::time::Instant::now() + CAPTION_CANCEL_JOIN_TIMEOUT;
    let abort_deadline = cancel_deadline + CAPTION_ABORT_JOIN_TIMEOUT;
    let mut cleanup_complete = true;
    let mut unfinished = Vec::new();
    for (task, cancelled) in tasks {
        let CaptionBurnTask {
            cancel,
            mut join,
            output_path,
            frames_dir,
            cleanup_ledger_id,
        } = task;
        let (task_stopped, joined_cleanly) = match tokio::time::timeout_at(
            cancel_deadline,
            &mut join,
        )
        .await
        {
            Ok(Ok(())) => (true, true),
            Ok(Err(error)) => {
                tracing::error!("Caption burn task stopped with a join error: {error}");
                (true, false)
            }
            Err(_) => {
                join.abort();
                match tokio::time::timeout_at(abort_deadline, &mut join).await {
                    Ok(Ok(())) => (true, false),
                    Ok(Err(error)) if error.is_cancelled() => (true, false),
                    Ok(Err(error)) => {
                        tracing::error!(
                            "Caption burn task stopped with a join error after abort: {error}"
                        );
                        (true, false)
                    }
                    Err(_) => {
                        tracing::error!(
                            "Caption burn task did not stop after cancellation and abort deadlines."
                        );
                        (false, false)
                    }
                }
            }
        };
        if !task_stopped {
            cleanup_complete = false;
            unfinished.push(CaptionBurnTask {
                cancel,
                join,
                output_path,
                frames_dir,
                cleanup_ledger_id,
            });
            continue;
        }
        if let Err(error) = tokio::fs::remove_dir_all(&frames_dir).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::error!(
                "Could not remove private caption frame cache {}: {error}",
                frames_dir.display()
            );
            cleanup_complete = false;
        }
        if cancelled || !joined_cleanly {
            match tokio::fs::remove_file(&output_path).await {
                Ok(()) => {
                    let _ = state
                        .database
                        .remove_caption_private_artifact(&cleanup_ledger_id);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let _ = state
                        .database
                        .remove_caption_private_artifact(&cleanup_ledger_id);
                }
                Err(error) => {
                    tracing::error!(
                        "Could not remove partial private caption output {}: {error}",
                        output_path.display()
                    );
                    cleanup_complete = false;
                }
            }
        }
    }
    CaptionBurnCleanupResult {
        complete: cleanup_complete && unfinished.is_empty(),
        unfinished,
    }
}

async fn remove_pending_caption_frame_dirs(frames_dirs: Vec<std::path::PathBuf>) -> bool {
    let mut cleanup_complete = true;
    for frames_dir in frames_dirs {
        if let Err(error) = tokio::fs::remove_dir_all(&frames_dir).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                "Could not remove caption frame cache {}: {error}",
                frames_dir.display()
            );
            cleanup_complete = false;
        }
    }
    cleanup_complete
}

async fn cleanup_registered_caption_private_artifacts(state: &AppState) -> bool {
    let records = match state.database.caption_private_artifacts() {
        Ok(records) => records,
        Err(error) => {
            tracing::error!("Could not read durable private-caption cleanup ownership: {error:#}");
            return false;
        }
    };
    let mut complete = true;
    for record in records {
        let cleaned = match record.kind.as_str() {
            CAPTION_PRIVATE_DIRECTORY_KIND => cleanup_registered_caption_directory(&record).await,
            CAPTION_PRIVATE_PARTIAL_FILE_KIND => cleanup_registered_caption_file(&record).await,
            other => {
                tracing::error!(
                    id = %record.id,
                    kind = other,
                    "Unknown durable private-caption artifact kind; cleanup remains fail-closed."
                );
                false
            }
        };
        if cleaned {
            if let Err(error) = state.database.remove_caption_private_artifact(&record.id) {
                tracing::error!(
                    id = %record.id,
                    "Could not retire durable private-caption ownership after cleanup: {error:#}"
                );
                complete = false;
            }
        } else {
            complete = false;
        }
    }
    complete
        && state
            .database
            .caption_private_artifacts()
            .is_ok_and(|records| records.is_empty())
}

async fn cleanup_registered_caption_directory(
    record: &crate::storage::CaptionPrivateArtifactRecord,
) -> bool {
    let mut candidates = Vec::new();
    if let Some(path) = record.published_path.as_ref() {
        candidates.push(std::path::PathBuf::from(path));
    }
    candidates.push(std::path::PathBuf::from(&record.path));
    candidates.sort();
    candidates.dedup();
    for candidate in candidates {
        if let Err(error) = remove_owned_caption_frame_dir(&candidate, &record.owner_token).await {
            tracing::error!(
                id = %record.id,
                path = %candidate.display(),
                "Could not remove owned private caption directory: {error}"
            );
            return false;
        }
    }
    true
}

async fn cleanup_registered_caption_file(
    record: &crate::storage::CaptionPrivateArtifactRecord,
) -> bool {
    let mut candidates = Vec::new();
    if let Some(path) = record.published_path.as_ref() {
        candidates.push(std::path::PathBuf::from(path));
    }
    candidates.push(std::path::PathBuf::from(&record.path));
    candidates.sort();
    candidates.dedup();
    for candidate in candidates {
        let metadata = match tokio::fs::symlink_metadata(&candidate).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::error!(path = %candidate.display(), "Could not inspect private caption file: {error}");
                return false;
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            tracing::error!(
                path = %candidate.display(),
                "Private caption cleanup refused a non-regular or symlink path."
            );
            return false;
        }
        let actual_identity = match crate::storage::capture_session_file_object_identity(&candidate)
        {
            Ok(Some(identity)) => identity,
            Ok(None) => continue,
            Err(error) => {
                tracing::error!(path = %candidate.display(), "Could not bind private caption file identity: {error:#}");
                return false;
            }
        };
        let exact_identity = record.object_identity.as_ref() == Some(&actual_identity);
        let private_staging_name = candidate == std::path::Path::new(&record.path)
            && candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(&record.owner_token));
        if !exact_identity && !private_staging_name {
            tracing::error!(
                path = %candidate.display(),
                "Private caption cleanup refused a file whose ownership identity changed."
            );
            return false;
        }
        if let Err(error) = tokio::fs::remove_file(&candidate).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::error!(path = %candidate.display(), "Could not remove private caption file: {error}");
            return false;
        }
    }
    true
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

/// Where a composited overlay bitmap lands when its push carried no rect
/// (older callers and smokes): one of the snap presets, resolved against the
/// canvas orientation at blit time so a legacy push still clears the portrait
/// safe area on a vertical leg. Not a wire type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlayFallbackPlacement {
    pub item: OverlayItem,
    pub snap: OverlaySnap,
}

impl From<CaptionOverlayPosition> for OverlayFallbackPlacement {
    fn from(position: CaptionOverlayPosition) -> Self {
        Self {
            item: OverlayItem::Captions,
            snap: match position {
                CaptionOverlayPosition::Top => OverlaySnap::TopCenter,
                CaptionOverlayPosition::Bottom => OverlaySnap::BottomCenter,
            },
        }
    }
}

/// How an installed overlay is placed: the streamer's rect from the overlay
/// layout, or the legacy snap when the push carried none.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverlayPlacement {
    pub rect: Option<OverlayRect>,
    pub fallback: OverlayFallbackPlacement,
}

impl OverlayPlacement {
    pub fn new(rect: Option<OverlayRect>, fallback: impl Into<OverlayFallbackPlacement>) -> Self {
        Self {
            rect,
            fallback: fallback.into(),
        }
    }

    /// The rect this overlay blits into on a canvas of this size.
    pub fn rect_for_canvas(&self, canvas_width: u32, canvas_height: u32) -> OverlayRect {
        self.rect.unwrap_or_else(|| {
            overlay_snap_rect(
                self.fallback.item,
                OverlayOrientation::for_canvas(canvas_width, canvas_height),
                self.fallback.snap,
            )
        })
    }
}

impl From<CaptionOverlayPosition> for OverlayPlacement {
    fn from(position: CaptionOverlayPosition) -> Self {
        Self::new(None, position)
    }
}

#[derive(Debug, Clone)]
pub struct CaptionOverlay {
    pub rgba: Arc<Vec<u8>>,
    pub bgra: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub placement: OverlayPlacement,
    pub revision: u64,
}

impl CaptionOverlay {
    /// The vertical edge this overlay occupies on a landscape canvas.
    #[cfg(test)]
    pub fn position(&self) -> CaptionOverlayPosition {
        if self.placement.rect_for_canvas(1920, 1080).bottom_gravity() {
            CaptionOverlayPosition::Bottom
        } else {
            CaptionOverlayPosition::Top
        }
    }

    /// The rect this overlay blits into on a canvas of this size.
    pub fn blit_rect(&self, canvas_width: u32, canvas_height: u32) -> OverlayRect {
        self.placement.rect_for_canvas(canvas_width, canvas_height)
    }
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
    /// The captions rect for this target's orientation (plan 164). Missing =>
    /// the legacy top/bottom bar snap for `position`.
    #[serde(default)]
    pub rect: Option<OverlayRect>,
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

#[cfg(test)]
pub(crate) fn install_caption_overlay(
    slot: &CaptionOverlaySlot,
    png_base64: &str,
    position: CaptionOverlayPosition,
) -> Result<CaptionOverlayInfo> {
    let prepared = prepare_caption_overlay(png_base64)?;
    Ok(install_prepared_caption_overlay(slot, prepared, position))
}

/// Decode and validate an overlay without holding the destination slot.
/// Callers which also own higher-level lifecycle locks can do this expensive
/// work first, revalidate their lifecycle authority, and keep the eventual
/// slot mutation to one bounded Arc swap.
pub(crate) fn prepare_caption_overlay(png_base64: &str) -> Result<PreparedCaptionOverlay> {
    decode_caption_overlay(png_base64)
}

/// Revisions for single-slot overlays are process-wide and never reused. The
/// Metal compositor caches an overlay texture per source index keyed on
/// (namespace, revision, size); a per-slot counter restarted at 1 after every
/// clear, so a new card the same size as an expired one could replay the old
/// card's pixels.
static SINGLE_SLOT_OVERLAY_REVISION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

pub(crate) fn install_prepared_caption_overlay(
    slot: &CaptionOverlaySlot,
    prepared: PreparedCaptionOverlay,
    placement: impl Into<OverlayPlacement>,
) -> CaptionOverlayInfo {
    let placement = placement.into();
    let mut guard = slot.lock().expect("caption overlay lock");
    let revision = SINGLE_SLOT_OVERLAY_REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    *guard = Some(CaptionOverlay {
        rgba: prepared.rgba,
        bgra: prepared.bgra,
        width: prepared.width,
        height: prepared.height,
        placement,
        revision,
    });
    CaptionOverlayInfo {
        active: true,
        width: prepared.width,
        height: prepared.height,
        revision,
    }
}

pub(crate) struct PreparedCaptionOverlay {
    rgba: Arc<Vec<u8>>,
    bgra: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

fn decode_caption_overlay(png_base64: &str) -> Result<PreparedCaptionOverlay> {
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
        rgba.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect(),
    );
    Ok(PreparedCaptionOverlay {
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
            OverlayPlacement::new(params.rect, params.position),
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
            OverlayPlacement::new(params.rect, params.position),
            params.style_revision,
        );
    }
    Ok(caption_overlay_targets_info(&guard))
}

/// Decode one PNG and install it in one target (or both) with a placement and
/// no style revision: the Buddy overlay slot (plan 164 Phase C) shares the
/// per-target slot type with captions but never carries a caption style.
#[cfg(test)]
pub(crate) fn install_overlay_targets(
    slots: &CaptionOverlaySlots,
    png_base64: &str,
    target: Option<CaptionOverlayTarget>,
    placement: OverlayPlacement,
) -> Result<CaptionOverlayTargetsInfo> {
    let decoded = decode_caption_overlay(png_base64)?;
    Ok(install_prepared_overlay_targets(
        slots, decoded, target, placement,
    ))
}

/// [`install_overlay_targets`] for a raster already decoded (off the async
/// runtime, plan 168 S-B1): one bounded swap under the slots lock.
pub(crate) fn install_prepared_overlay_targets(
    slots: &CaptionOverlaySlots,
    decoded: PreparedCaptionOverlay,
    target: Option<CaptionOverlayTarget>,
    placement: OverlayPlacement,
) -> CaptionOverlayTargetsInfo {
    let mut guard = slots.inner.lock().expect("caption overlay slots lock");
    if target.is_none_or(|target| target == CaptionOverlayTarget::Primary) {
        install_decoded_caption_overlay(&mut guard.primary, &decoded, placement, None);
    }
    if target.is_none_or(|target| target == CaptionOverlayTarget::Auxiliary) {
        install_decoded_caption_overlay(&mut guard.auxiliary, &decoded, placement, None);
    }
    caption_overlay_targets_info(&guard)
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
    decoded: &PreparedCaptionOverlay,
    placement: OverlayPlacement,
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
        placement,
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
    /// Same immutable owner as CaptionSession, kept only to associate a
    /// taken task's provider join evidence with its recording matcher.
    task_mark_target: Option<crate::clip_marks::MarkTarget>,
    stop: Option<Arc<AtomicBool>>,
    status: Option<CaptionsStatus>,
    /// The captions intent (plan 068 D1): the user wants live captions
    /// presented. Owns `captions.status`, `captions.update`, overlays, cue
    /// render and burn.
    desired_enabled: bool,
    /// Buddy's listen intent (plan 068 D1): the provider task and tap run
    /// while either intent is wanted. Listen owns nothing visible in the
    /// captions UI.
    listen_wanted: bool,
    /// Presentation flag shared with the running task: every renderer-facing
    /// caption side effect checks it. `None` without a task.
    presentation: Option<Arc<AtomicBool>>,
    /// The status the task would have presented. Adopted when captions turn
    /// on over a running listen-only task so the renderer sees the true
    /// transport state at once.
    shadow_status: Option<CaptionsStatus>,
    /// The running task proved it can listen: a successful upload, or a
    /// silent chunk skipped after the tap delivered frames. A listen intent
    /// joining the task reports `on` at once. Reset with every task.
    listen_ready: bool,
    /// Bumped whenever the listen intent ends (a stop, sign-out): a listening
    /// state a task decided to publish before that never lands after it.
    listen_epoch: u64,
    /// Current listen grant in the same monotonic clock as AudioFrame. Raw
    /// frames can remain in the shared caption receiver across revoke/grant;
    /// they must not acquire the new epoch merely because they drain later.
    listen_started_at: Option<std::time::Instant>,
    /// Buddy speech admission is independent of its Listen setting: explicit
    /// captions also feed consenting voice/spotlight features.
    speech_admitted: bool,
    speech_epoch: u64,
    speech_started_at: Option<std::time::Instant>,
    marker_session_id: Option<String>,
    marker_epoch: u64,
    marker_started_at: Option<std::time::Instant>,
    marker_listening: Option<crate::cohost::CohostListening>,
    language: Option<String>,
    /// Orders delayed capture auto-start against explicit stop/start, capture
    /// stop, sign-out, and shutdown. A queued task may commit only the exact
    /// generation reserved by its session.start request.
    start_intent_generation: u64,
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
    /// Orders SRT staging/publication against this coordinator's sign-out
    /// generation fence. Long writes hold only this purpose-built lane;
    /// sign-out waits on it after releasing CAPTION_CONTROL.
    artifact_publication: Arc<Mutex<()>>,
    /// Orders cue-frame writes and expiry cleanup against this coordinator's
    /// sign-out. Disk I/O holds neither CAPTION_CONTROL nor the coordinator.
    private_frame_io: Arc<Mutex<()>>,
    /// Set at the sign-out privacy boundary before CAPTION_CONTROL is
    /// released. Starts remain fail-closed until every owned task and private
    /// artifact is gone and the account credentials have been cleared.
    privacy_teardown_in_progress: bool,
    /// A task or private filesystem artifact outlived its hard cleanup
    /// deadline. The process may no longer prove a safe sign-out without a
    /// restart, so subsequent starts and sign-out claims remain fail-closed.
    privacy_teardown_failed: bool,
    /// The current serialized sign-out has joined its detached provider.
    /// Exact capture ends during later artifact cleanup need not wait on I/O.
    privacy_provider_joined: bool,
}

pub struct PendingCueRender {
    pub session_id: String,
    pub ffmpeg_path: String,
    pub recording_path: std::path::PathBuf,
    pub frames_dir: std::path::PathBuf,
    pub cues: Vec<CaptionCue>,
    pub expected: std::collections::BTreeSet<u64>,
    pub received: std::collections::BTreeSet<u64>,
    frame_writes_in_flight: std::collections::BTreeSet<u64>,
    artifact_generation: u64,
    last_progress_at: tokio::time::Instant,
    watchdog_active: bool,
    cleanup_in_progress: bool,
    /// Unique same-directory quarantine used by expiry cleanup. Retaining it
    /// in coordinator state lets a racing sign-out clean either pre-rename or
    /// post-rename ownership without deleting a replacement directory.
    cleanup_path: Option<std::path::PathBuf>,
    owner_token: String,
    cleanup_ledger_id: String,
}

struct CaptionBurnTask {
    cancel: watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
    output_path: std::path::PathBuf,
    frames_dir: std::path::PathBuf,
    cleanup_ledger_id: String,
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

fn advance_caption_start_intent(coordinator: &mut CaptionsCoordinator) -> u64 {
    coordinator.start_intent_generation = coordinator.start_intent_generation.wrapping_add(1);
    coordinator.start_intent_generation
}

/// Reserves one capture-owned caption auto-start generation. Explicit caption
/// or privacy commands take the same control lane and invalidate this token.
pub async fn reserve_caption_session_start(state: &AppState) -> Option<u64> {
    if state.process_shutdown_requested() {
        return None;
    }
    let _control = CAPTION_CONTROL.lock().await;
    if state.process_shutdown_requested() {
        return None;
    }
    let mut coordinator = state.captions.lock().await;
    if coordinator.privacy_teardown_in_progress || coordinator.privacy_teardown_failed {
        return None;
    }
    Some(advance_caption_start_intent(&mut coordinator))
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
        coordinator.presentation = Some(Arc::new(AtomicBool::new(true)));
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
            presented: true,
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
            placement: OverlayPlacement::from(CaptionOverlayPosition::Bottom),
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
        coordinator.presentation = Some(Arc::new(AtomicBool::new(true)));
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
pub(crate) async fn listen_wanted_for_test(state: &AppState) -> bool {
    state.captions.lock().await.listen_wanted
}

/// A live listen-only provider task on the tap (captions off, Buddy's listen
/// intent wanted), for the stop-path tests outside this module.
#[cfg(test)]
pub(crate) async fn install_listen_only_test_task(state: &AppState) {
    let mut receiver = install_tap();
    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = stop.clone();
    let task = tokio::spawn(async move {
        while !task_stop.load(Ordering::Acquire) {
            match tokio::time::timeout(std::time::Duration::from_millis(10), receiver.recv()).await
            {
                Ok(None) => break,
                Ok(Some(_)) | Err(_) => {}
            }
        }
    });
    let mut coordinator = state.captions.lock().await;
    coordinator.task = Some(task);
    coordinator.stop = Some(stop);
    coordinator.listen_wanted = true;
    coordinator.presentation = Some(Arc::new(AtomicBool::new(false)));
}

#[cfg(test)]
pub(crate) async fn caption_task_alive_for_test(state: &AppState) -> bool {
    coordinator_task_alive(&*state.captions.lock().await)
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
/// hold the coordinator lock while the RPC handler might). The status is
/// always remembered as the task's shadow; it reaches the renderer only while
/// captions present (plan 068 D1).
async fn publish_status(session: &CaptionSession, status: CaptionsStatus) {
    let mut coordinator = session.state.captions.lock().await;
    coordinator.shadow_status = Some(status.clone());
    if !session.presenting() {
        return;
    }
    coordinator.status = Some(status.clone());
    drop(coordinator);
    session.state.emit_event("captions.status", status);
}

/// Called under the co-host lifecycle fence. Retirement shares the lock used
/// by synchronous transcript appends; clear the old transcript before granting.
pub(crate) async fn retire_buddy_speech(state: &AppState) {
    let mut coordinator = state.captions.lock().await;
    coordinator.speech_admitted = false;
    coordinator.speech_epoch = coordinator.speech_epoch.saturating_add(1);
    coordinator.speech_started_at = None;
}

pub(crate) async fn grant_buddy_speech(state: &AppState) {
    if state.process_shutdown_requested() {
        return;
    }
    let mut coordinator = state.captions.lock().await;
    if state.process_shutdown_requested()
        || coordinator.privacy_teardown_in_progress
        || coordinator.privacy_teardown_failed
    {
        return;
    }
    if !coordinator.speech_admitted {
        coordinator.speech_admitted = true;
        coordinator.speech_started_at = Some(std::time::Instant::now());
    }
}

pub(crate) async fn retire_marker_voice(state: &AppState) {
    let mut coordinator = state.captions.lock().await;
    coordinator.marker_started_at = None;
    coordinator.marker_epoch = coordinator.marker_epoch.saturating_add(1);
}

pub(crate) async fn pause_marker_voice_for_service_flags(state: &AppState) {
    let listening = crate::cohost::CohostListening::blocked(
        "voice-disabled",
        "Buddy voice commands are temporarily unavailable. Turn listening on again after the pause ends.",
    );
    {
        let mut coordinator = state.captions.lock().await;
        coordinator.marker_started_at = None;
        coordinator.marker_epoch = coordinator.marker_epoch.saturating_add(1);
        coordinator.marker_listening = Some(listening.clone());
        if let Some(session_id) = coordinator.marker_session_id.as_ref() {
            state.emit_event(
                "session.marker.voice.status",
                serde_json::json!({"sessionId":session_id,"listening":listening}),
            );
        }
    }
    if crate::cohost::cohost_status(state)
        .await
        .session_id
        .is_none()
    {
        stop_listen(state).await;
    }
}

/// Capture-owned voice scope: never starts live chat or its scheduler.
/// Uses the existing shared provider, account gates and renderer-held AI consent.
pub(crate) async fn configure_marker_voice(
    state: &AppState,
    session_id: &str,
    consent: bool,
) -> Result<crate::cohost::CohostListening> {
    use crate::cohost::CohostListening;
    let _delivery = state.live_chat_persistence.begin_delivery().await;
    {
        let recording = state.recording.lock().await;
        if !recording
            .as_ref()
            .is_some_and(|r| r.session_id == session_id && !r.stop_requested)
        {
            bail!("The capture session has ended.")
        }
    }
    let settings = crate::cohost::get_cohost_settings(state).await;
    let blocked = if !consent {
        Some(CohostListening::blocked(
            "consent-required",
            "Enable cloud AI consent to use voice markers.",
        ))
    } else if !settings.enabled || !settings.listen {
        Some(CohostListening::off())
    } else if !crate::cohost::premium_entitled() {
        Some(CohostListening::blocked(
            "premium-required",
            "Buddy voice markers require Videorc Premium.",
        ))
    } else if crate::account::stored_session_token().is_none() {
        Some(CohostListening::blocked(
            "signed-out",
            "Sign in to use Buddy voice markers.",
        ))
    } else if !crate::service_flags::buddy_voice_commands_enabled(state) {
        Some(CohostListening::blocked(
            "voice-disabled",
            "Buddy voice commands are temporarily unavailable.",
        ))
    } else {
        None
    };
    {
        let mut coordinator = state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress || coordinator.privacy_teardown_failed {
            bail!("Account privacy cleanup is in progress.")
        }
        if coordinator.marker_session_id.as_deref() != Some(session_id) || blocked.is_some() {
            coordinator.marker_epoch = coordinator.marker_epoch.saturating_add(1);
            coordinator.marker_started_at = None;
        }
        coordinator.marker_session_id = Some(session_id.into());
        if blocked.is_none() && coordinator.marker_started_at.is_none() {
            coordinator.marker_started_at = Some(std::time::Instant::now())
        }
    }
    let listening = if let Some(blocked) = blocked {
        // Consent/settings opt-out cancels queued marker audio even if explicit captions stay on.
        if crate::cohost::cohost_status(state)
            .await
            .session_id
            .is_none()
        {
            stop_listen(state).await
        }
        blocked
    } else {
        start_listen_for_cohost(state, session_id).await
    };
    let mut coordinator = state.captions.lock().await;
    coordinator.marker_listening = Some(listening.clone());
    state.emit_event(
        "session.marker.voice.status",
        serde_json::json!({"sessionId":session_id,"listening":listening}),
    );
    Ok(listening)
}

fn marker_audio_owned(
    session: &CaptionSession,
    admission: AdmittedBuddyAudio,
    coordinator: &CaptionsCoordinator,
    target: Option<&crate::clip_marks::MarkTarget>,
) -> bool {
    admission.owns_marker(coordinator, target.map(|target| target.session_id.as_str()))
        && !session.stop.load(Ordering::Acquire)
        && crate::cohost::premium_entitled()
        && crate::account::stored_session_token().is_some()
        && crate::service_flags::buddy_voice_commands_enabled(&session.state)
}
fn publish_marker_outcome(
    session: &CaptionSession,
    target: Option<&crate::clip_marks::MarkTarget>,
    outcome: crate::marker_voice::UtteranceOutcome,
) -> bool {
    if let Some(message) = outcome.refusal {
        session.state.emit_event(
            "session.marker.voice.refused",
            serde_json::json!({"message":message}),
        );
    }
    if let Some(target) = target {
        for marker in outcome.markers {
            if let Err(error) = crate::session_markers::commit_voice(
                &session.state,
                crate::session_markers::CreateMarkerParams {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    session_id: target.session_id.clone(),
                    label: marker.label,
                },
                marker.at_seconds,
            ) {
                session.state.emit_event(
                    "session.marker.voice.refused",
                    serde_json::json!({"message":error.to_string()}),
                );
            }
        }
    }
    outcome.consumed
}
fn note_chunk_marker(
    session: &CaptionSession,
    chunk: &BufferedCaptionChunk,
    text: &str,
    segments: &[CaptionSegment],
    coordinator: &CaptionsCoordinator,
) -> bool {
    let mut buffer_epoch = session
        .marker_buffer_epoch
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut buffer = session
        .marker_utterance
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let owned = marker_audio_owned(
        session,
        chunk.admission,
        coordinator,
        session.mark_target.as_ref(),
    );
    tracing::debug!(
        seq = chunk.seq,
        offset_seconds = chunk.offset_seconds,
        marker_epoch = ?chunk.admission.marker_epoch,
        scope_epoch = coordinator.marker_epoch,
        owned,
        "Marker chunk admission"
    );
    if !owned {
        buffer.cancel();
        return buffer.observe_cancelled(&chunk.samples, text);
    }
    if *buffer_epoch != chunk.admission.marker_epoch {
        buffer.cancel();
        *buffer_epoch = chunk.admission.marker_epoch;
    }
    let outcome = buffer.observe(
        chunk.seq,
        chunk.offset_seconds,
        chunk.duration_seconds,
        &chunk.samples,
        text,
        segments,
    );
    publish_marker_outcome(session, session.mark_target.as_ref(), outcome)
}

/// Two independent owners travel with input audio. A Listen setting change
/// retires readiness without retiring speech admitted by the same consent.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct AdmittedBuddyAudio {
    speech_epoch: Option<u64>,
    listen_epoch: Option<u64>,
    marker_epoch: Option<u64>,
}

impl AdmittedBuddyAudio {
    fn owns_marker(
        self,
        coordinator: &CaptionsCoordinator,
        target_session_id: Option<&str>,
    ) -> bool {
        target_session_id.is_some()
            && target_session_id == coordinator.marker_session_id.as_deref()
            && coordinator.marker_started_at.is_some()
            && self.marker_epoch == Some(coordinator.marker_epoch)
            && !coordinator.privacy_teardown_in_progress
            && !coordinator.privacy_teardown_failed
    }

    fn merge(self, other: Self) -> Self {
        Self {
            marker_epoch: self
                .marker_epoch
                .filter(|epoch| Some(*epoch) == other.marker_epoch),
            speech_epoch: self
                .speech_epoch
                .filter(|epoch| Some(*epoch) == other.speech_epoch),
            listen_epoch: self
                .listen_epoch
                .filter(|epoch| Some(*epoch) == other.listen_epoch),
        }
    }

    fn owns_speech(self, coordinator: &CaptionsCoordinator) -> bool {
        coordinator.speech_admitted && self.speech_epoch == Some(coordinator.speech_epoch)
    }

    #[cfg(test)]
    fn test_epoch(epoch: u64) -> Self {
        Self {
            marker_epoch: None,
            speech_epoch: Some(epoch),
            listen_epoch: Some(epoch),
        }
    }
}

#[cfg(test)]
mod marker_ownership_tests {
    use super::*;

    #[test]
    fn delayed_marker_audio_cannot_acquire_a_replacement_capture_or_consent_grant() {
        let mut coordinator = CaptionsCoordinator {
            marker_session_id: Some("capture-a".into()),
            marker_epoch: 1,
            marker_started_at: Some(std::time::Instant::now()),
            ..Default::default()
        };
        let admitted = AdmittedBuddyAudio {
            marker_epoch: Some(1),
            ..Default::default()
        };
        assert!(admitted.owns_marker(&coordinator, Some("capture-a")));
        // Graceful caption retirement alone doesn't move the immutable target.
        coordinator.capture_epoch += 1;
        assert!(admitted.owns_marker(&coordinator, Some("capture-a")));
        coordinator.marker_session_id = Some("capture-b".into());
        coordinator.marker_epoch += 1;
        assert!(!admitted.owns_marker(&coordinator, Some("capture-a")));
        assert!(!admitted.owns_marker(&coordinator, Some("capture-b")));
        let fresh = AdmittedBuddyAudio {
            marker_epoch: Some(2),
            ..Default::default()
        };
        assert!(fresh.owns_marker(&coordinator, Some("capture-b")));
        coordinator.marker_started_at = None;
        coordinator.marker_epoch += 1;
        assert!(!fresh.owns_marker(&coordinator, Some("capture-b")));
        coordinator.marker_started_at = Some(std::time::Instant::now());
        assert!(!fresh.owns_marker(&coordinator, Some("capture-b")));
        let new_grant = AdmittedBuddyAudio {
            marker_epoch: Some(3),
            ..Default::default()
        };
        assert!(new_grant.owns_marker(&coordinator, Some("capture-b")));
        coordinator.privacy_teardown_in_progress = true;
        assert!(!new_grant.owns_marker(&coordinator, Some("capture-b")));
        coordinator.privacy_teardown_in_progress = false;
        coordinator.privacy_teardown_failed = true;
        assert!(!new_grant.owns_marker(&coordinator, Some("capture-b")));
    }
}

/// The listen epoch now (see `CaptionsCoordinator::listen_epoch`).
pub(crate) async fn current_listen_epoch(state: &AppState) -> u64 {
    state.captions.lock().await.listen_epoch
}

fn spawn_listening_publish(
    state: &AppState,
    listen_epoch: u64,
    listening: crate::cohost::CohostListening,
) {
    // Never await the chat lifecycle fence on the caption task: capture
    // finalization joins this task while holding that fence. The publish
    // re-checks the epoch under the fence, so a state the task queued before
    // a sign-out never overwrites the sign-out's `blocked`.
    let state = state.clone();
    tokio::spawn(async move {
        {
            let mut coordinator = state.captions.lock().await;
            if coordinator.listen_epoch == listen_epoch
                && coordinator.listen_wanted
                && coordinator.marker_started_at.is_some()
            {
                if let Some(session_id) = coordinator.marker_session_id.as_ref() {
                    state.emit_event(
                        "session.marker.voice.status",
                        serde_json::json!({"sessionId":session_id,"listening":listening}),
                    );
                }
                coordinator.marker_listening = Some(listening.clone());
            }
        }
        crate::cohost::publish_listening_for_epoch(&state, listen_epoch, listening).await;
    });
}

fn coordinator_task_alive(coordinator: &CaptionsCoordinator) -> bool {
    coordinator
        .task
        .as_ref()
        .is_some_and(|task| !task.is_finished())
}

fn coordinator_presenting(coordinator: &CaptionsCoordinator) -> bool {
    coordinator
        .presentation
        .as_ref()
        .is_some_and(|present| present.load(Ordering::Acquire))
}

/// A live task that Buddy's listen intent owns and captions do not present.
fn listen_only_task_alive(coordinator: &CaptionsCoordinator) -> bool {
    coordinator.listen_wanted
        && coordinator_task_alive(coordinator)
        && !coordinator_presenting(coordinator)
}

pub async fn start_captions(state: &AppState, language: Option<String>) -> Result<CaptionsStatus> {
    start_captions_with_bearer_for_session(
        state,
        None,
        language,
        crate::account::stored_session_token,
    )
    .await
    .map(|status| status.expect("unscoped caption start always returns a status"))
}

#[cfg(test)]
async fn start_captions_with_bearer(
    state: &AppState,
    language: Option<String>,
    resolve_bearer: impl FnOnce() -> Option<String> + Send,
) -> Result<CaptionsStatus> {
    start_captions_with_bearer_for_session(state, None, language, resolve_bearer)
        .await
        .map(|status| status.expect("unscoped caption start always returns a status"))
}

/// Starts captions only while the exact recording generation that requested
/// them still owns the capture slot. A stale queued task returns `None`
/// without changing global caption state or attaching to a replacement run.
pub async fn start_captions_for_session(
    state: &AppState,
    session_id: &str,
    start_intent_generation: u64,
    language: Option<String>,
) -> Result<Option<CaptionsStatus>> {
    start_captions_with_bearer_for_session(
        state,
        Some((session_id, start_intent_generation)),
        language,
        crate::account::stored_session_token,
    )
    .await
}

async fn start_captions_with_bearer_for_session(
    state: &AppState,
    expected_session: Option<(&str, u64)>,
    language: Option<String>,
    resolve_bearer: impl FnOnce() -> Option<String> + Send,
) -> Result<Option<CaptionsStatus>> {
    if state.process_shutdown_requested() {
        if expected_session.is_some() {
            return Ok(None);
        }
        bail!(CAPTION_START_SHUTDOWN_MESSAGE);
    }
    let _control = CAPTION_CONTROL.lock().await;
    // Shutdown takes this same control before its one-shot caption drain. A
    // start which was already queued must not recreate the tap/provider after
    // that drain releases the control lock.
    if state.process_shutdown_requested() {
        if expected_session.is_some() {
            return Ok(None);
        }
        bail!(CAPTION_START_SHUTDOWN_MESSAGE);
    }
    {
        let mut coordinator = state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress || coordinator.privacy_teardown_failed {
            if expected_session.is_some() {
                return Ok(None);
            }
            bail!(CAPTION_START_SIGN_OUT_MESSAGE);
        }
        if let Some((_, expected_generation)) = expected_session {
            if coordinator.start_intent_generation != expected_generation {
                return Ok(None);
            }
        } else {
            advance_caption_start_intent(&mut coordinator);
        }
    }
    // Hold the exact recording generation until the caption task is installed.
    // The process monitor cannot retire session A (and session B therefore
    // cannot replace it) between this check and the global caption commit.
    let expected_recording = match expected_session {
        Some((session_id, _)) => {
            let recording = state.recording.lock().await;
            if !recording
                .as_ref()
                .is_some_and(|active| active.session_id == session_id && !active.stop_requested)
            {
                return Ok(None);
            }
            Some(recording)
        }
        None => None,
    };
    let bearer = match resolve_bearer() {
        Some(bearer) => bearer,
        None => {
            let error = anyhow::anyhow!("Sign in to use live captions.");
            if expected_recording.is_some() {
                block_captions_after_control(
                    state,
                    "captions-start-failed",
                    format!("Live captions could not start: {error}"),
                )
                .await;
            }
            return Err(error);
        }
    };
    let client = match VideorcApiClient::new() {
        Ok(client) => client,
        Err(error) => {
            if expected_recording.is_some() {
                block_captions_after_control(
                    state,
                    "captions-start-failed",
                    format!("Live captions could not start: {error}"),
                )
                .await;
            }
            return Err(error);
        }
    };
    let language = normalize_caption_language(language);
    let capture_elapsed_seconds = if let Some(recording) = expected_recording.as_ref() {
        recording
            .as_ref()
            .map(crate::recording::ActiveRecording::capture_elapsed_seconds)
    } else {
        crate::recording::active_capture_elapsed_seconds(state).await
    };
    let capture_active =
        capture_elapsed_seconds.is_some() || caption_contract_idle_session_enabled();
    let (real_input_eligible, mark_target) = if let Some(recording) = expected_recording.as_ref() {
        caption_capture_facts(recording.as_ref())
    } else {
        caption_capture_facts(state.recording.lock().await.as_ref())
    };

    let mut coordinator = state.captions.lock().await;
    coordinator.desired_enabled = true;
    coordinator.language = language.clone();
    let listen_task_alive = coordinator.listen_wanted && coordinator_task_alive(&coordinator);
    if !capture_active {
        if !listen_task_alive {
            drop(coordinator);
            // The retired capture's monitor can still be awaiting this
            // control lock. Abort and join before Ready; its exact owner is
            // retired only by the monitor's subsequent capture-end call.
            finish_caption_task_for_retry(state, None).await?;
            coordinator = state.captions.lock().await;
        }
        let status = CaptionsStatus::ready();
        set_status(state, &mut coordinator, status.clone());
        return Ok(Some(status));
    }
    // A listen-only task already owns the tap and the timeline (plan 068 D1):
    // captions join it in place. Same task, same sequence, same offsets; the
    // renderer sees the transport state the task reached.
    if listen_only_task_alive(&coordinator) {
        if let Some(present) = coordinator.presentation.as_ref() {
            present.store(true, Ordering::Release);
        }
        let status = coordinator
            .shadow_status
            .clone()
            .unwrap_or_else(CaptionsStatus::ready);
        set_status(state, &mut coordinator, status.clone());
        return Ok(Some(status));
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
        return Ok(Some(status.clone()));
    }
    // An existing authorized caption task keeps its timeline through None or
    // input loss. Starting a new task still requires an actual supported input.
    if !real_input_eligible && !caption_contract_idle_session_enabled() {
        drop(coordinator);
        let message = "Select an available microphone before starting live captions.";
        block_captions_after_control(state, "captions-microphone-required", message.into()).await;
        anyhow::bail!(message);
    }
    drop(coordinator);
    finish_caption_task_for_retry(state, mark_target.as_ref()).await?;
    let mut coordinator = state.captions.lock().await;
    let status = spawn_transcription_task(
        state,
        &mut coordinator,
        TranscriptionTaskStart {
            bearer,
            client,
            language,
            capture_elapsed_seconds: capture_elapsed_seconds.unwrap_or(0.0),
            present: true,
            mark_target,
        },
    );
    set_status(state, &mut coordinator, status.clone());

    Ok(Some(status))
}

// Called only after start's existing task reuse and input eligibility gates,
// while CAPTION_CONTROL and any expected recording slot guard remain held.
async fn finish_caption_task_for_retry(
    state: &AppState,
    target: Option<&crate::clip_marks::MarkTarget>,
) -> Result<()> {
    let joined = finish_caption_task(state, true, false).await;
    let previous_join_unproven =
        target
            .filter(|target| target.records_to_file)
            .is_some_and(|target| {
                state.clip_marks.lock().map_or(true, |detector| {
                    detector.provider_join_unproven(&target.session_id)
                })
            });
    if !joined || previous_join_unproven {
        let message = "The previous caption provider did not finish stopping. Live captions could not restart safely.";
        block_captions_after_control(state, "captions-start-failed", message.into()).await;
        bail!(message);
    }
    Ok(())
}

/// What the caption start seams read off the capture slot: whether its
/// microphone can feed the tap, and where a voice clip mark for it lands.
fn caption_capture_facts(
    active: Option<&crate::recording::ActiveRecording>,
) -> (bool, Option<crate::clip_marks::MarkTarget>) {
    let eligible = active
        .and_then(|active| active.native_audio.as_ref())
        .is_some_and(|audio| audio.caption_start_eligible());
    let mark_target = active.map(|active| crate::clip_marks::MarkTarget {
        session_id: active.session_id.clone(),
        records_to_file: active.output_path.is_some(),
    });
    (eligible, mark_target)
}

struct TranscriptionTaskStart {
    bearer: String,
    client: VideorcApiClient,
    language: Option<String>,
    capture_elapsed_seconds: f64,
    present: bool,
    mark_target: Option<crate::clip_marks::MarkTarget>,
}

/// Install the tap and spawn the one provider task both intents share
/// (plan 068 D1). Returns the Starting status; the caller decides whether it
/// is presented. Any finished/stale task is replaced.
fn spawn_transcription_task(
    state: &AppState,
    coordinator: &mut CaptionsCoordinator,
    start: TranscriptionTaskStart,
) -> CaptionsStatus {
    crate::clip_marks::register_caption_target(state, start.mark_target.as_ref());
    if let Some(task) = coordinator.task.take() {
        let target = coordinator.task_mark_target.take();
        note_caption_provider_join(state, target.as_ref(), task.is_finished());
        task.abort();
    }
    remove_tap();

    let session_client_id = format!("captions-{}", uuid::Uuid::new_v4().simple());
    let sequence = coordinator.sequence.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let present = Arc::new(AtomicBool::new(start.present));
    let receiver = install_tap();
    let mut status = CaptionsStatus::active(
        CaptionsState::Starting,
        CaptionsTransport::Realtime,
        &session_client_id,
    );
    status.message = Some("Connecting live captions…".to_string());
    coordinator.shadow_status = Some(status.clone());
    coordinator.presentation = Some(present.clone());
    coordinator.listen_ready = false;
    coordinator.task_mark_target = start.mark_target.clone();

    let task_state = state.clone();
    let task_stop = stop.clone();
    coordinator.task = Some(tokio::spawn(run_caption_session(CaptionSession {
        bearer: start.bearer,
        client: start.client,
        language: start.language,
        receiver,
        capture_elapsed_seconds: start.capture_elapsed_seconds,
        session_client_id,
        sequence,
        state: task_state,
        stop: task_stop,
        present,
        mark_target: start.mark_target,
        marker_utterance: std::sync::Mutex::new(Default::default()),
        marker_buffer_epoch: std::sync::Mutex::new(None),
    })));
    coordinator.stop = Some(stop);
    status
}

/// Start Buddy's listen intent for a running Buddy session (plan 068 D2).
/// Reuses the caption start gates but never fails or blocks capture, never
/// raises a caption block, and never publishes a caption status: with no
/// eligible microphone, bearer or capture it reports a listen block and
/// returns quietly. The intent stays wanted so a later capture start resumes
/// it (`resume_listen_for_capture`).
pub async fn start_listen_for_cohost(
    state: &AppState,
    cohost_session_id: &str,
) -> crate::cohost::CohostListening {
    start_listen_with_bearer(
        state,
        cohost_session_id,
        crate::account::stored_session_token,
    )
    .await
}

async fn start_listen_with_bearer(
    state: &AppState,
    cohost_session_id: &str,
    resolve_bearer: impl FnOnce() -> Option<String> + Send,
) -> crate::cohost::CohostListening {
    start_listen_with_bearer_for_epoch(state, cohost_session_id, resolve_bearer, None).await
}

async fn start_listen_with_bearer_for_epoch(
    state: &AppState,
    cohost_session_id: &str,
    resolve_bearer: impl FnOnce() -> Option<String> + Send,
    expected_epoch: Option<u64>,
) -> crate::cohost::CohostListening {
    use crate::cohost::CohostListening;
    if state.process_shutdown_requested() {
        return CohostListening::blocked("shutting-down", "Videorc is shutting down.");
    }
    let _control = CAPTION_CONTROL.lock().await;
    if state.process_shutdown_requested() {
        return CohostListening::blocked("shutting-down", "Videorc is shutting down.");
    }
    {
        let coordinator = state.captions.lock().await;
        if expected_epoch
            .is_some_and(|epoch| coordinator.listen_epoch != epoch || !coordinator.listen_wanted)
        {
            return CohostListening::off();
        }
        if coordinator.privacy_teardown_in_progress || coordinator.privacy_teardown_failed {
            return CohostListening::blocked(
                "signing-out",
                "Buddy can't listen while account sign-out cleans up private caption data.",
            );
        }
    }
    let capture_elapsed_seconds = crate::recording::active_capture_elapsed_seconds(state).await;
    let capture_active =
        capture_elapsed_seconds.is_some() || caption_contract_idle_session_enabled();
    let (real_input_eligible, mark_target) =
        caption_capture_facts(state.recording.lock().await.as_ref());

    let mut coordinator = state.captions.lock().await;
    if !coordinator.listen_wanted {
        coordinator.listen_started_at = Some(std::time::Instant::now());
    }
    coordinator.listen_wanted = true;
    if coordinator_task_alive(&coordinator) {
        // Captions (or an earlier listen) already run the task: join it.
        let ready = coordinator.listen_ready
            || coordinator
                .shadow_status
                .as_ref()
                .is_some_and(|status| status.provider_ready);
        return if ready {
            CohostListening::on(None)
        } else {
            CohostListening::starting()
        };
    }
    if !capture_active {
        return CohostListening::blocked("no-capture", "Buddy hears you once a session is live.");
    }
    if !real_input_eligible && !caption_contract_idle_session_enabled() {
        return CohostListening::blocked(
            "no-microphone",
            "Select a microphone so Buddy can hear you.",
        );
    }
    // Credentials are read only once a session could actually listen.
    let Some(bearer) = resolve_bearer() else {
        return CohostListening::blocked("signed-out", "Sign in so Buddy can hear you.");
    };
    let client = match VideorcApiClient::new() {
        Ok(client) => client,
        Err(error) => {
            return CohostListening::blocked(
                "service-unavailable",
                format!("Buddy can't reach the transcription service: {error}"),
            );
        }
    };
    let language = coordinator.language.clone();
    spawn_transcription_task(
        state,
        &mut coordinator,
        TranscriptionTaskStart {
            bearer,
            client,
            language,
            capture_elapsed_seconds: capture_elapsed_seconds.unwrap_or(0.0),
            present: false,
            mark_target,
        },
    );
    tracing::info!(cohost_session_id, "Buddy listen intent started.");
    CohostListening::starting()
}

/// Capture start seam: a listen intent that was wanted before capture (or
/// blocked by no capture) starts now. Runs off the recording path and never
/// delays it.
pub async fn resume_listen_for_capture(state: &AppState) {
    resume_listen_for_capture_after_check(state, std::future::ready(())).await;
}

async fn resume_listen_for_capture_after_check<F>(state: &AppState, after_check: F)
where
    F: std::future::Future<Output = ()>,
{
    let epoch = {
        let coordinator = state.captions.lock().await;
        (coordinator.listen_wanted && !coordinator_task_alive(&coordinator))
            .then_some(coordinator.listen_epoch)
    };
    let Some(epoch) = epoch else {
        return;
    };
    after_check.await;
    let Some(session_id) = crate::cohost::cohost_status(state).await.session_id else {
        return;
    };
    let listening = start_listen_with_bearer_for_epoch(
        state,
        &session_id,
        crate::account::stored_session_token,
        Some(epoch),
    )
    .await;
    crate::cohost::publish_listening_for_epoch(state, epoch, listening).await;
}

/// How Buddy's listen intent ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenStop {
    /// The user stopped Buddy, listening or chat: a listen-only task ends at
    /// once and queued audio is never transcribed (a privacy boundary).
    Abort,
    /// The capture is ending and `finish_captions_for_capture` follows (the
    /// recording monitor): only the intent clears. A listen-only task keeps
    /// running until that seam closes the tap and drains its last chunks
    /// into the SRT, Clip that and the transcript.
    DrainWithCapture,
    /// `session.stop`: drain with the capture when one is running, else abort.
    DrainIfCapturing,
}

/// End Buddy's listen intent (plan 068 D1). Captions that present keep the
/// task; a listen-only task ends at once like an explicit caption opt-out
/// (queued audio is not transcribed after it). Never publishes a caption
/// status.
pub async fn stop_listen(state: &AppState) {
    stop_listen_with(state, ListenStop::Abort).await;
}

pub async fn stop_listen_with(state: &AppState, how: ListenStop) {
    let drain_with_capture = match how {
        ListenStop::Abort => false,
        ListenStop::DrainWithCapture => true,
        ListenStop::DrainIfCapturing => crate::recording::active_capture_elapsed_seconds(state)
            .await
            .is_some(),
    };
    let _control = CAPTION_CONTROL.lock().await;
    let end_task = {
        let mut coordinator = state.captions.lock().await;
        coordinator.listen_wanted = false;
        coordinator.listen_ready = false;
        // A listening state the task decided to publish before the intent
        // ended never lands after it.
        coordinator.listen_epoch = coordinator.listen_epoch.saturating_add(1);
        // Retirement owns cleanup even if the provider finished first. A
        // completed handle still owns its stop flag and installed tap.
        !drain_with_capture && coordinator.task.is_some() && !coordinator_presenting(&coordinator)
    };
    if end_task {
        finish_caption_task(state, true, false).await;
    }
}

pub async fn stop_captions(state: &AppState) -> CaptionsStatus {
    let _control = CAPTION_CONTROL.lock().await;
    let keep_listen_task = {
        let mut coordinator = state.captions.lock().await;
        advance_caption_start_intent(&mut coordinator);
        coordinator.listen_wanted && coordinator_task_alive(&coordinator)
    };
    if !keep_listen_task {
        // Explicit opt-out is a privacy boundary: do not transcribe audio
        // already queued behind the user's click. Graceful draining is
        // reserved for the capture-finalization path below so its last
        // settled cue can reach SRT.
        finish_caption_task(state, false, false).await;
    }
    let status = {
        let mut coordinator = state.captions.lock().await;
        coordinator.desired_enabled = false;
        coordinator.language = None;
        if keep_listen_task {
            // Buddy still listens (plan 068 D1): presentation goes off, the
            // task and tap stay. Nothing captions showed survives this click.
            if let Some(present) = coordinator.presentation.as_ref() {
                present.store(false, Ordering::Release);
            }
        } else {
            remove_tap();
        }
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
    let _sign_out = CAPTION_SIGN_OUT_SERIAL.lock().await;
    let (
        task,
        stop,
        pending_frames_dirs,
        caption_burn_tasks,
        artifact_publication,
        private_frame_io,
        task_mark_target,
    ) = {
        let _control = CAPTION_CONTROL.lock().await;
        let mut coordinator = state.captions.lock().await;
        advance_caption_start_intent(&mut coordinator);
        // A previous bounded attempt may have failed, but its durable ledger
        // and retained task handles remain authoritative cleanup ownership.
        // Every retry still detaches the provider/tap first and then retries
        // those exact objects; failure is not an unrecoverable in-memory latch.
        coordinator.privacy_teardown_failed = false;
        coordinator.privacy_teardown_in_progress = true;
        coordinator.privacy_provider_joined = false;
        coordinator.desired_enabled = false;
        coordinator.listen_wanted = false;
        coordinator.listen_ready = false;
        // A listening publish queued before this line never lands after it.
        coordinator.listen_epoch = coordinator.listen_epoch.saturating_add(1);
        coordinator.marker_started_at = None;
        coordinator.marker_epoch = coordinator.marker_epoch.saturating_add(1);
        coordinator.marker_session_id = None;
        coordinator.speech_admitted = false;
        coordinator.speech_epoch = coordinator.speech_epoch.saturating_add(1);
        coordinator.speech_started_at = None;
        coordinator.presentation = None;
        coordinator.shadow_status = None;
        coordinator.language = None;
        coordinator.chunks.clear();
        coordinator.capture_epoch = coordinator.capture_epoch.saturating_add(1);
        coordinator.finalized_style = None;
        coordinator.artifact_generation = coordinator.artifact_generation.saturating_add(1);
        let runtime = (
            coordinator.task.take(),
            coordinator.stop.take(),
            coordinator.task_mark_target.take(),
        );
        let pending_frames_dirs = take_pending_caption_frame_dirs(&mut coordinator);
        let caption_burn_tasks = std::mem::take(&mut coordinator.caption_burn_tasks);
        let artifact_publication = coordinator.artifact_publication.clone();
        let private_frame_io = coordinator.private_frame_io.clone();
        let status = CaptionsStatus::idle();
        coordinator.status = Some(status);
        (
            runtime.0,
            runtime.1,
            pending_frames_dirs,
            caption_burn_tasks,
            artifact_publication,
            private_frame_io,
            runtime.2,
        )
    };

    // The generation/fence above is authoritative before any external work.
    // Capture finalization may now acquire CAPTION_CONTROL while cancellation,
    // filesystem cleanup, and joins proceed independently.
    remove_tap();
    TAP_FRAMES_SEEN.store(0, Ordering::Release);
    TAP_FRAMES_DROPPED.store(0, Ordering::Release);
    clear_caption_presentation(state, "signing-out");
    let runtime_stopped = finish_taken_caption_task(task, stop, false).await;
    note_caption_provider_join(state, task_mark_target.as_ref(), runtime_stopped);
    if runtime_stopped {
        // The provider was detached under the generation fence, but an
        // already-polled future could have committed one last chunk before
        // cancellation reached it. Join first, then purge again so credential
        // removal follows a proven transcript-empty boundary.
        let mut coordinator = state.captions.lock().await;
        coordinator.chunks.clear();
        coordinator.finalized_style = None;
        coordinator.privacy_provider_joined = true;
        if let Ok(mut detector) = state.clip_marks.lock() {
            detector.retire_deferred_recordings();
        }
    }
    // Buddy's copy of what was said goes with the transcript, before the
    // credentials do: nothing heard under this account can ride the next
    // tick under another, and Buddy stops claiming it listens.
    crate::cohost::purge_speech_for_sign_out(state).await;
    // Any SRT writer which crossed the old generation must finish publication
    // or remove its identity-bound staging/output before credentials can be
    // cleared. This wait owns no general caption-control/coordinator lock.
    let io_deadline = tokio::time::Instant::now() + CAPTION_PRIVATE_IO_DRAIN_TIMEOUT;
    let (publication_wait, frame_wait) = tokio::join!(
        tokio::time::timeout_at(io_deadline, artifact_publication.lock()),
        tokio::time::timeout_at(io_deadline, private_frame_io.lock()),
    );
    let publication_drained = publication_wait.is_ok();
    let frame_io_drained = frame_wait.is_ok();
    if !publication_drained || !frame_io_drained {
        tracing::error!(
            publication_drained,
            frame_io_drained,
            "Private caption I/O did not reach its sign-out fence before the bounded deadline."
        );
    }
    let pending_removed = if frame_io_drained {
        remove_pending_caption_frame_dirs(pending_frames_dirs).await
    } else {
        false
    };
    let burn_cleanup = cancel_and_join_caption_burn_tasks(state, caption_burn_tasks).await;
    if !burn_cleanup.unfinished.is_empty() {
        state
            .captions
            .lock()
            .await
            .caption_burn_tasks
            .extend(burn_cleanup.unfinished);
    }
    let burns_stopped = burn_cleanup.complete;
    let durable_cleanup_complete = cleanup_registered_caption_private_artifacts(state).await;
    let privacy_io_safe = !state.captions.lock().await.privacy_teardown_failed;
    let cleanup_complete = runtime_stopped
        && publication_drained
        && frame_io_drained
        && pending_removed
        && burns_stopped
        && durable_cleanup_complete
        && privacy_io_safe;

    if cleanup_complete {
        // Credential removal is deliberately after the private-data barrier.
        // A failed/unfinished cleanup therefore cannot be reported as a
        // successful sign-out.
        clear_credentials();
        let status = CaptionsStatus::idle();
        {
            let _control = CAPTION_CONTROL.lock().await;
            let mut coordinator = state.captions.lock().await;
            coordinator.privacy_teardown_in_progress = false;
            coordinator.privacy_teardown_failed = false;
            coordinator.status = Some(status.clone());
        }
        publish_caption_boundary(state, &status, "signed-out");
        status
    } else {
        let mut status = CaptionsStatus::idle();
        status.state = CaptionsState::Blocked;
        status.reason_code = Some("captions-privacy-cleanup-failed".to_string());
        status.message = Some(
            "Sign-out was not completed because private caption cleanup did not finish. Try again after the current cleanup settles."
                .to_string(),
        );
        {
            let _control = CAPTION_CONTROL.lock().await;
            let mut coordinator = state.captions.lock().await;
            // Keep the fence set. Starts remain blocked and credentials stay
            // present rather than claiming a privacy transition we could not
            // prove complete.
            coordinator.privacy_teardown_failed = true;
            coordinator.status = Some(status.clone());
        }
        publish_caption_boundary(state, &status, "sign-out-cleanup-failed");
        status
    }
}

/// Stop and join the provider task before backend shutdown takes ownership of
/// the active recording. Taking `state.recording` makes its monitor return
/// before ordinary capture finalization, so shutdown cannot rely on that path
/// to remove the microphone tap. Preferences and artifact cues remain intact
/// for the separate artifact teardown below.
pub async fn shutdown_caption_runtime(state: &AppState) {
    let _control = CAPTION_CONTROL.lock().await;
    shutdown_caption_runtime_after_control(state).await;
}

async fn shutdown_caption_runtime_after_control(state: &AppState) {
    {
        let mut coordinator = state.captions.lock().await;
        advance_caption_start_intent(&mut coordinator);
    }
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
    let _ = cancel_and_join_caption_burn_tasks(state, caption_burn_tasks).await;
    let _ = cleanup_registered_caption_private_artifacts(state).await;
}

/// Capture sessions own caption audio. Closing the tap lets queued frames drain
/// and gives realtime VAD a bounded window to settle the last utterance before
/// artifact generation drains canonical cues.
pub async fn finish_captions_for_capture(state: &AppState, session_id: &str) -> CaptionsStatus {
    let _control = CAPTION_CONTROL.lock().await;
    {
        let mut coordinator = state.captions.lock().await;
        advance_caption_start_intent(&mut coordinator);
        if coordinator.privacy_teardown_in_progress {
            // Sign-out already took the provider and advanced the artifact
            // generation. Capture finalization must remain non-blocking but
            // must not repopulate finalized caption state behind that privacy
            // boundary.
            let status = CaptionsStatus::idle();
            coordinator.status = Some(status.clone());
            if let Ok(mut detector) = state.clip_marks.lock() {
                detector.defer_retirement(session_id);
                if coordinator.privacy_provider_joined {
                    detector.retire_recording(session_id);
                }
            }
            drop(coordinator);
            clear_caption_presentation(state, "capture-ended-during-sign-out");
            return status;
        }
        let style = coordinator.style;
        coordinator.finalized_style = Some(style);
    }
    if finish_caption_task(state, true, true).await {
        // The monitor passes the immutable retired capture ID. The recording
        // slot is already gone, and must never stand in for this drain owner.
        if let Ok(mut detector) = state.clip_marks.lock()
            && !detector.retire_recording(session_id)
        {
            detector.defer_retirement(session_id);
            state.emit_log(
                "warn",
                "The recording's earlier caption provider join remains unproven; its clip owner is retained."
                    .to_string(),
            );
        }
    } else {
        state.emit_log(
            "warn",
            "Caption provider teardown did not finish; its recording clip owner remains retained."
                .to_string(),
        );
    }
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
) -> bool {
    let (task, stop, task_mark_target) = {
        let mut coordinator = state.captions.lock().await;
        if !preserve_desired {
            coordinator.desired_enabled = false;
        }
        coordinator.presentation = None;
        coordinator.shadow_status = None;
        coordinator.listen_ready = false;
        (
            coordinator.task.take(),
            coordinator.stop.take(),
            coordinator.task_mark_target.take(),
        )
    };
    let joined = finish_taken_caption_task(task, stop, drain_final_transcript).await;
    note_caption_provider_join(state, task_mark_target.as_ref(), joined);
    joined
}

fn note_caption_provider_join(
    state: &AppState,
    target: Option<&crate::clip_marks::MarkTarget>,
    joined: bool,
) {
    if !joined
        && let Some(target) = target.filter(|target| target.records_to_file)
        && let Ok(mut detector) = state.clip_marks.lock()
    {
        detector.note_provider_join_failed(&target.session_id);
    }
}

async fn finish_taken_caption_task(
    task: Option<tokio::task::JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
    drain_final_transcript: bool,
) -> bool {
    if !drain_final_transcript && let Some(stop) = stop.as_ref() {
        stop.store(true, Ordering::Release);
    }
    remove_tap();
    let Some(mut task) = task else {
        return true;
    };
    if !drain_final_transcript {
        // Cancellation drops the receiver and any in-flight upload future at
        // once. Waiting for a cooperative loop turn could otherwise let a
        // queued chunk reach the provider after the user opted out.
        task.abort();
        return tokio::time::timeout(CAPTION_ABORT_JOIN_TIMEOUT, &mut task)
            .await
            .is_ok();
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
        return tokio::time::timeout(CAPTION_ABORT_JOIN_TIMEOUT, &mut task)
            .await
            .is_ok();
    }
    true
}

pub async fn block_captions_for_audio_path(state: &AppState, message: impl Into<String>) {
    block_captions(state, "audio-path-unsupported", message).await;
}

pub async fn block_captions(state: &AppState, reason_code: &str, message: impl Into<String>) {
    let _control = CAPTION_CONTROL.lock().await;
    block_captions_after_control(state, reason_code, message.into()).await;
}

async fn block_captions_after_control(state: &AppState, reason_code: &str, message: String) {
    {
        let mut coordinator = state.captions.lock().await;
        advance_caption_start_intent(&mut coordinator);
    }
    // A block is terminal for this runtime. Discard pending PCM just like an
    // explicit opt-out; only a normal capture end may drain final audio. A
    // task Buddy's listen intent still wants keeps running unpresented.
    let keep_listen_task = {
        let coordinator = state.captions.lock().await;
        coordinator.listen_wanted && coordinator_task_alive(&coordinator)
    };
    if keep_listen_task {
        let coordinator = state.captions.lock().await;
        if let Some(present) = coordinator.presentation.as_ref() {
            present.store(false, Ordering::Release);
        }
    } else {
        finish_caption_task(state, true, false).await;
    }
    let status = {
        let mut coordinator = state.captions.lock().await;
        coordinator.desired_enabled = true;
        let mut status = CaptionsStatus::ready();
        status.state = CaptionsState::Blocked;
        status.reason_code = Some(reason_code.to_string());
        status.message = Some(message);
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
    /// Captions are presenting (plan 068 D1). Flipped by `captions.start` /
    /// `captions.stop` while the task keeps running for the listen intent.
    present: Arc<AtomicBool>,
    /// The capture this task transcribes, read when the task started: a voice
    /// clip mark lands on it even while the capture-end drain runs after the
    /// recording slot was retired.
    mark_target: Option<crate::clip_marks::MarkTarget>,
    marker_utterance: std::sync::Mutex<crate::marker_voice::UtteranceBuffer>,
    marker_buffer_epoch: std::sync::Mutex<Option<u64>>,
}

impl CaptionSession {
    fn presenting(&self) -> bool {
        self.present.load(Ordering::Acquire)
    }

    /// Stamp audio at admission, before its provider response can be delayed.
    async fn admitted_listen_epoch(&self) -> Option<u64> {
        let coordinator = self.state.captions.lock().await;
        coordinator
            .listen_wanted
            .then_some(coordinator.listen_epoch)
    }

    async fn admitted_buddy_audio(&self) -> AdmittedBuddyAudio {
        let coordinator = self.state.captions.lock().await;
        AdmittedBuddyAudio {
            marker_epoch: coordinator
                .marker_started_at
                .map(|_| coordinator.marker_epoch),
            speech_epoch: coordinator
                .speech_admitted
                .then_some(coordinator.speech_epoch),
            listen_epoch: coordinator
                .listen_wanted
                .then_some(coordinator.listen_epoch),
        }
    }

    async fn admitted_buddy_audio_for_frame(&self, frame: &AudioFrame) -> AdmittedBuddyAudio {
        let coordinator = self.state.captions.lock().await;
        // Some producers stamp the buffer end. Requiring the entire frame
        // after grant excludes queued old audio and crossing frames. Caption
        // audio, capture timestamps, and recording clip marks stay unchanged.
        let Some(earliest) = frame.captured_at.checked_sub(frame.duration()) else {
            return AdmittedBuddyAudio::default();
        };
        AdmittedBuddyAudio {
            marker_epoch: coordinator
                .marker_started_at
                .filter(|grant| earliest >= *grant)
                .map(|_| coordinator.marker_epoch),
            speech_epoch: coordinator
                .speech_started_at
                .filter(|grant| coordinator.speech_admitted && earliest >= *grant)
                .map(|_| coordinator.speech_epoch),
            listen_epoch: coordinator
                .listen_started_at
                .filter(|grant| coordinator.listen_wanted && earliest >= *grant)
                .map(|_| coordinator.listen_epoch),
        }
    }

    /// Provider readiness belongs to the admitted input, never to a later
    /// listen intent. Publication runs off the caption task to avoid awaiting
    /// the chat lifecycle fence during capture finalization.
    async fn note_listen_ready(
        &self,
        admitted_epoch: Option<u64>,
        listening: crate::cohost::CohostListening,
    ) {
        let Some(epoch) = admitted_epoch else {
            return;
        };
        {
            let mut coordinator = self.state.captions.lock().await;
            if !coordinator.listen_wanted || coordinator.listen_epoch != epoch {
                return;
            }
            coordinator.listen_ready = true;
            if coordinator.marker_started_at.is_some() {
                if let Some(session_id) = coordinator.marker_session_id.as_ref() {
                    self.state.emit_event(
                        "session.marker.voice.status",
                        serde_json::json!({"sessionId":session_id,"listening":listening}),
                    );
                }
                coordinator.marker_listening = Some(listening.clone());
            }
        }
        spawn_listening_publish(&self.state, epoch, listening);
    }

    /// Caption health events are presentation: listen-only stays silent.
    fn emit_health(&self, level: crate::protocol::HealthLevel, code: &str, message: &str) {
        if !self.presenting() {
            return;
        }
        let _ = crate::recording::emit_health_event(&self.state, None, level, code, message);
    }

    fn chunk_purpose(&self) -> crate::videorc_api::CaptionChunkPurpose {
        if self.presenting() {
            crate::videorc_api::CaptionChunkPurpose::Captions
        } else {
            crate::videorc_api::CaptionChunkPurpose::Listen
        }
    }
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
    admission: AdmittedBuddyAudio,
}

/// A VAD item keeps its admission ownership and original file coordinates
/// through re-anchor. Completed identities remain briefly for canonical cue
/// corrections, but their clip hook runs only once. Unknown/pruned items can
/// never borrow the current timeline or recording.
#[derive(Debug, Clone, PartialEq)]
struct RealtimeCaptionItem {
    seq: u64,
    offset_seconds: f64,
    capture_epoch: u64,
    capture_end_seconds: Option<f64>,
    admission: AdmittedBuddyAudio,
    mark_target: Option<crate::clip_marks::MarkTarget>,
    clip_processed: bool,
}

const MAX_REALTIME_CAPTION_ITEMS: usize = 128;

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

/// Audio offsets belong to the consent intent at input admission, not to the
/// intent present when a delayed VAD or transcript event reaches us. Retain a
/// bounded number of boundaries; older or missing offsets have no Buddy owner.
#[derive(Default)]
struct RealtimeAudioAdmissions {
    boundaries: std::collections::VecDeque<(f64, AdmittedBuddyAudio)>,
    sent_ms: f64,
}

impl RealtimeAudioAdmissions {
    fn record(&mut self, duration_ms: f64, admission: AdmittedBuddyAudio) {
        if self
            .boundaries
            .back()
            .is_none_or(|(_, last)| *last != admission)
        {
            self.boundaries.push_back((self.sent_ms, admission));
            if self.boundaries.len() > 64 {
                self.boundaries.pop_front();
            }
        }
        self.sent_ms += duration_ms;
    }

    fn at(&self, audio_start_ms: Option<f64>) -> AdmittedBuddyAudio {
        let Some(start) = audio_start_ms.filter(|start| start.is_finite() && *start >= 0.0) else {
            return AdmittedBuddyAudio::default();
        };
        if start >= self.sent_ms {
            return AdmittedBuddyAudio::default();
        }
        self.boundaries
            .iter()
            .rev()
            .find(|(boundary, _)| *boundary <= start)
            .map(|(_, admission)| *admission)
            .unwrap_or_default()
    }

    fn for_event(
        &self,
        event: &RealtimeCaptionEvent,
        items: &std::collections::HashMap<String, RealtimeCaptionItem>,
        socket_admission: AdmittedBuddyAudio,
    ) -> AdmittedBuddyAudio {
        match event {
            RealtimeCaptionEvent::SpeechStarted { audio_start_ms, .. } => self.at(*audio_start_ms),
            RealtimeCaptionEvent::Partial { item_id, .. }
            | RealtimeCaptionEvent::Completed { item_id, .. } => items
                .get(item_id)
                .map(|item| item.admission)
                .unwrap_or_default(),
            RealtimeCaptionEvent::ConfigurationAcknowledged => socket_admission,
            _ => AdmittedBuddyAudio::default(),
        }
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

/// One RMS window of the silence gate (plan 068 D4): 50 ms at 16 kHz.
const SPEECH_WINDOW_SAMPLES: usize = CAPTION_SAMPLE_RATE as usize / 20;
/// -45 dBFS as a linear full-scale ratio.
const SPEECH_RMS_FLOOR: f64 = 0.005_623_413_251_903_491;

fn window_rms(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_square = samples
        .iter()
        .map(|sample| {
            let normalized = f64::from(*sample) / f64::from(i16::MAX);
            normalized * normalized
        })
        .sum::<f64>()
        / samples.len() as f64;
    mean_square.sqrt()
}

/// Silence gate for one transcription chunk (plan 068 D4): `false` only when
/// every 50 ms window's RMS sits below -45 dBFS. A trailing partial window
/// counts. Empty input is silence.
pub fn chunk_has_speech(samples: &[i16]) -> bool {
    samples
        .chunks(SPEECH_WINDOW_SAMPLES)
        .any(|window| window_rms(window) >= SPEECH_RMS_FLOOR)
}

/// Voice activity for one received frame (plan 068 D9): the same gate as the
/// chunk silence skip, on the frame the caption task already holds.
pub(crate) fn pcm_has_voice(samples: &[i16]) -> bool {
    chunk_has_speech(samples)
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
    // Buddy's listen intent never uses the realtime socket (plan 068 D5): its
    // token route is caption-gated, so a caption quota or the captions switch
    // would end listening. A listen-only task goes straight to the metered
    // chunk path and stays there, even if captions join it later.
    let realtime = if session.presenting() {
        run_realtime_caption_session(&mut session, &sequence, &mut timeline, &mut audio_heartbeat)
            .await
    } else {
        RealtimeOutcome::ListenOnly
    };
    let ended_normally = match realtime {
        RealtimeOutcome::Ended => true,
        RealtimeOutcome::ListenOnly => {
            tracing::info!("Buddy listens through chunked transcription.");
            let mut status = CaptionsStatus::active(
                CaptionsState::Degraded,
                CaptionsTransport::Chunked,
                &session.session_client_id,
            );
            status.reason_code = Some("realtime-fallback".to_string());
            status.message = Some("Captions on with higher delay.".to_string());
            // Presentation is off: this is the shadow a later captions start
            // adopts, never a caption status the renderer sees now.
            publish_status(&session, status).await;
            run_chunked_caption_session(
                &mut session,
                &sequence,
                &mut timeline,
                &mut audio_heartbeat,
            )
            .await
        }
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
            status.message = Some(format!("Captions on with higher delay: {reason}"));
            publish_status(&session, status).await;
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
        let (desired_enabled, listen_wanted, listen_epoch) = {
            let coordinator = session.state.captions.lock().await;
            (
                coordinator.desired_enabled,
                coordinator.listen_wanted,
                coordinator.listen_epoch,
            )
        };
        if listen_wanted {
            spawn_listening_publish(
                &session.state,
                listen_epoch,
                crate::cohost::CohostListening::blocked(
                    "no-capture",
                    "Buddy hears you while a session is live.",
                ),
            );
        }
        // A listen-only end is silent: the renderer never saw a caption
        // session, so it gets no caption boundary here.
        if desired_enabled || session.presenting() {
            let status = if desired_enabled {
                CaptionsStatus::ready()
            } else {
                CaptionsStatus::idle()
            };
            let mut coordinator = session.state.captions.lock().await;
            coordinator.status = Some(status.clone());
            drop(coordinator);
            session.state.emit_event("captions.status", status);
        }
    }
}

enum RealtimeOutcome {
    /// Session stopped normally (stop flag / tap removed).
    Ended,
    /// Streaming can't run (no key, mint failed, socket rejected) — chunk instead.
    Fallback(String),
    /// A listen-only task never tries streaming: chunk from the start.
    ListenOnly,
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
    // Utterance bookkeeping: item id → (caption seq, audio offset, speech/listen owners).
    let mut items: std::collections::HashMap<String, RealtimeCaptionItem> =
        std::collections::HashMap::new();
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

        let socket_admission = session.admitted_buddy_audio().await;
        let token = match session
            .client
            .mint_caption_realtime_token(&session.bearer, &session.session_client_id)
            .await
        {
            Ok(token) => token,
            Err(CaptionChunkFailure::Terminal { code, message }) => {
                tracing::warn!("Live captions stopped ({code}): {message}");
                return realtime_terminal_outcome(
                    handle_terminal_failure(
                        session,
                        &code,
                        &message,
                        CaptionsTransport::Realtime,
                        TerminalOrigin::RealtimeMint,
                    )
                    .await,
                    &message,
                );
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
            session.emit_health(
                crate::protocol::HealthLevel::Info,
                "captions-upload-recovered",
                "Streaming captions reconnected.",
            );
        }
        let connected_at = tokio::time::Instant::now();
        let socket_audio_base_ms = ms_sent;
        let mut provider_ready = false;
        let mut listening_published = false;
        let mut published_listen_epoch = None;
        let mut audio_admissions = RealtimeAudioAdmissions::default();
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
                                let admission = audio_admissions.for_event(&parsed, &items, socket_admission);
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
                                        admission,
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
                        (ms_at_anchor, capture_epoch) = reanchor_realtime_caption_capture(
                            session,
                            &mut items,
                            sequence,
                            timeline,
                            capture_epoch,
                            ms_sent,
                        )
                        .await;
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
                    crate::cohost::note_voice_frame(
                        &session.state,
                        &frame.samples,
                        &mono,
                        std::time::Instant::now(),
                    );
                    if provider_ready
                        && speech_watchdog_since.is_none()
                        && pcm_has_speech_energy(&mono)
                    {
                        speech_watchdog_since = Some(tokio::time::Instant::now());
                    }
                    let input_admission = session.admitted_buddy_audio_for_frame(&frame).await;
                    let frame_seconds = mono.len() as f64 / f64::from(CAPTION_SAMPLE_RATE);
                    audio_admissions.record(frame_seconds * 1000.0, input_admission);
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
                        input_admission.listen_epoch,
                        &mut published_listen_epoch,
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
                            let outcome = handle_terminal_failure(
                                session,
                                &failure.code,
                                &failure.message,
                                CaptionsTransport::Realtime,
                                TerminalOrigin::RealtimeSocket,
                            )
                            .await;
                            report_usage(session, &mut unreported_ms).await;
                            return realtime_terminal_outcome(outcome, &failure.message);
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
                                let outcome = handle_terminal_failure(
                                    session,
                                    &failure.code,
                                    &failure.message,
                                    CaptionsTransport::Realtime,
                                    TerminalOrigin::RealtimeSocket,
                                )
                                .await;
                                report_usage(session, &mut unreported_ms).await;
                                return realtime_terminal_outcome(outcome, &failure.message);
                            }
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback(failure.message.clone());
                        }
                        RealtimeCaptionEvent::AssistantResponse => {
                            let message = "Realtime caption model generated an assistant response; switching to transcription-only fallback.";
                            session.emit_health(
                                crate::protocol::HealthLevel::Warn,
                                "captions-assistant-response-generated",
                                message,
                            );
                            report_usage(session, &mut unreported_ms).await;
                            return RealtimeOutcome::Fallback(message.to_string());
                        }
                        RealtimeCaptionEvent::Ignored => {}
                    }
                    let admission = audio_admissions.for_event(&parsed, &items, socket_admission);
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
                            admission,
                        },
                    )
                    .await;
                    publish_listening_if_ready(
                        session,
                        provider_ready,
                        audio_heartbeat.has_seen_frame(),
                        &mut listening_published,
                        admission.listen_epoch,
                        &mut published_listen_epoch,
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
                        session.emit_health(
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
    session.emit_health(
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
    status.message = Some(format!("Captions reconnecting: {message}"));
    publish_status(session, status).await;
}

async fn caption_session_expects_audio(session: &CaptionSession) -> bool {
    if session.stop.load(Ordering::Acquire) {
        return false;
    }
    let wanted = {
        let coordinator = session.state.captions.lock().await;
        coordinator.desired_enabled || coordinator.listen_wanted
    };
    if !wanted {
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
    handle_terminal_failure(
        session,
        failure.reason_code(),
        failure.message(),
        transport,
        TerminalOrigin::AudioPath,
    )
    .await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalOutcome {
    /// The provider task ends now.
    EndTask,
    /// One intent ended and the other keeps this task: captions keep
    /// presenting after a listen block, or Buddy keeps listening (metered as
    /// listen from the next chunk) after a caption block.
    Continue,
}

/// Where a terminal failure came from: it decides which intent it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalOrigin {
    /// A chunk upload metered with this purpose.
    Upload(crate::videorc_api::CaptionChunkPurpose),
    /// The realtime token route, which checks caption access.
    RealtimeMint,
    /// The realtime socket or its provider: a transport only captions use.
    RealtimeSocket,
    /// The microphone path itself.
    AudioPath,
}

/// Which intent a terminal failure ends (plan 068 D5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalScope {
    Listen,
    Captions,
    Both,
}

/// Pure: listen codes end listening only; a caption allowance or captions
/// switch answer to a caption-metered request, and any realtime transport
/// failure, end captions only; everything else (sign-in, Premium, the account
/// blocklist, server configuration, a lost microphone, and any code a listen
/// chunk got) ends both. The web answers `ai-disabled` for the global switch
/// too: then the first listen chunk after it gets the same code and ends the
/// task.
fn terminal_failure_scope(code: &str, origin: TerminalOrigin) -> TerminalScope {
    use crate::videorc_api::CaptionChunkPurpose;
    if crate::videorc_api::is_listen_block_code(code) {
        return TerminalScope::Listen;
    }
    match origin {
        TerminalOrigin::Upload(CaptionChunkPurpose::Captions) | TerminalOrigin::RealtimeMint
            if crate::videorc_api::is_caption_scoped_code(code) =>
        {
            TerminalScope::Captions
        }
        TerminalOrigin::RealtimeSocket => TerminalScope::Captions,
        _ => TerminalScope::Both,
    }
}

/// A realtime terminal failure: end the task, or keep listening on chunks.
fn realtime_terminal_outcome(outcome: TerminalOutcome, message: &str) -> RealtimeOutcome {
    match outcome {
        TerminalOutcome::EndTask => RealtimeOutcome::Terminal,
        TerminalOutcome::Continue => RealtimeOutcome::Fallback(message.to_string()),
    }
}

/// A terminal provider failure (plan 068 D5). A listen-scoped code ends only
/// Buddy's listen intent: presenting captions continue, a listen-only task
/// ends quietly. A caption-scoped code while Buddy listens ends only
/// presentation: the caption block is published as it always was and the
/// task keeps transcribing for Buddy. Every other terminal failure ends the
/// task, blocks the listen intent when it was wanted, and presents a caption
/// block only while captions present.
async fn handle_terminal_failure(
    session: &CaptionSession,
    code: &str,
    message: &str,
    transport: CaptionsTransport,
    origin: TerminalOrigin,
) -> TerminalOutcome {
    let scope = terminal_failure_scope(code, origin);
    let (listen_wanted, listen_epoch) = {
        let mut coordinator = session.state.captions.lock().await;
        let wanted = coordinator.listen_wanted;
        if scope == TerminalScope::Listen {
            coordinator.listen_wanted = false;
        }
        (wanted, coordinator.listen_epoch)
    };
    let block_listening = || {
        spawn_listening_publish(
            &session.state,
            listen_epoch,
            crate::cohost::CohostListening::blocked(code, message),
        );
    };
    match scope {
        TerminalScope::Listen => {
            if listen_wanted {
                block_listening();
            }
            if session.presenting() {
                tracing::warn!(
                    "Buddy stopped listening ({code}); live captions continue: {message}"
                );
                return TerminalOutcome::Continue;
            }
            remove_tap();
            TerminalOutcome::EndTask
        }
        TerminalScope::Captions if listen_wanted => {
            tracing::warn!("Live captions stopped ({code}); Buddy keeps listening: {message}");
            publish_caption_block_keeping_task(session, code, message, transport).await;
            TerminalOutcome::Continue
        }
        TerminalScope::Captions | TerminalScope::Both => {
            if listen_wanted {
                block_listening();
            }
            if session.presenting() {
                publish_blocked_status(session, code, message, transport).await;
            } else {
                remove_tap();
            }
            TerminalOutcome::EndTask
        }
    }
}

/// Captions stop presenting with their block, while the task and tap stay
/// for Buddy. The flip and the status share the coordinator lock, so a
/// `captions.stop` racing it orders strictly before or after.
async fn publish_caption_block_keeping_task(
    session: &CaptionSession,
    reason_code: &str,
    message: &str,
    transport: CaptionsTransport,
) {
    {
        let mut coordinator = session.state.captions.lock().await;
        if !session.present.swap(false, Ordering::AcqRel) {
            return;
        }
        let mut status = CaptionsStatus::active(
            CaptionsState::Blocked,
            transport,
            &session.session_client_id,
        );
        status.reason_code = Some(reason_code.to_string());
        status.message = Some(message.to_string());
        coordinator.status = Some(status.clone());
        session.state.emit_event("captions.status", status);
    }
    clear_caption_presentation(&session.state, "blocked");
}

async fn publish_listening_if_ready(
    session: &CaptionSession,
    provider_ready: bool,
    audio_seen: bool,
    listening_published: &mut bool,
    admitted_epoch: Option<u64>,
    published_epoch: &mut Option<u64>,
    remaining_seconds: Option<u64>,
) {
    if !provider_ready || !audio_seen {
        return;
    }
    if !*listening_published {
        *listening_published = true;
        let mut status = CaptionsStatus::active(
            CaptionsState::Listening,
            CaptionsTransport::Realtime,
            &session.session_client_id,
        );
        status.provider_ready = true;
        status.remaining_seconds = remaining_seconds;
        publish_status(session, status).await;
    }
    let Some(epoch) = admitted_epoch else { return };
    if *published_epoch == Some(epoch) {
        return;
    }
    *published_epoch = Some(epoch);
    // The realtime allowance is the caption one: Buddy's stays unknown.
    session
        .note_listen_ready(Some(epoch), crate::cohost::CohostListening::on(None))
        .await;
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

// The realtime audio loop owns the decreasing-clock condition. Keep its
// capture reset together so actual input-clock tests exercise the same item,
// sequence and coordinator retirement as the provider task.
async fn reanchor_realtime_caption_capture(
    session: &CaptionSession,
    items: &mut std::collections::HashMap<String, RealtimeCaptionItem>,
    sequence: &CaptionSequence,
    timeline: &mut CaptionTimeline,
    capture_epoch: u64,
    ms_sent: f64,
) -> (f64, u64) {
    // Re-anchor presentation while retaining bounded original item ownership
    // for late clip routing.
    retire_realtime_caption_items(items, capture_epoch, timeline.current_seconds());
    let ms_at_anchor = ms_sent;
    timeline.reset_capture();
    sequence.reset();
    let mut coordinator = session.state.captions.lock().await;
    coordinator.capture_epoch += 1;
    (ms_at_anchor, coordinator.capture_epoch)
}

/// Route one gateway realtime event into caption updates + chunk records.
async fn handle_realtime_event(
    session: &CaptionSession,
    event: RealtimeCaptionEvent,
    items: &mut std::collections::HashMap<String, RealtimeCaptionItem>,
    sequence: &CaptionSequence,
    timeline: RealtimeCaptionTimeline,
) {
    match event {
        RealtimeCaptionEvent::SpeechStarted {
            item_id,
            audio_start_ms,
        } => {
            let coordinator = session.state.captions.lock().await;
            if coordinator.privacy_teardown_in_progress
                || coordinator.privacy_teardown_failed
                || session.stop.load(Ordering::Acquire)
            {
                return;
            }
            if audio_start_ms
                .is_some_and(|start| timeline.socket_audio_base_ms + start < timeline.ms_at_anchor)
            {
                return;
            }
            let offset = timeline.cue_offset_seconds(audio_start_ms);
            let _ = realtime_item_entry(
                items,
                sequence,
                &item_id,
                offset,
                timeline.capture_epoch,
                timeline.admission,
                session.mark_target.clone(),
            );
        }
        RealtimeCaptionEvent::Partial {
            item_id,
            transcript,
        } => {
            let Some(item) = items.get(&item_id) else {
                return;
            };
            let coordinator = session.state.captions.lock().await;
            if coordinator.privacy_teardown_in_progress
                || coordinator.privacy_teardown_failed
                || session.stop.load(Ordering::Acquire)
                || item.capture_epoch != coordinator.capture_epoch
                || !session.presenting()
            {
                return;
            }
            session.state.emit_event(
                "captions.update",
                CaptionsUpdate {
                    session_client_id: session.session_client_id.clone(),
                    seq: item.seq,
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
            let Some(item) = items.get(&item_id).cloned() else {
                return;
            };
            let offset = item.offset_seconds;
            let end = item
                .capture_end_seconds
                .unwrap_or_else(|| timeline.cue_end_seconds(offset));
            let duration_seconds = (end - offset).clamp(0.5, 30.0);
            let update = CaptionsUpdate {
                session_client_id: session.session_client_id.clone(),
                seq: item.seq,
                kind: CaptionUpdateKind::Final,
                text: transcript.clone(),
                chunk_seconds: (end - offset).ceil() as u64,
                remaining_seconds: None,
            };
            let inserted = {
                let mut coordinator = session.state.captions.lock().await;
                if coordinator.privacy_teardown_in_progress
                    || coordinator.privacy_teardown_failed
                    || session.stop.load(Ordering::Acquire)
                {
                    return;
                }
                // Presentation is read under the coordinator lock that
                // `captions.stop` flips it under: a final never lands after
                // the caption boundary that cleared the bar.
                let current_capture = item.capture_epoch == coordinator.capture_epoch;
                let presented = session.presenting() && current_capture;
                let inserted = upsert_caption_record(
                    &mut coordinator.chunks,
                    CaptionChunkRecord {
                        seq: item.seq,
                        offset_seconds: offset,
                        duration_seconds,
                        text: transcript.clone(),
                        segments: Vec::new(),
                        capture_epoch: item.capture_epoch,
                        provider_item_id: Some(item_id.clone()),
                        presented,
                    },
                );
                if presented {
                    session.state.emit_event("captions.update", update.clone());
                }
                let marker_consumed = crate::marker_voice::marker_candidate(&transcript);
                if !item.clip_processed
                    && marker_consumed
                    && marker_audio_owned(
                        session,
                        item.admission,
                        &coordinator,
                        item.mark_target.as_ref(),
                    )
                {
                    let mut outcome = crate::marker_voice::UtteranceOutcome {
                        consumed: true,
                        ..Default::default()
                    };
                    if duration_seconds > 10.0 {
                        outcome.refusal = Some(
                            "The marker command was too long. Please repeat a shorter command."
                                .into(),
                        )
                    } else {
                        match crate::marker_voice::parse_marker(&transcript, offset, &[]) {
                            Ok(Some(marker)) => outcome.markers.push(marker),
                            Err(message) => outcome.refusal = Some(message),
                            _ => {}
                        }
                    }
                    publish_marker_outcome(session, item.mark_target.as_ref(), outcome);
                }
                if !item.clip_processed {
                    items.get_mut(&item_id).unwrap().clip_processed = true;
                    if !marker_consumed {
                        crate::clip_marks::note_transcript_final(
                            &session.state,
                            &transcript,
                            &[],
                            offset,
                            item.mark_target.clone(),
                        );
                    }
                }
                // Buddy's consent check and append stay under the coordinator
                // lock, independently of the recording-owned clip hook.
                if current_capture && !marker_consumed {
                    crate::cohost::note_transcript_final(
                        &session.state,
                        &update,
                        crate::cohost::RecentSpeechFinal {
                            at: std::time::Instant::now(),
                            offset_seconds: offset,
                            duration_seconds,
                            text: transcript,
                            segments: Vec::new(),
                            presented,
                        },
                        item.admission.owns_speech(&coordinator),
                    );
                }
                inserted
            };
            if !inserted {
                tracing::debug!(
                    provider_item_id = %item_id,
                    "Coalesced a repeated realtime caption completion."
                );
            }
        }
        RealtimeCaptionEvent::ConfigurationAcknowledged
        | RealtimeCaptionEvent::Error(_)
        | RealtimeCaptionEvent::AssistantResponse
        | RealtimeCaptionEvent::Ignored => {}
    }
}

fn realtime_item_entry(
    items: &mut std::collections::HashMap<String, RealtimeCaptionItem>,
    sequence: &CaptionSequence,
    item_id: &str,
    offset: f64,
    capture_epoch: u64,
    admission: AdmittedBuddyAudio,
    mark_target: Option<crate::clip_marks::MarkTarget>,
) -> Option<RealtimeCaptionItem> {
    if !items.contains_key(item_id) && items.len() == MAX_REALTIME_CAPTION_ITEMS {
        let completed = items
            .iter()
            .filter(|(_, item)| item.clip_processed)
            .min_by_key(|(_, item)| (item.capture_epoch, item.seq))
            .map(|(id, _)| id.clone());
        match completed {
            Some(id) => {
                items.remove(&id);
            }
            None => {
                tracing::warn!(
                    "Realtime caption item ownership reached its bound; refusing an unknown item."
                );
                return None;
            }
        }
    }
    Some(
        items
            .entry(item_id.to_string())
            .or_insert_with(|| RealtimeCaptionItem {
                seq: sequence.next(),
                offset_seconds: offset,
                capture_epoch,
                capture_end_seconds: None,
                admission,
                mark_target,
                clip_processed: false,
            })
            .clone(),
    )
}

fn retire_realtime_caption_items(
    items: &mut std::collections::HashMap<String, RealtimeCaptionItem>,
    capture_epoch: u64,
    capture_end_seconds: f64,
) {
    for item in items
        .values_mut()
        .filter(|item| item.capture_epoch == capture_epoch)
    {
        item.capture_end_seconds = Some(capture_end_seconds.max(item.offset_seconds + 0.5));
    }
}

#[derive(Debug)]
struct BufferedCaptionChunk {
    samples: Vec<i16>,
    seq: u64,
    offset_seconds: f64,
    duration_seconds: f64,
    capture_epoch: u64,
    admission: AdmittedBuddyAudio,
}

struct CaptionChunkBuffer {
    chunk_samples: usize,
    max_pending: usize,
    pcm: Vec<i16>,
    /// Compressed input ownership, consumed with exactly the same PCM. Merge
    /// speech and readiness independently; mixed owners lose only that field.
    /// Caption presentation and recording ownership remain independent.
    pcm_ownership: std::collections::VecDeque<(usize, AdmittedBuddyAudio)>,
    pending: std::collections::VecDeque<BufferedCaptionChunk>,
}

impl CaptionChunkBuffer {
    fn new(chunk_samples: usize, max_pending: usize) -> Self {
        Self {
            chunk_samples: chunk_samples.max(1),
            max_pending: max_pending.max(1),
            pcm: Vec::with_capacity(chunk_samples.saturating_mul(2)),
            pcm_ownership: std::collections::VecDeque::new(),
            pending: std::collections::VecDeque::new(),
        }
    }

    /// Returns seconds evicted from the bounded queue. In ordinary operation
    /// this is zero: the receiver keeps draining while one HTTP upload waits.
    fn push_samples(
        &mut self,
        samples: Vec<i16>,
        capture_epoch: u64,
        admission: AdmittedBuddyAudio,
        sequence: &CaptionSequence,
        timeline: &mut CaptionTimeline,
    ) -> f64 {
        if !samples.is_empty() {
            if let Some((count, epoch)) = self.pcm_ownership.back_mut()
                && *epoch == admission
            {
                *count += samples.len();
            } else {
                self.pcm_ownership.push_back((samples.len(), admission));
            }
        }
        self.pcm.extend(samples);
        let mut dropped_seconds = 0.0;
        while self.pcm.len() >= self.chunk_samples {
            let chunk = self.pcm.drain(..self.chunk_samples).collect();
            let admission = self.take_ownership(self.chunk_samples);
            dropped_seconds += self.enqueue_back(Self::stamp_chunk(
                chunk,
                capture_epoch,
                admission,
                sequence,
                timeline,
            ));
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
        let admission = self.take_ownership(remainder.len());
        let stamped = Self::stamp_chunk(remainder, capture_epoch, admission, sequence, timeline);
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
            let admission = self.take_ownership(remainder.len());
            Some(Self::stamp_chunk(
                remainder,
                capture_epoch,
                admission,
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
        admission: AdmittedBuddyAudio,
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
            admission,
        }
    }

    fn take_ownership(&mut self, mut count: usize) -> AdmittedBuddyAudio {
        let mut owner = self
            .pcm_ownership
            .front()
            .map(|(_, epoch)| *epoch)
            .unwrap_or_default();
        while count > 0 {
            let Some((available, epoch)) = self.pcm_ownership.front_mut() else {
                return AdmittedBuddyAudio::default();
            };
            owner = owner.merge(*epoch);
            let taken = count.min(*available);
            count -= taken;
            *available -= taken;
            if *available == 0 {
                self.pcm_ownership.pop_front();
            }
        }
        owner
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
        self.pcm_ownership.clear();
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

/// The chunk, the purpose it was metered with, and the service's answer.
type CaptionChunkUploadResult = (
    BufferedCaptionChunk,
    crate::videorc_api::CaptionChunkPurpose,
    std::result::Result<CaptionChunkResponse, CaptionChunkFailure>,
);
type CaptionChunkUploadFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = CaptionChunkUploadResult> + Send>>;

/// Buddy's listening state as one chunked task reports it: `on` once the task
/// is ready (a successful upload, or a silent chunk skipped after the tap
/// delivered frames), then the listen allowance from listen-metered answers,
/// published at most once per `LISTEN_REMAINING_REFRESH`. Pure.
#[derive(Debug, Default)]
struct ListenReadiness {
    ready: bool,
    last_remaining_at: Option<std::time::Instant>,
    epoch: Option<u64>,
}

/// How often the listen allowance may change Buddy's published state.
const LISTEN_REMAINING_REFRESH: std::time::Duration = std::time::Duration::from_secs(30);

impl ListenReadiness {
    fn select_epoch(&mut self, epoch: Option<u64>) {
        if self.epoch != epoch {
            *self = Self {
                epoch,
                ..Self::default()
            };
        }
    }
    /// A silent chunk was skipped. Ready only once the tap has delivered
    /// frames, so a dead microphone path never reads as listening. `Some` is
    /// the state to report.
    fn silent_chunk_skipped(
        &mut self,
        frames_seen: bool,
    ) -> Option<crate::cohost::CohostListening> {
        if self.ready || !frames_seen {
            return None;
        }
        self.ready = true;
        Some(crate::cohost::CohostListening::on(None))
    }

    /// An upload succeeded. `listen_remaining` is the allowance when the chunk
    /// was metered as listen (a captions answer carries the caption one).
    fn upload_succeeded(
        &mut self,
        listen_remaining: Option<u64>,
        now: std::time::Instant,
    ) -> Option<crate::cohost::CohostListening> {
        let first = !self.ready;
        self.ready = true;
        let Some(remaining) = listen_remaining else {
            return first.then(|| crate::cohost::CohostListening::on(None));
        };
        let due = self
            .last_remaining_at
            .is_none_or(|last| now.saturating_duration_since(last) >= LISTEN_REMAINING_REFRESH);
        if !first && !due {
            return None;
        }
        self.last_remaining_at = Some(now);
        Some(crate::cohost::CohostListening::on(Some(remaining)))
    }
}

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
    // Captions win while they present: one upload, one charge (plan 068 D5).
    let purpose = session.chunk_purpose();
    let wav = encode_wav_16k_mono(&chunk.samples);
    Box::pin(async move {
        let result = client
            .transcribe_caption_chunk(
                &bearer,
                &session_client_id,
                wav,
                language.as_deref(),
                purpose,
            )
            .await;
        (chunk, purpose, result)
    })
}

/// Keep one chunk's transcript and hand it to captions (while they present)
/// and to Buddy. Presentation is read under the coordinator lock, the lock
/// `captions.stop` flips it under, and the update is emitted there: a caption
/// turned off while its upload was in flight never shows after the clear.
async fn commit_chunk_transcript(
    session: &CaptionSession,
    chunk: &BufferedCaptionChunk,
    caption_metered: bool,
    response: &CaptionChunkResponse,
) {
    let text = response.text.trim();
    if text.is_empty() {
        // An empty successful final still owns its audio. It can include the
        // quiet tail of a marker turn; skipping it invents a gap at the next
        // chunk and loses a complete command. No caption/clip/chat is emitted.
        let coordinator = session.state.captions.lock().await;
        note_chunk_marker(session, chunk, "", &[], &coordinator);
        return;
    }
    let update = CaptionsUpdate {
        session_client_id: session.session_client_id.clone(),
        seq: chunk.seq,
        kind: CaptionUpdateKind::Final,
        text: text.to_string(),
        chunk_seconds: response.chunk_seconds,
        remaining_seconds: caption_metered.then_some(response.remaining_seconds),
    };
    {
        let mut coordinator = session.state.captions.lock().await;
        if coordinator.privacy_teardown_in_progress
            || coordinator.privacy_teardown_failed
            || session.stop.load(Ordering::Acquire)
        {
            return;
        }
        let current_epoch = coordinator.capture_epoch;
        let presented = session.presenting() && chunk.capture_epoch == current_epoch;
        let first_final = upsert_caption_record(
            &mut coordinator.chunks,
            CaptionChunkRecord {
                seq: chunk.seq,
                offset_seconds: chunk.offset_seconds,
                duration_seconds: chunk.duration_seconds,
                text: text.to_string(),
                segments: response.segments.clone(),
                capture_epoch: chunk.capture_epoch,
                provider_item_id: None,
                presented,
            },
        );
        if presented {
            session.state.emit_event("captions.update", update.clone());
        }
        // Recording ownership is independent of current caption presentation
        // and Buddy consent. An old admitted chunk still marks its own file.
        let marker_consumed = first_final
            && note_chunk_marker(session, chunk, text, &response.segments, &coordinator);
        if first_final && !marker_consumed {
            crate::clip_marks::note_transcript_final(
                &session.state,
                text,
                &response.segments,
                chunk.offset_seconds,
                session.mark_target.clone(),
            );
        }
        if chunk.capture_epoch != current_epoch {
            tracing::info!(
                "Suppressed a caption update from a previous recording (epoch {} < {}).",
                chunk.capture_epoch,
                current_epoch,
            );
            return;
        }
        if marker_consumed {
            return;
        }
        // Same tap as the realtime final (plan 068 S3).
        crate::cohost::note_transcript_final(
            &session.state,
            &update,
            crate::cohost::RecentSpeechFinal {
                at: std::time::Instant::now(),
                offset_seconds: chunk.offset_seconds,
                duration_seconds: chunk.duration_seconds,
                text: text.to_string(),
                segments: response.segments.clone(),
                presented,
            },
            chunk.admission.owns_speech(&coordinator),
        );
    }
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
    let mut listen_readiness = ListenReadiness::default();
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

        while in_flight.is_none() && tokio::time::Instant::now() >= next_upload_allowed_at {
            let Some(chunk) = buffer.pop_front() else {
                break;
            };
            listen_readiness.select_epoch(chunk.admission.listen_epoch);
            // Silence is never uploaded or metered (plan 068 D4). The chunk
            // was stamped before this point, so the timeline stays exact.
            if !chunk_has_speech(&chunk.samples) {
                {
                    let coordinator = session.state.captions.lock().await;
                    note_chunk_marker(session, &chunk, "", &[], &coordinator);
                }
                tracing::trace!(seq = chunk.seq, "Skipped a silent transcription chunk.");
                // Quiet is not "still starting": a skipped chunk after real
                // frames proves the path, so Buddy reads as listening.
                if let Some(listening) =
                    listen_readiness.silent_chunk_skipped(audio_heartbeat.has_seen_frame())
                {
                    session
                        .note_listen_ready(chunk.admission.listen_epoch, listening)
                        .await;
                }
                continue;
            }
            if receiver_open
                && !session.presenting()
                && (chunk.admission.listen_epoch.is_none()
                    || chunk.admission.listen_epoch != session.admitted_listen_epoch().await)
            {
                continue;
            }
            in_flight = Some(begin_caption_chunk_upload(session, chunk));
        }
        if !receiver_open && in_flight.is_none() && buffer.is_empty() {
            let coordinator = session.state.captions.lock().await;
            let admission = AdmittedBuddyAudio {
                marker_epoch: *session
                    .marker_buffer_epoch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()),
                ..Default::default()
            };
            // The buffer only contains callbacks admitted under this exact marker epoch.
            // Consent retirement must discard it rather than granting old words a fresh owner.
            if marker_audio_owned(
                session,
                admission,
                &coordinator,
                session.mark_target.as_ref(),
            ) {
                let outcome = session
                    .marker_utterance
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finish_at_capture_end();
                publish_marker_outcome(session, session.mark_target.as_ref(), outcome);
            }
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
                    session.marker_utterance.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    timeline.reset_capture();
                    sequence.reset();
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
                crate::cohost::note_voice_frame(
                    &session.state,
                    &frame.samples,
                    &mono,
                    std::time::Instant::now(),
                );
                let dropped_seconds = buffer.push_samples(
                    mono,
                    capture_epoch,
                    session.admitted_buddy_audio_for_frame(&frame).await,
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
            (chunk, purpose, result) = await_caption_chunk_upload(&mut in_flight) => {
                in_flight = None;
                let caption_metered = purpose == crate::videorc_api::CaptionChunkPurpose::Captions;
                match result {
                    Ok(response) => {
                        let recovered = degraded_reason.take().is_some();
                        if recovered {
                            session.emit_health(
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
                            // A listen-metered answer carries Buddy's allowance,
                            // never the caption one.
                            status.remaining_seconds =
                                caption_metered.then_some(response.remaining_seconds);
                            publish_status(session, status).await;
                        }
                        listen_readiness.select_epoch(chunk.admission.listen_epoch);
                        let listen_remaining =
                            (!caption_metered).then_some(response.remaining_seconds);
                        if let Some(listening) = listen_readiness
                            .upload_succeeded(listen_remaining, std::time::Instant::now())
                        {
                            session.note_listen_ready(chunk.admission.listen_epoch, listening).await;
                        }
                        backoff = None;
                        next_upload_allowed_at = tokio::time::Instant::now();
                        commit_chunk_transcript(session, &chunk, caption_metered, &response).await;
                    }
                    Err(CaptionChunkFailure::Terminal { code, message }) => {
                        tracing::warn!("Live transcription stopped ({code}): {message}");
                        match handle_terminal_failure(
                            session,
                            &code,
                            &message,
                            CaptionsTransport::Chunked,
                            TerminalOrigin::Upload(purpose),
                        )
                        .await
                        {
                            TerminalOutcome::EndTask => return false,
                            TerminalOutcome::Continue => {
                                // The intent that continues sends the chunk
                                // again, metered as itself: nothing is lost.
                                let dropped_seconds = buffer.requeue_front(chunk);
                                if dropped_seconds > 0.0 {
                                    surface_chunked_audio_drop(
                                        session,
                                        dropped_seconds,
                                        0,
                                        provider_confirmed,
                                    )
                                    .await;
                                }
                                backoff = None;
                                next_upload_allowed_at = tokio::time::Instant::now();
                            }
                        }
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
                            session.marker_utterance.lock().unwrap_or_else(|e| e.into_inner()).cancel();
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
                            session.emit_health(
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
                            status.message = Some(format!("Captions retrying: {message}"));
                            publish_status(session, status).await;
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
    if session
        .marker_utterance
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cancel()
    {
        session.state.emit_event("session.marker.voice.refused", serde_json::json!({"message":"Some audio was missed. Please repeat the complete marker command."}));
    }
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
    session.emit_health(
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
    publish_status(session, status).await;
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
        test_caption_app_state_with_database(crate::storage::Database::open_in_memory_for_tests())
    }

    fn test_caption_app_state_with_database(database: crate::storage::Database) -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new("test-token".to_string(), 0, events, database)
    }

    #[cfg(debug_assertions)]
    async fn start_caption_contract_listen_grant(state: &AppState) -> Result<()> {
        state
            .live_chat
            .lock()
            .await
            .start_session("caption-contract-grant".into(), Vec::new());
        crate::cohost::set_cohost_settings(
            state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..Default::default()
            },
        )
        .await?;
        crate::cohost::start_cohost(
            state,
            crate::protocol::CohostStartParams {
                session_id: "caption-contract-grant".into(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await?;
        Ok(())
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_fresh_audio_owns_the_first_listen_chunk() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut session = test_caption_session(&state, false);
        let outcome: Result<_> = async {
            start_caption_contract_listen_grant(&state).await?;
            let expected = session.admitted_buddy_audio().await;
            let mut receiver = {
                let _control = CAPTION_CONTROL.lock().await;
                install_tap()
            };
            // Same real producer as the gated RPC, with no env mutation or
            // second injection to skip its first chunk. The capacity holds
            // all 150 frames, so no separate consumer can alter the clock.
            let producer_started_at = std::time::Instant::now();
            let accepted = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                produce_caption_contract_test_audio(3_000),
            )
            .await??;
            let producer_elapsed = producer_started_at.elapsed();
            let grant_times = {
                let coordinator = state.captions.lock().await;
                (coordinator.speech_started_at, coordinator.listen_started_at)
            };
            let sequence = CaptionSequence::default();
            let mut timeline = CaptionTimeline::new(0.0);
            let mut buffer = CaptionChunkBuffer::new(
                (f64::from(CAPTION_SAMPLE_RATE) * CAPTION_CHUNK_SECONDS) as usize,
                MAX_BUFFERED_CAPTION_CHUNKS,
            );
            let mut admissions = Vec::new();
            let mut capture_times = Vec::new();
            for _ in 0..accepted {
                let frame =
                    tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                        .await?
                        .ok_or_else(|| {
                            anyhow::anyhow!("Owned caption tap closed before its frames drained.")
                        })?;
                let admission = session.admitted_buddy_audio_for_frame(&frame).await;
                capture_times.push((frame.captured_at, frame.duration(), frame.timestamp_micros));
                admissions.push(admission);
                buffer.push_samples(
                    downmix_resample_to_16k_mono(&frame.samples, frame.channels, frame.sample_rate),
                    0,
                    admission,
                    &sequence,
                    &mut timeline,
                );
            }
            session.receiver = receiver;
            Ok((
                accepted,
                expected,
                grant_times,
                producer_started_at,
                producer_elapsed,
                admissions,
                capture_times,
                buffer.drain_pending(),
            ))
        }
        .await;
        // End the exact owned bus and cohost before any failing assertion.
        remove_tap();
        crate::cohost::stop_cohost(&state).await;
        let (
            accepted,
            expected,
            grant_times,
            producer_started_at,
            producer_elapsed,
            admissions,
            capture_times,
            chunks,
        ) = outcome
            .expect("actual contract producer and tap should complete within their deadlines");
        assert_eq!(accepted, 150);
        assert_eq!(TAP_FRAMES_DROPPED.load(Ordering::Relaxed), 0);
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        assert!(expected.speech_epoch.is_some() && expected.listen_epoch.is_some());
        let (speech_grant, listen_grant) = (grant_times.0.unwrap(), grant_times.1.unwrap());
        assert!(capture_times[0].0 >= speech_grant && capture_times[0].0 >= listen_grant);
        assert!(
            capture_times
                .iter()
                .all(|(end, _, _)| *end <= std::time::Instant::now())
        );
        assert!(
            producer_elapsed >= std::time::Duration::from_millis(3_000),
            "The entire sample clock must run, not just the first 20ms followed by a PCM burst."
        );
        for (index, (end, duration, timestamp_micros)) in capture_times.iter().enumerate() {
            assert_eq!(*duration, std::time::Duration::from_millis(20));
            assert_eq!(*timestamp_micros, index as u64 * 20_000);
            assert!(
                *end >= producer_started_at
                    + std::time::Duration::from_millis((index as u64 + 1) * 20),
                "Each actual completed buffer must follow its own sample-duration deadline."
            );
        }
        assert!(admissions.iter().all(|admission| *admission == expected));
        assert_eq!(chunks.len(), 1);
        assert!(chunk_has_speech(&chunks[0].samples));
        assert_eq!(
            session.chunk_purpose(),
            crate::videorc_api::CaptionChunkPurpose::Listen
        );
        assert_eq!(
            (admissions[0], chunks[0].admission),
            (expected, expected),
            "The first fixture buffer and sole 3s speech chunk must own the real grant: first end {}us after grant, buffer duration {}us. Listen-only skips an unowned chunk before upload.",
            capture_times[0]
                .0
                .duration_since(speech_grant.max(listen_grant))
                .as_micros(),
            capture_times[0].1.as_micros(),
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_concurrent_batches_keep_ordered_samples_and_acks() {
        use std::future::{Future, poll_fn};
        use std::task::Poll;

        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let outcome: Result<_> = async {
            let mut receiver = {
                let _control = CAPTION_CONTROL.lock().await;
                install_tap()
            };
            let serial_guard = CAPTION_CONTRACT_AUDIO_SERIAL.lock().await;
            let mut first = Box::pin(produce_caption_contract_test_audio(200));
            let mut second = Box::pin(produce_caption_contract_test_audio(200));
            // Poll the actual producer bodies to their first await: each has
            // captured this installed sender before waiting on serialization.
            let pending = poll_fn(|context| {
                Poll::Ready((
                    first.as_mut().poll(context).is_pending(),
                    second.as_mut().poll(context).is_pending(),
                ))
            })
            .await;
            if pending != (true, true) {
                bail!("Actual concurrent producers did not wait at their owned serialization boundary.");
            }
            let released_at = std::time::Instant::now();
            drop(serial_guard);
            let (first_ack, second_ack) = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                async { tokio::join!(first.as_mut(), second.as_mut()) },
            )
            .await?;
            let acks = (first_ack?, second_ack?);
            let mut frames = Vec::new();
            for _ in 0..20 {
                frames.push(
                    tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                        .await?
                        .ok_or_else(|| anyhow::anyhow!("Owned concurrent fixture receiver ended early."))?,
                );
            }
            Ok((pending, acks, released_at, frames))
        }
        .await;
        // The owned futures have completed or been dropped on error. No
        // detached producer can keep a guard or send after this exact removal.
        remove_tap();
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        let (pending, acks, released_at, frames) = outcome
            .expect("actual concurrent fixture producers must complete within their deadlines");
        assert_eq!(pending, (true, true));
        assert_eq!(
            acks,
            (10, 10),
            "Each serialized ACK owns only its ten frames."
        );
        assert_eq!(TAP_FRAMES_DROPPED.load(Ordering::Relaxed), 0);
        let now = std::time::Instant::now();
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.timestamp_micros, index as u64 * 20_000);
            assert_eq!(frame.duration(), std::time::Duration::from_millis(20));
            assert!(
                frame.captured_at
                    >= released_at + std::time::Duration::from_millis((index as u64 + 1) * 20)
            );
            assert!(frame.captured_at <= now);
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_reinstalled_tap_refuses_active_and_queued_old_writers() {
        use std::future::{Future, poll_fn};
        use std::task::Poll;

        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let outcome: Result<_> = async {
            let mut receiver = {
                let _control = CAPTION_CONTROL.lock().await;
                install_tap()
            };
            let mut active = Box::pin(produce_caption_contract_test_audio(200));
            let first_frame = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                tokio::select! {
                    frame = receiver.recv() => frame.ok_or_else(|| {
                        anyhow::anyhow!("Owned active fixture receiver ended before readiness.")
                    }),
                    result = active.as_mut() => {
                        result?;
                        bail!("Actual active producer ended before its first-frame readiness.");
                    }
                }
            })
            .await??;
            let mut queued = Box::pin(produce_caption_contract_test_audio(200));
            let queued_pending =
                poll_fn(|context| Poll::Ready(queued.as_mut().poll(context).is_pending())).await;
            if !queued_pending {
                bail!("Actual queued producer did not wait behind the active owner's guard.");
            }
            let mut replacement = {
                let _control = CAPTION_CONTROL.lock().await;
                remove_tap();
                install_tap()
            };
            let (active_result, queued_result) =
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    tokio::join!(active.as_mut(), queued.as_mut())
                })
                .await?;
            let retired = |result: Result<u64>| {
                result.is_err_and(|error| {
                    error.to_string() == "Caption contract audio tap was retired during injection."
                })
            };
            let refused = (retired(active_result), retired(queued_result));
            let replacement_empty = matches!(
                replacement.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            );
            let fresh_ack = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                produce_caption_contract_test_audio(20),
            )
            .await??;
            let fresh_frame =
                tokio::time::timeout(std::time::Duration::from_secs(1), replacement.recv())
                    .await?
                    .ok_or_else(|| {
                        anyhow::anyhow!("Replacement fixture tap did not receive its own frame.")
                    })?;
            Ok((
                first_frame,
                queued_pending,
                refused,
                replacement_empty,
                fresh_ack,
                fresh_frame,
            ))
        }
        .await;
        remove_tap();
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        let (first_frame, queued_pending, refused, replacement_empty, fresh_ack, fresh_frame) =
            outcome.expect(
                "active, queued and replacement producers must finish with bounded owned cleanup",
            );
        assert_eq!(first_frame.timestamp_micros, 0);
        assert!(queued_pending);
        assert_eq!(refused, (true, true));
        assert!(
            replacement_empty,
            "No retired producer may send into the new tap."
        );
        assert_eq!(fresh_ack, 1);
        assert_eq!(
            fresh_frame.timestamp_micros, 0,
            "The replacement owns a fresh sample clock."
        );
        assert_eq!(TAP_FRAMES_SEEN.load(Ordering::Relaxed), 1);
        assert_eq!(TAP_FRAMES_DROPPED.load(Ordering::Relaxed), 0);
    }

    #[cfg(debug_assertions)]
    struct RepeatedCaptionFixtureOutcome {
        timestamps: Vec<Vec<u64>>,
        same_capture_epoch: bool,
        held_cue_presented: bool,
        held_final_emitted: bool,
        held_buddy_final: bool,
        before_control: bool,
        after_control: bool,
        backwards_clock_retired: bool,
    }

    #[cfg(debug_assertions)]
    async fn repeated_caption_fixture_outcome() -> RepeatedCaptionFixtureOutcome {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut session = test_caption_session(&state, true);
        let outcome: Result<_> = async {
            start_caption_contract_listen_grant(&state).await?;
            session.receiver = {
                let _control = CAPTION_CONTROL.lock().await;
                install_tap()
            };
            let sequence = CaptionSequence::default();
            let mut timeline = CaptionTimeline::new(0.0);
            let mut items = std::collections::HashMap::new();
            let mut last_frame_timestamp = None;
            let mut ms_sent = 0.0;
            let mut ms_at_anchor = 0.0;
            let initial_epoch = state.captions.lock().await.capture_epoch;
            let mut capture_epoch = initial_epoch;
            let mut timestamps = Vec::new();
            let mut admission = AdmittedBuddyAudio::default();
            let mut events = state.events.subscribe();
            for batch in 0..2 {
                // Same actual paced producer and same installed tap as the
                // debug RPC. No env mutation, clock substitution or sleep.
                let accepted = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    produce_caption_contract_test_audio(200),
                )
                .await??;
                let mut batch_timestamps = Vec::new();
                for _ in 0..accepted {
                    let frame = tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        session.receiver.recv(),
                    )
                    .await?
                    .ok_or_else(|| {
                        anyhow::anyhow!("Owned caption tap closed before its batch drained.")
                    })?;
                    // Exercise the production decreasing-clock predicate and
                    // actual reset owner on the producer's real input frames.
                    if caption_anchor_should_reset(last_frame_timestamp, frame.timestamp_micros) {
                        (ms_at_anchor, capture_epoch) = reanchor_realtime_caption_capture(
                            &session,
                            &mut items,
                            &sequence,
                            &mut timeline,
                            capture_epoch,
                            ms_sent,
                        )
                        .await;
                    }
                    last_frame_timestamp = Some(frame.timestamp_micros);
                    batch_timestamps.push(frame.timestamp_micros);
                    admission = session.admitted_buddy_audio_for_frame(&frame).await;
                    let mono = downmix_resample_to_16k_mono(
                        &frame.samples,
                        frame.channels,
                        frame.sample_rate,
                    );
                    let seconds = mono.len() as f64 / f64::from(CAPTION_SAMPLE_RATE);
                    ms_sent += seconds * 1000.0;
                    timeline.advance_seconds(seconds);
                }
                timestamps.push(batch_timestamps);
                let current = RealtimeCaptionTimeline {
                    capture_base_seconds: timeline.capture_base_seconds,
                    ms_at_anchor,
                    socket_audio_base_ms: 0.0,
                    ms_sent,
                    capture_epoch,
                    admission,
                };
                if batch == 0 {
                    for (item_id, transcript, complete) in [
                        ("before-control", "fixture before batch", true),
                        ("held", "fixture retained utterance", false),
                    ] {
                        handle_realtime_event(
                            &session,
                            GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                                "type": "speech-started",
                                "itemId": item_id,
                                "raw": { "audio_start_ms": ms_sent - 20.0, "item_id": item_id }
                            })),
                            &mut items,
                            &sequence,
                            current,
                        )
                        .await;
                        if complete {
                            handle_realtime_event(
                                &session,
                                GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                                    "type": "input-transcription-completed",
                                    "itemId": item_id,
                                    "transcript": transcript
                                })),
                                &mut items,
                                &sequence,
                                current,
                            )
                            .await;
                        }
                    }
                } else {
                    handle_realtime_event(
                        &session,
                        GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                            "type": "input-transcription-completed",
                            "itemId": "held",
                            "transcript": "fixture retained utterance"
                        })),
                        &mut items,
                        &sequence,
                        current,
                    )
                    .await;
                    handle_realtime_event(
                        &session,
                        GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                            "type": "speech-started",
                            "itemId": "after-control",
                            "raw": { "audio_start_ms": ms_sent - 20.0, "item_id": "after-control" }
                        })),
                        &mut items,
                        &sequence,
                        current,
                    )
                    .await;
                    handle_realtime_event(
                        &session,
                        GatewayRealtimeCaptionTransport::parse(&serde_json::json!({
                            "type": "input-transcription-completed",
                            "itemId": "after-control",
                            "transcript": "fixture after batch"
                        })),
                        &mut items,
                        &sequence,
                        current,
                    )
                    .await;
                }
            }
            let emitted = drain_events(&mut events);
            let exact_ui = |text: &str| {
                emitted.iter().any(|event| {
                    event.event == "captions.update"
                        && event.payload["kind"] == "final"
                        && event.payload["text"] == text
                        && event.payload["sessionClientId"] == session.session_client_id
                })
            };
            let speech = crate::cohost::recent_speech_since(&state, None)
                .ok_or_else(|| anyhow::anyhow!("Owned Buddy speech snapshot was unavailable."))?;
            let exact_buddy = |text: &str| speech.finals.iter().any(|item| item.text == text);
            let held_cue_presented = state.captions.lock().await.chunks.iter().any(|cue| {
                cue.text == "fixture retained utterance"
                    && cue.capture_epoch == initial_epoch
                    && cue.presented
            });
            let mut result = RepeatedCaptionFixtureOutcome {
                timestamps,
                same_capture_epoch: initial_epoch == capture_epoch,
                held_cue_presented,
                held_final_emitted: exact_ui("fixture retained utterance"),
                held_buddy_final: exact_buddy("fixture retained utterance"),
                before_control: exact_ui("fixture before batch")
                    && exact_buddy("fixture before batch"),
                after_control: exact_ui("fixture after batch")
                    && exact_buddy("fixture after batch"),
                backwards_clock_retired: false,
            };
            // Genuine source-clock regression still retires presentation and
            // Buddy. This control uses the same predicate/reset/callback owner,
            // independent of the debug producer's intended continuity.
            let current = RealtimeCaptionTimeline {
                capture_base_seconds: timeline.capture_base_seconds,
                ms_at_anchor,
                socket_audio_base_ms: 0.0,
                ms_sent,
                capture_epoch,
                admission,
            };
            handle_realtime_event(
                &session,
                RealtimeCaptionEvent::SpeechStarted {
                    item_id: "genuine-retired".into(),
                    audio_start_ms: Some(ms_sent - 20.0),
                },
                &mut items,
                &sequence,
                current,
            )
            .await;
            let backwards_timestamp = last_frame_timestamp
                .ok_or_else(|| anyhow::anyhow!("Owned fixture batch contained no audio frames."))?
                .saturating_sub(1);
            if caption_anchor_should_reset(last_frame_timestamp, backwards_timestamp) {
                (ms_at_anchor, capture_epoch) = reanchor_realtime_caption_capture(
                    &session,
                    &mut items,
                    &sequence,
                    &mut timeline,
                    capture_epoch,
                    ms_sent,
                )
                .await;
            }
            handle_realtime_event(
                &session,
                RealtimeCaptionEvent::Completed {
                    item_id: "genuine-retired".into(),
                    transcript: "genuine retired utterance".into(),
                },
                &mut items,
                &sequence,
                RealtimeCaptionTimeline {
                    ms_at_anchor,
                    capture_epoch,
                    ..current
                },
            )
            .await;
            let emitted = drain_events(&mut events);
            let speech = crate::cohost::recent_speech_since(&state, None)
                .ok_or_else(|| anyhow::anyhow!("Owned Buddy speech snapshot was unavailable."))?;
            result.backwards_clock_retired = capture_epoch > current.capture_epoch
                && !emitted.iter().any(|event| event.event == "captions.update")
                && !speech
                    .finals
                    .iter()
                    .any(|item| item.text == "genuine retired utterance")
                && state.captions.lock().await.chunks.iter().any(|cue| {
                    cue.text == "genuine retired utterance"
                        && !cue.presented
                        && cue.capture_epoch == current.capture_epoch
                });
            Ok(result)
        }
        .await;
        // Retire the exact global tap and cohost scheduler before reporting
        // any failure. There is no detached producer or provider task here.
        remove_tap();
        tokio::time::timeout(
            std::time::Duration::from_secs(6),
            crate::cohost::stop_cohost(&state),
        )
        .await
        .expect("owned cohost cleanup must complete");
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        outcome.expect("actual fixture batches and callbacks must finish within their deadlines")
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_repeated_batches_keep_one_sample_clock() {
        let result = repeated_caption_fixture_outcome().await;
        assert!(result.before_control && result.after_control && result.backwards_clock_retired);
        assert_eq!(
            result.timestamps.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![10, 10]
        );
        assert!(
            result.timestamps[1][0] > *result.timestamps[0].last().unwrap(),
            "The same installed debug tap must not restart its timestamp clock at each RPC."
        );
        assert!(result.same_capture_epoch);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_repeated_batch_preserves_exact_final_event() {
        let result = repeated_caption_fixture_outcome().await;
        assert!(result.before_control && result.after_control && result.backwards_clock_retired);
        assert!(
            result.held_cue_presented && result.held_final_emitted,
            "A final held across another batch on this same tap must remain presented and emit its exact final event."
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_repeated_batch_preserves_exact_buddy_final() {
        let result = repeated_caption_fixture_outcome().await;
        assert!(result.before_control && result.after_control && result.backwards_clock_retired);
        assert!(
            result.held_buddy_final,
            "The consenting same-session Buddy owner must receive the exact final held across another fixture batch."
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn caption_contract_fixture_keeps_pregrant_and_crossing_audio_unowned() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let session = test_caption_session(&state, false);
        let old = AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 2,
            samples: vec![0.1; 1_920],
        };
        let outcome: Result<_> = async {
            let mut receiver = {
                let _control = CAPTION_CONTROL.lock().await;
                install_tap()
            };
            offer_caption_frame(&old);
            start_caption_contract_listen_grant(&state).await?;
            let first_grant = {
                let coordinator = state.captions.lock().await;
                coordinator
                    .speech_started_at
                    .unwrap()
                    .min(coordinator.listen_started_at.unwrap())
            };
            // This known past buffer ends at most 10ms after the first grant.
            // Its 20ms PCM crosses that boundary; no future wall-clock stamp.
            let crossing = AudioFrame {
                captured_at: first_grant
                    + first_grant
                        .elapsed()
                        .min(std::time::Duration::from_millis(10)),
                ..old.clone()
            };
            offer_caption_frame(&crossing);
            let mut admissions = Vec::new();
            for _ in 0..2 {
                let frame =
                    tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                        .await?
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "Owned caption tap closed before control frames drained."
                            )
                        })?;
                admissions.push(session.admitted_buddy_audio_for_frame(&frame).await);
            }
            Ok(admissions)
        }
        .await;
        remove_tap();
        crate::cohost::stop_cohost(&state).await;
        assert_eq!(
            outcome.expect("actual old/crossing control frames should reach the installed tap"),
            vec![AdmittedBuddyAudio::default(); 2],
        );
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn service_pause_retires_marker_admission_and_publishes_the_blocked_reason() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.marker_session_id = Some("capture-a".into());
            coordinator.marker_epoch = 7;
            coordinator.marker_started_at = Some(std::time::Instant::now());
        }
        pause_marker_voice_for_service_flags(&state).await;
        let coordinator = state.captions.lock().await;
        assert!(coordinator.marker_started_at.is_none());
        assert_eq!(coordinator.marker_epoch, 8);
        assert_eq!(
            coordinator
                .marker_listening
                .as_ref()
                .unwrap()
                .reason_code
                .as_deref(),
            Some("voice-disabled")
        );
        assert!(
            !AdmittedBuddyAudio {
                marker_epoch: Some(7),
                ..Default::default()
            }
            .owns_marker(&coordinator, Some("capture-a"))
        );
        assert!(
            drain_events(&mut events)
                .iter()
                .any(|event| event.event == "session.marker.voice.status"
                    && event.payload["listening"]["reasonCode"] == "voice-disabled")
        );
    }

    #[tokio::test]
    async fn no_microphone_refuses_new_captions_but_preserves_an_authorized_task() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("none-input"));
        let error =
            start_captions_with_bearer(&state, Some("en".into()), || Some("test-bearer".into()))
                .await
                .expect_err("an active silence bus is not microphone eligibility");
        assert!(error.to_string().contains("Select an available microphone"));
        assert!(state.captions.lock().await.task.is_none());
        let _runtime = install_caption_sign_out_test_session(&state).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        let status =
            start_captions_with_bearer(&state, Some("en".into()), || Some("test-bearer".into()))
                .await
                .expect("an authorized caption timeline survives missing input");
        assert_eq!(status.state, CaptionsState::Listening);
        assert_eq!(
            state.captions.lock().await.task.as_ref().unwrap().id(),
            task_id
        );
        assert!(caption_sign_out_test_snapshot(&state).await.tap_active);
        stop_captions(&state).await;
    }

    #[tokio::test]
    async fn queued_caption_start_error_cannot_block_a_replacement_session() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "finished-session",
        ));
        let start_intent_generation = reserve_caption_session_start(&state)
            .await
            .expect("caption start intent");

        let caption_control = CAPTION_CONTROL.lock().await;
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let queued_state = state.clone();
        let queued_start = tokio::spawn(async move {
            queued_tx.send(()).expect("caption start queue signal");
            start_captions_with_bearer_for_session(
                &queued_state,
                Some(("finished-session", start_intent_generation)),
                Some("en".to_string()),
                || None,
            )
            .await
        });
        queued_rx
            .await
            .expect("caption start reached control queue");
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "replacement-session",
        ));
        drop(caption_control);

        let status = queued_start
            .await
            .expect("queued caption start task")
            .expect("a stale generation is a quiet no-op");

        assert!(status.is_none());
        let coordinator = state.captions.lock().await;
        assert!(!coordinator.desired_enabled);
        assert!(coordinator.task.is_none());
        assert!(coordinator.stop.is_none());
    }

    #[tokio::test]
    async fn exact_session_caption_start_error_commits_blocked_before_replacement() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "caption-start-failure",
        ));
        let start_intent_generation = reserve_caption_session_start(&state)
            .await
            .expect("caption start intent");

        let error = start_captions_with_bearer_for_session(
            &state,
            Some(("caption-start-failure", start_intent_generation)),
            Some("en".to_string()),
            || None,
        )
        .await
        .expect_err("missing credentials must reject captions");

        assert_eq!(error.to_string(), "Sign in to use live captions.");
        let coordinator = state.captions.lock().await;
        let status = coordinator.status.as_ref().expect("blocked caption status");
        assert_eq!(status.state, CaptionsState::Blocked);
        assert_eq!(status.reason_code.as_deref(), Some("captions-start-failed"));
        assert!(
            status
                .message
                .as_deref()
                .is_some_and(|message| message.contains("Sign in to use live captions"))
        );
    }

    #[tokio::test]
    async fn explicit_caption_stop_invalidates_queued_session_auto_start() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "caption-stop-wins",
        ));
        let start_intent_generation = reserve_caption_session_start(&state)
            .await
            .expect("caption start intent");

        let held_control = CAPTION_CONTROL.lock().await;
        let (stop_queued_tx, stop_queued_rx) = tokio::sync::oneshot::channel();
        let stop_state = state.clone();
        let stop = tokio::spawn(async move {
            stop_queued_tx.send(()).expect("caption stop queue signal");
            stop_captions(&stop_state).await
        });
        stop_queued_rx.await.expect("caption stop reached queue");
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_captions_with_bearer_for_session(
                &start_state,
                Some(("caption-stop-wins", start_intent_generation)),
                Some("en".to_string()),
                || Some("must-not-be-used".to_string()),
            )
            .await
        });
        drop(held_control);

        assert_eq!(
            stop.await.expect("caption stop task").state,
            CaptionsState::Idle
        );
        assert!(
            start
                .await
                .expect("queued auto-start task")
                .expect("invalidated auto-start is a quiet no-op")
                .is_none()
        );
        let coordinator = state.captions.lock().await;
        assert!(!coordinator.desired_enabled);
        assert!(coordinator.task.is_none());
    }

    #[tokio::test]
    async fn recording_stop_intent_invalidates_queued_caption_auto_start() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "recording-stop-wins",
        ));
        let start_intent_generation = reserve_caption_session_start(&state)
            .await
            .expect("caption start intent");
        state
            .recording
            .lock()
            .await
            .as_mut()
            .expect("active recording")
            .stop_requested = true;

        let status = start_captions_with_bearer_for_session(
            &state,
            Some(("recording-stop-wins", start_intent_generation)),
            Some("en".to_string()),
            || None,
        )
        .await
        .expect("stopping recording invalidates auto-start");

        assert!(status.is_none());
        assert!(!state.captions.lock().await.desired_enabled);
    }

    #[tokio::test]
    async fn completed_sign_out_invalidates_queued_caption_auto_start() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "sign-out-wins",
        ));
        let start_intent_generation = reserve_caption_session_start(&state)
            .await
            .expect("caption start intent");

        let signed_out = stop_captions_for_sign_out(&state, || {}).await;
        assert_eq!(signed_out.state, CaptionsState::Idle);
        let status = start_captions_with_bearer_for_session(
            &state,
            Some(("sign-out-wins", start_intent_generation)),
            Some("en".to_string()),
            || None,
        )
        .await
        .expect("completed sign-out invalidates auto-start");

        assert!(status.is_none());
        let coordinator = state.captions.lock().await;
        assert!(!coordinator.desired_enabled);
        assert!(coordinator.task.is_none());
    }

    #[tokio::test]
    async fn shutdown_latch_rejects_caption_start_queued_behind_runtime_drain() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "caption-shutdown",
        ));
        let _runtime = install_caption_sign_out_test_session(&state).await;
        let before = caption_sign_out_test_snapshot(&state).await;
        assert!(before.task_present);
        assert!(before.stop_present);
        assert!(before.tap_active);

        // Hold the same authority as `shutdown_caption_runtime`, then prove a
        // start entered its wait while the process was still live. The sender
        // task has no await between this signal and polling the start through
        // to the contended control lock.
        let shutdown_control = CAPTION_CONTROL.lock().await;
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let queued_state = state.clone();
        let queued_start = tokio::spawn(async move {
            queued_tx
                .send(())
                .expect("caption start queue signal receiver");
            start_captions_with_bearer(&queued_state, Some("en".to_string()), || {
                Some("test-caption-bearer".to_string())
            })
            .await
        });
        queued_rx.await.expect("caption start reached queue poll");

        assert!(state.request_process_shutdown());
        shutdown_caption_runtime_after_control(&state).await;
        let drained = caption_sign_out_test_snapshot(&state).await;
        assert!(!drained.task_present);
        assert!(!drained.stop_present);
        assert!(!drained.tap_active);

        drop(shutdown_control);
        let error = queued_start
            .await
            .expect("queued caption start task")
            .expect_err("shutdown must reject a start queued behind its runtime drain");
        assert_eq!(error.to_string(), CAPTION_START_SHUTDOWN_MESSAGE);

        let after = caption_sign_out_test_snapshot(&state).await;
        assert!(
            !after.task_present,
            "shutdown must remain the final task owner"
        );
        assert!(
            !after.stop_present,
            "shutdown must remain the final stop owner"
        );
        assert!(
            !after.tap_active,
            "shutdown must remain the final tap owner"
        );
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
            presented: true,
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

        let first_item = realtime_item_entry(
            &mut realtime_items,
            &mut sequence,
            "item-1",
            0.25,
            0,
            AdmittedBuddyAudio::test_epoch(0),
            None,
        )
        .unwrap();
        let realtime_seq = first_item.seq;
        let offset = first_item.offset_seconds;
        assert_eq!(realtime_seq, 1);
        assert_eq!(
            realtime_item_entry(
                &mut realtime_items,
                &mut sequence,
                "item-1",
                0.5,
                1,
                AdmittedBuddyAudio::test_epoch(1),
                None,
            ),
            Some(first_item),
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
                presented: true,
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
                presented: true,
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
            presented: true,
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
            admission: AdmittedBuddyAudio::test_epoch(0),
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
    fn caption_leg_plan_burns_both_legs_beside_a_vertical_leg() {
        use CaptionBurnTarget::*;
        let both_legs = CaptionOverlayLegPlan {
            primary: true,
            aux: true,
            force_same_profile_split: false,
            captioned_copy: false,
        };
        for record_enabled in [true, false] {
            for target in [Stream, Both] {
                assert_eq!(
                    caption_overlay_leg_plan_with_vertical_leg(record_enabled, true, target, true),
                    both_legs,
                    "record={record_enabled} {target:?}"
                );
            }
        }
        // Recording-only captions never touch a live leg; the clean source
        // still gets its captioned copy.
        assert_eq!(
            caption_overlay_leg_plan_with_vertical_leg(true, true, Recording, true),
            caption_overlay_leg_plan(true, true, Recording)
        );
        assert_eq!(
            caption_overlay_leg_plan_with_vertical_leg(true, true, Off, true),
            caption_overlay_leg_plan(true, true, Off)
        );
        // Without a vertical leg nothing changes.
        for target in [Off, Stream, Recording, Both] {
            assert_eq!(
                caption_overlay_leg_plan_with_vertical_leg(true, true, target, false),
                caption_overlay_leg_plan(true, true, target)
            );
        }
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
            highlight_overlay_leg_plan(true, false, HighlightAuxLeg::None),
            (false, false)
        );
        // Stream-only: the primary leg IS the stream.
        assert_eq!(
            highlight_overlay_leg_plan(false, true, HighlightAuxLeg::None),
            (true, false)
        );
        // Record + split stream leg: highlight rides the aux (stream) leg only.
        assert_eq!(
            highlight_overlay_leg_plan(true, true, HighlightAuxLeg::Stream),
            (false, true)
        );
        // Record + stream sharing one leg: viewers and recording share pixels.
        assert_eq!(
            highlight_overlay_leg_plan(true, true, HighlightAuxLeg::None),
            (true, false)
        );
        // Idle sessions never burn.
        assert_eq!(
            highlight_overlay_leg_plan(false, false, HighlightAuxLeg::None),
            (false, false)
        );
    }

    #[test]
    fn highlight_leg_plan_burns_both_orientations_with_a_vertical_leg() {
        // Regression (owner live stream 2026-09-28): the vertical simulcast
        // leg owns the aux, so horizontal viewers watch the PRIMARY leg. The
        // card used to plan aux-only there, and the compositor never draws on
        // the vertical aux without a portrait raster — it reached no output.
        for record_enabled in [true, false] {
            assert_eq!(
                highlight_overlay_leg_plan(
                    record_enabled,
                    true,
                    HighlightAuxLeg::VerticalSimulcast
                ),
                (true, true),
                "record_enabled={record_enabled}"
            );
        }
        assert_eq!(
            highlight_overlay_leg_plan(true, false, HighlightAuxLeg::VerticalSimulcast),
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

    #[tokio::test]
    async fn blocked_srt_write_releases_caption_control_and_cannot_cross_sign_out_fence() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-srt-fence-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let recording_path = root.join("recording.mp4");
        let srt_path = recording_path.with_extension("srt");
        tokio::fs::write(&srt_path, b"existing saved captions")
            .await
            .unwrap();
        let state = test_caption_app_state();
        let artifact = FinalizedCaptionArtifact {
            chunks: vec![chunk(1, 0.0, "private in-flight cue", &[])],
            style: CaptionStyleSnapshot::default(),
            artifact_generation: 0,
        };
        let (write_started_tx, write_started_rx) = tokio::sync::oneshot::channel();
        let release_write = Arc::new(tokio::sync::Semaphore::new(0));
        let writer_release = release_write.clone();
        let writer_state = state.clone();
        let writer_recording = recording_path.clone();
        let writer = tokio::spawn(async move {
            write_caption_artifacts_with_writer(
                &writer_state,
                "srt-fence",
                &writer_recording,
                artifact,
                move |path, contents| async move {
                    let _ = write_started_tx.send(());
                    let _permit = writer_release.acquire().await.unwrap();
                    tokio::fs::write(path, contents).await
                },
            )
            .await
        });
        write_started_rx.await.expect("SRT writer reached I/O seam");

        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let sign_out_cleared = credentials_cleared.clone();
        let sign_out_state = state.clone();
        let sign_out = tokio::spawn(async move {
            stop_captions_for_sign_out(&sign_out_state, move || {
                sign_out_cleared.store(true, Ordering::Release);
            })
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if state.captions.lock().await.privacy_teardown_in_progress {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("sign-out generation fence must install before SRT I/O is released");

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            finish_captions_for_capture(&state, "caption-artifact-test"),
        )
        .await
        .expect("capture finalization must obtain caption control during blocked SRT I/O");
        assert!(!credentials_cleared.load(Ordering::Acquire));

        release_write.add_permits(1);
        writer.await.unwrap();
        let status = sign_out.await.unwrap();
        assert_eq!(status.state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert_eq!(
            tokio::fs::read(&srt_path).await.unwrap(),
            b"existing saved captions",
            "stale SRT publication must not replace an existing sidecar"
        );
        tokio::fs::remove_file(&srt_path).await.unwrap();
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "staging files must be retired");
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
            buffer.push_samples(
                vec![1, 2, 3, 4],
                7,
                AdmittedBuddyAudio::test_epoch(0),
                &sequence,
                &mut timeline
            ),
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
                AdmittedBuddyAudio::test_epoch(0),
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
        policy_buffer.push_samples(
            vec![1; 8],
            3,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
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
        buffer.push_samples(
            vec![1; 4],
            3,
            AdmittedBuddyAudio::test_epoch(0),
            &final_sequence,
            &mut timeline,
        );
        let in_flight = buffer.pop_front().expect("one upload is in flight");
        assert_eq!(in_flight.seq, 1);

        // Fill all eight queue slots while the first upload is near timeout,
        // then close with a short final remainder. Stop drops the old backlog,
        // preserves the tail, clears backoff, and leaves only two attempts.
        buffer.push_samples(
            vec![2; MAX_BUFFERED_CAPTION_CHUNKS * 4 + 2],
            3,
            AdmittedBuddyAudio::test_epoch(0),
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
        buffer.push_samples(
            vec![1; 4],
            9,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
        let in_flight = buffer.pop_front().expect("one upload is in flight");
        assert_eq!(in_flight.seq, 1);

        // Three exact full chunks arrive while that upload is pending. There is
        // no PCM remainder, so the newest full chunk (seq 4) owns the last words.
        buffer.push_samples(
            vec![2; 12],
            9,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
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
            presented: true,
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
            AdmittedBuddyAudio::test_epoch(0),
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
            frame_writes_in_flight: std::collections::BTreeSet::new(),
            artifact_generation,
            last_progress_at: tokio::time::Instant::now(),
            watchdog_active: false,
            cleanup_in_progress: false,
            cleanup_path: None,
            owner_token: request_id.to_string(),
            cleanup_ledger_id: format!("caption-frames-{request_id}"),
        }
    }

    #[tokio::test]
    async fn blocked_cue_frame_write_releases_control_and_cannot_cross_sign_out_fence() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-frame-fence-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let frames_dir = root.join("recording.captions-frames");
        tokio::fs::create_dir_all(&frames_dir).await.unwrap();
        let state = test_caption_app_state();
        let mut pending = pending_render_for_test("frame-fence", 0);
        pending.frames_dir = frames_dir.clone();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator
                .pending_cue_renders
                .insert("frame-fence".to_string(), pending);
            coordinator
                .pending_cue_render_order
                .push_back("frame-fence".to_string());
        }

        let (write_started_tx, write_started_rx) = tokio::sync::oneshot::channel();
        let release_write = Arc::new(tokio::sync::Semaphore::new(0));
        let writer_release = release_write.clone();
        let writer_state = state.clone();
        let writer = tokio::spawn(async move {
            submit_caption_cue_frame_with_writer(
                &writer_state,
                "frame-fence",
                1,
                b"private png bytes".to_vec(),
                move |path, bytes| async move {
                    let _ = write_started_tx.send(());
                    let _permit = writer_release.acquire().await.unwrap();
                    tokio::fs::write(path, bytes).await
                },
            )
            .await
        });
        write_started_rx
            .await
            .expect("cue-frame writer reached I/O seam");

        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let sign_out_cleared = credentials_cleared.clone();
        let sign_out_state = state.clone();
        let sign_out = tokio::spawn(async move {
            stop_captions_for_sign_out(&sign_out_state, move || {
                sign_out_cleared.store(true, Ordering::Release);
            })
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if state.captions.lock().await.privacy_teardown_in_progress {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("sign-out fence must install during blocked cue-frame I/O");
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            finish_captions_for_capture(&state, "caption-artifact-test"),
        )
        .await
        .expect("capture finalization must obtain control during blocked cue-frame I/O");
        assert!(!credentials_cleared.load(Ordering::Acquire));

        release_write.add_permits(1);
        let error = writer
            .await
            .unwrap()
            .expect_err("generation-fenced frame write must become stale");
        assert!(error.to_string().contains("stale"));
        assert_eq!(sign_out.await.unwrap().state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert!(!frames_dir.exists());
        let coordinator = state.captions.lock().await;
        assert!(coordinator.pending_cue_renders.is_empty());
        assert!(coordinator.caption_burn_tasks.is_empty());
        drop(coordinator);
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn blocked_watchdog_cleanup_does_not_retain_caption_control_or_coordinator() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-watchdog-io-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let frames_dir = root.join("recording.captions-frames");
        tokio::fs::create_dir_all(&frames_dir).await.unwrap();
        let state = test_caption_app_state();
        let now = tokio::time::Instant::now();
        let mut pending = pending_render_for_test("watchdog-io", 0);
        pending.frames_dir = frames_dir.clone();
        pending.watchdog_active = true;
        pending.last_progress_at = now;
        {
            let mut coordinator = state.captions.lock().await;
            coordinator
                .pending_cue_renders
                .insert("watchdog-io".to_string(), pending);
            coordinator
                .pending_cue_render_order
                .push_back("watchdog-io".to_string());
        }

        let (cleanup_started_tx, cleanup_started_rx) = tokio::sync::oneshot::channel();
        let release_cleanup = Arc::new(tokio::sync::Semaphore::new(0));
        let cleanup_release = release_cleanup.clone();
        let cleanup_state = state.clone();
        let cleanup = tokio::spawn(async move {
            cleanup_expired_caption_render(
                &cleanup_state,
                "watchdog-io",
                now + CAPTION_CUE_RENDER_INACTIVITY_TIMEOUT,
                move |path, _owner_token| async move {
                    let _ = cleanup_started_tx.send(());
                    let _permit = cleanup_release.acquire().await.unwrap();
                    tokio::fs::remove_dir_all(path).await
                },
            )
            .await
        });
        cleanup_started_rx
            .await
            .expect("watchdog reached external cleanup seam");
        tokio::fs::create_dir_all(&frames_dir).await.unwrap();
        let replacement_frame = frames_dir.join("replacement.png");
        tokio::fs::write(&replacement_frame, b"new request ownership")
            .await
            .unwrap();

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            finish_captions_for_capture(&state, "caption-artifact-test"),
        )
        .await
        .expect("capture finalization must not wait for watchdog filesystem cleanup");
        assert!(
            state
                .captions
                .lock()
                .await
                .pending_cue_renders
                .contains_key("watchdog-io"),
            "cleanup ownership stays visible until external deletion finishes"
        );

        release_cleanup.add_permits(1);
        assert!(matches!(
            cleanup.await.unwrap(),
            ExpiredCaptionRenderCleanup::Removed(_)
        ));
        assert!(
            replacement_frame.exists(),
            "identity-fenced watchdog cleanup must not delete a replacement directory"
        );
        assert!(state.captions.lock().await.pending_cue_renders.is_empty());
        let _ = tokio::fs::remove_dir_all(root).await;
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
                cleanup_ledger_id: "test-shutdown-burn".to_string(),
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
    async fn blocked_sign_out_cleanup_releases_control_for_capture_finalization() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-sign-out-control-{}",
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

        let state = test_caption_app_state();
        let (cancel, mut cancel_receiver) = watch::channel(false);
        let (cancel_seen_tx, cancel_seen_rx) = tokio::sync::oneshot::channel();
        let release_cleanup = Arc::new(tokio::sync::Semaphore::new(0));
        let task_release_cleanup = release_cleanup.clone();
        let join = tokio::spawn(async move {
            wait_for_caption_burn_cancel(&mut cancel_receiver).await;
            let _ = cancel_seen_tx.send(());
            let _permit = task_release_cleanup.acquire().await.unwrap();
        });
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.caption_burn_tasks.push(CaptionBurnTask {
                cancel,
                join,
                output_path: output_path.clone(),
                frames_dir: frames_dir.clone(),
                cleanup_ledger_id: "test-sign-out-burn".to_string(),
            });
        }

        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let cleared_by_sign_out = credentials_cleared.clone();
        let sign_out_state = state.clone();
        let sign_out = tokio::spawn(async move {
            stop_captions_for_sign_out(&sign_out_state, move || {
                cleared_by_sign_out.store(true, Ordering::Release);
            })
            .await
        });
        cancel_seen_rx
            .await
            .expect("sign-out must cancel the owned burn task");

        let finalized = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            finish_captions_for_capture(&state, "caption-artifact-test"),
        )
        .await
        .expect("capture finalization must not wait for sign-out artifact cleanup");
        assert_eq!(finalized.state, CaptionsState::Idle);
        assert!(
            !credentials_cleared.load(Ordering::Acquire),
            "credentials remain present until private cleanup has joined"
        );

        release_cleanup.add_permits(1);
        let status = sign_out.await.unwrap();
        assert_eq!(status.state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert!(!frames_dir.exists());
        assert!(!output_path.exists());
        let coordinator = state.captions.lock().await;
        assert!(!coordinator.privacy_teardown_in_progress);
        assert!(!coordinator.privacy_teardown_failed);
        assert!(coordinator.chunks.is_empty());
        assert!(coordinator.finalized_style.is_none());
        assert!(coordinator.caption_burn_tasks.is_empty());
        drop(coordinator);
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
        cancel_and_join_caption_burn_tasks(
            &test_caption_app_state(),
            vec![CaptionBurnTask {
                cancel,
                join,
                output_path: output_path.clone(),
                frames_dir: frames_dir.clone(),
                cleanup_ledger_id: "test-cancel-burn".to_string(),
            }],
        )
        .await;

        assert!(
            finished.load(Ordering::Acquire),
            "privacy teardown returns only after the burn task has joined"
        );
        assert!(!output_path.exists());
        assert!(!frames_dir.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn finished_panicked_caption_burn_still_removes_private_output_and_ledger() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-burn-panic-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let frames_dir = root.join("recording.captions-frames");
        let owner_token = "test-panicked-burn";
        let output_path = root.join(format!(".{owner_token}.partial"));
        tokio::fs::create_dir_all(&frames_dir).await.unwrap();
        tokio::fs::write(frames_dir.join("1.png"), b"private frame")
            .await
            .unwrap();
        tokio::fs::write(&output_path, b"partial private output")
            .await
            .unwrap();

        let state = test_caption_app_state();
        state
            .database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: owner_token.to_string(),
                kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
                path: output_path.display().to_string(),
                owner_token: owner_token.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        let (cancel, _cancel_receiver) = watch::channel(false);
        let join = tokio::spawn(async move {
            panic!("injected finished caption burn panic");
        });
        while !join.is_finished() {
            tokio::task::yield_now().await;
        }

        let cleanup = cancel_and_join_caption_burn_tasks(
            &state,
            vec![CaptionBurnTask {
                cancel,
                join,
                output_path: output_path.clone(),
                frames_dir: frames_dir.clone(),
                cleanup_ledger_id: owner_token.to_string(),
            }],
        )
        .await;

        assert!(cleanup.complete);
        assert!(cleanup.unfinished.is_empty());
        assert!(!output_path.exists());
        assert!(!frames_dir.exists());
        assert!(
            state
                .database
                .caption_private_artifacts()
                .unwrap()
                .is_empty()
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn durable_private_caption_cleanup_survives_database_restart() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-durable-restart-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let database_path = root.join("videorc.sqlite");
        let frames_owner = "restart-frame-owner";
        let frames_dir = root.join(".restart.caption-frames");
        create_owned_caption_frame_dir(&frames_dir, frames_owner)
            .await
            .unwrap();
        tokio::fs::write(frames_dir.join("1.png"), b"private cue frame")
            .await
            .unwrap();

        let burn_owner = "restart-burn-owner";
        let recording_path = root.join("recording.mp4");
        let staging_path = caption_burn_staging_path(&recording_path, burn_owner);
        let published_path = captioned_copy_path(&recording_path);
        tokio::fs::write(&staging_path, b"private captioned copy")
            .await
            .unwrap();
        let published_identity =
            crate::storage::capture_session_file_object_identity(&staging_path)
                .unwrap()
                .unwrap();

        let first_database = crate::storage::Database::open_file_for_tests(&database_path);
        first_database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: "restart-frames-ledger".to_string(),
                kind: CAPTION_PRIVATE_DIRECTORY_KIND.to_string(),
                path: frames_dir.display().to_string(),
                owner_token: frames_owner.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        first_database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: burn_owner.to_string(),
                kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
                path: staging_path.display().to_string(),
                owner_token: burn_owner.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        first_database
            .update_caption_private_artifact_publication(
                burn_owner,
                &published_path,
                &published_identity,
            )
            .unwrap();
        crate::atomic_file::replace_file(&staging_path, &published_path).unwrap();
        drop(first_database);

        let restarted_database = crate::storage::Database::open_file_for_tests(&database_path);
        let state = test_caption_app_state_with_database(restarted_database);
        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let cleared = credentials_cleared.clone();
        let status = stop_captions_for_sign_out(&state, move || {
            cleared.store(true, Ordering::Release);
        })
        .await;

        assert_eq!(status.state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert!(!frames_dir.exists());
        assert!(!staging_path.exists());
        assert!(!published_path.exists());
        assert!(
            state
                .database
                .caption_private_artifacts()
                .unwrap()
                .is_empty()
        );
        drop(state);
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn failed_durable_cleanup_is_retryable_and_clears_credentials_only_after_success() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-cleanup-retry-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let state = test_caption_app_state();
        let owner_token = "retry-burn-owner";
        let private_staging = root.join(format!(".{owner_token}.partial"));
        let published_path = root.join("recording (captioned).mp4");
        let expected_identity_path = root.join("expected-private-object");
        tokio::fs::write(&expected_identity_path, b"expected private object")
            .await
            .unwrap();
        let expected_identity =
            crate::storage::capture_session_file_object_identity(&expected_identity_path)
                .unwrap()
                .unwrap();
        tokio::fs::write(&published_path, b"replacement user object")
            .await
            .unwrap();
        state
            .database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: owner_token.to_string(),
                kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
                path: private_staging.display().to_string(),
                owner_token: owner_token.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        state
            .database
            .update_caption_private_artifact_publication(
                owner_token,
                &published_path,
                &expected_identity,
            )
            .unwrap();

        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let first_cleared = credentials_cleared.clone();
        let first = stop_captions_for_sign_out(&state, move || {
            first_cleared.store(true, Ordering::Release);
        })
        .await;
        assert_eq!(first.state, CaptionsState::Blocked);
        assert_eq!(
            first.reason_code.as_deref(),
            Some("captions-privacy-cleanup-failed")
        );
        assert!(!credentials_cleared.load(Ordering::Acquire));
        assert_eq!(
            tokio::fs::read(&published_path).await.unwrap(),
            b"replacement user object",
            "identity mismatch must preserve the replacement file"
        );
        assert_eq!(state.database.caption_private_artifacts().unwrap().len(), 1);

        tokio::fs::remove_file(&published_path).await.unwrap();
        let retry_cleared = credentials_cleared.clone();
        let retry = stop_captions_for_sign_out(&state, move || {
            retry_cleared.store(true, Ordering::Release);
        })
        .await;
        assert_eq!(retry.state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert!(
            state
                .database
                .caption_private_artifacts()
                .unwrap()
                .is_empty()
        );
        tokio::fs::remove_file(&expected_identity_path)
            .await
            .unwrap();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn prelatched_privacy_failure_still_stops_provider_and_global_tap_on_retry() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let probe = install_caption_sign_out_test_session(&state).await;
        offer_caption_frame(&crate::audio::AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 1,
            samples: vec![0.1; 960],
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while probe.frames_received() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the provider task is active before the retry begins");
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.privacy_teardown_in_progress = true;
            coordinator.privacy_teardown_failed = true;
        }
        let credentials_cleared = Arc::new(AtomicBool::new(false));
        let cleared = credentials_cleared.clone();
        let status = stop_captions_for_sign_out(&state, move || {
            cleared.store(true, Ordering::Release);
        })
        .await;

        assert_eq!(status.state, CaptionsState::Idle);
        assert!(credentials_cleared.load(Ordering::Acquire));
        assert!(probe.task_finished());
        let snapshot = caption_sign_out_test_snapshot(&state).await;
        assert!(!snapshot.task_present);
        assert!(!snapshot.stop_present);
        assert!(!snapshot.tap_active);
    }

    #[tokio::test]
    async fn burned_copy_ready_event_requires_current_generation_adoption() {
        let root = std::env::temp_dir().join(format!(
            "videorc-caption-burn-adoption-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let state = test_caption_app_state();
        state.captions.lock().await.artifact_generation = 2;
        let mut events = state.events.subscribe();
        let (_cancel, cancel_receiver) = watch::channel(false);

        let mut stale_pending = pending_render_for_test("stale-burn", 1);
        stale_pending.recording_path = root.join("stale.mp4");
        let stale_owner = "stale-burn-owner";
        let stale_private = caption_burn_staging_path(&stale_pending.recording_path, stale_owner);
        let stale_output = captioned_copy_path(&stale_pending.recording_path);
        tokio::fs::write(&stale_private, b"stale private copy")
            .await
            .unwrap();
        state
            .database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: stale_owner.to_string(),
                kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
                path: stale_private.display().to_string(),
                owner_token: stale_owner.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        assert!(
            !publish_caption_burn_output(
                &state,
                &stale_pending,
                &cancel_receiver,
                &stale_private,
                &stale_output,
                stale_owner,
            )
            .await
            .unwrap()
        );
        assert!(!stale_private.exists());
        assert!(!stale_output.exists());
        assert!(std::iter::from_fn(|| events.try_recv().ok()).all(|event| {
            event.event != "health.event" || event.payload["code"] != "captions-burned-copy-ready"
        }));

        let mut current_pending = pending_render_for_test("current-burn", 2);
        current_pending.recording_path = root.join("current.mp4");
        current_pending.session_id = "caption-burn-adoption-session".to_string();
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: current_pending.session_id.clone(),
                title: "Caption burn adoption".to_string(),
                started_at: "2026-08-28T00:00:00Z".to_string(),
                mode: "record".to_string(),
                output_path: Some(current_pending.recording_path.display().to_string()),
                container: Some("mkv".to_string()),
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: crate::protocol::default_layout_settings(),
                output: serde_json::from_value(serde_json::json!({
                    "recordEnabled": true,
                    "streamEnabled": false,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();
        let current_owner = "current-burn-owner";
        let current_private =
            caption_burn_staging_path(&current_pending.recording_path, current_owner);
        let current_output = captioned_copy_path(&current_pending.recording_path);
        tokio::fs::write(&current_private, b"current private copy")
            .await
            .unwrap();
        state
            .database
            .register_caption_private_artifact(&crate::storage::CaptionPrivateArtifactRecord {
                id: current_owner.to_string(),
                kind: CAPTION_PRIVATE_PARTIAL_FILE_KIND.to_string(),
                path: current_private.display().to_string(),
                owner_token: current_owner.to_string(),
                published_path: None,
                object_identity: None,
            })
            .unwrap();
        assert!(
            publish_caption_burn_output(
                &state,
                &current_pending,
                &cancel_receiver,
                &current_private,
                &current_output,
                current_owner,
            )
            .await
            .unwrap()
        );
        assert!(!current_private.exists());
        assert_eq!(
            tokio::fs::read(&current_output).await.unwrap(),
            b"current private copy"
        );
        assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|event| {
            event.event == "health.event" && event.payload["code"] == "captions-burned-copy-ready"
        }));
        assert!(
            state
                .database
                .caption_private_artifacts()
                .unwrap()
                .is_empty()
        );
        tokio::fs::remove_file(current_output).await.unwrap();
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
    fn caption_burn_pins_mp4_muxer_for_private_partial_output() {
        let recording = std::path::Path::new("/tmp/Recording 12.mp4");
        let list = std::path::Path::new("/tmp/private-frames/track.ffconcat");
        let staging = caption_burn_staging_path(recording, "owner-token");
        assert_eq!(
            staging.extension(),
            Some(std::ffi::OsStr::new("partial")),
            "privacy staging must remain visibly non-final"
        );

        let args = caption_burn_ffmpeg_args(recording, list, &staging);
        assert_eq!(
            &args[11..],
            &[
                OsString::from("-f"),
                OsString::from("mp4"),
                staging.as_os_str().to_owned(),
            ],
            "the explicit muxer must precede an extensionless private output"
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
        assert!(info.revision >= 1);

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
        assert_eq!(overlay.position(), CaptionOverlayPosition::Bottom);

        let second =
            install_caption_overlay(&slot, &encode_test_png(6, 2), CaptionOverlayPosition::Top)
                .expect("replacement installs");
        assert!(second.revision > info.revision);

        // A clear must not rewind the revision: the Metal texture cache keys
        // on it, and a same-size replacement would otherwise replay stale
        // pixels.
        clear_caption_overlay(&slot);
        let after_clear =
            install_caption_overlay(&slot, &encode_test_png(6, 2), CaptionOverlayPosition::Top)
                .expect("install after clear");
        assert!(after_clear.revision > second.revision);
    }

    #[test]
    fn overlay_rejects_garbage_and_keeps_previous() {
        let slot = new_caption_overlay_slot();
        let installed = install_caption_overlay(
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
        assert_eq!(survivor.revision, installed.revision);
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
                rect: None,
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
                rect: None,
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
                rect: None,
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
                rect: None,
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
                rect: None,
                target: Some(CaptionOverlayTarget::Primary),
                style_revision: Some(8),
            },
        )
        .unwrap_err();
        assert_eq!(caption_overlay_error_code(&stale), "captions-overlay-stale");
        let survivor = current_caption_overlays(&slots).primary.unwrap();
        assert_eq!(
            (survivor.width, survivor.position()),
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
                rect: None,
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

    // --- Plan 068 S3: one transcription engine, two intents ------------------

    fn drain_events(
        events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<crate::protocol::ServerEvent> {
        std::iter::from_fn(|| events.try_recv().ok()).collect()
    }

    fn caption_event_names(events: &[crate::protocol::ServerEvent]) -> Vec<String> {
        events
            .iter()
            .filter(|event| event.event.starts_with("captions.") || event.event == "health")
            .map(|event| event.event.clone())
            .collect()
    }

    /// A live provider task standing in for the shared engine, with the
    /// coordinator wired the way `spawn_transcription_task` wires it.
    async fn install_intent_test_task(
        state: &AppState,
        captions: bool,
        listen: bool,
    ) -> Arc<AtomicBool> {
        let mut receiver = install_tap();
        let stop = Arc::new(AtomicBool::new(false));
        let task_stop = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                if task_stop.load(Ordering::Acquire) {
                    break;
                }
                match tokio::time::timeout(std::time::Duration::from_millis(10), receiver.recv())
                    .await
                {
                    Ok(None) => break,
                    Ok(Some(_)) | Err(_) => {}
                }
            }
        });
        let present = Arc::new(AtomicBool::new(captions));
        let mut coordinator = state.captions.lock().await;
        coordinator.task = Some(task);
        coordinator.stop = Some(stop);
        coordinator.desired_enabled = captions;
        coordinator.listen_wanted = listen;
        coordinator.presentation = Some(present.clone());
        let mut shadow = CaptionsStatus::active(
            CaptionsState::Degraded,
            CaptionsTransport::Chunked,
            "captions-intent-test",
        );
        shadow.provider_ready = true;
        coordinator.shadow_status = Some(shadow.clone());
        coordinator.status = Some(if captions {
            shadow
        } else {
            CaptionsStatus::idle()
        });
        present
    }

    fn test_caption_session(state: &AppState, present: bool) -> CaptionSession {
        let (_sender, receiver) = mpsc::channel(1);
        CaptionSession {
            bearer: "test-bearer".to_string(),
            client: VideorcApiClient::new().expect("test api client"),
            language: None,
            receiver,
            capture_elapsed_seconds: 0.0,
            session_client_id: "captions-session-test".to_string(),
            sequence: CaptionSequence::default(),
            state: state.clone(),
            stop: Arc::new(AtomicBool::new(false)),
            present: Arc::new(AtomicBool::new(present)),
            mark_target: None,
            marker_utterance: std::sync::Mutex::new(Default::default()),
            marker_buffer_epoch: std::sync::Mutex::new(None),
        }
    }

    fn tone(samples: usize, amplitude: f64) -> Vec<i16> {
        (0..samples)
            .map(|index| {
                let phase = index as f64 * 440.0 * std::f64::consts::TAU / 16_000.0;
                (phase.sin() * amplitude * f64::from(i16::MAX)) as i16
            })
            .collect()
    }

    fn dbfs(db: f64) -> f64 {
        10f64.powf(db / 20.0)
    }

    #[test]
    fn silence_gate_skips_only_chunks_with_no_window_above_minus_45_dbfs() {
        let chunk_samples = (f64::from(CAPTION_SAMPLE_RATE) * CAPTION_CHUNK_SECONDS) as usize;
        // A sine's RMS is amplitude / sqrt(2): pick amplitudes around the
        // floor so the RMS lands clearly on each side of -45 dBFS.
        let quiet = dbfs(-48.0) * std::f64::consts::SQRT_2;
        let loud = dbfs(-40.0) * std::f64::consts::SQRT_2;
        let cases: Vec<(&str, Vec<i16>, bool)> = vec![
            ("empty", Vec::new(), false),
            ("digital silence", vec![0; chunk_samples], false),
            ("-48 dBFS everywhere", tone(chunk_samples, quiet), false),
            ("-40 dBFS everywhere", tone(chunk_samples, loud), true),
            (
                "one 50 ms window at -40 dBFS in silence",
                {
                    let mut samples = vec![0i16; chunk_samples];
                    let start = SPEECH_WINDOW_SAMPLES * 20;
                    samples[start..start + SPEECH_WINDOW_SAMPLES]
                        .copy_from_slice(&tone(SPEECH_WINDOW_SAMPLES, loud));
                    samples
                },
                true,
            ),
            (
                "a loud trailing partial window still counts",
                {
                    // 60 full silent windows, then a 100-sample loud tail.
                    let mut samples = vec![0i16; chunk_samples];
                    samples.extend(tone(100, loud));
                    samples
                },
                true,
            ),
            (
                "-40 dBFS spread thinly across every window stays silent",
                {
                    // One sample per window at full scale would be loud; one
                    // sample at -20 dBFS per 800-sample window is ~-49 dBFS RMS.
                    let mut samples = vec![0i16; chunk_samples];
                    for window in samples.chunks_mut(SPEECH_WINDOW_SAMPLES) {
                        window[0] = (dbfs(-20.0) * f64::from(i16::MAX)) as i16;
                    }
                    samples
                },
                false,
            ),
        ];
        for (name, samples, expected) in cases {
            assert_eq!(chunk_has_speech(&samples), expected, "{name}");
        }
        assert!(pcm_has_voice(&tone(320, loud)));
        assert!(!pcm_has_voice(&tone(320, quiet)));
    }

    #[test]
    fn silence_skip_keeps_the_timeline_exact() {
        let sequence = CaptionSequence::default();
        let mut timeline = CaptionTimeline::new(10.0);
        let mut buffer = CaptionChunkBuffer::new(1_600, 8);
        let loud = dbfs(-30.0) * std::f64::consts::SQRT_2;
        buffer.push_samples(
            vec![0; 1_600],
            1,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
        buffer.push_samples(
            tone(1_600, loud),
            1,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
        buffer.push_samples(
            vec![0; 1_600],
            1,
            AdmittedBuddyAudio::test_epoch(0),
            &sequence,
            &mut timeline,
        );
        let stamped = buffer.drain_pending();
        let offsets: Vec<f64> = stamped.iter().map(|chunk| chunk.offset_seconds).collect();
        assert_eq!(offsets, vec![10.0, 10.1, 10.2]);
        // Offsets were stamped before the gate ran: the surviving chunk keeps
        // its place even though its neighbours never upload.
        let uploaded: Vec<&BufferedCaptionChunk> = stamped
            .iter()
            .filter(|chunk| chunk_has_speech(&chunk.samples))
            .collect();
        assert_eq!(uploaded.len(), 1);
        assert_eq!(uploaded[0].seq, 2);
        assert_eq!(uploaded[0].offset_seconds, 10.1);
        assert_eq!(timeline.current_seconds(), 10.3);
    }

    #[tokio::test]
    async fn chunk_purpose_follows_presentation() {
        let state = test_caption_app_state();
        let session = test_caption_session(&state, false);
        assert_eq!(
            session.chunk_purpose(),
            crate::videorc_api::CaptionChunkPurpose::Listen
        );
        session.present.store(true, Ordering::Release);
        assert_eq!(
            session.chunk_purpose(),
            crate::videorc_api::CaptionChunkPurpose::Captions
        );
    }

    #[tokio::test]
    async fn listen_only_task_presents_nothing_but_buddy_hears_every_final() {
        let state = test_caption_app_state();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.listen_wanted = true;
            coordinator.speech_admitted = true;
        }
        let mut events = state.events.subscribe();
        let session = test_caption_session(&state, false);

        let mut status = CaptionsStatus::active(
            CaptionsState::Degraded,
            CaptionsTransport::Chunked,
            &session.session_client_id,
        );
        status.provider_ready = true;
        publish_status(&session, status.clone()).await;
        session.emit_health(
            crate::protocol::HealthLevel::Warn,
            "captions-upload-failed",
            "quiet",
        );
        surface_chunked_audio_drop(&session, 1.5, 2, true).await;
        {
            let coordinator = state.captions.lock().await;
            assert!(
                coordinator.status.is_none(),
                "listen-only never touches the caption status"
            );
            assert_eq!(
                coordinator
                    .shadow_status
                    .as_ref()
                    .map(|status| status.reason_code.clone()),
                Some(Some("captions-audio-dropped".to_string()))
            );
        }

        let mut items = std::collections::HashMap::new();
        let sequence = CaptionSequence::default();
        let timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 4.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 6_000.0,
            capture_epoch: 0,
            admission: AdmittedBuddyAudio::test_epoch(0),
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "item-1".to_string(),
                audio_start_ms: Some(500.0),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Partial {
                item_id: "item-1".to_string(),
                transcript: "clip th".to_string(),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "item-1".to_string(),
                transcript: "clip that".to_string(),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;

        assert!(
            caption_event_names(&drain_events(&mut events)).is_empty(),
            "listen-only must publish no caption status, update or health event"
        );
        let chunks = &state.captions.lock().await.chunks;
        assert_eq!(chunks.len(), 1);
        assert!(!chunks[0].presented);
        assert_eq!(chunks[0].text, "clip that");
        let window = state
            .cohost_transcript
            .lock()
            .unwrap()
            .snapshot(std::time::Instant::now());
        assert_eq!(window.text, "clip that");
        let speech = crate::cohost::recent_speech_since(&state, None).expect("speech");
        assert_eq!(speech.finals.len(), 1);
        assert_eq!(speech.finals[0].text, "clip that");
        assert_eq!(speech.finals[0].offset_seconds, 4.5);
        assert!(!speech.finals[0].presented);
    }

    #[tokio::test]
    async fn presenting_task_emits_updates_tagged_presented() {
        let state = test_caption_app_state();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.listen_wanted = true;
            coordinator.speech_admitted = true;
        }
        let mut events = state.events.subscribe();
        let session = test_caption_session(&state, true);
        let mut items = std::collections::HashMap::new();
        let sequence = CaptionSequence::default();
        let timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 0.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 2_000.0,
            capture_epoch: 0,
            admission: AdmittedBuddyAudio::test_epoch(0),
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "item-1".to_string(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "item-1".to_string(),
                transcript: "hello chat".to_string(),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        let names = caption_event_names(&drain_events(&mut events));
        assert_eq!(names, vec!["captions.update".to_string()]);
        assert!(state.captions.lock().await.chunks[0].presented);
        let speech = crate::cohost::recent_speech_since(&state, None).expect("speech");
        assert!(speech.finals[0].presented);
    }

    #[tokio::test]
    async fn listen_block_ends_listening_only_and_never_a_presenting_caption_session() {
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();

        // Both intents: the listen allowance runs out while captions present.
        let session = test_caption_session(&state, true);
        state.captions.lock().await.listen_wanted = true;
        let outcome = handle_terminal_failure(
            &session,
            "listen-monthly-quota-exhausted",
            "Listening is used up.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(crate::videorc_api::CaptionChunkPurpose::Listen),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::Continue);
        assert!(!state.captions.lock().await.listen_wanted);
        assert!(
            caption_event_names(&drain_events(&mut events)).is_empty(),
            "a listen block is not a caption block"
        );

        // Listen only: the same block ends the task quietly.
        let session = test_caption_session(&state, false);
        state.captions.lock().await.listen_wanted = true;
        let outcome = handle_terminal_failure(
            &session,
            "listen-disabled",
            "Listening is off.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(crate::videorc_api::CaptionChunkPurpose::Listen),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::EndTask);
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());

        // A terminal failure that applies to listening too ends a listen-only
        // task without a caption status, and a presenting task with the usual
        // block.
        state.captions.lock().await.listen_wanted = true;
        let outcome = handle_terminal_failure(
            &session,
            "unauthorized",
            "Sign in.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(crate::videorc_api::CaptionChunkPurpose::Listen),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::EndTask);
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());
        let presenting = test_caption_session(&state, true);
        let outcome = handle_terminal_failure(
            &presenting,
            "cloud-ai-premium-required",
            "Premium.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(crate::videorc_api::CaptionChunkPurpose::Captions),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::EndTask);
        let emitted = drain_events(&mut events);
        assert!(emitted.iter().any(|event| {
            event.event == "captions.status" && event.payload["state"] == "blocked"
        }));
        assert!(
            emitted
                .iter()
                .any(|event| event.event == "captions.cleared")
        );
    }

    #[tokio::test]
    async fn intent_matrix_keeps_one_task_alive_while_either_intent_is_wanted() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();

        // Listen only: an explicit caption stop answers idle and keeps the task.
        let present = install_intent_test_task(&state, false, true).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        let status = stop_captions(&state).await;
        assert_eq!(status.state, CaptionsState::Idle);
        assert!(!status.desired_enabled);
        {
            let coordinator = state.captions.lock().await;
            assert!(coordinator_task_alive(&coordinator));
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(coordinator.listen_wanted);
        }
        assert!(TAP_ACTIVE.load(Ordering::Acquire));
        assert!(!present.load(Ordering::Acquire));
        drain_events(&mut events);
        // Stopping listen with nothing presenting ends the task and the tap.
        stop_listen(&state).await;
        {
            let coordinator = state.captions.lock().await;
            assert!(coordinator.task.is_none());
            assert!(!coordinator.listen_wanted);
            assert!(coordinator.presentation.is_none());
        }
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        assert!(
            caption_event_names(&drain_events(&mut events)).is_empty(),
            "ending a listen-only task publishes no caption boundary"
        );

        // Both: captions off flips presentation, listen off ends the task.
        let present = install_intent_test_task(&state, true, true).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        stop_captions(&state).await;
        {
            let coordinator = state.captions.lock().await;
            assert!(coordinator_task_alive(&coordinator));
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(!coordinator.desired_enabled);
            assert_eq!(
                coordinator.status.as_ref().unwrap().state,
                CaptionsState::Idle
            );
        }
        assert!(!present.load(Ordering::Acquire));
        let names = caption_event_names(&drain_events(&mut events));
        assert!(names.contains(&"captions.status".to_string()));
        assert!(names.contains(&"captions.cleared".to_string()));
        stop_listen(&state).await;
        assert!(state.captions.lock().await.task.is_none());
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));

        // Captions only: listen off is a no-op, captions off ends the task.
        let present = install_intent_test_task(&state, true, false).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        stop_listen(&state).await;
        {
            let coordinator = state.captions.lock().await;
            assert!(coordinator_task_alive(&coordinator));
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(coordinator.desired_enabled);
        }
        assert!(present.load(Ordering::Acquire));
        assert!(TAP_ACTIVE.load(Ordering::Acquire));
        stop_captions(&state).await;
        assert!(state.captions.lock().await.task.is_none());
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        drain_events(&mut events);

        // Captions on over a listen-only task: same task, presentation on,
        // the renderer sees the transport state the task reached.
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("listen-first"));
        let present = install_intent_test_task(&state, false, true).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        let status =
            start_captions_with_bearer(&state, Some("en".into()), || Some("test-bearer".into()))
                .await
                .expect("captions join the listen task");
        assert_eq!(status.state, CaptionsState::Degraded);
        assert!(status.provider_ready);
        assert_eq!(
            status.session_client_id.as_deref(),
            Some("captions-intent-test")
        );
        {
            let coordinator = state.captions.lock().await;
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(coordinator.desired_enabled);
            assert!(coordinator.listen_wanted);
        }
        assert!(present.load(Ordering::Acquire));
        let emitted = drain_events(&mut events);
        assert!(emitted.iter().any(|event| {
            event.event == "captions.status" && event.payload["state"] == "degraded"
        }));

        // Listen on over a presenting caption task: joins, no caption emits.
        stop_listen(&state).await;
        assert!(state.captions.lock().await.task.as_ref().is_some());
        drain_events(&mut events);
        let listening =
            start_listen_with_bearer(&state, "buddy-session", || Some("test-bearer".into())).await;
        assert_eq!(listening, crate::cohost::CohostListening::on(None));
        {
            let coordinator = state.captions.lock().await;
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(coordinator.listen_wanted);
        }
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());

        stop_captions(&state).await;
        stop_listen(&state).await;
        *state.recording.lock().await = None;
    }

    #[tokio::test]
    async fn listen_start_never_blocks_capture_or_raises_a_caption_block() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();

        let listening = start_listen_with_bearer(&state, "buddy", || Some("b".into())).await;
        assert_eq!(
            listening.state,
            crate::cohost::CohostListeningState::Blocked
        );
        assert_eq!(listening.reason_code.as_deref(), Some("no-capture"));

        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "no-mic-session",
        ));
        let listening = start_listen_with_bearer(&state, "buddy", || Some("b".into())).await;
        assert_eq!(listening.reason_code.as_deref(), Some("no-microphone"));
        {
            let coordinator = state.captions.lock().await;
            assert!(
                coordinator.task.is_none(),
                "no task without an eligible microphone"
            );
            assert!(
                coordinator.listen_wanted,
                "the intent stays wanted for a later capture"
            );
            assert!(coordinator.status.is_none(), "never a caption status");
            assert!(!coordinator.desired_enabled);
        }
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        assert!(
            state.recording.lock().await.is_some(),
            "listen never touches the capture session"
        );
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());
        stop_listen(&state).await;
        assert!(!state.captions.lock().await.listen_wanted);
        *state.recording.lock().await = None;
    }

    #[tokio::test]
    async fn listen_only_recording_writes_the_srt_but_renders_no_cues() {
        let root = std::env::temp_dir().join(format!(
            "videorc-listen-only-artifact-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let recording_path = root.join("recording.mp4");
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();
        let mut heard = chunk(1, 0.0, "buddy heard this", &[]);
        heard.presented = false;
        let artifact = FinalizedCaptionArtifact {
            chunks: vec![heard],
            style: CaptionStyleSnapshot {
                output_width: 1_920,
                output_height: 1_080,
                ..CaptionStyleSnapshot::default()
            },
            artifact_generation: 0,
        };
        let artifact =
            write_caption_artifacts(&state, "listen-only", &recording_path, artifact).await;
        let srt = tokio::fs::read_to_string(recording_path.with_extension("srt"))
            .await
            .expect("the Buddy report's moments need the SRT even when captions never presented");
        assert!(srt.contains("buddy heard this"));
        assert_eq!(artifact.presented_chunk_count(), 0);
        assert!(artifact.presented_chunks().is_empty());
        begin_caption_cue_render(&state, "listen-only", "ffmpeg", &recording_path, &artifact).await;
        assert!(
            drain_events(&mut events)
                .iter()
                .all(|event| event.event != "captions.cues.render-request"),
            "unpresented records never reach the compositor"
        );
        assert!(!recording_path.with_extension("captions-frames").exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    // --- Plan 068 review fixes ---------------------------------------------

    fn purpose(listen: bool) -> crate::videorc_api::CaptionChunkPurpose {
        if listen {
            crate::videorc_api::CaptionChunkPurpose::Listen
        } else {
            crate::videorc_api::CaptionChunkPurpose::Captions
        }
    }

    #[test]
    fn terminal_failure_scope_table() {
        use TerminalScope::{Both, Captions, Listen};
        let captions_chunk = TerminalOrigin::Upload(purpose(false));
        let listen_chunk = TerminalOrigin::Upload(purpose(true));
        let cases: &[(&str, TerminalOrigin, TerminalScope)] = &[
            // The listen allowance and switch end listening only.
            ("listen-monthly-quota-exhausted", listen_chunk, Listen),
            ("listen-disabled", listen_chunk, Listen),
            // The caption allowance and the captions switch, answered to a
            // caption-metered request, end captions only.
            ("captions-monthly-quota-exhausted", captions_chunk, Captions),
            ("ai-disabled", captions_chunk, Captions),
            (
                "captions-monthly-quota-exhausted",
                TerminalOrigin::RealtimeMint,
                Captions,
            ),
            ("ai-disabled", TerminalOrigin::RealtimeMint, Captions),
            // The realtime socket is a caption-only transport.
            (
                "realtime-close-4401",
                TerminalOrigin::RealtimeSocket,
                Captions,
            ),
            // A listen chunk told `ai-disabled` means the global switch.
            ("ai-disabled", listen_chunk, Both),
            // What applies to listening too ends both.
            ("unauthorized", captions_chunk, Both),
            ("unauthorized", TerminalOrigin::RealtimeMint, Both),
            ("cloud-ai-premium-required", captions_chunk, Both),
            (
                "cloud-ai-premium-required",
                TerminalOrigin::RealtimeMint,
                Both,
            ),
            ("ai-user-disabled", captions_chunk, Both),
            ("captions-config-missing", captions_chunk, Both),
            ("audio-path-stalled", TerminalOrigin::AudioPath, Both),
        ];
        for (code, origin, expected) in cases {
            assert_eq!(
                terminal_failure_scope(code, *origin),
                *expected,
                "{code} from {origin:?}"
            );
        }
    }

    /// Finding 1b: with both intents on, a caption quota or the captions
    /// switch ends captions (with the caption block, exactly as before) and
    /// the same task keeps transcribing for Buddy, metered as listen.
    #[tokio::test]
    async fn caption_scoped_failures_never_stop_buddy_listening() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();
        for (code, origin) in [
            (
                "captions-monthly-quota-exhausted",
                TerminalOrigin::Upload(purpose(false)),
            ),
            ("ai-disabled", TerminalOrigin::RealtimeMint),
        ] {
            let session = test_caption_session(&state, true);
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.listen_wanted = true;
                coordinator.desired_enabled = true;
            }
            let outcome = handle_terminal_failure(
                &session,
                code,
                "Monthly live-caption allowance exhausted.",
                CaptionsTransport::Chunked,
                origin,
            )
            .await;
            assert_eq!(outcome, TerminalOutcome::Continue, "{code}");
            assert!(!session.presenting(), "captions stop presenting ({code})");
            assert_eq!(session.chunk_purpose(), purpose(true));
            {
                let coordinator = state.captions.lock().await;
                assert!(coordinator.listen_wanted, "Buddy keeps listening ({code})");
                let status = coordinator.status.as_ref().expect("caption block");
                assert_eq!(status.state, CaptionsState::Blocked);
                assert_eq!(status.reason_code.as_deref(), Some(code));
            }
            let emitted = drain_events(&mut events);
            assert!(emitted.iter().any(|event| {
                event.event == "captions.status"
                    && event.payload["state"] == "blocked"
                    && event.payload["reasonCode"] == code
            }));
            assert!(
                emitted
                    .iter()
                    .any(|event| event.event == "captions.cleared")
            );
        }

        // A realtime socket failure while Buddy listens falls back to chunks.
        let session = test_caption_session(&state, true);
        state.captions.lock().await.listen_wanted = true;
        let outcome = handle_terminal_failure(
            &session,
            "realtime-close-4429",
            "Realtime caption socket closed.",
            CaptionsTransport::Realtime,
            TerminalOrigin::RealtimeSocket,
        )
        .await;
        assert!(matches!(
            realtime_terminal_outcome(outcome, "closed"),
            RealtimeOutcome::Fallback(_)
        ));
        assert!(state.captions.lock().await.listen_wanted);

        // Captions only: the same caption block still ends the task.
        let session = test_caption_session(&state, true);
        state.captions.lock().await.listen_wanted = false;
        let outcome = handle_terminal_failure(
            &session,
            "captions-monthly-quota-exhausted",
            "Used up.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(purpose(false)),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::EndTask);
        assert!(matches!(
            realtime_terminal_outcome(outcome, "x"),
            RealtimeOutcome::Terminal
        ));

        // Both intents, but a failure that applies to listening too: the task
        // ends and both stop.
        for code in ["unauthorized", "cloud-ai-premium-required"] {
            let session = test_caption_session(&state, true);
            state.captions.lock().await.listen_wanted = true;
            let outcome = handle_terminal_failure(
                &session,
                code,
                "No.",
                CaptionsTransport::Chunked,
                TerminalOrigin::Upload(purpose(false)),
            )
            .await;
            assert_eq!(outcome, TerminalOutcome::EndTask, "{code}");
        }
        // The global switch reaches the next listen chunk and ends it then.
        let session = test_caption_session(&state, false);
        state.captions.lock().await.listen_wanted = true;
        let outcome = handle_terminal_failure(
            &session,
            "ai-disabled",
            "Cloud AI is off.",
            CaptionsTransport::Chunked,
            TerminalOrigin::Upload(purpose(true)),
        )
        .await;
        assert_eq!(outcome, TerminalOutcome::EndTask);
    }

    /// Finding 1a: a listen-only task never asks the caption-gated realtime
    /// token route; it starts on the metered chunk path.
    #[tokio::test]
    async fn a_listen_only_task_never_tries_realtime() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();
        // Closed receiver and no intent wanted: the chunk loop drains at once.
        let session = test_caption_session(&state, false);
        run_caption_session(session).await;
        let shadow = state
            .captions
            .lock()
            .await
            .shadow_status
            .clone()
            .expect("the chunked shadow a later captions start adopts");
        assert_eq!(shadow.transport, Some(CaptionsTransport::Chunked));
        assert_eq!(shadow.reason_code.as_deref(), Some("realtime-fallback"));
        // A realtime attempt would have said why it fell back.
        assert_eq!(
            shadow.message.as_deref(),
            Some("Captions on with higher delay.")
        );
        assert!(state.captions.lock().await.status.is_none());
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());
    }

    fn chunk_response(text: &str, remaining_seconds: u64) -> CaptionChunkResponse {
        CaptionChunkResponse {
            text: text.to_string(),
            chunk_seconds: 3,
            remaining_seconds,
            monthly_seconds_limit: 3_600,
            latency_ms: None,
            model: "test".to_string(),
            segments: Vec::new(),
        }
    }

    fn stamped_chunk(seq: u64, offset_seconds: f64) -> BufferedCaptionChunk {
        BufferedCaptionChunk {
            samples: Vec::new(),
            seq,
            offset_seconds,
            duration_seconds: 3.0,
            capture_epoch: 0,
            admission: AdmittedBuddyAudio::test_epoch(0),
        }
    }

    fn persist_clip_test_recording(state: &AppState, session_id: &str) {
        persist_clip_test_capture(state, session_id, true);
    }

    fn persist_clip_test_capture(state: &AppState, session_id: &str, records_to_file: bool) {
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: session_id.to_string(),
                title: "Caption clip ownership".to_string(),
                started_at: "2026-10-03T10:00:00Z".to_string(),
                mode: if records_to_file { "record" } else { "stream" }.to_string(),
                output_path: records_to_file.then(|| format!("/tmp/{session_id}.mp4")),
                container: records_to_file.then(|| "mp4".to_string()),
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: crate::protocol::default_layout_settings(),
                output: serde_json::from_value(serde_json::json!({
                    "recordEnabled": records_to_file,
                    "streamEnabled": !records_to_file,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();
    }

    async fn next_clip_event(
        events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> crate::protocol::ServerEvent {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("clip event channel");
                if event.event == "clip.marked" {
                    return event;
                }
            }
        })
        .await
        .expect("the admitted recording final must produce a clip mark")
    }

    #[tokio::test]
    async fn no_capture_caption_start_joins_the_retired_provider_before_ready() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        struct ProviderFinished(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for ProviderFinished {
            fn drop(&mut self) {
                if let Some(finished) = self.0.take() {
                    let _ = finished.send(());
                }
            }
        }
        let state = test_caption_app_state();
        for id in ["cancel-a", "cancel-b", "cancel-c"] {
            let capture_permit = state.ffmpeg_work.begin_capture_when_available().await;
            let mut active = crate::recording::test_active_recording_stub(id);
            active.output_path = Some(std::path::PathBuf::from(format!("/tmp/{id}.mp4")));
            *state.recording.lock().await = Some(active);
            let (_, target) = caption_capture_facts(state.recording.lock().await.as_ref());
            crate::clip_marks::register_caption_target(&state, target.as_ref());
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finished_tx, mut finished_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _finished = ProviderFinished(Some(finished_tx));
                let _ = started_tx.send(());
                std::future::pending::<()>().await;
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
                .await
                .unwrap()
                .unwrap();
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.task = Some(task);
                coordinator.task_mark_target = target;
                coordinator.stop = Some(Arc::new(AtomicBool::new(false)));
                coordinator.listen_wanted = true;
                coordinator.desired_enabled = true;
            }
            // Reach the actual monitor window: admission remains gated, the
            // old slot is retired, and Listen intentionally leaves the task
            // for capture drain. An idle captions.start can arrive next.
            let finalizing = state.ffmpeg_work.begin_finalizing();
            state.recording.lock().await.take();
            drop(capture_permit);
            stop_listen_with(&state, ListenStop::DrainWithCapture).await;
            let status = start_captions_with_bearer(&state, None, || Some("test-bearer".into()))
                .await
                .unwrap();
            assert_eq!(status.state, CaptionsState::Ready);
            assert!(
                finished_rx.try_recv().is_ok(),
                "Ready must follow the provider join"
            );
            finish_captions_for_capture(&state, id).await;
            assert!(
                !state.clip_marks.lock().unwrap().register_recording(id),
                "the exact drained owner must stay retired"
            );
            drop(finalizing);
        }
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .register_recording("after-cancellation")
        );
    }

    #[tokio::test]
    async fn a_terminal_blocked_retry_joins_before_replacement_and_preserves_its_owner() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let target = crate::clip_marks::MarkTarget {
            session_id: "blocked-retry".into(),
            records_to_file: true,
        };
        crate::clip_marks::register_caption_target(&state, Some(&target));
        state
            .clip_marks
            .lock()
            .unwrap()
            .note_manual_mark("blocked-retry", 10.0);
        let session = test_caption_session(&state, true);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let task_finished = finished.clone();
        let task = tokio::spawn(async move {
            let _finished = CaptionTestTaskFinished(task_finished);
            let outcome = handle_terminal_failure(
                &session,
                "unauthorized",
                "Sign in again.",
                CaptionsTransport::Chunked,
                TerminalOrigin::Upload(purpose(false)),
            )
            .await;
            assert_eq!(outcome, TerminalOutcome::EndTask);
            let _ = started_tx.send(());
            // Controlled scheduling point after the real Blocked event and
            // before the provider loop returns. No network/native fixture.
            std::future::pending::<()>().await;
        });
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.task = Some(task);
            coordinator.task_mark_target = Some(target.clone());
            coordinator.stop = Some(Arc::new(AtomicBool::new(false)));
            coordinator.presentation = Some(Arc::new(AtomicBool::new(true)));
            coordinator.desired_enabled = true;
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            state.captions.lock().await.status.as_ref().unwrap().state,
            CaptionsState::Blocked
        );
        assert!(!finished.load(Ordering::Acquire));
        let _control = CAPTION_CONTROL.lock().await;
        finish_caption_task_for_retry(&state, Some(&target))
            .await
            .unwrap();
        assert!(
            finished.load(Ordering::Acquire),
            "a Blocked retry must join the old provider"
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("blocked-retry", "clip that", &[], 15.0)
                .is_none()
        );
        let mut coordinator = state.captions.lock().await;
        spawn_transcription_task(
            &state,
            &mut coordinator,
            TranscriptionTaskStart {
                bearer: "test-bearer".into(),
                client: VideorcApiClient::new().unwrap(),
                language: None,
                capture_elapsed_seconds: 20.0,
                present: true,
                mark_target: Some(target),
            },
        );
        // Current-thread test: cancel the new queued provider before any poll.
        // This exercises ownership installation without a real provider call.
        let new_task = coordinator.task.take().unwrap();
        coordinator.task_mark_target.take();
        coordinator.stop.take();
        new_task.abort();
        drop(coordinator);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), new_task)
            .await
            .unwrap();
        remove_tap();
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("blocked-retry", "clip that", &[], 15.0)
                .is_none()
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("blocked-retry", "clip that", &[], 20.0)
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_failed_retry_join_refuses_replacement_even_after_an_empty_runtime_retry() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let target = crate::clip_marks::MarkTarget {
            session_id: "unjoined-retry".into(),
            records_to_file: true,
        };
        crate::clip_marks::register_caption_target(&state, Some(&target));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let task = tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
            let _ = finished_tx.send(());
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.task = Some(task);
            coordinator.task_mark_target = Some(target.clone());
            coordinator.stop = Some(Arc::new(AtomicBool::new(false)));
            coordinator.desired_enabled = true;
        }
        let _control = CAPTION_CONTROL.lock().await;
        let result = finish_caption_task_for_retry(&state, Some(&target)).await;
        // Own the blocking worker until it signals completion, even when the
        // production abort/join deadline intentionally refuses its result.
        drop(release_tx);
        tokio::time::timeout(std::time::Duration::from_secs(2), finished_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("did not finish stopping")
        );
        assert!(state.captions.lock().await.task.is_none());
        assert!(state.captions.lock().await.task_mark_target.is_none());
        assert_eq!(
            state
                .captions
                .lock()
                .await
                .status
                .as_ref()
                .unwrap()
                .reason_code
                .as_deref(),
            Some("captions-start-failed")
        );
        assert!(
            finish_caption_task_for_retry(&state, Some(&target))
                .await
                .is_err()
        );
        assert!(
            !state
                .clip_marks
                .lock()
                .unwrap()
                .retire_recording("unjoined-retry")
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .register_recording("independent-owner")
        );
        let independent = crate::clip_marks::MarkTarget {
            session_id: "independent-owner".into(),
            records_to_file: true,
        };
        assert!(
            finish_caption_task_for_retry(&state, Some(&independent))
                .await
                .is_ok()
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("unjoined-retry", "clip that", &[], 10.0)
                .is_none()
        );
    }

    #[tokio::test]
    async fn caption_opt_out_and_on_share_the_same_recordings_manual_dedupe() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let target = crate::clip_marks::MarkTarget {
            session_id: "opt-out-capture".into(),
            records_to_file: true,
        };
        crate::clip_marks::register_caption_target(&state, Some(&target));
        state
            .clip_marks
            .lock()
            .unwrap()
            .note_manual_mark("opt-out-capture", 10.0);
        let mut active = crate::recording::test_active_recording_stub("opt-out-capture");
        active.output_path = Some(std::path::PathBuf::from("/tmp/opt-out-capture.mp4"));
        *state.recording.lock().await = Some(active);
        install_intent_test_task(&state, true, false).await;
        state.captions.lock().await.task_mark_target = Some(target.clone());
        stop_captions(&state).await;
        assert!(state.captions.lock().await.task.is_none());
        assert!(state.captions.lock().await.task_mark_target.is_none());
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("opt-out-capture", "clip that", &[], 15.0)
                .is_none()
        );
        crate::clip_marks::register_caption_target(&state, Some(&target));
        install_intent_test_task(&state, true, false).await;
        state.captions.lock().await.task_mark_target = Some(target);
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        let confirmed_status =
            serde_json::to_value(state.captions.lock().await.status.as_ref().unwrap()).unwrap();
        let status = start_captions_with_bearer(&state, None, || Some("test-bearer".into()))
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(&status).unwrap(), confirmed_status);
        assert_eq!(
            state.captions.lock().await.task.as_ref().unwrap().id(),
            task_id
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("opt-out-capture", "clip that", &[], 15.0)
                .is_none()
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("opt-out-capture", "clip that", &[], 20.0)
                .is_some()
        );
        state.recording.lock().await.take();
        finish_captions_for_capture(&state, "opt-out-capture").await;
        assert!(
            !state
                .clip_marks
                .lock()
                .unwrap()
                .register_recording("opt-out-capture")
        );
    }

    #[tokio::test]
    async fn privacy_teardown_and_failed_join_block_both_actual_caption_callbacks() {
        let state = test_caption_app_state();
        persist_clip_test_recording(&state, "privacy-a");
        let target = crate::clip_marks::MarkTarget {
            session_id: "privacy-a".into(),
            records_to_file: true,
        };
        crate::clip_marks::register_caption_target(&state, Some(&target));
        let mut session = test_caption_session(&state, true);
        session.mark_target = Some(target.clone());
        let sequence = CaptionSequence::default();
        let mut items = std::collections::HashMap::new();
        let timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 10.0,
            ms_sent: 2_000.0,
            capture_epoch: 0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            admission: AdmittedBuddyAudio::default(),
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "private-item".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        for (in_progress, failed) in [(true, false), (false, true)] {
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.privacy_teardown_in_progress = in_progress;
                coordinator.privacy_teardown_failed = failed;
            }
            let mut events = state.events.subscribe();
            commit_chunk_transcript(
                &session,
                &stamped_chunk(1, 10.0),
                true,
                &chunk_response("clip that", 60),
            )
            .await;
            handle_realtime_event(
                &session,
                RealtimeCaptionEvent::Completed {
                    item_id: "private-item".into(),
                    transcript: "clip that".into(),
                },
                &mut items,
                &sequence,
                timeline,
            )
            .await;
            assert!(drain_events(&mut events).is_empty());
            assert!(state.captions.lock().await.chunks.is_empty());
            assert!(!items["private-item"].clip_processed);
            assert!(
                crate::cohost::recent_speech_since(&state, None)
                    .unwrap()
                    .finals
                    .is_empty()
            );
            assert!(
                crate::clip_marks::list_marks(&state, "privacy-a")
                    .unwrap()
                    .is_empty()
            );
        }
        // No callback repopulated the post-purge matcher. Its first eligible
        // phrase still lands; a failed provider owner is then refused even
        // after a later empty runtime confirms its own (different) join.
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("privacy-a", "clip that", &[], 10.0)
                .is_some()
        );
        note_caption_provider_join(&state, Some(&target), false);
        note_caption_provider_join(&state, None, true);
        state.captions.lock().await.privacy_teardown_failed = false;
        assert!(
            !state
                .clip_marks
                .lock()
                .unwrap()
                .retire_recording("privacy-a")
        );
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("privacy-a", "clip that", &[], 30.0)
                .is_none()
        );
    }

    #[tokio::test]
    async fn an_unproven_signed_out_provider_cannot_write_after_an_empty_runtime_retry() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        for records_to_file in [true, false] {
            let state = test_caption_app_state();
            persist_clip_test_capture(&state, "failed-sign-out", records_to_file);
            let target = crate::clip_marks::MarkTarget {
                session_id: "failed-sign-out".into(),
                records_to_file,
            };
            crate::clip_marks::register_caption_target(&state, Some(&target));
            let mut session = test_caption_session(&state, true);
            session.mark_target = Some(target.clone());
            let timeline = RealtimeCaptionTimeline {
                capture_base_seconds: 10.0,
                ms_at_anchor: 0.0,
                socket_audio_base_ms: 0.0,
                ms_sent: 2_000.0,
                capture_epoch: 0,
                admission: AdmittedBuddyAudio::default(),
            };
            let sequence = CaptionSequence::default();
            let mut items = std::collections::HashMap::new();
            handle_realtime_event(
                &session,
                RealtimeCaptionEvent::SpeechStarted {
                    item_id: "pre-sign-out".into(),
                    audio_start_ms: Some(0.0),
                },
                &mut items,
                &sequence,
                timeline,
            )
            .await;
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
            let task = tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                let _ = finished_tx.send(());
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
                .await
                .unwrap()
                .unwrap();
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.task = Some(task);
                coordinator.task_mark_target = Some(target);
                coordinator.stop = Some(session.stop.clone());
            }
            let status = stop_captions_for_sign_out(&state, || {}).await;
            drop(release_tx);
            tokio::time::timeout(std::time::Duration::from_secs(2), finished_rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.state, CaptionsState::Blocked);
            assert!(session.stop.load(Ordering::Acquire));
            finish_captions_for_capture(&state, "failed-sign-out").await;
            for empty_retry in [false, true] {
                if empty_retry {
                    assert_eq!(
                        stop_captions_for_sign_out(&state, || {}).await.state,
                        CaptionsState::Idle
                    );
                    assert!(!state.captions.lock().await.privacy_teardown_in_progress);
                }
                let mut events = state.events.subscribe();
                commit_chunk_transcript(
                    &session,
                    &stamped_chunk(1, 10.0),
                    true,
                    &chunk_response("clip that", 60),
                )
                .await;
                handle_realtime_event(
                    &session,
                    RealtimeCaptionEvent::Completed {
                        item_id: "pre-sign-out".into(),
                        transcript: "clip that".into(),
                    },
                    &mut items,
                    &sequence,
                    timeline,
                )
                .await;
                assert!(drain_events(&mut events).is_empty());
                assert!(state.captions.lock().await.chunks.is_empty());
                assert!(
                    crate::cohost::recent_speech_since(&state, None)
                        .unwrap()
                        .finals
                        .is_empty()
                );
                assert!(!items["pre-sign-out"].clip_processed);
                assert!(
                    crate::clip_marks::list_marks(&state, "failed-sign-out")
                        .unwrap()
                        .is_empty()
                );
            }
            if records_to_file {
                assert!(
                    !state
                        .clip_marks
                        .lock()
                        .unwrap()
                        .retire_recording("failed-sign-out")
                );
            }
        }
    }

    #[tokio::test]
    async fn capture_ends_during_sign_out_retire_only_after_the_exact_provider_join() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        for cycle in 0..3 {
            let id = format!("sign-out-capture-{cycle}");
            let newer = format!("manual-capture-{cycle}");
            let target = crate::clip_marks::MarkTarget {
                session_id: id.clone(),
                records_to_file: true,
            };
            crate::clip_marks::register_caption_target(&state, Some(&target));
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            // Started blocking work cannot be aborted until released. This
            // controls the actual join barrier rather than polling a handle
            // to Ready and then accidentally awaiting it a second time.
            let task = tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
                .await
                .unwrap()
                .unwrap();
            let publication = {
                let mut coordinator = state.captions.lock().await;
                coordinator.task = Some(task);
                coordinator.task_mark_target = Some(target);
                coordinator.stop = Some(Arc::new(AtomicBool::new(false)));
                coordinator.artifact_publication.clone()
            };
            let publication_guard = publication.lock().await;
            let signing_out_state = state.clone();
            let signing_out =
                tokio::spawn(
                    async move { stop_captions_for_sign_out(&signing_out_state, || {}).await },
                );
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !state.captions.lock().await.privacy_teardown_in_progress {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                finish_captions_for_capture(&state, &id),
            )
            .await
            .unwrap();
            assert!(!state.captions.lock().await.privacy_provider_joined);
            assert!(
                state.clip_marks.lock().unwrap().register_recording(&id),
                "capture end cannot retire its still-unjoined provider"
            );
            release_tx.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !state.captions.lock().await.privacy_provider_joined {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!state.clip_marks.lock().unwrap().register_recording(&id));
            // End during later filesystem cleanup is independent of the
            // joined provider, including a manual-only newer recording.
            assert!(state.clip_marks.lock().unwrap().register_recording(&newer));
            finish_captions_for_capture(&state, &id).await;
            assert!(state.clip_marks.lock().unwrap().register_recording(&newer));
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                finish_captions_for_capture(&state, &newer),
            )
            .await
            .unwrap();
            assert!(!state.clip_marks.lock().unwrap().register_recording(&newer));
            assert!(!signing_out.is_finished());
            drop(publication_guard);
            let status = tokio::time::timeout(std::time::Duration::from_secs(2), signing_out)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.state, CaptionsState::Idle);
        }
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .register_recording("after-sign-out-cycles")
        );
    }

    #[tokio::test]
    async fn a_late_chunk_final_keeps_its_recording_mark_after_capture_epoch_changes() {
        let state = test_caption_app_state();
        persist_clip_test_recording(&state, "late-chunk-a");
        persist_clip_test_recording(&state, "late-chunk-b");
        state.captions.lock().await.capture_epoch = 1;
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("late-chunk-b"));
        let mut session = test_caption_session(&state, true);
        session.mark_target = Some(crate::clip_marks::MarkTarget {
            session_id: "late-chunk-a".to_string(),
            records_to_file: true,
        });
        crate::clip_marks::register_caption_target(&state, session.mark_target.as_ref());
        let mut events = state.events.subscribe();
        commit_chunk_transcript(
            &session,
            &stamped_chunk(1, 10.0),
            true,
            &chunk_response("clip that", 60),
        )
        .await;
        let emitted = drain_events(&mut events);
        assert!(caption_event_names(&emitted).is_empty());
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .is_empty()
        );
        let event = match emitted
            .into_iter()
            .find(|event| event.event == "clip.marked")
        {
            Some(event) => event,
            None => next_clip_event(&mut events).await,
        };
        assert_eq!(event.payload["sessionId"], "late-chunk-a");
        assert_eq!(event.payload["saved"], true);
        assert_eq!(
            crate::clip_marks::list_marks(&state, "late-chunk-a")
                .unwrap()
                .len(),
            1
        );
        assert!(
            crate::clip_marks::list_marks(&state, "late-chunk-b")
                .unwrap()
                .is_empty()
        );
        assert!(!state.captions.lock().await.chunks[0].presented);
        state
            .clip_marks
            .lock()
            .unwrap()
            .note_manual_mark("late-chunk-a", 40.0);
        commit_chunk_transcript(
            &session,
            &stamped_chunk(1, 10.0),
            true,
            &chunk_response("clip that", 60),
        )
        .await;
        assert_eq!(state.captions.lock().await.chunks.len(), 1);
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("late-chunk-a", "clip that", &[], 45.0)
                .is_none(),
            "the same completed chunk must not call the clip hook again"
        );
    }

    #[tokio::test]
    async fn a_late_realtime_final_keeps_its_mark_without_old_capture_presentation() {
        let state = test_caption_app_state();
        persist_clip_test_recording(&state, "late-realtime-a");
        let mut session = test_caption_session(&state, true);
        session.mark_target = Some(crate::clip_marks::MarkTarget {
            session_id: "late-realtime-a".to_string(),
            records_to_file: true,
        });
        crate::clip_marks::register_caption_target(&state, session.mark_target.as_ref());
        let mut items = std::collections::HashMap::new();
        let sequence = CaptionSequence::default();
        let old_timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 10.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 2_000.0,
            capture_epoch: 0,
            admission: AdmittedBuddyAudio::test_epoch(0),
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "old-a".to_string(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            old_timeline,
        )
        .await;
        // Exercise the actual retirement seam called by realtime re-anchor.
        retire_realtime_caption_items(&mut items, 0, 12.0);
        sequence.reset();
        state.captions.lock().await.capture_epoch = 1;
        let current_timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 0.0,
            ms_sent: 1_000.0,
            capture_epoch: 1,
            ..old_timeline
        };
        let mut events = state.events.subscribe();
        for event in [
            RealtimeCaptionEvent::Partial {
                item_id: "old-a".to_string(),
                transcript: "clip th".to_string(),
            },
            RealtimeCaptionEvent::Completed {
                item_id: "old-a".to_string(),
                transcript: "clip that".to_string(),
            },
        ] {
            handle_realtime_event(&session, event, &mut items, &sequence, current_timeline).await;
        }
        let emitted = drain_events(&mut events);
        assert!(caption_event_names(&emitted).is_empty());
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .is_empty()
        );
        let event = match emitted
            .into_iter()
            .find(|event| event.event == "clip.marked")
        {
            Some(event) => event,
            None => next_clip_event(&mut events).await,
        };
        assert_eq!(event.payload["sessionId"], "late-realtime-a");
        assert_eq!(event.payload["atSeconds"], 10.0);
        assert_eq!(event.payload["saved"], true);
        {
            let coordinator = state.captions.lock().await;
            let cue = &coordinator.chunks[0];
            assert_eq!(cue.capture_epoch, 0);
            assert_eq!(cue.offset_seconds, 10.0);
            assert_eq!(cue.duration_seconds, 2.0);
            assert!(!cue.presented);
        }
        state
            .clip_marks
            .lock()
            .unwrap()
            .note_manual_mark("late-realtime-a", 40.0);
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "old-a".into(),
                transcript: "clip that".into(),
            },
            &mut items,
            &sequence,
            current_timeline,
        )
        .await;
        assert!(
            state
                .clip_marks
                .lock()
                .unwrap()
                .note_final("late-realtime-a", "clip that", &[], 45.0)
                .is_none(),
            "repeated provider completions must call the clip hook only once"
        );
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "new-a".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            current_timeline,
        )
        .await;
        assert_eq!(items["old-a"].seq, items["new-a"].seq);
        assert_ne!(items["old-a"].capture_epoch, items["new-a"].capture_epoch);
    }

    #[tokio::test]
    async fn realtime_item_retention_refuses_unknown_pruned_and_unregistered_clip_owners() {
        let state = test_caption_app_state();
        persist_clip_test_recording(&state, "item-a");
        let target = crate::clip_marks::MarkTarget {
            session_id: "item-a".into(),
            records_to_file: true,
        };
        crate::clip_marks::register_caption_target(&state, Some(&target));
        let mut session = test_caption_session(&state, true);
        session.mark_target = Some(target.clone());
        let sequence = CaptionSequence::default();
        let mut items = std::collections::HashMap::new();
        for index in 0..MAX_REALTIME_CAPTION_ITEMS {
            assert!(
                realtime_item_entry(
                    &mut items,
                    &sequence,
                    &format!("item-{index}"),
                    10.0,
                    0,
                    AdmittedBuddyAudio::default(),
                    Some(target.clone())
                )
                .is_some()
            );
        }
        assert!(
            realtime_item_entry(
                &mut items,
                &sequence,
                "overflow",
                10.0,
                0,
                AdmittedBuddyAudio::default(),
                Some(target.clone())
            )
            .is_none()
        );
        assert_eq!(items.len(), MAX_REALTIME_CAPTION_ITEMS);
        items.get_mut("item-0").unwrap().clip_processed = true;
        assert!(
            realtime_item_entry(
                &mut items,
                &sequence,
                "fresh-item",
                10.0,
                1,
                AdmittedBuddyAudio::default(),
                Some(target)
            )
            .is_some()
        );
        assert!(!items.contains_key("item-0"));
        assert_eq!(items.len(), MAX_REALTIME_CAPTION_ITEMS);
        {
            let mut detector = state.clip_marks.lock().unwrap();
            detector.retire_recording("item-a");
            assert!(detector.register_recording("item-b"));
            assert!(detector.register_recording("item-c"));
        }
        state.captions.lock().await.capture_epoch = 1;
        let timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 0.0,
            ms_sent: 1_000.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            capture_epoch: 1,
            admission: AdmittedBuddyAudio::default(),
        };
        let mut events = state.events.subscribe();
        for id in ["unknown", "item-0", "item-1"] {
            handle_realtime_event(
                &session,
                RealtimeCaptionEvent::Completed {
                    item_id: id.into(),
                    transcript: "clip that".into(),
                },
                &mut items,
                &sequence,
                timeline,
            )
            .await;
        }
        assert!(caption_event_names(&drain_events(&mut events)).is_empty());
        let coordinator = state.captions.lock().await;
        assert_eq!(
            coordinator.chunks.len(),
            1,
            "only the known item keeps its canonical old cue"
        );
        assert!(!coordinator.chunks[0].presented);
        drop(coordinator);
        assert!(items["item-1"].clip_processed);
        assert!(
            crate::clip_marks::list_marks(&state, "item-a")
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .is_empty()
        );
    }

    #[tokio::test]
    async fn capture_admission_waits_for_the_old_caption_drain_before_recording_replacement() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        for records_to_file in [true, false] {
            let state = test_caption_app_state();
            persist_clip_test_capture(&state, "drain-a", records_to_file);
            persist_clip_test_recording(&state, "drain-b");
            let capture_permit = state.ffmpeg_work.begin_capture_when_available().await;
            let mut active_a = crate::recording::test_active_recording_stub("drain-a");
            if records_to_file {
                active_a.output_path = Some(std::path::PathBuf::from("/tmp/drain-a.mp4"));
            }
            *state.recording.lock().await = Some(active_a);
            let (_, target_a) = caption_capture_facts(state.recording.lock().await.as_ref());
            let mut session = test_caption_session(&state, true);
            session.mark_target = target_a;
            crate::clip_marks::register_caption_target(&state, session.mark_target.as_ref());
            session.receiver = install_tap();
            let present = session.present.clone();
            let stop = session.stop.clone();
            let task_mark_target = session.mark_target.clone();
            let (draining_tx, draining_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                while session.receiver.recv().await.is_some() {}
                draining_tx.send(()).expect("provider drain boundary");
                let _ = release_rx.await;
                // Only the provider response is controlled. Final routing is
                // the actual callback, after the recording slot was retired.
                commit_chunk_transcript(
                    &session,
                    &stamped_chunk(1, 10.0),
                    true,
                    &chunk_response("clip that", 60),
                )
                .await;
            });
            let old_task_id = task.id();
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.task = Some(task);
                coordinator.task_mark_target = task_mark_target;
                coordinator.stop = Some(stop);
                coordinator.desired_enabled = true;
                coordinator.listen_wanted = true;
                coordinator.presentation = Some(present);
                coordinator.status = Some(CaptionsStatus::active(
                    CaptionsState::Listening,
                    CaptionsTransport::Chunked,
                    "captions-drain-a",
                ));
            }
            let generation = reserve_caption_session_start(&state).await.unwrap();
            let status = start_captions_with_bearer_for_session(
                &state,
                Some(("drain-a", generation)),
                None,
                || Some("test-bearer".to_string()),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(status.state, CaptionsState::Listening);
            assert_eq!(
                state.captions.lock().await.task.as_ref().unwrap().id(),
                old_task_id,
                "an authorized task is reused within the same capture"
            );

            // Match monitor_session: finalization owns the gate before A's
            // slot becomes reusable, and holds it past provider/artifact drain.
            let finalizing_permit = state.ffmpeg_work.begin_finalizing();
            let retired_a = state.recording.lock().await.take().unwrap();
            drop(retired_a);
            drop(capture_permit);
            stop_listen_with(&state, ListenStop::DrainWithCapture).await;
            let replacement_state = state.clone();
            let replacement = tokio::spawn(async move {
                let permit = replacement_state
                    .ffmpeg_work
                    .begin_capture_when_available()
                    .await;
                *replacement_state.recording.lock().await =
                    Some(crate::recording::test_active_recording_stub("drain-b"));
                let generation = reserve_caption_session_start(&replacement_state)
                    .await
                    .unwrap();
                let result = start_captions_with_bearer_for_session(
                    &replacement_state,
                    Some(("drain-b", generation)),
                    None,
                    || Some("test-bearer".to_string()),
                )
                .await;
                (permit, result)
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while state.ffmpeg_work.snapshot().capture_waiting == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("replacement capture reached the production admission gate");
            assert!(state.recording.lock().await.is_none());
            let mut events = state.events.subscribe();
            let finishing_state = state.clone();
            let finishing = tokio::spawn(async move {
                finish_captions_for_capture(&finishing_state, "drain-a").await
            });
            tokio::time::timeout(std::time::Duration::from_secs(2), draining_rx)
                .await
                .expect("capture finish closed the provider tap")
                .expect("provider reached final response barrier");
            assert!(!replacement.is_finished());
            assert!(!finishing.is_finished());
            assert!(state.recording.lock().await.is_none());
            release_tx
                .send(())
                .expect("release final provider response");
            tokio::time::timeout(std::time::Duration::from_secs(2), finishing)
                .await
                .expect("caption drain deadline")
                .expect("caption drain task");
            let event = next_clip_event(&mut events).await;
            assert_eq!(event.payload["sessionId"], "drain-a");
            assert_eq!(event.payload["saved"], records_to_file);
            assert!(state.captions.lock().await.task.is_none());
            assert!(!TAP_ACTIVE.load(Ordering::Acquire));
            assert!(!replacement.is_finished());
            drop(finalizing_permit);
            let (replacement_permit, result) =
                tokio::time::timeout(std::time::Duration::from_secs(2), replacement)
                    .await
                    .expect("capture starts after finalization")
                    .expect("replacement task");
            // The stub has no microphone: the fresh start truthfully refuses
            // instead of adopting the now-joined A task as B's provider.
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Select an available microphone")
            );
            assert!(state.captions.lock().await.task.is_none());
            assert_eq!(
                state.recording.lock().await.as_ref().unwrap().session_id,
                "drain-b"
            );
            assert!(
                crate::clip_marks::list_marks(&state, "drain-b")
                    .unwrap()
                    .is_empty()
            );
            drop(replacement_permit);
        }
    }

    /// Finding 10: captions turned off while an upload was in flight never
    /// show its final; the record and Buddy still get it.
    #[tokio::test]
    async fn a_final_after_captions_turned_off_never_shows() {
        let state = test_caption_app_state();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.listen_wanted = true;
            coordinator.speech_admitted = true;
        }
        let mut events = state.events.subscribe();
        let session = test_caption_session(&state, true);
        commit_chunk_transcript(
            &session,
            &stamped_chunk(1, 0.0),
            true,
            &chunk_response("one", 9),
        )
        .await;
        let emitted = drain_events(&mut events);
        let update = emitted
            .iter()
            .find(|event| event.event == "captions.update")
            .expect("a presented final shows");
        assert_eq!(update.payload["remainingSeconds"], 9);

        // The upload was sent while presenting; captions.stop lands before
        // its answer.
        session.present.store(false, Ordering::Release);
        commit_chunk_transcript(
            &session,
            &stamped_chunk(2, 3.0),
            true,
            &chunk_response("two", 6),
        )
        .await;
        assert!(
            caption_event_names(&drain_events(&mut events)).is_empty(),
            "no captions.update after the caption boundary"
        );
        let coordinator = state.captions.lock().await;
        assert_eq!(coordinator.chunks.len(), 2);
        assert!(coordinator.chunks[0].presented);
        assert!(!coordinator.chunks[1].presented);
        drop(coordinator);
        let speech = crate::cohost::recent_speech_since(&state, None).expect("speech");
        assert_eq!(speech.finals.len(), 2);
        assert_eq!(speech.finals[1].text, "two");
    }

    /// Finding 11: quiet is not "still starting", and the listen allowance
    /// refreshes from listen-metered answers at most every 30 s.
    #[test]
    fn listen_readiness_reports_on_in_quiet_and_throttles_the_allowance() {
        use crate::cohost::CohostListening;
        let now = std::time::Instant::now();
        let mut quiet = ListenReadiness::default();
        // No frames yet: a skipped chunk proves nothing.
        assert_eq!(quiet.silent_chunk_skipped(false), None);
        assert_eq!(
            quiet.silent_chunk_skipped(true),
            Some(CohostListening::on(None))
        );
        assert_eq!(quiet.silent_chunk_skipped(true), None);
        // The first listen-metered answer brings the allowance at once...
        assert_eq!(
            quiet.upload_succeeded(Some(500), now),
            Some(CohostListening::on(Some(500)))
        );
        // ...then at most every 30 s.
        assert_eq!(quiet.upload_succeeded(Some(497), now + secs(3)), None);
        assert_eq!(quiet.upload_succeeded(Some(470), now + secs(29)), None);
        assert_eq!(
            quiet.upload_succeeded(Some(467), now + secs(30)),
            Some(CohostListening::on(Some(467)))
        );
        // A caption-metered answer carries no listen allowance.
        let mut captions_first = ListenReadiness::default();
        assert_eq!(
            captions_first.upload_succeeded(None, now),
            Some(CohostListening::on(None))
        );
        assert_eq!(captions_first.upload_succeeded(None, now + secs(40)), None);
        assert_eq!(
            captions_first.upload_succeeded(Some(10), now + secs(41)),
            Some(CohostListening::on(Some(10)))
        );
    }

    fn secs(value: u64) -> std::time::Duration {
        std::time::Duration::from_secs(value)
    }

    /// Finding 11: a listen intent that joins a task already proven ready
    /// reads `on` at once, not `starting`.
    #[tokio::test]
    async fn shared_provider_readiness_preserves_blocked_or_ended_marker_status() {
        let state = test_caption_app_state();
        let session = test_caption_session(&state, true);
        let mut events = state.events.subscribe();
        for blocked in [
            crate::cohost::CohostListening::blocked("voice-disabled", "Paused"),
            crate::cohost::CohostListening::blocked("consent-required", "Consent required"),
            crate::cohost::CohostListening::off(),
        ] {
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.listen_wanted = true;
                coordinator.listen_epoch = 7;
                coordinator.listen_ready = false;
                coordinator.marker_session_id = Some("capture-a".into());
                coordinator.marker_started_at = None;
                coordinator.marker_listening = Some(blocked.clone());
            }
            session
                .note_listen_ready(Some(7), crate::cohost::CohostListening::on(None))
                .await;
            tokio::task::yield_now().await;
            let coordinator = state.captions.lock().await;
            assert!(coordinator.listen_ready);
            assert_eq!(coordinator.marker_listening.as_ref(), Some(&blocked));
            drop(coordinator);
            assert!(
                drain_events(&mut events)
                    .iter()
                    .all(|event| event.event != "session.marker.voice.status")
            );
        }
        state.captions.lock().await.marker_started_at = Some(std::time::Instant::now());
        session
            .note_listen_ready(Some(7), crate::cohost::CohostListening::on(None))
            .await;
        assert_eq!(
            state.captions.lock().await.marker_listening,
            Some(crate::cohost::CohostListening::on(None))
        );
        assert!(
            drain_events(&mut events)
                .iter()
                .any(|event| event.event == "session.marker.voice.status")
        );
    }

    #[tokio::test]
    async fn listen_joining_a_ready_task_is_on_at_once() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("ready-join"));
        install_intent_test_task(&state, true, false).await;
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.shadow_status.as_mut().unwrap().provider_ready = false;
        }
        let listening =
            start_listen_with_bearer(&state, "buddy", || Some("test-bearer".into())).await;
        assert_eq!(listening, crate::cohost::CohostListening::starting());
        let session = test_caption_session(&state, true);
        session
            .note_listen_ready(
                session.admitted_listen_epoch().await,
                crate::cohost::CohostListening::on(None),
            )
            .await;
        let listening =
            start_listen_with_bearer(&state, "buddy", || Some("test-bearer".into())).await;
        assert_eq!(listening, crate::cohost::CohostListening::on(None));
        stop_captions(&state).await;
        stop_listen(&state).await;
        *state.recording.lock().await = None;
    }

    /// Finding 2: at a capture end Buddy's stop only clears the listen
    /// intent; the listen-only task lives on until the capture seam drains it.
    /// An explicit stop still aborts at once.
    #[tokio::test]
    async fn a_capture_end_drains_the_listen_task_and_an_explicit_stop_aborts_it() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let mut events = state.events.subscribe();

        install_intent_test_task(&state, false, true).await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        stop_listen_with(&state, ListenStop::DrainWithCapture).await;
        {
            let coordinator = state.captions.lock().await;
            assert!(!coordinator.listen_wanted);
            assert!(
                coordinator_task_alive(&coordinator),
                "the task drains later"
            );
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
        }
        assert!(
            TAP_ACTIVE.load(Ordering::Acquire),
            "the tap keeps feeding it"
        );
        // The capture seam closes the tap and joins the drained task.
        finish_captions_for_capture(&state, "caption-artifact-test").await;
        assert!(state.captions.lock().await.task.is_none());
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));

        // session.stop with no capture running: nothing to drain with.
        install_intent_test_task(&state, false, true).await;
        stop_listen_with(&state, ListenStop::DrainIfCapturing).await;
        assert!(state.captions.lock().await.task.is_none());

        // session.stop while capturing: drains.
        *state.recording.lock().await =
            Some(crate::recording::test_active_recording_stub("draining"));
        install_intent_test_task(&state, false, true).await;
        stop_listen_with(&state, ListenStop::DrainIfCapturing).await;
        assert!(coordinator_task_alive(&*state.captions.lock().await));
        *state.recording.lock().await = None;
        finish_captions_for_capture(&state, "caption-artifact-test").await;
        assert!(state.captions.lock().await.task.is_none());

        // An explicit stop (Buddy off, listening off) aborts at once.
        install_intent_test_task(&state, false, true).await;
        stop_listen_with(&state, ListenStop::Abort).await;
        assert!(state.captions.lock().await.task.is_none());
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
        drain_events(&mut events);
    }

    /// Finding 2: a voice mark carries the capture the task transcribes, read
    /// when the task started, so the capture-end drain needs no slot.
    #[tokio::test]
    async fn the_caption_task_carries_its_capture_to_every_final() {
        let mut active = crate::recording::test_active_recording_stub("marked-stream");
        let (eligible, target) = caption_capture_facts(Some(&active));
        assert!(!eligible);
        assert_eq!(
            target,
            Some(crate::clip_marks::MarkTarget {
                session_id: "marked-stream".to_string(),
                records_to_file: false,
            })
        );
        active.output_path = Some(std::path::PathBuf::from("/tmp/marked-stream.mp4"));
        let (_, target) = caption_capture_facts(Some(&active));
        assert!(target.is_some_and(|target| target.records_to_file));
        assert_eq!(caption_capture_facts(None), (false, None));

        let state = test_caption_app_state();
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.listen_wanted = true;
            coordinator.speech_admitted = true;
        }
        let mut session = test_caption_session(&state, false);
        session.mark_target = Some(crate::clip_marks::MarkTarget {
            session_id: "marked-stream".to_string(),
            records_to_file: true,
        });
        commit_chunk_transcript(
            &session,
            &stamped_chunk(1, 9.0),
            false,
            &chunk_response("hi", 1),
        )
        .await;
        let speech = crate::cohost::recent_speech_since(&state, None).expect("speech");
        assert_eq!(speech.finals[0].offset_seconds, 9.0);
        assert!(!speech.finals[0].presented);
        assert_eq!(
            session.mark_target.as_ref().unwrap().session_id,
            "marked-stream"
        );
    }

    /// Finding 4: sign-out ends Buddy's listening in the state too, and a
    /// listening publish decided before an intent ended never lands after.
    #[tokio::test]
    async fn consent_revocation_keeps_explicit_captions_and_fences_old_listen_publications() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        *state.recording.lock().await = Some(crate::recording::test_active_recording_stub(
            "consent-capture",
        ));
        let present = install_intent_test_task(&state, true, false).await;
        state
            .live_chat
            .lock()
            .await
            .start_session("consent-chat".into(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let params = crate::protocol::CohostStartParams {
            session_id: "consent-chat".into(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        let (task_id, capture_epoch, listen_epoch) = {
            let coordinator = state.captions.lock().await;
            (
                coordinator.task.as_ref().unwrap().id(),
                coordinator.capture_epoch,
                coordinator.listen_epoch,
            )
        };
        let mut events = state.events.subscribe();
        let revoked = crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                consent_to_process_chat: false,
                ..params.clone()
            },
        )
        .await
        .unwrap();
        {
            let coordinator = state.captions.lock().await;
            assert!(!coordinator.listen_wanted);
            assert!(coordinator.desired_enabled);
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert_eq!(coordinator.capture_epoch, capture_epoch);
            assert!(coordinator.listen_epoch > listen_epoch);
        }
        assert!(present.load(Ordering::Acquire));
        assert!(TAP_ACTIVE.load(Ordering::Acquire));
        assert_eq!(
            revoked.reason,
            Some(crate::cohost::CohostReason::ConsentRequired)
        );
        let epoch_after_revoke = current_listen_epoch(&state).await;
        drain_events(&mut events);
        crate::cohost::publish_listening_for_epoch(
            &state,
            listen_epoch,
            crate::cohost::CohostListening::on(Some(90)),
        )
        .await;
        assert!(
            drain_events(&mut events).is_empty(),
            "old speech readiness cannot publish after revoke"
        );
        assert_eq!(crate::cohost::cohost_status(&state).await, revoked);
        // The same caption task continues to present its authorized finals.
        commit_chunk_transcript(
            &test_caption_session(&state, true),
            &stamped_chunk(1, 0.0),
            true,
            &chunk_response("explicit captions remain", 1),
        )
        .await;
        assert!(
            caption_event_names(&drain_events(&mut events)).contains(&"captions.update".into())
        );
        crate::cohost::start_cohost(&state, params).await.unwrap();
        let coordinator = state.captions.lock().await;
        assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
        assert_eq!(coordinator.capture_epoch, capture_epoch);
        assert!(coordinator.listen_epoch > epoch_after_revoke);
        assert!(coordinator.listen_wanted);
        drop(coordinator);
        assert!(state.recording.lock().await.is_some());
        assert_eq!(
            state.live_chat.lock().await.session_id(),
            Some("consent-chat")
        );
        crate::cohost::stop_cohost(&state).await;
        stop_captions(&state).await;
        *state.recording.lock().await = None;
    }

    #[tokio::test]
    async fn replacing_cohost_session_retires_retained_listen_readiness() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        install_intent_test_task(&state, true, false).await;
        state
            .live_chat
            .lock()
            .await
            .start_session("old-listen-chat".into(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                session_id: "old-listen-chat".into(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        let session = test_caption_session(&state, true);
        let admitted = session.admitted_buddy_audio().await;
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        assert!(admitted.listen_epoch.is_some());
        // The RPC validates the new authoritative chat while the old Buddy
        // engine and an explicit caption task are still present.
        state
            .live_chat
            .lock()
            .await
            .start_session("new-listen-chat".into(), Vec::new());
        let params = crate::protocol::CohostStartParams {
            session_id: "new-listen-chat".into(),
            consent_to_process_chat: false,
            stream_title: None,
        };
        let replacement = crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        assert_eq!(replacement.session_id.as_deref(), Some("new-listen-chat"));
        assert_eq!(replacement.status, crate::cohost::CohostStatus::Paused);
        assert_eq!(
            replacement.reason,
            Some(crate::cohost::CohostReason::ConsentRequired)
        );
        assert_eq!(
            replacement
                .listening
                .as_ref()
                .unwrap()
                .reason_code
                .as_deref(),
            Some("consent-required")
        );
        {
            let coordinator = state.captions.lock().await;
            assert!(!coordinator.listen_wanted);
            assert!(!coordinator.listen_ready);
            assert!(coordinator.listen_epoch > admitted.listen_epoch.unwrap());
            assert_eq!(coordinator.task.as_ref().unwrap().id(), task_id);
            assert!(coordinator.desired_enabled);
        }
        let mut events = state.events.subscribe();
        session
            .note_listen_ready(
                admitted.listen_epoch,
                crate::cohost::CohostListening::on(Some(60)),
            )
            .await;
        crate::cohost::publish_listening_for_epoch(
            &state,
            admitted.listen_epoch.unwrap(),
            crate::cohost::CohostListening::on(Some(60)),
        )
        .await;
        assert!(drain_events(&mut events).is_empty());
        assert_eq!(crate::cohost::cohost_status(&state).await, replacement);
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                consent_to_process_chat: true,
                ..params
            },
        )
        .await
        .unwrap();
        drain_events(&mut events);
        state.captions.lock().await.listen_ready = false;
        session
            .note_listen_ready(
                admitted.listen_epoch,
                crate::cohost::CohostListening::on(Some(60)),
            )
            .await;
        crate::cohost::publish_listening_for_epoch(
            &state,
            admitted.listen_epoch.unwrap(),
            crate::cohost::CohostListening::on(Some(60)),
        )
        .await;
        assert!(!state.captions.lock().await.listen_ready);
        assert!(drain_events(&mut events).is_empty());
        crate::cohost::stop_cohost(&state).await;
        stop_captions(&state).await;
    }

    #[tokio::test]
    async fn buddy_speech_grant_respects_privacy_and_shutdown_guards() {
        let state = test_caption_app_state();
        let session = test_caption_session(&state, true);
        for (in_progress, failed) in [(true, false), (false, true)] {
            {
                let mut coordinator = state.captions.lock().await;
                coordinator.privacy_teardown_in_progress = in_progress;
                coordinator.privacy_teardown_failed = failed;
            }
            grant_buddy_speech(&state).await;
            assert_eq!(session.admitted_buddy_audio().await.speech_epoch, None);
            assert_eq!(state.captions.lock().await.speech_started_at, None);
        }
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.privacy_teardown_failed = false;
        }
        grant_buddy_speech(&state).await;
        let admitted = session.admitted_buddy_audio().await;
        let grant = state.captions.lock().await.speech_started_at;
        assert!(admitted.speech_epoch.is_some());
        grant_buddy_speech(&state).await;
        assert_eq!(state.captions.lock().await.speech_started_at, grant);
        retire_buddy_speech(&state).await;
        assert!(state.request_process_shutdown());
        grant_buddy_speech(&state).await;
        assert_eq!(session.admitted_buddy_audio().await.speech_epoch, None);
        assert_eq!(state.captions.lock().await.speech_started_at, None);
    }

    #[tokio::test]
    async fn caption_only_finals_follow_consent_without_enabling_listen() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        install_intent_test_task(&state, true, false).await;
        state
            .live_chat
            .lock()
            .await
            .start_session("caption-only-consent".into(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let params = crate::protocol::CohostStartParams {
            session_id: "caption-only-consent".into(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        let session = test_caption_session(&state, true);
        let mut items = std::collections::HashMap::new();
        let sequence = CaptionSequence::default();
        let timeline = RealtimeCaptionTimeline {
            capture_base_seconds: 0.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 3_000.0,
            capture_epoch: 0,
            admission: session.admitted_buddy_audio().await,
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "caption-only-before".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "caption-only-before".into(),
                transcript: "caption-only realtime before".into(),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        let mut before = stamped_chunk(2, 3.0);
        before.admission = timeline.admission;
        commit_chunk_transcript(
            &session,
            &before,
            true,
            &chunk_response("caption-only chunk before", 9),
        )
        .await;
        assert_eq!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .len(),
            2,
            "explicit captions feed consenting Buddy even with its listen switch off"
        );
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "caption-only-late".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                consent_to_process_chat: false,
                ..params.clone()
            },
        )
        .await
        .unwrap();
        commit_chunk_transcript(
            &session,
            &stamped_chunk(3, 6.0),
            true,
            &chunk_response("caption-only revoked", 8),
        )
        .await;
        assert!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(std::time::Instant::now())
                .text
                .is_empty()
        );
        crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "caption-only-late".into(),
                transcript: "caption-only retired realtime".into(),
            },
            &mut items,
            &sequence,
            timeline,
        )
        .await;
        assert!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(std::time::Instant::now())
                .text
                .is_empty()
        );
        let mut fresh = stamped_chunk(4, 9.0);
        fresh.admission = session.admitted_buddy_audio().await;
        commit_chunk_transcript(
            &session,
            &fresh,
            true,
            &chunk_response("caption-only fresh", 7),
        )
        .await;
        assert_eq!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals[0]
                .text,
            "caption-only fresh"
        );
        let fresh_timeline = RealtimeCaptionTimeline {
            admission: fresh.admission,
            ..timeline
        };
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "caption-only-fresh".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            fresh_timeline,
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "caption-only-fresh".into(),
                transcript: "caption-only fresh realtime".into(),
            },
            &mut items,
            &sequence,
            fresh_timeline,
        )
        .await;
        assert_eq!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .len(),
            2
        );
        assert!(!state.captions.lock().await.listen_wanted);
        assert!(state.captions.lock().await.desired_enabled);
        assert_eq!(
            crate::cohost::cohost_status(&state)
                .await
                .listening
                .unwrap()
                .state,
            crate::cohost::CohostListeningState::Off
        );
        // Sign-out retires this independent owner; sign-in restores speech
        // for a consenting session even while Listen remains off.
        let before_sign_in = fresh.admission;
        retire_buddy_speech(&state).await;
        assert_eq!(session.admitted_buddy_audio().await.speech_epoch, None);
        crate::cohost::resume_listen_after_sign_in(&state).await;
        let resumed = session.admitted_buddy_audio().await;
        assert!(resumed.speech_epoch.is_some());
        assert_ne!(resumed.speech_epoch, before_sign_in.speech_epoch);
        assert_eq!(resumed.listen_epoch, None);
        assert!(!state.captions.lock().await.listen_wanted);
        commit_chunk_transcript(
            &session,
            &fresh,
            true,
            &chunk_response("signed-out owner", 7),
        )
        .await;
        assert_eq!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .len(),
            2
        );
        fresh.admission = resumed;
        let fresh_timeline = RealtimeCaptionTimeline {
            admission: resumed,
            ..fresh_timeline
        };
        // Listening may turn on/off without revoking consenting speech. A
        // chunk crossing only that setting keeps speech but loses readiness.
        let speech_grant = state.captions.lock().await.speech_started_at;
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                listen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let with_listen = session.admitted_buddy_audio().await;
        let mut buffer = CaptionChunkBuffer::new(4, 8);
        let mut chunk_timeline = CaptionTimeline::new(12.0);
        buffer.push_samples(vec![1; 2], 0, with_listen, &sequence, &mut chunk_timeline);
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                listen: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let without_listen = session.admitted_buddy_audio().await;
        assert_eq!(with_listen.speech_epoch, without_listen.speech_epoch);
        assert_eq!(state.captions.lock().await.speech_started_at, speech_grant);
        buffer.push_samples(
            vec![1; 2],
            0,
            without_listen,
            &sequence,
            &mut chunk_timeline,
        );
        let mixed_listen = buffer.pop_front().unwrap();
        assert_eq!(
            mixed_listen.admission.speech_epoch,
            fresh.admission.speech_epoch
        );
        assert_eq!(mixed_listen.admission.listen_epoch, None);
        commit_chunk_transcript(
            &session,
            &mixed_listen,
            true,
            &chunk_response("same consenting speech", 6),
        )
        .await;
        assert_eq!(
            crate::cohost::recent_speech_since(&state, None)
                .unwrap()
                .finals
                .len(),
            3
        );
        // Reasserting unchanged consent preserves the input-origin boundary.
        crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        assert_eq!(state.captions.lock().await.speech_started_at, speech_grant);
        // Normal stop and replacement both reject old callback owners, while
        // explicit captions continue to present their transcript.
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::SpeechStarted {
                item_id: "caption-only-stopped".into(),
                audio_start_ms: Some(0.0),
            },
            &mut items,
            &sequence,
            fresh_timeline,
        )
        .await;
        crate::cohost::stop_cohost(&state).await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "caption-only-stopped".into(),
                transcript: "stopped realtime speech".into(),
            },
            &mut items,
            &sequence,
            fresh_timeline,
        )
        .await;
        commit_chunk_transcript(&session, &fresh, true, &chunk_response("stopped speech", 5)).await;
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .is_none_or(|speech| speech.finals.is_empty())
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("replacement-consent".into(), Vec::new());
        let replacement = crate::protocol::CohostStartParams {
            session_id: "replacement-consent".into(),
            ..params
        };
        crate::cohost::start_cohost(&state, replacement.clone())
            .await
            .unwrap();
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "caption-only-stopped".into(),
                transcript: "replaced realtime speech".into(),
            },
            &mut items,
            &sequence,
            fresh_timeline,
        )
        .await;
        commit_chunk_transcript(
            &session,
            &fresh,
            true,
            &chunk_response("replaced speech", 4),
        )
        .await;
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .is_none_or(|speech| speech.finals.is_empty())
        );
        let replacement_owner = session.admitted_buddy_audio().await;
        let delivery = state.live_chat_persistence.begin_delivery().await;
        crate::cohost::stop_cohost_for_session_end_if_matching_before_emit(
            &state,
            "caption-only-consent",
            &delivery,
            std::future::ready(()),
        )
        .await;
        assert_eq!(session.admitted_buddy_audio().await, replacement_owner);
        crate::cohost::stop_cohost_for_session_end_if_matching_before_emit(
            &state,
            "replacement-consent",
            &delivery,
            std::future::ready(()),
        )
        .await;
        drop(delivery);
        let mut replacement_chunk = stamped_chunk(10, 20.0);
        replacement_chunk.admission = replacement_owner;
        commit_chunk_transcript(
            &session,
            &replacement_chunk,
            true,
            &chunk_response("matching stop speech", 3),
        )
        .await;
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .is_none_or(|speech| speech.finals.is_empty())
        );
        crate::cohost::start_cohost(&state, replacement)
            .await
            .unwrap();
        replacement_chunk.admission = session.admitted_buddy_audio().await;
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        commit_chunk_transcript(
            &session,
            &replacement_chunk,
            true,
            &chunk_response("disabled speech", 2),
        )
        .await;
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .is_none_or(|speech| speech.finals.is_empty())
        );
        assert!(state.captions.lock().await.desired_enabled);
        assert!(
            state
                .captions
                .lock()
                .await
                .chunks
                .iter()
                .any(|chunk| chunk.text == "disabled speech" && chunk.presented)
        );
        stop_captions(&state).await;
    }

    #[tokio::test]
    async fn admitted_speech_cannot_join_buddy_after_revoke_and_regrant() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        install_intent_test_task(&state, true, false).await;
        state
            .live_chat
            .lock()
            .await
            .start_session("speech-consent".into(), Vec::new());
        crate::cohost::set_cohost_settings(
            &state,
            crate::protocol::CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let params = crate::protocol::CohostStartParams {
            session_id: "speech-consent".into(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        crate::cohost::start_cohost(&state, params.clone())
            .await
            .unwrap();
        let mut session = test_caption_session(&state, true);
        session.mark_target = Some(crate::clip_marks::MarkTarget {
            session_id: "immutable-recording".into(),
            records_to_file: false,
        });
        let old_epoch = session.admitted_buddy_audio().await;
        let (queued_tx, queued_rx) = mpsc::channel(2);
        session.receiver = queued_rx;
        let raw_frame = |captured_at| AudioFrame {
            timestamp_micros: 0,
            captured_at,
            sample_rate: 16_000,
            channels: 1,
            samples: vec![0.1; 320],
        };
        queued_tx
            .send(raw_frame(std::time::Instant::now()))
            .await
            .unwrap();
        let task_id = state.captions.lock().await.task.as_ref().unwrap().id();
        let sequence = CaptionSequence::default();
        let mut chunk_timeline = CaptionTimeline::new(0.0);
        let mut buffer = CaptionChunkBuffer::new(4, 8);
        buffer.push_samples(vec![1; 4], 0, old_epoch, &sequence, &mut chunk_timeline);
        buffer.push_samples(vec![1; 2], 0, old_epoch, &sequence, &mut chunk_timeline);
        let mut audio_epochs = RealtimeAudioAdmissions::default();
        audio_epochs.record(30_000.0, old_epoch);
        let mut items = std::collections::HashMap::new();
        let realtime_timeline = |admission| RealtimeCaptionTimeline {
            capture_base_seconds: 0.0,
            ms_at_anchor: 0.0,
            socket_audio_base_ms: 0.0,
            ms_sent: 90_000.0,
            capture_epoch: 0,
            admission,
        };
        let old_started = RealtimeCaptionEvent::SpeechStarted {
            item_id: "old-speech".into(),
            audio_start_ms: Some(20_000.0),
        };
        let epoch = audio_epochs.for_event(&old_started, &items, old_epoch);
        handle_realtime_event(
            &session,
            old_started,
            &mut items,
            &sequence,
            realtime_timeline(epoch),
        )
        .await;
        crate::cohost::start_cohost(
            &state,
            crate::protocol::CohostStartParams {
                consent_to_process_chat: false,
                ..params.clone()
            },
        )
        .await
        .unwrap();
        let revoked_epoch = session.admitted_buddy_audio().await;
        assert_eq!(revoked_epoch, AdmittedBuddyAudio::default());
        queued_tx
            .send(raw_frame(std::time::Instant::now()))
            .await
            .unwrap();
        // Both a mixed chunk and an entirely revoked chunk finish uploading
        // only after grant. Their presentation stays authorized independently.
        buffer.push_samples(vec![2; 2], 0, revoked_epoch, &sequence, &mut chunk_timeline);
        buffer.push_samples(vec![2; 4], 0, revoked_epoch, &sequence, &mut chunk_timeline);
        audio_epochs.record(30_000.0, revoked_epoch);
        crate::cohost::start_cohost(&state, params).await.unwrap();
        let granted_epoch = session.admitted_buddy_audio().await;
        assert_ne!(granted_epoch, old_epoch);
        assert_eq!(
            state.captions.lock().await.task.as_ref().unwrap().id(),
            task_id
        );
        let grant_time = state.captions.lock().await.speech_started_at.unwrap();
        // Raw receiver frames queued before revoke and while revoked remain
        // authorized captions, but neither transport may assign today's epoch.
        for _ in 0..2 {
            let queued = session.receiver.recv().await.unwrap();
            assert_eq!(
                session.admitted_buddy_audio_for_frame(&queued).await,
                AdmittedBuddyAudio::default()
            );
        }
        let crossing = raw_frame(grant_time + std::time::Duration::from_millis(10));
        assert_eq!(
            session.admitted_buddy_audio_for_frame(&crossing).await,
            AdmittedBuddyAudio::default()
        );
        let fresh = raw_frame(grant_time + std::time::Duration::from_millis(40));
        assert_eq!(
            session.admitted_buddy_audio_for_frame(&fresh).await,
            granted_epoch
        );
        // Joining/resuming the same intent preserves its capture-time boundary.
        start_listen_with_bearer(&state, "speech-consent", || None).await;
        assert_eq!(
            state.captions.lock().await.speech_started_at,
            Some(grant_time)
        );
        audio_epochs.record(30_000.0, granted_epoch);
        let mut events = state.events.subscribe();
        let chunks = buffer.drain_pending();
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.admission)
                .collect::<Vec<_>>(),
            vec![
                old_epoch,
                AdmittedBuddyAudio::default(),
                AdmittedBuddyAudio::default()
            ]
        );
        for (chunk, text) in chunks.iter().zip([
            "old chunk clip that",
            "mixed chunk words",
            "revoked chunk words",
        ]) {
            commit_chunk_transcript(&session, chunk, true, &chunk_response(text, 9)).await;
        }
        // A delayed completed item keeps the ownership of its original VAD.
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "old-speech".into(),
                transcript: "old realtime clip that".into(),
            },
            &mut items,
            &sequence,
            realtime_timeline(granted_epoch),
        )
        .await;
        // VAD itself can arrive late: its known audio offset selects the
        // revoked input span, rather than sampling today's consent intent.
        let revoked_started = RealtimeCaptionEvent::SpeechStarted {
            item_id: "revoked-speech".into(),
            audio_start_ms: Some(40_000.0),
        };
        let epoch = audio_epochs.for_event(&revoked_started, &items, old_epoch);
        assert_eq!(epoch, AdmittedBuddyAudio::default());
        handle_realtime_event(
            &session,
            revoked_started,
            &mut items,
            &sequence,
            realtime_timeline(epoch),
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "revoked-speech".into(),
                transcript: "revoked realtime words".into(),
            },
            &mut items,
            &sequence,
            realtime_timeline(granted_epoch),
        )
        .await;
        let emitted = drain_events(&mut events);
        assert_eq!(caption_event_names(&emitted), vec!["captions.update"; 5]);
        assert_eq!(state.captions.lock().await.chunks.len(), 5);
        assert!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(std::time::Instant::now())
                .text
                .is_empty(),
            "pre-revocation chunk/realtime finals cannot enter the new Buddy generation"
        );
        assert!(
            crate::cohost::recent_speech_since(&state, None)
                .is_none_or(|speech| speech.finals.is_empty())
        );
        // Recording clip marks use the immutable task target even for speech
        // retired from Buddy, with no current recording slot to fall back to.
        let mut marks = emitted
            .into_iter()
            .filter(|event| event.event == "clip.marked")
            .collect::<Vec<_>>();
        tokio::time::timeout(secs(1), async {
            while marks.len() < 2 {
                let event = events.recv().await.unwrap();
                if event.event == "clip.marked" {
                    marks.push(event);
                }
            }
        })
        .await
        .expect("both transports still route their clip marks");
        assert!(
            marks
                .iter()
                .all(|event| event.payload["sessionId"] == "immutable-recording")
        );
        state.captions.lock().await.listen_ready = false;
        session
            .note_listen_ready(
                old_epoch.listen_epoch,
                crate::cohost::CohostListening::on(Some(90)),
            )
            .await;
        assert!(
            !state.captions.lock().await.listen_ready,
            "a retired reply cannot ready a new listen epoch"
        );
        assert!(drain_events(&mut events).is_empty());
        // Fresh input after grant reaches the existing Buddy session through
        // the same two production callbacks and can confirm listening again.
        buffer.push_samples(vec![3; 4], 0, granted_epoch, &sequence, &mut chunk_timeline);
        commit_chunk_transcript(
            &session,
            &buffer.pop_front().unwrap(),
            true,
            &chunk_response("fresh chunk words", 8),
        )
        .await;
        let fresh_started = RealtimeCaptionEvent::SpeechStarted {
            item_id: "fresh-speech".into(),
            audio_start_ms: Some(70_000.0),
        };
        let epoch = audio_epochs.for_event(&fresh_started, &items, old_epoch);
        assert_eq!(epoch, granted_epoch);
        handle_realtime_event(
            &session,
            fresh_started,
            &mut items,
            &sequence,
            realtime_timeline(epoch),
        )
        .await;
        handle_realtime_event(
            &session,
            RealtimeCaptionEvent::Completed {
                item_id: "fresh-speech".into(),
                transcript: "fresh realtime words".into(),
            },
            &mut items,
            &sequence,
            realtime_timeline(epoch),
        )
        .await;
        let speech = crate::cohost::recent_speech_since(&state, None).unwrap();
        assert_eq!(
            speech
                .finals
                .iter()
                .map(|final_| final_.text.as_str())
                .collect::<Vec<_>>(),
            vec!["fresh chunk words", "fresh realtime words"]
        );
        assert_eq!(
            caption_event_names(&drain_events(&mut events)),
            vec!["captions.update"; 2]
        );
        session
            .note_listen_ready(
                granted_epoch.listen_epoch,
                crate::cohost::CohostListening::on(Some(120)),
            )
            .await;
        assert!(state.captions.lock().await.listen_ready);
        let published = tokio::time::timeout(secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(published.event, "cohost.state");
        assert_eq!(published.payload["listening"]["remainingSeconds"], 120);
        crate::cohost::stop_cohost(&state).await;
        stop_captions(&state).await;
    }

    #[tokio::test]
    async fn stop_listen_reaps_a_finished_owned_task_and_tap() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let receiver = install_tap();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel::<()>();
        let (completed_tx, completed_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            finish_rx.await.unwrap();
            drop(receiver);
            completed_tx.send(()).unwrap();
        });
        {
            let mut coordinator = state.captions.lock().await;
            coordinator.task = Some(task);
            coordinator.stop = Some(Arc::new(AtomicBool::new(false)));
            coordinator.listen_wanted = true;
            coordinator.presentation = Some(Arc::new(AtomicBool::new(false)));
        }
        finish_tx.send(()).unwrap();
        tokio::time::timeout(secs(1), completed_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(secs(1), async {
            while coordinator_task_alive(&*state.captions.lock().await) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // Leave the completed handle unpolled: production cleanup owns its
        // single join, even though completion preceded intent retirement.
        assert!(state.captions.lock().await.task.is_some());
        assert!(TAP_ACTIVE.load(Ordering::Acquire));
        stop_listen(&state).await;
        let coordinator = state.captions.lock().await;
        assert!(
            coordinator.task.is_none(),
            "retirement reaps the owned finished handle"
        );
        assert!(coordinator.stop.is_none());
        assert!(!coordinator.listen_wanted);
        assert!(!TAP_ACTIVE.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn delayed_capture_resume_cannot_rearm_a_retired_listen_epoch() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        crate::cohost::start_cohost_session_for_test(&state, "resume-chat").await;
        state.captions.lock().await.listen_wanted = true;
        let before = current_listen_epoch(&state).await;
        let (checked_tx, checked_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let resume_state = state.clone();
        let resume = tokio::spawn(async move {
            resume_listen_for_capture_after_check(&resume_state, async {
                checked_tx.send(()).unwrap();
                release_rx.await.unwrap();
            })
            .await;
        });
        tokio::time::timeout(secs(1), checked_rx)
            .await
            .unwrap()
            .unwrap();
        stop_listen(&state).await;
        assert!(current_listen_epoch(&state).await > before);
        let mut events = state.events.subscribe();
        release_tx.send(()).unwrap();
        tokio::time::timeout(secs(1), resume)
            .await
            .unwrap()
            .unwrap();
        assert!(!state.captions.lock().await.listen_wanted);
        assert!(state.captions.lock().await.task.is_none());
        assert!(drain_events(&mut events).is_empty());
        crate::cohost::stop_cohost(&state).await;
    }

    #[tokio::test]
    async fn sign_out_and_stops_fence_late_listening_publishes() {
        let _caption_test_guard = caption_lifecycle_test_lock().lock().await;
        let state = test_caption_app_state();
        let before = current_listen_epoch(&state).await;
        install_intent_test_task(&state, false, true).await;
        stop_listen(&state).await;
        let after_stop = current_listen_epoch(&state).await;
        assert!(after_stop > before);
        stop_captions_for_sign_out(&state, || {}).await;
        assert!(current_listen_epoch(&state).await > after_stop);
        let coordinator = state.captions.lock().await;
        assert!(!coordinator.listen_wanted);
        assert!(!coordinator.listen_ready);
    }
}
