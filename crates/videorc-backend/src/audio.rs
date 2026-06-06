use std::ffi::CString;
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::protocol::{AudioMeterResult, AudioMeterStatus, Device, DeviceKind, DeviceStatus};

pub const NATIVE_AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const NATIVE_AUDIO_CHANNELS: u16 = 2;
/// Minimum elapsed capture time before audio-capture coverage is meaningful — below this
/// the sampled count is too noisy (start-up jitter, FIFO preroll) to judge a gap.
pub const AUDIO_COVERAGE_WARMUP_SECS: f64 = 3.0;
const AUDIO_RING_CAPACITY_FRAMES: usize = 256;
const METER_SAMPLE_DURATION: Duration = Duration::from_millis(700);
const FIFO_OPEN_RETRY: Duration = Duration::from_millis(20);
pub const NATIVE_AUDIO_FFMPEG_QUEUE_SIZE: u32 = 256;

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
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

impl AudioFrame {
    pub fn frame_count(&self) -> usize {
        self.samples.len() / usize::from(self.channels)
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

#[derive(Debug, Default)]
pub struct AudioCaptureStats {
    captured_frames: AtomicU64,
    dropped_frames: AtomicU64,
    fifo_write_errors: AtomicU64,
}

impl AudioCaptureStats {
    pub fn captured_frames(&self) -> u64 {
        self.captured_frames.load(Ordering::Relaxed)
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames.load(Ordering::Relaxed)
    }

    fn reset_recording_window(&self) {
        self.captured_frames.store(0, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.fifo_write_errors.store(0, Ordering::Relaxed);
    }
}

pub struct NativeAudioSource {
    pub device_id: u32,
    pub device_name: String,
    receiver: Option<mpsc::Receiver<AudioFrame>>,
    stats: Arc<AudioCaptureStats>,
    stop: Arc<AtomicBool>,
    stop_on_drop: bool,
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
    stop: Arc<AtomicBool>,
    writer: Option<thread::JoinHandle<()>>,
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
}

impl Drop for NativeAudioCaptureSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        #[cfg(target_os = "macos")]
        if let Some(audio_unit) = self.audio_unit.as_mut() {
            let _ = audio_unit.stop();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
    }
}

pub fn parse_coreaudio_microphone_id(id: &str) -> Option<u32> {
    id.strip_prefix("microphone:coreaudio:")?.parse().ok()
}

pub fn native_audio_fifo_path(session_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("videorc-audio-{session_id}.f32le"))
}

pub fn create_native_audio_fifo(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path)
            .with_context(|| format!("Could not remove stale audio FIFO {}", path.display()))?;
    }

    let c_path = CString::new(path.display().to_string())
        .context("Audio FIFO path contained an interior NUL byte")?;
    let status = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if status != 0 {
        return Err(io::Error::last_os_error())
            .with_context(|| format!("Could not create audio FIFO {}", path.display()));
    }

    Ok(())
}

pub fn start_native_audio_source(
    device_id: u32,
    settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    start_platform_audio_source(device_id, settings)
}

pub fn attach_fifo_writer(
    mut source: NativeAudioSource,
    fifo_path: PathBuf,
) -> NativeAudioCaptureSession {
    source.stop_on_drop = false;
    let device_id = source.device_id;
    let device_name = std::mem::take(&mut source.device_name);
    let receiver = source
        .receiver
        .take()
        .expect("native audio source receiver is available before attaching FIFO writer");
    let stats = source.stats.clone();
    let stop = source.stop.clone();
    #[cfg(target_os = "macos")]
    let audio_unit = source.audio_unit.take();

    let writer_stats = stats.clone();
    let writer_stop = stop.clone();
    let writer_path = fifo_path.clone();
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

        let discarded_preroll_frames = discard_preroll_audio_frames(&receiver);
        if discarded_preroll_frames > 0 {
            tracing::info!(
                "Discarded {discarded_preroll_frames} native audio pre-roll frames before starting the recording FIFO."
            );
        }
        // Warmup starts CoreAudio before FFmpeg is ready, so the bounded callback queue can
        // legitimately fill during pre-roll. The live recording diagnostics should count
        // only frames captured/dropped after the FIFO is open and pre-roll has been
        // discarded.
        writer_stats.reset_recording_window();

        while !writer_stop.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
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
        stop,
        writer: Some(writer),
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
        Err(error) => vec![Device {
            id: "microphone:coreaudio-unavailable".to_string(),
            name: "Native microphone capture".to_string(),
            kind: DeviceKind::Microphone,
            status: DeviceStatus::Unavailable,
            detail: Some(error.to_string()),
        }],
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
            status: AudioMeterStatus::Unavailable,
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some("Native microphone capture did not receive audio frames.".to_string()),
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
    let c_path = CString::new(path.display().to_string())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid FIFO path"))?;

    while !stop.load(Ordering::Relaxed) {
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if fd >= 0 {
            let _ = unsafe { libc::fcntl(fd, libc::F_SETFL, 0) };
            let file = unsafe { File::from_raw_fd(fd) };
            return Ok(file);
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENXIO) {
            return Err(error);
        }
        thread::sleep(FIFO_OPEN_RETRY);
    }

    Err(io::Error::new(
        io::ErrorKind::Interrupted,
        "native audio writer stopped before FIFO opened",
    ))
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

fn amplitude_to_db(amplitude: f32) -> f32 {
    if amplitude <= f32::EPSILON {
        -90.0
    } else {
        20.0 * amplitude.log10()
    }
}

fn db_to_level(db: f32) -> f64 {
    f64::from(((db + 60.0) / 60.0).clamp(0.0, 1.0))
}

fn timestamp_for_frame(frame_cursor: u64) -> u64 {
    frame_cursor.saturating_mul(1_000_000) / u64::from(NATIVE_AUDIO_SAMPLE_RATE)
}

fn permission_or_unavailable(message: &str) -> AudioMeterStatus {
    let lower = message.to_lowercase();
    if lower.contains("permission") || lower.contains("unauthor") {
        AudioMeterStatus::PermissionRequired
    } else {
        AudioMeterStatus::Unavailable
    }
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

    let (sender, receiver) = mpsc::sync_channel(AUDIO_RING_CAPACITY_FRAMES);
    let stats = Arc::new(AudioCaptureStats::default());
    let callback_stats = stats.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let callback_stop = stop.clone();
    let mut frame_cursor = 0_u64;

    type Args = render_callback::Args<data::Interleaved<f32>>;
    audio_unit
        .set_input_callback(move |args: Args| {
            if callback_stop.load(Ordering::Relaxed) {
                return Ok(());
            }

            let samples = process_interleaved_f32(args.data.buffer, args.data.channels, settings);
            let frame_count = samples.len() / usize::from(NATIVE_AUDIO_CHANNELS);
            let frame = AudioFrame {
                timestamp_micros: timestamp_for_frame(frame_cursor),
                sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
                channels: NATIVE_AUDIO_CHANNELS,
                samples,
            };
            frame_cursor = frame_cursor.saturating_add(frame_count as u64);
            callback_stats
                .captured_frames
                .fetch_add(frame_count as u64, Ordering::Relaxed);

            match sender.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(frame)) => {
                    callback_stats
                        .dropped_frames
                        .fetch_add(frame.frame_count() as u64, Ordering::Relaxed);
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
        stop,
        stop_on_drop: true,
        audio_unit: Some(audio_unit),
    })
}

#[cfg(not(target_os = "macos"))]
fn start_platform_audio_source(
    _device_id: u32,
    _settings: AudioProcessingSettings,
) -> Result<NativeAudioSource> {
    bail!("Native microphone capture is only implemented on macOS");
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

#[cfg(not(target_os = "macos"))]
fn list_platform_microphones() -> Result<Vec<Device>> {
    bail!("Native microphone discovery is only implemented on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn queued_audio_frames_are_discarded_before_fifo_writer_starts() {
        let (sender, receiver) = mpsc::sync_channel(AUDIO_RING_CAPACITY_FRAMES);
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

        stats.captured_frames.fetch_add(480, Ordering::Relaxed);
        stats.dropped_frames.fetch_add(96, Ordering::Relaxed);

        assert_eq!(stats.captured_frames(), 480);
        assert_eq!(stats.dropped_frames(), 96);
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
}
