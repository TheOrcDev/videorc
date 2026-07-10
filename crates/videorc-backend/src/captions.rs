//! Live captions: taps microphone PCM off the native audio pipeline and
//! transcribes it through videorc-web, streaming-first (S2): the gateway
//! realtime WebSocket (voice-model input-audio transcription events, ~1s
//! behind speech, partial + final updates) with automatic fallback to ~3s
//! chunked batch transcription (`/api/ai/captions/chunks` → grok-stt)
//! whenever streaming is unavailable. Transcripts broadcast to renderer
//! clients and accumulate as chunk records for the SRT + burned copy.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, bail};
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::sync::mpsc;

use crate::audio::AudioFrame;
use crate::process_job::spawn_owned_tokio;
use crate::state::AppState;
use crate::videorc_api::{CaptionChunkFailure, VideorcApiClient};

pub const CAPTION_SAMPLE_RATE: u32 = 16_000;
pub const CAPTION_CHUNK_SECONDS: f64 = 3.0;
/// Bounded frame queue between the realtime audio thread and the session task.
/// At ~93 CoreAudio callbacks/s, 256 frames ≈ 2.7s of cushion.
const TAP_CHANNEL_CAPACITY: usize = 256;

// ---------------------------------------------------------------------------
// Tap: the audio FIFO writer thread offers every mic frame here. Fast path is
// one relaxed atomic load when captions are off; when on, a non-blocking
// try_send that drops the frame rather than ever stalling the audio thread.
// ---------------------------------------------------------------------------

static TAP_ACTIVE: AtomicBool = AtomicBool::new(false);
static TAP: std::sync::Mutex<Option<mpsc::Sender<AudioFrame>>> = std::sync::Mutex::new(None);

pub fn offer_caption_frame(frame: &AudioFrame) {
    if !TAP_ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let Ok(guard) = TAP.try_lock() else {
        return;
    };
    if let Some(sender) = guard.as_ref() {
        let _ = sender.try_send(frame.clone());
    }
}

fn install_tap() -> mpsc::Receiver<AudioFrame> {
    let (sender, receiver) = mpsc::channel(TAP_CHANNEL_CAPACITY);
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

/// Which output legs carry the LIVE caption bar (R1). The lag caveat applies
/// wherever it burns; the recording additionally gets the aligned copy.
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
    pub fn burns_recording(self) -> bool {
        matches!(self, CaptionBurnTarget::Recording | CaptionBurnTarget::Both)
    }
}

/// Per-leg overlay plan for a session shape (pure; unit-tested matrix).
/// `force_same_profile_split`: record+stream sessions whose legs must DIFFER
/// (one burned, one clean) need a separate stream render even at the same
/// profile; when both legs agree they share frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionOverlayLegPlan {
    pub primary: bool,
    pub aux: bool,
    pub force_same_profile_split: bool,
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
    };
    if target == CaptionBurnTarget::Off {
        return none;
    }
    match (record_enabled, stream_enabled) {
        (false, false) => none,
        // Record only: the primary leg IS the recording.
        (true, false) => CaptionOverlayLegPlan {
            primary: target.burns_recording(),
            aux: false,
            force_same_profile_split: false,
        },
        // Stream only: the primary leg IS the stream.
        (false, true) => CaptionOverlayLegPlan {
            primary: target.burns_stream(),
            aux: false,
            force_same_profile_split: false,
        },
        // Record + stream: primary = recording, aux = stream (when split).
        (true, true) => CaptionOverlayLegPlan {
            primary: target.burns_recording(),
            aux: target.burns_stream(),
            force_same_profile_split: target.burns_recording() != target.burns_stream(),
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

pub async fn drain_caption_chunks(state: &AppState) -> Vec<CaptionChunkRecord> {
    let mut coordinator = state.captions.lock().await;
    let epoch = coordinator.capture_epoch;
    let drained = std::mem::take(&mut coordinator.chunks);
    drop(coordinator);
    filter_caption_records_for_epoch(drained, epoch)
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
/// Returns the drained chunks so the burned-copy job can reuse them. Never
/// fails the session — problems downgrade to health warnings.
pub async fn write_caption_artifacts(
    state: &AppState,
    session_id: &str,
    recording_path: &std::path::Path,
) -> Vec<CaptionChunkRecord> {
    let chunks = drain_caption_chunks(state).await;
    if chunks.is_empty() {
        return chunks;
    }
    let srt = render_srt(&chunks);
    if srt.is_empty() {
        return chunks;
    }
    let srt_path = recording_path.with_extension("srt");
    match tokio::fs::write(&srt_path, &srt).await {
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
    chunks
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
    chunks: &[CaptionChunkRecord],
) {
    let cues = caption_cues(chunks);
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
    let (position, text_size, canvas) = {
        let mut coordinator = state.captions.lock().await;
        let style = coordinator.style;
        let canvas = coordinator.output_size;
        let mut expected: std::collections::BTreeSet<u64> =
            cues.iter().map(|cue| cue.seq).collect();
        expected.insert(CAPTION_BLANK_FRAME_SEQ);
        coordinator.pending_cue_render = Some(PendingCueRender {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            ffmpeg_path: ffmpeg_path.to_string(),
            recording_path: recording_path.to_path_buf(),
            frames_dir: frames_dir.clone(),
            cues: cues.clone(),
            expected,
            received: std::collections::BTreeSet::new(),
        });
        (style.0, style.1, canvas)
    };

    state.emit_event(
        "captions.cues.render-request",
        serde_json::json!({
            "requestId": request_id,
            "canvasWidth": canvas.0.max(2),
            "canvasHeight": canvas.1.max(2),
            "position": position,
            "textSize": text_size,
            "blankSeq": CAPTION_BLANK_FRAME_SEQ,
            "cues": cues
                .iter()
                .map(|cue| serde_json::json!({ "seq": cue.seq, "text": cue.text }))
                .collect::<Vec<_>>(),
        }),
    );

    // Watchdog: if the renderer never completes this request, clean up and
    // report — the .srt sidecar already exists either way.
    let watchdog_state = state.clone();
    let watchdog_request = request_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let pending = {
            let mut coordinator = watchdog_state.captions.lock().await;
            match &coordinator.pending_cue_render {
                Some(pending) if pending.request_id == watchdog_request => {
                    coordinator.pending_cue_render.take()
                }
                _ => None,
            }
        };
        if let Some(pending) = pending {
            let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
            let _ = crate::recording::emit_health_event(
                &watchdog_state,
                Some(&pending.session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-burn-failed",
                "The caption frames were not rendered in time; the .srt sidecar is still available.",
            );
        }
    });
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

    let completed = {
        let mut coordinator = state.captions.lock().await;
        let Some(pending) = coordinator.pending_cue_render.as_mut() else {
            bail!("No caption frame request is in flight.");
        };
        if pending.request_id != request_id {
            bail!("Caption frame request is stale.");
        }
        if !pending.expected.contains(&seq) {
            bail!("Caption frame seq {seq} was not requested.");
        }
        let path = pending.frames_dir.join(format!("{seq}.png"));
        std::fs::write(&path, &bytes)
            .map_err(|error| anyhow::anyhow!("Could not store caption frame: {error}"))?;
        pending.received.insert(seq);
        if pending.received == pending.expected {
            coordinator.pending_cue_render.take()
        } else {
            None
        }
    };

    if let Some(pending) = completed {
        enqueue_caption_overlay_burn(state.clone(), pending);
        return Ok(true);
    }
    Ok(false)
}

/// Burn the aligned captions into a `(captioned)` copy of the recording:
/// renderer-supplied full-frame cue PNGs play as a concat track and composite
/// with the CORE `overlay` filter — works with the bundled dependency-free
/// ffmpeg (no libass). Runs through the idle-aware ffmpeg coordinator; the
/// original file is never touched; failures degrade to SRT-only with a
/// health warning. Not restart-resumable (v1).
fn enqueue_caption_overlay_burn(state: AppState, pending: PendingCueRender) {
    tokio::spawn(async move {
        let list = build_caption_track_concat(&pending.cues, CAPTION_BLANK_FRAME_SEQ);
        let list_path = pending.frames_dir.join("track.ffconcat");
        if let Err(error) = tokio::fs::write(&list_path, &list).await {
            let _ = crate::recording::emit_health_event(
                &state,
                Some(&pending.session_id),
                crate::protocol::HealthLevel::Warn,
                "captions-burn-failed",
                &format!("Could not write the caption track list: {error}"),
            );
            let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
            return;
        }

        // Wait out the same idle window as the quality gates, then hold the
        // maintenance permit so the encode never competes with a capture.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let maintenance = state.ffmpeg_work.begin_maintenance_when_idle().await;
        let cancel = maintenance.cancel_token();
        let output_path = captioned_copy_path(&pending.recording_path);
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
        let spawned = spawn_owned_tokio(&mut command);
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                let _ = crate::recording::emit_health_event(
                    &state,
                    Some(&pending.session_id),
                    crate::protocol::HealthLevel::Warn,
                    "captions-burn-failed",
                    &format!("Could not start ffmpeg for the captioned copy: {error}"),
                );
                let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
                return;
            }
        };

        let outcome = loop {
            if cancel.is_cancelled() {
                let _ = child.kill().await;
                break Err("capture started; captioned copy cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(status)) => break Err(format!("ffmpeg exited with {status}")),
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
                Err(error) => break Err(format!("could not wait for ffmpeg: {error}")),
            }
        };

        match outcome {
            Ok(()) => {
                let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
                let _ = crate::recording::emit_health_event(
                    &state,
                    Some(&pending.session_id),
                    crate::protocol::HealthLevel::Info,
                    "captions-burned-copy-ready",
                    &format!("Captioned copy saved to {}.", output_path.display()),
                );
            }
            Err(reason) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                let _ = tokio::fs::remove_dir_all(&pending.frames_dir).await;
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
    });
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

#[derive(Clone)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOverlayInfo {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub revision: u64,
}

/// Decode + validate a caption bar and install it in the overlay slot.
/// Rejects oversized or undecodable payloads without touching the current
/// overlay. Pure with respect to the slot — unit-tested directly.
pub fn install_caption_overlay(
    slot: &CaptionOverlaySlot,
    png_base64: &str,
    position: CaptionOverlayPosition,
) -> Result<CaptionOverlayInfo> {
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

    let mut guard = slot.lock().expect("caption overlay lock");
    let revision = guard.as_ref().map_or(1, |overlay| overlay.revision + 1);
    let rgba = Arc::new(image.into_raw());
    let bgra = Arc::new(
        rgba.chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect(),
    );
    *guard = Some(CaptionOverlay {
        rgba,
        bgra,
        width,
        height,
        position,
        revision,
    });
    Ok(CaptionOverlayInfo {
        active: true,
        width,
        height,
        revision,
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

// ---------------------------------------------------------------------------
// Session state machine.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionsState {
    Idle,
    Live,
    /// Uploads are failing and retrying with backoff; the session survives
    /// and recovers on the next successful chunk (R0).
    Degraded,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsStatus {
    pub state: CaptionsState,
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
            message: None,
            remaining_seconds: None,
            session_client_id: None,
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

#[derive(Default)]
pub struct CaptionsCoordinator {
    task: Option<tokio::task::JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
    status: Option<CaptionsStatus>,
    /// Transcribed chunks awaiting the post-recording pass (drained +
    /// epoch-filtered at session stop).
    chunks: Vec<CaptionChunkRecord>,
    /// Bumped by the caption session on every capture-pipeline restart
    /// (frame-timestamp regression); finalize keeps only current-epoch
    /// records.
    capture_epoch: u64,
    /// Styling knobs + output size captured at session start for the burned copy.
    style: (CaptionOverlayPosition, CaptionTextSize),
    output_size: (u32, u32),
    /// In-flight cue-frame render request (R2): the renderer supplies one
    /// full-frame PNG per cue; complete → the overlay burn runs.
    pending_cue_render: Option<PendingCueRender>,
}

pub struct PendingCueRender {
    pub request_id: String,
    pub session_id: String,
    pub ffmpeg_path: String,
    pub recording_path: std::path::PathBuf,
    pub frames_dir: std::path::PathBuf,
    pub cues: Vec<CaptionCue>,
    pub expected: std::collections::BTreeSet<u64>,
    pub received: std::collections::BTreeSet<u64>,
}

/// The blank (fully transparent) gap frame's pseudo-seq in a render request.
pub const CAPTION_BLANK_FRAME_SEQ: u64 = 0;

/// Stash the caption style + output size for this session (used by the
/// burned copy's cue frames).
pub async fn set_caption_session_style(
    state: &AppState,
    position: CaptionOverlayPosition,
    text_size: CaptionTextSize,
    output_width: u32,
    output_height: u32,
) {
    let mut coordinator = state.captions.lock().await;
    coordinator.style = (position, text_size);
    coordinator.output_size = (output_width, output_height);
}

pub type CaptionsSlot = Arc<Mutex<CaptionsCoordinator>>;

pub fn new_captions_slot() -> CaptionsSlot {
    Arc::new(Mutex::new(CaptionsCoordinator::default()))
}

pub async fn captions_status(state: &AppState) -> CaptionsStatus {
    state
        .captions
        .lock()
        .await
        .status
        .clone()
        .unwrap_or_else(CaptionsStatus::idle)
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
    let Some(bearer) = crate::account::stored_session_token() else {
        bail!("Sign in to use live captions.");
    };
    let client = VideorcApiClient::new()?;

    let mut coordinator = state.captions.lock().await;
    if let (Some(task), Some(status)) = (coordinator.task.as_ref(), coordinator.status.as_ref())
        && !task.is_finished()
        && matches!(status.state, CaptionsState::Live | CaptionsState::Degraded)
    {
        return Ok(status.clone());
    }
    if let Some(task) = coordinator.task.take() {
        task.abort();
    }
    remove_tap();

    let session_client_id = format!("captions-{}", uuid::Uuid::new_v4().simple());
    let stop = Arc::new(AtomicBool::new(false));
    let receiver = install_tap();
    let status = CaptionsStatus {
        state: CaptionsState::Live,
        message: None,
        remaining_seconds: None,
        session_client_id: Some(session_client_id.clone()),
    };
    set_status(state, &mut coordinator, status.clone());

    let task_state = state.clone();
    let task_stop = stop.clone();
    coordinator.task = Some(tokio::spawn(run_caption_session(CaptionSession {
        bearer,
        client,
        language,
        receiver,
        session_client_id,
        state: task_state,
        stop: task_stop,
    })));
    coordinator.stop = Some(stop);

    Ok(status)
}

pub async fn stop_captions(state: &AppState) -> CaptionsStatus {
    let mut coordinator = state.captions.lock().await;
    if let Some(stop) = coordinator.stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    if let Some(task) = coordinator.task.take() {
        task.abort();
    }
    remove_tap();
    let status = CaptionsStatus::idle();
    set_status(state, &mut coordinator, status.clone());
    status
}

struct CaptionSession {
    bearer: String,
    client: VideorcApiClient,
    language: Option<String>,
    receiver: mpsc::Receiver<AudioFrame>,
    session_client_id: String,
    state: AppState,
    stop: Arc<AtomicBool>,
}

/// Streaming-first: try the gateway realtime transport (S2) and fall back to
/// chunked transcription whenever streaming is unavailable — the caption
/// session always works, streaming just makes it ~1s instead of ~4s.
async fn run_caption_session(mut session: CaptionSession) {
    let ended_normally = match run_realtime_caption_session(&mut session).await {
        RealtimeOutcome::Ended => true,
        RealtimeOutcome::Fallback(reason) => {
            tracing::info!(
                "Streaming captions unavailable ({reason}); using chunked transcription."
            );
            run_chunked_caption_session(&mut session).await
        }
        RealtimeOutcome::Terminal => false,
    };
    if ended_normally {
        remove_tap();
        publish_status(&session.state, CaptionsStatus::idle()).await;
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
async fn run_realtime_caption_session(session: &mut CaptionSession) -> RealtimeOutcome {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::Message;

    let mut first_attempt = true;
    let mut backoff: Option<std::time::Duration> = None;
    // Utterance bookkeeping: item id → (caption seq, audio offset seconds).
    let mut items: std::collections::HashMap<String, (u64, f64)> = std::collections::HashMap::new();
    let mut seq = 0_u64;
    // Recording-epoch anchoring (same idea as chunked): mono ms sent since the
    // capture pipeline (re)started. speech_started's audio_start_ms is
    // relative to the WS stream, so remember the stream ms at each anchor.
    let mut ms_sent: f64 = 0.0;
    let mut ms_at_anchor: f64 = 0.0;
    let mut last_frame_timestamp: Option<u64> = None;
    let mut unreported_ms: f64 = 0.0;
    let mut degraded = false;
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
                publish_status(
                    &session.state,
                    CaptionsStatus {
                        state: CaptionsState::Error,
                        message: Some(message),
                        remaining_seconds: None,
                        session_client_id: Some(session.session_client_id.clone()),
                    },
                )
                .await;
                return RealtimeOutcome::Terminal;
            }
            Err(CaptionChunkFailure::Transient { message }) => {
                if first_attempt {
                    return RealtimeOutcome::Fallback(message);
                }
                // Streaming worked before — treat as an outage and retry.
                let wait = next_caption_backoff(backoff);
                backoff = Some(wait);
                signal_degraded(session, &mut degraded, &message).await;
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
                if first_attempt {
                    return RealtimeOutcome::Fallback(message);
                }
                let wait = next_caption_backoff(backoff);
                backoff = Some(wait);
                signal_degraded(session, &mut degraded, &message).await;
                tokio::time::sleep(wait).await;
                continue 'reconnect;
            }
        };
        first_attempt = false;
        backoff = None;
        tracing::info!("Streaming captions connected ({}).", token.model);

        let configure = serde_json::json!({
            "type": "session.update",
            "session": {
                "input_audio_format": "pcm16",
                "input_audio_transcription": { "enabled": true },
                "turn_detection": { "type": "server_vad" }
            }
        });
        if ws
            .send(Message::Text(configure.to_string().into()))
            .await
            .is_err()
        {
            continue 'reconnect;
        }

        if degraded {
            degraded = false;
            let _ = crate::recording::emit_health_event(
                &session.state,
                None,
                crate::protocol::HealthLevel::Info,
                "captions-upload-recovered",
                "Streaming captions reconnected.",
            );
        }
        publish_status(
            &session.state,
            CaptionsStatus {
                state: CaptionsState::Live,
                message: None,
                remaining_seconds: Some(token.remaining_seconds),
                session_client_id: Some(session.session_client_id.clone()),
            },
        )
        .await;

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

        loop {
            if session.stop.load(Ordering::Relaxed) {
                let _ = ws.send(Message::Close(None)).await;
                report_usage(session, &mut unreported_ms).await;
                return RealtimeOutcome::Ended;
            }
            tokio::select! {
                maybe_frame = session.receiver.recv() => {
                    let Some(frame) = maybe_frame else {
                        let _ = ws.send(Message::Close(None)).await;
                        report_usage(session, &mut unreported_ms).await;
                        return RealtimeOutcome::Ended;
                    };
                    if caption_anchor_should_reset(last_frame_timestamp, frame.timestamp_micros) {
                        // New recording: re-anchor, forget in-flight
                        // utterances (their transcripts belong to the
                        // previous video), and advance the capture epoch.
                        ms_at_anchor = ms_sent;
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
                    ms_sent += mono.len() as f64 * 1000.0 / f64::from(CAPTION_SAMPLE_RATE);
                    unreported_ms += mono.len() as f64 * 1000.0 / f64::from(CAPTION_SAMPLE_RATE);
                    let mut bytes = Vec::with_capacity(mono.len() * 2);
                    for sample in &mono {
                        bytes.extend_from_slice(&sample.to_le_bytes());
                    }
                    use base64::Engine as _;
                    let event = serde_json::json!({
                        "type": "input_audio_buffer.append",
                        "audio": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    });
                    if ws.send(Message::Text(event.to_string().into())).await.is_err() {
                        signal_degraded(session, &mut degraded, "realtime socket dropped").await;
                        continue 'reconnect;
                    }
                }
                maybe_message = ws.next() => {
                    let Some(Ok(message)) = maybe_message else {
                        signal_degraded(session, &mut degraded, "realtime socket closed").await;
                        continue 'reconnect;
                    };
                    let Message::Text(text) = message else { continue };
                    let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    handle_realtime_event(
                        session,
                        &event,
                        &mut items,
                        &mut seq,
                        ms_at_anchor,
                        ms_sent,
                        capture_epoch,
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
            }
        }
    }
}

async fn signal_degraded(session: &CaptionSession, degraded: &mut bool, message: &str) {
    if *degraded {
        return;
    }
    *degraded = true;
    tracing::warn!("Streaming captions degraded: {message}");
    let _ = crate::recording::emit_health_event(
        &session.state,
        None,
        crate::protocol::HealthLevel::Warn,
        "captions-upload-failed",
        &format!("Streaming captions interrupted; reconnecting. {message}"),
    );
    publish_status(
        &session.state,
        CaptionsStatus {
            state: CaptionsState::Degraded,
            message: Some(format!("Captions reconnecting — {message}")),
            remaining_seconds: None,
            session_client_id: Some(session.session_client_id.clone()),
        },
    )
    .await;
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
    event: &serde_json::Value,
    items: &mut std::collections::HashMap<String, (u64, f64)>,
    seq: &mut u64,
    ms_at_anchor: f64,
    ms_sent: f64,
    capture_epoch: u64,
) {
    let event_type = event
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let raw_type = event
        .get("rawType")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let item_entry = |items: &mut std::collections::HashMap<String, (u64, f64)>,
                      seq: &mut u64,
                      item_id: &str,
                      offset: f64| {
        *items.entry(item_id.to_string()).or_insert_with(|| {
            *seq += 1;
            (*seq, offset)
        })
    };

    match (event_type, raw_type) {
        ("speech-started", _) => {
            let item_id = event
                .get("itemId")
                .or_else(|| event.pointer("/raw/item_id"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let start_ms = event
                .pointer("/raw/audio_start_ms")
                .and_then(|value| value.as_f64())
                .unwrap_or(ms_sent);
            if !item_id.is_empty() {
                let offset = ((start_ms - ms_at_anchor) / 1000.0).max(0.0);
                item_entry(items, seq, item_id, offset);
            }
        }
        ("custom", "conversation.item.input_audio_transcription.updated") => {
            let item_id = event
                .pointer("/raw/item_id")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let transcript = event
                .pointer("/raw/transcript")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim();
            if item_id.is_empty() || transcript.is_empty() {
                return;
            }
            // Unknown item = its speech started before a recording boundary
            // (we cleared it) — the transcript belongs to the previous video.
            let Some(&(item_seq, _)) = items.get(item_id) else {
                return;
            };
            session.state.emit_event(
                "captions.update",
                CaptionsUpdate {
                    session_client_id: session.session_client_id.clone(),
                    seq: item_seq,
                    kind: CaptionUpdateKind::Partial,
                    text: transcript.to_string(),
                    chunk_seconds: 0,
                    remaining_seconds: None,
                },
            );
        }
        ("input-transcription-completed", _) => {
            let item_id = event
                .get("itemId")
                .or_else(|| event.pointer("/raw/item_id"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let transcript = event
                .get("transcript")
                .or_else(|| event.pointer("/raw/transcript"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim();
            if item_id.is_empty() || transcript.is_empty() {
                return;
            }
            // Same boundary rule as partials: cleared items never resurrect.
            let Some(&(item_seq, offset)) = items.get(item_id) else {
                return;
            };
            let end = ((ms_sent - ms_at_anchor) / 1000.0).max(offset + 0.5);
            session
                .state
                .captions
                .lock()
                .await
                .chunks
                .push(CaptionChunkRecord {
                    seq: item_seq,
                    offset_seconds: offset,
                    duration_seconds: (end - offset).clamp(0.5, 30.0),
                    text: transcript.to_string(),
                    segments: Vec::new(),
                    capture_epoch,
                });
            session.state.emit_event(
                "captions.update",
                CaptionsUpdate {
                    session_client_id: session.session_client_id.clone(),
                    seq: item_seq,
                    kind: CaptionUpdateKind::Final,
                    text: transcript.to_string(),
                    chunk_seconds: (end - offset).ceil() as u64,
                    remaining_seconds: None,
                },
            );
        }
        _ => {}
    }
}

async fn run_chunked_caption_session(session: &mut CaptionSession) -> bool {
    let chunk_samples = (f64::from(CAPTION_SAMPLE_RATE) * CAPTION_CHUNK_SECONDS) as usize;
    let mut pcm: Vec<i16> = Vec::with_capacity(chunk_samples * 2);
    let mut seq = 0_u64;
    let mut capture_epoch = session.state.captions.lock().await.capture_epoch;
    // Recording-epoch anchoring for the post pass: mono samples consumed since
    // the current capture pipeline started (frames are already epoch-trimmed).
    let mut consumed_samples: u64 = 0;
    let mut last_frame_timestamp: Option<u64> = None;
    // Transient-failure backoff (R0): failed chunks are DROPPED — captions
    // skip a beat instead of dying — and uploads resume automatically once a
    // chunk succeeds after the backoff window. Never terminal.
    let mut backoff: Option<std::time::Duration> = None;
    let mut next_upload_allowed_at = std::time::Instant::now();
    let mut degraded_reason: Option<String> = None;

    loop {
        if session.stop.load(Ordering::Relaxed) {
            break;
        }
        let Some(frame) = session.receiver.recv().await else {
            break; // tap removed
        };
        if caption_anchor_should_reset(last_frame_timestamp, frame.timestamp_micros) {
            // New capture pipeline (new recording): drop cross-session audio,
            // restart the offset anchor, and advance the capture epoch so any
            // still-in-flight transcripts from the previous recording can
            // never be attributed to this one.
            pcm.clear();
            consumed_samples = 0;
            let mut coordinator = session.state.captions.lock().await;
            coordinator.capture_epoch += 1;
            capture_epoch = coordinator.capture_epoch;
        }
        last_frame_timestamp = Some(frame.timestamp_micros);
        pcm.extend(downmix_resample_to_16k_mono(
            &frame.samples,
            frame.channels,
            frame.sample_rate,
        ));
        if pcm.len() < chunk_samples {
            continue;
        }

        let chunk: Vec<i16> = pcm.drain(..chunk_samples).collect();
        seq += 1;
        let offset_seconds = consumed_samples as f64 / f64::from(CAPTION_SAMPLE_RATE);
        consumed_samples += chunk_samples as u64;
        // In backoff: drop this chunk without an upload attempt (the loop keeps
        // draining frames so the tap channel never backs up).
        if std::time::Instant::now() < next_upload_allowed_at {
            continue;
        }
        let wav = encode_wav_16k_mono(&chunk);

        match session
            .client
            .transcribe_caption_chunk(
                &session.bearer,
                &session.session_client_id,
                wav,
                session.language.as_deref(),
            )
            .await
        {
            Ok(response) => {
                if degraded_reason.take().is_some() {
                    // Outage over: say so once and go back to Live.
                    let _ = crate::recording::emit_health_event(
                        &session.state,
                        None,
                        crate::protocol::HealthLevel::Info,
                        "captions-upload-recovered",
                        "Caption uploads recovered; live captions resumed.",
                    );
                    publish_status(
                        &session.state,
                        CaptionsStatus {
                            state: CaptionsState::Live,
                            message: None,
                            remaining_seconds: Some(response.remaining_seconds),
                            session_client_id: Some(session.session_client_id.clone()),
                        },
                    )
                    .await;
                }
                backoff = None;
                if !response.text.trim().is_empty() {
                    let current_epoch = {
                        let mut coordinator = session.state.captions.lock().await;
                        coordinator.chunks.push(CaptionChunkRecord {
                            seq,
                            offset_seconds,
                            duration_seconds: CAPTION_CHUNK_SECONDS,
                            text: response.text.trim().to_string(),
                            segments: response.segments.clone(),
                            capture_epoch,
                        });
                        coordinator.capture_epoch
                    };
                    // An upload that outlived its recording (slow round trip
                    // across a session boundary) still lands in `chunks` —
                    // the drain filter attributes it correctly — but it must
                    // not be ANNOUNCED: the live strip and burn bar belong to
                    // the current video (carry-over fix, 2026-07-04).
                    if capture_epoch == current_epoch {
                        session.state.emit_event(
                            "captions.update",
                            CaptionsUpdate {
                                session_client_id: session.session_client_id.clone(),
                                seq,
                                kind: CaptionUpdateKind::Final,
                                text: response.text.trim().to_string(),
                                chunk_seconds: response.chunk_seconds,
                                remaining_seconds: Some(response.remaining_seconds),
                            },
                        );
                    } else {
                        tracing::info!(
                            "Suppressed a caption update from a previous recording (epoch {capture_epoch} < {current_epoch})."
                        );
                    }
                }
            }
            Err(CaptionChunkFailure::Terminal { code, message }) => {
                // Only auth/premium/quota/disabled end the session.
                tracing::warn!("Live captions stopped ({code}): {message}");
                remove_tap();
                publish_status(
                    &session.state,
                    CaptionsStatus {
                        state: CaptionsState::Error,
                        message: Some(message),
                        remaining_seconds: None,
                        session_client_id: Some(session.session_client_id.clone()),
                    },
                )
                .await;
                return false;
            }
            Err(CaptionChunkFailure::Transient { message }) => {
                let next_backoff = next_caption_backoff(backoff);
                backoff = Some(next_backoff);
                next_upload_allowed_at = std::time::Instant::now() + next_backoff;
                tracing::warn!(
                    "Live caption chunk failed (retrying in {}s): {message}",
                    next_backoff.as_secs()
                );
                if degraded_reason.as_deref() != Some(message.as_str()) {
                    // First failure of this outage (or the reason changed):
                    // one health event + a degraded status carrying the REAL
                    // reason — never a silent generic stop.
                    let _ = crate::recording::emit_health_event(
                        &session.state,
                        None,
                        crate::protocol::HealthLevel::Warn,
                        "captions-upload-failed",
                        &format!("Caption upload failed; retrying with backoff. {message}"),
                    );
                    publish_status(
                        &session.state,
                        CaptionsStatus {
                            state: CaptionsState::Degraded,
                            message: Some(format!("Captions reconnecting — {message}")),
                            remaining_seconds: None,
                            session_client_id: Some(session.session_client_id.clone()),
                        },
                    )
                    .await;
                    degraded_reason = Some(message);
                }
            }
        }
    }

    true
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

#[cfg(test)]
mod tests {
    use super::*;

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
        // Off burns nothing anywhere.
        for (record, stream) in [(true, false), (false, true), (true, true)] {
            assert_eq!(
                plan(record, stream, Off),
                CaptionOverlayLegPlan {
                    primary: false,
                    aux: false,
                    force_same_profile_split: false
                }
            );
        }
        // Record only: primary is the recording; stream targets are inert.
        assert!(plan(true, false, Recording).primary);
        assert!(plan(true, false, Both).primary);
        assert!(!plan(true, false, Stream).primary);
        // Stream only: primary IS the stream; recording targets are inert.
        assert!(plan(false, true, Stream).primary);
        assert!(plan(false, true, Both).primary);
        assert!(!plan(false, true, Recording).primary);
        // Record+stream: split forced ONLY when the legs must differ.
        let stream_only = plan(true, true, Stream);
        assert_eq!((stream_only.primary, stream_only.aux), (false, true));
        assert!(stream_only.force_same_profile_split);
        let recording_only = plan(true, true, Recording);
        assert_eq!((recording_only.primary, recording_only.aux), (true, false));
        assert!(recording_only.force_same_profile_split);
        let both = plan(true, true, Both);
        assert_eq!((both.primary, both.aux), (true, true));
        assert!(!both.force_same_profile_split);
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
