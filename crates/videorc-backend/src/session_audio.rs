//! One normalized PCM timeline per recording/broadcast. Producers may disappear;
//! the sample cursor and downstream transport belong to the session.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::audio::{AudioFrame, NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_SAMPLE_RATE};

pub const CHUNK_FRAMES: usize = 480;
const MAX_BUFFERED_FRAMES: u64 = 4_800;
const MAX_BUFFERED_PACKETS: usize = 32;
const PLAYOUT_DELAY: Duration = Duration::from_millis(50);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBusCounters {
    pub captured_frames: u64,
    pub generated_frames: u64,
    pub discarded_frames: u64,
    pub dropped_frames: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBusStatus {
    pub sample_cursor: u64,
    pub selected_input: bool,
    pub counters: AudioBusCounters,
}

struct RenderedPcm {
    samples: Vec<f32>,
    captured: Vec<bool>,
}

struct QueuedPcm {
    start: u64,
    samples: Vec<f32>,
}

impl QueuedPcm {
    fn frames(&self) -> u64 {
        (self.samples.len() / usize::from(NATIVE_AUDIO_CHANNELS)) as u64
    }
    fn end(&self) -> u64 {
        self.start + self.frames()
    }
}

pub struct AudioTimeline {
    cursor: u64,
    generation: u64,
    packets: VecDeque<QueuedPcm>,
    counters: AudioBusCounters,
}

impl AudioTimeline {
    pub fn new() -> Self {
        Self {
            cursor: 0,
            generation: 0,
            packets: VecDeque::new(),
            counters: AudioBusCounters::default(),
        }
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }
    pub fn counters(&self) -> AudioBusCounters {
        self.counters
    }

    /// Candidate pre-roll never enters this queue. A committed generation
    /// starts at the existing cursor, with every old packet discarded.
    pub fn select_generation(&mut self, generation: u64) {
        self.counters.discarded_frames += self.packets.iter().map(QueuedPcm::frames).sum::<u64>();
        self.packets.clear();
        self.generation = generation;
    }

    pub fn discard_before(&mut self, floor: u64) {
        while let Some(packet) = self.packets.front_mut() {
            if packet.start >= floor {
                break;
            }
            let frames = floor.saturating_sub(packet.start).min(packet.frames());
            self.counters.discarded_frames += frames;
            if frames == packet.frames() {
                self.packets.pop_front();
            } else {
                packet.samples.drain(..frames as usize * 2);
                packet.start += frames;
                break;
            }
        }
    }

    pub fn push(&mut self, generation: u64, start: u64, frame: AudioFrame) -> bool {
        let frames = frame.frame_count() as u64;
        if generation != self.generation
            || frame.sample_rate != NATIVE_AUDIO_SAMPLE_RATE
            || frame.channels != NATIVE_AUDIO_CHANNELS
            || !frame.samples.len().is_multiple_of(2)
            || frame.samples.iter().any(|sample| !sample.is_finite())
        {
            self.counters.dropped_frames += frames;
            return false;
        }
        let floor = self
            .packets
            .back()
            .map_or(self.cursor, |packet| packet.end().max(self.cursor));
        let trim = floor.saturating_sub(start).min(frames);
        self.counters.discarded_frames += trim;
        if trim == frames {
            return false;
        }
        let start = start + trim;
        let frames = frames - trim;
        if start.saturating_add(frames) > self.cursor.saturating_add(MAX_BUFFERED_FRAMES)
            || self.packets.len() >= MAX_BUFFERED_PACKETS
        {
            self.counters.dropped_frames += frames;
            return false;
        }
        self.packets.push_back(QueuedPcm {
            start,
            samples: frame.samples[(trim as usize * 2)..].to_vec(),
        });
        true
    }

    /// Exactly one chunk is emitted, including intentional/loss silence. The
    /// caller controls pacing; pressure cannot reset or advance this cursor
    /// without emitting the corresponding PCM interval.
    #[cfg(test)]
    pub fn render_chunk(&mut self) -> Vec<f32> {
        self.render_with_provenance().samples
    }

    fn account_stale_chunk(&mut self, chunk: &RenderedPcm, stale_from: Option<usize>) {
        if let Some(from) = stale_from {
            let captured = chunk
                .captured
                .iter()
                .skip(from)
                .filter(|captured| **captured)
                .count() as u64;
            self.counters.captured_frames -= captured;
            self.counters.generated_frames += captured;
            self.counters.discarded_frames += captured;
        }
    }

    fn render_with_provenance(&mut self) -> RenderedPcm {
        let end = self.cursor + CHUNK_FRAMES as u64;
        let mut output = vec![0.0; CHUNK_FRAMES * 2];
        let mut provenance = vec![false; CHUNK_FRAMES];
        let mut captured = 0;
        while let Some(packet) = self.packets.front_mut() {
            if packet.start >= end {
                break;
            }
            let from = packet.start.max(self.cursor);
            let to = packet.end().min(end);
            if from < to {
                let source_offset = ((from - packet.start) * 2) as usize;
                let output_offset = ((from - self.cursor) * 2) as usize;
                let length = ((to - from) * 2) as usize;
                output[output_offset..output_offset + length]
                    .copy_from_slice(&packet.samples[source_offset..source_offset + length]);
                provenance[(from - self.cursor) as usize..(to - self.cursor) as usize].fill(true);
                captured += to - from;
            }
            if packet.end() <= end {
                self.packets.pop_front();
            } else {
                let consumed = ((end - packet.start) * 2) as usize;
                packet.samples.drain(..consumed);
                packet.start = end;
                break;
            }
        }
        self.cursor = end;
        self.counters.captured_frames += captured;
        self.counters.generated_frames += CHUNK_FRAMES as u64 - captured;
        RenderedPcm {
            samples: output,
            captured: provenance,
        }
    }
}

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::audio::{
    AudioCaptureStats, AudioProcessingSettings, AudioProcessingSettingsHandle,
    NativeAudioInputState, NativeAudioSource, process_interleaved_f32,
};

const WRITE_DEADLINE: Duration = Duration::from_secs(5);
const EPOCH_DEADLINE: Duration = Duration::from_secs(30);
static OWNED_WRITERS: AtomicU64 = AtomicU64::new(0);

/// A timed-out native close keeps its writer/producer owned by the original
/// thread. It cannot publish PCM after stop, and admission can observe this
/// fence rather than repeatedly opening devices behind a stuck cleanup.
pub fn cleanup_pending() -> bool {
    OWNED_WRITERS.load(Ordering::Acquire) != 0
}

pub struct SessionAudio {
    pub device_id: u32,
    pub device_name: String,
    pub fifo_path: PathBuf,
    stats: Arc<AudioCaptureStats>,
    selected_input: bool,
    status: Arc<std::sync::Mutex<AudioBusStatus>>,
    processing_settings: AudioProcessingSettingsHandle,
    stop: Arc<AtomicBool>,
    writer: Option<thread::JoinHandle<()>>,
    finished: mpsc::Receiver<()>,
    #[cfg(debug_assertions)]
    caption_contract_test_injector: Option<crate::audio::CaptionContractTestAudioInjector>,
}

impl std::fmt::Debug for SessionAudio {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionAudio")
            .field("device_id", &self.device_id)
            .field("device_name", &self.device_name)
            .field("fifo_path", &self.fifo_path)
            .field("captured_frames", &self.captured_frames())
            .finish_non_exhaustive()
    }
}

impl SessionAudio {
    pub fn status(&self) -> AudioBusStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
    pub fn has_selected_input(&self) -> bool {
        self.selected_input
    }
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
    pub fn input_state(&self) -> NativeAudioInputState {
        self.stats.input_state()
    }
    pub fn source_loss_after_ms(&self) -> Option<u64> {
        self.stats.source_loss_after_ms()
    }
    pub fn claim_source_loss_event(&self) -> Option<u64> {
        self.stats.claim_source_loss_event()
    }
    pub fn recording_window_elapsed_secs(&self) -> Option<f64> {
        self.stats.recording_window_elapsed_secs()
    }
    pub fn finish_recording_window(&self) {
        self.stats.finish_recording_window();
    }
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.stats.mark_stopped();
        self.stats.finish_recording_window();
    }
    pub fn update_processing_settings(&self, settings: AudioProcessingSettings) {
        self.processing_settings.update(settings);
    }
    #[cfg(debug_assertions)]
    pub fn caption_contract_test_injector(
        &self,
    ) -> Option<crate::audio::CaptionContractTestAudioInjector> {
        self.caption_contract_test_injector.clone()
    }
}

impl Drop for SessionAudio {
    fn drop(&mut self) {
        self.request_stop();
        if self.finished.recv_timeout(WRITE_DEADLINE).is_ok() {
            if let Some(writer) = self.writer.take() {
                let _ = writer.join();
            }
        } else {
            // Only uninterruptible native teardown may remain here: FIFO open,
            // writes and epoch waits all observe the stop flag independently.
            tracing::warn!("Session audio cleanup remains quarantined after its 5s deadline.");
        }
        let _ = crate::fifo::cleanup(&self.fifo_path);
    }
}

pub fn attach(
    mut source: Option<NativeAudioSource>,
    fifo_path: PathBuf,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    settings: AudioProcessingSettings,
    source_stall_timeout: Duration,
) -> SessionAudio {
    let selected_input = source.is_some();
    let device_id = source.as_ref().map_or(0, |source| source.device_id);
    let device_name = source.as_ref().map_or_else(
        || "No microphone".into(),
        |source| source.device_name.clone(),
    );
    #[cfg(debug_assertions)]
    let caption_contract_test_injector = source
        .as_ref()
        .and_then(|source| source.caption_contract_test_injector.clone());
    let receiver = source.as_mut().and_then(|source| source.receiver.take());
    let producer_stats = source.as_ref().map(NativeAudioSource::stats_handle);
    let status = Arc::new(std::sync::Mutex::new(AudioBusStatus {
        selected_input,
        ..Default::default()
    }));
    let writer_status = status.clone();
    let stats = Arc::new(AudioCaptureStats::default());
    let stop = Arc::new(AtomicBool::new(false));
    let processing_settings = AudioProcessingSettingsHandle::new(settings);
    let (finished_tx, finished) = mpsc::sync_channel(1);
    let writer_stats = stats.clone();
    let writer_stop = stop.clone();
    let writer_settings = processing_settings.clone();
    let path = fifo_path.clone();
    OWNED_WRITERS.fetch_add(1, Ordering::AcqRel);
    let writer = thread::spawn(move || {
        struct Owner;
        impl Drop for Owner {
            fn drop(&mut self) {
                OWNED_WRITERS.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _owner = Owner;
        let result = run_bus(
            receiver,
            &path,
            video_epoch,
            producer_stats,
            BusContext {
                settings: &writer_settings,
                stats: &writer_stats,
                stop: &writer_stop,
                source_stall_timeout,
                status: &writer_status,
            },
        );
        if let Err(error) = result {
            if writer_stop.load(Ordering::Acquire) {
                writer_stats.mark_stopped();
            } else {
                writer_stats.mark_downstream_closed();
            }
            tracing::warn!("Session audio transport ended: {error}");
        }
        // The output file is already closed and publication fenced. If a
        // native driver hangs here it retains only its own retired producer.
        drop(source);
        let _ = finished_tx.send(());
    });
    SessionAudio {
        device_id,
        device_name,
        fifo_path,
        stats,
        selected_input,
        status,
        processing_settings,
        stop,
        writer: Some(writer),
        finished,
        #[cfg(debug_assertions)]
        caption_contract_test_injector,
    }
}

fn valid_fresh_frame(frame: &AudioFrame, now: Instant) -> bool {
    frame.sample_rate == NATIVE_AUDIO_SAMPLE_RATE
        && frame.channels == NATIVE_AUDIO_CHANNELS
        && !frame.samples.is_empty()
        && frame.samples.len().is_multiple_of(2)
        && frame.samples.iter().all(|sample| sample.is_finite())
        && frame.captured_at <= now
        && now.duration_since(frame.captured_at) <= Duration::from_millis(100)
}

/// A slowly adjusted device-to-session clock. Hardware rate error is corrected
/// by resampling, never by jumping the session cursor. Arrival jitter is averaged
/// across a bounded 60-second regression window; correction is capped at 0.1%.
struct SourceClock {
    epoch: Instant,
    last_timestamp: Option<u64>,
    device_end: f64,
    mapped_end: f64,
    ratio: f64,
    observations: VecDeque<(f64, f64)>,
    last_observation: f64,
}
impl SourceClock {
    fn new(frame: &AudioFrame, epoch: Instant) -> Self {
        let start = frame
            .captured_at
            .checked_sub(frame.duration())
            .unwrap_or(epoch);
        Self {
            epoch,
            last_timestamp: None,
            device_end: frame.timestamp_micros as f64 * 0.048,
            mapped_end: start.saturating_duration_since(epoch).as_secs_f64() * 48_000.0,
            ratio: 1.0,
            observations: VecDeque::new(),
            last_observation: f64::NEG_INFINITY,
        }
    }

    fn interval(&mut self, frame: &AudioFrame) -> Option<(u64, usize)> {
        if self
            .last_timestamp
            .is_some_and(|last| frame.timestamp_micros <= last)
        {
            return None;
        }
        self.last_timestamp = Some(frame.timestamp_micros);
        let device_start = frame.timestamp_micros as f64 * 0.048;
        let frames = frame.frame_count() as f64;
        let device_end = device_start + frames;
        let observed_end = frame
            .captured_at
            .saturating_duration_since(self.epoch)
            .as_secs_f64()
            * 48_000.0;
        if device_end - self.last_observation >= 24_000.0 {
            self.last_observation = device_end;
            self.observations.push_back((device_end, observed_end));
            while self.observations.len() > 121 {
                self.observations.pop_front();
            }
            let (first_x, first_y) = *self.observations.front()?;
            if device_end - first_x >= 240_000.0 {
                let count = self.observations.len() as f64;
                let (sx, sy, sxx, sxy) = self.observations.iter().fold(
                    (0.0, 0.0, 0.0, 0.0),
                    |(sx, sy, sxx, sxy), (x, y)| {
                        let x = x - first_x;
                        let y = y - first_y;
                        (sx + x, sy + y, sxx + x * x, sxy + x * y)
                    },
                );
                let slope = ((sxy - sx * sy / count) / (sxx - sx * sx / count)).clamp(0.999, 1.001);
                let predicted_end =
                    first_y + (sy - slope * sx) / count + slope * (device_end - first_x);
                let phase_error =
                    predicted_end - (self.mapped_end + (device_end - self.device_end) * self.ratio);
                let correction = (phase_error / (30.0 * 48_000.0)).clamp(-0.00025, 0.00025);
                let target = (slope + correction).clamp(0.999, 1.001);
                self.ratio += (target - self.ratio) * 0.05;
            }
        }
        // Microsecond timestamps quantize 48kHz positions by at most 0.024
        // frames. Preserve exact continuity at packet boundaries within that
        // tolerance; genuine missing intervals remain silence in the bus.
        let gap = device_start - self.device_end;
        let gap = if gap.abs() < 0.05 { 0.0 } else { gap };
        let start = self.mapped_end + gap * self.ratio;
        self.mapped_end = start + frames * self.ratio;
        self.device_end = device_end;
        let start = start.round().max(0.0) as u64;
        let end = self.mapped_end.round().max(0.0) as u64;
        Some((start, end.saturating_sub(start) as usize))
    }
}

fn resample_frame(mut frame: AudioFrame, frames: usize) -> AudioFrame {
    let input_frames = frame.frame_count();
    if frames == input_frames || input_frames == 0 {
        return frame;
    }
    let mut samples = Vec::with_capacity(frames * 2);
    for index in 0..frames {
        let position = index as f64 * input_frames as f64 / frames as f64;
        let left = (position.floor() as usize).min(input_frames - 1);
        let right = (left + 1).min(input_frames - 1);
        let fraction = (position - left as f64) as f32;
        for channel in 0..2 {
            let a = frame.samples[left * 2 + channel];
            let b = frame.samples[right * 2 + channel];
            samples.push(a + (b - a) * fraction);
        }
    }
    frame.samples = samples;
    frame
}

struct BusContext<'a> {
    settings: &'a AudioProcessingSettingsHandle,
    stats: &'a AudioCaptureStats,
    stop: &'a AtomicBool,
    source_stall_timeout: Duration,
    status: &'a std::sync::Mutex<AudioBusStatus>,
}

fn run_bus(
    mut receiver: Option<mpsc::Receiver<AudioFrame>>,
    path: &std::path::Path,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    producer_stats: Option<Arc<AudioCaptureStats>>,
    context: BusContext<'_>,
) -> io::Result<()> {
    let BusContext {
        settings,
        stats,
        stop,
        source_stall_timeout,
        status,
    } = context;
    let mut file = crate::fifo::open_writer(
        path,
        stop,
        Duration::from_millis(5),
        false,
        "Session audio stopped before the reader opened",
    )?;
    let wait_started = Instant::now();
    let epoch = match video_epoch {
        Some(epoch) => loop {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Some(epoch) = epoch.get() {
                break *epoch;
            }
            if wait_started.elapsed() >= EPOCH_DEADLINE {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Video epoch did not arrive",
                ));
            }
            if let Some(receiver) = receiver.as_ref() {
                while receiver.try_recv().is_ok() {}
            }
            thread::sleep(Duration::from_millis(2));
        },
        None => Instant::now(),
    };
    stats.reset_recording_window();
    if receiver.is_none() {
        stats.mark_silent();
    }
    let mut timeline = AudioTimeline::new();
    timeline.select_generation(0);
    let mut last_source_frame = Instant::now();
    let mut clock = None;
    let mut accounted = AudioBusCounters::default();
    let mut previous_producer_drops = producer_stats
        .as_ref()
        .map_or(0, |stats| stats.dropped_frames());
    while !stop.load(Ordering::Acquire) {
        if let Some(stats) = producer_stats.as_ref() {
            let drops = stats.dropped_frames();
            timeline.counters.dropped_frames += drops.saturating_sub(previous_producer_drops);
            previous_producer_drops = drops;
        }
        let mut source_lost = false;
        if let Some(receiver) = receiver.as_ref() {
            loop {
                match receiver.try_recv() {
                    Ok(frame) => {
                        let now = Instant::now();
                        if !valid_fresh_frame(&frame, now) {
                            timeline.counters.discarded_frames += frame.frame_count() as u64;
                            continue;
                        }
                        let trimmed = crate::audio::trim_audio_frame_before_epoch(frame, epoch);
                        timeline.counters.discarded_frames += trimmed.discarded_frames;
                        let Some(frame) = trimmed.frame else {
                            continue;
                        };
                        let clock = clock.get_or_insert_with(|| SourceClock::new(&frame, epoch));
                        let Some((start, frames)) = clock.interval(&frame) else {
                            timeline.counters.discarded_frames += frame.frame_count() as u64;
                            continue;
                        };
                        if timeline.push(0, start, resample_frame(frame, frames)) {
                            last_source_frame = now;
                            stats.mark_live();
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        source_lost = true;
                        break;
                    }
                }
            }
            source_lost |= last_source_frame.elapsed() >= source_stall_timeout;
        }
        if source_lost {
            receiver = None;
            stats.mark_source_lost_at(Instant::now());
        }
        let now = Instant::now();
        let wall_cursor = now
            .saturating_duration_since(epoch)
            .saturating_sub(PLAYOUT_DELAY)
            .as_nanos()
            * u128::from(NATIVE_AUDIO_SAMPLE_RATE)
            / 1_000_000_000;
        timeline.discard_before((wall_cursor as u64).saturating_sub(MAX_BUFFERED_FRAMES));
        let next = epoch
            + PLAYOUT_DELAY
            + Duration::from_nanos(
                (timeline.cursor() + CHUNK_FRAMES as u64) * 1_000_000_000
                    / u64::from(NATIVE_AUDIO_SAMPLE_RATE),
            );
        if let Some(remaining) = next.checked_duration_since(Instant::now()) {
            thread::sleep(remaining.min(Duration::from_millis(2)));
            continue;
        }
        let start = timeline.cursor();
        let raw = timeline.render_with_provenance();
        let written = write_chunk(&mut file, &raw.samples, settings, stop)?;
        timeline.account_stale_chunk(&raw, written.stale_from);
        let frame = AudioFrame {
            timestamp_micros: start * 1_000_000 / u64::from(NATIVE_AUDIO_SAMPLE_RATE),
            captured_at: epoch
                + Duration::from_nanos(start * 1_000_000_000 / u64::from(NATIVE_AUDIO_SAMPLE_RATE)),
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples: written.samples,
        };
        stats.record_live_peak(
            frame
                .samples
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs())),
        );
        crate::captions::offer_caption_frame(&frame);
        let after = timeline.counters();
        stats.record_captured_frames(after.captured_frames - accounted.captured_frames);
        stats.record_generated_frames(after.generated_frames - accounted.generated_frames);
        stats.record_dropped_frames(after.dropped_frames - accounted.dropped_frames);
        accounted = after;
        let mut status = status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.sample_cursor = timeline.cursor();
        status.counters = after;
    }
    Ok(())
}

struct WrittenChunk {
    samples: Vec<f32>,
    stale_from: Option<usize>,
}

fn write_chunk(
    file: &mut impl Write,
    raw: &[f32],
    settings: &AudioProcessingSettingsHandle,
    stop: &AtomicBool,
) -> io::Result<WrittenChunk> {
    write_chunk_with_clock(file, raw, settings, stop, Instant::now, || {
        thread::sleep(Duration::from_millis(1));
    })
}

fn write_chunk_with_clock(
    file: &mut impl Write,
    raw: &[f32],
    settings: &AudioProcessingSettingsHandle,
    stop: &AtomicBool,
    mut now: impl FnMut() -> Instant,
    mut wait: impl FnMut(),
) -> io::Result<WrittenChunk> {
    let started = now();
    let deadline = started + WRITE_DEADLINE;
    let mut bytes = vec![0; raw.len() * 4];
    let mut written = 0;
    let mut stale_from = None;
    while written < bytes.len() {
        if stop.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Session audio stopped",
            ));
        }
        let clock = now();
        if clock >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Session audio output stopped accepting PCM",
            ));
        }
        // Refresh controls from RAW input before every attempt. Already written
        // bytes are immutable; a mute during pressure cannot release queued
        // unmuted speech when the reader resumes. Finish any partially written
        // stereo frame before changing controls so the stream stays well-formed.
        let replace_from = written.div_ceil(8) * 8;
        if clock.duration_since(started) >= Duration::from_millis(100) {
            bytes[replace_from..].fill(0);
            stale_from.get_or_insert(replace_from / 8);
        } else {
            let processed = process_interleaved_f32(raw, 2, settings.load());
            for (index, sample) in processed.iter().enumerate().skip(replace_from / 4) {
                bytes[index * 4..index * 4 + 4].copy_from_slice(&sample.to_le_bytes());
            }
        }
        match file.write(&bytes[written..]) {
            Ok(0) => {}
            Ok(count) => {
                written += count;
                continue;
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
        wait();
    }
    Ok(WrittenChunk {
        samples: bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().expect("complete PCM sample")))
            .collect(),
        stale_from,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn frame(value: f32, count: usize) -> AudioFrame {
        AudioFrame {
            timestamp_micros: 0,
            captured_at: Instant::now(),
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples: vec![value; count * 2],
        }
    }

    #[test]
    fn no_input_and_eof_keep_exact_sample_accounting() {
        let mut timeline = AudioTimeline::new();
        assert_eq!(timeline.render_chunk(), vec![0.0; 960]);
        assert!(timeline.push(0, 480, frame(0.5, 480)));
        assert_eq!(timeline.render_chunk(), vec![0.5; 960]);
        for _ in 0..100 {
            assert_eq!(timeline.render_chunk(), vec![0.0; 960]);
        }
        assert_eq!(timeline.cursor(), 102 * 480);
        assert_eq!(timeline.counters().captured_frames, 480);
        assert_eq!(timeline.counters().generated_frames, 101 * 480);
    }

    #[test]
    fn replacement_discards_old_preroll_without_resetting_the_cursor() {
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.2, 960));
        timeline.render_chunk();
        timeline.select_generation(1);
        assert!(!timeline.push(0, 480, frame(0.2, 480)));
        timeline.push(1, 0, frame(0.7, 960));
        assert_eq!(timeline.render_chunk(), vec![0.7; 960]);
        assert_eq!(timeline.cursor(), 960);
        assert_eq!(timeline.counters().discarded_frames, 960);
        assert_eq!(timeline.counters().dropped_frames, 480);
    }

    #[test]
    fn late_overlap_is_trimmed_and_future_buffering_is_bounded() {
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.2, 480));
        timeline.push(0, 240, frame(0.8, 480));
        assert!(!timeline.push(0, 4800, frame(1.0, 480)));
        assert_eq!(timeline.render_chunk(), vec![0.2; 960]);
        let next = timeline.render_chunk();
        assert_eq!(&next[..480], &[0.8; 480]);
        assert_eq!(&next[480..], &[0.0; 480]);
        assert_eq!(timeline.counters().discarded_frames, 240);
    }

    #[test]
    fn duplicate_and_fully_late_frames_cannot_confirm_input_health() {
        let epoch = Instant::now();
        let mut frame = frame(0.5, 480);
        frame.captured_at = epoch + Duration::from_millis(10);
        let mut clock = SourceClock::new(&frame, epoch);
        assert_eq!(clock.interval(&frame), Some((0, 480)));
        frame.captured_at += Duration::from_millis(10);
        assert_eq!(clock.interval(&frame), None);
        let mut timeline = AudioTimeline::new();
        timeline.render_chunk();
        assert!(!timeline.push(0, 0, frame));
    }

    #[test]
    fn pressure_discards_old_speech_and_accounts_silent_catchup_without_cursor_jump() {
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.8, 960));
        timeline.render_chunk();
        // A downstream stall advanced wall time, but no corresponding PCM
        // interval has been delivered. Old speech must never be replayed.
        timeline.discard_before(48_000);
        for _ in 0..100 {
            assert!(timeline.render_chunk().iter().all(|value| *value == 0.0));
        }
        assert_eq!(timeline.cursor(), 48_480);
        assert_eq!(timeline.counters().captured_frames, 480);
        assert_eq!(timeline.counters().discarded_frames, 480);
        assert_eq!(timeline.counters().generated_frames, 48_000);
    }

    #[test]
    fn device_clock_drift_is_gradually_resampled_with_callback_jitter() {
        for drift in [-100.0, -30.0, 30.0, 100.0] {
            let epoch = Instant::now();
            let mut packet = frame(0.3, 480);
            packet.captured_at = epoch + Duration::from_millis(10);
            let mut clock = SourceClock::new(&packet, epoch);
            let mut end = 0;
            for index in 0..180_000u64 {
                packet.timestamp_micros = index * 10_000;
                let seconds = (index + 1) as f64 * 0.01 * (1.0 + drift / 1_000_000.0);
                let jitter = if index % 2 == 0 { 0.001 } else { -0.001 };
                packet.captured_at = epoch + Duration::from_secs_f64(seconds + jitter);
                let (start, count) = clock.interval(&packet).unwrap();
                assert!(
                    start.abs_diff(end) <= 1,
                    "continuous resampling must not insert clock resets"
                );
                end = start + count as u64;
            }
            let expected = 1800.0 * 48_000.0 * (1.0 + drift / 1_000_000.0);
            assert!(
                (end as f64 - expected).abs() < 48_000.0 * 0.020,
                "drift={drift} error={}ms",
                (end as f64 - expected) / 48.0
            );
        }
    }

    #[test]
    fn partial_stereo_frame_preserves_bytes_and_mute_applies_to_unpublished_frames() {
        struct PartialWriter<'a> {
            bytes: Vec<u8>,
            settings: &'a AudioProcessingSettingsHandle,
        }
        impl Write for PartialWriter<'_> {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let count = if self.bytes.is_empty() {
                    3
                } else {
                    bytes.len()
                };
                self.bytes.extend_from_slice(&bytes[..count]);
                self.settings.update(AudioProcessingSettings {
                    gain_db: 6.0,
                    muted: true,
                });
                Ok(count)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let settings = AudioProcessingSettingsHandle::new(AudioProcessingSettings {
            gain_db: 6.0,
            muted: false,
        });
        let mut writer = PartialWriter {
            bytes: vec![],
            settings: &settings,
        };
        let now = Instant::now();
        let result = write_chunk_with_clock(
            &mut writer,
            &[0.25; 960],
            &settings,
            &AtomicBool::new(false),
            || now,
            || {},
        )
        .unwrap();
        let gained = 0.25 * 10.0_f32.powf(6.0 / 20.0);
        assert!((result.samples[0] - gained).abs() < 0.00001);
        assert!((result.samples[1] - gained).abs() < 0.00001);
        assert!(result.samples[2..].iter().all(|sample| *sample == 0.0));
        assert_eq!(result.stale_from, None);
        assert_eq!(
            writer.bytes,
            result
                .samples
                .iter()
                .flat_map(|sample| sample.to_le_bytes())
                .collect::<Vec<_>>()
        );
        let frame = AudioFrame {
            timestamp_micros: 20_000,
            captured_at: now,
            sample_rate: 48_000,
            channels: 2,
            samples: result.samples,
        };
        let caption = crate::captions::round_trip_caption_audio_test_frame(&frame);
        assert_eq!(caption.samples, frame.samples);
        assert_eq!(caption.timestamp_micros, 20_000);
    }

    #[test]
    fn stalled_writer_discards_unpublished_speech_and_cancellation_has_a_deadline() {
        struct BlockOnce {
            bytes: Vec<u8>,
            blocked: bool,
        }
        impl Write for BlockOnce {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if !self.blocked {
                    self.blocked = true;
                    return Err(io::ErrorKind::WouldBlock.into());
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let now = std::cell::Cell::new(Instant::now());
        let settings = AudioProcessingSettingsHandle::new(AudioProcessingSettings::default());
        let mut writer = BlockOnce {
            bytes: vec![],
            blocked: false,
        };
        let result = write_chunk_with_clock(
            &mut writer,
            &[0.8; 960],
            &settings,
            &AtomicBool::new(false),
            || now.get(),
            || now.set(now.get() + Duration::from_millis(200)),
        )
        .unwrap();
        assert!(result.samples.iter().all(|sample| *sample == 0.0));
        assert_eq!(result.stale_from, Some(0));
        let mut writer = BlockOnce {
            bytes: vec![],
            blocked: false,
        };
        let result = write_chunk_with_clock(
            &mut writer,
            &[0.8; 960],
            &settings,
            &AtomicBool::new(false),
            || now.get(),
            || now.set(now.get() + WRITE_DEADLINE),
        );
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::TimedOut);
        assert!(writer.bytes.is_empty());
        let stop = AtomicBool::new(false);
        let mut writer = BlockOnce {
            bytes: vec![],
            blocked: false,
        };
        let result = write_chunk_with_clock(
            &mut writer,
            &[0.8; 960],
            &settings,
            &stop,
            || now.get(),
            || stop.store(true, Ordering::Release),
        );
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::Interrupted);
        assert!(writer.bytes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn absent_input_keeps_one_pipe_open_with_truthful_silence_through_stop() {
        use std::io::Read;
        let path =
            std::env::temp_dir().join(format!("videorc-silent-bus-{}.fifo", uuid::Uuid::new_v4()));
        crate::fifo::create(&path).unwrap();
        let reader_path = path.clone();
        let reader = thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).unwrap();
            let mut bytes = vec![];
            file.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let session = attach(
            None,
            path,
            None,
            AudioProcessingSettings::default(),
            Duration::from_secs(1),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.status().sample_cursor < 960 && Instant::now() < deadline {
            thread::yield_now();
        }
        let status = session.status();
        assert!(status.sample_cursor >= 960);
        assert_eq!(session.input_state(), NativeAudioInputState::Silent);
        assert!(!status.selected_input);
        assert_eq!(status.counters.captured_frames, 0);
        assert_eq!(status.counters.generated_frames, status.sample_cursor);
        session.request_stop();
        assert_eq!(session.input_state(), NativeAudioInputState::Stopped);
        assert!(!session.has_selected_input());
        assert_eq!(session.claim_source_loss_event(), None);
        drop(session);
        let bytes = reader.join().unwrap();
        assert!(bytes.len() >= 960 * 8);
        assert!(bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn pressure_accounting_intersects_real_samples_with_only_the_replaced_suffix() {
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.5, 240));
        let chunk = timeline.render_with_provenance();
        timeline.account_stale_chunk(&chunk, Some(240));
        assert_eq!(timeline.counters().captured_frames, 240);
        assert_eq!(timeline.counters().generated_frames, 240);
        assert_eq!(timeline.counters().discarded_frames, 0);
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 240, frame(0.5, 240));
        let chunk = timeline.render_with_provenance();
        timeline.account_stale_chunk(&chunk, Some(300));
        assert_eq!(timeline.counters().captured_frames, 60);
        assert_eq!(timeline.counters().generated_frames, 420);
        assert_eq!(timeline.counters().discarded_frames, 180);
    }

    #[test]
    fn silent_pcm_is_real_capture_and_malformed_formats_are_not() {
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.0, 480));
        timeline.render_chunk();
        assert_eq!(timeline.counters().captured_frames, 480);
        assert_eq!(timeline.counters().generated_frames, 0);
        let mut malformed = frame(0.4, 480);
        malformed.sample_rate = 44100;
        assert!(!timeline.push(0, 480, malformed));
        assert!(!timeline.push(0, 480, frame(f32::NAN, 480)));
    }
}
