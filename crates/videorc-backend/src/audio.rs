use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::protocol::{AudioMeterResult, AudioMeterStatus, Device, DeviceKind, DeviceStatus};

pub const NATIVE_AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const NATIVE_AUDIO_CHANNELS: u16 = 2;
const WINDOWS_DSHOW_MICROPHONE_PREFIX: &str = "microphone:windows-dshow:";
/// Minimum elapsed capture time before audio-capture coverage is meaningful — below this
/// the sampled count is too noisy (start-up jitter, FIFO preroll) to judge a gap.
pub const AUDIO_COVERAGE_WARMUP_SECS: f64 = 3.0;
// CoreAudio must never block on the realtime callback. The recording bridge can briefly
// stop reading the audio FIFO while probing/flushing the H.264 video FIFO, so keep a
// bounded multi-second packet cushion instead of dropping valid mic callbacks.
const AUDIO_RING_CAPACITY_PACKETS: usize = 1024;
const METER_SAMPLE_DURATION: Duration = Duration::from_millis(700);
const FIFO_OPEN_RETRY: Duration = Duration::from_millis(20);
pub const NATIVE_AUDIO_FFMPEG_QUEUE_SIZE: u32 = 1024;

/// Reserved CoreAudio id used only by the maintained debug caption smoke.
/// A release build does not compile the synthetic source or its RPC handle.
#[cfg(debug_assertions)]
pub const CAPTION_CONTRACT_TEST_DEVICE_ID: u32 = u32::MAX;
#[cfg(debug_assertions)]
const CAPTION_CONTRACT_TEST_PACKET_MS: u64 = 20;

/// Fraction of the expected audio sample-frames that were actually captured over the
/// elapsed window: `captured / (elapsed × sample_rate)`. 1.0 means full real-time
/// coverage; values meaningfully below 1.0 indicate the mic stalled (a capture gap).
/// Returns `None` before [`AUDIO_COVERAGE_WARMUP_SECS`] (too little signal) or when the
/// sample rate is zero. Pure and deterministic, so it is unit-tested directly.
pub fn audio_capture_coverage(
    captured_frames: u64,
    elapsed_secs: f64,
    sample_rate: u32,
) -> Option<f64> {
    if sample_rate == 0 || !elapsed_secs.is_finite() || elapsed_secs < AUDIO_COVERAGE_WARMUP_SECS {
        return None;
    }
    let expected = elapsed_secs * f64::from(sample_rate);
    if expected <= 0.0 {
        return None;
    }
    Some(captured_frames as f64 / expected)
}

#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub timestamp_micros: u64,
    pub captured_at: Instant,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

impl AudioFrame {
    pub fn frame_count(&self) -> usize {
        if self.channels == 0 {
            return 0;
        }
        self.samples.len() / usize::from(self.channels)
    }

    fn duration(&self) -> Duration {
        if self.sample_rate == 0 {
            return Duration::ZERO;
        }
        Duration::from_secs_f64(self.frame_count() as f64 / f64::from(self.sample_rate))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AudioProcessingSettings {
    pub gain_db: f32,
    pub muted: bool,
}

impl Default for AudioProcessingSettings {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            muted: false,
        }
    }
}

/// Lock-free snapshot read by the realtime CoreAudio callback on every frame.
/// Gain and mute share one atomic word so callbacks never observe a mixed pair
/// from two renderer updates, and the callback never takes a mutex.
#[derive(Debug, Clone)]
pub struct AudioProcessingSettingsHandle {
    packed: Arc<AtomicU64>,
}

impl AudioProcessingSettingsHandle {
    pub fn new(settings: AudioProcessingSettings) -> Self {
        Self {
            packed: Arc::new(AtomicU64::new(pack_audio_processing_settings(settings))),
        }
    }

    pub fn update(&self, settings: AudioProcessingSettings) {
        self.packed
            .store(pack_audio_processing_settings(settings), Ordering::Release);
    }

    fn load(&self) -> AudioProcessingSettings {
        unpack_audio_processing_settings(self.packed.load(Ordering::Acquire))
    }
}

fn normalized_audio_processing_settings(
    settings: AudioProcessingSettings,
) -> AudioProcessingSettings {
    AudioProcessingSettings {
        gain_db: if settings.gain_db.is_finite() {
            settings.gain_db.clamp(-24.0, 24.0)
        } else {
            0.0
        },
        muted: settings.muted,
    }
}

fn pack_audio_processing_settings(settings: AudioProcessingSettings) -> u64 {
    let settings = normalized_audio_processing_settings(settings);
    u64::from(settings.gain_db.to_bits()) | (u64::from(settings.muted) << 32)
}

fn unpack_audio_processing_settings(packed: u64) -> AudioProcessingSettings {
    AudioProcessingSettings {
        gain_db: f32::from_bits(packed as u32),
        muted: ((packed >> 32) & 1) == 1,
    }
}

/// Raw-tone controller for the permissionless maintained caption smoke.
///
/// The producer owns the real source cadence. This handle only selects a
/// bounded number of raw packets to fill with a tone; the producer then runs
/// them through `processed_capture_frame_with_handle` before the shared FIFO
/// writer fans the resulting frame out to captions and FFmpeg.
#[cfg(debug_assertions)]
#[derive(Debug, Clone)]
pub struct CaptionContractTestAudioInjector {
    raw_peak_bits: Arc<AtomicU64>,
    packets_remaining: Arc<AtomicU64>,
    packets_generated: Arc<AtomicU64>,
    injection_active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy)]
pub struct CaptionContractTestAudioInjection {
    pub packets_generated: u64,
    pub raw_peak: f32,
}

#[cfg(debug_assertions)]
impl CaptionContractTestAudioInjector {
    pub async fn inject(
        &self,
        duration_ms: u64,
        raw_peak: f32,
    ) -> Result<CaptionContractTestAudioInjection> {
        if !caption_contract_test_audio_enabled() {
            bail!("Caption contract test audio is disabled.");
        }
        if !raw_peak.is_finite() || !(0.001..=0.5).contains(&raw_peak) {
            bail!("Caption contract test raw peak must be between 0.001 and 0.5.");
        }
        self.injection_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow::anyhow!("A caption contract PCM injection is already active."))?;

        let duration_ms = duration_ms.clamp(CAPTION_CONTRACT_TEST_PACKET_MS, 5_000);
        let packet_count = duration_ms.div_ceil(CAPTION_CONTRACT_TEST_PACKET_MS);
        let before = self.packets_generated.load(Ordering::Acquire);
        self.raw_peak_bits
            .store(u64::from(raw_peak.to_bits()), Ordering::Release);
        self.packets_remaining
            .store(packet_count, Ordering::Release);

        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(duration_ms)
            + Duration::from_secs(2);
        let outcome = loop {
            let generated = self
                .packets_generated
                .load(Ordering::Acquire)
                .saturating_sub(before);
            if generated >= packet_count {
                break Ok(CaptionContractTestAudioInjection {
                    packets_generated: generated,
                    raw_peak,
                });
            }
            if self.stop.load(Ordering::Acquire) {
                break Err(anyhow::anyhow!(
                    "The active native audio session stopped during PCM injection."
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                break Err(anyhow::anyhow!(
                    "Timed out waiting for the synthetic native audio source."
                ));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };

        self.packets_remaining.store(0, Ordering::Release);
        self.raw_peak_bits.store(0, Ordering::Release);
        self.injection_active.store(false, Ordering::Release);
        outcome
    }
}

#[cfg(debug_assertions)]
fn caption_contract_test_audio_enabled() -> bool {
    std::env::var("VIDEORC_CAPTION_CONTRACT_TEST").as_deref() == Ok("1")
}

#[derive(Debug, Default)]
pub struct AudioCaptureStats {
    captured_frames: AtomicU64,
    dropped_frames: AtomicU64,
    fifo_write_errors: AtomicU64,
    recording_window_finished: AtomicBool,
    // Peak amplitude of the most recent frame window (milli-units, 0..=1000):
    // the Studio mixer's live meter reads this via the diagnostics sampler —
    // no extra device open (post-0.9.4 fix batch F7).
    live_peak_milli: AtomicU64,
    // Loudest peak seen over the whole recording window (same milli-units).
    // A TCC-unauthorized process gets SILENT ZEROS from CoreAudio, not an
    // error — frames keep counting while the track holds nothing. This is the
    // truthful "did the mic capture any sound at all" signal (plan 021 F3).
    session_peak_milli: AtomicU64,
    // Coverage must use the same window as the counters. The FIFO writer resets the
    // counters after discarding audio captured before the first video frame, and stop
    // freezes them before FFmpeg finishes flushing. Tracking that exact window avoids
    // counting either startup or finalization latency as a microphone capture gap.
    recording_window: std::sync::Mutex<AudioCaptureWindow>,
}

#[derive(Debug, Default)]
struct AudioCaptureWindow {
    started_at: Option<Instant>,
    finished_elapsed: Option<Duration>,
}

impl AudioCaptureStats {
    pub fn captured_frames(&self) -> u64 {
        self.captured_frames.load(Ordering::Relaxed)
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames.load(Ordering::Relaxed)
    }

    pub fn live_peak(&self) -> f32 {
        self.live_peak_milli.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn session_peak(&self) -> f32 {
        self.session_peak_milli.load(Ordering::Relaxed) as f32 / 1000.0
    }

    fn record_live_peak(&self, peak: f32) {
        let clamped = (peak.clamp(0.0, 1.0) * 1000.0) as u64;
        self.live_peak_milli.store(clamped, Ordering::Relaxed);
        self.session_peak_milli
            .fetch_max(clamped, Ordering::Relaxed);
    }

    fn reset_recording_window(&self) {
        self.reset_recording_window_at(Instant::now());
    }

    fn reset_recording_window_at(&self, started_at: Instant) {
        let mut window = self
            .recording_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Prevent the realtime callback from adding a frame between the counter reset and
        // the new epoch becoming authoritative.
        self.recording_window_finished
            .store(true, Ordering::Relaxed);
        self.captured_frames.store(0, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.fifo_write_errors.store(0, Ordering::Relaxed);
        self.session_peak_milli.store(0, Ordering::Relaxed);
        *window = AudioCaptureWindow {
            started_at: Some(started_at),
            finished_elapsed: None,
        };
        self.recording_window_finished
            .store(false, Ordering::Relaxed);
    }

    fn finish_recording_window(&self) {
        self.finish_recording_window_at(Instant::now());
    }

    fn finish_recording_window_at(&self, finished_at: Instant) {
        let mut window = self
            .recording_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if window.finished_elapsed.is_some() {
            return;
        }
        self.recording_window_finished
            .store(true, Ordering::Relaxed);
        window.finished_elapsed = window
            .started_at
            .map(|started_at| finished_at.saturating_duration_since(started_at));
    }

    fn recording_window_finished(&self) -> bool {
        self.recording_window_finished.load(Ordering::Relaxed)
    }

    fn recording_window_elapsed_secs(&self) -> Option<f64> {
        self.recording_window_elapsed_at(Instant::now())
            .map(|elapsed| elapsed.as_secs_f64())
    }

    fn recording_window_elapsed_at(&self, sampled_at: Instant) -> Option<Duration> {
        let window = self
            .recording_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let started_at = window.started_at?;
        Some(
            window
                .finished_elapsed
                .unwrap_or_else(|| sampled_at.saturating_duration_since(started_at)),
        )
    }

    fn record_captured_frames(&self, frames: u64) {
        if !self.recording_window_finished() {
            self.captured_frames.fetch_add(frames, Ordering::Relaxed);
        }
    }

    fn record_dropped_frames(&self, frames: u64) {
        if !self.recording_window_finished() {
            self.dropped_frames.fetch_add(frames, Ordering::Relaxed);
        }
    }
}

pub struct NativeAudioSource {
    pub device_id: u32,
    pub device_name: String,
    receiver: Option<mpsc::Receiver<AudioFrame>>,
    stats: Arc<AudioCaptureStats>,
    processing_settings: AudioProcessingSettingsHandle,
    stop: Arc<AtomicBool>,
    stop_on_drop: bool,
    #[cfg(debug_assertions)]
    caption_contract_test_injector: Option<CaptionContractTestAudioInjector>,
    #[cfg(debug_assertions)]
    caption_contract_test_producer: Option<thread::JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    audio_unit: Option<coreaudio::audio_unit::AudioUnit>,
}

impl NativeAudioSource {
    /// A cloneable, `Send` handle to the capture stats — lets callers poll mic warmup
    /// across await points without holding the (`!Send`) source itself. `captured_frames`
    /// stays zero until CoreAudio delivers its first callback (the warmed-up signal).
    pub fn stats_handle(&self) -> Arc<AudioCaptureStats> {
        self.stats.clone()
    }
}

impl std::fmt::Debug for NativeAudioSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAudioSource")
            .field("device_id", &self.device_id)
            .field("device_name", &self.device_name)
            .field("captured_frames", &self.stats.captured_frames())
            .field("dropped_frames", &self.stats.dropped_frames())
            .finish_non_exhaustive()
    }
}

impl Drop for NativeAudioSource {
    fn drop(&mut self) {
        if !self.stop_on_drop {
            return;
        }
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(debug_assertions)]
        if let Some(producer) = self.caption_contract_test_producer.take() {
            let _ = producer.join();
        }
        #[cfg(target_os = "macos")]
        if let Some(audio_unit) = self.audio_unit.as_mut() {
            let _ = audio_unit.stop();
        }
    }
}

pub struct NativeAudioCaptureSession {
    pub device_id: u32,
    pub device_name: String,
    pub fifo_path: PathBuf,
    stats: Arc<AudioCaptureStats>,
    processing_settings: AudioProcessingSettingsHandle,
    stop: Arc<AtomicBool>,
    writer: Option<thread::JoinHandle<()>>,
    #[cfg(debug_assertions)]
    caption_contract_test_injector: Option<CaptionContractTestAudioInjector>,
    #[cfg(debug_assertions)]
    caption_contract_test_producer: Option<thread::JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    audio_unit: Option<coreaudio::audio_unit::AudioUnit>,
}

impl std::fmt::Debug for NativeAudioCaptureSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAudioCaptureSession")
            .field("device_id", &self.device_id)
            .field("device_name", &self.device_name)
            .field("fifo_path", &self.fifo_path)
            .field("captured_frames", &self.captured_frames())
            .field("dropped_frames", &self.dropped_frames())
            .finish_non_exhaustive()
    }
}

impl NativeAudioCaptureSession {
    pub fn captured_frames(&self) -> u64 {
        self.stats.captured_frames()
    }

    pub fn dropped_frames(&self) -> u64 {
        self.stats.dropped_frames()
    }

    pub fn live_peak(&self) -> f32 {
        self.stats.live_peak()
    }

    pub fn session_peak(&self) -> f32 {
        self.stats.session_peak()
    }

    pub fn recording_window_elapsed_secs(&self) -> Option<f64> {
        self.stats.recording_window_elapsed_secs()
    }

    pub fn finish_recording_window(&self) {
        self.stats.finish_recording_window();
    }

    pub fn update_processing_settings(&self, settings: AudioProcessingSettings) {
        self.processing_settings.update(settings);
    }

    /// Clone the permissionless raw-PCM controller installed only for the
    /// maintained debug caption smoke. Production CoreAudio sessions return
    /// `None`, so the RPC cannot inject into an ordinary microphone session.
    #[cfg(debug_assertions)]
    pub fn caption_contract_test_injector(&self) -> Option<CaptionContractTestAudioInjector> {
        self.caption_contract_test_injector.clone()
    }
}

impl Drop for NativeAudioCaptureSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(debug_assertions)]
        if let Some(producer) = self.caption_contract_test_producer.take() {
            let _ = producer.join();
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        #[cfg(target_os = "macos")]
        if let Some(audio_unit) = self.audio_unit.as_mut() {
            let _ = audio_unit.stop();
        }
        let _ = crate::fifo::cleanup(&self.fifo_path);
    }
}

pub fn parse_coreaudio_microphone_id(id: &str) -> Option<u32> {
    id.strip_prefix("microphone:coreaudio:")?.parse().ok()
}

pub fn parse_windows_dshow_microphone_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(WINDOWS_DSHOW_MICROPHONE_PREFIX)?;
    let bytes = decode_hex(encoded)?;
    String::from_utf8(bytes).ok()
}

#[cfg(any(test, target_os = "windows"))]
fn windows_dshow_microphone_device_id(device_name: &str) -> String {
    format!(
        "{WINDOWS_DSHOW_MICROPHONE_PREFIX}{}",
        encode_hex(device_name.as_bytes())
    )
}

pub fn native_audio_fifo_path(session_id: &str) -> PathBuf {
    crate::fifo::transport_path(&format!("videorc-audio-{session_id}.f32le"))
}

pub fn create_native_audio_fifo(path: &Path) -> Result<()> {
    crate::fifo::cleanup(path)
        .with_context(|| format!("Could not remove stale audio FIFO {}", path.display()))?;

    crate::fifo::create(path)
        .with_context(|| format!("Could not create audio FIFO {}", path.display()))
}

pub fn start_native_audio_source(
    device_id: u32,
    settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    #[cfg(debug_assertions)]
    if device_id == CAPTION_CONTRACT_TEST_DEVICE_ID {
        if !caption_contract_test_audio_enabled() {
            bail!("The caption contract test microphone requires VIDEORC_CAPTION_CONTRACT_TEST=1.");
        }
        return start_caption_contract_test_audio_source(settings);
    }
    start_platform_audio_source(device_id, settings)
}

/// How long the FIFO writer waits for the encoder bridge to deliver its first video
/// frame before giving up on epoch alignment (mirrors the recording startup budget).
const VIDEO_EPOCH_WAIT_TIMEOUT: Duration = Duration::from_secs(20);

struct AudioPreroll {
    discarded_frames: u64,
    ready_frames: VecDeque<AudioFrame>,
}

/// Discard queued audio until the shared video epoch is set (the encoder bridge's
/// first composited video frame), so the first audio sample written corresponds to the
/// same instant as the first video frame. This replaces the old calibrated constant:
/// the video pipeline's startup latency varies with resolution (4K warms slower than
/// 1080p), so no fixed offset can align both. Returns the discarded frame count plus
/// any already-queued audio captured at/after the epoch, or None when the wait timed
/// out and the writer should proceed unaligned.
fn discard_audio_until_video_epoch(
    receiver: &mpsc::Receiver<AudioFrame>,
    video_epoch: &OnceLock<Instant>,
    stop: &AtomicBool,
) -> Option<AudioPreroll> {
    let waited_since = Instant::now();
    let mut pending = VecDeque::new();
    loop {
        if let Some(epoch) = video_epoch.get().copied() {
            return Some(discard_audio_before_epoch(receiver, pending, epoch, stop));
        }
        if stop.load(Ordering::Relaxed) || waited_since.elapsed() >= VIDEO_EPOCH_WAIT_TIMEOUT {
            return None;
        }
        match receiver.recv_timeout(Duration::from_millis(2)) {
            Ok(frame) => pending.push_back(frame),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Some(AudioPreroll {
                    discarded_frames: pending.iter().map(|frame| frame.frame_count() as u64).sum(),
                    ready_frames: VecDeque::new(),
                });
            }
        }
    }
}

fn discard_audio_before_epoch(
    receiver: &mpsc::Receiver<AudioFrame>,
    mut pending: VecDeque<AudioFrame>,
    epoch: Instant,
    stop: &AtomicBool,
) -> AudioPreroll {
    let mut discarded_frames = 0_u64;
    let mut ready_frames = VecDeque::new();

    loop {
        let frame = if let Some(frame) = pending.pop_front() {
            frame
        } else if ready_frames.is_empty() && !stop.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return AudioPreroll {
                        discarded_frames,
                        ready_frames,
                    };
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return AudioPreroll {
                        discarded_frames,
                        ready_frames,
                    };
                }
            }
        } else {
            return AudioPreroll {
                discarded_frames,
                ready_frames,
            };
        };

        let trimmed = trim_audio_frame_before_epoch(frame, epoch);
        discarded_frames = discarded_frames.saturating_add(trimmed.discarded_frames);
        if let Some(frame) = trimmed.frame {
            ready_frames.push_back(frame);
            ready_frames.extend(pending);
            return AudioPreroll {
                discarded_frames,
                ready_frames,
            };
        }
    }
}

struct TrimmedAudioFrame {
    discarded_frames: u64,
    frame: Option<AudioFrame>,
}

fn trim_audio_frame_before_epoch(mut frame: AudioFrame, epoch: Instant) -> TrimmedAudioFrame {
    let frame_count = frame.frame_count();
    if frame_count == 0 || frame.sample_rate == 0 || frame.channels == 0 {
        return TrimmedAudioFrame {
            discarded_frames: frame_count as u64,
            frame: None,
        };
    }

    let frame_end = frame.captured_at;
    let frame_start = frame_end.checked_sub(frame.duration()).unwrap_or(frame_end);
    if frame_end <= epoch {
        return TrimmedAudioFrame {
            discarded_frames: frame_count as u64,
            frame: None,
        };
    }
    if frame_start >= epoch {
        return TrimmedAudioFrame {
            discarded_frames: 0,
            frame: Some(frame),
        };
    }

    let trim_duration = epoch.duration_since(frame_start);
    let frames_to_trim = ((trim_duration.as_secs_f64() * f64::from(frame.sample_rate)).round()
        as usize)
        .min(frame_count);
    if frames_to_trim == 0 {
        return TrimmedAudioFrame {
            discarded_frames: 0,
            frame: Some(frame),
        };
    }
    if frames_to_trim >= frame_count {
        return TrimmedAudioFrame {
            discarded_frames: frame_count as u64,
            frame: None,
        };
    }

    let sample_offset = frames_to_trim * usize::from(frame.channels);
    frame.samples = frame.samples[sample_offset..].to_vec();
    frame.timestamp_micros = frame.timestamp_micros.saturating_add(
        (frames_to_trim as u64).saturating_mul(1_000_000) / u64::from(frame.sample_rate),
    );
    TrimmedAudioFrame {
        discarded_frames: frames_to_trim as u64,
        frame: Some(frame),
    }
}

pub fn attach_fifo_writer(
    mut source: NativeAudioSource,
    fifo_path: PathBuf,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
) -> NativeAudioCaptureSession {
    source.stop_on_drop = false;
    let device_id = source.device_id;
    let device_name = std::mem::take(&mut source.device_name);
    let receiver = source
        .receiver
        .take()
        .expect("native audio source receiver is available before attaching FIFO writer");
    let stats = source.stats.clone();
    let processing_settings = source.processing_settings.clone();
    let stop = source.stop.clone();
    #[cfg(debug_assertions)]
    let caption_contract_test_injector = source.caption_contract_test_injector.clone();
    #[cfg(debug_assertions)]
    let caption_contract_test_producer = source.caption_contract_test_producer.take();
    #[cfg(target_os = "macos")]
    let audio_unit = source.audio_unit.take();

    let writer_stats = stats.clone();
    let writer_stop = stop.clone();
    let writer_path = fifo_path.clone();
    // Clear warmup/pre-roll counters before the session is published as active; the
    // writer thread repeats this after it drains queued pre-roll frames.
    stats.reset_recording_window();
    let writer = thread::spawn(move || {
        let mut file = match open_fifo_writer(&writer_path, &writer_stop) {
            Ok(file) => file,
            Err(error) => {
                writer_stats
                    .fifo_write_errors
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!("Could not open native audio FIFO: {error}");
                return;
            }
        };

        let preroll = match video_epoch.as_deref() {
            Some(epoch) => match discard_audio_until_video_epoch(&receiver, epoch, &writer_stop) {
                Some(preroll) => preroll,
                None => {
                    tracing::warn!(
                        "Video epoch never arrived; writing native audio without epoch alignment."
                    );
                    AudioPreroll {
                        discarded_frames: discard_preroll_audio_frames(&receiver),
                        ready_frames: VecDeque::new(),
                    }
                }
            },
            None => AudioPreroll {
                discarded_frames: discard_preroll_audio_frames(&receiver),
                ready_frames: VecDeque::new(),
            },
        };
        if preroll.discarded_frames > 0 {
            tracing::info!(
                "Discarded {} native audio pre-roll frames before starting the recording FIFO.",
                preroll.discarded_frames
            );
        }
        // Warmup starts CoreAudio before FFmpeg is ready, so the bounded callback queue can
        // legitimately fill during pre-roll. The live recording diagnostics should count
        // only frames captured/dropped after the FIFO is open and pre-roll has been
        // discarded.
        writer_stats.reset_recording_window();

        for frame in preroll.ready_frames {
            let frame_count = frame.frame_count() as u64;
            if let Err(error) = write_frame_f32le(&mut file, &frame) {
                writer_stats
                    .fifo_write_errors
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!("Could not write native audio frame: {error}");
                return;
            }
            writer_stats.record_captured_frames(frame_count);
        }

        while !writer_stop.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
                    // Live captions listen on this same post-gain/post-mute mic
                    // bus; the offer is a relaxed-atomic no-op unless a caption
                    // session is active and never blocks this writer.
                    crate::captions::offer_caption_frame(&frame);
                    let frame_peak = frame
                        .samples
                        .iter()
                        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
                    writer_stats.record_live_peak(frame_peak);
                    if let Err(error) = write_frame_f32le(&mut file, &frame) {
                        writer_stats
                            .fifo_write_errors
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::warn!("Could not write native audio frame: {error}");
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    NativeAudioCaptureSession {
        device_id,
        device_name,
        fifo_path,
        stats,
        processing_settings,
        stop,
        writer: Some(writer),
        #[cfg(debug_assertions)]
        caption_contract_test_injector,
        #[cfg(debug_assertions)]
        caption_contract_test_producer,
        #[cfg(target_os = "macos")]
        audio_unit,
    }
}

fn discard_preroll_audio_frames(receiver: &mpsc::Receiver<AudioFrame>) -> u64 {
    let mut discarded = 0_u64;
    while let Ok(frame) = receiver.try_recv() {
        discarded = discarded.saturating_add(frame.frame_count() as u64);
    }
    discarded
}

pub fn sample_native_audio_meter(
    device_id: u32,
    settings: AudioProcessingSettings,
) -> AudioMeterResult {
    match start_native_audio_source(device_id, settings) {
        Ok(source) => sample_meter_from_source(source, METER_SAMPLE_DURATION),
        Err(error) => AudioMeterResult {
            status: permission_or_unavailable(&error.to_string()),
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some(error.to_string()),
        },
    }
}

pub fn list_native_microphones() -> Vec<Device> {
    match list_platform_microphones() {
        Ok(devices) => devices,
        Err(error) => vec![platform_unavailable_microphone(&error.to_string())],
    }
}

fn sample_meter_from_source(mut source: NativeAudioSource, duration: Duration) -> AudioMeterResult {
    let receiver = source
        .receiver
        .take()
        .expect("native audio source receiver is available before sampling meter");
    let started = Instant::now();
    let mut peak = 0.0_f32;
    let mut sum_squares = 0.0_f64;
    let mut samples = 0_u64;

    while started.elapsed() < duration {
        match receiver.recv_timeout(Duration::from_millis(80)) {
            Ok(frame) => {
                for sample in frame.samples {
                    let value = sample.abs();
                    peak = peak.max(value);
                    sum_squares += f64::from(value * value);
                    samples += 1;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if samples == 0 {
        return AudioMeterResult {
            status: AudioMeterStatus::NoFrames,
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some(
                "This microphone opened but did not send audio frames. Try a fallback input or another mic."
                    .to_string(),
            ),
        };
    }

    let peak_db = amplitude_to_db(peak);
    let rms = (sum_squares / samples as f64).sqrt() as f32;
    let mean_db = amplitude_to_db(rms);
    let level = db_to_level(peak_db);
    let silent = peak_db <= -55.0;

    AudioMeterResult {
        status: if silent {
            AudioMeterStatus::Silent
        } else {
            AudioMeterStatus::Ready
        },
        level: Some(level),
        peak_db: Some(f64::from(peak_db)),
        mean_db: Some(f64::from(mean_db)),
        message: Some(if silent {
            "Native microphone signal is very low.".to_string()
        } else {
            "Native microphone signal detected.".to_string()
        }),
    }
}

fn open_fifo_writer(path: &Path, stop: &AtomicBool) -> io::Result<File> {
    crate::fifo::open_writer(
        path,
        stop,
        FIFO_OPEN_RETRY,
        true,
        "native audio writer stopped before FIFO opened",
    )
}

fn write_frame_f32le(file: &mut File, frame: &AudioFrame) -> io::Result<()> {
    if frame.sample_rate != NATIVE_AUDIO_SAMPLE_RATE || frame.channels != NATIVE_AUDIO_CHANNELS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native audio frame format does not match FFmpeg FIFO format",
        ));
    }
    let _timestamp_micros = frame.timestamp_micros;
    let mut bytes = Vec::with_capacity(frame.samples.len() * std::mem::size_of::<f32>());
    for sample in &frame.samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    file.write_all(&bytes)
}

pub fn process_interleaved_f32(
    input: &[f32],
    source_channels: usize,
    settings: AudioProcessingSettings,
) -> Vec<f32> {
    if input.is_empty() || source_channels == 0 {
        return Vec::new();
    }

    let gain = if settings.muted {
        0.0
    } else {
        db_to_gain(settings.gain_db)
    };
    let frame_count = input.len() / source_channels;
    let mut output = Vec::with_capacity(frame_count * usize::from(NATIVE_AUDIO_CHANNELS));

    for frame_index in 0..frame_count {
        let base = frame_index * source_channels;
        let mono = if source_channels > 1 {
            centered_voice_sample(
                input[base],
                input.get(base + 1).copied().unwrap_or(input[base]),
            )
        } else {
            input[base]
        };
        let sample = (mono * gain).clamp(-1.0, 1.0);
        output.push(sample);
        output.push(sample);
    }

    output
}

#[cfg(any(test, target_os = "macos", debug_assertions))]
fn processed_capture_frame(
    input: &[f32],
    source_channels: usize,
    settings: AudioProcessingSettings,
    timestamp_micros: u64,
) -> AudioFrame {
    AudioFrame {
        timestamp_micros,
        captured_at: Instant::now(),
        sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
        channels: NATIVE_AUDIO_CHANNELS,
        samples: process_interleaved_f32(input, source_channels, settings),
    }
}

#[cfg(any(test, target_os = "macos", debug_assertions))]
fn processed_capture_frame_with_handle(
    input: &[f32],
    source_channels: usize,
    settings: &AudioProcessingSettingsHandle,
    timestamp_micros: u64,
) -> AudioFrame {
    processed_capture_frame(input, source_channels, settings.load(), timestamp_micros)
}

#[cfg(debug_assertions)]
fn start_caption_contract_test_audio_source(
    settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    let (sender, receiver) = mpsc::sync_channel(AUDIO_RING_CAPACITY_PACKETS);
    let stats = Arc::new(AudioCaptureStats::default());
    let processing_settings = AudioProcessingSettingsHandle::new(settings);
    let stop = Arc::new(AtomicBool::new(false));
    let injector = CaptionContractTestAudioInjector {
        raw_peak_bits: Arc::new(AtomicU64::new(0)),
        packets_remaining: Arc::new(AtomicU64::new(0)),
        packets_generated: Arc::new(AtomicU64::new(0)),
        injection_active: Arc::new(AtomicBool::new(false)),
        stop: stop.clone(),
    };

    let producer_stats = stats.clone();
    let producer_settings = processing_settings.clone();
    let producer_stop = stop.clone();
    let producer_injector = injector.clone();
    let producer = thread::spawn(move || {
        const SOURCE_CHANNELS: usize = 2;
        let samples_per_channel = (u64::from(NATIVE_AUDIO_SAMPLE_RATE)
            * CAPTION_CONTRACT_TEST_PACKET_MS
            / 1_000) as usize;
        let packet_duration = Duration::from_millis(CAPTION_CONTRACT_TEST_PACKET_MS);
        let mut frame_cursor = 0_u64;
        let mut next_tick = Instant::now();

        while !producer_stop.load(Ordering::Acquire) {
            let inject_tone = producer_injector
                .packets_remaining
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    (remaining > 0).then(|| remaining - 1)
                })
                .is_ok();
            let raw_peak = if inject_tone {
                f32::from_bits(producer_injector.raw_peak_bits.load(Ordering::Acquire) as u32)
            } else {
                0.0
            };
            let mut input = Vec::with_capacity(samples_per_channel * SOURCE_CHANNELS);
            for sample_index in 0..samples_per_channel {
                let absolute = frame_cursor as usize + sample_index;
                let phase = absolute as f32 * 440.0 * std::f32::consts::TAU
                    / NATIVE_AUDIO_SAMPLE_RATE as f32;
                let sample = phase.sin() * raw_peak;
                input.extend_from_slice(&[sample, sample]);
            }
            let frame = processed_capture_frame_with_handle(
                &input,
                SOURCE_CHANNELS,
                &producer_settings,
                timestamp_for_frame(frame_cursor),
            );
            let frame_count = frame.frame_count() as u64;
            frame_cursor = frame_cursor.saturating_add(frame_count);
            producer_stats.record_captured_frames(frame_count);

            match sender.try_send(frame) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(frame)) => {
                    producer_stats.record_dropped_frames(frame.frame_count() as u64);
                }
                Err(mpsc::TrySendError::Disconnected(_)) => break,
            }
            if inject_tone {
                producer_injector
                    .packets_generated
                    .fetch_add(1, Ordering::Release);
            }

            next_tick = next_tick
                .checked_add(packet_duration)
                .unwrap_or_else(Instant::now);
            let now = Instant::now();
            if next_tick > now {
                thread::sleep(next_tick.duration_since(now));
            } else {
                next_tick = now;
            }
        }
    });

    Ok(NativeAudioSource {
        device_id: CAPTION_CONTRACT_TEST_DEVICE_ID,
        device_name: "Caption contract test microphone".to_string(),
        receiver: Some(receiver),
        stats,
        processing_settings,
        stop,
        stop_on_drop: true,
        caption_contract_test_injector: Some(injector),
        caption_contract_test_producer: Some(producer),
        #[cfg(target_os = "macos")]
        audio_unit: None,
    })
}

fn centered_voice_sample(left: f32, right: f32) -> f32 {
    const SILENT_CHANNEL_THRESHOLD: f32 = 1.0e-5;

    match (
        left.abs() > SILENT_CHANNEL_THRESHOLD,
        right.abs() > SILENT_CHANNEL_THRESHOLD,
    ) {
        (true, true) => (left + right) * 0.5,
        (true, false) => left,
        (false, true) => right,
        (false, false) => 0.0,
    }
}

#[cfg(test)]
fn fake_pcm_frames(frame_count: usize, chunk_frames: usize, frequency_hz: f32) -> Vec<AudioFrame> {
    let mut frames = Vec::new();
    let mut produced = 0usize;

    while produced < frame_count {
        let current_frames = chunk_frames.min(frame_count - produced);
        let mut samples = Vec::with_capacity(current_frames * usize::from(NATIVE_AUDIO_CHANNELS));
        for frame_offset in 0..current_frames {
            let phase = ((produced + frame_offset) as f32 * frequency_hz * std::f32::consts::TAU)
                / NATIVE_AUDIO_SAMPLE_RATE as f32;
            let sample = phase.sin() * 0.25;
            samples.push(sample);
            samples.push(sample);
        }
        frames.push(AudioFrame {
            timestamp_micros: timestamp_for_frame(produced as u64),
            captured_at: Instant::now(),
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples,
        });
        produced += current_frames;
    }

    frames
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

pub(crate) fn amplitude_to_db(amplitude: f32) -> f32 {
    if amplitude <= f32::EPSILON {
        -90.0
    } else {
        20.0 * amplitude.log10()
    }
}

pub(crate) fn db_to_level(db: f32) -> f64 {
    f64::from(((db + 60.0) / 60.0).clamp(0.0, 1.0))
}

fn timestamp_for_frame(frame_cursor: u64) -> u64 {
    frame_cursor.saturating_mul(1_000_000) / u64::from(NATIVE_AUDIO_SAMPLE_RATE)
}

#[cfg(any(test, target_os = "windows"))]
fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }

    value
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16)?;
            let low = char::from(pair[1]).to_digit(16)?;
            Some(((high << 4) | low) as u8)
        })
        .collect()
}

fn permission_or_unavailable(message: &str) -> AudioMeterStatus {
    let lower = message.to_lowercase();
    if lower.contains("permission") || lower.contains("unauthor") {
        AudioMeterStatus::PermissionRequired
    } else {
        AudioMeterStatus::Unavailable
    }
}

fn unavailable_microphone(id: &str, name: &str, detail: &str) -> Device {
    Device {
        id: id.to_string(),
        name: name.to_string(),
        kind: DeviceKind::Microphone,
        status: DeviceStatus::Unavailable,
        detail: Some(detail.to_string()),
        width: None,
        height: None,
    }
}

#[cfg(target_os = "macos")]
fn platform_unavailable_microphone(detail: &str) -> Device {
    unavailable_microphone(
        "microphone:coreaudio-unavailable",
        "Native microphone capture",
        detail,
    )
}

#[cfg(target_os = "windows")]
fn platform_unavailable_microphone(detail: &str) -> Device {
    unavailable_microphone(
        "microphone:windows-mediafoundation-unavailable",
        "Microphone",
        detail,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_unavailable_microphone(detail: &str) -> Device {
    unavailable_microphone("microphone:unsupported-platform", "Microphone", detail)
}

#[cfg(target_os = "macos")]
fn start_platform_audio_source(
    device_id: u32,
    settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    use coreaudio::audio_unit::audio_format::LinearPcmFlags;
    use coreaudio::audio_unit::macos_helpers::{audio_unit_from_device_id, get_device_name};
    use coreaudio::audio_unit::render_callback::{self, data};
    use coreaudio::audio_unit::{Element, SampleFormat, Scope, StreamFormat};
    use std::sync::mpsc::TrySendError;

    let device_name =
        get_device_name(device_id).unwrap_or_else(|_| format!("CoreAudio device {device_id}"));
    let mut audio_unit = audio_unit_from_device_id(device_id, true)
        .with_context(|| format!("Could not open CoreAudio input device {device_name}"))?;

    let stream_format = StreamFormat {
        sample_rate: f64::from(NATIVE_AUDIO_SAMPLE_RATE),
        sample_format: SampleFormat::F32,
        flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
        channels: u32::from(NATIVE_AUDIO_CHANNELS),
    };
    audio_unit
        .set_stream_format(stream_format, Scope::Output, Element::Input)
        .with_context(|| format!("Could not set CoreAudio stream format for {device_name}"))?;

    let (sender, receiver) = mpsc::sync_channel(AUDIO_RING_CAPACITY_PACKETS);
    let stats = Arc::new(AudioCaptureStats::default());
    let callback_stats = stats.clone();
    let processing_settings = AudioProcessingSettingsHandle::new(settings);
    let callback_processing_settings = processing_settings.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let callback_stop = stop.clone();
    let mut frame_cursor = 0_u64;

    type Args = render_callback::Args<data::Interleaved<f32>>;
    audio_unit
        .set_input_callback(move |args: Args| {
            if callback_stop.load(Ordering::Relaxed) {
                return Ok(());
            }

            // This processed frame is the single native microphone bus shared
            // by FFmpeg and live captions. Gain/mute are already applied before
            // either consumer can see it, so muted speech never reaches cloud
            // transcription and caption levels match audible mic levels.
            let frame = processed_capture_frame_with_handle(
                args.data.buffer,
                args.data.channels,
                &callback_processing_settings,
                timestamp_for_frame(frame_cursor),
            );
            let frame_count = frame.samples.len() / usize::from(NATIVE_AUDIO_CHANNELS);
            frame_cursor = frame_cursor.saturating_add(frame_count as u64);
            callback_stats.record_captured_frames(frame_count as u64);

            match sender.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(frame)) => {
                    callback_stats.record_dropped_frames(frame.frame_count() as u64);
                }
                Err(TrySendError::Disconnected(_)) => {}
            }

            Ok(())
        })
        .with_context(|| {
            format!("Could not register CoreAudio input callback for {device_name}")
        })?;

    audio_unit
        .start()
        .with_context(|| format!("Could not start CoreAudio input device {device_name}"))?;

    Ok(NativeAudioSource {
        device_id,
        device_name,
        receiver: Some(receiver),
        stats,
        processing_settings,
        stop,
        stop_on_drop: true,
        #[cfg(debug_assertions)]
        caption_contract_test_injector: None,
        #[cfg(debug_assertions)]
        caption_contract_test_producer: None,
        audio_unit: Some(audio_unit),
    })
}

#[cfg(not(target_os = "macos"))]
fn start_platform_audio_source(
    _device_id: u32,
    _settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    // The live meter samples the native capture ring, which only the CoreAudio
    // backend fills today. Recording audio on Windows still works (the dshow
    // mic leg runs inside ffmpeg, not this path) — only the in-app level meter
    // is pending its own Windows capture source. Phrase it as a not-yet, not a
    // macOS-only defect, so the mic UI does not read as broken. Must NOT
    // contain "permission"/"unauthor" (permission_or_unavailable keys on that).
    bail!("Live microphone metering is not available on this platform yet.");
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::*;
    use windows::Win32::Media::MediaFoundation::{
        IMFActivate, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_SYMBOLIC_LINK, MF_VERSION, MFCreateAttributes,
        MFEnumDeviceSources, MFSTARTUP_FULL, MFShutdown, MFStartup,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::core::GUID;

    pub fn list_platform_microphones() -> windows::core::Result<Vec<Device>> {
        let mut devices = list_media_foundation_microphones()?;
        if devices.is_empty() {
            devices.push(unavailable_microphone(
                "microphone:windows-mediafoundation-missing",
                "Microphone",
                "MediaFoundation did not report any audio capture devices.",
            ));
        }
        Ok(devices)
    }

    fn list_media_foundation_microphones() -> windows::core::Result<Vec<Device>> {
        let _media_foundation = MediaFoundationSession::start()?;
        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 1)? };
        let attributes =
            attributes.expect("MFCreateAttributes returned success without attributes");
        unsafe {
            attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID,
            )?
        };

        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0;
        unsafe { MFEnumDeviceSources(&attributes, &mut activates, &mut count)? };

        let mut devices = Vec::new();
        for index in 0..count {
            let activate = unsafe { activates.add(index as usize).read() };
            if let Some(activate) = activate {
                devices.push(device_from_activate(&activate, index));
            }
        }
        unsafe { CoTaskMemFree(Some(activates.cast())) };

        Ok(devices)
    }

    fn device_from_activate(activate: &IMFActivate, index: u32) -> Device {
        let friendly_name = mf_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
            .unwrap_or_else(|| format!("Microphone {}", index + 1));
        let symbolic_link = mf_string(
            activate,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_SYMBOLIC_LINK,
        );
        // Same trap as the Windows camera path (camera_capture.rs): dshow's
        // selector is the DirectShow FRIENDLY NAME (`audio=Microphone (...)`),
        // not the MediaFoundation MMDEVAPI symbolic link. Encoding
        // `@\\?\SWD#MMDEVAPI#...` into the device id made FFmpeg exit
        // immediately at session start with:
        //   Could not find audio only device with name [@\\?\SWD#MMDEVAPI#...]
        //   Error opening input files: I/O error
        //   FFmpeg exited with exit code: 0xfffffffb
        // which the user sees as "recording starts then stops". Keep the
        // symbolic link in detail for support bundles only.
        let capture_name = friendly_name.clone();
        Device {
            id: windows_dshow_microphone_device_id(&capture_name),
            name: friendly_name.clone(),
            kind: DeviceKind::Microphone,
            status: DeviceStatus::Available,
            detail: Some(windows_media_foundation_microphone_detail(
                &friendly_name,
                symbolic_link
                    .as_deref()
                    .map(|link| format!("@{link}"))
                    .as_deref()
                    .unwrap_or(&capture_name),
            )),
            width: None,
            height: None,
        }
    }

    fn mf_string(activate: &IMFActivate, key: &GUID) -> Option<String> {
        let len = unsafe { activate.GetStringLength(key).ok()? };
        if len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let mut written = 0;
        unsafe {
            activate
                .GetString(key, &mut buffer, Some(&mut written))
                .ok()?;
        }
        utf16_z(&buffer[..written as usize])
    }

    struct MediaFoundationSession;

    impl MediaFoundationSession {
        fn start() -> windows::core::Result<Self> {
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
            Ok(Self)
        }
    }

    impl Drop for MediaFoundationSession {
        fn drop(&mut self) {
            let _ = unsafe { MFShutdown() };
        }
    }
}

#[cfg(target_os = "macos")]
fn list_platform_microphones() -> Result<Vec<Device>> {
    use coreaudio::audio_unit::Scope;
    use coreaudio::audio_unit::macos_helpers::{
        get_audio_device_ids_for_scope, get_audio_device_supports_scope, get_default_device_id,
        get_device_name,
    };

    let default_input = get_default_device_id(true);
    let mut devices = Vec::new();

    for device_id in get_audio_device_ids_for_scope(Scope::Input)? {
        if !get_audio_device_supports_scope(device_id, Scope::Input).unwrap_or(false) {
            continue;
        }
        let name =
            get_device_name(device_id).unwrap_or_else(|_| format!("CoreAudio device {device_id}"));
        let is_default = default_input == Some(device_id);
        devices.push(Device {
            id: format!("microphone:coreaudio:{device_id}"),
            name,
            kind: DeviceKind::Microphone,
            status: DeviceStatus::Available,
            detail: Some(if is_default {
                "Native CoreAudio input · default".to_string()
            } else {
                "Native CoreAudio input".to_string()
            }),
            width: None,
            height: None,
        });
    }

    if devices.is_empty() {
        bail!("CoreAudio did not report any input devices");
    }

    devices.sort_by_key(|device| {
        if device
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("default"))
        {
            (0, device.name.clone())
        } else {
            (1, device.name.clone())
        }
    });
    Ok(devices)
}

#[cfg(target_os = "windows")]
fn list_platform_microphones() -> Result<Vec<Device>> {
    windows_native::list_platform_microphones()
        .context("MediaFoundation microphone discovery failed")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn list_platform_microphones() -> Result<Vec<Device>> {
    bail!("Native microphone discovery is only implemented on macOS/Windows")
}

#[cfg(any(test, target_os = "windows"))]
fn windows_media_foundation_microphone_detail(friendly_name: &str, capture_name: &str) -> String {
    if capture_name == friendly_name {
        format!("Windows MediaFoundation microphone. Recording uses dshow device `{capture_name}`.")
    } else {
        format!(
            "Windows MediaFoundation microphone `{friendly_name}`. Recording uses dshow device `{capture_name}`."
        )
    }
}

#[cfg(any(test, target_os = "windows"))]
fn utf16_z(value: &[u16]) -> Option<String> {
    let len = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    let text = String::from_utf16_lossy(&value[..len]);
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(samples: usize) -> AudioFrame {
        frame_at(Instant::now(), samples)
    }

    fn frame_at(captured_at: Instant, samples: usize) -> AudioFrame {
        AudioFrame {
            timestamp_micros: 0,
            captured_at,
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples: vec![0.0; samples * NATIVE_AUDIO_CHANNELS as usize],
        }
    }

    #[test]
    fn epoch_trim_discards_audio_captured_before_the_first_video_frame() {
        let (tx, rx) = mpsc::channel::<AudioFrame>();
        let epoch: OnceLock<Instant> = OnceLock::new();
        let stop = AtomicBool::new(false);

        // Pre-epoch capture: queued before the video pipeline delivered anything.
        let anchor = Instant::now();
        tx.send(frame_at(anchor + Duration::from_millis(10), 480))
            .unwrap();
        tx.send(frame_at(anchor + Duration::from_millis(20), 480))
            .unwrap();
        epoch.set(anchor + Duration::from_millis(25)).unwrap();

        let preroll = discard_audio_until_video_epoch(&rx, &epoch, &stop)
            .expect("epoch was set, the wait must succeed");
        assert_eq!(
            preroll.discarded_frames, 960,
            "both pre-epoch frames are trimmed"
        );
        assert!(preroll.ready_frames.is_empty());

        // Post-epoch frames flow to the FIFO untouched.
        tx.send(frame(480)).unwrap();
        assert_eq!(rx.try_recv().unwrap().frame_count(), 480);
    }

    #[test]
    fn epoch_trim_preserves_audio_already_captured_after_the_first_video_frame() {
        let (tx, rx) = mpsc::channel::<AudioFrame>();
        let epoch: OnceLock<Instant> = OnceLock::new();
        let stop = AtomicBool::new(false);
        let anchor = Instant::now();

        tx.send(frame_at(anchor + Duration::from_millis(10), 480))
            .unwrap();
        tx.send(frame_at(anchor + Duration::from_millis(30), 480))
            .unwrap();
        tx.send(frame_at(anchor + Duration::from_millis(40), 480))
            .unwrap();
        epoch.set(anchor + Duration::from_millis(25)).unwrap();

        let preroll = discard_audio_until_video_epoch(&rx, &epoch, &stop)
            .expect("epoch was set, the wait must succeed");

        assert_eq!(
            preroll.discarded_frames, 720,
            "one full pre-roll packet and half of the boundary packet are trimmed"
        );
        let ready_counts = preroll
            .ready_frames
            .iter()
            .map(AudioFrame::frame_count)
            .collect::<Vec<_>>();
        assert_eq!(ready_counts, vec![240]);
        assert_eq!(preroll.ready_frames[0].timestamp_micros, 5_000);
        assert_eq!(rx.try_recv().unwrap().frame_count(), 480);
    }

    #[test]
    fn epoch_trim_gives_up_when_stopped_before_video_arrives() {
        let (tx, rx) = mpsc::channel::<AudioFrame>();
        let epoch: OnceLock<Instant> = OnceLock::new();
        let stop = AtomicBool::new(true);
        tx.send(frame(480)).unwrap();
        assert!(discard_audio_until_video_epoch(&rx, &epoch, &stop).is_none());
    }

    #[test]
    fn audio_capture_coverage_flags_real_time_vs_stalled_capture() {
        // Below warmup: not enough signal yet.
        assert_eq!(audio_capture_coverage(48_000, 1.0, 48_000), None);
        // Full real-time capture over 4s ≈ 1.0 coverage.
        let full = audio_capture_coverage(4 * 48_000, 4.0, 48_000).unwrap();
        assert!((full - 1.0).abs() < 1e-6, "full coverage {full}");
        // Mic delivered only half the expected samples → a clear gap.
        let stalled = audio_capture_coverage(2 * 48_000, 4.0, 48_000).unwrap();
        assert!((stalled - 0.5).abs() < 1e-6, "stalled coverage {stalled}");
        // Zero sample rate is undefined.
        assert_eq!(audio_capture_coverage(1000, 5.0, 0), None);
    }

    #[test]
    fn meter_reports_no_frames_separately_from_unavailable() {
        let (_sender, receiver) = mpsc::channel();
        let source = NativeAudioSource {
            device_id: 42,
            device_name: "Built-in Microphone".to_string(),
            receiver: Some(receiver),
            stats: Arc::new(AudioCaptureStats::default()),
            processing_settings: AudioProcessingSettingsHandle::new(
                AudioProcessingSettings::default(),
            ),
            stop: Arc::new(AtomicBool::new(false)),
            stop_on_drop: true,
            #[cfg(debug_assertions)]
            caption_contract_test_injector: None,
            #[cfg(debug_assertions)]
            caption_contract_test_producer: None,
            #[cfg(target_os = "macos")]
            audio_unit: None,
        };

        let result = sample_meter_from_source(source, Duration::from_millis(1));

        assert_eq!(result.status, AudioMeterStatus::NoFrames);
        assert!(
            result
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("did not send audio frames")
        );
    }

    #[test]
    fn fake_pcm_frames_keep_monotonic_timestamps() {
        let frames = fake_pcm_frames(4_800, 480, 440.0);
        assert!(frames.len() > 1);
        assert_eq!(frames[0].timestamp_micros, 0);
        assert_eq!(frames[0].sample_rate, NATIVE_AUDIO_SAMPLE_RATE);
        assert_eq!(frames[0].channels, NATIVE_AUDIO_CHANNELS);

        for pair in frames.windows(2) {
            assert!(pair[1].timestamp_micros > pair[0].timestamp_micros);
        }
    }

    // Plan 021 F3: session_peak is the max over the recording window (the
    // live meter only keeps the LAST frame's peak, which reads 0 the moment
    // the speaker pauses), and it resets with the window so a silent second
    // take is not masked by a loud first one.
    #[test]
    fn session_peak_holds_the_window_maximum_and_resets() {
        let stats = AudioCaptureStats::default();
        assert_eq!(stats.session_peak(), 0.0);

        stats.record_live_peak(0.25);
        stats.record_live_peak(0.9);
        stats.record_live_peak(0.1);
        // Live meter follows the last frame; the session keeps the loudest.
        assert!((stats.live_peak() - 0.1).abs() < 1e-3);
        assert!((stats.session_peak() - 0.9).abs() < 1e-3);

        stats.reset_recording_window();
        assert_eq!(stats.session_peak(), 0.0);
    }

    #[test]
    fn queued_audio_frames_are_discarded_before_fifo_writer_starts() {
        let (sender, receiver) = mpsc::sync_channel(AUDIO_RING_CAPACITY_PACKETS);
        for frame in fake_pcm_frames(1_920, 480, 440.0) {
            sender.try_send(frame).unwrap();
        }

        assert_eq!(discard_preroll_audio_frames(&receiver), 1_920);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn recording_audio_stats_start_after_preroll() {
        let stats = AudioCaptureStats::default();
        stats.captured_frames.fetch_add(48_000, Ordering::Relaxed);
        stats.dropped_frames.fetch_add(4_800, Ordering::Relaxed);
        stats.fifo_write_errors.fetch_add(1, Ordering::Relaxed);

        stats.reset_recording_window();

        assert_eq!(stats.captured_frames(), 0);
        assert_eq!(stats.dropped_frames(), 0);
        assert_eq!(stats.fifo_write_errors.load(Ordering::Relaxed), 0);

        stats.record_captured_frames(480);
        stats.record_dropped_frames(96);

        assert_eq!(stats.captured_frames(), 480);
        assert_eq!(stats.dropped_frames(), 96);

        stats.finish_recording_window();
        stats.record_captured_frames(480);
        stats.record_dropped_frames(96);

        assert_eq!(stats.captured_frames(), 480);
        assert_eq!(stats.dropped_frames(), 96);

        stats.reset_recording_window();
        stats.record_captured_frames(240);

        assert_eq!(stats.captured_frames(), 240);
        assert_eq!(stats.dropped_frames(), 0);
    }

    #[test]
    fn recording_audio_coverage_uses_the_counter_window_and_freezes_at_stop() {
        let stats = AudioCaptureStats::default();
        let sampler_started_at = Instant::now();
        let counter_window_started_at = sampler_started_at + Duration::from_millis(500);
        stats.reset_recording_window_at(counter_window_started_at);
        stats.record_captured_frames(9 * u64::from(NATIVE_AUDIO_SAMPLE_RATE));

        let stopped_at = counter_window_started_at + Duration::from_secs(9);
        stats.finish_recording_window_at(stopped_at);
        let sampled_after_finalization = stopped_at + Duration::from_millis(700);
        let capture_elapsed = stats
            .recording_window_elapsed_at(sampled_after_finalization)
            .expect("recording counter window is available");

        assert_eq!(capture_elapsed, Duration::from_secs(9));
        let aligned_coverage = audio_capture_coverage(
            stats.captured_frames(),
            capture_elapsed.as_secs_f64(),
            NATIVE_AUDIO_SAMPLE_RATE,
        )
        .unwrap();
        assert!((aligned_coverage - 1.0).abs() < f64::EPSILON);

        // The old sampler-task clock included both the delayed counter reset and FFmpeg
        // finalization. The same gap-free capture therefore failed the honest 95% gate.
        let old_sampler_elapsed = sampled_after_finalization.duration_since(sampler_started_at);
        let old_coverage = audio_capture_coverage(
            stats.captured_frames(),
            old_sampler_elapsed.as_secs_f64(),
            NATIVE_AUDIO_SAMPLE_RATE,
        )
        .unwrap();
        assert!(old_coverage < 0.95, "old coverage was {old_coverage}");
    }

    #[test]
    fn gain_and_mute_are_deterministic() {
        let input = [0.25, 0.25, 0.5, 0.5];
        let gained = process_interleaved_f32(
            &input,
            2,
            AudioProcessingSettings {
                gain_db: 6.0,
                muted: false,
            },
        );
        assert!(gained[0] > input[0]);
        assert!(gained[1] > input[1]);

        let muted = process_interleaved_f32(
            &input,
            2,
            AudioProcessingSettings {
                gain_db: 24.0,
                muted: true,
            },
        );
        assert!(muted.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn shared_native_capture_frame_applies_controls_before_caption_fanout() {
        let muted = processed_capture_frame(
            &[0.8, 0.8, -0.5, -0.5],
            2,
            AudioProcessingSettings {
                gain_db: 24.0,
                muted: true,
            },
            42,
        );
        assert_eq!(muted.timestamp_micros, 42);
        assert!(muted.samples.iter().all(|sample| *sample == 0.0));

        let gained = processed_capture_frame(
            &[0.1, 0.1],
            2,
            AudioProcessingSettings {
                gain_db: 6.0,
                muted: false,
            },
            43,
        );
        assert!(gained.samples[0] > 0.1);
        assert_eq!(gained.samples[0], gained.samples[1]);
    }

    #[test]
    fn caption_contract_test_source_delivers_permissionless_warmup_frames() {
        let mut source = start_caption_contract_test_audio_source(AudioProcessingSettings {
            gain_db: 6.0,
            muted: true,
        })
        .expect("debug caption source should start without a device");
        let stats = source.stats_handle();
        let receiver = source
            .receiver
            .take()
            .expect("debug caption source owns its receiver");
        let frame = receiver
            .recv_timeout(Duration::from_millis(500))
            .expect("debug caption source should deliver a warmup frame");

        assert_eq!(frame.frame_count(), 960);
        assert!(frame.samples.iter().all(|sample| *sample == 0.0));
        assert!(stats.captured_frames() >= 960);
    }

    #[test]
    fn live_audio_processing_updates_reach_fifo_and_caption_bus_without_restarting_capture() {
        let settings = AudioProcessingSettingsHandle::new(AudioProcessingSettings::default());
        let input = [0.1, 0.1, -0.2, -0.2];

        settings.update(AudioProcessingSettings {
            gain_db: 6.0,
            muted: false,
        });
        let gained = processed_capture_frame_with_handle(&input, 2, &settings, 100);
        let caption_gained = crate::captions::round_trip_caption_audio_test_frame(&gained);
        assert_eq!(caption_gained.samples, gained.samples);
        assert!(gained.samples[0] > input[0]);

        settings.update(AudioProcessingSettings {
            gain_db: 24.0,
            muted: true,
        });
        let muted = processed_capture_frame_with_handle(&input, 2, &settings, 101);
        let caption_muted = crate::captions::round_trip_caption_audio_test_frame(&muted);
        assert!(muted.samples.iter().all(|sample| *sample == 0.0));
        assert!(caption_muted.samples.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn mono_input_is_duplicated_to_stereo() {
        let output = process_interleaved_f32(&[0.1, 0.2], 1, AudioProcessingSettings::default());
        assert_eq!(output, vec![0.1, 0.1, 0.2, 0.2]);
    }

    #[test]
    fn left_only_stereo_input_is_centered() {
        let output = process_interleaved_f32(
            &[0.5, 0.0, -0.25, 0.0],
            2,
            AudioProcessingSettings::default(),
        );
        assert_eq!(output, vec![0.5, 0.5, -0.25, -0.25]);
    }

    #[test]
    fn right_only_stereo_input_is_centered() {
        let output = process_interleaved_f32(
            &[0.0, 0.5, 0.0, -0.25],
            2,
            AudioProcessingSettings::default(),
        );
        assert_eq!(output, vec![0.5, 0.5, -0.25, -0.25]);
    }

    #[test]
    fn true_stereo_input_is_averaged_then_centered() {
        let output = process_interleaved_f32(
            &[0.5, 0.25, -0.25, -0.75],
            2,
            AudioProcessingSettings::default(),
        );
        assert_eq!(output, vec![0.375, 0.375, -0.5, -0.5]);
    }

    #[test]
    fn native_voice_centering_uses_first_two_channels() {
        let output =
            process_interleaved_f32(&[0.6, 0.2, 1.0], 3, AudioProcessingSettings::default());
        assert_eq!(output, vec![0.4, 0.4]);
    }

    #[test]
    fn parses_coreaudio_microphone_ids() {
        assert_eq!(
            parse_coreaudio_microphone_id("microphone:coreaudio:42"),
            Some(42)
        );
        assert_eq!(
            parse_coreaudio_microphone_id("microphone:avfoundation:1"),
            None
        );
    }

    #[test]
    fn parses_windows_dshow_microphone_ids() {
        assert_eq!(
            parse_windows_dshow_microphone_id(
                "microphone:windows-dshow:4d6963726f70686f6e65204172726179"
            )
            .as_deref(),
            Some("Microphone Array")
        );
        assert_eq!(
            parse_windows_dshow_microphone_id(&windows_dshow_microphone_device_id(
                r"@\\?\swdevice#mmdevapi#{0.0.1.00000000}"
            ))
            .as_deref(),
            Some(r"@\\?\swdevice#mmdevapi#{0.0.1.00000000}")
        );
        assert_eq!(
            parse_windows_dshow_microphone_id("microphone:windows-dshow:not-hex"),
            None
        );
        assert_eq!(
            parse_windows_dshow_microphone_id("microphone:coreaudio:42"),
            None
        );
    }

    #[test]
    fn describes_windows_mediafoundation_microphone_detail() {
        // Detail may still mention a symbolic link for support triage; the
        // dshow capture name (device id payload) is the friendly name.
        assert_eq!(
            windows_media_foundation_microphone_detail(
                "Microphone Array",
                r"@\\?\swdevice#mmdevapi#{0.0.1.00000000}"
            ),
            r"Windows MediaFoundation microphone `Microphone Array`. Recording uses dshow device `@\\?\swdevice#mmdevapi#{0.0.1.00000000}`."
        );
        assert_eq!(
            windows_media_foundation_microphone_detail("Microphone Array", "Microphone Array"),
            "Windows MediaFoundation microphone. Recording uses dshow device `Microphone Array`."
        );
        // Round-trip the id with the friendly name FFmpeg dshow accepts.
        assert_eq!(
            parse_windows_dshow_microphone_id(&windows_dshow_microphone_device_id(
                "Microphone (HD Pro Webcam C920)"
            ))
            .as_deref(),
            Some("Microphone (HD Pro Webcam C920)")
        );
    }

    #[test]
    fn trims_utf16_null_terminated_microphone_names() {
        let mut value = [0u16; 8];
        value[0] = 'M' as u16;
        value[1] = 'i' as u16;
        value[2] = 'c' as u16;

        assert_eq!(utf16_z(&value).as_deref(), Some("Mic"));
        assert_eq!(utf16_z(&[0, 0, 0]), None);
    }
}
