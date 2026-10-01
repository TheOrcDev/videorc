//! One normalized PCM timeline per recording/broadcast. Producers may disappear;
//! the sample cursor and downstream transport belong to the session.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::audio::{AudioFrame, NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_SAMPLE_RATE};

pub const CHUNK_FRAMES: usize = 480;
/// How far ahead of the cursor captured audio may wait, sized in TIME rather
/// than packets so a 128-frame CoreAudio callback (Shure MV7+) gets the same
/// headroom as a 512-frame one (built-in microphone). One second absorbs a
/// bursty FIFO reader (FFmpeg drains the 64 KiB Darwin pipe in ~170 ms gulps)
/// and a slow muxer start without turning captured speech into silence. Memory
/// stays bounded by the producer's 1024-packet channel upstream.
const MAX_BUFFERED_FRAMES: u64 = 48_000;
/// Contiguous packets are merged until a queued packet reaches this size, so
/// the queue length is independent of the device callback size.
const COALESCE_LIMIT_FRAMES: u64 = 4_800;
/// Frames older than this at ingest are stale. The producer channel holds
/// about 2.7 s of 128-frame packets, so anything older cannot be real time.
const MAX_FRAME_AGE: Duration = Duration::from_secs(2);
/// How far the bus cursor trails the wall clock. Only write timing depends on
/// it: FFmpeg timestamps the bus input by sample count, so a different delay
/// writes the same PCM bytes, later (plan 069 decision 13).
pub const PLAYOUT_DELAY: Duration = Duration::from_millis(50);
/// Sessions on a platform that can capture system audio run the bus with this
/// headroom, fixed at session start whether or not the switch is on. System
/// buffers arrive 22-52 ms after their last sample (S0), so 50 ms would place
/// about 31% of them behind the cursor.
pub const SYSTEM_AUDIO_PLAYOUT_DELAY: Duration = Duration::from_millis(150);
/// The enable/disable envelope for a mixed source and the microphone handoff
/// ramp: 5 ms at 48 kHz.
const RAMP_FRAMES: u16 = 240;
/// Peak limiter on the mixed sum (plan 069 decision 7): -1 dBFS ceiling,
/// instant attack, about 50 ms release. It runs only while a system source is
/// attached, or while it is still releasing after one detached.
const LIMITER_CEILING: f32 = 0.891_250_9;
const LIMITER_RELEASE_FRAMES: f64 = 0.050 * 48_000.0;

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
    pub generation: u64,
    pub device_id: Option<String>,
    pub device_name: String,
    pub last_commit: Option<AudioCommitReceipt>,
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
    losses: BusLosses,
    /// How far past the cursor a packet may land: [`MAX_BUFFERED_FRAMES`]
    /// plus the source's bus delay, which places every packet that much
    /// further ahead (plan 069 decision 8). Without it a microphone offset
    /// near its +1000 ms ceiling would land beyond the cap and record silence.
    ahead_limit: u64,
}

/// What [`AudioTimeline::push_outcome`] did with one packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushOutcome {
    Placed,
    /// More than the ahead limit past the cursor. `end` is where the packet
    /// ended on the bus timeline; `frames` were dropped.
    AheadOfCap {
        end: u64,
        frames: u64,
    },
    /// Malformed, from another generation, or wholly overlapping.
    Rejected,
}

/// Why captured audio did not reach the bus, split by cause. Diagnostics only:
/// `AudioBusCounters` stays the renderer contract, this explains its totals in
/// the log when a take loses microphone audio.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BusLosses {
    /// Refused because it landed more than `MAX_BUFFERED_FRAMES` past the cursor.
    pub dropped_ahead_of_cap: u64,
    /// The part of `dropped_ahead_of_cap` that was on time by the wall clock
    /// while the output had fallen behind (plan 076): the reader stalled, the
    /// source did not.
    pub dropped_output_behind: u64,
    /// Refused for a wrong generation, format, or non-finite samples.
    pub dropped_malformed: u64,
    /// The producer's own channel was full when CoreAudio delivered the frame.
    pub producer_queue_full: u64,
    /// Older than `MAX_FRAME_AGE` (or malformed) when the bus ingested it.
    pub discarded_stale: u64,
    /// Captured before the video epoch (pre-roll), never part of the take.
    pub discarded_before_epoch: u64,
    /// Overlapped audio already rendered or queued.
    pub discarded_overlap: u64,
    /// Repeated or non-advancing device timestamps.
    pub discarded_duplicate: u64,
    /// Queued packets discarded when the wall clock moved past the buffer.
    pub discarded_behind_cap: u64,
    /// Chunk frames replaced by silence because the FIFO stayed full for 100 ms.
    pub stale_written: u64,
}

impl BusLosses {
    fn merge(&mut self, other: BusLosses) {
        self.dropped_ahead_of_cap += other.dropped_ahead_of_cap;
        self.dropped_output_behind += other.dropped_output_behind;
        self.dropped_malformed += other.dropped_malformed;
        self.producer_queue_full += other.producer_queue_full;
        self.discarded_stale += other.discarded_stale;
        self.discarded_before_epoch += other.discarded_before_epoch;
        self.discarded_overlap += other.discarded_overlap;
        self.discarded_duplicate += other.discarded_duplicate;
        self.discarded_behind_cap += other.discarded_behind_cap;
        self.stale_written += other.stale_written;
    }
}

impl AudioTimeline {
    pub fn new() -> Self {
        Self {
            cursor: 0,
            generation: 0,
            packets: VecDeque::new(),
            counters: AudioBusCounters::default(),
            losses: BusLosses::default(),
            ahead_limit: MAX_BUFFERED_FRAMES,
        }
    }

    /// Widens the ahead-of-cursor cap by the source's bus delay.
    fn with_delay_headroom(mut self, delay_frames: u64) -> Self {
        self.ahead_limit = MAX_BUFFERED_FRAMES.saturating_add(delay_frames);
        self
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }
    pub fn counters(&self) -> AudioBusCounters {
        self.counters
    }
    pub fn losses(&self) -> BusLosses {
        self.losses
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
            self.losses.discarded_behind_cap += frames;
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
        self.push_outcome(generation, start, frame) == PushOutcome::Placed
    }

    /// [`Self::push`], saying why a packet did not reach the queue.
    fn push_outcome(&mut self, generation: u64, start: u64, frame: AudioFrame) -> PushOutcome {
        let frames = frame.frame_count() as u64;
        if generation != self.generation
            || frame.sample_rate != NATIVE_AUDIO_SAMPLE_RATE
            || frame.channels != NATIVE_AUDIO_CHANNELS
            || !frame.samples.len().is_multiple_of(2)
            || frame.samples.iter().any(|sample| !sample.is_finite())
        {
            self.counters.dropped_frames += frames;
            self.losses.dropped_malformed += frames;
            return PushOutcome::Rejected;
        }
        let floor = self
            .packets
            .back()
            .map_or(self.cursor, |packet| packet.end().max(self.cursor));
        let trim = floor.saturating_sub(start).min(frames);
        self.counters.discarded_frames += trim;
        self.losses.discarded_overlap += trim;
        if trim == frames {
            return PushOutcome::Rejected;
        }
        let start = start + trim;
        let frames = frames - trim;
        // The only ceiling is time ahead of the cursor. A packet count would
        // give a 128-frame callback device a fraction of the headroom.
        let end = start.saturating_add(frames);
        if end > self.cursor.saturating_add(self.ahead_limit) {
            self.counters.dropped_frames += frames;
            self.losses.dropped_ahead_of_cap += frames;
            return PushOutcome::AheadOfCap { end, frames };
        }
        let samples = &frame.samples[(trim as usize * 2)..];
        if let Some(back) = self.packets.back_mut()
            && back.end() == start
            && back.frames() < COALESCE_LIMIT_FRAMES
        {
            back.samples.extend_from_slice(samples);
        } else {
            self.packets.push_back(QueuedPcm {
                start,
                samples: samples.to_vec(),
            });
        }
        PushOutcome::Placed
    }

    /// Plan 076: a packet refused ahead of the cursor, but whose end lies
    /// within the ahead limit of where the cursor would be if the output kept
    /// pace with the wall clock (`wall_cursor`), was on time. The output fell
    /// behind, not the source. Counted as `dropped_output_behind`.
    fn on_time_by_wall_clock(&mut self, end: u64, frames: u64, wall_cursor: u64) -> bool {
        if end > wall_cursor.saturating_add(self.ahead_limit) {
            return false;
        }
        self.losses.dropped_output_behind += frames;
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
/// System-audio producers live in their own pool and are never counted here.
pub fn cleanup_pending(standby_owners: u64) -> bool {
    OWNED_WRITERS.load(Ordering::Acquire) != 0
        || OWNED_PRODUCERS.load(Ordering::Acquire) > standby_owners
}

const PRODUCER_LIMIT: u64 = 2;
static OWNED_PRODUCERS: AtomicU64 = AtomicU64::new(0);
/// Plan 069 decision 11: one system-audio producer at a time, in a pool and
/// owned counter of its own, so it never blocks microphone admission or a
/// microphone hot-swap (which needs both microphone slots).
const SYSTEM_PRODUCER_LIMIT: u64 = 1;
static OWNED_SYSTEM_PRODUCERS: AtomicU64 = AtomicU64::new(0);

/// What a bus source is. The microphone is folded to centered mono with the
/// user's gain and mute; system audio keeps its stereo image and has a gain
/// only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceRole {
    Microphone,
    System,
}
impl SourceRole {
    const fn producer_limit(self) -> u64 {
        match self {
            Self::Microphone => PRODUCER_LIMIT,
            Self::System => SYSTEM_PRODUCER_LIMIT,
        }
    }
    fn owned(self) -> &'static AtomicU64 {
        match self {
            Self::Microphone => &OWNED_PRODUCERS,
            Self::System => &OWNED_SYSTEM_PRODUCERS,
        }
    }
    const fn label(self) -> &'static str {
        match self {
            Self::Microphone => "Microphone",
            Self::System => "System audio",
        }
    }
    const fn busy_message(self) -> &'static str {
        match self {
            Self::Microphone => {
                "A microphone is still opening or closing; wait for its cleanup before retrying."
            }
            Self::System => {
                "System audio is still opening or closing; wait for its cleanup before retrying."
            }
        }
    }
}
/// A producer pool is full because an earlier capture is still opening or
/// closing. Typed so a caller can wait for that cleanup instead of failing
/// (the System audio switch retries across a just-detached capture); the
/// message is unchanged.
#[derive(Debug)]
pub struct ProducerPoolBusy(&'static str);
impl std::fmt::Display for ProducerPoolBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for ProducerPoolBusy {}

static PRODUCER_CLOSED: OnceLock<(std::sync::Mutex<()>, std::sync::Condvar)> = OnceLock::new();
fn wait_for_producer_cleanup(count: &AtomicU64, deadline: Instant) -> bool {
    let (mutex, closed) = PRODUCER_CLOSED.get_or_init(Default::default);
    let mut guard = mutex.lock().unwrap_or_else(|p| p.into_inner());
    while count.load(Ordering::Acquire) != 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let (next, _) = closed
            .wait_timeout(guard, remaining)
            .unwrap_or_else(|p| p.into_inner());
        guard = next;
    }
    true
}

#[cfg(not(test))]
static PLATFORM_PRODUCER_POOL: OnceLock<Arc<AtomicU64>> = OnceLock::new();
#[cfg(not(test))]
static PLATFORM_SYSTEM_PRODUCER_POOL: OnceLock<Arc<AtomicU64>> = OnceLock::new();
struct ProducerPermit {
    local: Arc<AtomicU64>,
    platform: Arc<AtomicU64>,
    role: SourceRole,
}
impl ProducerPermit {
    fn acquire(local: Arc<AtomicU64>) -> anyhow::Result<Self> {
        Self::acquire_role(SourceRole::Microphone, local)
    }
    fn acquire_role(role: SourceRole, local: Arc<AtomicU64>) -> anyhow::Result<Self> {
        #[cfg(not(test))]
        let platform = match role {
            SourceRole::Microphone => &PLATFORM_PRODUCER_POOL,
            SourceRole::System => &PLATFORM_SYSTEM_PRODUCER_POOL,
        }
        .get_or_init(|| Arc::new(AtomicU64::new(0)))
        .clone();
        #[cfg(test)]
        let platform = local.clone(); // Independent unit sessions do not share devices.
        Self::acquire_in_role(role, local, platform)
    }
    #[cfg(test)]
    fn acquire_in(local: Arc<AtomicU64>, platform: Arc<AtomicU64>) -> anyhow::Result<Self> {
        Self::acquire_in_role(SourceRole::Microphone, local, platform)
    }
    // Rust 1.99 renames fetch_update to try_update; release builds still use 1.98.
    #[allow(deprecated)]
    fn acquire_in_role(
        role: SourceRole,
        local: Arc<AtomicU64>,
        platform: Arc<AtomicU64>,
    ) -> anyhow::Result<Self> {
        platform
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < role.producer_limit()).then_some(count + 1)
            })
            .map_err(|_| anyhow::Error::new(ProducerPoolBusy(role.busy_message())))?;
        if !Arc::ptr_eq(&local, &platform) {
            local.fetch_add(1, Ordering::AcqRel);
        }
        role.owned().fetch_add(1, Ordering::AcqRel);
        Ok(Self {
            local,
            platform,
            role,
        })
    }
}
impl Drop for ProducerPermit {
    fn drop(&mut self) {
        let (mutex, closed) = PRODUCER_CLOSED.get_or_init(Default::default);
        let _guard = mutex.lock().unwrap_or_else(|p| p.into_inner());
        self.platform.fetch_sub(1, Ordering::AcqRel);
        if !Arc::ptr_eq(&self.local, &self.platform) {
            self.local.fetch_sub(1, Ordering::AcqRel);
        }
        self.role.owned().fetch_sub(1, Ordering::AcqRel);
        closed.notify_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProducerCompletion {
    Running,
    Closed,
    Panicked,
}

struct CompletionGuard {
    state: tokio::sync::watch::Sender<ProducerCompletion>,
    closed: mpsc::SyncSender<ProducerCompletion>,
}
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        let state = if thread::panicking() {
            ProducerCompletion::Panicked
        } else {
            ProducerCompletion::Closed
        };
        self.state.send_replace(state);
        let _ = self.closed.send(state);
    }
}
struct CompletionTicket {
    state: tokio::sync::watch::Receiver<ProducerCompletion>,
    closed: mpsc::Receiver<ProducerCompletion>,
}
impl CompletionTicket {
    fn running(&self) -> bool {
        *self.state.borrow() == ProducerCompletion::Running
    }
}
fn completion_channel() -> (CompletionGuard, CompletionTicket) {
    let (state_tx, state_rx) = tokio::sync::watch::channel(ProducerCompletion::Running);
    let (closed_tx, closed_rx) = mpsc::sync_channel(1);
    (
        CompletionGuard {
            state: state_tx,
            closed: closed_tx,
        },
        CompletionTicket {
            state: state_rx,
            closed: closed_rx,
        },
    )
}

struct ManagedProducer {
    device_id: String,
    device_name: String,
    receiver: Option<mpsc::Receiver<AudioFrame>>,
    stats: Arc<AudioCaptureStats>,
    stop: Option<mpsc::Sender<()>>,
    completion: Option<CompletionTicket>,
    #[cfg(debug_assertions)]
    caption_injector: Option<crate::audio::CaptionContractTestAudioInjector>,
}
impl ManagedProducer {
    fn retire(mut self) -> CompletionTicket {
        self.stop.take();
        self.completion.take().expect("owned completion receipt")
    }
}
impl Drop for ManagedProducer {
    fn drop(&mut self) {
        self.stop.take();
    }
}

struct OpenCancellation(Option<Arc<AtomicBool>>);
impl OpenCancellation {
    fn disarm(&mut self) {
        self.0.take();
    }
}
impl Drop for OpenCancellation {
    fn drop(&mut self) {
        if let Some(cancelled) = self.0.take() {
            cancelled.store(true, Ordering::Release);
        }
    }
}

/// Shared failure slot a capture owner fills when its platform reports that
/// the stream died (the worker's `CapturedInput::failure`, the SCStream
/// `didStopWithError`, WASAPI `AUDCLNT_E_DEVICE_INVALIDATED`).
pub type ProducerFailure = Arc<std::sync::Mutex<Option<String>>>;

/// An opened capture handed to the bus: a receiver of normalized 48 kHz
/// stereo interleaved f32 `AudioFrame`s (`timestamp_micros` on the device
/// clock, `captured_at` = the END of the packet), its stats, a failure slot,
/// and the owner whose Drop closes the device.
pub struct ProducerSource {
    device_id: String,
    device_name: String,
    receiver: mpsc::Receiver<AudioFrame>,
    stats: Arc<AudioCaptureStats>,
    _owner: Box<dyn Send>,
    failure: Option<Arc<std::sync::Mutex<Option<String>>>>,
    #[cfg(debug_assertions)]
    caption_injector: Option<crate::audio::CaptionContractTestAudioInjector>,
}
impl ProducerSource {
    fn native(mut source: NativeAudioSource) -> Self {
        Self {
            device_id: format!("microphone:coreaudio:{}", source.device_id),
            device_name: source.device_name.clone(),
            receiver: source
                .receiver
                .take()
                .expect("native receiver before transfer"),
            stats: source.stats_handle(),
            #[cfg(debug_assertions)]
            caption_injector: source.caption_contract_test_injector.clone(),
            _owner: Box::new(source),
            failure: None,
        }
    }
    fn worker(device_id: String, source: crate::audio_capture_adapter::CapturedInput) -> Self {
        Self {
            device_id,
            device_name: source.device_name,
            receiver: source.receiver,
            stats: source.stats,
            _owner: source.owner,
            failure: Some(source.failure),
            #[cfg(debug_assertions)]
            caption_injector: None,
        }
    }
    /// Plan 069 S2: adapt a system-audio capture (S3's
    /// `system_audio_capture.rs` handle on macOS, S8's WASAPI loopback on
    /// Windows) for [`SystemAudioHandle::prepare`]. The bus never retires it
    /// for silence; it retires only when `failure` is filled or the receiver
    /// disconnects.
    pub fn system(
        device_id: String,
        device_name: String,
        receiver: mpsc::Receiver<AudioFrame>,
        stats: Arc<AudioCaptureStats>,
        failure: ProducerFailure,
        owner: Box<dyn Send>,
    ) -> Self {
        Self {
            device_id,
            device_name,
            receiver,
            stats,
            _owner: owner,
            failure: Some(failure),
            #[cfg(debug_assertions)]
            caption_injector: None,
        }
    }
    fn failure_reason(&self, fallback: &str) -> String {
        self.failure
            .as_ref()
            .and_then(|failure| failure.lock().unwrap_or_else(|p| p.into_inner()).clone())
            .unwrap_or_else(|| fallback.into())
    }
    fn into_managed(
        self,
        stop: mpsc::Sender<()>,
        completion: CompletionTicket,
    ) -> (ManagedProducer, Box<dyn Send>) {
        (
            ManagedProducer {
                device_id: self.device_id,
                device_name: self.device_name,
                receiver: Some(self.receiver),
                stats: self.stats,
                stop: Some(stop),
                completion: Some(completion),
                #[cfg(debug_assertions)]
                caption_injector: self.caption_injector,
            },
            self._owner,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnerPhase {
    BeforeOpened,
    BeforeReady,
}
type OwnerTask = Box<dyn FnOnce() + Send>;
fn spawn_owner(task: OwnerTask) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("microphone-owner".into())
        .spawn(task)
}
fn spawn_system_owner(task: OwnerTask) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("system-audio-owner".into())
        .spawn(task)
}

async fn prepare_native_with_readiness(
    device_id: u32,
    cancelled: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
    require_readiness: bool,
) -> anyhow::Result<ManagedProducer> {
    prepare_producer_with(
        move || {
            // Enumeration and open share the limited owner's five-second budget.
            let id = format!("microphone:coreaudio:{device_id}");
            let exact = crate::audio::list_native_microphones()
                .iter()
                .filter(|device| device.id == id)
                .count()
                == 1;
            #[cfg(debug_assertions)]
            let exact = exact
                || device_id == crate::audio::CAPTION_CONTRACT_TEST_DEVICE_ID
                || (device_id == crate::audio::CAPTION_CONTRACT_TEST_DEVICE_ID - 1
                    && std::env::var("VIDEORC_LIVE_SOURCE_SWITCH_TEST").as_deref() == Ok("1"));
            if !exact {
                anyhow::bail!("The selected microphone is missing or its identity is ambiguous.");
            }
            crate::audio::start_native_audio_source(device_id, AudioProcessingSettings::default())
                .map(ProducerSource::native)
        },
        cancelled,
        count,
        spawn_owner,
        |_| {},
        require_readiness,
    )
    .await
}

/// How long opening a microphone may take before the session gives up on
/// it. On Windows this includes the capture worker's protocol and DirectShow
/// inventory probes (cached after the first run); a busy laptop needed more
/// than the old 5 s and lost its microphone (plan 065, A2). Elsewhere opening
/// is a single in-process call.
const MICROPHONE_OPEN_BUDGET: Duration = if cfg!(target_os = "windows") {
    Duration::from_secs(15)
} else {
    Duration::from_secs(5)
};
/// How long opening a system-audio capture may take (PR #477 review). The
/// macOS start (`SystemAudioCapture::start`) may take up to its 12 s start
/// budget, and a start that gives up then spends up to its 3 s stop budget
/// closing what it opened, all inside `open`. The owner must be given both,
/// or a slow first start reads as unavailable while its capture still holds
/// the one system pool slot, and the retry then fails as `ProducerPoolBusy`.
const SYSTEM_AUDIO_OPEN_BUDGET: Duration = Duration::from_secs(15);

impl SourceRole {
    const fn open_budget(self) -> Duration {
        match self {
            Self::Microphone => MICROPHONE_OPEN_BUDGET,
            Self::System => SYSTEM_AUDIO_OPEN_BUDGET,
        }
    }
}

#[derive(Debug)]
struct PreparationCleanupPending(String);
impl std::fmt::Display for PreparationCleanupPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} Capture cleanup remains quarantined; retry after it closes.",
            self.0
        )
    }
}
impl std::error::Error for PreparationCleanupPending {}

async fn prepare_producer_with(
    open: impl FnOnce() -> anyhow::Result<ProducerSource> + Send + 'static,
    operation_cancelled: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
    spawn: impl FnOnce(OwnerTask) -> io::Result<thread::JoinHandle<()>>,
    phase: impl Fn(OwnerPhase) + Send + 'static,
    require_readiness: bool,
) -> anyhow::Result<ManagedProducer> {
    prepare_producer_in(
        SourceRole::Microphone,
        open,
        operation_cancelled,
        count,
        spawn,
        phase,
        require_readiness,
    )
    .await
}

async fn prepare_producer_in(
    role: SourceRole,
    open: impl FnOnce() -> anyhow::Result<ProducerSource> + Send + 'static,
    operation_cancelled: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
    spawn: impl FnOnce(OwnerTask) -> io::Result<thread::JoinHandle<()>>,
    phase: impl Fn(OwnerPhase) + Send + 'static,
    require_readiness: bool,
) -> anyhow::Result<ManagedProducer> {
    let permit = ProducerPermit::acquire_role(role, count)?;
    let mut cancellation = OpenCancellation(Some(Arc::new(AtomicBool::new(false))));
    let worker_cancelled = cancellation.0.as_ref().expect("armed cancellation").clone();
    let (opened_tx, opened_rx) = tokio::sync::oneshot::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (completion_guard, completion) = completion_channel();
    let mut closed = completion.state.clone();
    spawn(Box::new(move || {
        let _completion = completion_guard;
        let _permit = permit;
        let cancelled = || {
            worker_cancelled.load(Ordering::Acquire) || operation_cancelled.load(Ordering::Acquire)
        };
        if cancelled() {
            return;
        }
        let source = match open() {
            Ok(source) => source,
            Err(error) => {
                let _ = opened_tx.send(Err(error));
                return;
            }
        };
        phase(OwnerPhase::BeforeOpened);
        if cancelled() || opened_tx.send(Ok(())).is_err() {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if !require_readiness {
                break;
            }
            if cancelled() {
                return;
            }
            if Instant::now() >= deadline {
                let _ = ready_tx.send(Err(anyhow::anyhow!(
                    source.failure_reason("The microphone did not deliver fresh PCM within 2s.")
                )));
                return;
            }
            match source.receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(frame) if valid_fresh_frame(&frame, Instant::now()) => break,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = ready_tx.send(Err(anyhow::anyhow!(
                        source.failure_reason("The microphone stopped before readiness.")
                    )));
                    return;
                }
            }
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let (producer, owner) = source.into_managed(stop_tx, completion);
        phase(OwnerPhase::BeforeReady);
        if cancelled() || ready_tx.send(Ok(producer)).is_err() {
            return;
        }
        let _ = stop_rx.recv();
        drop(owner);
    }))?;
    let result: anyhow::Result<ManagedProducer> = async {
        tokio::time::timeout(role.open_budget(), opened_rx)
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "{} opening exceeded {}s; its owner is still responsible for cleanup.",
                    role.label(),
                    role.open_budget().as_secs()
                )
            })???;
        let producer = tokio::time::timeout(Duration::from_secs(2), ready_rx)
            .await
            .map_err(|_| anyhow::anyhow!("Microphone readiness exceeded 2s."))???;
        Ok(producer)
    }
    .await;
    let producer = match result {
        Ok(producer) => producer,
        Err(error) => {
            cancellation
                .0
                .as_ref()
                .expect("armed cancellation")
                .store(true, Ordering::Release);
            // A failed readiness response precedes driver Drop. Do not let a
            // sequential restore race that still-owned capture lease.
            let cleanup = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let state = *closed.borrow();
                    match state {
                        ProducerCompletion::Closed => return true,
                        ProducerCompletion::Panicked => return false,
                        ProducerCompletion::Running => {}
                    }
                    if closed.changed().await.is_err() {
                        return false;
                    }
                }
            })
            .await;
            return if cleanup == Ok(true) {
                Err(error)
            } else {
                Err(PreparationCleanupPending(error.to_string()).into())
            };
        }
    };
    cancellation.disarm();
    Ok(producer)
}

struct ProducerLifetime {
    owner: Option<Box<dyn Send>>,
    permit: Option<ProducerPermit>,
    completion: Option<CompletionGuard>,
}
impl Drop for ProducerLifetime {
    fn drop(&mut self) {
        // Driver teardown precedes capacity release and completion, including
        // failure to spawn the dedicated owner thread.
        drop(self.owner.take());
        drop(self.permit.take());
        drop(self.completion.take());
    }
}
fn own_initial_source(
    source: NativeAudioSource,
    count: Arc<AtomicU64>,
) -> anyhow::Result<ManagedProducer> {
    let permit = ProducerPermit::acquire(count)?;
    adopt_initial_source(source, permit)
}
fn adopt_initial_source(
    source: NativeAudioSource,
    permit: ProducerPermit,
) -> anyhow::Result<ManagedProducer> {
    let (stop_tx, stop_rx) = mpsc::channel();
    let (completion_guard, completion) = completion_channel();
    let (producer, owner) = ProducerSource::native(source).into_managed(stop_tx, completion);
    let lifetime = ProducerLifetime {
        owner: Some(owner),
        permit: Some(permit),
        completion: Some(completion_guard),
    };
    spawn_owner(Box::new(move || {
        let _ = stop_rx.recv();
        drop(lifetime);
    }))?;
    Ok(producer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCommitReceipt {
    pub session_id: String,
    pub request_id: String,
    pub generation: u64,
    pub cutover_sample: u64,
    pub device_id: Option<String>,
    pub output_observed: bool,
}

/// Why a mixed input left the session. A source whose buffers kept arriving
/// but could not be placed on the timeline did not stop; saying it did sends
/// the user to check a working device (plan 070).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLossReason {
    /// EOF, a callback stall, or a platform-reported capture failure.
    CaptureStopped,
    /// Buffers arrived, but none could be placed for the loss deadline.
    TimelineRejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLoss {
    pub reason: SourceLossReason,
    pub generation: u64,
    pub device_name: String,
    pub after_ms: u64,
}

/// A timeline loss that ended (plan 076): the source, which never stopped
/// delivering, placed audio again. A placement loss never retires a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRecovery {
    pub generation: u64,
    pub device_name: String,
    /// Recording-window time of the recovery.
    pub after_ms: u64,
    /// From the source's last placed audio before the loss to its first after.
    pub gap_ms: u64,
}

/// The output fell behind the wall clock and captured audio was replaced with
/// silence (plan 076): the FIFO reader stopped draining, the sources did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputStallReport {
    pub duration_ms: u64,
    pub max_lag_ms: u64,
    /// Captured audio (microphone and system) replaced with silence.
    pub lost_ms: u64,
}

#[derive(Debug)]
pub struct AudioObservation {
    pub generation: u64,
    pub device_name: String,
    pub selected_input: bool,
    pub captured_frames: u64,
    pub dropped_frames: u64,
    pub live_peak: f32,
    pub session_peak: f32,
    pub elapsed_secs: Option<f64>,
    pub input_state: NativeAudioInputState,
    pub source_loss_after_ms: Option<u64>,
    pub losses: Vec<SourceLoss>,
    pub recoveries: Vec<SourceRecovery>,
    pub output_stalls: Vec<OutputStallReport>,
}

/// Test-only view of every frame the bus offers the caption tap.
#[cfg(test)]
type CaptionObserver = Arc<dyn Fn(&AudioFrame) + Send + Sync>;

struct AudioShared {
    owner_present: bool,
    retiring: Vec<(String, tokio::sync::watch::Receiver<ProducerCompletion>)>,
    status: AudioBusStatus,
    stats: Arc<AudioCaptureStats>,
    totals: Arc<AudioCaptureStats>,
    ever_selected: bool,
    last_selected_name: String,
    losses: VecDeque<SourceLoss>,
    recoveries: VecDeque<SourceRecovery>,
    output_stalls: VecDeque<OutputStallReport>,
    system: SystemShared,
    system_stats: Arc<AudioCaptureStats>,
    mix_clipped_samples: u64,
    #[cfg(test)]
    caption_observer: Option<CaptionObserver>,
    #[cfg(test)]
    after_ramp: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    #[cfg(test)]
    cancellation_input: Option<(u64, fn(&mut AudioTimeline))>,
    #[cfg(debug_assertions)]
    caption_injector: Option<crate::audio::CaptionContractTestAudioInjector>,
}

#[derive(Clone)]
pub struct AudioSwitchHandle {
    commands: mpsc::SyncSender<AudioSwitchCommand>,
    shared: Arc<std::sync::Mutex<AudioShared>>,
    producer_count: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    /// When `request_stop` was first called; the bus drains up to it.
    stop_requested_at: Arc<OnceLock<Instant>>,
    /// How long a microphone handoff may take from admission to commit on
    /// this bus ([`handoff_budget`]).
    handoff_budget: Duration,
    /// Set once by [`SessionAudio::request_silent_drain`]; irreversible.
    draining: Arc<AtomicBool>,
}

/// A microphone hot-swap's budget from admission to commit with no bus delay.
const HANDOFF_BASE_BUDGET: Duration = Duration::from_secs(1);

/// How long a microphone handoff may take from admission to commit (PR #477
/// review). A positive microphone offset is a bus delay D (plan 069 decision
/// 8): the candidate's first sample lands D after it was captured, and the
/// cursor reaches it one playout delay after that. So a candidate can cover
/// the cutover only after admission + D + playout. Every deadline on the
/// handoff (the bus's own and the caller's receipt wait) extends by both, or
/// an offset near +850 ms would cancel every hot-swap.
fn handoff_budget(microphone_delay_frames: u64, playout_delay: Duration) -> Duration {
    HANDOFF_BASE_BUDGET
        + Duration::from_nanos(
            microphone_delay_frames.saturating_mul(1_000_000_000)
                / u64::from(NATIVE_AUDIO_SAMPLE_RATE),
        )
        + playout_delay
}

enum HandoffPurpose {
    Commit,
    Release {
        closed: tokio::sync::oneshot::Sender<Vec<tokio::sync::watch::Receiver<ProducerCompletion>>>,
    },
    Restore {
        failure: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplacementDisposition {
    Concurrent,
    KnownSelfOwnedExclusive,
}

fn replacement_disposition(shared: &AudioShared, target: Option<&str>) -> ReplacementDisposition {
    if target.is_some()
        && ((shared.owner_present
            && shared.status.device_id.as_deref() == target
            && shared.stats.input_state() != NativeAudioInputState::Live)
            || shared.retiring.iter().any(|(id, completion)| {
                Some(id.as_str()) == target && *completion.borrow() != ProducerCompletion::Closed
            }))
    {
        ReplacementDisposition::KnownSelfOwnedExclusive
    } else {
        ReplacementDisposition::Concurrent
    }
}

struct AudioSwitchCommand {
    purpose: HandoffPurpose,
    request: crate::live_source_switch::SourceSwitchParams,
    coordinator: Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
    cancelled: Arc<AtomicBool>,
    candidate: Option<ManagedProducer>,
    admitted_at: Instant,
    acknowledgement: tokio::sync::oneshot::Sender<anyhow::Result<AudioCommitReceipt>>,
}

pub struct InitialAudioSource {
    source: InitialInput,
}
impl std::fmt::Debug for InitialAudioSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InitialAudioSource")
            .field("device_id", &self.device_id())
            .field("device_name", &self.device_name())
            .finish_non_exhaustive()
    }
}
enum InitialInput {
    /// A bare CoreAudio source adopted at attach. Only tests build one since
    /// S4 moved every session onto `attach_prepared_with`; production hands
    /// over `Owned` producers (including the warm standby).
    #[cfg_attr(not(test), allow(dead_code))]
    Warm(NativeAudioSource),
    Owned {
        producer: ManagedProducer,
        count: Arc<AtomicU64>,
    },
}
impl InitialAudioSource {
    #[cfg(test)]
    pub fn warm(source: NativeAudioSource) -> Self {
        Self {
            source: InitialInput::Warm(source),
        }
    }
    pub fn owned_producer_count(&self) -> u64 {
        match &self.source {
            InitialInput::Owned { .. } => 1,
            InitialInput::Warm(_) => 0,
        }
    }
    pub fn stats_handle(&self) -> Arc<AudioCaptureStats> {
        match &self.source {
            InitialInput::Warm(source) => source.stats_handle(),
            InitialInput::Owned { producer, .. } => producer.stats.clone(),
        }
    }
    pub fn device_name(&self) -> String {
        match &self.source {
            InitialInput::Warm(source) => source.device_name.clone(),
            InitialInput::Owned { producer, .. } => producer.device_name.clone(),
        }
    }
    fn device_id(&self) -> String {
        match &self.source {
            InitialInput::Warm(source) => format!("microphone:coreaudio:{}", source.device_id),
            InitialInput::Owned { producer, .. } => producer.device_id.clone(),
        }
    }
    #[cfg(debug_assertions)]
    fn caption_injector(&self) -> Option<crate::audio::CaptionContractTestAudioInjector> {
        match &self.source {
            InitialInput::Warm(source) => source.caption_contract_test_injector.clone(),
            InitialInput::Owned { producer, .. } => producer.caption_injector.clone(),
        }
    }
    fn count(&self) -> Arc<AtomicU64> {
        match &self.source {
            InitialInput::Warm(_) => Arc::new(AtomicU64::new(0)),
            InitialInput::Owned { count, .. } => count.clone(),
        }
    }
    fn into_owned(self, count: Arc<AtomicU64>) -> anyhow::Result<ManagedProducer> {
        match self.source {
            InitialInput::Warm(source) => own_initial_source(source, count),
            InitialInput::Owned { producer, .. } => Ok(producer),
        }
    }
}

pub async fn prepare_initial_native(device_id: u32) -> anyhow::Result<InitialAudioSource> {
    let count = Arc::new(AtomicU64::new(0));
    let producer = prepare_native_with_readiness(
        device_id,
        Arc::new(AtomicBool::new(false)),
        count.clone(),
        false,
    )
    .await?;
    Ok(InitialAudioSource {
        source: InitialInput::Owned { producer, count },
    })
}

async fn prepare_adapter(
    device_id: String,
    ffmpeg_path: String,
    cancelled: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
) -> anyhow::Result<ManagedProducer> {
    prepare_producer_with(
        move || {
            crate::audio_capture_adapter::open(&ffmpeg_path, &device_id)
                .map(|source| ProducerSource::worker(device_id, source))
        },
        cancelled,
        count,
        spawn_owner,
        |_| {},
        true,
    )
    .await
}

#[cfg(any(all(target_os = "windows", debug_assertions), test))]
fn incident_worker_open_failure_enabled(
    debug_build: bool,
    smoke_rpc: Option<&str>,
    injection: Option<&str>,
) -> bool {
    debug_build && smoke_rpc == Some("1") && injection == Some("1")
}

pub async fn prepare_initial_adapter(
    device_id: String,
    ffmpeg_path: String,
) -> anyhow::Result<InitialAudioSource> {
    // Incident reproduction only: a shipping release cannot enable this hook.
    // Returning through the real acquisition boundary preserves the production
    // DirectShow fallback and its diagnostics instead of simulating success.
    #[cfg(all(target_os = "windows", debug_assertions))]
    if incident_worker_open_failure_enabled(
        cfg!(debug_assertions),
        std::env::var("VIDEORC_ENABLE_SMOKE_RPC").as_deref().ok(),
        std::env::var("VIDEORC_INCIDENT_WORKER_OPEN_FAILURE")
            .as_deref()
            .ok(),
    ) {
        anyhow::bail!("Injected incident capture-worker open failure (diagnostic-only)");
    }
    let count = Arc::new(AtomicU64::new(0));
    let producer = prepare_adapter(
        device_id,
        ffmpeg_path,
        Arc::new(AtomicBool::new(false)),
        count.clone(),
    )
    .await?;
    Ok(InitialAudioSource {
        source: InitialInput::Owned { producer, count },
    })
}

pub struct SessionAudio {
    pub fifo_path: PathBuf,
    handle: AudioSwitchHandle,
    system: SystemAudioHandle,
    processing_settings: AudioProcessingSettingsHandle,
    writer: Option<thread::JoinHandle<()>>,
    finished: mpsc::Receiver<()>,
}

impl std::fmt::Debug for SessionAudio {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionAudio")
            .field("status", &self.status())
            .field("fifo_path", &self.fifo_path)
            .finish_non_exhaustive()
    }
}

impl SessionAudio {
    fn totals(&self) -> Arc<AudioCaptureStats> {
        self.handle
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .totals
            .clone()
    }
    /// Identity and generation are captured under one lock. Atomic PCM counters
    /// may progress, but observations can never combine two source generations.
    pub fn caption_start_eligible(&self) -> bool {
        let shared = self.handle.shared.lock().unwrap_or_else(|p| p.into_inner());
        shared.status.selected_input
            && matches!(
                shared.stats.input_state(),
                NativeAudioInputState::Starting | NativeAudioInputState::Live
            )
    }
    pub fn observation(&self, finalizing: bool) -> AudioObservation {
        let mut shared = self.handle.shared.lock().unwrap_or_else(|p| p.into_inner());
        if finalizing {
            shared.stats.finish_recording_window();
            shared.totals.finish_recording_window();
        }
        let stats = if finalizing {
            &shared.totals
        } else {
            &shared.stats
        };
        AudioObservation {
            generation: shared.status.generation,
            device_name: if finalizing {
                shared.last_selected_name.clone()
            } else {
                shared.status.device_name.clone()
            },
            selected_input: if finalizing {
                shared.ever_selected
            } else {
                shared.status.selected_input
            },
            captured_frames: stats.captured_frames(),
            dropped_frames: stats.dropped_frames(),
            live_peak: stats.live_peak(),
            session_peak: stats.session_peak(),
            elapsed_secs: stats.recording_window_elapsed_secs(),
            input_state: shared.stats.input_state(),
            source_loss_after_ms: shared.stats.source_loss_after_ms(),
            losses: shared.losses.drain(..).collect(),
            recoveries: shared.recoveries.drain(..).collect(),
            output_stalls: shared.output_stalls.drain(..).collect(),
        }
    }
    pub fn switch_handle(&self) -> AudioSwitchHandle {
        self.handle.clone()
    }
    /// Plan 069: the session's system-audio slot (prepare, attach, detach,
    /// gain, observation, loss events).
    pub fn system_audio(&self) -> SystemAudioHandle {
        self.system.clone()
    }
    #[cfg(test)]
    pub async fn attach_system(&self, producer: SystemAudioProducer) -> anyhow::Result<u64> {
        self.system.attach(producer).await
    }
    #[cfg(test)]
    pub async fn detach_system(&self) -> anyhow::Result<Option<u64>> {
        self.system.detach().await
    }
    fn stats(&self) -> Arc<AudioCaptureStats> {
        self.handle
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stats
            .clone()
    }
    pub fn status(&self) -> AudioBusStatus {
        self.handle.status()
    }
    #[cfg(test)]
    pub fn has_selected_input(&self) -> bool {
        self.status().selected_input
    }
    #[cfg(test)]
    pub fn captured_frames(&self) -> u64 {
        self.stats().captured_frames()
    }
    pub fn input_state(&self) -> NativeAudioInputState {
        self.stats().input_state()
    }
    #[cfg(test)]
    pub fn source_loss_after_ms(&self) -> Option<u64> {
        self.stats().source_loss_after_ms()
    }
    /// The microphone producer is still owned: never retired (plan 076).
    #[cfg(test)]
    pub fn microphone_owner_present(&self) -> bool {
        self.handle
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .owner_present
    }
    #[cfg(test)]
    pub fn claim_source_loss_event(&self) -> Option<SourceLoss> {
        self.handle
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .losses
            .pop_front()
    }
    /// End capture immediately while preserving the timed PCM pipe until the
    /// video owner closes FFmpeg. This transition is irreversible for a session.
    pub fn request_silent_drain(&self) -> bool {
        self.handle.request_silent_drain()
    }

    pub fn request_stop(&self) {
        // The instant first, so a bus that sees the flag drains to it.
        let _ = self.handle.stop_requested_at.set(Instant::now());
        self.handle.stop.store(true, Ordering::Release);
        let stats = self.stats();
        stats.mark_stopped();
        stats.finish_recording_window();
        self.totals().finish_recording_window();
    }
    pub fn update_processing_settings(&self, settings: AudioProcessingSettings) {
        self.processing_settings.update(settings);
    }
    #[cfg(debug_assertions)]
    pub fn caption_contract_test_injector(
        &self,
    ) -> Option<crate::audio::CaptionContractTestAudioInjector> {
        self.handle
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .caption_injector
            .clone()
    }
}

impl AudioSwitchHandle {
    fn request_silent_drain(&self) -> bool {
        // Share the source-commit linearization point: a racing handoff either
        // completes before this freeze or observes draining and cannot commit.
        let shared = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        if self.stop.load(Ordering::Acquire) || self.draining.swap(true, Ordering::AcqRel) {
            return false;
        }
        shared.stats.mark_stopped();
        shared.stats.finish_recording_window();
        shared.totals.finish_recording_window();
        true
    }

    pub async fn replace(
        &self,
        request: crate::live_source_switch::SourceSwitchParams,
        ffmpeg_path: String,
        coordinator: Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        cancelled: Arc<AtomicBool>,
    ) -> anyhow::Result<AudioCommitReceipt> {
        let count = self.producer_count.clone();
        let opening_cancelled = cancelled.clone();
        self.replace_with(request, coordinator, cancelled, move |id: String| {
            let count = count.clone();
            let cancelled = opening_cancelled.clone();
            let ffmpeg_path = ffmpeg_path.clone();
            async move {
                if let Some(device_id) = crate::audio::parse_coreaudio_microphone_id(&id) {
                    if id != format!("microphone:coreaudio:{device_id}") {
                        anyhow::bail!("The microphone ID is not canonical.");
                    }
                    prepare_native_with_readiness(device_id, cancelled, count, true).await
                } else {
                    prepare_adapter(id, ffmpeg_path, cancelled, count).await
                }
            }
        })
        .await
    }

    async fn replace_with<F, Fut>(
        &self,
        request: crate::live_source_switch::SourceSwitchParams,
        coordinator: Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        cancelled: Arc<AtomicBool>,
        mut open: F,
    ) -> anyhow::Result<AudioCommitReceipt>
    where
        F: FnMut(String) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<ManagedProducer>>,
    {
        let _cancel_on_drop = OpenCancellation(Some(cancelled.clone()));
        let (disposition, previous_id) = {
            let shared = self.shared.lock().unwrap_or_else(|p| p.into_inner());
            if shared.losses.len() >= 32 {
                anyhow::bail!(
                    "Microphone loss events are awaiting delivery; retry after status refresh."
                );
            }
            (
                replacement_disposition(&shared, request.device_id.as_deref()),
                shared.status.device_id.clone(),
            )
        };
        self.ensure_switch_current(&request, &coordinator, &cancelled)?;
        if disposition == ReplacementDisposition::KnownSelfOwnedExclusive {
            // This classification is ownership evidence, not an interpretation
            // of an arbitrary permission/busy error from a different device.
            let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
            self.cutover(
                &request,
                &coordinator,
                &cancelled,
                None,
                HandoffPurpose::Release { closed: closed_tx },
            )
            .await?;
            let receipts = tokio::time::timeout(self.handoff_budget, closed_rx)
                .await
                .map_err(|_| {
                    anyhow::anyhow!("Previous microphone release was not acknowledged.")
                })??;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            for mut receipt in receipts {
                loop {
                    self.ensure_switch_current(&request, &coordinator, &cancelled)?;
                    match *receipt.borrow() {
                        ProducerCompletion::Closed => break,
                        ProducerCompletion::Panicked => anyhow::bail!(
                            "Previous microphone owner failed during cleanup; capture remains unavailable."
                        ),
                        ProducerCompletion::Running => {}
                    }
                    tokio::select! {
                        changed = receipt.changed() => { changed.map_err(|_| anyhow::anyhow!("Previous microphone cleanup receipt closed unexpectedly."))?; },
                        _ = tokio::time::sleep_until(deadline) => anyhow::bail!("Previous microphone did not close within 5s; its owner remains quarantined."),
                        _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                    }
                }
            }
        }
        let prepared = match request.device_id.clone() {
            None => Ok(None),
            Some(id) => open(id).await.map(Some),
        };
        self.ensure_switch_current(&request, &coordinator, &cancelled)?;
        let result = match prepared {
            Ok(candidate) => {
                self.cutover(
                    &request,
                    &coordinator,
                    &cancelled,
                    candidate,
                    HandoffPurpose::Commit,
                )
                .await
            }
            Err(error) => Err(error),
        };
        if result.is_ok() || disposition == ReplacementDisposition::Concurrent {
            return result;
        }
        // The bus receipt wins a response timeout; never restore over an
        // already committed target or a superseding Stop/layout intent.
        self.ensure_switch_current(&request, &coordinator, &cancelled)?;
        let failure = result.unwrap_err();
        if failure.is::<PreparationCleanupPending>() {
            return Err(failure);
        }
        let target_failure = failure.to_string();
        coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_stage(&request, crate::live_source_switch::SwitchStage::Restoring)
            .map_err(|error| anyhow::anyhow!(error.message()))?;
        let previous = previous_id
            .ok_or_else(|| anyhow::anyhow!("Previous microphone identity is unavailable."))?;
        let restored = open(previous).await;
        self.ensure_switch_current(&request, &coordinator, &cancelled)?;
        match restored {
            Ok(candidate) => {
                self.cutover(
                    &request,
                    &coordinator,
                    &cancelled,
                    Some(candidate),
                    HandoffPurpose::Restore {
                        failure: target_failure.clone(),
                    },
                )
                .await?;
                Err(anyhow::anyhow!(
                    "{target_failure} The previous microphone was restored."
                ))
            }
            Err(error) => Err(anyhow::anyhow!(
                "{target_failure} Restoring the previous microphone also failed: {error}"
            )),
        }
    }

    fn ensure_switch_current(
        &self,
        request: &crate::live_source_switch::SourceSwitchParams,
        coordinator: &Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        if self.stop.load(Ordering::Acquire)
            || self.draining.load(Ordering::Acquire)
            || cancelled.load(Ordering::Acquire)
        {
            anyhow::bail!("Source change cancelled");
        }
        coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .validate_commit(request)
            .map_err(|error| anyhow::anyhow!(error.message()))
    }

    async fn cutover(
        &self,
        request: &crate::live_source_switch::SourceSwitchParams,
        coordinator: &Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        cancelled: &Arc<AtomicBool>,
        candidate: Option<ManagedProducer>,
        purpose: HandoffPurpose,
    ) -> anyhow::Result<AudioCommitReceipt> {
        self.ensure_switch_current(request, coordinator, cancelled)?;
        let release = matches!(&purpose, HandoffPurpose::Release { .. });
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        self.commands
            .try_send(AudioSwitchCommand {
                request: request.clone(),
                coordinator: coordinator.clone(),
                cancelled: cancelled.clone(),
                candidate,
                purpose,
                admitted_at: Instant::now(),
                acknowledgement,
            })
            .map_err(|_| {
                anyhow::anyhow!(
                    "The session audio writer is unavailable or already changing sources."
                )
            })?;
        let result = tokio::time::timeout(self.handoff_budget, receipt).await;
        if !release
            && let Some(receipt) = self.status().last_commit
            && receipt.session_id == request.session_id
            && receipt.request_id == request.request_id
        {
            return Ok(receipt);
        }
        result
            .map_err(|_| anyhow::anyhow!("Microphone cutover acknowledgement timed out."))?
            .map_err(|_| anyhow::anyhow!("Session audio stopped before acknowledging cutover."))?
    }
    pub fn status(&self) -> AudioBusStatus {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .status
            .clone()
    }
    pub fn input_state(&self) -> NativeAudioInputState {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stats
            .input_state()
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

#[cfg(test)]
pub fn attach(
    source: Option<NativeAudioSource>,
    fifo_path: PathBuf,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    settings: AudioProcessingSettings,
    source_stall_timeout: Duration,
) -> SessionAudio {
    attach_prepared(
        source.map(InitialAudioSource::warm),
        fifo_path,
        video_epoch,
        settings,
        source_stall_timeout,
    )
}

#[cfg(test)]
pub fn attach_prepared(
    source: Option<InitialAudioSource>,
    fifo_path: PathBuf,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    settings: AudioProcessingSettings,
    source_stall_timeout: Duration,
) -> SessionAudio {
    attach_prepared_with(
        source,
        fifo_path,
        video_epoch,
        settings,
        source_stall_timeout,
        SessionAudioOptions::default(),
    )
}

/// [`attach_prepared`] with explicit bus timing (plan 069 decisions 8 and
/// 13). The defaults reproduce the pre-mixer bus exactly.
pub fn attach_prepared_with(
    source: Option<InitialAudioSource>,
    fifo_path: PathBuf,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    settings: AudioProcessingSettings,
    source_stall_timeout: Duration,
    options: SessionAudioOptions,
) -> SessionAudio {
    let stats = Arc::new(AudioCaptureStats::default());
    let shared = Arc::new(std::sync::Mutex::new(AudioShared {
        owner_present: source.is_some(),
        retiring: Vec::new(),
        status: AudioBusStatus {
            selected_input: source.is_some(),
            device_id: source.as_ref().map(InitialAudioSource::device_id),
            device_name: source
                .as_ref()
                .map_or_else(|| "No microphone".into(), |source| source.device_name()),
            ..Default::default()
        },
        stats: stats.clone(),
        totals: Arc::new(AudioCaptureStats::default()),
        ever_selected: source.is_some(),
        last_selected_name: source
            .as_ref()
            .map_or_else(|| "No microphone".into(), |source| source.device_name()),
        losses: VecDeque::new(),
        recoveries: VecDeque::new(),
        output_stalls: VecDeque::new(),
        system: SystemShared::default(),
        system_stats: Arc::new(AudioCaptureStats::default()),
        mix_clipped_samples: 0,
        #[cfg(test)]
        caption_observer: None,
        #[cfg(test)]
        after_ramp: None,
        #[cfg(test)]
        cancellation_input: None,
        #[cfg(debug_assertions)]
        caption_injector: source.as_ref().and_then(|source| source.caption_injector()),
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let draining = Arc::new(AtomicBool::new(false));
    let processing_settings = AudioProcessingSettingsHandle::new(settings);
    let (finished_tx, finished) = mpsc::sync_channel(1);
    let (commands, command_rx) = mpsc::sync_channel(1);
    let producer_count = source
        .as_ref()
        .map_or_else(|| Arc::new(AtomicU64::new(0)), InitialAudioSource::count);
    let stop_requested_at = Arc::new(OnceLock::new());
    let handle = AudioSwitchHandle {
        commands,
        shared: shared.clone(),
        producer_count: producer_count.clone(),
        stop: stop.clone(),
        stop_requested_at: stop_requested_at.clone(),
        handoff_budget: handoff_budget(options.microphone_delay_frames, options.playout_delay),
        draining: draining.clone(),
    };
    let system_settings = AudioProcessingSettingsHandle::new(AudioProcessingSettings {
        gain_db: crate::protocol::clamp_system_audio_gain_db(options.system_gain_db),
        muted: false,
    });
    let (system_commands, system_command_rx) = mpsc::sync_channel(2);
    let system_count = Arc::new(AtomicU64::new(0));
    let echo_guard = Arc::new(AtomicBool::new(options.echo_guard));
    let system = SystemAudioHandle {
        commands: system_commands,
        shared: shared.clone(),
        settings: system_settings.clone(),
        count: system_count.clone(),
        stop: stop.clone(),
        draining: draining.clone(),
        echo_guard: echo_guard.clone(),
    };
    let timing = BusTiming {
        playout_delay: options.playout_delay,
        microphone_delay_frames: options.microphone_delay_frames,
        system_delay_frames: options.system_delay_frames,
    };
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
        // Even a failed owner spawn is cleaned up on this bounded writer owner,
        // never on the dispatcher/recording mutex thread.
        let result = source
            .map(|source| source.into_owned(producer_count.clone()))
            .transpose()
            .map_err(|error| io::Error::other(error.to_string()))
            .and_then(|producer| {
                run_bus(
                    producer,
                    &path,
                    video_epoch,
                    command_rx,
                    system_command_rx,
                    BusContext {
                        settings: &writer_settings,
                        system_settings: &system_settings,
                        stop: &stop,
                        stop_requested_at: &stop_requested_at,
                        draining: &draining,
                        source_stall_timeout,
                        timing,
                        shared: &shared,
                        echo_guard: &echo_guard,
                    },
                )
            });
        if let Err(error) = result {
            let stats = shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .stats
                .clone();
            if stop.load(Ordering::Acquire) {
                stats.mark_stopped();
            } else {
                stats.mark_downstream_closed();
            }
            tracing::warn!("Session audio transport ended: {error}");
        }
        let cleanup_deadline = Instant::now() + WRITE_DEADLINE;
        if !wait_for_producer_cleanup(&producer_count, cleanup_deadline) {
            tracing::warn!(
                "Microphone owner remains quarantined after 5s; next session admission is fenced until actual close."
            );
        }
        if !wait_for_producer_cleanup(&system_count, cleanup_deadline) {
            tracing::warn!(
                "System audio owner remains quarantined after 5s; the next system audio attach is fenced until actual close."
            );
        }
        let _ = finished_tx.send(());
    });
    SessionAudio {
        fifo_path,
        handle,
        system,
        processing_settings,
        writer: Some(writer),
        finished,
    }
}

fn valid_fresh_frame(frame: &AudioFrame, now: Instant) -> bool {
    valid_frame_shape(frame)
        && frame.captured_at <= now
        && now.duration_since(frame.captured_at) <= MAX_FRAME_AGE
}

fn valid_frame_shape(frame: &AudioFrame) -> bool {
    frame.sample_rate == NATIVE_AUDIO_SAMPLE_RATE
        && frame.channels == NATIVE_AUDIO_CHANNELS
        && !frame.samples.is_empty()
        && frame.samples.len().is_multiple_of(2)
        && frame.samples.iter().all(|sample| sample.is_finite())
}

/// System-audio freshness is judged by arrival, not by the PTS-derived
/// `captured_at` (PR #477 review). The PTS comes from the output device's
/// clock; a clock that runs fast puts `captured_at` in the future, which the
/// microphone rule reads as stale, and every buffer would then be dropped in
/// silence. A buffer that just arrived is fresh; its PTS still places it. Only
/// a PTS further than [`MAX_FRAME_AGE`] from its arrival, either way, cannot
/// be placed and is stale.
fn valid_system_frame(frame: &AudioFrame, arrived_at: Instant) -> bool {
    let skew = if frame.captured_at >= arrived_at {
        frame.captured_at.duration_since(arrived_at)
    } else {
        arrived_at.duration_since(frame.captured_at)
    };
    valid_frame_shape(frame) && skew <= MAX_FRAME_AGE
}

/// A system source whose buffers keep arriving but none of which can be
/// placed in the mix (stale by arrival, before the epoch, behind the cursor,
/// beyond the ahead cap, duplicate timestamps) for this long is lost, not
/// silent: it fills the loss path (`system-audio-lost`) instead of dropping
/// out unseen. A startup burst trims for well under a second.
const SYSTEM_UNPLAYABLE_LOSS_AFTER: Duration = Duration::from_secs(2);

fn microphone_loss_reason(
    disconnected: bool,
    since_arrival: Duration,
    since_placement: Duration,
    timeout: Duration,
) -> Option<SourceLossReason> {
    if disconnected || since_arrival >= timeout {
        Some(SourceLossReason::CaptureStopped)
    } else if since_placement >= timeout {
        Some(SourceLossReason::TimelineRejected)
    } else {
        None
    }
}

/// Where the cursor would be if the output kept pace with the wall clock.
fn wall_cursor_at(now: Instant, epoch: Instant, playout_delay: Duration) -> u64 {
    (now.saturating_duration_since(epoch)
        .saturating_sub(playout_delay)
        .as_nanos()
        * u128::from(NATIVE_AUDIO_SAMPLE_RATE)
        / 1_000_000_000) as u64
}

/// How the bus judges a packet refused ahead of its cursor (plan 076).
#[derive(Debug, Clone, Copy)]
struct Placement {
    epoch: Instant,
    playout_delay: Duration,
    /// The output is in a stall episode ([`OutputStall`]): a packet that is
    /// on time by the wall clock is not its source's fault.
    output_behind: bool,
}
impl Placement {
    fn wall_cursor(&self, now: Instant) -> u64 {
        wall_cursor_at(now, self.epoch, self.playout_delay)
    }
}

/// When a source last delivered a buffer, was live, and placed audio (plan
/// 075). Live includes buffers refused only because the output fell behind:
/// the source kept time, so it is not lost.
#[derive(Debug, Clone, Copy)]
struct SourceActivity {
    arrival: Instant,
    live: Instant,
    placed: Instant,
}
impl SourceActivity {
    fn new(now: Instant) -> Self {
        Self {
            arrival: now,
            live: now,
            placed: now,
        }
    }
}

/// A source can only be re-anchored this often while its buffers keep
/// failing to place (plan 076).
const REANCHOR_INTERVAL: Duration = Duration::from_secs(10);

/// A source whose buffers keep arriving but cannot be placed (plan 076). It
/// is reported once, re-anchored at most every [`REANCHOR_INTERVAL`], never
/// retired, and reported recovered at its next placed buffer. Only a stopped
/// capture (EOF, a stall, a platform failure) retires a source.
#[derive(Debug, Default)]
struct TimelineFault {
    /// When the fault began, and the source's last placement before it.
    since: Option<(Instant, Instant)>,
    last_reanchor: Option<Instant>,
}
impl TimelineFault {
    /// `true` the first time: the loss is reported once per fault.
    fn begin(&mut self, now: Instant, last_placed: Instant) -> bool {
        if self.since.is_some() {
            return false;
        }
        self.since = Some((now, last_placed));
        true
    }

    /// Whether to drop the source clock now, so its next buffer maps from its
    /// capture time against the epoch, as it did at session start.
    fn reanchor_due(&mut self, now: Instant) -> bool {
        if self.since.is_none()
            || self
                .last_reanchor
                .is_some_and(|at| now.saturating_duration_since(at) < REANCHOR_INTERVAL)
        {
            return false;
        }
        self.last_reanchor = Some(now);
        true
    }

    /// The silent gap, once a placement after the fault began ends it.
    fn recovered(&mut self, placed: Instant) -> Option<Duration> {
        let (since, last_placed) = self.since?;
        if placed <= since {
            return None;
        }
        self.since = None;
        Some(placed.saturating_duration_since(last_placed))
    }
}

/// A stall episode starts when the cursor trails the wall clock by this much
/// (250 ms), and ends once it is back within [`OUTPUT_CAUGHT_UP_FRAMES`].
const OUTPUT_STALL_START_FRAMES: u64 = 12_000;
/// 100 ms. A bus paces one 10 ms chunk behind the wall clock, but on a busy
/// machine (exactly when stalls happen) its thread wakes tens of ms late, so
/// a 50 ms line could leave an episode open long after the reader resumed.
const OUTPUT_CAUGHT_UP_FRAMES: u64 = 4_800;
/// An episode excuses its sources this long. An output that stays behind
/// longer is stuck, not stalled, and its sources report the loss.
const OUTPUT_STALL_FORGIVENESS: Duration = Duration::from_secs(15);

/// Output-stall bookkeeping (plan 076). The cursor advances only as the FIFO
/// reader drains; the wall clock does not wait. A bus that has kept pace and
/// then falls behind is in a stall episode: the reader stopped (FFmpeg pauses
/// its audio input while its video input is late), and a buffer that is on
/// time by the wall clock is not its source's fault. A bus that never kept
/// pace has a timeline fault instead (plan 070), which its sources report.
#[derive(Debug, Default)]
struct OutputStall {
    kept_pace: bool,
    episode: Option<StallEpisode>,
}
#[derive(Debug, Clone, Copy)]
struct StallEpisode {
    started: Instant,
    max_lag: u64,
    lost_before: u64,
}
impl OutputStall {
    /// `lag` is how far the cursor trails the wall clock; `lost` is the
    /// running count of captured frames lost to a stalled output.
    fn observe(&mut self, now: Instant, lag: u64, lost: u64) -> Option<OutputStallReport> {
        if lag <= OUTPUT_CAUGHT_UP_FRAMES {
            self.kept_pace = true;
            return self.finish(now, lost);
        }
        match self.episode.as_mut() {
            Some(episode) => episode.max_lag = episode.max_lag.max(lag),
            None if self.kept_pace && lag >= OUTPUT_STALL_START_FRAMES => {
                // The reader stopped about `lag` ago.
                let behind = Duration::from_nanos(lag * 1_000_000_000 / 48_000);
                self.episode = Some(StallEpisode {
                    started: now.checked_sub(behind).unwrap_or(now),
                    max_lag: lag,
                    lost_before: lost,
                });
            }
            None => {}
        }
        None
    }

    fn output_behind(&self, now: Instant) -> bool {
        self.episode.is_some_and(|episode| {
            now.saturating_duration_since(episode.started) < OUTPUT_STALL_FORGIVENESS
        })
    }

    fn finish(&mut self, now: Instant, lost: u64) -> Option<OutputStallReport> {
        let episode = self.episode.take()?;
        Some(OutputStallReport {
            duration_ms: now.saturating_duration_since(episode.started).as_millis() as u64,
            max_lag_ms: episode.max_lag * 1_000 / 48_000,
            lost_ms: lost.saturating_sub(episode.lost_before) * 1_000 / 48_000,
        })
    }
}

/// Captured frames a source lost to a stalled output: refused on time,
/// discarded once the wall clock passed them, or written as stale silence.
fn output_stall_losses(losses: &BusLosses) -> u64 {
    losses.dropped_output_behind + losses.discarded_behind_cap + losses.stale_written
}

/// A stall that silenced less audio than this is logged only: a 10-30 ms
/// stale chunk under ordinary pressure is not news for the streamer.
const OUTPUT_STALL_REPORT_MS: u64 = 250;

/// Logs one stall episode; one that cost audible audio is queued for a
/// health event.
fn publish_output_stall(shared: &std::sync::Mutex<AudioShared>, report: OutputStallReport) {
    if report.lost_ms < OUTPUT_STALL_REPORT_MS {
        tracing::info!(
            duration_ms = report.duration_ms,
            max_lag_ms = report.max_lag_ms,
            lost_ms = report.lost_ms,
            "Session audio output fell behind and caught up without an audible gap."
        );
        return;
    }
    tracing::warn!(
        duration_ms = report.duration_ms,
        max_lag_ms = report.max_lag_ms,
        lost_ms = report.lost_ms,
        "Session audio output stalled (the FIFO reader stopped draining); captured audio in the gap was replaced with silence and every source kept running."
    );
    shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .output_stalls
        .push_back(report);
}

/// Every source's frames lost to a stalled output so far.
fn bus_output_stall_losses(timeline: &AudioTimeline, system: Option<&SourceSlot>) -> u64 {
    output_stall_losses(&timeline.losses())
        + system.map_or(0, |slot| output_stall_losses(&slot.timeline.losses()))
}

/// Queues the microphone's loss event, once per loss (the stats claim it).
fn push_microphone_loss(
    shared: &std::sync::Mutex<AudioShared>,
    stats: &AudioCaptureStats,
    reason: SourceLossReason,
    generation: u64,
) {
    if let Some(after_ms) = stats.claim_source_loss_event() {
        let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
        let device_name = shared.status.device_name.clone();
        // Admission backpressure bounds losses without dropping an
        // unreported generation's event during rapid replacement.
        shared.losses.push_back(SourceLoss {
            reason,
            generation,
            device_name,
            after_ms,
        });
    }
}

/// Acts on one system-slot observation at bus sample `cursor` (plan 076). A
/// stopped capture ramps out; a timeline loss is reported while the slot
/// stays in the mix, and so is its recovery.
fn handle_slot_health(
    slot: &mut SourceSlot,
    health: SlotHealth,
    cursor: u64,
    shared: &std::sync::Mutex<AudioShared>,
) {
    match health {
        SlotHealth::Healthy => {}
        SlotHealth::Stopped(reason) => {
            if slot.exit.is_none() {
                tracing::warn!(
                    "System audio source lost at sample {cursor}; the session continues on the microphone: {reason}"
                );
                slot.begin_exit(SlotExit::Lost {
                    cutover_sample: cursor,
                    kind: SourceLossReason::CaptureStopped,
                    reason,
                });
            }
        }
        SlotHealth::TimelineLost(reason) => {
            tracing::warn!(
                "System audio could not be placed at sample {cursor}; it stays in the mix and re-anchors: {reason}"
            );
            shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .system
                .losses
                .push_back(SystemAudioLoss {
                    device_name: slot.producer.device_name.clone(),
                    kind: SourceLossReason::TimelineRejected,
                    reason,
                    at_sample: cursor,
                });
        }
        SlotHealth::Recovered { gap } => {
            let gap_ms = gap.as_millis() as u64;
            tracing::info!(gap_ms, "System audio is placed again at sample {cursor}.");
            shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .system
                .recoveries
                .push_back(SystemAudioRecovery {
                    gap_ms,
                    at_sample: cursor,
                });
        }
    }
}

/// Drains every pending producer frame into the timeline. Returns `true` when
/// the producer channel is disconnected. Called from the pacing loop and from
/// inside a blocked FIFO write, so a bursty reader never starves ingestion.
#[allow(clippy::too_many_arguments)]
fn ingest_pending(
    receiver: &mpsc::Receiver<AudioFrame>,
    timeline: &mut AudioTimeline,
    clock: &mut Option<SourceClock>,
    generation: u64,
    placement: Placement,
    delay_frames: u64,
    stats: &AudioCaptureStats,
    activity: &mut SourceActivity,
) -> bool {
    let epoch = placement.epoch;
    loop {
        match receiver.try_recv() {
            Ok(frame) => {
                let now = Instant::now();
                activity.arrival = now;
                if !valid_fresh_frame(&frame, now) {
                    let frames = frame.frame_count() as u64;
                    timeline.counters.discarded_frames += frames;
                    timeline.losses.discarded_stale += frames;
                    continue;
                }
                let trimmed = crate::audio::trim_audio_frame_before_epoch(frame, epoch);
                timeline.counters.discarded_frames += trimmed.discarded_frames;
                timeline.losses.discarded_before_epoch += trimmed.discarded_frames;
                let Some(frame) = trimmed.frame else {
                    continue;
                };
                let clock = clock.get_or_insert_with(|| {
                    let clock = SourceClock::new(&frame, epoch).with_delay(delay_frames);
                    tracing::info!(
                        epoch_age_ms = now.saturating_duration_since(epoch).as_millis() as u64,
                        mapped_start = clock.mapped_end.round() as u64 + delay_frames,
                        cursor = timeline.cursor(),
                        "Microphone timeline initialized"
                    );
                    clock
                });
                let Some((start, frames)) = clock.interval(&frame) else {
                    let frames = frame.frame_count() as u64;
                    timeline.counters.discarded_frames += frames;
                    timeline.losses.discarded_duplicate += frames;
                    continue;
                };
                match timeline.push_outcome(generation, start, resample_frame(frame, frames)) {
                    PushOutcome::Placed => {
                        activity.placed = now;
                        activity.live = now;
                        stats.mark_live();
                    }
                    PushOutcome::AheadOfCap { end, frames } => {
                        if placement.output_behind
                            && timeline.on_time_by_wall_clock(
                                end,
                                frames,
                                placement.wall_cursor(now),
                            )
                        {
                            activity.live = now;
                        }
                    }
                    PushOutcome::Rejected => {}
                }
            }
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(mpsc::TryRecvError::Disconnected) => return true,
        }
    }
}

/// Worst-case pacing observed by one bus run; logged with the loss split.
#[derive(Debug, Default, Clone, Copy)]
struct BusDiagnostics {
    max_write_stall: Duration,
    max_lateness: Duration,
}

fn log_bus_summary(timeline: &AudioTimeline, diagnostics: &BusDiagnostics, outcome: &str) {
    let counters = timeline.counters();
    let losses = timeline.losses();
    let lost = counters
        .dropped_frames
        .saturating_add(losses.discarded_stale)
        .saturating_add(losses.stale_written);
    let message = format!(
        "Session audio bus {outcome}: cursor={} captured={} generated={} discarded={} \
         (stale={}, before-epoch={}, overlap={}, duplicate={}, behind-cap={}) dropped={} \
         (ahead-of-cap={}, output-behind={}, malformed={}, producer-queue-full={}) \
         stale-written={} max-write-stall={}ms max-lateness={}ms",
        counters.captured_frames + counters.generated_frames,
        counters.captured_frames,
        counters.generated_frames,
        counters.discarded_frames,
        losses.discarded_stale,
        losses.discarded_before_epoch,
        losses.discarded_overlap,
        losses.discarded_duplicate,
        losses.discarded_behind_cap,
        counters.dropped_frames,
        losses.dropped_ahead_of_cap,
        losses.dropped_output_behind,
        losses.dropped_malformed,
        losses.producer_queue_full,
        losses.stale_written,
        diagnostics.max_write_stall.as_millis(),
        diagnostics.max_lateness.as_millis(),
    );
    if lost > 0 {
        tracing::warn!("{message}");
    } else {
        tracing::info!("{message}");
    }
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
    /// Plan 069 decision 8: a non-negative bus delay, added to every mapped
    /// position. The bus can only delay; the FFmpeg whole-track shift carries
    /// the common part of the offsets.
    delay_frames: u64,
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
            delay_frames: 0,
        }
    }

    fn with_delay(mut self, delay_frames: u64) -> Self {
        self.delay_frames = delay_frames;
        self
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
        Some((
            start.saturating_add(self.delay_frames),
            end.saturating_sub(start) as usize,
        ))
    }
}

/// What one second of current, nonzero input produced on a bus mapped against
/// `epoch` (plan 070 regression harness).
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct EpochAudioEvidence {
    pub counters: AudioBusCounters,
    pub dropped_ahead_of_cap: u64,
    /// Output position of the first audible mixed frame, if any.
    pub first_audible_frame: Option<u64>,
    pub audible_frames: u64,
    pub rendered_frames: u64,
}

/// Feeds a second of current audio captured from `started` through the real
/// timeline, clock and system slot, rendering behind a 150 ms playout delay.
#[cfg(test)]
pub(crate) fn test_current_audio_on_epoch(
    epoch: Instant,
    started: Instant,
    packet_frames: usize,
    microphone_enabled: bool,
    system_enabled: bool,
) -> EpochAudioEvidence {
    let mut timeline = AudioTimeline::new();
    let mut clock = None;
    let (mut system, _sender, _failure) = mix_tests::test_slot(0);
    let mut next_frame = 0;
    let mut first_audible_frame = None;
    let mut audible_frames = 0;
    let mut rendered_frames = 0;
    for tick in 0..100 {
        let end_frames = (tick + 1) * CHUNK_FRAMES;
        while next_frame + packet_frames <= end_frames {
            let captured_at =
                started + Duration::from_secs_f64((next_frame + packet_frames) as f64 / 48_000.0);
            let frame = AudioFrame {
                timestamp_micros: next_frame as u64 * 1_000_000 / 48_000,
                captured_at,
                sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
                channels: NATIVE_AUDIO_CHANNELS,
                samples: vec![0.25; packet_frames * 2],
            };
            if microphone_enabled {
                let clock = clock.get_or_insert_with(|| SourceClock::new(&frame, epoch));
                let (start, _) = clock.interval(&frame).unwrap();
                timeline.push(0, start, frame.clone());
            }
            if system_enabled {
                system.place(frame, epoch, captured_at);
            }
            next_frame += packet_frames;
        }
        if tick >= 15 {
            let mic = timeline.render_with_provenance();
            let sys = system.render();
            let mixed = mix_chunk(
                &mic.samples,
                AudioProcessingSettings::default(),
                &sys.samples,
                AudioProcessingSettings::default(),
                PeakLimiter::default(),
            );
            for (index, frame) in mixed.output.chunks_exact(2).enumerate() {
                if frame.iter().any(|value| *value > 0.1) {
                    first_audible_frame.get_or_insert(rendered_frames + index as u64);
                    audible_frames += 1;
                }
            }
            rendered_frames += CHUNK_FRAMES as u64;
        }
    }
    let mic = timeline.counters();
    let sys = system.timeline.counters();
    EpochAudioEvidence {
        counters: AudioBusCounters {
            captured_frames: mic.captured_frames + sys.captured_frames,
            dropped_frames: mic.dropped_frames + sys.dropped_frames,
            generated_frames: mic.generated_frames + sys.generated_frames,
            discarded_frames: mic.discarded_frames + sys.discarded_frames,
        },
        dropped_ahead_of_cap: timeline.losses().dropped_ahead_of_cap
            + system.timeline.losses().dropped_ahead_of_cap,
        first_audible_frame,
        audible_frames,
        rendered_frames,
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

struct OutputObservation {
    request: crate::live_source_switch::SourceSwitchParams,
    coordinator: Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
    acknowledgement: Option<tokio::sync::oneshot::Sender<anyhow::Result<AudioCommitReceipt>>>,
}

struct PendingHandoff {
    command: AudioSwitchCommand,
    generation: u64,
    cutover: u64,
    deadline: Instant,
    clock: Option<SourceClock>,
    pcm: AudioTimeline,
    lost: bool,
    old_ramped_down: bool,
    delay_frames: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum HandoffAction {
    Continue,
    RampOld,
    Commit,
    Cancel,
}

fn next_cutover_sample(cursor: u64, elapsed: Duration) -> u64 {
    let wall = (elapsed.as_nanos() * 48_000).div_ceil(1_000_000_000) as u64;
    wall.div_ceil(CHUNK_FRAMES as u64)
        .saturating_mul(CHUNK_FRAMES as u64)
        .max(cursor.saturating_add(CHUNK_FRAMES as u64))
}

impl AudioTimeline {
    fn covers(&self, start: u64, frames: u64) -> bool {
        let end = start.saturating_add(frames);
        let mut covered = start;
        for packet in &self.packets {
            if packet.start > covered {
                return false;
            }
            covered = covered.max(packet.end());
            if covered >= end {
                return true;
            }
        }
        false
    }
}

impl PendingHandoff {
    fn new(
        command: AudioSwitchCommand,
        generation: u64,
        cursor: u64,
        epoch: Instant,
        now: Instant,
    ) -> Self {
        let cutover = next_cutover_sample(cursor, now.saturating_duration_since(epoch));
        let mut pcm = AudioTimeline::new();
        pcm.cursor = cutover;
        pcm.select_generation(generation);
        let deadline = command.admitted_at + HANDOFF_BASE_BUDGET;
        Self {
            command,
            generation,
            cutover,
            deadline,
            clock: None,
            pcm,
            lost: false,
            old_ramped_down: false,
            delay_frames: 0,
        }
    }

    /// The candidate microphone lands on the same bus delay as the one it
    /// replaces (plan 069 decision 8), so it can cover the cutover only D
    /// plus one playout delay after admission: the deadline extends by both
    /// ([`handoff_budget`]).
    fn with_delay(mut self, delay_frames: u64, playout_delay: Duration) -> Self {
        self.delay_frames = delay_frames;
        self.pcm.ahead_limit = MAX_BUFFERED_FRAMES.saturating_add(delay_frames);
        self.deadline = self.command.admitted_at + handoff_budget(delay_frames, playout_delay);
        self
    }

    fn poll(&mut self, epoch: Instant, now: Instant) {
        let Some(receiver) = self
            .command
            .candidate
            .as_ref()
            .and_then(|candidate| candidate.receiver.as_ref())
        else {
            return;
        };
        loop {
            match receiver.try_recv() {
                Ok(frame) => {
                    if !valid_fresh_frame(&frame, now) {
                        self.pcm.counters.discarded_frames += frame.frame_count() as u64;
                        continue;
                    }
                    let delay_frames = self.delay_frames;
                    let clock = self.clock.get_or_insert_with(|| {
                        SourceClock::new(&frame, epoch).with_delay(delay_frames)
                    });
                    let Some((start, frames)) = clock.interval(&frame) else {
                        self.pcm.counters.discarded_frames += frame.frame_count() as u64;
                        continue;
                    };
                    // The timeline floor removes every sample before cutover,
                    // including straddling blocks and fractional clock mapping.
                    self.pcm
                        .push(self.generation, start, resample_frame(frame, frames));
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.lost = true;
                    break;
                }
            }
        }
    }

    fn ready(&self) -> bool {
        self.command.candidate.is_none()
            || (!self.lost && self.pcm.covers(self.cutover, CHUNK_FRAMES as u64))
    }

    fn action(&mut self, cursor: u64, now: Instant, stopping: bool) -> HandoffAction {
        if stopping
            || self.command.cancelled.load(Ordering::Acquire)
            || self.lost
            || now >= self.deadline
        {
            return HandoffAction::Cancel;
        }
        if cursor == self.cutover {
            return if self.old_ramped_down && self.ready() {
                HandoffAction::Commit
            } else {
                HandoffAction::Cancel
            };
        }
        if cursor + CHUNK_FRAMES as u64 == self.cutover {
            if self.ready() {
                return HandoffAction::RampOld;
            }
            // A target arriving after this decision cannot skip the old ramp.
            // Move both the boundary and candidate floor by one whole chunk.
            self.cutover += CHUNK_FRAMES as u64;
            self.pcm.cursor = self.cutover;
            self.pcm.discard_before(self.cutover);
        }
        HandoffAction::Continue
    }
}

fn ramp_through_zero(samples: &mut [f32], ramp_in: bool) {
    let frames = samples.len() / 2;
    let length = 240.min(frames);
    for index in 0..length {
        let (frame, gain) = if ramp_in {
            (index, index as f32 / length as f32)
        } else {
            (
                frames - length + index,
                (length - index - 1) as f32 / length as f32,
            )
        };
        samples[frame * 2] *= gain;
        samples[frame * 2 + 1] *= gain;
    }
}

/// Per-frame enable envelope of a mixed source (plan 069 decision 2). A source
/// joins with a 5 ms ramp from zero that starts at its first captured frame,
/// so a startup burst never clicks in, and leaves with a 5 ms ramp to zero at
/// the chunk boundary after a detach or a loss. Integer steps keep both ends
/// exact: the steady state multiplies by exactly 1.0.
#[derive(Debug, Clone, Copy, Default)]
struct EnableRamp {
    level: u16,
    joined: bool,
    closing: bool,
}
impl EnableRamp {
    fn apply(&mut self, samples: &mut [f32], captured: &[bool]) {
        for (frame, captured) in samples.chunks_exact_mut(2).zip(captured) {
            let gain = if self.closing {
                self.level = self.level.saturating_sub(1);
                f32::from(self.level) / f32::from(RAMP_FRAMES)
            } else if self.joined || *captured {
                self.joined = true;
                let gain = f32::from(self.level) / f32::from(RAMP_FRAMES);
                self.level = (self.level + 1).min(RAMP_FRAMES);
                gain
            } else {
                0.0
            };
            frame[0] *= gain;
            frame[1] *= gain;
        }
    }
    fn closed(&self) -> bool {
        self.closing && self.level == 0
    }
}

/// Stereo-linked peak limiter on the mixed sum (plan 069 decision 7): -1 dBFS
/// ceiling, instant attack (no look-ahead, so it adds no latency), and a
/// one-pole release with a 50 ms time constant. Unity gain is exact, so an
/// idle limiter is a no-op.
#[derive(Debug, Clone, Copy)]
struct PeakLimiter {
    gain: f32,
}
impl Default for PeakLimiter {
    fn default() -> Self {
        Self { gain: 1.0 }
    }
}
impl PeakLimiter {
    fn idle(&self) -> bool {
        self.gain >= 1.0
    }
    /// Limits `samples` in place. `clipped` marks every sample whose input
    /// magnitude was above the ceiling: the samples the limiter had to pull
    /// under it (`audioMixClippedSamples` on `diagnostics.stats`).
    fn process(&mut self, samples: &mut [f32], clipped: &mut [bool]) {
        let release = (1.0 - (-1.0 / LIMITER_RELEASE_FRAMES).exp()) as f32;
        for (frame, clipped) in samples.chunks_exact_mut(2).zip(clipped.chunks_exact_mut(2)) {
            clipped[0] = frame[0].abs() > LIMITER_CEILING;
            clipped[1] = frame[1].abs() > LIMITER_CEILING;
            if self.gain < 1.0 {
                self.gain += (1.0 - self.gain) * release;
                // f32 cannot creep closer than this to unity (the step drops
                // below one ulp); the final 0.001 dB jump is inaudible.
                if 1.0 - self.gain < 1.0e-4 {
                    self.gain = 1.0;
                }
            }
            let peak = frame[0].abs().max(frame[1].abs());
            if peak * self.gain > LIMITER_CEILING {
                self.gain = LIMITER_CEILING / peak;
            }
            if self.gain < 1.0 {
                frame[0] *= self.gain;
                frame[1] *= self.gain;
            }
        }
    }
}

/// One mixed chunk, computed from raw PCM and the current controls.
struct MixedSamples {
    output: Vec<f32>,
    microphone: Vec<f32>,
    system: Vec<f32>,
    clipped: Vec<bool>,
    limiter: PeakLimiter,
}

/// The mix (plan 069 decisions 3, 5, 7): the microphone keeps exactly today's
/// fold, gain and mute (`process_interleaved_f32`); system audio keeps its
/// stereo image and takes its own gain only; the sum passes the limiter.
fn mix_chunk(
    microphone_raw: &[f32],
    microphone: AudioProcessingSettings,
    system_raw: &[f32],
    system: AudioProcessingSettings,
    mut limiter: PeakLimiter,
) -> MixedSamples {
    let microphone_samples = process_interleaved_f32(microphone_raw, 2, microphone);
    let system_gain = if system.muted {
        0.0
    } else {
        crate::audio::db_to_gain(system.gain_db)
    };
    let system_samples = system_raw
        .iter()
        .map(|sample| sample * system_gain)
        .collect::<Vec<_>>();
    let mut output = microphone_samples
        .iter()
        .zip(&system_samples)
        .map(|(microphone, system)| microphone + system)
        .collect::<Vec<_>>();
    let mut clipped = vec![false; output.len()];
    limiter.process(&mut output, &mut clipped);
    MixedSamples {
        output,
        microphone: microphone_samples,
        system: system_samples,
        clipped,
        limiter,
    }
}

/// Plan 069 decision 8: each source's offset `o_s` (ms, positive delays) is
/// split into one FFmpeg whole-track shift `min(o_mic, o_sys)`, fixed at
/// session start, and a non-negative bus delay `o_s - min` per source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncOffsetSplit {
    pub track_shift_ms: i32,
    pub microphone_delay_frames: u64,
    pub system_delay_frames: u64,
}
pub fn split_sync_offsets(microphone_offset_ms: i32, system_offset_ms: i32) -> SyncOffsetSplit {
    let shift = microphone_offset_ms.min(system_offset_ms);
    let frames = |offset: i32| {
        (i64::from(offset) - i64::from(shift)) as u64 * u64::from(NATIVE_AUDIO_SAMPLE_RATE) / 1_000
    };
    SyncOffsetSplit {
        track_shift_ms: shift,
        microphone_delay_frames: frames(microphone_offset_ms),
        system_delay_frames: frames(system_offset_ms),
    }
}

/// Bus timing and mix configuration fixed at session start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionAudioOptions {
    /// [`PLAYOUT_DELAY`] by default; [`SYSTEM_AUDIO_PLAYOUT_DELAY`] on every
    /// session of a platform that supports system audio (decision 13).
    pub playout_delay: Duration,
    /// Non-negative bus delays from [`split_sync_offsets`] (decision 8).
    pub microphone_delay_frames: u64,
    pub system_delay_frames: u64,
    /// Initial system-audio level; live changes use
    /// [`SystemAudioHandle::set_gain_db`].
    pub system_gain_db: f32,
    /// Plan 076: pause system audio when it carries the stream back into
    /// itself. Live changes use [`SystemAudioHandle::set_echo_guard`].
    pub echo_guard: bool,
}
impl Default for SessionAudioOptions {
    fn default() -> Self {
        Self {
            playout_delay: PLAYOUT_DELAY,
            microphone_delay_frames: 0,
            system_delay_frames: 0,
            system_gain_db: crate::protocol::SYSTEM_AUDIO_GAIN_DB_DEFAULT,
            echo_guard: true,
        }
    }
}

/// A prepared system-audio producer: its capture runs on a dedicated owner
/// thread and holds the one system pool permit until it closes. Attach it
/// with [`SystemAudioHandle::attach`]; dropping it closes the capture.
pub struct SystemAudioProducer {
    producer: ManagedProducer,
    failure: Option<ProducerFailure>,
}
impl std::fmt::Debug for SystemAudioProducer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SystemAudioProducer")
            .field("device_id", &self.producer.device_id)
            .field("device_name", &self.producer.device_name)
            .finish_non_exhaustive()
    }
}
impl SystemAudioProducer {
    pub fn device_name(&self) -> &str {
        &self.producer.device_name
    }
}

async fn prepare_system_audio_in(
    open: impl FnOnce() -> anyhow::Result<ProducerSource> + Send + 'static,
    cancelled: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
) -> anyhow::Result<SystemAudioProducer> {
    let failure_slot: Arc<std::sync::Mutex<Option<ProducerFailure>>> = Arc::default();
    let captured_failure = failure_slot.clone();
    // No readiness wait: a system source may legitimately deliver nothing
    // while nothing plays (Windows loopback). It joins the mix at its first
    // buffer instead (decision 12).
    let producer = prepare_producer_in(
        SourceRole::System,
        move || {
            let source = open()?;
            *captured_failure.lock().unwrap_or_else(|p| p.into_inner()) = source.failure.clone();
            Ok(source)
        },
        cancelled,
        count,
        spawn_system_owner,
        |_| {},
        false,
    )
    .await?;
    let failure = failure_slot
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    Ok(SystemAudioProducer { producer, failure })
}

/// Live system-audio state for Diagnostics (`systemAudio*` and
/// `audioMixClippedSamples` on `diagnostics.stats`).
#[derive(Debug, Clone, PartialEq)]
pub struct SystemAudioObservation {
    /// A system slot is in the mix (including before its first buffer).
    pub attached: bool,
    pub device_name: Option<String>,
    /// Bus sample at which the attached slot joined.
    pub cutover_sample: Option<u64>,
    /// Post-gain system peak of the latest chunk (0..=1).
    pub live_peak: f32,
    pub session_peak: f32,
    pub captured_frames: u64,
    pub generated_frames: u64,
    pub dropped_frames: u64,
    /// Mixed samples the limiter had to pull under its -1 dBFS ceiling.
    pub mix_clipped_samples: u64,
}

/// The bus paused system audio because it carried the stream back into
/// itself (plan 076): the microphone returned `lag_ms` later. The slot left
/// the mix; turning System audio on again resumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAudioEchoPause {
    pub lag_ms: u32,
    pub at_sample: u64,
}

/// System audio placed again after a timeline loss (plan 076). The slot never
/// left the mix; `gap_ms` of it was silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAudioRecovery {
    pub gap_ms: u64,
    pub at_sample: u64,
}

/// A system source the platform reported lost mid-session. The bus ramped it
/// out and keeps running on the microphone. A timeline loss (plan 076) is
/// reported the same way, but its slot stays in the mix and re-anchors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAudioLoss {
    pub device_name: String,
    pub kind: SourceLossReason,
    pub reason: String,
    pub at_sample: u64,
}

#[derive(Debug, Default)]
struct SystemShared {
    attached: bool,
    device_name: Option<String>,
    cutover_sample: Option<u64>,
    losses: VecDeque<SystemAudioLoss>,
    recoveries: VecDeque<SystemAudioRecovery>,
    echo_pauses: VecDeque<SystemAudioEchoPause>,
}

enum SystemCommand {
    Attach {
        producer: SystemAudioProducer,
        acknowledgement: tokio::sync::oneshot::Sender<anyhow::Result<u64>>,
    },
    Detach {
        acknowledgement: tokio::sync::oneshot::Sender<anyhow::Result<Option<u64>>>,
    },
}
fn refuse_system_command(command: SystemCommand, reason: &str) {
    match command {
        SystemCommand::Attach {
            producer,
            acknowledgement,
        } => {
            let _ = acknowledgement.send(Err(anyhow::anyhow!("{reason}")));
            // The capture closes on its own owner thread.
            drop(producer);
        }
        SystemCommand::Detach { acknowledgement } => {
            let _ = acknowledgement.send(Ok(None));
        }
    }
}

/// Only an explicit acknowledgement lets a caller observe an attach. A caller
/// that gave up waiting is refused rather than attached behind its back.
const SYSTEM_ATTACH_DEADLINE: Duration = WRITE_DEADLINE;
const SYSTEM_ATTACH_DRAINING: &str =
    "Session audio is draining after Stop; system audio was not attached.";

/// Controls the session's system-audio slot. Cloneable; every call is
/// non-blocking or bounded.
#[derive(Clone)]
pub struct SystemAudioHandle {
    commands: mpsc::SyncSender<SystemCommand>,
    shared: Arc<std::sync::Mutex<AudioShared>>,
    settings: AudioProcessingSettingsHandle,
    count: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    echo_guard: Arc<AtomicBool>,
}
impl SystemAudioHandle {
    /// Opens a system-audio capture on its own owner thread, inside the
    /// system pool (limit 1). `open` builds the source with
    /// [`ProducerSource::system`]. Microphone admission never waits on it.
    pub async fn prepare(
        &self,
        open: impl FnOnce() -> anyhow::Result<ProducerSource> + Send + 'static,
        cancelled: Arc<AtomicBool>,
    ) -> anyhow::Result<SystemAudioProducer> {
        prepare_system_audio_in(open, cancelled, self.count.clone()).await
    }

    /// Adds the producer to the mix at the next chunk boundary and returns
    /// that bus sample. The slot renders silence until its first buffer, then
    /// ramps in over 5 ms. Refused (and the producer closed) when the session
    /// is stopping or silently draining, a system slot is already attached,
    /// or the bus does not acknowledge within 5 s.
    pub async fn attach(&self, producer: SystemAudioProducer) -> anyhow::Result<u64> {
        if self.stop.load(Ordering::Acquire) {
            anyhow::bail!("Session audio is stopping; system audio was not attached.");
        }
        if self.draining.load(Ordering::Acquire) {
            anyhow::bail!(SYSTEM_ATTACH_DRAINING);
        }
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        self.commands
            .try_send(SystemCommand::Attach {
                producer,
                acknowledgement,
            })
            .map_err(|_| {
                anyhow::anyhow!(
                    "The session audio writer is unavailable or already changing system audio."
                )
            })?;
        match tokio::time::timeout(SYSTEM_ATTACH_DEADLINE, receipt).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => anyhow::bail!("Session audio stopped before attaching system audio."),
            Err(_) => anyhow::bail!(
                "Session audio did not acknowledge system audio within 5s; it was not attached."
            ),
        }
    }

    /// Ramps the system slot to zero over 5 ms from the next chunk boundary,
    /// then closes its capture. Returns the boundary sample, or `None` when no
    /// system slot was attached (idempotent).
    pub async fn detach(&self) -> anyhow::Result<Option<u64>> {
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        match self
            .commands
            .try_send(SystemCommand::Detach { acknowledgement })
        {
            Ok(()) => {}
            // A stopped bus has nothing attached.
            Err(mpsc::TrySendError::Disconnected(_)) => return Ok(None),
            Err(mpsc::TrySendError::Full(_)) => {
                anyhow::bail!("Session audio is already changing system audio; retry.")
            }
        }
        match tokio::time::timeout(SYSTEM_ATTACH_DEADLINE, receipt).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Ok(None),
            Err(_) => anyhow::bail!("Session audio did not acknowledge the system audio detach."),
        }
    }

    /// Live level change, applied at the next write attempt (same latency as
    /// the microphone gain). Clamped to the shared -24..=+12 dB range.
    pub fn set_gain_db(&self, gain_db: f32) {
        self.settings.update(AudioProcessingSettings {
            gain_db: crate::protocol::clamp_system_audio_gain_db(gain_db),
            muted: false,
        });
    }

    pub fn observation(&self) -> SystemAudioObservation {
        let shared = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        let stats = &shared.system_stats;
        SystemAudioObservation {
            attached: shared.system.attached,
            device_name: shared.system.device_name.clone(),
            cutover_sample: shared.system.cutover_sample,
            live_peak: stats.live_peak(),
            session_peak: stats.session_peak(),
            captured_frames: stats.captured_frames(),
            generated_frames: stats.generated_frames(),
            dropped_frames: stats.dropped_frames(),
            mix_clipped_samples: shared.mix_clipped_samples,
        }
    }

    /// One `system-audio-lost` event per loss (S4 emits the health event).
    pub fn claim_loss(&self) -> Option<SystemAudioLoss> {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .system
            .losses
            .pop_front()
    }

    /// Plan 076: whether a detected loop pauses system audio. Off, a loop is
    /// only logged.
    pub fn set_echo_guard(&self, enabled: bool) {
        self.echo_guard.store(enabled, Ordering::Release);
    }

    /// One `system-audio-echo-paused` event per pause.
    pub fn claim_echo_pause(&self) -> Option<SystemAudioEchoPause> {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .system
            .echo_pauses
            .pop_front()
    }

    /// One `system-audio-recovered` event per timeline loss that ended.
    pub fn claim_recovery(&self) -> Option<SystemAudioRecovery> {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .system
            .recoveries
            .pop_front()
    }

    /// System producers this session owns (open, attached or closing).
    #[cfg(test)]
    pub fn owned_producer_count(&self) -> u64 {
        self.count.load(Ordering::Acquire)
    }
}

enum SlotExit {
    Detach {
        cutover_sample: u64,
        acknowledgement: tokio::sync::oneshot::Sender<anyhow::Result<Option<u64>>>,
    },
    Lost {
        cutover_sample: u64,
        kind: SourceLossReason,
        reason: String,
    },
    /// A silent drain ended capture: a deliberate stop, never a loss.
    Drained { cutover_sample: u64 },
    /// The echo guard paused it: it carried the stream back into itself.
    EchoPaused { cutover_sample: u64, lag_ms: u32 },
}

/// A mixed source beside the microphone. It has its own timeline, clock,
/// bus delay and enable ramp; its gain handle is shared with
/// [`SystemAudioHandle`]. The microphone keeps the pre-existing hot-swap state
/// machine in `run_bus_owned`; both render one chunk per bus chunk, in
/// lockstep on the same cursor.
struct SourceSlot {
    role: SourceRole,
    producer: ManagedProducer,
    receiver: mpsc::Receiver<AudioFrame>,
    failure: Option<ProducerFailure>,
    previous_producer_drops: u64,
    timeline: AudioTimeline,
    clock: Option<SourceClock>,
    delay_frames: u64,
    ramp: EnableRamp,
    accounted: AudioBusCounters,
    exit: Option<SlotExit>,
    /// The bus's playout delay: where the cursor would be by the wall clock.
    playout_delay: Duration,
    /// Set by the bus before every ingest pass (plan 076): the output is in
    /// a stall episode, so a buffer on time by the wall clock is not refused
    /// by this source's fault.
    output_behind: bool,
    /// Arrival of the first buffer in the current run of buffers that placed
    /// no sample (and were not excused by a stalled output); `None` once one
    /// did.
    unplayable_since: Option<Instant>,
    last_placed: Instant,
    /// That run lasted [`SYSTEM_UNPLAYABLE_LOSS_AFTER`]: reported once, then
    /// re-anchored until a buffer places again (plan 076). Never an exit.
    fault: TimelineFault,
}

/// What one ingest pass of a mixed source observed (plan 076).
#[derive(Debug, Clone, PartialEq, Eq)]
enum SlotHealth {
    Healthy,
    /// The platform reported a failure or the stream ended: the slot leaves.
    Stopped(String),
    /// Buffers kept arriving but none could be placed. Reported once; the
    /// slot stays in the mix and re-anchors.
    TimelineLost(String),
    /// The first placed buffer after a timeline loss.
    Recovered {
        gap: Duration,
    },
}

/// What [`SourceSlot::place`] did with one buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaceOutcome {
    Placed,
    /// Refused ahead of a cursor that fell behind the wall clock, while the
    /// buffer itself was on time.
    OnTime,
    Refused,
}

impl SourceSlot {
    fn new(
        role: SourceRole,
        producer: SystemAudioProducer,
        cursor: u64,
        delay_frames: u64,
        playout_delay: Duration,
    ) -> Self {
        let SystemAudioProducer {
            mut producer,
            failure,
        } = producer;
        // A producer without a receiver is already over; it reads as lost.
        let receiver = producer
            .receiver
            .take()
            .unwrap_or_else(|| mpsc::channel().1);
        let previous_producer_drops = producer.stats.dropped_frames();
        let mut timeline = AudioTimeline::new().with_delay_headroom(delay_frames);
        timeline.cursor = cursor;
        timeline.select_generation(0);
        Self {
            role,
            producer,
            receiver,
            failure,
            previous_producer_drops,
            timeline,
            clock: None,
            delay_frames,
            ramp: EnableRamp::default(),
            accounted: AudioBusCounters::default(),
            exit: None,
            playout_delay,
            output_behind: false,
            unplayable_since: None,
            last_placed: Instant::now(),
            fault: TimelineFault::default(),
        }
    }

    /// Drains every pending frame into the slot timeline: stale and pre-epoch
    /// frames are discarded, and a first burst whose early frames already lie
    /// behind the cursor is trimmed as overlap, never queued late. Returns the
    /// reason once the platform reported a failure, the stream ended, or (once
    /// per fault) buffers kept arriving that could not be placed for
    /// [`SYSTEM_UNPLAYABLE_LOSS_AFTER`]. Silence, including no buffers at all,
    /// is never loss (decision 11).
    #[cfg(test)]
    fn ingest(&mut self, epoch: Instant) -> Option<String> {
        self.ingest_at(epoch, Instant::now())
    }

    /// [`Self::ingest`] with every drained buffer arriving at `now`.
    #[cfg(test)]
    fn ingest_at(&mut self, epoch: Instant, now: Instant) -> Option<String> {
        match self.ingest_health_at(epoch, now) {
            SlotHealth::Stopped(reason) | SlotHealth::TimelineLost(reason) => Some(reason),
            SlotHealth::Healthy | SlotHealth::Recovered { .. } => None,
        }
    }

    fn ingest_health(&mut self, epoch: Instant) -> SlotHealth {
        self.ingest_health_at(epoch, Instant::now())
    }

    /// [`Self::ingest`], keeping what happened: a stopped capture (EOF and
    /// platform failure are sticky, so every pass sees them), or the edges of
    /// a timeline loss and its recovery (each reported once).
    fn ingest_health_at(&mut self, epoch: Instant, now: Instant) -> SlotHealth {
        let mut disconnected = false;
        let mut newly_lost = false;
        loop {
            match self.receiver.try_recv() {
                Ok(frame) => match self.place(frame, epoch, now) {
                    PlaceOutcome::Placed => {
                        self.unplayable_since = None;
                        self.last_placed = now;
                    }
                    PlaceOutcome::OnTime => self.unplayable_since = None,
                    PlaceOutcome::Refused => {
                        let since = *self.unplayable_since.get_or_insert(now);
                        if now.saturating_duration_since(since) >= SYSTEM_UNPLAYABLE_LOSS_AFTER {
                            newly_lost |= self.fault.begin(now, self.last_placed);
                        }
                    }
                },
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        let failure = self
            .failure
            .as_ref()
            .and_then(|failure| failure.lock().unwrap_or_else(|p| p.into_inner()).clone());
        if let Some(reason) = failure {
            return SlotHealth::Stopped(reason);
        }
        if disconnected {
            return SlotHealth::Stopped(format!("{} stopped delivering audio.", self.role.label()));
        }
        if self.fault.reanchor_due(now) {
            // The next buffer maps from its capture time, as at session start.
            self.clock = None;
            tracing::warn!(
                "{} timeline re-anchored: its buffers keep arriving but none could be placed.",
                self.role.label()
            );
        }
        if newly_lost {
            // Buffers kept arriving; the timeline refused every one.
            return SlotHealth::TimelineLost(format!(
                "{} timestamps drifted out of range; no buffer could be placed for {}s.",
                self.role.label(),
                SYSTEM_UNPLAYABLE_LOSS_AFTER.as_secs()
            ));
        }
        match self.fault.recovered(self.last_placed) {
            Some(gap) => SlotHealth::Recovered { gap },
            None => SlotHealth::Healthy,
        }
    }

    /// Places one buffer and says whether any of its samples reached the mix.
    fn place(&mut self, frame: AudioFrame, epoch: Instant, now: Instant) -> PlaceOutcome {
        let fresh = match self.role {
            SourceRole::System => valid_system_frame(&frame, now),
            SourceRole::Microphone => valid_fresh_frame(&frame, now),
        };
        if !fresh {
            let frames = frame.frame_count() as u64;
            self.timeline.counters.discarded_frames += frames;
            self.timeline.losses.discarded_stale += frames;
            return PlaceOutcome::Refused;
        }
        let trimmed = crate::audio::trim_audio_frame_before_epoch(frame, epoch);
        self.timeline.counters.discarded_frames += trimmed.discarded_frames;
        self.timeline.losses.discarded_before_epoch += trimmed.discarded_frames;
        let Some(frame) = trimmed.frame else {
            return PlaceOutcome::Refused;
        };
        let delay_frames = self.delay_frames;
        let clock = self
            .clock
            .get_or_insert_with(|| SourceClock::new(&frame, epoch).with_delay(delay_frames));
        let Some((start, frames)) = clock.interval(&frame) else {
            let frames = frame.frame_count() as u64;
            self.timeline.counters.discarded_frames += frames;
            self.timeline.losses.discarded_duplicate += frames;
            return PlaceOutcome::Refused;
        };
        match self
            .timeline
            .push_outcome(0, start, resample_frame(frame, frames))
        {
            PushOutcome::Placed => PlaceOutcome::Placed,
            PushOutcome::AheadOfCap { end, frames } => {
                let wall_cursor = wall_cursor_at(now, epoch, self.playout_delay);
                if self.output_behind
                    && self
                        .timeline
                        .on_time_by_wall_clock(end, frames, wall_cursor)
                {
                    PlaceOutcome::OnTime
                } else {
                    PlaceOutcome::Refused
                }
            }
            PushOutcome::Rejected => PlaceOutcome::Refused,
        }
    }

    fn account_producer_drops(&mut self) {
        let drops = self.producer.stats.dropped_frames();
        let new_drops = drops.saturating_sub(self.previous_producer_drops);
        self.timeline.counters.dropped_frames += new_drops;
        self.timeline.losses.producer_queue_full += new_drops;
        self.previous_producer_drops = drops;
    }

    fn begin_exit(&mut self, exit: SlotExit) {
        self.ramp.closing = true;
        self.exit = Some(exit);
    }

    fn render(&mut self) -> RenderedPcm {
        let mut raw = self.timeline.render_with_provenance();
        self.ramp.apply(&mut raw.samples, &raw.captured);
        raw
    }
}

/// Applies queued system commands at a chunk boundary (`cursor` is the next
/// sample the bus renders). A slot that is ramping out finishes first.
fn accept_system_commands(
    commands: &mpsc::Receiver<SystemCommand>,
    system: &mut Option<SourceSlot>,
    cursor: u64,
    timing: BusTiming,
    stop: &AtomicBool,
    draining: &AtomicBool,
    shared: &std::sync::Mutex<AudioShared>,
) {
    while system.as_ref().is_none_or(|slot| slot.exit.is_none()) {
        let Ok(command) = commands.try_recv() else {
            return;
        };
        match command {
            SystemCommand::Attach {
                producer,
                acknowledgement,
            } => {
                if stop.load(Ordering::Acquire) {
                    refuse_system_command(
                        SystemCommand::Attach {
                            producer,
                            acknowledgement,
                        },
                        "Session audio is stopping; system audio was not attached.",
                    );
                    continue;
                }
                if draining.load(Ordering::Acquire) {
                    refuse_system_command(
                        SystemCommand::Attach {
                            producer,
                            acknowledgement,
                        },
                        SYSTEM_ATTACH_DRAINING,
                    );
                    continue;
                }
                if system.is_some() {
                    refuse_system_command(
                        SystemCommand::Attach {
                            producer,
                            acknowledgement,
                        },
                        "System audio is already attached to this session.",
                    );
                    continue;
                }
                if acknowledgement.is_closed() {
                    continue;
                }
                let device_name = producer.device_name().to_string();
                let slot = SourceSlot::new(
                    SourceRole::System,
                    producer,
                    cursor,
                    timing.system_delay_frames,
                    timing.playout_delay,
                );
                // Publish before acknowledging, so a caller that sees Ok sees
                // the attached state; withdraw if the caller already left.
                let publish = |attached: bool| {
                    let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
                    shared.system.attached = attached;
                    shared.system.device_name = attached.then(|| device_name.clone());
                    shared.system.cutover_sample = attached.then_some(cursor);
                };
                publish(true);
                if acknowledgement.send(Ok(cursor)).is_err() {
                    publish(false);
                    continue;
                }
                *system = Some(slot);
            }
            SystemCommand::Detach { acknowledgement } => match system.as_mut() {
                Some(slot) => slot.begin_exit(SlotExit::Detach {
                    cutover_sample: cursor,
                    acknowledgement,
                }),
                None => {
                    let _ = acknowledgement.send(Ok(None));
                }
            },
        }
    }
}

/// Retires a system slot. Its close ticket goes to `system_retired`, never
/// the microphone's list: a microphone release waits on every microphone
/// ticket, and must never wait on (or fail because of) a closing system
/// capture (PR #477 review; decision 11).
fn retire_system_slot(
    slot: SourceSlot,
    shared: &std::sync::Mutex<AudioShared>,
    system_stats: &AudioCaptureStats,
    system_retired: &mut Vec<CompletionTicket>,
    diagnostics: &BusDiagnostics,
) {
    let SourceSlot {
        producer,
        timeline,
        exit,
        ..
    } = slot;
    log_bus_summary(&timeline, diagnostics, "system source retired");
    let device_name = producer.device_name.clone();
    system_retired.push(producer.retire());
    system_stats.record_live_peak(0.0);
    {
        let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
        shared.system.attached = false;
        shared.system.device_name = None;
        shared.system.cutover_sample = None;
        if let Some(SlotExit::Lost {
            cutover_sample,
            kind,
            reason,
        }) = &exit
        {
            shared.system.losses.push_back(SystemAudioLoss {
                device_name,
                kind: *kind,
                reason: reason.clone(),
                at_sample: *cutover_sample,
            });
        }
    }
    if let Some(SlotExit::EchoPaused {
        cutover_sample,
        lag_ms,
    }) = &exit
    {
        tracing::warn!(
            "System audio left the mix at sample {cutover_sample}: it carried the stream back {lag_ms} ms later."
        );
        shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .system
            .echo_pauses
            .push_back(SystemAudioEchoPause {
                lag_ms: *lag_ms,
                at_sample: *cutover_sample,
            });
    }
    if let Some(SlotExit::Drained { cutover_sample }) = &exit {
        tracing::info!(
            "System audio left the mix for the silent drain at sample {cutover_sample}."
        );
    }
    if let Some(SlotExit::Detach {
        cutover_sample,
        acknowledgement,
    }) = exit
    {
        let _ = acknowledgement.send(Ok(Some(cutover_sample)));
    }
}

/// A stopping bus keeps writing until its cursor reaches the stop instant
/// (PR #477 review). The cursor trails the wall clock by the playout delay,
/// so exiting on the stop flag would drop the last 50 ms (150 ms with system
/// audio) of captured audio and FFmpeg would pad that tail with silence.
/// Chunks still owed are flushed once their audio has had
/// [`STOP_DRAIN_ARRIVAL`] to arrive, not at their paced time, and the whole
/// drain is bounded by [`STOP_DRAIN_MARGIN`] past the playout delay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StopDrain {
    /// The bus sample at the stop instant.
    target: u64,
    /// Owed chunks render from here on without pacing.
    flush_at: Instant,
    /// Past this the drain gives up and the bus exits at once.
    deadline: Instant,
}
/// Covers a microphone callback (about 11 ms) and a system buffer's 22 to
/// 52 ms delivery lag (S0).
const STOP_DRAIN_ARRIVAL: Duration = Duration::from_millis(60);
const STOP_DRAIN_MARGIN: Duration = Duration::from_millis(100);
impl StopDrain {
    fn new(stop_at: Instant, epoch: Instant, playout_delay: Duration) -> Self {
        let target = (stop_at.saturating_duration_since(epoch).as_nanos()
            * u128::from(NATIVE_AUDIO_SAMPLE_RATE))
        .div_ceil(1_000_000_000) as u64;
        Self {
            target,
            flush_at: stop_at + STOP_DRAIN_ARRIVAL.min(playout_delay),
            deadline: stop_at + playout_delay + STOP_DRAIN_MARGIN,
        }
    }
    fn at(stop_requested_at: &OnceLock<Instant>, epoch: Instant, playout_delay: Duration) -> Self {
        Self::new(
            stop_requested_at
                .get()
                .copied()
                .unwrap_or_else(Instant::now),
            epoch,
            playout_delay,
        )
    }
    fn done(&self, cursor: u64, now: Instant) -> bool {
        cursor >= self.target || now >= self.deadline
    }
}

#[derive(Debug, Clone, Copy)]
struct BusTiming {
    playout_delay: Duration,
    microphone_delay_frames: u64,
    system_delay_frames: u64,
}

struct BusContext<'a> {
    settings: &'a AudioProcessingSettingsHandle,
    system_settings: &'a AudioProcessingSettingsHandle,
    stop: &'a AtomicBool,
    stop_requested_at: &'a OnceLock<Instant>,
    draining: &'a AtomicBool,
    source_stall_timeout: Duration,
    timing: BusTiming,
    shared: &'a std::sync::Mutex<AudioShared>,
    /// Plan 076: a detected loop pauses system audio.
    echo_guard: &'a AtomicBool,
}

fn run_bus(
    mut producer: Option<ManagedProducer>,
    path: &std::path::Path,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    commands: mpsc::Receiver<AudioSwitchCommand>,
    system_commands: mpsc::Receiver<SystemCommand>,
    context: BusContext<'_>,
) -> io::Result<()> {
    let mut retired = Vec::new();
    let mut system_retired = Vec::new();
    let shared = context.shared;
    let result = run_bus_owned(
        &mut producer,
        path,
        video_epoch,
        commands,
        &system_commands,
        context,
        &mut retired,
        &mut system_retired,
    );
    // Early exits (stop before the epoch, a failed transport) drop an
    // attached slot, which closes its capture; never report it attached.
    {
        let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
        shared.system.attached = false;
        shared.system.device_name = None;
        shared.system.cutover_sample = None;
    }
    // An attach that raced stop (or a failed transport) is refused, never
    // left queued; its capture closes on its own owner thread.
    while let Ok(command) = system_commands.try_recv() {
        refuse_system_command(
            command,
            "Session audio stopped before attaching system audio.",
        );
    }
    drop(system_commands);
    if let Some(producer) = producer {
        retired.push(producer.retire());
    }
    for completion in retired {
        if matches!(
            completion.closed.try_recv(),
            Ok(ProducerCompletion::Panicked)
        ) {
            tracing::warn!("Microphone owner terminated unexpectedly during close.");
        }
    }
    for completion in system_retired {
        if matches!(
            completion.closed.try_recv(),
            Ok(ProducerCompletion::Panicked)
        ) {
            tracing::warn!("System audio owner terminated unexpectedly during close.");
        }
    }
    result
}

fn cancel_drain_observation(observe: &mut Option<OutputObservation>) {
    if let Some(mut observation) = observe.take()
        && let Some(acknowledgement) = observation.acknowledgement.take()
    {
        let _ = acknowledgement.send(Err(anyhow::anyhow!(
            "Session audio is draining after Stop."
        )));
    }
}

fn retire_draining_sources(
    producer: &mut Option<ManagedProducer>,
    pending: &mut Option<PendingHandoff>,
    commands: &mpsc::Receiver<AudioSwitchCommand>,
    shared: &std::sync::Mutex<AudioShared>,
    retired: &mut Vec<CompletionTicket>,
) {
    let mut retire = |owner: ManagedProducer| {
        let id = owner.device_id.clone();
        let completion = owner.retire();
        shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retiring
            .push((id, completion.state.clone()));
        retired.push(completion);
    };
    if let Some(owner) = producer.take() {
        retire(owner);
    }
    let mut cancel = |mut command: AudioSwitchCommand| {
        if let Some(owner) = command.candidate.take() {
            retire(owner);
        }
        let _ = command.acknowledgement.send(Err(anyhow::anyhow!(
            "Session audio is draining after Stop."
        )));
    };
    if let Some(handoff) = pending.take() {
        cancel(handoff.command);
    }
    while let Ok(command) = commands.try_recv() {
        cancel(command);
    }
    shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .owner_present = false;
}

#[allow(clippy::too_many_arguments)]
fn run_bus_owned(
    producer: &mut Option<ManagedProducer>,
    path: &std::path::Path,
    video_epoch: Option<Arc<OnceLock<Instant>>>,
    commands: mpsc::Receiver<AudioSwitchCommand>,
    system_commands: &mpsc::Receiver<SystemCommand>,
    context: BusContext<'_>,
    retired: &mut Vec<CompletionTicket>,
    system_retired: &mut Vec<CompletionTicket>,
) -> io::Result<()> {
    let BusContext {
        settings,
        system_settings,
        stop,
        stop_requested_at,
        draining,
        source_stall_timeout,
        timing,
        shared,
        echo_guard,
    } = context;
    let playout_delay = timing.playout_delay;
    // Plan 069: the system slot, and the limiter that runs only while one is
    // attached (or still releasing after one left). With no slot ever
    // attached, every chunk takes the unchanged microphone-only write path.
    let mut system: Option<SourceSlot> = None;
    let mut limiter = PeakLimiter::default();
    let system_stats = shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .system_stats
        .clone();
    let mut receiver = producer
        .as_mut()
        .and_then(|producer| producer.receiver.take());
    let mut producer_stats = producer.as_ref().map(|producer| producer.stats.clone());
    let mut stats = shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .stats
        .clone();
    let mut file = crate::fifo::open_audio_writer(
        path,
        stop,
        Duration::from_millis(5),
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
            accept_system_commands(
                system_commands,
                &mut system,
                0,
                timing,
                stop,
                draining,
                shared,
            );
            if let Some(slot) = system.as_ref() {
                while slot.receiver.try_recv().is_ok() {}
            }
            thread::sleep(Duration::from_millis(2));
        },
        None => Instant::now(),
    };
    let totals = shared
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .totals
        .clone();
    totals.reset_recording_window();
    stats.reset_recording_window();
    system_stats.reset_recording_window();
    if receiver.is_none() {
        stats.mark_silent();
    }
    let mut timeline = AudioTimeline::new().with_delay_headroom(timing.microphone_delay_frames);
    timeline.select_generation(0);
    let mut generation = 0;
    let mut pending: Option<PendingHandoff> = None;
    let mut observe: Option<OutputObservation> = None;
    let mut activity = SourceActivity::new(Instant::now());
    let mut microphone_fault = TimelineFault::default();
    let mut stall = OutputStall::default();
    // Plan 076: the microphone's band envelope, and the system slot's while
    // one mixes, feed the loop detector.
    let mut echo = crate::echo_guard::EchoWatch::default();
    let mut echo_slot = false;
    let mut echo_logged = false;
    let mut clock = None;
    let mut accounted = AudioBusCounters::default();
    let mut diagnostics = BusDiagnostics::default();
    let mut previous_producer_drops = producer_stats
        .as_ref()
        .map_or(0, |stats| stats.dropped_frames());
    // Writes stop on this, not on `stop`: a stopping bus drains first.
    let write_stop = AtomicBool::new(false);
    let mut drain: Option<StopDrain> = None;
    loop {
        if stop.load(Ordering::Acquire) {
            let drain =
                drain.get_or_insert_with(|| StopDrain::at(stop_requested_at, epoch, playout_delay));
            if drain.done(timeline.cursor(), Instant::now()) {
                break;
            }
        }
        if draining.load(Ordering::Acquire) {
            // Silent drain: capture ends now, the timed pipe keeps writing
            // silence. The microphone retires on its list; a system slot
            // ramps out and retires on its own list at the chunk end, so a
            // closing system capture never blocks the microphone path. Stop
            // afterwards runs the bounded drain above over this silence.
            retire_draining_sources(producer, &mut pending, &commands, shared, retired);
            receiver = None;
            producer_stats = None;
            timeline.select_generation(generation);
            cancel_drain_observation(&mut observe);
            if let Some(slot) = system.as_mut()
                && slot.exit.is_none()
            {
                slot.begin_exit(SlotExit::Drained {
                    cutover_sample: timeline.cursor(),
                });
            }
        }
        accept_system_commands(
            system_commands,
            &mut system,
            timeline.cursor(),
            timing,
            stop,
            draining,
            shared,
        );
        if !draining.load(Ordering::Acquire)
            && pending.is_none()
            && let Ok(command) = commands.try_recv()
        {
            pending = Some(
                PendingHandoff::new(
                    command,
                    generation + 1,
                    timeline.cursor(),
                    epoch,
                    Instant::now(),
                )
                .with_delay(timing.microphone_delay_frames, playout_delay),
            );
        }
        if let Some(pending) = pending.as_mut() {
            pending.poll(epoch, Instant::now());
        }
        if let Some(stats) = producer_stats.as_ref() {
            let drops = stats.dropped_frames();
            let new_drops = drops.saturating_sub(previous_producer_drops);
            timeline.counters.dropped_frames += new_drops;
            timeline.losses.producer_queue_full += new_drops;
            previous_producer_drops = drops;
        }
        let placement = Placement {
            epoch,
            playout_delay,
            output_behind: stall.output_behind(Instant::now()),
        };
        let mut loss_reason = None;
        if let Some(receiver) = receiver.as_ref() {
            let disconnected = ingest_pending(
                receiver,
                &mut timeline,
                &mut clock,
                generation,
                placement,
                timing.microphone_delay_frames,
                &stats,
                &mut activity,
            );
            loss_reason = microphone_loss_reason(
                disconnected,
                activity.arrival.elapsed(),
                activity.live.elapsed(),
                source_stall_timeout,
            );
        }
        match loss_reason {
            Some(SourceLossReason::CaptureStopped) => {
                receiver = None;
                microphone_fault = TimelineFault::default();
                {
                    let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
                    shared.owner_present = false;
                    if let Some(old) = producer.take() {
                        let id = old.device_id.clone();
                        let completion = old.retire();
                        shared.retiring.push((id, completion.state.clone()));
                        retired.push(completion);
                    }
                    stats.mark_source_lost_at(Instant::now());
                }
                producer_stats = None;
                push_microphone_loss(shared, &stats, SourceLossReason::CaptureStopped, generation);
            }
            // Plan 076: buffers keep arriving but none place. The input is
            // healthy, so it stays open: reported once, re-anchored, and
            // reported again when it places.
            Some(SourceLossReason::TimelineRejected) => {
                let now = Instant::now();
                if microphone_fault.begin(now, activity.placed) {
                    stats.mark_source_lost_at(now);
                    tracing::warn!(
                        "Microphone buffers keep arriving but none could be placed for {}s; the input stays open.",
                        source_stall_timeout.as_secs_f32()
                    );
                    push_microphone_loss(
                        shared,
                        &stats,
                        SourceLossReason::TimelineRejected,
                        generation,
                    );
                }
                if microphone_fault.reanchor_due(now) {
                    // The next buffer maps from its capture time, as it did
                    // at session start.
                    clock = None;
                    tracing::warn!("Microphone timeline re-anchored.");
                }
            }
            None => {}
        }
        if let Some(gap) = microphone_fault.recovered(activity.placed) {
            stats.mark_recovered();
            let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
            let recovery = SourceRecovery {
                generation,
                device_name: shared.status.device_name.clone(),
                after_ms: (stats.recording_window_elapsed_secs().unwrap_or_default() * 1_000.0)
                    as u64,
                gap_ms: gap.as_millis() as u64,
            };
            tracing::info!(
                gap_ms = recovery.gap_ms,
                "Microphone audio is placed again; its timeline loss ended."
            );
            shared.recoveries.push_back(recovery);
        }
        if let Some(slot) = system.as_mut() {
            slot.account_producer_drops();
            slot.output_behind = placement.output_behind;
            // No stall rule here (decision 11): only the platform's failure
            // signal or the end of the stream retires a system source.
            let health = slot.ingest_health(epoch);
            handle_slot_health(slot, health, timeline.cursor(), shared);
        }
        if echo_slot != system.is_some() {
            echo_slot = system.is_some();
            echo_logged = false;
            echo.system_changed();
        }
        if let Some(found) = echo.take_detection()
            && let Some(slot) = system.as_mut()
            && slot.exit.is_none()
        {
            let cutover_sample = timeline.cursor();
            if echo_guard.load(Ordering::Acquire) {
                tracing::warn!(
                    lag_ms = found.lag_ms,
                    correlation = found.correlation,
                    "System audio carries the stream back into itself; pausing it."
                );
                slot.begin_exit(SlotExit::EchoPaused {
                    cutover_sample,
                    lag_ms: found.lag_ms,
                });
            } else if !echo_logged {
                echo_logged = true;
                tracing::warn!(
                    lag_ms = found.lag_ms,
                    "System audio carries the stream back into itself; the echo guard is off."
                );
            }
        }
        let now = Instant::now();
        let wall_cursor = wall_cursor_at(now, epoch, playout_delay);
        if let Some(report) = stall.observe(
            now,
            wall_cursor.saturating_sub(timeline.cursor()),
            bus_output_stall_losses(&timeline, system.as_ref()),
        ) {
            publish_output_stall(shared, report);
        }
        timeline.discard_before(wall_cursor.saturating_sub(MAX_BUFFERED_FRAMES));
        if let Some(slot) = system.as_mut() {
            slot.timeline
                .discard_before(wall_cursor.saturating_sub(MAX_BUFFERED_FRAMES));
        }
        let next = epoch
            + playout_delay
            + Duration::from_nanos(
                (timeline.cursor() + CHUNK_FRAMES as u64) * 1_000_000_000
                    / u64::from(NATIVE_AUDIO_SAMPLE_RATE),
            );
        let next = drain.map_or(next, |drain| next.min(drain.flush_at));
        if let Some(remaining) = next.checked_duration_since(Instant::now()) {
            thread::sleep(remaining.min(Duration::from_millis(2)));
            continue;
        }
        diagnostics.max_lateness = diagnostics
            .max_lateness
            .max(Instant::now().saturating_duration_since(next));
        let mut ramp_old = false;
        let mut ramp_in = false;
        if let Some(handoff) = pending.as_mut() {
            match handoff.action(
                timeline.cursor(),
                Instant::now(),
                stop.load(Ordering::Acquire) || draining.load(Ordering::Acquire),
            ) {
                HandoffAction::Continue => {}
                HandoffAction::RampOld => {
                    handoff.old_ramped_down = true;
                    ramp_old = true;
                }
                HandoffAction::Cancel => {
                    let mut handoff = pending.take().expect("pending handoff");
                    ramp_in = handoff.old_ramped_down;
                    if draining.load(Ordering::Acquire)
                        && let Some(owner) = handoff.command.candidate.take()
                    {
                        let id = owner.device_id.clone();
                        let completion = owner.retire();
                        shared
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .retiring
                            .push((id, completion.state.clone()));
                        retired.push(completion);
                    }
                    let _ = handoff.command.acknowledgement.send(Err(anyhow::anyhow!("The prepared microphone became unavailable or the source change was cancelled before cutover.")));
                }
                HandoffAction::Commit => {
                    let mut handoff = pending.take().expect("pending handoff");
                    let mut coordinator = handoff
                        .command
                        .coordinator
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    let validated = coordinator
                        .validate_commit(&handoff.command.request)
                        .and_then(|()| {
                            if matches!(handoff.command.purpose, HandoffPurpose::Restore { .. }) {
                                coordinator.validate_microphone_restoration(
                                    &handoff.command.request,
                                    handoff
                                        .command
                                        .candidate
                                        .as_ref()
                                        .map(|candidate| candidate.device_id.as_str()),
                                )
                            } else {
                                Ok(())
                            }
                        });
                    if let Err(error) = validated {
                        ramp_in = handoff.old_ramped_down;
                        let _ = handoff
                            .command
                            .acknowledgement
                            .send(Err(anyhow::anyhow!(error.message())));
                    } else {
                        let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
                        if draining.load(Ordering::Acquire) {
                            if let Some(owner) = handoff.command.candidate.take() {
                                let id = owner.device_id.clone();
                                let completion = owner.retire();
                                shared.retiring.push((id, completion.state.clone()));
                                retired.push(completion);
                            }
                            let _ = handoff.command.acknowledgement.send(Err(anyhow::anyhow!(
                                "Session audio is draining after Stop."
                            )));
                            continue;
                        }
                        // Selection, route and receipt share this linearization
                        // point with Stop. No write or native close under locks.
                        let previous_identity = (
                            shared.status.device_id.clone(),
                            shared.status.device_name.clone(),
                        );
                        generation = handoff.generation;
                        timeline.select_generation(generation);
                        timeline.counters.discarded_frames += handoff.pcm.counters.discarded_frames;
                        timeline.counters.dropped_frames += handoff.pcm.counters.dropped_frames;
                        timeline.losses.merge(handoff.pcm.losses);
                        timeline.packets = std::mem::take(&mut handoff.pcm.packets);
                        shared.retiring.retain(|(_, completion)| {
                            *completion.borrow() != ProducerCompletion::Closed
                        });
                        if let Some(old) = producer.take() {
                            let id = old.device_id.clone();
                            let completion = old.retire();
                            shared.retiring.push((id, completion.state.clone()));
                            retired.push(completion);
                        }
                        *producer = handoff.command.candidate.take();
                        receiver = producer
                            .as_mut()
                            .and_then(|producer| producer.receiver.take());
                        producer_stats = producer.as_ref().map(|producer| producer.stats.clone());
                        previous_producer_drops = producer_stats
                            .as_ref()
                            .map_or(0, |stats| stats.dropped_frames());
                        clock = handoff.clock.take();
                        activity = SourceActivity::new(Instant::now());
                        microphone_fault = TimelineFault::default();
                        stats = Arc::new(AudioCaptureStats::default());
                        stats.reset_recording_window();
                        if producer.is_none() {
                            stats.mark_silent();
                        } else {
                            stats.mark_live();
                        }
                        shared.stats = stats.clone();
                        if let Some(producer) = producer.as_ref() {
                            shared.ever_selected = true;
                            shared.last_selected_name = producer.device_name.clone();
                        }
                        shared.status.generation = generation;
                        shared.owner_present = producer.is_some();
                        shared.status.selected_input = producer.is_some();
                        shared.status.device_id =
                            producer.as_ref().map(|producer| producer.device_id.clone());
                        shared.status.device_name = producer.as_ref().map_or_else(
                            || "No microphone".into(),
                            |producer| producer.device_name.clone(),
                        );
                        #[cfg(debug_assertions)]
                        {
                            shared.caption_injector = producer
                                .as_ref()
                                .and_then(|producer| producer.caption_injector.clone());
                        }
                        let mut receipt = AudioCommitReceipt {
                            session_id: handoff.command.request.session_id.clone(),
                            request_id: handoff.command.request.request_id.clone(),
                            generation,
                            cutover_sample: timeline.cursor(),
                            device_id: shared.status.device_id.clone(),
                            output_observed: false,
                        };
                        match handoff.command.purpose {
                            HandoffPurpose::Release { closed } => {
                                shared.status.device_id = previous_identity.0;
                                shared.status.device_name = previous_identity.1;
                                stats.mark_source_lost_at(Instant::now());
                                let _ = stats.claim_source_loss_event();
                                coordinator.previous_unavailable(&handoff.command.request);
                                receipt.device_id = shared.status.device_id.clone();
                                observe = None;
                                let _ = closed.send(
                                    retired.iter().map(|ticket| ticket.state.clone()).collect(),
                                );
                                let _ = handoff.command.acknowledgement.send(Ok(receipt));
                            }
                            purpose => {
                                shared.status.last_commit = Some(receipt);
                                match purpose {
                                    HandoffPurpose::Commit => {
                                        coordinator
                                            .commit_microphone(&handoff.command.request)
                                            .expect("validated under same mutex");
                                    }
                                    HandoffPurpose::Restore { failure } => {
                                        coordinator
                                            .restore_microphone(
                                                &handoff.command.request,
                                                shared.status.device_id.as_deref(),
                                                failure,
                                            )
                                            .expect("validated restore under same mutex");
                                    }
                                    HandoffPurpose::Release { .. } => unreachable!(),
                                }
                                observe = Some(OutputObservation {
                                    request: handoff.command.request.clone(),
                                    coordinator: handoff.command.coordinator.clone(),
                                    acknowledgement: Some(handoff.command.acknowledgement),
                                });
                            }
                        }
                        ramp_in = true;
                    }
                }
            }
        }
        #[cfg(test)]
        if (ramp_old || ramp_in)
            && let Some((expected_generation, prepare_input)) = shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .cancellation_input
        {
            assert_eq!(
                timeline.generation, expected_generation,
                "cancellation must retain old timeline"
            );
            assert_eq!(
                producer.as_ref().map(|owner| owner.device_id.as_str()),
                Some("microphone:coreaudio:7"),
                "cancellation must retain old physical owner"
            );
            prepare_input(&mut timeline);
        }
        let start = timeline.cursor();
        let mut raw = timeline.render_with_provenance();
        if ramp_old {
            ramp_through_zero(&mut raw.samples, false);
        }
        if ramp_in {
            ramp_through_zero(&mut raw.samples, true);
        }
        let system_raw = system.as_mut().map(|slot| {
            debug_assert_eq!(slot.timeline.cursor(), start, "sources render in lockstep");
            slot.render()
        });
        let mixing = system_raw.is_some() || !limiter.idle();
        let write_started = Instant::now();
        let mut deferred_health = Vec::new();
        let mut wait = || {
            // A stop that arrives mid-write drains too, until its deadline.
            if stop.load(Ordering::Acquire)
                && StopDrain::at(stop_requested_at, epoch, playout_delay).done(0, Instant::now())
            {
                write_stop.store(true, Ordering::Release);
            }
            if draining.load(Ordering::Acquire) {
                retire_draining_sources(producer, &mut pending, &commands, shared, retired);
                receiver = None;
                producer_stats = None;
            }
            // The FIFO reader is behind. Keep ingesting so a bursty reader
            // never pushes the microphone into the timeline's drop path, and
            // keep the stall episode current (plan 076): a reader that stops
            // for seconds is the output's fault, not the sources'.
            let now = Instant::now();
            if let Some(report) = stall.observe(
                now,
                wall_cursor_at(now, epoch, playout_delay).saturating_sub(timeline.cursor()),
                bus_output_stall_losses(&timeline, system.as_ref()),
            ) {
                publish_output_stall(shared, report);
            }
            let placement = Placement {
                epoch,
                playout_delay,
                output_behind: stall.output_behind(now),
            };
            if let Some(receiver) = receiver.as_ref() {
                ingest_pending(
                    receiver,
                    &mut timeline,
                    &mut clock,
                    generation,
                    placement,
                    timing.microphone_delay_frames,
                    &stats,
                    &mut activity,
                );
            }
            if let Some(slot) = system.as_mut() {
                // A stop is sticky (failure slot or EOF): the next pacing
                // pass observes it again and ramps the slot out. The edges
                // of a timeline loss are kept for that pass.
                slot.output_behind = placement.output_behind;
                match slot.ingest_health(epoch) {
                    SlotHealth::Healthy | SlotHealth::Stopped(_) => {}
                    health => deferred_health.push(health),
                }
            }
            thread::sleep(Duration::from_millis(1));
        };
        let outcome = if mixing {
            let silence;
            let system_samples = match system_raw.as_ref() {
                Some(system_raw) => system_raw.samples.as_slice(),
                None => {
                    silence = vec![0.0; raw.samples.len()];
                    silence.as_slice()
                }
            };
            write_mixed_chunk_with_clock(
                &mut file,
                &raw.samples,
                settings,
                system_samples,
                system_settings,
                limiter,
                &write_stop,
                draining,
                Instant::now,
                &mut wait,
            )
            .map(ChunkOutcome::Mixed)
        } else {
            write_chunk_with_clock(
                &mut file,
                &raw.samples,
                settings,
                &write_stop,
                draining,
                Instant::now,
                &mut wait,
            )
            .map(ChunkOutcome::Microphone)
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                log_bus_summary(&timeline, &diagnostics, &format!("ended ({error})"));
                return Err(error);
            }
        };
        // The microphone tap (captions, Orcle voice activity, the mic meter)
        // is the processed microphone chunk as written, before any sum
        // (decision 5). Without a system slot it is the written chunk itself.
        let (stale_from, microphone_samples, mixed) = match outcome {
            ChunkOutcome::Microphone(written) => (written.stale_from, written.samples, None),
            ChunkOutcome::Mixed(mixed) => {
                limiter = mixed.limiter;
                (
                    mixed.written.stale_from,
                    mixed.microphone,
                    Some((mixed.system, mixed.clipped_samples)),
                )
            }
        };
        diagnostics.max_write_stall = diagnostics.max_write_stall.max(write_started.elapsed());
        if let Some(slot) = system.as_mut() {
            let cursor = timeline.cursor();
            for health in deferred_health {
                handle_slot_health(slot, health, cursor, shared);
            }
        }
        timeline.account_stale_chunk(&raw, stale_from);
        if let Some(from) = stale_from {
            timeline.losses.stale_written += (CHUNK_FRAMES - from) as u64;
        }
        #[cfg(test)]
        if ramp_old {
            let observer = shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .after_ramp
                .clone();
            if let Some(observer) = observer {
                observer(start);
            }
        }
        if !draining.load(Ordering::Acquire) {
            let mixing_system = system.as_ref().is_some_and(|slot| slot.exit.is_none());
            echo.chunk(
                &microphone_samples,
                mixed
                    .as_ref()
                    .filter(|_| mixing_system)
                    .map(|(system, _)| system.as_slice()),
            );
        }
        let frame = AudioFrame {
            timestamp_micros: start * 1_000_000 / u64::from(NATIVE_AUDIO_SAMPLE_RATE),
            captured_at: epoch
                + Duration::from_nanos(start * 1_000_000_000 / u64::from(NATIVE_AUDIO_SAMPLE_RATE)),
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples: microphone_samples,
        };
        stats.record_live_peak(
            frame
                .samples
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs())),
        );
        totals.record_live_peak(
            frame
                .samples
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs())),
        );
        // A draining bus writes silence after capture ended: no caption tap.
        if !draining.load(Ordering::Acquire) {
            crate::captions::offer_caption_frame(&frame);
            #[cfg(test)]
            {
                let observer = shared
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .caption_observer
                    .clone();
                if let Some(observer) = observer {
                    observer(&frame);
                }
            }
        }
        if let (Some((system_samples, _)), Some(slot), Some(system_raw)) =
            (mixed.as_ref(), system.as_mut(), system_raw.as_ref())
        {
            slot.timeline.account_stale_chunk(system_raw, stale_from);
            if let Some(from) = stale_from {
                slot.timeline.losses.stale_written += (CHUNK_FRAMES - from) as u64;
            }
            system_stats.record_live_peak(
                system_samples
                    .iter()
                    .fold(0.0_f32, |peak, sample| peak.max(sample.abs())),
            );
            let after = slot.timeline.counters();
            system_stats
                .record_captured_frames(after.captured_frames - slot.accounted.captured_frames);
            system_stats
                .record_generated_frames(after.generated_frames - slot.accounted.generated_frames);
            system_stats
                .record_dropped_frames(after.dropped_frames - slot.accounted.dropped_frames);
            slot.accounted = after;
        }
        let after = timeline.counters();
        stats.record_captured_frames(after.captured_frames - accounted.captured_frames);
        stats.record_generated_frames(after.generated_frames - accounted.generated_frames);
        stats.record_dropped_frames(after.dropped_frames - accounted.dropped_frames);
        totals.record_captured_frames(after.captured_frames - accounted.captured_frames);
        totals.record_generated_frames(after.generated_frames - accounted.generated_frames);
        totals.record_dropped_frames(after.dropped_frames - accounted.dropped_frames);
        accounted = after;
        {
            let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
            shared.status.sample_cursor = timeline.cursor();
            shared.status.counters = after;
            if let Some((_, clipped)) = mixed.as_ref() {
                shared.mix_clipped_samples += clipped;
            }
        }
        if draining.load(Ordering::Acquire) {
            cancel_drain_observation(&mut observe);
        }
        if let Some(OutputObservation {
            request,
            coordinator,
            acknowledgement,
        }) = observe.as_mut()
        {
            let mut coordinator = coordinator.lock().unwrap_or_else(|p| p.into_inner());
            let mut shared = shared.lock().unwrap_or_else(|p| p.into_inner());
            if draining.load(Ordering::Acquire) {
                if let Some(acknowledgement) = acknowledgement.take() {
                    let _ = acknowledgement.send(Err(anyhow::anyhow!(
                        "Session audio is draining after Stop."
                    )));
                }
                continue;
            }
            if let Some(receipt) = shared.status.last_commit.as_mut() {
                receipt.output_observed |= stale_from.is_none()
                    && (request.device_id.is_none()
                        || raw.captured.iter().all(|captured| *captured));
                if receipt.output_observed {
                    coordinator.observe_output(&request.session_id, &request.request_id);
                }
                if let Some(acknowledgement) = acknowledgement.take() {
                    let _ = acknowledgement.send(Ok(receipt.clone()));
                }
            }
        }
        if system.as_ref().is_some_and(|slot| slot.ramp.closed()) {
            let slot = system.take().expect("closed system slot");
            retire_system_slot(slot, shared, &system_stats, system_retired, &diagnostics);
        }
        retired.retain(CompletionTicket::running);
        system_retired.retain(CompletionTicket::running);
    }
    if let Some(report) = stall.finish(
        Instant::now(),
        bus_output_stall_losses(&timeline, system.as_ref()),
    ) {
        publish_output_stall(shared, report);
    }
    if let Some(slot) = system.take() {
        retire_system_slot(slot, shared, &system_stats, system_retired, &diagnostics);
    }
    log_bus_summary(&timeline, &diagnostics, "stopped");

    Ok(())
}

enum ChunkOutcome {
    Microphone(WrittenChunk),
    Mixed(MixedWrite),
}

struct WrittenChunk {
    samples: Vec<f32>,
    stale_from: Option<usize>,
    /// The frame from which a silent drain replaced the chunk with zeros.
    /// Intentional stop silence, never stale capture.
    silent_from: Option<usize>,
}

/// The microphone-only write path, byte for byte the pre-mixer writer.
fn write_chunk_with_clock(
    file: &mut impl Write,
    raw: &[f32],
    settings: &AudioProcessingSettingsHandle,
    stop: &AtomicBool,
    draining: &AtomicBool,
    now: impl FnMut() -> Instant,
    wait: impl FnMut(),
) -> io::Result<WrittenChunk> {
    write_rendered_chunk(
        file,
        raw.len(),
        |_| process_interleaved_f32(raw, 2, settings.load()),
        stop,
        draining,
        now,
        wait,
    )
}

struct MixedWrite {
    written: WrittenChunk,
    /// The processed microphone as written (zero where the chunk went stale).
    microphone: Vec<f32>,
    /// The gained system contribution as written.
    system: Vec<f32>,
    clipped_samples: u64,
    limiter: PeakLimiter,
}

/// The mixed write path. Controls are re-read before every write attempt, as
/// on the microphone path; each attempt re-mixes the whole chunk from the
/// limiter state at the chunk start, and only the unwritten suffix changes.
#[allow(clippy::too_many_arguments)]
fn write_mixed_chunk_with_clock(
    file: &mut impl Write,
    microphone_raw: &[f32],
    microphone_settings: &AudioProcessingSettingsHandle,
    system_raw: &[f32],
    system_settings: &AudioProcessingSettingsHandle,
    limiter: PeakLimiter,
    stop: &AtomicBool,
    draining: &AtomicBool,
    now: impl FnMut() -> Instant,
    wait: impl FnMut(),
) -> io::Result<MixedWrite> {
    let length = microphone_raw.len();
    let mut microphone = vec![0.0; length];
    let mut system = vec![0.0; length];
    let mut clipped = vec![false; length];
    let mut limiter_after = limiter;
    let written = write_rendered_chunk(
        file,
        length,
        |from| {
            let mixed = mix_chunk(
                microphone_raw,
                microphone_settings.load(),
                system_raw,
                system_settings.load(),
                limiter,
            );
            microphone[from..].copy_from_slice(&mixed.microphone[from..]);
            system[from..].copy_from_slice(&mixed.system[from..]);
            clipped[from..].copy_from_slice(&mixed.clipped[from..]);
            limiter_after = mixed.limiter;
            mixed.output
        },
        stop,
        draining,
        now,
        wait,
    )?;
    // What was not written as rendered was written as zeros: a stale suffix,
    // or the silence of a drain that began mid-chunk.
    if let Some(from) = match (written.stale_from, written.silent_from) {
        (Some(stale), Some(silent)) => Some(stale.min(silent)),
        (stale, silent) => stale.or(silent),
    } {
        microphone[from * 2..].fill(0.0);
        system[from * 2..].fill(0.0);
        clipped[from * 2..].fill(false);
    }
    Ok(MixedWrite {
        written,
        microphone,
        system,
        clipped_samples: clipped.iter().filter(|clipped| **clipped).count() as u64,
        limiter: limiter_after,
    })
}

/// Writes one chunk of `samples` f32 values. `render(from)` produces the
/// processed chunk from the current controls before each attempt; only the
/// values from sample index `from` (always a whole stereo frame) are used.
fn write_rendered_chunk(
    file: &mut impl Write,
    samples: usize,
    mut render: impl FnMut(usize) -> Vec<f32>,
    stop: &AtomicBool,
    draining: &AtomicBool,
    mut now: impl FnMut() -> Instant,
    mut wait: impl FnMut(),
) -> io::Result<WrittenChunk> {
    let started = now();
    let deadline = started + WRITE_DEADLINE;
    let mut bytes = vec![0; samples * 4];
    let mut written = 0;
    let mut stale_from = None;
    let mut silent_from = None;
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
        if draining.load(Ordering::Acquire) {
            bytes[replace_from..].fill(0);
            silent_from.get_or_insert(replace_from / 8);
        } else if clock.duration_since(started) >= Duration::from_millis(100) {
            bytes[replace_from..].fill(0);
            stale_from.get_or_insert(replace_from / 8);
        } else {
            let processed = render(replace_from / 4);
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
        silent_from,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn arriving_microphone_frames_rejected_by_timeline_are_not_callback_loss() {
        let now = Instant::now();
        let old = now - Duration::from_secs(3);
        let (sender, receiver) = mpsc::channel();
        sender
            .send(AudioFrame {
                timestamp_micros: 1,
                captured_at: now,
                sample_rate: 48000,
                channels: 2,
                samples: vec![0.25; 960],
            })
            .unwrap();
        let mut timeline = AudioTimeline::new();
        let mut clock = None;
        let stats = AudioCaptureStats::default();
        let mut activity = SourceActivity {
            arrival: old,
            live: old,
            placed: old,
        };
        // A bus that never kept pace (plan 070's old epoch): the refusal is
        // the timeline's, never excused as a stalled output.
        assert!(!ingest_pending(
            &receiver,
            &mut timeline,
            &mut clock,
            0,
            Placement {
                epoch: now - Duration::from_secs(9),
                playout_delay: PLAYOUT_DELAY,
                output_behind: false,
            },
            0,
            &stats,
            &mut activity,
        ));
        assert_eq!(timeline.losses().dropped_ahead_of_cap, 480);
        assert_eq!(timeline.losses().dropped_output_behind, 0);
        assert_eq!(activity.placed, old);
        assert_eq!(activity.live, old);
        assert!(activity.arrival >= now);
        assert_eq!(
            microphone_loss_reason(
                false,
                Duration::ZERO,
                Duration::from_secs(3),
                Duration::from_secs(2)
            ),
            Some(SourceLossReason::TimelineRejected)
        );
        assert_eq!(
            microphone_loss_reason(true, Duration::ZERO, Duration::ZERO, Duration::from_secs(2)),
            Some(SourceLossReason::CaptureStopped)
        );
        assert_eq!(
            microphone_loss_reason(
                false,
                Duration::from_secs(3),
                Duration::from_secs(3),
                Duration::from_secs(2)
            ),
            Some(SourceLossReason::CaptureStopped)
        );
        assert_eq!(
            microphone_loss_reason(
                false,
                Duration::ZERO,
                Duration::ZERO,
                Duration::from_secs(2)
            ),
            None
        );
    }

    #[test]
    fn incident_worker_failure_requires_debug_build_and_both_opt_ins() {
        assert!(!super::incident_worker_open_failure_enabled(
            false,
            Some("1"),
            Some("1")
        ));
        assert!(!super::incident_worker_open_failure_enabled(
            true,
            None,
            Some("1")
        ));
        assert!(!super::incident_worker_open_failure_enabled(
            true,
            Some("1"),
            None
        ));
        assert!(super::incident_worker_open_failure_enabled(
            true,
            Some("1"),
            Some("1")
        ));
    }

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
        assert!(!timeline.push(0, MAX_BUFFERED_FRAMES, frame(1.0, 480)));
        assert_eq!(timeline.losses().dropped_ahead_of_cap, 480);
        assert_eq!(timeline.render_chunk(), vec![0.2; 960]);
        let next = timeline.render_chunk();
        assert_eq!(&next[..480], &[0.8; 480]);
        assert_eq!(&next[480..], &[0.0; 480]);
        assert_eq!(timeline.counters().discarded_frames, 240);
    }

    #[test]
    fn buffering_is_sized_in_time_so_small_callbacks_get_the_same_headroom() {
        // 128-frame CoreAudio callbacks (Shure MV7+) arriving 800 ms ahead of a
        // stalled cursor used to hit a 32-packet ceiling after about 85 ms.
        let mut timeline = AudioTimeline::new();
        let packets = 300_u64;
        for index in 0..packets {
            assert!(
                timeline.push(0, index * 128, frame(0.5, 128)),
                "packet {index} was refused"
            );
        }
        assert!(
            timeline.packets.len() <= 10,
            "contiguous packets coalesce: {}",
            timeline.packets.len()
        );
        assert_eq!(timeline.counters().dropped_frames, 0);
        let total = packets * 128;
        let mut fully_captured_chunks = 0;
        while timeline.cursor() < total {
            let chunk = timeline.render_with_provenance();
            if chunk.captured.iter().all(|captured| *captured) {
                fully_captured_chunks += 1;
            }
        }
        assert_eq!(
            fully_captured_chunks,
            (total / CHUNK_FRAMES as u64) as usize
        );
        assert_eq!(timeline.counters().captured_frames, total);
        assert_eq!(timeline.counters().generated_frames, 0);
        assert_eq!(timeline.losses(), BusLosses::default());
        // The ceiling is still a ceiling, in time: one second ahead is refused.
        let cursor = timeline.cursor();
        assert!(!timeline.push(0, cursor + MAX_BUFFERED_FRAMES, frame(0.5, 128)));
        assert_eq!(timeline.losses().dropped_ahead_of_cap, 128);
        assert_eq!(timeline.counters().dropped_frames, 128);
    }

    #[test]
    fn a_frame_is_stale_only_past_the_producer_channel_depth() {
        let now = Instant::now();
        let mut fresh = frame(0.5, 128);
        fresh.captured_at = now - Duration::from_millis(900);
        assert!(valid_fresh_frame(&fresh, now));
        let mut stale = frame(0.5, 128);
        stale.captured_at = now - MAX_FRAME_AGE - Duration::from_millis(1);
        assert!(!valid_fresh_frame(&stale, now));
    }

    #[tokio::test]
    async fn a_bursty_fifo_reader_never_drops_small_microphone_callbacks() {
        use std::io::Read;
        // FFmpeg with a starved demux queue drains the 64 KiB Darwin pipe in
        // gulps. 230 ms of reader silence exceeds the pipe at 48 kHz stereo
        // f32, so the writer blocks for tens of milliseconds each cycle. With
        // 128-frame callbacks that used to overflow the packet ceiling.
        let path =
            crate::audio::native_audio_fifo_path(&format!("bursty-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let reader_path = path.clone();
        let reader = thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).unwrap();
            let mut buffer = vec![0_u8; 256 * 1024];
            let mut total = 0_usize;
            let started = Instant::now();
            loop {
                thread::sleep(Duration::from_millis(230));
                // Real time on average: after each stall, catch up to the
                // byte budget the wall clock implies, then stall again.
                let budget = started.elapsed().as_secs_f64() * 48_000.0 * 8.0;
                while (total as f64) < budget {
                    match file.read(&mut buffer) {
                        Ok(0) => return total,
                        Ok(count) => total += count,
                        Err(error) => panic!("{error}"),
                    }
                }
            }
        });
        let count = Arc::new(AtomicU64::new(0));
        let producer = paced_test_producer_with_packet(
            "microphone:coreaudio:7",
            0.5,
            count.clone(),
            None,
            128,
        )
        .await;
        let session = attach_prepared(
            Some(InitialAudioSource {
                source: InitialInput::Owned { producer, count },
            }),
            path,
            None,
            AudioProcessingSettings::default(),
            Duration::from_secs(1),
        );
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let status = session.status();
        session.request_stop();
        drop(session);
        let bytes = reader.join().unwrap();
        assert!(bytes > 0);
        assert_eq!(status.counters.dropped_frames, 0, "{:?}", status.counters);
        // At most 200 ms of the whole take may be anything but captured speech
        // (the playout delay before the first packet lands, plus jitter).
        assert!(
            status.counters.captured_frames + 9_600 >= status.sample_cursor,
            "{:?}",
            status.counters
        );
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
    #[cfg(debug_assertions)]
    fn debug_fixture_late_wakes_preserve_pcm_through_the_real_source_clock_and_timeline() {
        let epoch = Instant::now();
        let mut fixture =
            crate::audio::fixture_clock::FixtureAudioClock::new(epoch + Duration::from_millis(20));
        let mut source_clock = None;
        let mut timeline = AudioTimeline::new();
        for tick in 0..1_000_u64 {
            let now = epoch + Duration::from_millis(tick * 10);
            // Three missed scheduling slots every 200ms, within playout's
            // existing 50ms allowance. No sleeps or hardware are involved.
            if tick % 20 >= 3 || tick < 20 {
                while fixture.deadline() <= now {
                    let timing = fixture.next_packet(now);
                    let mut packet = frame(0.25, 960);
                    packet.timestamp_micros = timing.frame_cursor * 1_000_000 / 48_000;
                    packet.captured_at = timing.captured_at;
                    let clock =
                        source_clock.get_or_insert_with(|| SourceClock::new(&packet, epoch));
                    let (start, count) = clock.interval(&packet).unwrap();
                    timeline.push(0, start, resample_frame(packet, count));
                }
            }
            if tick >= 6 {
                timeline.render_chunk();
            }
        }
        assert_eq!(timeline.counters().generated_frames, 0);
        assert_eq!(timeline.losses().discarded_overlap, 0);
        assert_eq!(timeline.counters().captured_frames, 994 * 480);
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
            &AtomicBool::new(false),
            || now.get(),
            || stop.store(true, Ordering::Release),
        );
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::Interrupted);
        assert!(writer.bytes.is_empty());
    }

    #[test]
    fn silent_drain_overrides_late_unmute_and_preserves_partial_pcm_frame() {
        struct Partial<'a> {
            bytes: Vec<u8>,
            draining: &'a AtomicBool,
            settings: &'a AudioProcessingSettingsHandle,
        }
        impl Write for Partial<'_> {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let count = if self.bytes.is_empty() {
                    3
                } else {
                    bytes.len()
                };
                self.bytes.extend_from_slice(&bytes[..count]);
                self.draining.store(true, Ordering::Release);
                self.settings.update(AudioProcessingSettings {
                    gain_db: 24.0,
                    muted: false,
                });
                Ok(count)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let draining = AtomicBool::new(false);
        let settings = AudioProcessingSettingsHandle::new(AudioProcessingSettings::default());
        let mut writer = Partial {
            bytes: Vec::new(),
            draining: &draining,
            settings: &settings,
        };
        let now = Instant::now();
        let written = write_chunk_with_clock(
            &mut writer,
            &[0.25; 960],
            &settings,
            &AtomicBool::new(false),
            &draining,
            || now,
            || {},
        )
        .unwrap();
        assert_eq!(&written.samples[..2], &[0.25, 0.25]);
        assert!(written.samples[2..].iter().all(|sample| *sample == 0.0));
        assert_eq!(
            written.stale_from, None,
            "intentional stop silence is not stale capture"
        );
        let mut next = Vec::new();
        let written = write_chunk_with_clock(
            &mut next,
            &[0.75; 960],
            &settings,
            &AtomicBool::new(false),
            &draining,
            || now,
            || {},
        )
        .unwrap();
        assert!(written.samples.iter().all(|sample| *sample == 0.0));
    }

    #[tokio::test]
    async fn silent_drain_cancels_pending_output_observation() {
        let request = source_request("drain-observe", Some("microphone:coreaudio:7"));
        let coordinator = source_coordinator(&request);
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        let mut observe = Some(OutputObservation {
            request,
            coordinator,
            acknowledgement: Some(acknowledgement),
        });
        cancel_drain_observation(&mut observe);
        assert!(observe.is_none());
        assert!(
            receipt
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("draining")
        );
    }

    #[tokio::test]
    async fn silent_drain_real_bus_retires_capture_freezes_stats_and_cleans_each_exit() {
        use std::io::Read;
        let mut previous: Option<AudioSwitchHandle> = None;
        for exit in [
            "normal-stop",
            "unexpected-reader-exit",
            "forced-reader-exit",
            "pending-switch-drain",
        ] {
            let path = crate::audio::native_audio_fifo_path(&format!(
                "drain-bus-{}",
                uuid::Uuid::new_v4()
            ));
            crate::audio::create_native_audio_fifo(&path).unwrap();
            let reader_path = path.clone();
            let close_reader = Arc::new(AtomicBool::new(false));
            let reader_close = close_reader.clone();
            let (chunks, mut received) = tokio::sync::mpsc::unbounded_channel();
            let (reader_finished, finished) = mpsc::sync_channel(1);
            let reader = thread::spawn(move || {
                let result = (|| -> io::Result<()> {
                    let mut file = std::fs::File::open(reader_path)?;
                    let mut cursor = 0_u64;
                    while !reader_close.load(Ordering::Acquire) {
                        let mut bytes = [0_u8; CHUNK_FRAMES * 8];
                        match file.read_exact(&mut bytes) {
                            Ok(()) => {}
                            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                            Err(error) => return Err(error),
                        }
                        let samples: Vec<_> = bytes
                            .chunks_exact(4)
                            .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
                            .collect();
                        cursor += CHUNK_FRAMES as u64;
                        let _ = chunks.send((cursor, samples));
                    }
                    Ok(())
                })();
                let _ = reader_finished.send(result);
            });
            let count = Arc::new(AtomicU64::new(0));
            let producer =
                paced_test_producer("microphone:coreaudio:7", 0.5, count.clone(), None).await;
            let session = attach_prepared(
                Some(InitialAudioSource {
                    source: InitialInput::Owned {
                        producer,
                        count: count.clone(),
                    },
                }),
                path,
                None,
                AudioProcessingSettings::default(),
                Duration::from_secs(1),
            );
            if let Some(old) = previous.take() {
                old.draining.store(true, Ordering::Release);
                old.stop.store(true, Ordering::Release);
            }
            let verified = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let (_, samples) = received
                        .recv()
                        .await
                        .ok_or_else(|| anyhow::anyhow!("Reader ended before captured PCM"))?;
                    if samples.iter().all(|sample| *sample > 0.1) {
                        break;
                    }
                }
                anyhow::ensure!(
                    !session.handle.draining.load(Ordering::Acquire),
                    "retired session affected replacement"
                );
                if exit != "unexpected-reader-exit" {
                    if exit == "pending-switch-drain" {
                        let old_stats = session.stats();
                        let handle = session.switch_handle();
                        session.handle.shared.lock().unwrap().after_ramp =
                            Some(Arc::new(move |_| {
                                handle.request_silent_drain();
                            }));
                        let mut coordinator =
                            crate::live_source_switch::SourceSwitchCoordinator::default();
                        coordinator.start(
                            "test-session".into(),
                            crate::protocol::SourceSelection {
                                microphone_id: Some("microphone:coreaudio:7".into()),
                                screen_id: None,
                                window_id: None,
                                camera_id: None,
                                test_pattern: false,
                            },
                        );
                        coordinator.enable_microphone();
                        let coordinator = Arc::new(std::sync::Mutex::new(coordinator));
                        let result = send_test_switch(
                            &session,
                            &coordinator,
                            "pending-drain",
                            Some("microphone:coreaudio:8"),
                            0.8,
                            false,
                            None,
                        )
                        .await
                        .0;
                        anyhow::ensure!(result.is_err(), "prepared source committed after drain");
                        anyhow::ensure!(session.handle.draining.load(Ordering::Acquire));
                        anyhow::ensure!(
                            Arc::ptr_eq(&old_stats, &session.stats()),
                            "drain replaced frozen stats"
                        );
                        anyhow::ensure!(
                            session.status().device_id.as_deref() == Some("microphone:coreaudio:7")
                        );
                        session.handle.shared.lock().unwrap().after_ramp = None;
                    } else {
                        anyhow::ensure!(session.request_silent_drain());
                    }
                    anyhow::ensure!(!session.request_silent_drain(), "drain must be idempotent");
                    let cutoff = session.status().sample_cursor + 2 * CHUNK_FRAMES as u64;
                    let captured = session.stats().captured_frames();
                    let elapsed = session.stats().recording_window_elapsed_secs();
                    session.update_processing_settings(AudioProcessingSettings {
                        gain_db: 24.0,
                        muted: false,
                    });
                    let mut silent_chunks = 0;
                    while silent_chunks < 5 {
                        let (end, samples) = received
                            .recv()
                            .await
                            .ok_or_else(|| anyhow::anyhow!("Drain closed PCM before owner exit"))?;
                        if end > cutoff {
                            anyhow::ensure!(
                                samples.iter().all(|sample| *sample == 0.0),
                                "Stop released captured speech"
                            );
                            silent_chunks += 1;
                        }
                    }
                    anyhow::ensure!(session.stats().captured_frames() == captured);
                    anyhow::ensure!(session.stats().recording_window_elapsed_secs() == elapsed);
                    if exit == "pending-switch-drain" {
                        let shared = session.handle.shared.lock().unwrap();
                        for id in ["microphone:coreaudio:7", "microphone:coreaudio:8"] {
                            anyhow::ensure!(
                                shared
                                    .retiring
                                    .iter()
                                    .any(|(retired_id, _)| retired_id == id),
                                "Drain discarded the completion receipt for {id}"
                            );
                        }
                    }
                    let retired: Vec<_> = session
                        .handle
                        .shared
                        .lock()
                        .unwrap()
                        .retiring
                        .iter()
                        .map(|(_, state)| state.clone())
                        .collect();
                    anyhow::ensure!(!retired.is_empty(), "Capture was not retired");
                    for mut state in retired {
                        while *state.borrow() == ProducerCompletion::Running {
                            state.changed().await?;
                        }
                        anyhow::ensure!(*state.borrow() == ProducerCompletion::Closed);
                    }
                    anyhow::ensure!(
                        count.load(Ordering::Acquire) == 0,
                        "Capture owner survived drain"
                    );
                }
                Ok::<_, anyhow::Error>(())
            })
            .await;
            session.handle.shared.lock().unwrap().after_ramp = None;
            previous = Some(session.switch_handle());
            let reader_result = if exit != "normal-stop" {
                close_reader.store(true, Ordering::Release);
                Some(finished.recv_timeout(Duration::from_secs(2)))
            } else {
                None
            };
            // Both explicit Stop and unsolicited/forced reader exit retain one
            // final owner. Always clean it before asserting diagnostic failures.
            drop(session);
            let reader_result =
                reader_result.unwrap_or_else(|| finished.recv_timeout(Duration::from_secs(2)));
            if reader_result.is_ok() {
                reader.join().unwrap();
            }
            reader_result.expect("Owned reader did not finish").unwrap();
            verified.expect("Drain readiness/cleanup deadline").unwrap();
            assert_eq!(count.load(Ordering::Acquire), 0);
        }
    }

    #[tokio::test]
    async fn silent_drain_failed_start_drop_retires_source_without_a_reader() {
        let path = crate::audio::native_audio_fifo_path(&format!(
            "drain-unopened-{}",
            uuid::Uuid::new_v4()
        ));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let count = Arc::new(AtomicU64::new(0));
        let producer =
            paced_test_producer("microphone:coreaudio:7", 0.5, count.clone(), None).await;
        let mut closed = producer.completion.as_ref().unwrap().state.clone();
        let session = attach_prepared(
            Some(InitialAudioSource {
                source: InitialInput::Owned {
                    producer,
                    count: count.clone(),
                },
            }),
            path,
            None,
            AudioProcessingSettings::default(),
            Duration::from_secs(1),
        );
        drop(session);
        tokio::time::timeout(Duration::from_secs(2), async {
            while *closed.borrow() == ProducerCompletion::Running {
                closed.changed().await.unwrap();
            }
        })
        .await
        .expect("Failed start retained microphone owner");
        assert_eq!(*closed.borrow(), ProducerCompletion::Closed);
        assert_eq!(count.load(Ordering::Acquire), 0);
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
    fn source_request(
        id: &str,
        device_id: Option<&str>,
    ) -> crate::live_source_switch::SourceSwitchParams {
        crate::live_source_switch::SourceSwitchParams {
            session_id: "test-session".into(),
            request_id: id.into(),
            expected_source_revision: 0,
            kind: crate::live_source_switch::SourceKind::Microphone,
            device_id: device_id.map(str::to_string),
            protected_overlay_window_ids: vec![],
        }
    }

    fn source_coordinator(
        request: &crate::live_source_switch::SourceSwitchParams,
    ) -> Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>> {
        let mut coordinator = crate::live_source_switch::SourceSwitchCoordinator::default();
        coordinator.start(
            request.session_id.clone(),
            crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        coordinator.enable_microphone();
        coordinator.admit(request).unwrap();
        Arc::new(std::sync::Mutex::new(coordinator))
    }

    fn handoff(
        epoch: Instant,
        cursor: u64,
        now: Instant,
    ) -> (PendingHandoff, mpsc::Sender<AudioFrame>) {
        let (sender, receiver) = mpsc::channel();
        let (completion_guard, completion) = completion_channel();
        drop(completion_guard);
        let candidate = ManagedProducer {
            device_id: "microphone:coreaudio:7".into(),
            device_name: "Target".into(),
            receiver: Some(receiver),
            stats: Arc::new(AudioCaptureStats::default()),
            stop: None,
            completion: Some(completion),
            #[cfg(debug_assertions)]
            caption_injector: None,
        };
        let request = source_request("switch", Some("microphone:coreaudio:7"));
        let coordinator = source_coordinator(&request);
        let cancelled = coordinator.lock().unwrap().cancellation(&request).unwrap();
        let (acknowledgement, _) = tokio::sync::oneshot::channel();
        let command = AudioSwitchCommand {
            purpose: HandoffPurpose::Commit,
            request,
            coordinator,
            cancelled,
            candidate: Some(candidate),
            admitted_at: now,
            acknowledgement,
        };
        (PendingHandoff::new(command, 1, cursor, epoch, now), sender)
    }

    #[test]
    fn handoff_requires_complete_boundary_coverage_and_an_old_source_ramp() {
        let epoch = Instant::now();
        let now = epoch + Duration::from_millis(20);
        let (mut handoff, _sender) = handoff(epoch, 480, now);
        assert_eq!(handoff.cutover, 960);
        handoff.pcm.push(1, 960, frame(0.8, 1));
        assert!(!handoff.ready(), "one sample is not a healthy next chunk");
        assert_eq!(handoff.action(480, now, false), HandoffAction::Continue);
        assert_eq!(
            handoff.cutover, 1440,
            "late preparation must defer the ramp and boundary together"
        );
        handoff.pcm.push(1, 1440, frame(0.8, 480));
        assert_eq!(handoff.action(960, now, false), HandoffAction::RampOld);
        assert_eq!(
            handoff.action(1440, now, false),
            HandoffAction::Cancel,
            "no commit without an acknowledged old envelope"
        );
        handoff.old_ramped_down = true;
        assert_eq!(handoff.action(1440, now, false), HandoffAction::Commit);
        handoff.command.cancelled.store(true, Ordering::Release);
        assert_eq!(handoff.action(1440, now, false), HandoffAction::Cancel);
        assert!(
            handoff.old_ramped_down,
            "cancellation must restore the old envelope"
        );
    }

    #[test]
    fn handoff_variable_blocks_trim_preparation_and_reject_discontinuous_coverage() {
        let epoch = Instant::now();
        let now = epoch + Duration::from_millis(20);
        let (mut handoff, sender) = handoff(epoch, 480, now);
        let mut first = frame(-0.8, 300);
        first.timestamp_micros = 15_000;
        first.captured_at = epoch + Duration::from_nanos(1_020 * 1_000_000_000 / 48_000);
        sender.send(first).unwrap();
        let mut second = frame(0.7, 500);
        second.timestamp_micros = 21_250;
        second.captured_at = epoch + Duration::from_nanos(1_520 * 1_000_000_000 / 48_000);
        sender.send(second).unwrap();
        handoff.poll(epoch, epoch + Duration::from_millis(35));
        assert!(handoff.ready());
        assert_eq!(handoff.pcm.counters.discarded_frames, 240);
        assert!(handoff.pcm.packets.iter().all(|packet| packet.start >= 960));
        let chunk = handoff.pcm.render_chunk();
        assert_eq!(&chunk[..120], &vec![-0.8; 120]);
        assert_eq!(&chunk[120..], &vec![0.7; 840]);
        let mut timeline = AudioTimeline::new();
        timeline.push(0, 0, frame(0.1, 200));
        timeline.push(0, 201, frame(0.2, 279));
        assert!(
            !timeline.covers(0, 480),
            "a missing sample must not confirm full coverage"
        );
        assert_eq!(
            next_cutover_sample(0, Duration::from_nanos(10_000_001)),
            960
        );
        assert_eq!(
            next_cutover_sample(0, Duration::from_nanos(10_020_834)),
            960
        );
    }

    #[test]
    fn eof_after_candidate_readiness_and_stop_both_preserve_old_route() {
        let epoch = Instant::now();
        let (mut handoff, sender) = handoff(epoch, 0, epoch);
        handoff.pcm.push(1, 480, frame(0.7, 480));
        drop(sender);
        handoff.poll(epoch, epoch);
        assert_eq!(handoff.action(0, epoch, false), HandoffAction::Cancel);
        assert_eq!(handoff.action(0, epoch, true), HandoffAction::Cancel);
        assert_eq!(
            handoff
                .command
                .coordinator
                .lock()
                .unwrap()
                .snapshot("test-session")
                .unwrap()
                .confirmed
                .microphone_id,
            None
        );
    }

    struct SignalDrop(mpsc::Sender<()>);
    impl Drop for SignalDrop {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    fn fake_source(
        receiver: mpsc::Receiver<AudioFrame>,
        closed: mpsc::Sender<()>,
    ) -> ProducerSource {
        ProducerSource {
            device_id: "test:microphone".into(),
            device_name: "Test microphone".into(),
            receiver,
            stats: Arc::new(AudioCaptureStats::default()),
            _owner: Box::new(SignalDrop(closed)),
            failure: None,
            #[cfg(debug_assertions)]
            caption_injector: None,
        }
    }

    #[tokio::test]
    async fn cancelled_open_and_ready_handoffs_close_the_owned_source_before_releasing_capacity() {
        for boundary in [OwnerPhase::BeforeOpened, OwnerPhase::BeforeReady] {
            let count = Arc::new(AtomicU64::new(0));
            let (pcm, receiver) = mpsc::channel();
            let (closed_tx, closed_rx) = mpsc::channel();
            let (boundary_tx, boundary_rx) = tokio::sync::oneshot::channel();
            let boundary_tx = std::sync::Mutex::new(Some(boundary_tx));
            let (release_tx, release_rx) = mpsc::channel();
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            let worker_count = count.clone();
            let task = tokio::spawn(async move {
                prepare_producer_with(
                    move || {
                        pcm.send(frame(0.0, 480)).unwrap();
                        Ok(fake_source(receiver, closed_tx))
                    },
                    Arc::new(AtomicBool::new(false)),
                    worker_count,
                    move |task| {
                        thread::Builder::new().spawn(move || {
                            task();
                            let _ = done_tx.send(());
                        })
                    },
                    move |phase| {
                        if phase == boundary {
                            let _ = boundary_tx.lock().unwrap().take().unwrap().send(());
                            release_rx.recv().unwrap();
                        }
                    },
                    true,
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(2), boundary_rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(count.load(Ordering::Acquire), 1);
            task.abort();
            assert!(matches!(task.await,Err(error) if error.is_cancelled()));
            release_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), done_rx)
                .await
                .unwrap()
                .unwrap();
            closed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(count.load(Ordering::Acquire), 0);
        }
    }

    #[tokio::test]
    async fn failed_owner_spawn_returns_capacity_and_never_opens_a_device() {
        let count = Arc::new(AtomicU64::new(0));
        let opened = Arc::new(AtomicBool::new(false));
        let worker_opened = opened.clone();
        let result = prepare_producer_with(
            move || {
                worker_opened.store(true, Ordering::Release);
                unreachable!()
            },
            Arc::new(AtomicBool::new(false)),
            count.clone(),
            |_task| Err(io::Error::other("injected spawn failure")),
            |_| {},
            true,
        )
        .await;
        assert!(result.is_err());
        assert!(!opened.load(Ordering::Acquire));
        assert_eq!(count.load(Ordering::Acquire), 0);
    }

    #[test]
    fn owner_capacity_stays_bounded_until_actual_driver_close() {
        let count = Arc::new(AtomicU64::new(0));
        let first = ProducerPermit::acquire(count.clone()).unwrap();
        let second = ProducerPermit::acquire(count.clone()).unwrap();
        assert!(ProducerPermit::acquire(count.clone()).is_err());
        drop(first);
        let replacement = ProducerPermit::acquire(count.clone()).unwrap();
        assert_eq!(count.load(Ordering::Acquire), 2);
        drop(second);
        drop(replacement);
        assert_eq!(count.load(Ordering::Acquire), 0);
    }
    struct PcmTestOwner {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Drop for PcmTestOwner {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    async fn paced_test_producer(
        id: &str,
        value: f32,
        count: Arc<AtomicU64>,
        controls: Option<(AudioProcessingSettingsHandle, AudioProcessingSettings)>,
    ) -> ManagedProducer {
        paced_test_producer_with_packet(id, value, count, controls, 480).await
    }

    async fn paced_test_producer_with_packet(
        id: &str,
        value: f32,
        count: Arc<AtomicU64>,
        controls: Option<(AudioProcessingSettingsHandle, AudioProcessingSettings)>,
        packet_frames: usize,
    ) -> ManagedProducer {
        let id = id.to_string();
        prepare_producer_with(
            move || {
                let (sender, receiver) = mpsc::channel();
                let stop = Arc::new(AtomicBool::new(false));
                let producer_stop = stop.clone();
                let epoch = Instant::now();
                let worker = thread::spawn(move || {
                    let packet_nanos =
                        packet_frames as u64 * 1_000_000_000 / u64::from(NATIVE_AUDIO_SAMPLE_RATE);
                    for index in 0_u64.. {
                        let end = epoch + Duration::from_nanos((index + 1) * packet_nanos);
                        // Media pacing only; readiness and cleanup use channels.
                        if let Some(remaining) = end.checked_duration_since(Instant::now()) {
                            thread::sleep(remaining);
                        }
                        if producer_stop.load(Ordering::Acquire) {
                            break;
                        }
                        let mut packet = frame(value, packet_frames);
                        packet.timestamp_micros = index * packet_frames as u64 * 1_000_000
                            / u64::from(NATIVE_AUDIO_SAMPLE_RATE);
                        packet.captured_at = end;
                        if sender.send(packet).is_err() {
                            break;
                        }
                    }
                });
                Ok(ProducerSource {
                    device_id: id.clone(),
                    device_name: id,
                    receiver,
                    stats: Arc::new(AudioCaptureStats::default()),
                    failure: None,
                    _owner: Box::new(PcmTestOwner {
                        stop,
                        thread: Some(worker),
                    }),
                    #[cfg(debug_assertions)]
                    caption_injector: None,
                })
            },
            Arc::new(AtomicBool::new(false)),
            count,
            spawn_owner,
            move |phase| {
                if phase == OwnerPhase::BeforeReady
                    && let Some((handle, settings)) = controls.as_ref()
                {
                    handle.update(*settings);
                }
            },
            true,
        )
        .await
        .unwrap()
    }

    async fn send_test_switch(
        session: &SessionAudio,
        coordinator: &Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        id: &str,
        target: Option<&str>,
        value: f32,
        cancel_after_ramp: bool,
        controls: Option<AudioProcessingSettings>,
    ) -> (anyhow::Result<AudioCommitReceipt>, Option<u64>) {
        let mut request = source_request(id, target);
        request.expected_source_revision = coordinator
            .lock()
            .unwrap()
            .snapshot("test-session")
            .unwrap()
            .source_revision;
        let cancelled = {
            let mut coordinator = coordinator.lock().unwrap();
            coordinator.admit(&request).unwrap();
            coordinator.cancellation(&request).unwrap()
        };
        let candidate = match target {
            Some(id) => Some(
                paced_test_producer(
                    id,
                    value,
                    session.handle.producer_count.clone(),
                    controls.map(|settings| (session.processing_settings.clone(), settings)),
                )
                .await,
            ),
            None => None,
        };
        let (ramp_tx, ramp_rx) = mpsc::channel();
        if cancel_after_ramp {
            let cancellation = cancelled.clone();
            session.handle.shared.lock().unwrap().after_ramp = Some(Arc::new(move |start| {
                cancellation.store(true, Ordering::Release);
                ramp_tx.send(start + 480).unwrap();
            }));
        }
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        session
            .handle
            .commands
            .try_send(AudioSwitchCommand {
                purpose: HandoffPurpose::Commit,
                request: request.clone(),
                coordinator: coordinator.clone(),
                cancelled,
                candidate,
                admitted_at: Instant::now(),
                acknowledgement,
            })
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), receipt)
            .await
            .unwrap()
            .unwrap();
        let cancelled_at = if cancel_after_ramp {
            session.handle.shared.lock().unwrap().after_ramp = None;
            Some(ramp_rx.recv_timeout(Duration::from_secs(1)).unwrap())
        } else {
            None
        };
        if let Err(error) = &result {
            coordinator
                .lock()
                .unwrap()
                .finish(
                    &request,
                    crate::live_source_switch::SwitchStage::Failed,
                    Some(error.to_string()),
                )
                .unwrap();
        }
        (result, cancelled_at)
    }

    #[tokio::test]
    async fn real_bus_handoffs_preserve_one_pcm_stream_ramps_mute_none_and_cancelled_old_route() {
        use std::io::Read;
        let path =
            crate::audio::native_audio_fifo_path(&format!("switch-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let reader_path = path.clone();
        let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
        let reader = thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 3840];
                match file.read_exact(&mut chunk) {
                    Ok(()) => {
                        bytes.extend_from_slice(&chunk);
                        let decoded = chunk
                            .chunks_exact(8)
                            .map(|frame| f32::from_le_bytes(frame[..4].try_into().unwrap()))
                            .collect::<Vec<_>>();
                        let _ = progress_tx.send((bytes.len() / 8, decoded));
                    }
                    Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                    Err(error) => panic!("{error}"),
                }
            }
            bytes
        });
        let session = attach(
            None,
            path,
            None,
            AudioProcessingSettings::default(),
            Duration::from_secs(1),
        );
        let mut progress_rx = progress_rx;
        tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let mut initial = crate::live_source_switch::SourceSwitchCoordinator::default();
        initial.start(
            "test-session".into(),
            crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        initial.enable_microphone();
        let coordinator = Arc::new(std::sync::Mutex::new(initial));
        assert!(!session.caption_start_eligible());
        let a = send_test_switch(
            &session,
            &coordinator,
            "a",
            Some("microphone:coreaudio:7"),
            0.4,
            false,
            None,
        )
        .await
        .0
        .unwrap();
        assert!(session.caption_start_eligible());
        let b = send_test_switch(
            &session,
            &coordinator,
            "b",
            Some("microphone:coreaudio:8"),
            0.8,
            false,
            Some(AudioProcessingSettings {
                gain_db: -3.0,
                muted: true,
            }),
        )
        .await
        .0
        .unwrap();
        session.update_processing_settings(AudioProcessingSettings {
            gain_db: -3.0,
            muted: false,
        });
        // Acknowledgement delivery and Tokio scheduling are not a PCM boundary.
        // Wait for an actual complete decoded chunk with the new controls before
        // replacing B, and retain its exact sample interval for the assertion.
        let expected_b = 0.8 * 10.0_f32.powf(-3.0 / 20.0);
        let unmuted_b = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let (end, decoded) = progress_rx.recv().await.unwrap();
                if end >= b.cutover_sample as usize + 960
                    && decoded.iter().all(|sample| sample.abs() > 0.001)
                {
                    break end - decoded.len()..end;
                }
            }
        })
        .await
        .expect("B never emitted a full chunk with the confirmed controls");
        let none = send_test_switch(&session, &coordinator, "none", None, 0.0, false, None)
            .await
            .0
            .unwrap();
        assert!(!session.caption_start_eligible());
        session.update_processing_settings(AudioProcessingSettings::default());
        let a2 = send_test_switch(
            &session,
            &coordinator,
            "a2",
            Some("microphone:coreaudio:7"),
            0.4,
            false,
            None,
        )
        .await
        .0
        .unwrap();
        // Only this exact-envelope subcase controls producer input availability.
        // Ordinary A/B/None above uses the paced native producer unchanged. An
        // OS-thread scheduling gap is valid silence, but is not an envelope oracle.
        session.handle.shared.lock().unwrap().cancellation_input = Some((
            a2.generation,
            |timeline| {
                eprintln!(
                    "cancellation input boundary={} queued={} captured={} generated={} discarded={}",
                    timeline.cursor(),
                    timeline.packets.len(),
                    timeline.counters.captured_frames,
                    timeline.counters.generated_frames,
                    timeline.counters.discarded_frames
                );
                timeline.packets.clear();
                timeline.packets.push_back(QueuedPcm {
                    start: timeline.cursor(),
                    samples: vec![0.4; CHUNK_FRAMES * 2],
                });
            },
        ));
        let (cancelled, boundary) = send_test_switch(
            &session,
            &coordinator,
            "cancelled-b",
            Some("microphone:coreaudio:8"),
            0.8,
            true,
            None,
        )
        .await;
        assert!(cancelled.is_err());
        let boundary = boundary.unwrap();
        loop {
            let (frames, _) = tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
                .await
                .unwrap()
                .unwrap();
            if frames >= boundary as usize + 480 {
                break;
            }
        }
        session.handle.shared.lock().unwrap().cancellation_input = None;
        assert_eq!(
            session.status().device_id.as_deref(),
            Some("microphone:coreaudio:7")
        );
        let final_none =
            send_test_switch(&session, &coordinator, "final-none", None, 0.0, false, None)
                .await
                .0
                .unwrap();
        session.request_stop();
        let observation = session.observation(true);
        assert!(
            observation.selected_input,
            "final totals retain earlier selected microphone evidence"
        );
        assert!(observation.captured_frames >= 960);
        assert!(observation.session_peak >= 0.39);
        let count = session.handle.producer_count.clone();
        drop(session);
        assert_eq!(count.load(Ordering::Acquire), 0);
        let bytes = reader.join().unwrap();
        let samples = bytes
            .chunks_exact(8)
            .map(|frame| f32::from_le_bytes(frame[..4].try_into().unwrap()))
            .collect::<Vec<_>>();
        for receipt in [&a, &b, &none, &a2, &final_none] {
            assert_eq!(receipt.session_id, "test-session");
            assert!(receipt.output_observed);
        }
        assert!(
            a.cutover_sample < b.cutover_sample
                && b.cutover_sample < none.cutover_sample
                && none.cutover_sample < a2.cutover_sample
        );
        assert!(
            samples[..a.cutover_sample as usize]
                .iter()
                .all(|sample| *sample == 0.0),
            "candidate PCM before commit must not escape"
        );
        assert_eq!(samples[a.cutover_sample as usize], 0.0);
        assert!((samples[a.cutover_sample as usize + 240] - 0.4).abs() < 0.001);
        assert!(
            samples[b.cutover_sample as usize..b.cutover_sample as usize + 480]
                .iter()
                .all(|sample| *sample == 0.0),
            "mute changed at the preparation barrier applies to the first committed B chunk"
        );
        assert!(
            samples[unmuted_b]
                .iter()
                .all(|sample| (*sample - expected_b).abs() < 0.001),
            "unmuted B must reach output with exactly one gain application"
        );
        assert!(
            samples[none.cutover_sample as usize..a2.cutover_sample as usize]
                .iter()
                .all(|sample| *sample == 0.0)
        );
        assert!((samples[boundary as usize - 241] - 0.4).abs() < 0.001);
        assert_eq!(samples[boundary as usize - 1], 0.0);
        assert_eq!(samples[boundary as usize], 0.0);
        assert!(
            (samples[boundary as usize + 240] - 0.4).abs() < 0.001,
            "cancelled handoff must restore old gain envelope"
        );
        assert!(
            samples[final_none.cutover_sample as usize..]
                .iter()
                .all(|sample| *sample == 0.0)
        );
    }
    struct HeldClose {
        started: Option<tokio::sync::oneshot::Sender<()>>,
        release: mpsc::Receiver<()>,
    }
    impl Drop for HeldClose {
        fn drop(&mut self) {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            // A deterministic driver-close barrier, with its own failure bound.
            let _ = self.release.recv_timeout(Duration::from_secs(3));
        }
    }

    #[tokio::test]
    async fn real_lost_owner_closes_before_exclusive_retry_restore_or_stop() {
        use std::io::Read;
        for outcome in ["retry", "restored", "unavailable", "stop"] {
            let count = Arc::new(AtomicU64::new(0));
            let (pcm_tx, pcm_rx) = mpsc::channel();
            let (close_tx, close_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let initial = prepare_producer_with(
                move || {
                    Ok(ProducerSource {
                        device_id: "microphone:coreaudio:7".into(),
                        device_name: "A".into(),
                        receiver: pcm_rx,
                        stats: Arc::new(AudioCaptureStats::default()),
                        failure: None,
                        _owner: Box::new(HeldClose {
                            started: Some(close_tx),
                            release: release_rx,
                        }),
                        #[cfg(debug_assertions)]
                        caption_injector: None,
                    })
                },
                Arc::new(AtomicBool::new(false)),
                count.clone(),
                spawn_owner,
                |_| {},
                false,
            )
            .await
            .unwrap();
            let path = crate::audio::native_audio_fifo_path(&format!(
                "exclusive-bus-{}",
                uuid::Uuid::new_v4()
            ));
            crate::audio::create_native_audio_fifo(&path).unwrap();
            let reader_path = path.clone();
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
            let reader = thread::spawn(move || {
                let mut file = std::fs::File::open(reader_path).unwrap();
                let mut samples = Vec::new();
                let mut chunk = [0u8; 3840];
                while file.read_exact(&mut chunk).is_ok() {
                    samples.extend(
                        chunk
                            .chunks_exact(8)
                            .map(|bytes| f32::from_le_bytes(bytes[..4].try_into().unwrap())),
                    );
                    let _ = progress_tx.send(samples.len());
                }
                samples
            });
            let session = attach_prepared(
                Some(InitialAudioSource {
                    source: InitialInput::Owned {
                        producer: initial,
                        count: count.clone(),
                    },
                }),
                path,
                None,
                AudioProcessingSettings::default(),
                Duration::from_millis(200),
            );
            tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
                .await
                .unwrap()
                .unwrap();
            // EOF is real bus input loss. The owner then blocks inside Drop.
            drop(pcm_tx);
            tokio::time::timeout(Duration::from_secs(2), close_rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(session.input_state(), NativeAudioInputState::SourceLost);
            assert_eq!(count.load(Ordering::Acquire), 1);
            let request = source_request("exclusive", Some("microphone:coreaudio:7"));
            let coordinator = source_coordinator(&request);
            // Initial session selection is A, even after actual input loss.
            {
                let mut coord = coordinator.lock().unwrap();
                coord.stop("test-session");
                coord.start(
                    "test-session".into(),
                    crate::protocol::SourceSelection {
                        microphone_id: request.device_id.clone(),
                        screen_id: None,
                        window_id: None,
                        camera_id: None,
                        test_pattern: false,
                    },
                );
                coord.enable_microphone();
                coord.admit(&request).unwrap();
            }
            let cancellation = coordinator.lock().unwrap().cancellation(&request).unwrap();
            let calls = Arc::new(AtomicU64::new(0));
            let opened = calls.clone();
            let handle = session.switch_handle();
            let task_coord = coordinator.clone();
            let task_count = count.clone();
            let (restore_tx, restore_rx) = tokio::sync::oneshot::channel();
            let restore_tx = Arc::new(std::sync::Mutex::new(Some(restore_tx)));
            let (continue_tx, continue_rx) = tokio::sync::watch::channel(false);
            let task = tokio::spawn(async move {
                handle
                    .replace_with(request, task_coord, cancellation, move |id| {
                        let attempt = opened.fetch_add(1, Ordering::AcqRel);
                        let count = task_count.clone();
                        let restore_tx = restore_tx.clone();
                        let mut continue_rx = continue_rx.clone();
                        async move {
                            assert_eq!(
                                count.load(Ordering::Acquire),
                                0,
                                "no open while the exact prior owner is closing"
                            );
                            if outcome != "retry" && attempt == 0 {
                                anyhow::bail!("Target open refused");
                            }
                            if outcome == "unavailable" {
                                anyhow::bail!("Restore refused");
                            }
                            if outcome == "stop" {
                                if let Some(sender) = restore_tx.lock().unwrap().take() {
                                    let _ = sender.send(());
                                }
                                while !*continue_rx.borrow() {
                                    continue_rx.changed().await.unwrap();
                                }
                            }
                            Ok(paced_test_producer(&id, 0.65, count, None).await)
                        }
                    })
                    .await
            });
            // Observe the release generation through actual PCM progress, not a sleep.
            while session.status().generation == 0 {
                tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert_eq!(calls.load(Ordering::Acquire), 0);
            release_tx.send(()).unwrap();
            if outcome == "stop" {
                tokio::time::timeout(Duration::from_secs(2), restore_rx)
                    .await
                    .unwrap()
                    .unwrap();
                coordinator.lock().unwrap().stop("test-session");
                session.request_stop();
                continue_tx.send(true).unwrap();
            }
            let result = tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap();
            let status = session.status();
            if outcome == "retry" {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err());
            }
            if outcome == "restored" {
                let snapshot = coordinator
                    .lock()
                    .unwrap()
                    .snapshot("test-session")
                    .unwrap();
                let operation = snapshot.last_operation.unwrap();
                assert_eq!(
                    operation.previous_source,
                    crate::live_source_switch::SourcePreservation::Restored
                );
                assert_eq!(
                    operation.stage,
                    crate::live_source_switch::SwitchStage::Failed
                );
            }
            if outcome == "retry" || outcome == "restored" {
                assert!(status.selected_input);
                assert_eq!(session.input_state(), NativeAudioInputState::Live);
                assert!(status.last_commit.as_ref().unwrap().output_observed);
            } else {
                assert!(!status.selected_input);
            }
            session.request_stop();
            drop(session);
            let samples = reader.join().unwrap();
            assert_eq!(count.load(Ordering::Acquire), 0);
            if outcome == "retry" || outcome == "restored" {
                let boundary = status.last_commit.unwrap().cutover_sample as usize;
                assert!(samples[..boundary].iter().all(|sample| *sample == 0.0));
                assert!((samples[boundary + 240] - 0.65).abs() < 0.001);
            } else {
                assert!(samples.iter().all(|sample| *sample == 0.0));
            }
        }
    }

    #[tokio::test]
    async fn failed_readiness_waits_for_actual_owner_close_before_returning() {
        let count = Arc::new(AtomicU64::new(0));
        let (close_tx, close_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let task_count = count.clone();
        let task = tokio::spawn(async move {
            prepare_producer_with(
                move || {
                    let (tx, rx) = mpsc::channel();
                    drop(tx);
                    Ok(ProducerSource {
                        device_id: "A".into(),
                        device_name: "A".into(),
                        receiver: rx,
                        stats: Arc::new(AudioCaptureStats::default()),
                        failure: None,
                        _owner: Box::new(HeldClose {
                            started: Some(close_tx),
                            release: release_rx,
                        }),
                        #[cfg(debug_assertions)]
                        caption_injector: None,
                    })
                },
                Arc::new(AtomicBool::new(false)),
                task_count,
                spawn_owner,
                |_| {},
                true,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), close_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(!task.is_finished());
        assert_eq!(count.load(Ordering::Acquire), 1);
        release_tx.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(count.load(Ordering::Acquire), 0);
    }

    #[test]
    fn failed_initial_open_cannot_escape_platform_capacity_via_a_silence_bus_pool() {
        let platform = Arc::new(AtomicU64::new(0));
        let initial = Arc::new(AtomicU64::new(0));
        let silent_bus = Arc::new(AtomicU64::new(0));
        let stuck_initial = ProducerPermit::acquire_in(initial.clone(), platform.clone()).unwrap();
        let active_b = ProducerPermit::acquire_in(silent_bus.clone(), platform.clone()).unwrap();
        for _ in 0..50 {
            assert!(ProducerPermit::acquire_in(silent_bus.clone(), platform.clone()).is_err());
        }
        assert_eq!(platform.load(Ordering::Acquire), 2);
        drop(stuck_initial);
        let candidate_c = ProducerPermit::acquire_in(silent_bus.clone(), platform.clone()).unwrap();
        assert_eq!(platform.load(Ordering::Acquire), 2);
        drop(candidate_c);
        drop(active_b);
        assert_eq!(platform.load(Ordering::Acquire), 0);
    }
}

/// Plan 069 S2: the bus mixes a system source. These tests pin the mic-only
/// write path to golden bytes captured before the mixer existed.
#[cfg(test)]
mod mix_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const FIXTURE_FRAMES: usize = 480_000; // 10 s at 48 kHz.
    const FIXTURE_PACKET: usize = 512;
    /// SHA-256 of the first 10 s the pre-S2 bus wrote for `fixture_sample`
    /// at +3 dB (512-frame packets, 50 ms playout), captured on the pre-change
    /// writer on macOS. The fixture uses `f32::sin`, whose last bits differ
    /// between platform math libraries, so the pinned digest is checked on
    /// macOS only. Every platform instead compares the real bus byte for byte
    /// with `reference_writer_bytes`, the chunk-by-chunk writer path the
    /// digest pins.
    #[cfg(target_os = "macos")]
    const MIC_ONLY_GOLDEN_SHA256: &str =
        "ed3f07a9b312bf01561301c02406f6c9827df05af98b1b720f19e59eee683fc7";

    /// Deterministic stereo fixture addressed by absolute sample position:
    /// different L/R tones, with one-channel-silent stretches every second so
    /// every `centered_voice_sample` branch and the +3 dB clamp are exercised.
    fn fixture_sample(position: usize) -> (f32, f32) {
        let t = position as f32 / 48_000.0;
        let left = 0.6 * (std::f32::consts::TAU * 440.0 * t).sin();
        let right = 0.9 * (std::f32::consts::TAU * 660.0 * t).sin();
        match position % 48_000 {
            4_800..9_600 => (left, 0.0),
            14_400..19_200 => (0.0, right),
            24_000..26_400 => (0.0, 0.0),
            _ => (left, right),
        }
    }

    fn fixture_packet(index: usize, epoch: Instant) -> AudioFrame {
        let first = index * FIXTURE_PACKET;
        let mut samples = Vec::with_capacity(FIXTURE_PACKET * 2);
        for position in first..first + FIXTURE_PACKET {
            let (left, right) = fixture_sample(position);
            samples.push(left);
            samples.push(right);
        }
        AudioFrame {
            timestamp_micros: (first as u64) * 1_000_000 / 48_000,
            captured_at: epoch
                + Duration::from_nanos(((first + FIXTURE_PACKET) as u64) * 1_000_000_000 / 48_000),
            sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
            channels: NATIVE_AUDIO_CHANNELS,
            samples,
        }
    }

    fn fixture_settings() -> AudioProcessingSettings {
        AudioProcessingSettings {
            gain_db: 3.0,
            muted: false,
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    struct StopOnDrop {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    /// Sends pre-built packets in real time: each packet is released once
    /// the wall clock passes its `captured_at` (a real device cannot deliver
    /// a buffer before it ends). The stream stays open after the last packet.
    fn timed_source(
        id: &str,
        packets: Vec<AudioFrame>,
        failure: Option<Arc<std::sync::Mutex<Option<String>>>>,
    ) -> ProducerSource {
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker = thread::spawn(move || {
            for packet in packets {
                loop {
                    if worker_stop.load(Ordering::Acquire) {
                        return;
                    }
                    match packet.captured_at.checked_duration_since(Instant::now()) {
                        Some(remaining) => thread::sleep(remaining.min(Duration::from_millis(5))),
                        None => break,
                    }
                }
                if sender.send(packet).is_err() {
                    return;
                }
            }
            while !worker_stop.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(5));
            }
        });
        ProducerSource {
            device_id: id.into(),
            device_name: id.into(),
            receiver,
            stats: Arc::new(AudioCaptureStats::default()),
            _owner: Box::new(StopOnDrop {
                stop,
                thread: Some(worker),
            }),
            failure,
            #[cfg(debug_assertions)]
            caption_injector: None,
        }
    }

    fn spawn_fifo_reader(
        path: PathBuf,
    ) -> (
        thread::JoinHandle<Vec<u8>>,
        tokio::sync::watch::Receiver<usize>,
    ) {
        spawn_fifo_reader_with_stall(path, None)
    }

    /// A reader that, once it has read `stall.0` frames, stops draining the
    /// FIFO for `stall.1`: FFmpeg pausing its audio input while its video
    /// input is late (plan 076).
    fn spawn_fifo_reader_with_stall(
        path: PathBuf,
        mut stall: Option<(usize, Duration)>,
    ) -> (
        thread::JoinHandle<Vec<u8>>,
        tokio::sync::watch::Receiver<usize>,
    ) {
        use std::io::Read;
        let (progress_tx, progress_rx) = tokio::sync::watch::channel(0_usize);
        let reader = thread::spawn(move || {
            // Opening blocks until the bus connects its writer.
            let mut file = std::fs::File::open(path).unwrap();
            // A blocking read was seen to miss the writer's close on a macOS
            // FIFO (no writer left anywhere, read still parked) and hang the
            // suite. Read non-blocking and treat a long silence as the end:
            // the bus writes a chunk every 10 ms while it runs.
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let fd = file.as_raw_fd();
                // SAFETY: fcntl on a descriptor this thread owns.
                unsafe {
                    let flags = libc::fcntl(fd, libc::F_GETFL);
                    assert!(flags >= 0, "F_GETFL failed");
                    assert!(libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0);
                }
            }
            const IDLE_END: Duration = Duration::from_secs(10);
            let mut bytes = Vec::new();
            let mut buffer = vec![0_u8; 64 * 1024];
            let mut last_data = Instant::now();
            loop {
                if let Some((after, pause)) = stall
                    && bytes.len() / 8 >= after
                {
                    stall = None;
                    thread::sleep(pause);
                    last_data = Instant::now();
                }
                match file.read(&mut buffer) {
                    Ok(0) => return bytes,
                    Ok(count) => {
                        bytes.extend_from_slice(&buffer[..count]);
                        progress_tx.send_replace(bytes.len() / 8);
                        last_data = Instant::now();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if last_data.elapsed() >= IDLE_END {
                            return bytes;
                        }
                        wait_readable(&file);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => panic!("{error}"),
                }
            }
        });
        (reader, progress_rx)
    }

    /// Waits for data (or the writer's close) instead of a fixed sleep, so
    /// the reader drains as fast as a real one on a slow machine too: a
    /// VM stretches a 2 ms sleep into a crawl that looks like a stalled
    /// reader to the bus (plan 076).
    fn wait_readable(file: &std::fs::File) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let mut descriptor = libc::pollfd {
                fd: file.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one pollfd for a descriptor this thread owns.
            unsafe {
                libc::poll(&mut descriptor, 1, 20);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = file;
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// Everything the bus reports until an output stall is (the episode
    /// ends once the bus catches up, which a slow machine takes longer to
    /// do), and the output position at that moment.
    async fn observe_until_stall_reported(
        bus: &Bus,
    ) -> (
        Vec<SourceLoss>,
        Vec<OutputStallReport>,
        NativeAudioInputState,
        usize,
    ) {
        let (mut losses, mut stalls) = (Vec::new(), Vec::new());
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let observation = bus.session.observation(false);
            losses.extend(observation.losses);
            stalls.extend(observation.output_stalls);
            if !stalls.is_empty() || Instant::now() >= deadline {
                return (
                    losses,
                    stalls,
                    observation.input_state,
                    *bus.progress.borrow(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    struct BusRun {
        bytes: Vec<u8>,
        status: AudioBusStatus,
    }

    /// One real bus session fed by the fixture microphone for `frames`
    /// frames. Returns every byte the FIFO reader saw.
    async fn run_fixture_mic_session(frames: usize) -> BusRun {
        let epoch = Instant::now() + Duration::from_millis(300);
        let packets = (0..frames.div_ceil(FIXTURE_PACKET))
            .map(|index| fixture_packet(index, epoch))
            .collect::<Vec<_>>();
        let count = Arc::new(AtomicU64::new(0));
        let producer = prepare_producer_with(
            move || Ok(timed_source("microphone:coreaudio:41", packets, None)),
            Arc::new(AtomicBool::new(false)),
            count.clone(),
            spawn_owner,
            |_| {},
            false,
        )
        .await
        .unwrap();
        let path =
            crate::audio::native_audio_fifo_path(&format!("golden-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let (reader, mut progress) = spawn_fifo_reader(path.clone());
        let video_epoch = Arc::new(OnceLock::new());
        video_epoch.set(epoch).unwrap();
        let session = attach_prepared(
            Some(InitialAudioSource {
                source: InitialInput::Owned { producer, count },
            }),
            path,
            Some(video_epoch),
            fixture_settings(),
            Duration::from_secs(2),
        );
        tokio::time::timeout(
            Duration::from_secs(30),
            progress.wait_for(|written| *written >= frames),
        )
        .await
        .expect("bus wrote the fixture window")
        .unwrap();
        let status = session.status();
        session.request_stop();
        drop(session);
        BusRun {
            bytes: reader.join().unwrap(),
            status,
        }
    }

    /// Timing can only lose PCM (a packet landing behind the cursor), never
    /// change it. A run with zero discarded/dropped frames is exact.
    fn clean(run: &BusRun) -> bool {
        run.status.counters.discarded_frames == 0 && run.status.counters.dropped_frames == 0
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mic_only_bus_output_matches_the_pre_mixer_golden_bytes() {
        let mut attempts = Vec::new();
        for _ in 0..4 {
            let run = run_fixture_mic_session(FIXTURE_FRAMES).await;
            if clean(&run) {
                assert_matches_reference(&run.bytes);
                return;
            }
            attempts.push(run.status.counters);
        }
        panic!("every attempt lost PCM to scheduling: {attempts:?}");
    }

    /// The fixture pushed through the timeline and `write_chunk_with_clock`,
    /// chunk by chunk, without real time.
    fn reference_writer_bytes() -> Vec<u8> {
        let epoch = Instant::now();
        let mut timeline = AudioTimeline::new();
        timeline.select_generation(0);
        let mut clock: Option<SourceClock> = None;
        let mut next_packet = 0;
        let settings = AudioProcessingSettingsHandle::new(fixture_settings());
        let mut bytes = Vec::with_capacity(FIXTURE_FRAMES * 8);
        let stop = AtomicBool::new(false);
        while timeline.cursor() < FIXTURE_FRAMES as u64 {
            // Deliver every packet that starts within the next 100 ms.
            while next_packet * FIXTURE_PACKET < timeline.cursor() as usize + 4_800 {
                let packet = fixture_packet(next_packet, epoch);
                let clock = clock.get_or_insert_with(|| SourceClock::new(&packet, epoch));
                let (start, frames) = clock.interval(&packet).unwrap();
                assert!(timeline.push(0, start, resample_frame(packet, frames)));
                next_packet += 1;
            }
            let raw = timeline.render_with_provenance();
            let now = Instant::now();
            let written = write_chunk_with_clock(
                &mut bytes,
                &raw.samples,
                &settings,
                &stop,
                &AtomicBool::new(false),
                || now,
                || {},
            )
            .unwrap();
            assert_eq!(written.stale_from, None);
        }
        assert_eq!(bytes.len(), FIXTURE_FRAMES * 8);
        bytes
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mic_only_writer_matches_the_pre_mixer_golden_bytes() {
        assert_eq!(
            sha256_hex(&reference_writer_bytes()),
            MIC_ONLY_GOLDEN_SHA256
        );
    }

    /// The real bus output must equal the reference writer bytes exactly.
    fn assert_matches_reference(bytes: &[u8]) {
        let reference = reference_writer_bytes();
        assert_eq!(
            sha256_hex(&bytes[..FIXTURE_FRAMES * 8]),
            sha256_hex(&reference),
            "mic-only bus bytes differ from the reference writer"
        );
    }

    // ---- Plan 069 S2: the mixer ------------------------------------------

    /// The pre-mixer golden with the bus at the system-audio playout delay:
    /// decision 13 changes write timing only, never the PCM bytes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn playout_delay_150ms_writes_the_same_bytes_as_50ms() {
        let mut attempts = Vec::new();
        for _ in 0..4 {
            let run = run_fixture_mic_session_with(
                FIXTURE_FRAMES,
                SessionAudioOptions {
                    playout_delay: SYSTEM_AUDIO_PLAYOUT_DELAY,
                    ..SessionAudioOptions::default()
                },
            )
            .await;
            if clean(&run) {
                assert_matches_reference(&run.bytes);
                return;
            }
            attempts.push(run.status.counters);
        }
        panic!("every attempt lost PCM to scheduling: {attempts:?}");
    }

    /// Decision 8 on the real bus: a microphone bus delay of N frames writes
    /// N frames of silence, then exactly the undelayed bytes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn microphone_bus_delay_shifts_the_written_pcm_by_exactly_n_frames() {
        const FRAMES: usize = 96_000;
        const DELAY: usize = 4_837;
        for _ in 0..4 {
            let (base, delayed) = tokio::join!(
                run_fixture_mic_session_with(FRAMES + DELAY, SessionAudioOptions::default()),
                run_fixture_mic_session_with(
                    FRAMES + DELAY,
                    SessionAudioOptions {
                        microphone_delay_frames: DELAY as u64,
                        ..SessionAudioOptions::default()
                    },
                ),
            );
            if !clean(&base) || !clean(&delayed) {
                continue;
            }
            assert!(delayed.bytes[..DELAY * 8].iter().all(|byte| *byte == 0));
            assert_eq!(
                &delayed.bytes[DELAY * 8..(DELAY + FRAMES) * 8],
                &base.bytes[..FRAMES * 8]
            );
            return;
        }
        panic!("every attempt lost PCM to scheduling");
    }

    /// S4: a microphone offset at its +1000 ms ceiling becomes a 48 000-frame
    /// bus delay on a system-audio platform (decision 8). Every delayed packet
    /// then lands a full second plus the playout delay ahead of the cursor, so
    /// the ahead-of-cursor cap widens by the delay or the take records silence.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn microphone_bus_delay_at_the_offset_ceiling_keeps_every_frame() {
        const FRAMES: usize = 24_000;
        const DELAY: usize = 48_000;
        let options = SessionAudioOptions {
            playout_delay: SYSTEM_AUDIO_PLAYOUT_DELAY,
            ..SessionAudioOptions::default()
        };
        let mut attempts = Vec::new();
        for _ in 0..4 {
            let (base, delayed) = tokio::join!(
                run_fixture_mic_session_with(FRAMES + DELAY, options),
                run_fixture_mic_session_with(
                    FRAMES + DELAY,
                    SessionAudioOptions {
                        microphone_delay_frames: DELAY as u64,
                        ..options
                    },
                ),
            );
            if !clean(&base) || !clean(&delayed) {
                attempts.push((base.status.counters, delayed.status.counters));
                continue;
            }
            assert!(delayed.bytes[..DELAY * 8].iter().all(|byte| *byte == 0));
            assert_eq!(
                &delayed.bytes[DELAY * 8..(DELAY + FRAMES) * 8],
                &base.bytes[..FRAMES * 8]
            );
            return;
        }
        panic!("every attempt lost PCM: {attempts:?}");
    }

    async fn run_fixture_mic_session_with(frames: usize, options: SessionAudioOptions) -> BusRun {
        let epoch = Instant::now() + Duration::from_millis(300);
        let packets = (0..frames.div_ceil(FIXTURE_PACKET))
            .map(|index| fixture_packet(index, epoch))
            .collect::<Vec<_>>();
        let bus = start_bus(epoch, Some(packets), fixture_settings(), options).await;
        bus.wait_for_frames(frames).await;
        let status = bus.session.status();
        let (bytes, _) = bus.finish();
        BusRun { bytes, status }
    }

    /// Packets of `packet_frames` covering bus positions
    /// `[first, first + frames)`, stamped like a real device: an arbitrary
    /// device-clock origin and `captured_at` at the END of each packet.
    fn signal_packets(
        epoch: Instant,
        first: usize,
        frames: usize,
        packet_frames: usize,
        sample: impl Fn(usize) -> (f32, f32),
    ) -> Vec<AudioFrame> {
        let mut packets = Vec::new();
        let mut start = first;
        while start < first + frames {
            let count = packet_frames.min(first + frames - start);
            let mut samples = Vec::with_capacity(count * 2);
            for position in start..start + count {
                let (left, right) = sample(position);
                samples.push(left);
                samples.push(right);
            }
            packets.push(AudioFrame {
                timestamp_micros: 7_000_000_000 + (start as u64) * 1_000_000 / 48_000,
                captured_at: epoch
                    + Duration::from_nanos(((start + count) as u64) * 1_000_000_000 / 48_000),
                sample_rate: NATIVE_AUDIO_SAMPLE_RATE,
                channels: NATIVE_AUDIO_CHANNELS,
                samples,
            });
            start += count;
        }
        packets
    }

    /// A position-addressed stereo system signal below the limiter ceiling,
    /// so an aligned sample can be checked for exact equality.
    fn system_signal(position: usize) -> (f32, f32) {
        let phase = (position % 997) as f32 / 997.0;
        (0.1 + 0.6 * phase, -0.05 - 0.3 * phase)
    }

    struct Bus {
        session: SessionAudio,
        reader: thread::JoinHandle<Vec<u8>>,
        progress: tokio::sync::watch::Receiver<usize>,
    }
    impl Bus {
        async fn wait_for_frames(&self, frames: usize) {
            let mut progress = self.progress.clone();
            tokio::time::timeout(
                Duration::from_secs(30),
                progress.wait_for(|written| *written >= frames),
            )
            .await
            .expect("bus output progressed")
            .unwrap();
        }
        fn finish(self) -> (Vec<u8>, AudioBusStatus) {
            let status = self.session.status();
            self.session.request_stop();
            drop(self.session);
            (self.reader.join().unwrap(), status)
        }
    }

    async fn start_bus(
        epoch: Instant,
        microphone: Option<Vec<AudioFrame>>,
        settings: AudioProcessingSettings,
        options: SessionAudioOptions,
    ) -> Bus {
        start_bus_with_stall(epoch, microphone, settings, options, None).await
    }

    async fn start_bus_with_stall(
        epoch: Instant,
        microphone: Option<Vec<AudioFrame>>,
        settings: AudioProcessingSettings,
        options: SessionAudioOptions,
        reader_stall: Option<(usize, Duration)>,
    ) -> Bus {
        let source = match microphone {
            Some(packets) => {
                let count = Arc::new(AtomicU64::new(0));
                let producer = prepare_producer_with(
                    move || Ok(timed_source("microphone:coreaudio:41", packets, None)),
                    Arc::new(AtomicBool::new(false)),
                    count.clone(),
                    spawn_owner,
                    |_| {},
                    false,
                )
                .await
                .unwrap();
                Some(InitialAudioSource {
                    source: InitialInput::Owned { producer, count },
                })
            }
            None => None,
        };
        let path =
            crate::audio::native_audio_fifo_path(&format!("mix-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let (reader, progress) = spawn_fifo_reader_with_stall(path.clone(), reader_stall);
        let video_epoch = Arc::new(OnceLock::new());
        video_epoch.set(epoch).unwrap();
        let session = attach_prepared_with(
            source,
            path,
            Some(video_epoch),
            settings,
            crate::audio::NATIVE_AUDIO_SOURCE_STALL_TIMEOUT,
            options,
        );
        Bus {
            session,
            reader,
            progress,
        }
    }

    async fn prepare_system(
        handle: &SystemAudioHandle,
        packets: Vec<AudioFrame>,
        failure: ProducerFailure,
    ) -> SystemAudioProducer {
        handle
            .prepare(
                move || {
                    let source = timed_source("system-audio:default", packets, None);
                    let ProducerSource {
                        receiver,
                        stats,
                        _owner,
                        ..
                    } = source;
                    Ok(ProducerSource::system(
                        "system-audio:default".into(),
                        "System audio".into(),
                        receiver,
                        stats,
                        failure,
                        _owner,
                    ))
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap()
    }

    fn decode(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect()
    }

    fn system_options() -> SessionAudioOptions {
        SessionAudioOptions {
            playout_delay: SYSTEM_AUDIO_PLAYOUT_DELAY,
            system_gain_db: 0.0,
            ..SessionAudioOptions::default()
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    fn quiet_failure() -> ProducerFailure {
        Arc::new(std::sync::Mutex::new(None))
    }

    /// Frames in `from..to` whose left sample is exactly `value`.
    fn frames_at(samples: &[f32], from: usize, to: usize, value: f32) -> usize {
        (from..to.min(samples.len() / 2))
            .filter(|frame| samples[frame * 2] == value)
            .count()
    }

    /// Plan 076, the owner's stream 1: FFmpeg stopped draining the audio
    /// FIFO for about 3 s (its audio input paused while video was late). The
    /// microphone kept delivering, so it is never retired: the stretch the
    /// reader missed is silent, the microphone is back as soon as the reader
    /// is, and the gap is reported as an output stall, not a source loss.
    /// On 0.9.121 this retired the microphone for the rest of the session.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_output_stall_never_retires_a_healthy_microphone() {
        for options in [SessionAudioOptions::default(), system_options()] {
            let epoch = Instant::now() + Duration::from_millis(100);
            let microphone = signal_packets(epoch, 0, 48_000 * 30, 480, |_| (0.2, 0.2));
            let bus = start_bus_with_stall(
                epoch,
                Some(microphone),
                AudioProcessingSettings::default(),
                options,
                Some((72_000, Duration::from_secs(3))),
            )
            .await;
            let (losses, stalls, input_state, caught_up) = observe_until_stall_reported(&bus).await;
            // One second of output after the bus caught up.
            bus.wait_for_frames(caught_up + 48_000 * 2).await;
            assert!(bus.session.microphone_owner_present(), "never retired");
            let (bytes, _) = bus.finish();
            let samples = decode(&bytes);
            assert_eq!(losses, vec![], "not a source loss");
            assert_eq!(input_state, NativeAudioInputState::Live);
            // Scheduling jitter may split the episode; together they cover
            // the stall.
            assert!(!stalls.is_empty(), "the stall is reported");
            let longest = stalls.iter().map(|stall| stall.duration_ms).max().unwrap();
            assert!(longest >= 2_500, "{stalls:?}");
            let lost: u64 = stalls.iter().map(|stall| stall.lost_ms).sum();
            assert!(lost >= 1_000, "{stalls:?}");
            assert_eq!(frames_at(&samples, 24_000, 72_000, 0.2), 48_000, "before");
            assert_eq!(
                frames_at(&samples, caught_up + 48_000, caught_up + 96_000, 0.2),
                48_000,
                "the microphone is back after the stall"
            );
        }
    }

    /// The same stall with system audio mixed: neither source is lost, and
    /// both are back after it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_output_stall_keeps_system_audio_in_the_mix() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let microphone = signal_packets(epoch, 0, 48_000 * 30, 480, |_| (0.2, 0.2));
        let bus = start_bus_with_stall(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            system_options(),
            Some((72_000, Duration::from_secs(3))),
        )
        .await;
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 48_000 * 30, 960, |_| (0.5, 0.25)),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        let (losses, stalls, _, caught_up) = observe_until_stall_reported(&bus).await;
        bus.wait_for_frames(caught_up + 48_000 * 2).await;
        assert!(system.observation().attached, "still in the mix");
        assert_eq!(system.claim_loss(), None, "no system loss");
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        assert_eq!(losses, vec![]);
        assert!(!stalls.is_empty(), "the stall is reported");
        assert_eq!(
            frames_at(&samples, caught_up + 48_000, caught_up + 96_000, 0.7),
            48_000,
            "microphone plus system after the stall"
        );
    }

    /// A device clock that jumps 5 s ahead mid-session (a genuine timeline
    /// fault, with the output keeping pace): the loss is reported once, the
    /// source re-anchors from its capture times, and its recovery is
    /// reported. The producer is never retired.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_source_clock_jump_re_anchors_and_recovers_without_retiring() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let mut microphone = signal_packets(epoch, 0, 48_000 * 9, 480, |_| (0.2, 0.2));
        for packet in microphone.iter_mut().skip(200) {
            packet.timestamp_micros += 5_000_000;
        }
        let bus = start_bus(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            SessionAudioOptions::default(),
        )
        .await;
        bus.wait_for_frames(48_000 * 8).await;
        let observation = bus.session.observation(false);
        assert!(bus.session.microphone_owner_present(), "never retired");
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        assert_eq!(
            observation
                .losses
                .iter()
                .map(|loss| loss.reason)
                .collect::<Vec<_>>(),
            vec![SourceLossReason::TimelineRejected],
            "reported once"
        );
        assert_eq!(observation.recoveries.len(), 1, "{observation:?}");
        let gap = observation.recoveries[0].gap_ms;
        assert!((1_900..=3_000).contains(&gap), "gap {gap} ms");
        assert_eq!(observation.input_state, NativeAudioInputState::Live);
        assert!(observation.output_stalls.is_empty(), "the output kept pace");
        assert_eq!(
            frames_at(&samples, 288_000, 384_000, 0.2),
            96_000,
            "placed again from its capture times"
        );
    }

    /// Mono samples as stereo packets of `packet_frames`, stamped like a
    /// real device from `epoch`.
    fn mono_packets(epoch: Instant, mono: &[f32], packet_frames: usize) -> Vec<AudioFrame> {
        signal_packets(epoch, 0, mono.len(), packet_frames, |position| {
            (mono[position], mono[position])
        })
    }

    /// Plan 076, the owner's stream 2: a Twitch tab plays the stream 3.16 s
    /// behind while System audio is on, so the microphone comes back through
    /// it. The echo guard pauses system audio (the slot ramps out and a pause
    /// is reported with the lag) and the microphone is untouched.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_echo_guard_pauses_system_audio_that_carries_the_stream_back() {
        use crate::echo_guard::fixtures::{looped, music, speech};
        let seconds = 22.0;
        let voice = speech(seconds, 7, 0.25);
        let system_signal = looped(&voice, &music(seconds, 0.12), 3.16, 0.5);
        let epoch = Instant::now() + Duration::from_millis(100);
        let bus = start_bus(
            epoch,
            Some(mono_packets(epoch, &voice, 480)),
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            mono_packets(epoch, &system_signal, 960),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            while system.observation().attached {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the guard paused system audio");
        let pause = system.claim_echo_pause().expect("a pause is reported");
        assert!(pause.lag_ms.abs_diff(3_160) <= 30, "{pause:?}");
        assert_eq!(system.claim_loss(), None, "a pause is not a loss");
        let cutover = pause.at_sample as usize;
        bus.wait_for_frames(cutover + 48_000).await;
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        // The microphone path flushes near-silent samples to zero, so compare
        // within a hair; any system audio left would be orders larger.
        let after = cutover + RAMP_FRAMES as usize;
        let worst = (after..cutover + 48_000)
            .map(|frame| (samples[frame * 2] - voice[frame]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            worst <= 1.0e-4,
            "after the pause the output is the microphone alone (worst {worst})"
        );
    }

    #[test]
    fn a_stall_is_excused_only_after_the_bus_kept_pace_and_only_for_a_while() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut stall = OutputStall::default();
        // Never kept pace (plan 070's old epoch): no episode, nothing excused.
        assert_eq!(stall.observe(t0, 480_000, 0), None);
        assert!(!stall.output_behind(t0));
        // Kept pace, then 250 ms behind: an episode that began 250 ms ago.
        assert_eq!(stall.observe(t0, 480, 0), None);
        assert_eq!(stall.observe(t0 + ms(100), 12_000, 10), None);
        assert!(stall.output_behind(t0 + ms(200)));
        assert_eq!(stall.observe(t0 + ms(2_000), 96_000, 20_000), None);
        assert!(
            !stall.output_behind(t0 + Duration::from_secs(16)),
            "stuck, not stalled"
        );
        let report = stall
            .observe(t0 + ms(3_100), 480, 48_010)
            .expect("caught up ends the episode");
        assert_eq!(
            report,
            OutputStallReport {
                duration_ms: 3_250,
                max_lag_ms: 2_000,
                lost_ms: 1_000,
            }
        );
        assert!(!stall.output_behind(t0 + ms(3_200)));
        // A busy machine wakes the bus tens of ms late: that is caught up.
        assert_eq!(stall.observe(t0 + ms(4_000), 12_000, 0), None);
        assert!(stall.observe(t0 + ms(5_000), 3_000, 0).is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_system_attach_is_silent_before_and_sample_aligned_after() {
        for _ in 0..4 {
            let epoch = Instant::now() + Duration::from_millis(100);
            let bus = start_bus(
                epoch,
                None,
                AudioProcessingSettings::default(),
                system_options(),
            )
            .await;
            let system = bus.session.system_audio();
            // S0's shape: 960-frame buffers from t=0. They queue in the
            // producer while the switch is still off.
            let producer = prepare_system(
                &system,
                signal_packets(epoch, 0, 96_000, 960, system_signal),
                quiet_failure(),
            )
            .await;
            tokio::time::sleep_until((epoch + Duration::from_millis(300)).into()).await;
            let cutover = bus.session.attach_system(producer).await.unwrap() as usize;
            assert_eq!(
                cutover % CHUNK_FRAMES,
                0,
                "attach lands on a chunk boundary"
            );
            assert!(system.observation().attached);
            bus.wait_for_frames(cutover + 24_000).await;
            let observation = system.observation();
            let (bytes, _) = bus.finish();
            let samples = decode(&bytes);
            if observation.captured_frames < 23_000 {
                continue; // The burst lost frames to scheduling; retry.
            }
            assert!(
                samples[..cutover * 2].iter().all(|sample| *sample == 0.0),
                "nothing from the queued burst leaks before the attach boundary"
            );
            for position in cutover + RAMP_FRAMES as usize..cutover + 24_000 {
                let (left, right) = system_signal(position);
                assert_eq!(
                    (samples[position * 2], samples[position * 2 + 1]),
                    (left, right),
                    "system sample {position} is placed at its capture position"
                );
            }
            // The 5 ms ramp in starts from zero at the boundary.
            assert_eq!(samples[cutover * 2], 0.0);
            let (left, _) = system_signal(cutover + 120);
            assert!((samples[(cutover + 120) * 2] - left * 0.5).abs() < 1.0e-6);
            return;
        }
        panic!("every attempt lost PCM to scheduling");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detaching_system_audio_ramps_to_zero_without_a_click_and_keeps_the_mic() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let microphone = signal_packets(epoch, 0, 144_000, 512, |_| (0.2, 0.2));
        let bus = start_bus(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 144_000, 960, |_| (0.5, 0.25)),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        tokio::time::sleep_until((epoch + Duration::from_millis(600)).into()).await;
        let detached = bus.session.detach_system().await.unwrap().unwrap() as usize;
        assert!(!system.observation().attached);
        assert_eq!(
            bus.session.detach_system().await.unwrap(),
            None,
            "idempotent"
        );
        wait_until(
            || system.owned_producer_count() == 0,
            "system capture close",
        )
        .await;
        bus.wait_for_frames(detached + 9_600).await;
        let (bytes, status) = bus.finish();
        assert_eq!(status.counters.discarded_frames, 0, "{:?}", status.counters);
        let samples = decode(&bytes);
        let left = samples.iter().step_by(2).copied().collect::<Vec<_>>();
        assert!(
            (left[detached - 1] - 0.7).abs() < 1.0e-6,
            "mic + system before"
        );
        assert!(
            left[detached + RAMP_FRAMES as usize..detached + 9_600]
                .iter()
                .all(|sample| *sample == 0.2),
            "system off leaves exactly the microphone"
        );
        let slope = 0.5 / f32::from(RAMP_FRAMES);
        let max_step = left[1..detached + 9_600]
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_step <= slope + 1.0e-6,
            "max step {max_step} exceeds the ramp slope {slope}"
        );
    }

    /// A silent drain (PR #472) while system audio is mixed: the system slot
    /// ramps out on its own retire list (never a loss), no system attach is
    /// accepted afterwards (at the handle or at the bus), and the pipe keeps
    /// carrying paced silence until Stop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn silent_drain_detaches_system_audio_refuses_attaches_and_writes_silence() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let microphone = signal_packets(epoch, 0, 144_000, 512, |_| (0.2, 0.2));
        let bus = start_bus(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 144_000, 960, |_| (0.5, 0.25)),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        tokio::time::sleep_until((epoch + Duration::from_millis(600)).into()).await;
        let mixed_until = bus.session.status().sample_cursor as usize;
        assert!(bus.session.request_silent_drain());
        assert!(!bus.session.request_silent_drain(), "drain is idempotent");
        wait_until(|| !system.observation().attached, "system detach on drain").await;
        wait_until(
            || system.owned_producer_count() == 0,
            "system capture close",
        )
        .await;
        assert!(system.claim_loss().is_none(), "a drain is not a loss");

        // Refused at the handle; the capture closes on its own owner thread.
        let late = prepare_system(
            &system,
            signal_packets(epoch, 0, 144_000, 960, |_| (0.5, 0.25)),
            quiet_failure(),
        )
        .await;
        let refused = bus.session.attach_system(late).await.unwrap_err();
        assert!(refused.to_string().contains("draining"), "{refused:#}");
        wait_until(
            || system.owned_producer_count() == 0,
            "refused capture close",
        )
        .await;
        // Refused at the bus: an attach that passed the handle before the
        // drain landed.
        let late = prepare_system(
            &system,
            signal_packets(epoch, 0, 144_000, 960, |_| (0.5, 0.25)),
            quiet_failure(),
        )
        .await;
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        assert!(
            system
                .commands
                .try_send(SystemCommand::Attach {
                    producer: late,
                    acknowledgement,
                })
                .is_ok()
        );
        let refused = tokio::time::timeout(Duration::from_secs(5), receipt)
            .await
            .expect("bus answers a queued attach")
            .expect("bus acknowledges, never drops, a queued attach")
            .unwrap_err();
        assert!(refused.to_string().contains("draining"), "{refused:#}");
        wait_until(
            || system.owned_producer_count() == 0,
            "bus-refused capture close",
        )
        .await;
        assert!(!system.observation().attached);

        let silent_from = bus.session.status().sample_cursor as usize + 2 * CHUNK_FRAMES;
        bus.wait_for_frames(silent_from + 9_600).await;
        let stopping = Instant::now();
        let (bytes, _) = bus.finish();
        assert!(
            stopping.elapsed() < Duration::from_secs(2),
            "Stop after a drain is bounded"
        );
        let samples = decode(&bytes);
        assert!(
            (samples[(mixed_until - 1) * 2] - 0.7).abs() < 1.0e-6,
            "mic + system before the drain"
        );
        assert!(
            samples[silent_from * 2..(silent_from + 9_600) * 2]
                .iter()
                .all(|sample| *sample == 0.0),
            "a draining bus writes silence, never system audio"
        );
    }

    /// A system attach racing `request_silent_drain`: whichever wins, the
    /// session ends with no system slot, no open capture, silence after the
    /// drain, and a bounded Stop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_system_attach_racing_a_silent_drain_never_survives_it() {
        let mut outcomes = (0, 0);
        for offset_ms in [0_u64, 1, 2, 5, 10, 20] {
            let epoch = Instant::now() + Duration::from_millis(100);
            let microphone = signal_packets(epoch, 0, 96_000, 512, |_| (0.2, 0.2));
            let bus = start_bus(
                epoch,
                Some(microphone),
                AudioProcessingSettings::default(),
                system_options(),
            )
            .await;
            let system = bus.session.system_audio();
            let producer = prepare_system(
                &system,
                signal_packets(epoch, 0, 96_000, 960, |_| (0.5, 0.25)),
                quiet_failure(),
            )
            .await;
            tokio::time::sleep_until((epoch + Duration::from_millis(200)).into()).await;
            let drain_handle = bus.session.switch_handle();
            let (attached, drained) = tokio::join!(bus.session.attach_system(producer), async {
                tokio::time::sleep(Duration::from_millis(offset_ms)).await;
                tokio::task::spawn_blocking(move || drain_handle.request_silent_drain())
                    .await
                    .unwrap()
            });
            assert!(drained, "offset {offset_ms}");
            match attached {
                Ok(_) => outcomes.0 += 1,
                Err(error) => {
                    assert!(error.to_string().contains("draining"), "{error:#}");
                    outcomes.1 += 1;
                }
            }
            wait_until(
                || !system.observation().attached,
                "no system slot after drain",
            )
            .await;
            wait_until(
                || system.owned_producer_count() == 0,
                "system capture close",
            )
            .await;
            assert!(system.claim_loss().is_none(), "a drain is not a loss");
            let silent_from = bus.session.status().sample_cursor as usize + 2 * CHUNK_FRAMES;
            bus.wait_for_frames(silent_from + 4_800).await;
            let stopping = Instant::now();
            let (bytes, _) = bus.finish();
            assert!(stopping.elapsed() < Duration::from_secs(2));
            let samples = decode(&bytes);
            assert!(
                samples[silent_from * 2..(silent_from + 4_800) * 2]
                    .iter()
                    .all(|sample| *sample == 0.0),
                "offset {offset_ms}: silence after the drain"
            );
        }
        assert_eq!(outcomes.0 + outcomes.1, 6);
    }

    /// Mic-only byte identity holds up to a silent drain: every chunk written
    /// before it is the reference writer's bytes, and the pipe then carries
    /// exact zeros.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn silent_drain_keeps_mic_only_bytes_identical_up_to_the_drain() {
        let reference = reference_writer_bytes();
        let mut attempts = Vec::new();
        for _ in 0..4 {
            let epoch = Instant::now() + Duration::from_millis(300);
            let packets = (0..FIXTURE_FRAMES.div_ceil(FIXTURE_PACKET))
                .map(|index| fixture_packet(index, epoch))
                .collect::<Vec<_>>();
            let bus = start_bus(
                epoch,
                Some(packets),
                fixture_settings(),
                SessionAudioOptions::default(),
            )
            .await;
            bus.wait_for_frames(96_000).await;
            // Timing is judged up to the drain: the drain itself discards
            // the microphone's buffered playout (it is capture that ended).
            let before = bus.session.status();
            let identical_until = before.sample_cursor as usize;
            assert!(bus.session.request_silent_drain());
            let silent_from = bus.session.status().sample_cursor as usize + 2 * CHUNK_FRAMES;
            bus.wait_for_frames(silent_from + 24_000).await;
            let (bytes, _) = bus.finish();
            if before.counters.discarded_frames != 0 || before.counters.dropped_frames != 0 {
                attempts.push(before.counters);
                continue;
            }
            assert!(identical_until >= 96_000);
            assert_eq!(
                sha256_hex(&bytes[..identical_until * 8]),
                sha256_hex(&reference[..identical_until * 8]),
                "mic-only bytes before the drain differ from the reference writer"
            );
            assert!(
                bytes[silent_from * 8..(silent_from + 24_000) * 8]
                    .iter()
                    .all(|byte| *byte == 0),
                "a draining bus writes exact zeros"
            );
            return;
        }
        panic!("every attempt lost PCM to scheduling: {attempts:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mixed_sum_is_limited_counted_stereo_and_the_caption_tap_hears_only_the_mic() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let microphone = signal_packets(epoch, 0, 72_000, 512, |_| (0.6, 0.6));
        let bus = start_bus(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let tapped = Arc::new(std::sync::Mutex::new(Vec::<f32>::new()));
        let tap = tapped.clone();
        bus.session.handle.shared.lock().unwrap().caption_observer =
            Some(Arc::new(move |frame: &AudioFrame| {
                tap.lock().unwrap().extend_from_slice(&frame.samples);
            }));
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 72_000, 960, |_| (0.7, -0.3)),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        bus.wait_for_frames(48_000).await;
        let observation = system.observation();
        let microphone_peak = bus.session.observation(false).live_peak;
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        assert!(
            samples
                .iter()
                .all(|sample| sample.abs() <= LIMITER_CEILING + 1.0e-6),
            "the limiter holds the -1 dBFS ceiling"
        );
        assert!(observation.mix_clipped_samples > 0, "{observation:?}");
        assert!(
            (observation.live_peak - 0.7).abs() < 0.002,
            "{observation:?}"
        );
        assert!(
            (microphone_peak - 0.6).abs() < 0.002,
            "mic meter is pre-sum"
        );
        // Steady state: the linked limiter keeps the stereo image (L = mic
        // 0.6 + 0.7, R = mic 0.6 - 0.3) and the ceiling on the loud side.
        let (left, right) = (samples[40_000 * 2], samples[40_000 * 2 + 1]);
        assert!((left - LIMITER_CEILING).abs() < 1.0e-4, "{left}");
        assert!((right / left - 0.3 / 1.3).abs() < 1.0e-4, "{left} {right}");
        let tapped = tapped.lock().unwrap();
        assert!(tapped.len() >= 40_000 * 2);
        assert!(
            tapped.iter().all(|sample| *sample == 0.0 || *sample == 0.6),
            "captions and voice activity hear only the processed microphone"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn silent_system_producer_is_never_retired_for_stalling() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let path =
            crate::audio::native_audio_fifo_path(&format!("mix-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let (reader, progress) = spawn_fifo_reader(path.clone());
        let video_epoch = Arc::new(OnceLock::new());
        video_epoch.set(epoch).unwrap();
        // A 100 ms stall timeout; the system source delivers nothing at all
        // for 1.2 s (Windows loopback while nothing plays), then plays.
        let session = attach_prepared_with(
            None,
            path,
            Some(video_epoch),
            AudioProcessingSettings::default(),
            Duration::from_millis(100),
            system_options(),
        );
        let bus = Bus {
            session,
            reader,
            progress,
        };
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 57_600, 24_000, 960, system_signal),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        bus.wait_for_frames(57_600 + 19_200).await;
        let observation = system.observation();
        assert!(observation.attached, "silence is not loss");
        assert_eq!(system.claim_loss(), None);
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        assert!(samples[..57_600 * 2].iter().all(|sample| *sample == 0.0));
        let position = 57_600 + 9_600;
        assert_eq!(samples[position * 2], system_signal(position).0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_platform_failure_ramps_system_audio_out_and_the_session_continues() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let microphone = signal_packets(epoch, 0, 96_000, 512, |_| (0.2, 0.2));
        let bus = start_bus(
            epoch,
            Some(microphone),
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let failure = quiet_failure();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 96_000, 960, |_| (0.3, 0.3)),
            failure.clone(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        bus.wait_for_frames(19_200).await;
        *failure.lock().unwrap() = Some("The stream stopped with an error.".into());
        wait_until(|| !system.observation().attached, "system loss").await;
        let loss = system.claim_loss().expect("one loss event");
        assert_eq!(loss.reason, "The stream stopped with an error.");
        assert_eq!(loss.device_name, "System audio");
        assert_eq!(system.claim_loss(), None, "claimed once");
        wait_until(
            || system.owned_producer_count() == 0,
            "system capture close",
        )
        .await;
        let at = loss.at_sample as usize;
        bus.wait_for_frames(at + 9_600).await;
        assert_eq!(bus.session.input_state(), NativeAudioInputState::Live);
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        assert!((samples[(at - 1) * 2] - 0.5).abs() < 1.0e-6);
        assert!(
            samples[(at + RAMP_FRAMES as usize) * 2..(at + 9_600) * 2]
                .iter()
                .all(|sample| *sample == 0.2)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attach_racing_stop_is_refused_and_the_capture_closes() {
        let epoch = Instant::now();
        let bus = start_bus(
            epoch,
            None,
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let first = prepare_system(&system, vec![], quiet_failure()).await;
        bus.session.attach_system(first).await.unwrap();
        // One system slot per session; a second capture cannot even open
        // while the first holds the system pool.
        let refused = system
            .prepare(
                || unreachable!("the system pool is full"),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap_err();
        assert!(
            refused
                .to_string()
                .contains("System audio is still opening")
        );
        bus.session.detach_system().await.unwrap();
        wait_until(|| system.owned_producer_count() == 0, "first capture close").await;
        let second = prepare_system(&system, vec![], quiet_failure()).await;
        assert_eq!(system.owned_producer_count(), 1);
        bus.session.request_stop();
        let error = system.attach(second).await.unwrap_err();
        assert!(error.to_string().contains("stopping"), "{error}");
        wait_until(
            || system.owned_producer_count() == 0,
            "refused capture close",
        )
        .await;
        assert!(!system.observation().attached);
        let _ = bus.finish();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_attached_system_source_does_not_block_a_microphone_hot_swap() {
        let epoch = Instant::now() + Duration::from_millis(100);
        let bus = start_bus(
            epoch,
            None,
            AudioProcessingSettings::default(),
            system_options(),
        )
        .await;
        let system = bus.session.system_audio();
        let producer = prepare_system(
            &system,
            signal_packets(epoch, 0, 96_000, 960, |_| (0.3, -0.3)),
            quiet_failure(),
        )
        .await;
        bus.session.attach_system(producer).await.unwrap();
        let mut initial = crate::live_source_switch::SourceSwitchCoordinator::default();
        initial.start(
            "test-session".into(),
            crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        initial.enable_microphone();
        let coordinator = Arc::new(std::sync::Mutex::new(initial));
        let request = crate::live_source_switch::SourceSwitchParams {
            session_id: "test-session".into(),
            request_id: "mic-a".into(),
            expected_source_revision: coordinator
                .lock()
                .unwrap()
                .snapshot("test-session")
                .unwrap()
                .source_revision,
            kind: crate::live_source_switch::SourceKind::Microphone,
            device_id: Some("microphone:coreaudio:7".into()),
            protected_overlay_window_ids: vec![],
        };
        let cancelled = {
            let mut coordinator = coordinator.lock().unwrap();
            coordinator.admit(&request).unwrap();
            coordinator.cancellation(&request).unwrap()
        };
        let microphone = signal_packets(epoch, 0, 96_000, 480, |_| (0.2, 0.2));
        let candidate = prepare_producer_with(
            move || Ok(timed_source("microphone:coreaudio:7", microphone, None)),
            Arc::new(AtomicBool::new(false)),
            bus.session.handle.producer_count.clone(),
            spawn_owner,
            |_| {},
            true,
        )
        .await
        .unwrap();
        let (acknowledgement, receipt) = tokio::sync::oneshot::channel();
        bus.session
            .handle
            .commands
            .try_send(AudioSwitchCommand {
                purpose: HandoffPurpose::Commit,
                request,
                coordinator,
                cancelled,
                candidate: Some(candidate),
                admitted_at: Instant::now(),
                acknowledgement,
            })
            .unwrap();
        let receipt = tokio::time::timeout(Duration::from_secs(2), receipt)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(system.observation().attached);
        let cutover = receipt.cutover_sample as usize;
        bus.wait_for_frames(cutover + 9_600).await;
        let (bytes, _) = bus.finish();
        let samples = decode(&bytes);
        let position = cutover + 4_800;
        assert!((samples[position * 2] - 0.5).abs() < 1.0e-6);
        assert!((samples[position * 2 + 1] - -0.1).abs() < 1.0e-6);
    }

    // ---- PR #477 review --------------------------------------------------

    fn microphone_switch(
        id: &str,
        target: &str,
    ) -> (
        crate::live_source_switch::SourceSwitchParams,
        Arc<std::sync::Mutex<crate::live_source_switch::SourceSwitchCoordinator>>,
        Arc<AtomicBool>,
    ) {
        let mut initial = crate::live_source_switch::SourceSwitchCoordinator::default();
        initial.start(
            "test-session".into(),
            crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        initial.enable_microphone();
        let request = crate::live_source_switch::SourceSwitchParams {
            session_id: "test-session".into(),
            request_id: id.into(),
            expected_source_revision: initial.snapshot("test-session").unwrap().source_revision,
            kind: crate::live_source_switch::SourceKind::Microphone,
            device_id: Some(target.into()),
            protected_overlay_window_ids: vec![],
        };
        initial.admit(&request).unwrap();
        let cancelled = initial.cancellation(&request).unwrap();
        (request, Arc::new(std::sync::Mutex::new(initial)), cancelled)
    }

    /// A microphone that starts capturing when it opens: a constant level in
    /// 480-frame packets, released in real time.
    async fn open_live_microphone(
        id: String,
        count: Arc<AtomicU64>,
        level: f32,
    ) -> anyhow::Result<ManagedProducer> {
        prepare_producer_with(
            move || {
                let origin = Instant::now();
                Ok(timed_source(
                    &id,
                    signal_packets(origin, 0, 480_000, 480, move |_| (level, level)),
                    None,
                ))
            },
            Arc::new(AtomicBool::new(false)),
            count,
            spawn_owner,
            |_| {},
            true,
        )
        .await
    }

    /// Finding 1: a positive microphone offset is a bus delay D, so a hot-swap
    /// candidate covers the cutover only after admission + D + playout. At
    /// +1000 ms (48 000 frames) every swap used to cancel at the 1 s deadline.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_microphone_hot_swap_commits_behind_a_one_second_microphone_bus_delay() {
        for delay in [0_u64, 48_000] {
            let epoch = Instant::now();
            let bus = start_bus(
                epoch,
                None,
                AudioProcessingSettings::default(),
                SessionAudioOptions {
                    playout_delay: SYSTEM_AUDIO_PLAYOUT_DELAY,
                    microphone_delay_frames: delay,
                    ..SessionAudioOptions::default()
                },
            )
            .await;
            bus.wait_for_frames(4_800).await;
            let (request, coordinator, cancelled) =
                microphone_switch(&format!("swap-{delay}"), "microphone:coreaudio:7");
            let count = bus.session.handle.producer_count.clone();
            let admitted = Instant::now();
            let receipt = bus
                .session
                .switch_handle()
                .replace_with(request, coordinator, cancelled, move |id| {
                    open_live_microphone(id, count.clone(), 0.2)
                })
                .await
                .unwrap_or_else(|error| panic!("delay {delay}: the hot-swap failed: {error}"));
            let took = admitted.elapsed();
            let cutover = receipt.cutover_sample as usize;
            bus.wait_for_frames(cutover + 9_600).await;
            let (bytes, _) = bus.finish();
            let samples = decode(&bytes);
            assert!(
                samples[..cutover * 2].iter().all(|sample| *sample == 0.0),
                "delay {delay}: nothing before the cutover"
            );
            assert!(
                samples[(cutover + RAMP_FRAMES as usize) * 2..(cutover + 9_600) * 2]
                    .iter()
                    .all(|sample| (*sample - 0.2).abs() < 1.0e-6),
                "delay {delay}: the new microphone plays from the cutover"
            );
            if delay == 0 {
                assert!(
                    took < Duration::from_secs(1),
                    "delay 0 swaps as before: {took:?}"
                );
            }
        }
    }

    /// Finding 3: a system-audio start may take its 12 s start budget plus a
    /// 3 s stop, far past the microphone's 5 s open budget.
    /// macOS only: it is the one platform in this build that opens a system
    /// source, and elsewhere the microphone budget can equal the system one
    /// (Windows allows 15 s), so the premise does not hold.
    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_slow_system_audio_start_gets_its_own_open_budget() {
        assert!(
            SourceRole::System.open_budget()
                >= crate::system_audio_capture::SYSTEM_AUDIO_START_BUDGET
                    + crate::system_audio_capture::SYSTEM_AUDIO_STOP_BUDGET
        );
        assert_eq!(SourceRole::Microphone.open_budget(), MICROPHONE_OPEN_BUDGET);
        let count = Arc::new(AtomicU64::new(0));
        let producer = prepare_system_audio_in(
            || {
                // A slow first startCapture: past the microphone budget.
                thread::sleep(MICROPHONE_OPEN_BUDGET + Duration::from_millis(500));
                let (frames, receiver) = mpsc::channel::<AudioFrame>();
                Ok(ProducerSource::system(
                    "system-audio:default".into(),
                    "System audio".into(),
                    receiver,
                    Arc::new(AudioCaptureStats::default()),
                    quiet_failure(),
                    Box::new(frames),
                ))
            },
            Arc::new(AtomicBool::new(false)),
            count.clone(),
        )
        .await
        .expect("a slow system audio start is not unavailable");
        assert_eq!(count.load(Ordering::Acquire), 1);
        drop(producer);
        wait_until(
            || count.load(Ordering::Acquire) == 0,
            "system capture close",
        )
        .await;
    }

    /// Finding 4: the bus cursor trails the wall clock by the playout delay;
    /// a stop must still write the captured audio up to the stop instant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopping_writes_real_microphone_audio_up_to_the_stop_instant() {
        for playout_delay in [PLAYOUT_DELAY, SYSTEM_AUDIO_PLAYOUT_DELAY] {
            let epoch = Instant::now() + Duration::from_millis(100);
            let microphone = signal_packets(epoch, 0, 480_000, 512, |_| (0.2, 0.2));
            let bus = start_bus(
                epoch,
                Some(microphone),
                AudioProcessingSettings::default(),
                SessionAudioOptions {
                    playout_delay,
                    ..SessionAudioOptions::default()
                },
            )
            .await;
            bus.wait_for_frames(24_000).await;
            let stopped = Instant::now();
            let (bytes, status) = bus.finish();
            let drained = stopped.elapsed();
            let samples = decode(&bytes);
            let stop_sample =
                (stopped.duration_since(epoch).as_nanos() * 48_000 / 1_000_000_000) as usize;
            let written = samples.len() / 2;
            assert!(
                written >= stop_sample,
                "{playout_delay:?}: the bus wrote {written} frames, the stop was at {stop_sample}"
            );
            let tail = (stop_sample - 24_000)..stop_sample;
            assert!(
                samples[tail.start * 2..tail.end * 2]
                    .iter()
                    .all(|sample| (*sample - 0.2).abs() < 1.0e-6),
                "{playout_delay:?}: real microphone samples up to the stop ({:?})",
                status.counters
            );
            assert!(
                drained < playout_delay + STOP_DRAIN_MARGIN + Duration::from_millis(250),
                "{playout_delay:?}: the drain is bounded ({drained:?})"
            );
        }
    }

    #[test]
    fn a_stop_drain_targets_the_stop_instant_and_is_bounded() {
        let epoch = Instant::now();
        let stop_at = epoch + Duration::from_millis(1_000);
        let drain = StopDrain::new(stop_at, epoch, SYSTEM_AUDIO_PLAYOUT_DELAY);
        assert_eq!(drain.target, 48_000);
        assert_eq!(drain.flush_at, stop_at + STOP_DRAIN_ARRIVAL);
        assert_eq!(
            drain.deadline,
            stop_at + SYSTEM_AUDIO_PLAYOUT_DELAY + STOP_DRAIN_MARGIN
        );
        assert!(!drain.done(47_520, stop_at));
        assert!(drain.done(48_000, stop_at));
        assert!(drain.done(0, drain.deadline), "never past the deadline");
        let short = StopDrain::new(stop_at, epoch, PLAYOUT_DELAY);
        assert_eq!(
            short.flush_at,
            stop_at + PLAYOUT_DELAY,
            "never later than paced"
        );
        assert_eq!(StopDrain::new(epoch, stop_at, PLAYOUT_DELAY).target, 0);
    }

    /// Finding 5: the output device's clock can run PTS ahead of the host
    /// clock. Those buffers just arrived; they are fresh, and PTS places them.
    #[test]
    fn a_system_clock_running_ahead_of_arrival_is_still_mixed() {
        let epoch = Instant::now() - Duration::from_secs(5);
        let (mut slot, sender, _failure) = test_slot(0);
        slot.timeline.cursor = 48_000;
        // Ten 20 ms buffers stamped 40 to 220 ms after they arrive.
        for packet in signal_packets(epoch, 48_000, 9_600, 960, system_signal) {
            sender.send(packet).unwrap();
        }
        let arrived = epoch + Duration::from_millis(980);
        assert_eq!(slot.ingest_at(epoch, arrived), None);
        assert_eq!(slot.timeline.losses().discarded_stale, 0);
        slot.ramp.joined = true;
        slot.ramp.level = RAMP_FRAMES;
        let chunk = slot.render();
        assert!(chunk.captured.iter().all(|captured| *captured));
        let (left, right) = system_signal(48_000);
        assert_eq!(chunk.samples[..2], [left, right]);
    }

    #[test]
    fn system_buffers_that_cannot_be_placed_for_two_seconds_are_a_loss() {
        let epoch = Instant::now() - Duration::from_secs(20);
        let (mut slot, sender, _failure) = test_slot(0);
        let base = epoch + Duration::from_secs(1);
        let mut timestamp = 7_000_000_000_u64;
        // A buffer stamped `ahead` past its arrival.
        let mut feed = |slot: &mut SourceSlot, arrival: Instant, ahead: Duration| {
            let mut packet = signal_packets(epoch, 0, 960, 960, system_signal).remove(0);
            packet.timestamp_micros = timestamp;
            timestamp += 20_000;
            packet.captured_at = arrival + ahead;
            sender.send(packet).unwrap();
            slot.ingest_at(epoch, arrival)
        };
        let far = Duration::from_secs(5);
        // 1.5 s of buffers stamped 5 s ahead: unplaceable, not yet a loss.
        for index in 0..75_u64 {
            let arrival = base + Duration::from_millis(index * 20);
            assert_eq!(feed(&mut slot, arrival, far), None, "buffer {index}");
        }
        // One buffer that places resets the run.
        let good = base + Duration::from_millis(1_500);
        slot.timeline.cursor =
            (good.duration_since(epoch).as_nanos() * 48_000 / 1_000_000_000) as u64 - 4_800;
        assert_eq!(feed(&mut slot, good, Duration::ZERO), None);
        assert!(slot.timeline.counters.discarded_frames > 0);
        let restart = good + Duration::from_millis(20);
        for index in 0..100_u64 {
            let arrival = restart + Duration::from_millis(index * 20);
            assert_eq!(feed(&mut slot, arrival, far), None, "run 2, buffer {index}");
        }
        let reason = feed(&mut slot, restart + Duration::from_secs(2), far)
            .expect("2 s of unplaceable buffers is a loss");
        assert!(reason.contains("drifted out of range"), "{reason}");
        // Plan 076: the buffers kept arriving, so this is a placement loss,
        // reported once. The slot stays in the mix and re-anchors; it never
        // exits for it.
        assert!(slot.exit.is_none());
        assert!(slot.clock.is_none(), "re-anchored at the loss");
        assert_eq!(
            feed(&mut slot, restart + Duration::from_secs(3), far),
            None,
            "reported once, not sticky"
        );
        drop(sender);
        assert_eq!(
            slot.ingest_health_at(epoch, restart + Duration::from_secs(4)),
            SlotHealth::Stopped("System audio stopped delivering audio.".into()),
            "an ended stream still retires the slot"
        );
    }

    /// Finding 6: a closing system capture never holds up (or fails) the
    /// release a microphone retry waits on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_closing_system_capture_never_holds_up_a_microphone_release() {
        struct HeldOwner {
            closing: Option<tokio::sync::oneshot::Sender<()>>,
            release: mpsc::Receiver<()>,
        }
        impl Drop for HeldOwner {
            fn drop(&mut self) {
                if let Some(closing) = self.closing.take() {
                    let _ = closing.send(());
                }
                let _ = self.release.recv_timeout(Duration::from_secs(15));
            }
        }
        let count = Arc::new(AtomicU64::new(0));
        let (pcm_tx, pcm_rx) = mpsc::channel::<AudioFrame>();
        let (mic_closing_tx, mic_closing) = tokio::sync::oneshot::channel();
        let (mic_release, mic_release_rx) = mpsc::channel();
        let initial = prepare_producer_with(
            move || {
                Ok(ProducerSource {
                    device_id: "microphone:coreaudio:7".into(),
                    device_name: "A".into(),
                    receiver: pcm_rx,
                    stats: Arc::new(AudioCaptureStats::default()),
                    failure: None,
                    _owner: Box::new(HeldOwner {
                        closing: Some(mic_closing_tx),
                        release: mic_release_rx,
                    }),
                    #[cfg(debug_assertions)]
                    caption_injector: None,
                })
            },
            Arc::new(AtomicBool::new(false)),
            count.clone(),
            spawn_owner,
            |_| {},
            false,
        )
        .await
        .unwrap();
        let path =
            crate::audio::native_audio_fifo_path(&format!("release-bus-{}", uuid::Uuid::new_v4()));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let (reader, progress) = spawn_fifo_reader(path.clone());
        let session = attach_prepared_with(
            Some(InitialAudioSource {
                source: InitialInput::Owned {
                    producer: initial,
                    count: count.clone(),
                },
            }),
            path,
            None,
            AudioProcessingSettings::default(),
            Duration::from_millis(200),
            system_options(),
        );
        let bus = Bus {
            session,
            reader,
            progress,
        };
        bus.wait_for_frames(4_800).await;
        // A system capture whose close takes as long as the test says.
        let system = bus.session.system_audio();
        let (system_closing_tx, system_closing) = tokio::sync::oneshot::channel();
        let (system_release, system_release_rx) = mpsc::channel();
        let producer = system
            .prepare(
                move || {
                    let (frames, receiver) = mpsc::channel::<AudioFrame>();
                    Ok(ProducerSource::system(
                        "system-audio:default".into(),
                        "System audio".into(),
                        receiver,
                        Arc::new(AudioCaptureStats::default()),
                        quiet_failure(),
                        Box::new((
                            frames,
                            HeldOwner {
                                closing: Some(system_closing_tx),
                                release: system_release_rx,
                            },
                        )),
                    ))
                },
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
        bus.session.attach_system(producer).await.unwrap();
        bus.session.detach_system().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), system_closing)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            system.owned_producer_count(),
            1,
            "the system capture is still closing"
        );
        // The microphone is lost; its owner then blocks inside its close.
        drop(pcm_tx);
        tokio::time::timeout(Duration::from_secs(2), mic_closing)
            .await
            .unwrap()
            .unwrap();
        let (request, coordinator, cancelled) = {
            let (request, coordinator, cancelled) =
                microphone_switch("retry", "microphone:coreaudio:7");
            let mut coord = coordinator.lock().unwrap();
            coord.stop("test-session");
            coord.start(
                "test-session".into(),
                crate::protocol::SourceSelection {
                    microphone_id: request.device_id.clone(),
                    screen_id: None,
                    window_id: None,
                    camera_id: None,
                    test_pattern: false,
                },
            );
            coord.enable_microphone();
            let mut request = request;
            request.expected_source_revision =
                coord.snapshot("test-session").unwrap().source_revision;
            coord.admit(&request).unwrap();
            let cancelled_now = coord.cancellation(&request).unwrap();
            drop(cancelled);
            drop(coord);
            (request, coordinator, cancelled_now)
        };
        let handle = bus.session.switch_handle();
        let open_count = count.clone();
        let task = tokio::spawn(async move {
            handle
                .replace_with(request, coordinator, cancelled, move |id| {
                    open_live_microphone(id, open_count.clone(), 0.3)
                })
                .await
        });
        wait_until(
            || bus.session.status().generation > 0,
            "the exclusive release",
        )
        .await;
        mic_release.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .expect("the retry never waits on the closing system capture")
            .unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            system.owned_producer_count(),
            1,
            "the system capture was still closing throughout"
        );
        system_release.send(()).unwrap();
        wait_until(
            || system.owned_producer_count() == 0,
            "system capture close",
        )
        .await;
        let _ = bus.finish();
    }

    // ---- Pure mixer pieces ---------------------------------------------------

    fn stereo(left: f32, right: f32, frames: usize) -> Vec<f32> {
        (0..frames).flat_map(|_| [left, right]).collect()
    }

    #[test]
    fn the_mic_is_folded_and_gained_while_system_keeps_its_stereo_and_own_gain() {
        let mixed = mix_chunk(
            &stereo(0.2, 0.1, 480),
            AudioProcessingSettings {
                gain_db: -6.0,
                muted: false,
            },
            &stereo(0.3, -0.1, 480),
            AudioProcessingSettings {
                gain_db: 6.0,
                muted: false,
            },
            PeakLimiter::default(),
        );
        let microphone = (0.15 * crate::audio::db_to_gain(-6.0)).clamp(-1.0, 1.0);
        let system = crate::audio::db_to_gain(6.0);
        assert_eq!(
            mixed.microphone,
            process_interleaved_f32(
                &stereo(0.2, 0.1, 480),
                2,
                AudioProcessingSettings {
                    gain_db: -6.0,
                    muted: false
                }
            ),
            "the microphone keeps exactly today's processing"
        );
        assert_eq!(mixed.microphone[..2], [microphone, microphone]);
        assert_eq!(mixed.system[..2], [0.3 * system, -0.1 * system]);
        assert_eq!(
            mixed.output[..2],
            [microphone + 0.3 * system, microphone - 0.1 * system]
        );
        assert!(mixed.limiter.idle());
        assert!(mixed.clipped.iter().all(|clipped| !clipped));
    }

    #[test]
    fn mic_mute_never_mutes_system_audio_and_system_silence_never_mutes_the_mic() {
        let muted_mic = mix_chunk(
            &stereo(0.4, 0.4, 480),
            AudioProcessingSettings {
                gain_db: 0.0,
                muted: true,
            },
            &stereo(0.3, 0.2, 480),
            AudioProcessingSettings::default(),
            PeakLimiter::default(),
        );
        assert!(muted_mic.microphone.iter().all(|sample| *sample == 0.0));
        assert_eq!(muted_mic.output[..2], [0.3, 0.2]);
        let silent_system = mix_chunk(
            &stereo(0.4, 0.4, 480),
            AudioProcessingSettings::default(),
            &stereo(0.3, 0.2, 480),
            AudioProcessingSettings {
                gain_db: 0.0,
                muted: true,
            },
            PeakLimiter::default(),
        );
        assert_eq!(silent_system.output[..2], [0.4, 0.4]);
    }

    #[test]
    fn limiter_holds_the_ceiling_counts_clipping_and_releases_to_exact_unity() {
        let mut limiter = PeakLimiter::default();
        let mut loud = stereo(1.4, -0.7, 480);
        let mut clipped = vec![false; loud.len()];
        limiter.process(&mut loud, &mut clipped);
        assert!(
            loud.iter()
                .all(|sample| sample.abs() <= LIMITER_CEILING + 1.0e-6)
        );
        assert!((loud[0] - LIMITER_CEILING).abs() < 1.0e-6);
        assert!((loud[1] / loud[0] + 0.5).abs() < 1.0e-6, "linked stereo");
        assert_eq!(clipped.iter().filter(|clipped| **clipped).count(), 480);
        // Release: about 50 ms to recover 63%, then exact unity again.
        let mut quiet = stereo(0.25, 0.25, 2_400);
        let mut clipped = vec![false; quiet.len()];
        limiter.process(&mut quiet, &mut clipped);
        let recovered = quiet[quiet.len() - 2] / 0.25;
        let expected = 1.0 - (1.0 - LIMITER_CEILING / 1.4) * (-1.0_f32).exp();
        assert!(
            (recovered - expected).abs() < 0.01,
            "{recovered} vs {expected}"
        );
        for _ in 0..100 {
            let mut chunk = stereo(0.25, 0.25, 480);
            limiter.process(&mut chunk, &mut vec![false; 960]);
        }
        assert!(limiter.idle());
        let mut unity = stereo(0.25, -0.5, 480);
        limiter.process(&mut unity, &mut vec![false; 960]);
        assert_eq!(unity, stereo(0.25, -0.5, 480), "an idle limiter is a no-op");
    }

    #[test]
    fn enable_ramp_joins_at_the_first_captured_frame_and_closes_within_5ms() {
        let mut ramp = EnableRamp::default();
        let mut samples = stereo(0.8, 0.8, 480);
        let mut captured = vec![false; 480];
        captured[100..].fill(true);
        ramp.apply(&mut samples, &captured);
        assert!(samples[..200].iter().all(|sample| *sample == 0.0));
        assert_eq!(samples[(100 + 120) * 2], 0.8 * 0.5);
        assert!(
            samples[(100 + 240) * 2..]
                .iter()
                .all(|sample| *sample == 0.8)
        );
        ramp.closing = true;
        let mut samples = stereo(0.8, 0.8, 480);
        ramp.apply(&mut samples, &[true; 480]);
        assert_eq!(samples[0], 0.8 * 239.0 / 240.0);
        assert!(samples[239 * 2..].iter().all(|sample| *sample == 0.0));
        assert!(ramp.closed());
        let steps = [0.8_f32]
            .iter()
            .chain(samples.iter().step_by(2))
            .collect::<Vec<_>>()
            .windows(2)
            .map(|pair| (pair[0] - pair[1]).abs())
            .fold(0.0_f32, f32::max);
        assert!(steps <= 0.8 / 240.0 + 1.0e-6);
    }

    pub(super) fn test_slot(
        delay_frames: u64,
    ) -> (SourceSlot, mpsc::Sender<AudioFrame>, ProducerFailure) {
        let (sender, receiver) = mpsc::channel();
        let (completion_guard, completion) = completion_channel();
        drop(completion_guard);
        let failure = quiet_failure();
        let producer = SystemAudioProducer {
            producer: ManagedProducer {
                device_id: "system-audio:default".into(),
                device_name: "System audio".into(),
                receiver: Some(receiver),
                stats: Arc::new(AudioCaptureStats::default()),
                stop: None,
                completion: Some(completion),
                #[cfg(debug_assertions)]
                caption_injector: None,
            },
            failure: Some(failure.clone()),
        };
        (
            SourceSlot::new(
                SourceRole::System,
                producer,
                0,
                delay_frames,
                SYSTEM_AUDIO_PLAYOUT_DELAY,
            ),
            sender,
            failure,
        )
    }

    #[test]
    fn ten_seconds_without_a_single_system_buffer_is_not_loss_but_a_failure_is() {
        let epoch = Instant::now();
        let (mut slot, sender, failure) = test_slot(0);
        for _ in 0..1_000 {
            assert_eq!(slot.ingest(epoch), None);
            assert!(slot.render().samples.iter().all(|sample| *sample == 0.0));
        }
        assert_eq!(slot.timeline.cursor(), 480_000, "10 s of bus time");
        assert!(slot.exit.is_none());
        *failure.lock().unwrap() = Some("didStopWithError".into());
        assert_eq!(slot.ingest(epoch).as_deref(), Some("didStopWithError"));
        *failure.lock().unwrap() = None;
        drop(sender);
        assert_eq!(
            slot.ingest(epoch).as_deref(),
            Some("System audio stopped delivering audio.")
        );
    }

    #[test]
    fn system_frames_before_the_video_epoch_are_trimmed_per_source() {
        let epoch = Instant::now() - Duration::from_secs(1);
        let (mut slot, sender, _failure) = test_slot(0);
        // 960 frames ending 10 ms after the epoch: the first 480 predate it.
        let packets = signal_packets(
            epoch - Duration::from_millis(10),
            0,
            960,
            960,
            system_signal,
        );
        sender.send(packets[0].clone()).unwrap();
        assert_eq!(slot.ingest(epoch), None);
        assert_eq!(slot.timeline.losses().discarded_before_epoch, 480);
        slot.ramp.joined = true;
        slot.ramp.level = RAMP_FRAMES;
        let chunk = slot.render();
        assert!(chunk.captured.iter().all(|captured| *captured));
        assert_eq!(&chunk.samples[..], &packets[0].samples[960..]);
    }

    #[test]
    fn a_first_burst_behind_the_cursor_is_trimmed_not_queued() {
        let epoch = Instant::now() - Duration::from_secs(1);
        let (mut slot, sender, _failure) = test_slot(0);
        slot.timeline.cursor = 9_600; // The slot joined 200 ms in.
        for packet in signal_packets(epoch, 0, 14_400, 960, system_signal) {
            sender.send(packet).unwrap();
        }
        assert_eq!(slot.ingest(epoch), None);
        assert_eq!(slot.timeline.losses().discarded_overlap, 9_600);
        slot.ramp.joined = true;
        slot.ramp.level = RAMP_FRAMES;
        let chunk = slot.render();
        let (left, right) = system_signal(9_600);
        assert_eq!(
            chunk.samples[..2],
            [left, right],
            "no late replay of the backlog"
        );
    }

    #[test]
    fn per_source_bus_delay_shifts_the_slot_by_exactly_n_frames() {
        const DELAY: usize = 1_234;
        let epoch = Instant::now() - Duration::from_secs(1);
        let (mut direct, direct_sender, _a) = test_slot(0);
        let (mut delayed, delayed_sender, _b) = test_slot(DELAY as u64);
        for packet in signal_packets(epoch, 0, 9_600, 960, system_signal) {
            direct_sender.send(packet.clone()).unwrap();
            delayed_sender.send(packet).unwrap();
        }
        for slot in [&mut direct, &mut delayed] {
            assert_eq!(slot.ingest(epoch), None);
            slot.ramp.joined = true;
            slot.ramp.level = RAMP_FRAMES;
        }
        let mut direct_out = Vec::new();
        let mut delayed_out = Vec::new();
        for _ in 0..24 {
            direct_out.extend(direct.render().samples);
            delayed_out.extend(delayed.render().samples);
        }
        assert!(delayed_out[..DELAY * 2].iter().all(|sample| *sample == 0.0));
        assert_eq!(
            &delayed_out[DELAY * 2..],
            &direct_out[..direct_out.len() - DELAY * 2]
        );
    }

    #[test]
    fn sync_offsets_split_into_a_track_shift_and_non_negative_bus_delays() {
        assert_eq!(
            split_sync_offsets(0, 0),
            SyncOffsetSplit {
                track_shift_ms: 0,
                microphone_delay_frames: 0,
                system_delay_frames: 0,
            },
            "the default mic path is unchanged"
        );
        assert_eq!(
            split_sync_offsets(-40, 0),
            SyncOffsetSplit {
                track_shift_ms: -40,
                microphone_delay_frames: 0,
                system_delay_frames: 1_920,
            }
        );
        assert_eq!(
            split_sync_offsets(25, 0),
            SyncOffsetSplit {
                track_shift_ms: 0,
                microphone_delay_frames: 1_200,
                system_delay_frames: 0,
            }
        );
    }

    #[test]
    fn system_producers_have_their_own_pool_and_owned_counter() {
        assert!(!std::ptr::eq(
            SourceRole::System.owned(),
            SourceRole::Microphone.owned()
        ));
        assert!(std::ptr::eq(
            SourceRole::Microphone.owned(),
            &OWNED_PRODUCERS
        ));
        let microphone = Arc::new(AtomicU64::new(0));
        let system = Arc::new(AtomicU64::new(0));
        let _a = ProducerPermit::acquire_in_role(
            SourceRole::Microphone,
            microphone.clone(),
            microphone.clone(),
        )
        .unwrap();
        let _b = ProducerPermit::acquire_in_role(
            SourceRole::Microphone,
            microphone.clone(),
            microphone.clone(),
        )
        .unwrap();
        let _system =
            ProducerPermit::acquire_in_role(SourceRole::System, system.clone(), system.clone())
                .unwrap();
        assert!(
            ProducerPermit::acquire_in_role(SourceRole::System, system.clone(), system.clone())
                .is_err(),
            "one system producer at a time"
        );
        assert_eq!(microphone.load(Ordering::Acquire), 2);
    }
}
