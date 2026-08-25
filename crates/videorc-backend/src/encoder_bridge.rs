use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::io::{self, Write as StdWrite};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Condvar, Mutex as StdMutex, OnceLock};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, oneshot, watch};
use tokio::task::JoinHandle as TokioJoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use crate::compositor::render_camera_overlay_bgra;
use crate::compositor::{CompositorFrameExportHandle, CompositorFrameStore, CompositorPixelFormat};
use crate::compositor_synthetic::{SyntheticCompositorFrame, SyntheticMovingSource};
use crate::diagnostics::{
    EncoderBridgeDiagnosticSnapshot, apply_encoder_bridge_stats,
    apply_runtime_diagnostics_snapshot, starting_diagnostics,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::frame_store::FrameHandle;
use crate::mpeg_ts::{MpegTsH264Writer, timing_to_90khz};
#[cfg(target_os = "windows")]
use crate::preview_camera::PreviewCameraFrameSource;
use crate::preview_screen::PreviewScreenD3D11FrameSource;
use crate::process_job::spawn_owned_tokio;
use crate::protocol::{
    DiagnosticStats, EncoderBridgeRoleDiagnosticStats, EncoderBridgeRoleOutputPressureStats,
    EncoderBridgeSyntheticParams, EncoderBridgeSyntheticResult, HealthLevel,
};
#[cfg(target_os = "windows")]
use crate::scene_geometry::{PixelRect, SceneCrop, SceneMask};
use crate::state::AppState;
#[cfg(target_os = "macos")]
use crate::video_toolbox_encoder::{
    VideoToolboxFrameTiming, VideoToolboxH264AnnexBFrame, VideoToolboxH264AsyncAnnexBFrame,
    VideoToolboxH264Session,
};
#[cfg(target_os = "windows")]
use crate::windows_d3d11_device::{WindowsD3d11EncoderProgress, WindowsD3d11ErrorCode};
#[cfg(target_os = "windows")]
use crate::windows_d3d11_session::{
    WindowsD3d11EncoderTicketSource, WindowsD3d11EncoderTicketSourceSnapshot,
};
#[cfg(target_os = "windows")]
use crate::windows_media_foundation_encoder::{
    D3D11BgraOverlay, DRAIN_TIMEOUT as MEDIA_FOUNDATION_DRAIN_TIMEOUT, MediaFoundationEncodedFrame,
    MediaFoundationEncoderConfig, MediaFoundationH264Encoder,
};

const ENCODER_BRIDGE_DIAGNOSTIC_WINDOW: Duration = Duration::from_secs(2);

#[cfg(target_os = "windows")]
#[derive(Clone)]
pub struct DirectD3D11CameraOverlay {
    pub source: PreviewCameraFrameSource,
    pub destination: PixelRect,
    pub crop: SceneCrop,
    pub contain: bool,
    pub mirror_x: bool,
    pub mask: SceneMask,
}
const ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD: Duration = Duration::from_millis(1);
/// Diagnostics are emitted at most once per two-second window plus terminal
/// events. A capacity-one watch channel keeps only the latest snapshot so a
/// stalled diagnostics consumer cannot retain memory or block the media writer.
const VIDEOTOOLBOX_FRESH_FRAME_HEADROOM: Duration = Duration::from_millis(4);
// Calibrated from the 2026-07-10 real-device baselines. The 4K recording leg
// peaked at depth 4 / 99ms and the companion 1080p stream leg at depth 2 /
// 35ms. These ceilings leave transient headroom without restoring the old
// generic 240-frame (eight-second at 30fps) hidden backlog.
const RECORDING_OUTPUT_QUEUE_MAX_FRAMES: usize = 16;
const RECORDING_OUTPUT_QUEUE_MAX_AGE: Duration = Duration::from_millis(250);
const STREAM_OUTPUT_QUEUE_COALESCE_FRAMES: usize = 4;
const STREAM_OUTPUT_QUEUE_COALESCE_AGE: Duration = Duration::from_millis(100);
const STREAM_OUTPUT_QUEUE_MAX_FRAMES: usize = 8;
const STREAM_OUTPUT_QUEUE_MAX_AGE: Duration = Duration::from_millis(150);
/// Recording output pressure is recoverable while either VideoToolbox or the
/// FIFO writer is still advancing. Queue depth/age are pressure signals, not a
/// liveness verdict; only a complete lack of pipeline progress for this window
/// may stop the output.
const RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT: Duration = Duration::from_secs(2);
/// A stream output over its age budget DEGRADES (latest-wins coalescing) for
/// this long before the failure is treated as real. A single over-budget
/// sample used to be a death sentence: one 166ms-old frame killed a
/// 3-platform live session (2026-07-15 owner incident) while the queue held
/// 2 of 8 frames. Transient downstream stalls recover within this window; a
/// genuinely wedged output still fails honestly.
const STREAM_OUTPUT_SUSTAINED_FAIL_WINDOW: Duration = Duration::from_secs(2);
// Raw frames receive wall-clock PTS at FFmpeg demux. Keep no stale waiting
// frames: the writer accepts the latest scheduler frame only when it is ready
// for another complete write; busy ticks are explicitly coalesced and the
// decoder holds the last VFR frame across the wall-time gap.
const RAW_VIDEO_FIFO_QUEUE_MAX_FRAMES: usize = 0;
#[cfg(not(target_os = "windows"))]
const FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const VIDEOTOOLBOX_FIFO_WRITE_STALL_TOLERANCE: Duration = FIFO_FRAME_WRITE_HARD_TIMEOUT;
#[cfg(all(target_os = "macos", debug_assertions))]
const VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES_ENV: &str = "VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES";
#[cfg(all(target_os = "macos", debug_assertions))]
const VIDEORC_TEST_VT_FIFO_PAUSE_MS_ENV: &str = "VIDEORC_TEST_VT_FIFO_PAUSE_MS";
// Media Foundation can stop draining the raw-video pipe for several seconds
// while its MFT catches up. A raw YUV frame is indivisible once writing starts:
// timing it out truncates a plane, kills FFmpeg, strands the recovery MKV, and
// loses the remainder of the user's recording. Keep a bounded shutdown escape
// hatch, but give a progressing Windows recording enough time to recover.
#[cfg(target_os = "windows")]
const RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(target_os = "windows")]
const MEDIA_FOUNDATION_FIFO_WRITE_HARD_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(not(target_os = "windows"))]
const RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT: Duration = FIFO_FRAME_WRITE_HARD_TIMEOUT;
// The raw writer's NO-PROGRESS tolerance is a PLATFORM contract, decoupled
// from the output queue's age budget. Issue #149 (real Windows device): the
// software Media Foundation MFT pauses draining the raw pipe for seconds at a
// time; the writer was using the recording queue's 250ms max_frame_age both
// as the initial deadline (anchored at SUBMIT time, so a frame that waited in
// the latest-wins mailbox was dead before its first byte) and as the sliding
// no-progress window — making the 30s Windows hard timeout unreachable and
// killing healthy recordings ~1s in. Late is fine for a file; only a truly
// wedged pipe (no bytes for this long) is fatal.
#[cfg(target_os = "windows")]
const RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE: Duration = Duration::from_secs(10);
#[cfg(not(target_os = "windows"))]
const RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE: Duration = FIFO_FRAME_WRITE_HARD_TIMEOUT;
const RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT: Duration = Duration::from_millis(2500);
#[cfg(target_os = "windows")]
const WINDOWS_D3D11_GENERATION_RECOVERY_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(target_os = "windows")]
const WINDOWS_D3D11_GENERATION_RECOVERY_POLL: Duration = Duration::from_millis(50);
/// Cadence of the encoder drain's bounded wait for a freshly published
/// primary frame. Small enough to drain two-frame pump bursts within one
/// clock period; large enough that the idle wait stays negligible.
#[cfg(target_os = "windows")]
const WINDOWS_D3D11_ENCODER_DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// Whether a newly published primary sequence must be drained before the next
/// scheduled tick. `None` (no composition yet) is never newer.
#[cfg(any(target_os = "windows", test))]
const fn windows_d3d11_primary_sequence_is_newer(
    published: Option<u64>,
    last_seen: Option<u64>,
) -> bool {
    match (published, last_seen) {
        (Some(published), Some(seen)) => published > seen,
        (Some(_), None) => true,
        (None, _) => false,
    }
}
const FIFO_WRITE_PROGRESS_YIELD_BUDGET: u32 = 64;
const FIFO_WRITE_STALL_BACKOFF: Duration = Duration::from_micros(250);
const VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK: usize = 8;
const VIDEOTOOLBOX_PROBE_ENV: &str = "VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE";

type CompositorFrameHandle = FrameHandle<CompositorPixelFormat, CompositorFrameExportHandle>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBridgeVideoOutput {
    RawYuv420p,
    VideoToolboxH264AnnexB,
    VideoToolboxH264MpegTs,
    WindowsMediaFoundationH264MpegTs,
}

impl EncoderBridgeVideoOutput {
    const fn uses_video_toolbox(self) -> bool {
        matches!(
            self,
            Self::VideoToolboxH264AnnexB | Self::VideoToolboxH264MpegTs
        )
    }

    const fn uses_media_foundation(self) -> bool {
        matches!(self, Self::WindowsMediaFoundationH264MpegTs)
    }

    const fn uses_encoded_h264(self) -> bool {
        self.uses_video_toolbox() || self.uses_media_foundation()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBridgeOutputRole {
    Shared,
    Recording,
    Stream,
}

impl EncoderBridgeOutputRole {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Recording => "recording",
            Self::Stream => "stream",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EncoderBridgeLifecycleSnapshot {
    pub live_outer_writers: usize,
    pub live_fifo_writers: usize,
    pub live_resources: usize,
    pub detached_writers: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderBridgeLifecycleTransition {
    pub sequence: u64,
    pub writer_id: String,
    pub session_id: String,
    pub role: EncoderBridgeOutputRole,
    pub state: &'static str,
    pub lifecycle: EncoderBridgeLifecycleSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EncoderBridgeLifecycleWorkerRecord {
    Transition(EncoderBridgeLifecycleTransition),
    Overflow {
        dropped_transitions: usize,
        latest_sequence: u64,
        lifecycle: EncoderBridgeLifecycleSnapshot,
    },
}

const ENCODER_BRIDGE_LIFECYCLE_TRANSITION_CAPACITY: usize = 64;

#[derive(Default)]
struct EncoderBridgeLifecycleOverflowState {
    dropped: AtomicUsize,
    version: AtomicU64,
    latest_sequence: AtomicU64,
    live_outer_writers: AtomicUsize,
    live_fifo_writers: AtomicUsize,
    live_resources: AtomicUsize,
    detached_writers: AtomicUsize,
    closed_gates: AtomicUsize,
}

impl EncoderBridgeLifecycleOverflowState {
    fn record(&self, transition: &EncoderBridgeLifecycleTransition) {
        // A tiny seqlock keeps the coalesced snapshot internally consistent
        // without ever blocking the stop/reap producer.
        self.version.fetch_add(1, Ordering::AcqRel);
        self.latest_sequence
            .store(transition.sequence, Ordering::Relaxed);
        self.live_outer_writers
            .store(transition.lifecycle.live_outer_writers, Ordering::Relaxed);
        self.live_fifo_writers
            .store(transition.lifecycle.live_fifo_writers, Ordering::Relaxed);
        self.live_resources
            .store(transition.lifecycle.live_resources, Ordering::Relaxed);
        self.detached_writers
            .store(transition.lifecycle.detached_writers, Ordering::Relaxed);
        self.version.fetch_add(1, Ordering::Release);
        self.dropped.fetch_add(1, Ordering::Release);
    }

    fn take(&self) -> Option<EncoderBridgeLifecycleWorkerRecord> {
        if self.closed_gates.load(Ordering::Acquire) > 0 {
            return None;
        }
        let dropped_transitions = self.dropped.swap(0, Ordering::AcqRel);
        if dropped_transitions == 0 {
            return None;
        }
        let (latest_sequence, lifecycle) = loop {
            let before = self.version.load(Ordering::Acquire);
            if !before.is_multiple_of(2) {
                thread::yield_now();
                continue;
            }
            let latest_sequence = self.latest_sequence.load(Ordering::Relaxed);
            let lifecycle = EncoderBridgeLifecycleSnapshot {
                live_outer_writers: self.live_outer_writers.load(Ordering::Relaxed),
                live_fifo_writers: self.live_fifo_writers.load(Ordering::Relaxed),
                live_resources: self.live_resources.load(Ordering::Relaxed),
                detached_writers: self.detached_writers.load(Ordering::Relaxed),
            };
            let after = self.version.load(Ordering::Acquire);
            if before == after {
                break (latest_sequence, lifecycle);
            }
        };
        Some(EncoderBridgeLifecycleWorkerRecord::Overflow {
            dropped_transitions,
            latest_sequence,
            lifecycle,
        })
    }
}

struct EncoderBridgeLifecyclePersistenceGateState {
    open: AtomicBool,
    overflow: Arc<EncoderBridgeLifecycleOverflowState>,
}

impl EncoderBridgeLifecyclePersistenceGateState {
    fn new(overflow: Arc<EncoderBridgeLifecycleOverflowState>) -> Self {
        Self {
            open: AtomicBool::new(true),
            overflow,
        }
    }

    fn close(&self) {
        if self.open.swap(false, Ordering::AcqRel) {
            self.overflow.closed_gates.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn open(&self) {
        if !self.open.swap(true, Ordering::AcqRel) {
            self.overflow.closed_gates.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
}

impl Drop for EncoderBridgeLifecyclePersistenceGateState {
    fn drop(&mut self) {
        if !self.open.load(Ordering::Acquire) {
            self.overflow.closed_gates.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

struct EncoderBridgeLifecycleTransitionEnvelope {
    transition: EncoderBridgeLifecycleTransition,
    state: Option<AppState>,
    gate: Arc<EncoderBridgeLifecyclePersistenceGateState>,
}

#[derive(Clone)]
struct EncoderBridgeLifecycleTransitionPublisher {
    sender: std_mpsc::SyncSender<EncoderBridgeLifecycleTransitionEnvelope>,
    overflow: Arc<EncoderBridgeLifecycleOverflowState>,
}

impl EncoderBridgeLifecycleTransitionPublisher {
    fn publish(&self, envelope: EncoderBridgeLifecycleTransitionEnvelope) {
        match self.sender.try_send(envelope) {
            Ok(()) => {}
            Err(
                std_mpsc::TrySendError::Full(envelope)
                | std_mpsc::TrySendError::Disconnected(envelope),
            ) => {
                self.overflow.record(&envelope.transition);
            }
        }
    }

    fn persistence_gate(&self) -> Arc<EncoderBridgeLifecyclePersistenceGateState> {
        Arc::new(EncoderBridgeLifecyclePersistenceGateState::new(
            self.overflow.clone(),
        ))
    }
}

struct PendingEncoderBridgeLifecycleRecord {
    record: EncoderBridgeLifecycleWorkerRecord,
    state: Option<AppState>,
    gate: Option<Arc<EncoderBridgeLifecyclePersistenceGateState>>,
}

impl PendingEncoderBridgeLifecycleRecord {
    fn sequence(&self) -> u64 {
        match &self.record {
            EncoderBridgeLifecycleWorkerRecord::Transition(transition) => transition.sequence,
            EncoderBridgeLifecycleWorkerRecord::Overflow {
                latest_sequence, ..
            } => *latest_sequence,
        }
    }

    fn ready(&self) -> bool {
        self.gate.as_ref().is_none_or(|gate| gate.is_open())
    }
}

fn run_encoder_bridge_lifecycle_persistence_worker<F>(
    receiver: std_mpsc::Receiver<EncoderBridgeLifecycleTransitionEnvelope>,
    overflow: Arc<EncoderBridgeLifecycleOverflowState>,
    start: Option<std_mpsc::Receiver<()>>,
    mut persist: F,
) where
    F: FnMut(EncoderBridgeLifecycleWorkerRecord, Option<AppState>),
{
    if let Some(start) = start {
        let _ = start.recv();
    }
    let mut pending = BTreeMap::<u64, PendingEncoderBridgeLifecycleRecord>::new();
    let mut last_state = None;
    loop {
        let mut disconnected = false;
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(envelope) => {
                if envelope.state.is_some() {
                    last_state = envelope.state.clone();
                }
                let sequence = envelope.transition.sequence;
                pending.insert(
                    sequence,
                    PendingEncoderBridgeLifecycleRecord {
                        record: EncoderBridgeLifecycleWorkerRecord::Transition(envelope.transition),
                        state: envelope.state,
                        gate: Some(envelope.gate),
                    },
                );
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
        }
        while let Ok(envelope) = receiver.try_recv() {
            if envelope.state.is_some() {
                last_state = envelope.state.clone();
            }
            let sequence = envelope.transition.sequence;
            pending.insert(
                sequence,
                PendingEncoderBridgeLifecycleRecord {
                    record: EncoderBridgeLifecycleWorkerRecord::Transition(envelope.transition),
                    state: envelope.state,
                    gate: Some(envelope.gate),
                },
            );
        }
        if let Some(record) = overflow.take() {
            let item = PendingEncoderBridgeLifecycleRecord {
                record,
                state: last_state.clone(),
                gate: None,
            };
            pending.insert(item.sequence(), item);
        }
        while let Some(sequence) = pending.keys().next().copied() {
            if !pending.get(&sequence).is_some_and(|item| item.ready()) {
                break;
            }
            let item = pending
                .remove(&sequence)
                .expect("pending lifecycle record exists");
            persist(item.record, item.state);
        }
        if disconnected && pending.is_empty() && overflow.dropped.load(Ordering::Acquire) == 0 {
            break;
        }
        if disconnected {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn persist_encoder_bridge_lifecycle_worker_record(
    record: EncoderBridgeLifecycleWorkerRecord,
    state: Option<AppState>,
) {
    let Some(state) = state else {
        return;
    };
    match record {
        EncoderBridgeLifecycleWorkerRecord::Transition(transition) => {
            let message = format!(
                "sequence={} writerId={} sessionId={} role={} state={} liveOuter={} liveFifo={} liveResources={} detached={}",
                transition.sequence,
                transition.writer_id,
                transition.session_id,
                transition.role.label(),
                transition.state,
                transition.lifecycle.live_outer_writers,
                transition.lifecycle.live_fifo_writers,
                transition.lifecycle.live_resources,
                transition.lifecycle.detached_writers,
            );
            if let Ok(entry) = state.database.add_session_log(
                &transition.session_id,
                if transition.state == "detached" {
                    HealthLevel::Warn
                } else {
                    HealthLevel::Info
                },
                "encoder-bridge-writer-lifecycle",
                &message,
                None,
            ) {
                state.emit_event("session.log", entry);
            }
        }
        EncoderBridgeLifecycleWorkerRecord::Overflow {
            dropped_transitions,
            latest_sequence,
            lifecycle,
        } => state.emit_log(
            "warn",
            format!(
                "Encoder bridge lifecycle persistence queue overflowed by {dropped_transitions} transition(s); latestSequence={latest_sequence} liveOuter={} liveFifo={} liveResources={} detached={}",
                lifecycle.live_outer_writers,
                lifecycle.live_fifo_writers,
                lifecycle.live_resources,
                lifecycle.detached_writers,
            ),
        ),
    }
}

fn spawn_encoder_bridge_lifecycle_publisher<F>(
    capacity: usize,
    start: Option<std_mpsc::Receiver<()>>,
    persist: F,
) -> (
    EncoderBridgeLifecycleTransitionPublisher,
    thread::JoinHandle<()>,
)
where
    F: FnMut(EncoderBridgeLifecycleWorkerRecord, Option<AppState>) + Send + 'static,
{
    let (sender, receiver) = std_mpsc::sync_channel(capacity);
    let overflow = Arc::new(EncoderBridgeLifecycleOverflowState::default());
    let worker_overflow = overflow.clone();
    let worker = thread::Builder::new()
        .name("videorc-encoder-lifecycle-persistence".to_string())
        .spawn(move || {
            run_encoder_bridge_lifecycle_persistence_worker(
                receiver,
                worker_overflow,
                start,
                persist,
            );
        })
        .expect("could not start encoder lifecycle persistence worker");
    (
        EncoderBridgeLifecycleTransitionPublisher { sender, overflow },
        worker,
    )
}

static ENCODER_BRIDGE_LIFECYCLE_PUBLISHER: OnceLock<EncoderBridgeLifecycleTransitionPublisher> =
    OnceLock::new();

fn encoder_bridge_lifecycle_transition_publisher()
-> &'static EncoderBridgeLifecycleTransitionPublisher {
    ENCODER_BRIDGE_LIFECYCLE_PUBLISHER.get_or_init(|| {
        let (publisher, worker) = spawn_encoder_bridge_lifecycle_publisher(
            ENCODER_BRIDGE_LIFECYCLE_TRANSITION_CAPACITY,
            None,
            persist_encoder_bridge_lifecycle_worker_record,
        );
        drop(worker);
        publisher
    })
}

#[derive(Debug)]
struct EncoderBridgeWriterRegistryEntry {
    session_id: String,
    role: EncoderBridgeOutputRole,
    outer_live: bool,
    fifo_writers_live: usize,
    resource_live: bool,
    stop_signalled: bool,
    detached: bool,
}

#[derive(Debug, Default)]
struct EncoderBridgeWriterRegistry {
    writers: HashMap<String, EncoderBridgeWriterRegistryEntry>,
    next_transition_sequence: u64,
}

impl EncoderBridgeWriterRegistry {
    fn register(
        &mut self,
        writer_id: impl Into<String>,
        session_id: impl Into<String>,
        role: EncoderBridgeOutputRole,
    ) {
        self.writers.insert(
            writer_id.into(),
            EncoderBridgeWriterRegistryEntry {
                session_id: session_id.into(),
                role,
                outer_live: true,
                fifo_writers_live: 0,
                resource_live: true,
                stop_signalled: false,
                detached: false,
            },
        );
    }

    fn snapshot_excluding_session(
        &self,
        excluded_session_id: Option<&str>,
    ) -> EncoderBridgeLifecycleSnapshot {
        let mut snapshot = EncoderBridgeLifecycleSnapshot::default();
        for writer in self.writers.values().filter(|writer| {
            excluded_session_id.is_none_or(|session_id| writer.session_id != session_id)
        }) {
            snapshot.live_outer_writers += usize::from(writer.outer_live);
            snapshot.live_fifo_writers += writer.fifo_writers_live;
            snapshot.live_resources += usize::from(writer.resource_live);
            snapshot.detached_writers += usize::from(writer.detached && writer.resource_live);
        }
        snapshot
    }

    fn snapshot(&self) -> EncoderBridgeLifecycleSnapshot {
        self.snapshot_excluding_session(None)
    }

    fn admission_blocker(&self, next_session_id: &str) -> Option<EncoderBridgeLifecycleSnapshot> {
        let snapshot = self.snapshot_excluding_session(Some(next_session_id));
        (snapshot.live_resources > 0).then_some(snapshot)
    }

    fn sequenced_snapshot(&mut self) -> (u64, EncoderBridgeLifecycleSnapshot) {
        self.next_transition_sequence = self.next_transition_sequence.wrapping_add(1).max(1);
        (self.next_transition_sequence, self.snapshot())
    }

    fn signal_stop(&mut self, writer_id: &str) -> Option<(u64, EncoderBridgeLifecycleSnapshot)> {
        let writer = self.writers.get_mut(writer_id)?;
        if writer.stop_signalled {
            return None;
        }
        writer.stop_signalled = true;
        Some(self.sequenced_snapshot())
    }

    fn fifo_started(&mut self, writer_id: &str) -> Option<(u64, EncoderBridgeLifecycleSnapshot)> {
        let writer = self.writers.get_mut(writer_id)?;
        writer.fifo_writers_live = writer.fifo_writers_live.saturating_add(1);
        Some(self.sequenced_snapshot())
    }

    fn fifo_exited(
        &mut self,
        writer_id: &str,
    ) -> Option<(&'static str, u64, EncoderBridgeLifecycleSnapshot)> {
        let should_release = self.writers.get_mut(writer_id).is_some_and(|writer| {
            writer.fifo_writers_live = writer.fifo_writers_live.saturating_sub(1);
            !writer.outer_live && writer.fifo_writers_live == 0
        });
        if !self.writers.contains_key(writer_id) {
            return None;
        }
        if should_release {
            self.writers.remove(writer_id);
        }
        let (sequence, snapshot) = self.sequenced_snapshot();
        Some((
            if should_release {
                "fifo-exited/resource-released"
            } else {
                "fifo-exited"
            },
            sequence,
            snapshot,
        ))
    }

    fn outer_exited(
        &mut self,
        writer_id: &str,
    ) -> Option<(&'static str, u64, EncoderBridgeLifecycleSnapshot)> {
        let should_release = self.writers.get_mut(writer_id).is_some_and(|writer| {
            writer.outer_live = false;
            writer.fifo_writers_live == 0
        });
        if !self.writers.contains_key(writer_id) {
            return None;
        }
        if should_release {
            self.writers.remove(writer_id);
        }
        let (sequence, snapshot) = self.sequenced_snapshot();
        Some((
            if should_release {
                "outer-exited/resource-released"
            } else {
                "outer-exited"
            },
            sequence,
            snapshot,
        ))
    }

    fn mark_detached(&mut self, writer_id: &str) -> Option<(u64, EncoderBridgeLifecycleSnapshot)> {
        let writer = self.writers.get_mut(writer_id)?;
        writer.detached = true;
        Some(self.sequenced_snapshot())
    }
}

static ENCODER_BRIDGE_WRITER_REGISTRY: OnceLock<StdMutex<EncoderBridgeWriterRegistry>> =
    OnceLock::new();

#[cfg(test)]
pub(crate) static ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK: StdMutex<()> = StdMutex::new(());

fn encoder_bridge_writer_registry() -> &'static StdMutex<EncoderBridgeWriterRegistry> {
    ENCODER_BRIDGE_WRITER_REGISTRY
        .get_or_init(|| StdMutex::new(EncoderBridgeWriterRegistry::default()))
}

pub fn encoder_bridge_lifecycle_snapshot() -> EncoderBridgeLifecycleSnapshot {
    encoder_bridge_writer_registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot()
}

pub async fn wait_for_encoder_bridge_start_admission(
    session_id: &str,
    grace: Duration,
) -> Result<EncoderBridgeLifecycleSnapshot> {
    let deadline = Instant::now() + grace;
    loop {
        let blocker = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .admission_blocker(session_id);
        match blocker {
            None => return Ok(encoder_bridge_lifecycle_snapshot()),
            Some(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Some(blocker) => {
                bail!(
                    "A previous recording still owns encoder resources (outer writers: {}, FIFO writers: {}, resources: {}, detached: {}). Restart Videorc to recover the encoder, then try recording again.",
                    blocker.live_outer_writers,
                    blocker.live_fifo_writers,
                    blocker.live_resources,
                    blocker.detached_writers,
                );
            }
        }
    }
}

#[derive(Clone)]
struct EncoderBridgeWriterLifecycle {
    state: Option<AppState>,
    writer_id: String,
    session_id: String,
    role: EncoderBridgeOutputRole,
    detached_ever: Arc<AtomicBool>,
    publisher: EncoderBridgeLifecycleTransitionPublisher,
    persistence_gate: Arc<EncoderBridgeLifecyclePersistenceGateState>,
}

impl std::fmt::Debug for EncoderBridgeWriterLifecycle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EncoderBridgeWriterLifecycle")
            .field("writer_id", &self.writer_id)
            .field("session_id", &self.session_id)
            .field("role", &self.role)
            .field("detached_ever", &self.detached_ever())
            .finish_non_exhaustive()
    }
}

impl EncoderBridgeWriterLifecycle {
    fn register(state: AppState, session_id: String, role: EncoderBridgeOutputRole) -> Self {
        let publisher = encoder_bridge_lifecycle_transition_publisher().clone();
        let lifecycle = Self {
            state: Some(state),
            writer_id: Uuid::new_v4().to_string(),
            session_id,
            role,
            detached_ever: Arc::new(AtomicBool::new(false)),
            persistence_gate: publisher.persistence_gate(),
            publisher,
        };
        encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .register(
                lifecycle.writer_id.clone(),
                lifecycle.session_id.clone(),
                lifecycle.role,
            );
        lifecycle.emit("started", encoder_bridge_lifecycle_snapshot());
        lifecycle
    }

    #[cfg(test)]
    fn register_for_test(session_id: &str, role: EncoderBridgeOutputRole) -> Self {
        Self::register_for_test_with_publisher(
            session_id,
            role,
            encoder_bridge_lifecycle_transition_publisher().clone(),
        )
    }

    #[cfg(test)]
    fn register_for_test_with_publisher(
        session_id: &str,
        role: EncoderBridgeOutputRole,
        publisher: EncoderBridgeLifecycleTransitionPublisher,
    ) -> Self {
        let lifecycle = Self {
            state: None,
            writer_id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            role,
            detached_ever: Arc::new(AtomicBool::new(false)),
            persistence_gate: publisher.persistence_gate(),
            publisher,
        };
        encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .register(
                lifecycle.writer_id.clone(),
                lifecycle.session_id.clone(),
                lifecycle.role,
            );
        lifecycle
    }

    fn registered_role(&self) -> EncoderBridgeOutputRole {
        encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .writers
            .get(&self.writer_id)
            .map_or(self.role, |writer| writer.role)
    }

    fn stop_signalled(&self) {
        let mut registry = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let transition = registry.signal_stop(&self.writer_id);
        if let Some((sequence, snapshot)) = transition {
            self.buffer_transition(sequence, "stop-signalled", snapshot);
        }
        drop(registry);
    }

    fn fifo_started(&self) {
        let mut registry = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let transition = registry.fifo_started(&self.writer_id);
        if let Some((sequence, snapshot)) = transition {
            self.buffer_transition(sequence, "fifo-started", snapshot);
        }
        drop(registry);
    }

    fn fifo_exited(&self) {
        let mut registry = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let transition = registry.fifo_exited(&self.writer_id);
        if let Some((state, sequence, snapshot)) = transition {
            self.buffer_transition(sequence, state, snapshot);
        }
        drop(registry);
    }

    fn outer_exited(&self) {
        let mut registry = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let transition = registry.outer_exited(&self.writer_id);
        if let Some((state, sequence, snapshot)) = transition {
            self.buffer_transition(sequence, state, snapshot);
        }
        drop(registry);
    }

    fn mark_detached(&self) {
        if self.detached_ever.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut registry = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let transition = registry.mark_detached(&self.writer_id);
        if let Some((sequence, snapshot)) = transition {
            self.buffer_transition(sequence, "detached", snapshot);
        }
        drop(registry);
    }

    fn detached_ever(&self) -> bool {
        self.detached_ever.load(Ordering::Acquire)
    }

    fn buffer_transition(
        &self,
        sequence: u64,
        state: &'static str,
        lifecycle: EncoderBridgeLifecycleSnapshot,
    ) {
        self.publisher
            .publish(EncoderBridgeLifecycleTransitionEnvelope {
                transition: EncoderBridgeLifecycleTransition {
                    sequence,
                    writer_id: self.writer_id.clone(),
                    session_id: self.session_id.clone(),
                    role: self.role,
                    state,
                    lifecycle,
                },
                state: self.state.clone(),
                gate: self.persistence_gate.clone(),
            });
    }

    fn persistence_gate(&self) -> Arc<EncoderBridgeLifecyclePersistenceGateState> {
        self.persistence_gate.clone()
    }

    fn cancel_failed_start(&self) {
        let snapshot = {
            let mut registry = encoder_bridge_writer_registry()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            registry.writers.remove(&self.writer_id);
            registry.snapshot()
        };
        self.emit("start-failed/resource-released", snapshot);
    }

    fn emit(&self, transition: &str, snapshot: EncoderBridgeLifecycleSnapshot) {
        let Some(state) = self.state.as_ref() else {
            return;
        };
        let message = format!(
            "writerId={} role={} state={transition} liveOuter={} liveFifo={} liveResources={} detached={}",
            self.writer_id,
            encoder_bridge_output_role_label(self.registered_role()),
            snapshot.live_outer_writers,
            snapshot.live_fifo_writers,
            snapshot.live_resources,
            snapshot.detached_writers,
        );
        if let Ok(entry) = state.database.add_session_log(
            &self.session_id,
            if transition == "detached" {
                HealthLevel::Warn
            } else {
                HealthLevel::Info
            },
            "encoder-bridge-writer-lifecycle",
            &message,
            None,
        ) {
            state.emit_event("session.log", entry);
        }
    }
}

struct EncoderBridgeOuterWriterGuard {
    lifecycle: EncoderBridgeWriterLifecycle,
}

impl Drop for EncoderBridgeOuterWriterGuard {
    fn drop(&mut self) {
        self.lifecycle.outer_exited();
    }
}

struct EncoderBridgeFifoWriterGuard {
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
}

impl EncoderBridgeFifoWriterGuard {
    fn enter(lifecycle: Option<EncoderBridgeWriterLifecycle>) -> Self {
        if let Some(lifecycle) = lifecycle.as_ref() {
            lifecycle.fifo_started();
        }
        Self { lifecycle }
    }
}

impl Drop for EncoderBridgeFifoWriterGuard {
    fn drop(&mut self) {
        if let Some(lifecycle) = self.lifecycle.as_ref() {
            lifecycle.fifo_exited();
        }
    }
}

type RegisteredFifoWriterTask = Box<dyn FnOnce() + Send + 'static>;

fn spawn_registered_fifo_writer<F>(
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
    builder: thread::Builder,
    writer: F,
) -> io::Result<thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    spawn_registered_fifo_writer_with(lifecycle, writer, move |task| builder.spawn(task))
}

fn spawn_registered_fifo_writer_with<F, S>(
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
    writer: F,
    spawn: S,
) -> io::Result<thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
    S: FnOnce(RegisteredFifoWriterTask) -> io::Result<thread::JoinHandle<()>>,
{
    // Registration is synchronous. The guard moves into the exact closure
    // handed to the thread spawner, so an unsuccessful spawn drops that
    // closure and immediately rolls back the live-FIFO registry count.
    let guard = EncoderBridgeFifoWriterGuard::enter(lifecycle);
    spawn(Box::new(move || {
        let _guard = guard;
        writer();
    }))
}

/// Production admission decision made before a compositor frame enters
/// VideoToolbox. Encoded H.264 access units are never dropped because doing so
/// can break their dependent reference chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncoderBridgePreEncodeAdmission {
    Submit,
    /// Streaming prioritizes bounded live latency. The compositor store is
    /// itself latest-wins, so skipping this submission coalesces superseded
    /// work and the next admitted tick reads the newest available frame.
    CoalesceLatestStreamFrame,
    /// Recording has no live-latency contract. When its bounded encoded queue
    /// is pressured but progressing, skip only the not-yet-encoded compositor
    /// tick. The bridge clock has already advanced, so the next admitted AU
    /// retains a truthful wall-time gap and every existing AU is delivered.
    PauseRecordingFrame,
    /// Recording/shared output fails before a long hidden backlog. Streaming
    /// also fails at its hard ceiling because dropping already-encoded access
    /// units would corrupt the stream until the next independently decodable
    /// frame.
    FailOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EncoderBridgeOutputQueuePolicy {
    role: EncoderBridgeOutputRole,
    coalesce_at_frames: Option<usize>,
    coalesce_at_age: Option<Duration>,
    max_frames: usize,
    max_age: Duration,
}

fn effective_encoder_bridge_output_role(
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeOutputRole {
    if diagnostics_context.role != EncoderBridgeOutputRole::Shared {
        return diagnostics_context.role;
    }
    match (
        diagnostics_context.recording_output.is_some(),
        diagnostics_context.stream_output.is_some(),
    ) {
        (true, false) => EncoderBridgeOutputRole::Recording,
        (false, true) => EncoderBridgeOutputRole::Stream,
        _ => EncoderBridgeOutputRole::Shared,
    }
}

fn encoder_bridge_output_queue_policy(
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeOutputQueuePolicy {
    let role = effective_encoder_bridge_output_role(diagnostics_context);
    match role {
        EncoderBridgeOutputRole::Stream => EncoderBridgeOutputQueuePolicy {
            role,
            coalesce_at_frames: Some(STREAM_OUTPUT_QUEUE_COALESCE_FRAMES),
            coalesce_at_age: Some(STREAM_OUTPUT_QUEUE_COALESCE_AGE),
            max_frames: STREAM_OUTPUT_QUEUE_MAX_FRAMES,
            max_age: STREAM_OUTPUT_QUEUE_MAX_AGE,
        },
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared => {
            EncoderBridgeOutputQueuePolicy {
                role,
                coalesce_at_frames: None,
                coalesce_at_age: None,
                max_frames: RECORDING_OUTPUT_QUEUE_MAX_FRAMES,
                max_age: RECORDING_OUTPUT_QUEUE_MAX_AGE,
            }
        }
    }
}

fn encoder_bridge_pre_encode_admission(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    oldest_frame_age: Option<Duration>,
) -> EncoderBridgePreEncodeAdmission {
    if queue_depth >= policy.max_frames as u64
        || oldest_frame_age.is_some_and(|age| age >= policy.max_age)
    {
        return EncoderBridgePreEncodeAdmission::FailOutput;
    }
    if policy.role == EncoderBridgeOutputRole::Stream
        && (policy
            .coalesce_at_frames
            .is_some_and(|depth| queue_depth >= depth as u64)
            || policy
                .coalesce_at_age
                .is_some_and(|limit| oldest_frame_age.is_some_and(|age| age >= limit)))
    {
        return EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame;
    }
    EncoderBridgePreEncodeAdmission::Submit
}

fn encoder_bridge_progress_aware_pre_encode_admission(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    oldest_frame_age: Option<Duration>,
    last_progress_age: Duration,
) -> EncoderBridgePreEncodeAdmission {
    if policy.role == EncoderBridgeOutputRole::Stream {
        return encoder_bridge_pre_encode_admission(policy, queue_depth, oldest_frame_age);
    }

    // Recording age is evidence, not a live-latency SLA. Continue admitting
    // while the bounded depth still has room so the maintained pressure probe
    // can reproduce the exact 16-frame/~528ms incident shape. Once full, skip
    // only pre-encode ticks while downstream progress remains recent. Existing
    // encoded access units stay ordered and retained throughout the pause.
    if queue_depth < policy.max_frames as u64 {
        return EncoderBridgePreEncodeAdmission::Submit;
    }
    if last_progress_age < RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT {
        EncoderBridgePreEncodeAdmission::PauseRecordingFrame
    } else {
        EncoderBridgePreEncodeAdmission::FailOutput
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncoderBridgeOverBudgetEscalation {
    /// Keep the stream output alive: drop pre-encode like coalescing and re-check.
    Degrade,
    /// The violation is sustained (or the queue truly full): fail the output.
    Fail,
}

/// Stream output DEGRADES under transient pressure — its latest-wins
/// coalescing makes dropped frames an honest, visible quality trade.
/// Recording uses the separate progress-aware admission policy above.
/// A single over-age sample used to kill a recording outright — the
/// 2026-07-16 owner incident lost a 4K session 2s in at "oldest 251/250ms"
/// while the encoder was merely warming up (depth 6/16, still progressing).
fn encoder_bridge_over_budget_escalation(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    over_budget_since: Instant,
    now: Instant,
) -> EncoderBridgeOverBudgetEscalation {
    // A queue at its frame ceiling means the consumer made no progress across
    // the whole depth ladder — that is not jitter.
    if queue_depth >= policy.max_frames as u64 {
        return EncoderBridgeOverBudgetEscalation::Fail;
    }
    if now.duration_since(over_budget_since) >= STREAM_OUTPUT_SUSTAINED_FAIL_WINDOW {
        return EncoderBridgeOverBudgetEscalation::Fail;
    }
    EncoderBridgeOverBudgetEscalation::Degrade
}

fn encoder_bridge_output_pressure_error(
    policy: EncoderBridgeOutputQueuePolicy,
    queue_depth: u64,
    oldest_frame_age: Option<Duration>,
    last_progress_age: Duration,
) -> io::Error {
    let age_ms = oldest_frame_age.map(|age| age.as_millis()).unwrap_or(0);
    let role = encoder_bridge_output_role_label(policy.role);
    let integrity = if policy.role == EncoderBridgeOutputRole::Stream {
        "encoded H.264 access units were preserved; the stream stopped instead of corrupting its reference chain"
    } else {
        "all queued encoded access units were preserved; the recording stopped only after downstream progress ceased"
    };
    if policy.role == EncoderBridgeOutputRole::Stream {
        io::Error::other(format!(
            "{role} encoder output exceeded its bounded latency contract (depth {queue_depth}/{}, oldest {age_ms}/{}ms); {integrity}",
            policy.max_frames,
            policy.max_age.as_millis(),
        ))
    } else {
        io::Error::other(format!(
            "{role} encoder output made no progress for {}ms (limit {}ms; depth {queue_depth}/{}, oldest {age_ms}/{}ms); {integrity}",
            last_progress_age.as_millis(),
            RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT.as_millis(),
            policy.max_frames,
            policy.max_age.as_millis(),
        ))
    }
}

const fn encoder_bridge_output_role_label(role: EncoderBridgeOutputRole) -> &'static str {
    match role {
        EncoderBridgeOutputRole::Recording => "recording",
        EncoderBridgeOutputRole::Stream => "stream",
        EncoderBridgeOutputRole::Shared => "shared recording/stream",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderBridgeOutputProfile {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderBridgeDiagnosticsContext {
    pub role: EncoderBridgeOutputRole,
    pub recording_output: Option<EncoderBridgeOutputProfile>,
    pub stream_output: Option<EncoderBridgeOutputProfile>,
    pub active_video_toolbox_output_encoders: u64,
    pub active_encoded_output_encoders: u64,
    pub separate_output_encoders_active: bool,
}

impl EncoderBridgeDiagnosticsContext {
    pub const fn shared() -> Self {
        Self {
            role: EncoderBridgeOutputRole::Shared,
            recording_output: None,
            stream_output: None,
            active_video_toolbox_output_encoders: 0,
            active_encoded_output_encoders: 0,
            separate_output_encoders_active: false,
        }
    }
}

impl Default for EncoderBridgeDiagnosticsContext {
    fn default() -> Self {
        Self::shared()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EncoderBridgeSettings {
    ffmpeg_path: String,
    output_path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    duration_ms: u64,
    bitrate_kbps: u32,
}

#[derive(Debug, Default, Clone)]
struct EncoderBridgeProgress {
    encoded_fps: Option<f64>,
    encoder_speed: Option<f64>,
    dropped_frames: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct EncoderBridgeRuntimeStats {
    queue_depth: u64,
    /// Peak combined pending encoder + FIFO depth observed this session.
    output_queue_high_water_frames: u64,
    /// Age of the oldest frame awaiting VideoToolbox completion or FIFO write.
    output_queue_oldest_frame_age_ms: Option<u64>,
    /// Peak oldest-frame age observed this session, retained after recovery.
    output_queue_oldest_frame_age_high_water_ms: Option<u64>,
    /// Time since the last encoder completion or complete FIFO AU write.
    output_last_progress_age_ms: Option<u64>,
    /// Number of ticks where a role-specific soft or hard output limit applied.
    output_queue_capacity_pressure_events: u64,
    /// Number of pressured intervals that returned to the healthy queue budget.
    output_pressure_recovery_events: u64,
    /// Frames coalesced before encoding by the stream latest-wins policy.
    /// This does not count encoded H.264 access units.
    output_queue_dropped_frames: u64,
    /// Recording ticks deliberately skipped before encode while queued AUs drain.
    output_pre_encode_skipped_frames: u64,
    /// Current per-stage VideoToolbox callback/in-flight depth.
    video_toolbox_pending_encode_frames: u64,
    /// Current per-stage encoded FIFO writer depth.
    video_toolbox_pending_fifo_frames: u64,
    /// Encoded H.264 AUs rejected after encode. Must remain zero in healthy and
    /// recoverable-pressure sessions.
    encoded_access_unit_dropped_frames: u64,
    input_fps: Option<f64>,
    dropped_frames: u64,
    encoder_speed: Option<f64>,
    /// Compositor frames re-fed to the encoder because no newer frame was ready by the
    /// CFR deadline — these become duplicate frames in the final file (the classic
    /// "frozen capture, ffmpeg duplicates the last frame" failure, now counted).
    repeated_fed_frames: u64,
    /// Number of distinct runs where the bridge re-fed one or more duplicate frames.
    repeated_frame_bursts: u64,
    /// Longest consecutive duplicate re-feed run observed by the bridge.
    max_repeated_frame_run: u64,
    /// Ticks where no usable compositor frame existed and synthetic filler was fed.
    synthetic_fallback_frames: u64,
    /// Max age (ms) of a compositor frame at the moment it was fed to the encoder.
    source_to_encode_age_ms: Option<u64>,
    /// P95 age (ms) of compositor frames at the moment they were fed to the encoder.
    source_to_encode_age_p95_ms: Option<f64>,
    /// P95 age (ms) of compositor frames that were re-fed as duplicate bridge frames.
    repeated_frame_age_p95_ms: Option<f64>,
    /// Max age (ms) of a compositor frame that was re-fed as a duplicate bridge frame.
    repeated_frame_age_max_ms: Option<u64>,
    /// Ticks where the bridge still copied YUV into FFmpeg, but the compositor frame also
    /// exposed an IOSurface-backed Metal target that a future VideoToolbox path can adopt.
    metal_target_frames: u64,
    /// Frames written through the raw-video FFmpeg bridge. Today this is the recording
    /// export hot path; zero-copy VideoToolbox export should drive it to zero.
    raw_video_copied_frames: u64,
    /// Raw-video FFmpeg writes whose source frame also exposed a Metal IOSurface target.
    metal_target_copied_frames: u64,
    /// Raw-video FFmpeg writes whose source frame carried the retained CoreVideo handle.
    metal_target_handle_frames: u64,
    /// Frames submitted to the encoder without a CPU raw-video copy.
    zero_copy_frames: u64,
    /// Retained Metal target frames encoded by the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_frames: u64,
    /// Encoded bytes copied from the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_bytes: u64,
    /// Failed attempts by the opt-in VideoToolbox sidecar probe.
    video_toolbox_probe_errors: u64,
    /// Retained Metal target frames written through the VideoToolbox H.264 output path.
    video_toolbox_output_frames: u64,
    /// Encoded bytes written through the VideoToolbox H.264 output path.
    video_toolbox_output_bytes: u64,
    /// Max inline VideoToolbox encode latency observed by the bridge writer.
    video_toolbox_output_encode_ms: Option<u64>,
    compositor_wait_p95_ms: Option<f64>,
    video_toolbox_submit_p95_ms: Option<f64>,
    /// P95 time the raw-video FIFO worker spent writing one frame into FFmpeg.
    raw_video_fifo_write_p95_ms: Option<f64>,
    video_toolbox_fifo_write_p95_ms: Option<f64>,
    video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    writer_loop_p95_ms: Option<f64>,
    writer_sleep_p95_ms: Option<f64>,
    writer_active_p95_ms: Option<f64>,
    deadline_lag_p95_ms: Option<f64>,
    deadline_lag_max_ms: Option<f64>,
    late_deadline_ticks: u64,
    schedule_skipped_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct EncoderBridgeRoleProcessDiagnostics {
    raw_video_copied_frames: u64,
    dropped_frames: u64,
    encoder_speed: Option<f64>,
    recording_raw_video_copied_frames: u64,
    stream_raw_video_copied_frames: u64,
    recording_dropped_frames: u64,
    stream_dropped_frames: u64,
    recording_encoder_speed: Option<f64>,
    stream_encoder_speed: Option<f64>,
}

/// Generic artifact diagnostics describe the local recording whenever split
/// record/stream encoders are active. The post-recording freeze repair consumes
/// these fields, so a later stream snapshot must neither erase recording
/// evidence with zeroes nor inject stream-only defects into recording policy.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct EncoderBridgeRecordingArtifactDiagnostics {
    input_fps: Option<f64>,
    repeated_fed_frames: u64,
    repeated_frame_bursts: u64,
    max_repeated_frame_run: u64,
    synthetic_fallback_frames: u64,
    source_to_encode_age_ms: Option<u64>,
    source_to_encode_age_p95_ms: Option<f64>,
    repeated_frame_age_p95_ms: Option<f64>,
    repeated_frame_age_max_ms: Option<u64>,
}

impl EncoderBridgeRecordingArtifactDiagnostics {
    fn from_runtime(runtime: EncoderBridgeRuntimeStats) -> Self {
        Self {
            input_fps: runtime.input_fps,
            repeated_fed_frames: runtime.repeated_fed_frames,
            repeated_frame_bursts: runtime.repeated_frame_bursts,
            max_repeated_frame_run: runtime.max_repeated_frame_run,
            synthetic_fallback_frames: runtime.synthetic_fallback_frames,
            source_to_encode_age_ms: runtime.source_to_encode_age_ms,
            source_to_encode_age_p95_ms: runtime.source_to_encode_age_p95_ms,
            repeated_frame_age_p95_ms: runtime.repeated_frame_age_p95_ms,
            repeated_frame_age_max_ms: runtime.repeated_frame_age_max_ms,
        }
    }

    fn from_stats(stats: &DiagnosticStats) -> Self {
        Self {
            input_fps: stats.encoder_bridge_input_fps,
            repeated_fed_frames: stats.encoder_bridge_repeated_frames,
            repeated_frame_bursts: stats.encoder_bridge_repeated_frame_bursts,
            max_repeated_frame_run: stats.encoder_bridge_max_repeated_frame_run,
            synthetic_fallback_frames: stats.encoder_bridge_synthetic_frames,
            source_to_encode_age_ms: stats.encoder_bridge_source_age_ms,
            source_to_encode_age_p95_ms: stats.encoder_bridge_source_age_p95_ms,
            repeated_frame_age_p95_ms: stats.encoder_bridge_repeated_frame_age_p95_ms,
            repeated_frame_age_max_ms: stats.encoder_bridge_repeated_frame_age_max_ms,
        }
    }
}

fn merge_encoder_bridge_recording_artifact_diagnostics(
    base: &DiagnosticStats,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeRecordingArtifactDiagnostics {
    if diagnostics_context.separate_output_encoders_active
        && diagnostics_context.recording_output.is_some()
        && effective_encoder_bridge_output_role(diagnostics_context)
            == EncoderBridgeOutputRole::Stream
    {
        EncoderBridgeRecordingArtifactDiagnostics::from_stats(base)
    } else {
        EncoderBridgeRecordingArtifactDiagnostics::from_runtime(runtime)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct EncoderBridgeMergedRoleDiagnostics {
    recording: EncoderBridgeRoleDiagnosticStats,
    stream: EncoderBridgeRoleDiagnosticStats,
    aggregate: EncoderBridgeRoleDiagnosticStats,
}

fn runtime_role_diagnostics(
    runtime: EncoderBridgeRuntimeStats,
) -> EncoderBridgeRoleDiagnosticStats {
    EncoderBridgeRoleDiagnosticStats {
        metal_target_frames: runtime.metal_target_frames,
        metal_target_copied_frames: runtime.metal_target_copied_frames,
        metal_target_handle_frames: runtime.metal_target_handle_frames,
        zero_copy_frames: runtime.zero_copy_frames,
        video_toolbox_probe_frames: runtime.video_toolbox_probe_frames,
        video_toolbox_probe_bytes: runtime.video_toolbox_probe_bytes,
        video_toolbox_probe_errors: runtime.video_toolbox_probe_errors,
        video_toolbox_output_encode_ms: runtime.video_toolbox_output_encode_ms,
        compositor_wait_p95_ms: runtime.compositor_wait_p95_ms,
        video_toolbox_submit_p95_ms: runtime.video_toolbox_submit_p95_ms,
        raw_video_fifo_write_p95_ms: runtime.raw_video_fifo_write_p95_ms,
        video_toolbox_fifo_write_p95_ms: runtime.video_toolbox_fifo_write_p95_ms,
        video_toolbox_fifo_enqueue_p95_ms: runtime.video_toolbox_fifo_enqueue_p95_ms,
        video_toolbox_fifo_enqueue_max_ms: runtime.video_toolbox_fifo_enqueue_max_ms,
        writer_loop_p95_ms: runtime.writer_loop_p95_ms,
        writer_sleep_p95_ms: runtime.writer_sleep_p95_ms,
        writer_active_p95_ms: runtime.writer_active_p95_ms,
        deadline_lag_p95_ms: runtime.deadline_lag_p95_ms,
        deadline_lag_max_ms: runtime.deadline_lag_max_ms,
        late_deadline_ticks: runtime.late_deadline_ticks,
        schedule_skipped_ms: runtime.schedule_skipped_ms,
    }
}

fn max_optional_f64(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn role_diagnostics_high_water(
    previous: EncoderBridgeRoleDiagnosticStats,
    current: EncoderBridgeRoleDiagnosticStats,
) -> EncoderBridgeRoleDiagnosticStats {
    EncoderBridgeRoleDiagnosticStats {
        metal_target_frames: previous
            .metal_target_frames
            .max(current.metal_target_frames),
        metal_target_copied_frames: previous
            .metal_target_copied_frames
            .max(current.metal_target_copied_frames),
        metal_target_handle_frames: previous
            .metal_target_handle_frames
            .max(current.metal_target_handle_frames),
        zero_copy_frames: previous.zero_copy_frames.max(current.zero_copy_frames),
        video_toolbox_probe_frames: previous
            .video_toolbox_probe_frames
            .max(current.video_toolbox_probe_frames),
        video_toolbox_probe_bytes: previous
            .video_toolbox_probe_bytes
            .max(current.video_toolbox_probe_bytes),
        video_toolbox_probe_errors: previous
            .video_toolbox_probe_errors
            .max(current.video_toolbox_probe_errors),
        video_toolbox_output_encode_ms: max_optional_u64(
            previous.video_toolbox_output_encode_ms,
            current.video_toolbox_output_encode_ms,
        ),
        compositor_wait_p95_ms: max_optional_f64(
            previous.compositor_wait_p95_ms,
            current.compositor_wait_p95_ms,
        ),
        video_toolbox_submit_p95_ms: max_optional_f64(
            previous.video_toolbox_submit_p95_ms,
            current.video_toolbox_submit_p95_ms,
        ),
        raw_video_fifo_write_p95_ms: max_optional_f64(
            previous.raw_video_fifo_write_p95_ms,
            current.raw_video_fifo_write_p95_ms,
        ),
        video_toolbox_fifo_write_p95_ms: max_optional_f64(
            previous.video_toolbox_fifo_write_p95_ms,
            current.video_toolbox_fifo_write_p95_ms,
        ),
        video_toolbox_fifo_enqueue_p95_ms: max_optional_f64(
            previous.video_toolbox_fifo_enqueue_p95_ms,
            current.video_toolbox_fifo_enqueue_p95_ms,
        ),
        video_toolbox_fifo_enqueue_max_ms: max_optional_f64(
            previous.video_toolbox_fifo_enqueue_max_ms,
            current.video_toolbox_fifo_enqueue_max_ms,
        ),
        writer_loop_p95_ms: max_optional_f64(
            previous.writer_loop_p95_ms,
            current.writer_loop_p95_ms,
        ),
        writer_sleep_p95_ms: max_optional_f64(
            previous.writer_sleep_p95_ms,
            current.writer_sleep_p95_ms,
        ),
        writer_active_p95_ms: max_optional_f64(
            previous.writer_active_p95_ms,
            current.writer_active_p95_ms,
        ),
        deadline_lag_p95_ms: max_optional_f64(
            previous.deadline_lag_p95_ms,
            current.deadline_lag_p95_ms,
        ),
        deadline_lag_max_ms: max_optional_f64(
            previous.deadline_lag_max_ms,
            current.deadline_lag_max_ms,
        ),
        late_deadline_ticks: previous
            .late_deadline_ticks
            .max(current.late_deadline_ticks),
        schedule_skipped_ms: previous
            .schedule_skipped_ms
            .max(current.schedule_skipped_ms),
    }
}

fn aggregate_role_diagnostics(
    recording: EncoderBridgeRoleDiagnosticStats,
    stream: EncoderBridgeRoleDiagnosticStats,
) -> EncoderBridgeRoleDiagnosticStats {
    EncoderBridgeRoleDiagnosticStats {
        metal_target_frames: recording
            .metal_target_frames
            .saturating_add(stream.metal_target_frames),
        metal_target_copied_frames: recording
            .metal_target_copied_frames
            .saturating_add(stream.metal_target_copied_frames),
        metal_target_handle_frames: recording
            .metal_target_handle_frames
            .saturating_add(stream.metal_target_handle_frames),
        zero_copy_frames: recording
            .zero_copy_frames
            .saturating_add(stream.zero_copy_frames),
        video_toolbox_probe_frames: recording
            .video_toolbox_probe_frames
            .saturating_add(stream.video_toolbox_probe_frames),
        video_toolbox_probe_bytes: recording
            .video_toolbox_probe_bytes
            .saturating_add(stream.video_toolbox_probe_bytes),
        video_toolbox_probe_errors: recording
            .video_toolbox_probe_errors
            .saturating_add(stream.video_toolbox_probe_errors),
        video_toolbox_output_encode_ms: max_optional_u64(
            recording.video_toolbox_output_encode_ms,
            stream.video_toolbox_output_encode_ms,
        ),
        compositor_wait_p95_ms: max_optional_f64(
            recording.compositor_wait_p95_ms,
            stream.compositor_wait_p95_ms,
        ),
        video_toolbox_submit_p95_ms: max_optional_f64(
            recording.video_toolbox_submit_p95_ms,
            stream.video_toolbox_submit_p95_ms,
        ),
        raw_video_fifo_write_p95_ms: max_optional_f64(
            recording.raw_video_fifo_write_p95_ms,
            stream.raw_video_fifo_write_p95_ms,
        ),
        video_toolbox_fifo_write_p95_ms: max_optional_f64(
            recording.video_toolbox_fifo_write_p95_ms,
            stream.video_toolbox_fifo_write_p95_ms,
        ),
        video_toolbox_fifo_enqueue_p95_ms: max_optional_f64(
            recording.video_toolbox_fifo_enqueue_p95_ms,
            stream.video_toolbox_fifo_enqueue_p95_ms,
        ),
        video_toolbox_fifo_enqueue_max_ms: max_optional_f64(
            recording.video_toolbox_fifo_enqueue_max_ms,
            stream.video_toolbox_fifo_enqueue_max_ms,
        ),
        writer_loop_p95_ms: max_optional_f64(
            recording.writer_loop_p95_ms,
            stream.writer_loop_p95_ms,
        ),
        writer_sleep_p95_ms: max_optional_f64(
            recording.writer_sleep_p95_ms,
            stream.writer_sleep_p95_ms,
        ),
        writer_active_p95_ms: max_optional_f64(
            recording.writer_active_p95_ms,
            stream.writer_active_p95_ms,
        ),
        deadline_lag_p95_ms: max_optional_f64(
            recording.deadline_lag_p95_ms,
            stream.deadline_lag_p95_ms,
        ),
        deadline_lag_max_ms: max_optional_f64(
            recording.deadline_lag_max_ms,
            stream.deadline_lag_max_ms,
        ),
        late_deadline_ticks: recording
            .late_deadline_ticks
            .saturating_add(stream.late_deadline_ticks),
        schedule_skipped_ms: recording
            .schedule_skipped_ms
            .saturating_add(stream.schedule_skipped_ms),
    }
}

fn merge_encoder_bridge_role_diagnostics(
    base: &DiagnosticStats,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeMergedRoleDiagnostics {
    let current = runtime_role_diagnostics(runtime);
    if !diagnostics_context.separate_output_encoders_active {
        return EncoderBridgeMergedRoleDiagnostics {
            recording: Default::default(),
            stream: Default::default(),
            aggregate: current,
        };
    }

    let mut recording = base.encoder_bridge_recording_role_diagnostics;
    let mut stream = base.encoder_bridge_stream_role_diagnostics;
    match effective_encoder_bridge_output_role(diagnostics_context) {
        EncoderBridgeOutputRole::Recording => {
            recording = role_diagnostics_high_water(recording, current);
        }
        EncoderBridgeOutputRole::Stream => {
            stream = role_diagnostics_high_water(stream, current);
        }
        EncoderBridgeOutputRole::Shared => {
            debug_assert!(
                false,
                "a shared bridge cannot report separate output encoders"
            );
        }
    }
    EncoderBridgeMergedRoleDiagnostics {
        recording,
        stream,
        aggregate: aggregate_role_diagnostics(recording, stream),
    }
}

fn encoder_bridge_recording_diagnostics_target_fps(
    target_fps: u32,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> u32 {
    if diagnostics_context.separate_output_encoders_active {
        diagnostics_context
            .recording_output
            .map_or(target_fps, |output| output.fps)
    } else {
        target_fps
    }
}

fn merge_encoder_bridge_recording_error(
    base: &DiagnosticStats,
    error: Option<String>,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> Option<String> {
    if diagnostics_context.separate_output_encoders_active
        && diagnostics_context.recording_output.is_some()
    {
        if effective_encoder_bridge_output_role(diagnostics_context)
            == EncoderBridgeOutputRole::Stream
        {
            return base.encoder_bridge_error.clone();
        }
        return error.or_else(|| base.encoder_bridge_error.clone());
    }
    error
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EncoderBridgeMergedOutputPressure {
    recording: EncoderBridgeRoleOutputPressureStats,
    stream: EncoderBridgeRoleOutputPressureStats,
    aggregate: EncoderBridgeRoleOutputPressureStats,
}

fn runtime_output_pressure(
    runtime: EncoderBridgeRuntimeStats,
) -> EncoderBridgeRoleOutputPressureStats {
    EncoderBridgeRoleOutputPressureStats {
        output_queue_high_water_frames: runtime.output_queue_high_water_frames,
        output_queue_oldest_frame_age_high_water_ms: runtime
            .output_queue_oldest_frame_age_high_water_ms,
        output_last_progress_age_ms: runtime.output_last_progress_age_ms,
        output_pressure_recovery_events: runtime.output_pressure_recovery_events,
        output_pre_encode_skipped_frames: runtime.output_pre_encode_skipped_frames,
        video_toolbox_pending_encode_frames: runtime.video_toolbox_pending_encode_frames,
        video_toolbox_pending_fifo_frames: runtime.video_toolbox_pending_fifo_frames,
        encoded_access_unit_dropped_frames: runtime.encoded_access_unit_dropped_frames,
    }
}

/// A bridge that has exited has no current queue or VideoToolbox stage depth.
/// Keep cumulative/high-water incident evidence, but do not let one stopped
/// split-output role make the surviving role look permanently backlogged.
fn mark_encoder_bridge_output_inactive(
    mut runtime: EncoderBridgeRuntimeStats,
) -> EncoderBridgeRuntimeStats {
    runtime.queue_depth = 0;
    runtime.output_queue_oldest_frame_age_ms = None;
    runtime.output_last_progress_age_ms = None;
    runtime.video_toolbox_pending_encode_frames = 0;
    runtime.video_toolbox_pending_fifo_frames = 0;
    runtime
}

fn max_optional_u64(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn aggregate_output_pressure(
    recording: EncoderBridgeRoleOutputPressureStats,
    stream: EncoderBridgeRoleOutputPressureStats,
) -> EncoderBridgeRoleOutputPressureStats {
    EncoderBridgeRoleOutputPressureStats {
        output_queue_high_water_frames: recording
            .output_queue_high_water_frames
            .max(stream.output_queue_high_water_frames),
        output_queue_oldest_frame_age_high_water_ms: max_optional_u64(
            recording.output_queue_oldest_frame_age_high_water_ms,
            stream.output_queue_oldest_frame_age_high_water_ms,
        ),
        output_last_progress_age_ms: max_optional_u64(
            recording.output_last_progress_age_ms,
            stream.output_last_progress_age_ms,
        ),
        output_pressure_recovery_events: recording
            .output_pressure_recovery_events
            .saturating_add(stream.output_pressure_recovery_events),
        output_pre_encode_skipped_frames: recording
            .output_pre_encode_skipped_frames
            .saturating_add(stream.output_pre_encode_skipped_frames),
        video_toolbox_pending_encode_frames: recording
            .video_toolbox_pending_encode_frames
            .saturating_add(stream.video_toolbox_pending_encode_frames),
        video_toolbox_pending_fifo_frames: recording
            .video_toolbox_pending_fifo_frames
            .saturating_add(stream.video_toolbox_pending_fifo_frames),
        encoded_access_unit_dropped_frames: recording
            .encoded_access_unit_dropped_frames
            .saturating_add(stream.encoded_access_unit_dropped_frames),
    }
}

fn merge_encoder_bridge_role_output_pressure(
    base: &DiagnosticStats,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeMergedOutputPressure {
    if !diagnostics_context.separate_output_encoders_active {
        return EncoderBridgeMergedOutputPressure {
            recording: Default::default(),
            stream: Default::default(),
            aggregate: runtime_output_pressure(runtime),
        };
    }

    let mut recording = base.encoder_bridge_recording_output_pressure;
    let mut stream = base.encoder_bridge_stream_output_pressure;
    match effective_encoder_bridge_output_role(diagnostics_context) {
        EncoderBridgeOutputRole::Recording => recording = runtime_output_pressure(runtime),
        EncoderBridgeOutputRole::Stream => stream = runtime_output_pressure(runtime),
        EncoderBridgeOutputRole::Shared => {
            debug_assert!(
                false,
                "a shared bridge cannot report separate output encoders"
            );
        }
    }

    EncoderBridgeMergedOutputPressure {
        recording,
        stream,
        aggregate: aggregate_output_pressure(recording, stream),
    }
}

fn merge_encoder_bridge_role_process_diagnostics(
    base: &DiagnosticStats,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
) -> EncoderBridgeRoleProcessDiagnostics {
    let mut recording_raw_video_copied_frames =
        base.encoder_bridge_recording_raw_video_copied_frames;
    let mut stream_raw_video_copied_frames = base.encoder_bridge_stream_raw_video_copied_frames;
    let mut recording_dropped_frames = base.encoder_bridge_recording_dropped_frames;
    let mut stream_dropped_frames = base.encoder_bridge_stream_dropped_frames;
    let mut recording_encoder_speed = base.encoder_bridge_recording_encoder_speed;
    let mut stream_encoder_speed = base.encoder_bridge_stream_encoder_speed;

    match effective_encoder_bridge_output_role(diagnostics_context) {
        EncoderBridgeOutputRole::Recording => {
            recording_raw_video_copied_frames = runtime.raw_video_copied_frames;
            recording_dropped_frames = runtime.dropped_frames;
            recording_encoder_speed = runtime.encoder_speed;
        }
        EncoderBridgeOutputRole::Stream => {
            stream_raw_video_copied_frames = runtime.raw_video_copied_frames;
            stream_dropped_frames = runtime.dropped_frames;
            stream_encoder_speed = runtime.encoder_speed;
        }
        EncoderBridgeOutputRole::Shared => {
            if diagnostics_context.recording_output.is_some() {
                recording_raw_video_copied_frames = runtime.raw_video_copied_frames;
                recording_dropped_frames = runtime.dropped_frames;
                recording_encoder_speed = runtime.encoder_speed;
            }
            if diagnostics_context.stream_output.is_some() {
                stream_raw_video_copied_frames = runtime.raw_video_copied_frames;
                stream_dropped_frames = runtime.dropped_frames;
                stream_encoder_speed = runtime.encoder_speed;
            }
        }
    }

    let slower_speed = |left: Option<f64>, right: Option<f64>| match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    let (raw_video_copied_frames, dropped_frames, encoder_speed) =
        if diagnostics_context.separate_output_encoders_active {
            (
                recording_raw_video_copied_frames.saturating_add(stream_raw_video_copied_frames),
                recording_dropped_frames.saturating_add(stream_dropped_frames),
                slower_speed(recording_encoder_speed, stream_encoder_speed),
            )
        } else {
            (
                runtime.raw_video_copied_frames,
                runtime.dropped_frames,
                runtime.encoder_speed,
            )
        };

    EncoderBridgeRoleProcessDiagnostics {
        raw_video_copied_frames,
        dropped_frames,
        encoder_speed,
        recording_raw_video_copied_frames,
        stream_raw_video_copied_frames,
        recording_dropped_frames,
        stream_dropped_frames,
        recording_encoder_speed,
        stream_encoder_speed,
    }
}

/// A compositor frame fed into the encoder FIFO on one tick.
#[derive(Clone)]
struct FedCompositorFrame {
    /// Retains the compositor's immutable allocation through FIFO delivery. Raw
    /// output writes these bytes directly instead of copying them into a second
    /// full-frame bridge buffer.
    frame: CompositorFrameHandle,
    sequence: u64,
    captured_at: Instant,
    age_ms: u64,
    has_metal_iosurface_target: bool,
    has_metal_export_handle: bool,
    #[cfg(target_os = "macos")]
    metal_target: Option<Arc<crate::metal_compositor::MetalCompositorTargetPixelBuffer>>,
}

/// How one encoder-bridge tick consumed a compositor frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeFrameSource {
    /// A fresh compositor frame whose sequence advanced past the last fed one.
    Fresh,
    /// The same compositor frame as the previous tick — re-encoded as a CFR duplicate.
    Repeated,
    /// No usable compositor frame; synthetic filler was fed.
    SyntheticFallback,
}

impl BridgeFrameSource {
    const fn accounting_kind(self) -> crate::diagnostics::BridgeInputKind {
        match self {
            Self::Fresh => crate::diagnostics::BridgeInputKind::Fresh,
            Self::Repeated => crate::diagnostics::BridgeInputKind::Repeated,
            Self::SyntheticFallback => crate::diagnostics::BridgeInputKind::Synthetic,
        }
    }
}

/// Steady-state cap for the bridge writer's Media Foundation input-credit
/// wait: two frame intervals. A stalled MFT then costs one skipped (counted)
/// frame instead of freezing the CFR schedule for the encoder's 3 s event
/// timeout (tester: 119 encoded frames in 6.7 s at 1080p60).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn media_foundation_writer_input_credit_timeout(target_fps: u32) -> Duration {
    Duration::from_secs_f64(2.0 / f64::from(target_fps.max(1)))
}

/// Classify a tick from the sequence of the frame it fed versus the last fed sequence.
/// A repeat means the compositor did not publish a new frame before the encoder's CFR
/// deadline, so the previous frame's bytes are encoded again as a duplicate.
fn classify_bridge_frame(last_fed: Option<u64>, fed: Option<u64>) -> BridgeFrameSource {
    match fed {
        None => BridgeFrameSource::SyntheticFallback,
        Some(sequence) => match last_fed {
            Some(previous) if previous == sequence => BridgeFrameSource::Repeated,
            _ => BridgeFrameSource::Fresh,
        },
    }
}

/// Lag past which the schedule stops trying to catch up frame-by-frame and
/// re-anchors with an explicit counted wall-time gap (app nap, display sleep).
/// Raw FIFO frames are demuxed with wall-clock PTS, so they can use the same
/// honest re-anchor as timestamped encoded outputs.
const ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD: Duration = Duration::from_secs(2);

/// Per-tick schedule decision (plan 026). The writer schedule is ABSOLUTE
/// (`next_frame_at += interval`); wall time is never silently dropped. The old
/// re-anchor (`next_frame_at = now + interval` whenever a tick overran) deleted
/// the overshoot from the video timeline every iteration — the encoder emitted
/// fewer than fps frames per wall second while stamping exact-CFR PTS, so video
/// ran fast and audio drifted late (~0.6-0.8s/min on macOS; ~8% timeline
/// compression on the first real Windows artifact, 2026-07-09).
#[derive(Debug, PartialEq, Eq)]
struct BridgeTickPlan {
    /// The loop is at/past its deadline: skip the fresh-frame wait and feed the
    /// latest available frame immediately (a repeat if unchanged) so the
    /// schedule converges instead of compressing.
    skip_fresh_wait: bool,
    /// Whole intervals dropped from the schedule as an explicit stall gap.
    /// Zero in every healthy tick.
    reanchor_skipped_intervals: u64,
}

fn plan_bridge_tick(lag: Duration, frame_interval: Duration) -> BridgeTickPlan {
    if frame_interval.is_zero() {
        return BridgeTickPlan {
            skip_fresh_wait: false,
            reanchor_skipped_intervals: 0,
        };
    }
    if lag >= ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD {
        let skipped = (lag.as_nanos() / frame_interval.as_nanos()) as u64;
        return BridgeTickPlan {
            skip_fresh_wait: true,
            reanchor_skipped_intervals: skipped,
        };
    }
    BridgeTickPlan {
        skip_fresh_wait: lag > Duration::ZERO,
        reanchor_skipped_intervals: 0,
    }
}

fn compositor_frame_wait_budget(
    video_output: EncoderBridgeVideoOutput,
    consecutive_repeated_frames: u64,
    frame_interval: Duration,
) -> Duration {
    if video_output.uses_encoded_h264() {
        // Wait for a fresh compositor target, but never spend the whole CFR interval.
        // VideoToolbox encoding and FIFO writes must keep a little headroom or the bridge
        // falls behind real time and starts feeding visible duplicates.
        return videotoolbox_fresh_frame_grace(frame_interval);
    }
    if consecutive_repeated_frames > 0 {
        frame_interval + frame_interval
    } else {
        frame_interval
    }
}

fn videotoolbox_fresh_frame_grace(frame_interval: Duration) -> Duration {
    frame_interval.saturating_sub(VIDEOTOOLBOX_FRESH_FRAME_HEADROOM)
}

fn record_encoder_bridge_terminal_failure(
    signal: &Arc<StdMutex<Option<String>>>,
    message: impl Into<String>,
) -> String {
    let mut failure = signal
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    failure.get_or_insert_with(|| message.into()).clone()
}

fn read_encoder_bridge_terminal_failure(signal: &Arc<StdMutex<Option<String>>>) -> Option<String> {
    signal
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[derive(Debug, Default)]
struct EncoderBridgeDrainState {
    downstream_closed: bool,
}

impl EncoderBridgeDrainState {
    fn observe_error(&mut self, error: &io::Error) -> bool {
        let downstream_closed = io_error_is_downstream_closed(error);
        self.downstream_closed |= downstream_closed;
        downstream_closed
    }

    fn pending_timeout_is_terminal(
        &self,
        pending_video_toolbox_frames: u64,
        pending_fifo_frames: u64,
    ) -> bool {
        !self.downstream_closed && (pending_video_toolbox_frames > 0 || pending_fifo_frames > 0)
    }

    fn record_main_loop_error(
        &mut self,
        terminal_failure: &Arc<StdMutex<Option<String>>>,
        role: EncoderBridgeOutputRole,
        error: &io::Error,
    ) -> String {
        if self.observe_error(error) {
            format!(
                "{} encoder output ended: downstream closed ({error})",
                encoder_bridge_output_role_label(role)
            )
        } else {
            record_encoder_bridge_terminal_failure(
                terminal_failure,
                format!(
                    "{} encoder output stopped: {error}",
                    encoder_bridge_output_role_label(role)
                ),
            )
        }
    }

    fn record_video_toolbox_loop_error(
        &mut self,
        terminal_failure: &Arc<StdMutex<Option<String>>>,
        role: EncoderBridgeOutputRole,
        error: &io::Error,
    ) -> String {
        if self.observe_error(error) {
            format!(
                "{} VideoToolbox output ended: downstream closed ({error})",
                encoder_bridge_output_role_label(role)
            )
        } else {
            record_encoder_bridge_terminal_failure(
                terminal_failure,
                format!(
                    "{} VideoToolbox output stopped: {error}",
                    encoder_bridge_output_role_label(role)
                ),
            )
        }
    }
}

fn signal_encoder_bridge_startup(
    sender: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    result: std::result::Result<(), String>,
) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}

#[derive(Debug)]
pub struct EncoderBridgeRecordingSession {
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    startup_ready: Option<oneshot::Receiver<std::result::Result<(), String>>>,
    fifo_path: PathBuf,
    writer: Option<thread::JoinHandle<()>>,
    diagnostics_task: Option<TokioJoinHandle<()>>,
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
    #[cfg(target_os = "windows")]
    d3d11_input: Option<WindowsD3d11EncoderTicketSource>,
}

impl EncoderBridgeRecordingSession {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(lifecycle) = self.lifecycle.as_ref() {
            lifecycle.stop_signalled();
        }
    }

    /// Deterministic teardown: signal stop, then reap the writer thread within
    /// `deadline`. The report preserves terminal failures learned while the
    /// writer drains and keeps detached children visible to later admission.
    #[cfg(test)]
    fn stop_and_reap(self, deadline: Duration) -> EncoderBridgeShutdownReport {
        self.stop_and_reap_until(Instant::now() + deadline)
    }

    pub fn stop_and_reap_until(mut self, deadline_at: Instant) -> EncoderBridgeShutdownReport {
        let started_at = Instant::now();
        self.stop();
        let outer_reaped = self.reap_writer_until(deadline_at);
        if let Some(task) = self.diagnostics_task.take() {
            task.abort();
        }
        let detached = !outer_reaped
            || self
                .lifecycle
                .as_ref()
                .is_some_and(EncoderBridgeWriterLifecycle::detached_ever);
        EncoderBridgeShutdownReport {
            writer_id: self
                .lifecycle
                .as_ref()
                .map(|lifecycle| lifecycle.writer_id.clone()),
            session_id: self
                .lifecycle
                .as_ref()
                .map(|lifecycle| lifecycle.session_id.clone()),
            role: self.lifecycle.as_ref().map(|lifecycle| lifecycle.role),
            reaped: outer_reaped && !detached,
            detached,
            terminal_failure: self.terminal_failure(),
            teardown_duration_ms: started_at.elapsed().as_millis() as u64,
            lifecycle: encoder_bridge_lifecycle_snapshot(),
        }
    }

    fn reap_writer_until(&mut self, deadline_at: Instant) -> bool {
        let Some(writer) = self.writer.take() else {
            return true;
        };
        while !writer.is_finished() {
            let now = Instant::now();
            if now >= deadline_at {
                // Dropping the JoinHandle detaches the thread. The lifecycle
                // registry retains ownership until the actual outer/FIFO
                // guards leave, so the next recording still fails admission.
                drop(writer);
                if let Some(lifecycle) = self.lifecycle.as_ref() {
                    lifecycle.mark_detached();
                }
                return false;
            }
            thread::sleep((deadline_at - now).min(Duration::from_millis(25)));
        }
        let _ = writer.join();
        true
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn stop_and_join_writer(&mut self) {
        self.stop();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }

    /// Returns the first terminal media-path failure reported by the bridge.
    ///
    /// FFmpeg can exit successfully after the bridge closes its FIFO at a
    /// complete raw-video frame boundary. Recording finalization must inspect
    /// this signal so that a shortened file is not published as successful.
    pub fn terminal_failure(&self) -> Option<String> {
        read_encoder_bridge_terminal_failure(&self.terminal_failure)
    }

    pub async fn wait_until_ready(&mut self) -> Result<()> {
        let Some(startup_ready) = self.startup_ready.take() else {
            return Ok(());
        };
        match tokio::time::timeout(Duration::from_secs(4), startup_ready).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(message))) => bail!(message),
            Ok(Err(_)) => bail!("Encoder bridge stopped before its first frame was ready"),
            Err(_) => bail!("Encoder bridge first-frame priming timed out"),
        }
    }

    #[cfg(test)]
    pub(crate) fn blocked_for_lifecycle_test(
        session_id: &str,
        role: EncoderBridgeOutputRole,
    ) -> (Self, Arc<AtomicBool>, std_mpsc::Sender<()>) {
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(session_id, role);
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
        let (release_tx, release_rx) = std_mpsc::channel();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle,
            };
            ready_tx.send(()).expect("publish blocked writer readiness");
            release_rx.recv().expect("release blocked writer");
        });
        ready_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("blocked lifecycle test writer became live");
        (
            Self {
                stop: stop.clone(),
                terminal_failure: Arc::new(StdMutex::new(None)),
                startup_ready: None,
                fifo_path: PathBuf::from("/nonexistent-test-fifo"),
                writer: Some(writer),
                diagnostics_task: None,
                lifecycle: Some(lifecycle),
                #[cfg(target_os = "windows")]
                d3d11_input: None,
            },
            stop,
            release_tx,
        )
    }

    #[cfg(target_os = "windows")]
    #[allow(dead_code)]
    pub(crate) fn latest_d3d11_input_ticket(
        &self,
    ) -> Option<crate::windows_d3d11_device::WindowsD3d11TextureLeaseTicket> {
        self.d3d11_input
            .as_ref()?
            .latest_ticket()
            .map(|(_, _, ticket)| ticket)
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn replace_d3d11_input_generation(
        &self,
        expected_generation: u64,
        replacement: &WindowsD3d11EncoderTicketSource,
    ) -> Result<bool, String> {
        self.d3d11_input
            .as_ref()
            .ok_or_else(|| "encoder bridge has no unified D3D11 ticket source".to_string())?
            .replace_generation(expected_generation, replacement)
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn can_replace_d3d11_input_generation(
        &self,
        expected_generation: u64,
        replacement: &WindowsD3d11EncoderTicketSource,
    ) -> Result<bool, String> {
        self.d3d11_input
            .as_ref()
            .ok_or_else(|| "encoder bridge has no unified D3D11 ticket source".to_string())?
            .can_replace_generation(expected_generation, replacement)
    }
}

impl Drop for EncoderBridgeRecordingSession {
    fn drop(&mut self) {
        // Explicit recording exits use `begin_encoder_bridge_shutdown`, but a
        // partially constructed or panicking owner can still reach Drop. Keep
        // that last-resort cleanup bounded so Drop can never restore the old
        // unbounded process-shutdown/startup-failure hang.
        const DROP_JOIN_GRACE: Duration = Duration::from_millis(250);
        self.stop();
        self.reap_writer_until(Instant::now() + DROP_JOIN_GRACE);
        if let Some(task) = self.diagnostics_task.take() {
            task.abort();
        }
        let _ = crate::fifo::cleanup(&self.fifo_path);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderBridgeShutdownReport {
    pub writer_id: Option<String>,
    pub session_id: Option<String>,
    pub role: Option<EncoderBridgeOutputRole>,
    pub reaped: bool,
    pub detached: bool,
    pub terminal_failure: Option<String>,
    pub teardown_duration_ms: u64,
    pub lifecycle: EncoderBridgeLifecycleSnapshot,
}

/// A signal-all/reap-all teardown begun against one absolute deadline.
/// Lifecycle transitions are buffered without I/O while the deadline is live;
/// callers persist the returned drain only after `finish` completes.
pub struct EncoderBridgeShutdownBatch {
    started_at: Instant,
    reap_task: Option<TokioJoinHandle<Vec<EncoderBridgeShutdownReport>>>,
    persistence_gate: EncoderBridgeLifecyclePersistenceGate,
}

#[derive(Debug, Default)]
pub struct EncoderBridgeShutdownBatchReport {
    pub reports: Vec<EncoderBridgeShutdownReport>,
    pub lifecycle: EncoderBridgeLifecycleSnapshot,
    pub teardown_duration_ms: u64,
    pub task_error: Option<String>,
}

pub struct EncoderBridgeLifecyclePersistenceGate {
    gates: Vec<Arc<EncoderBridgeLifecyclePersistenceGateState>>,
    released: bool,
}

impl EncoderBridgeLifecyclePersistenceGate {
    fn release(&mut self) {
        if self.released {
            return;
        }
        for gate in &self.gates {
            gate.open();
        }
        self.released = true;
    }
}

impl Drop for EncoderBridgeLifecyclePersistenceGate {
    fn drop(&mut self) {
        self.release();
    }
}

pub fn gate_encoder_bridge_lifecycle_persistence<'a>(
    sessions: impl IntoIterator<Item = &'a EncoderBridgeRecordingSession>,
) -> EncoderBridgeLifecyclePersistenceGate {
    let gates = sessions
        .into_iter()
        .filter_map(|session| session.lifecycle.as_ref())
        .map(|lifecycle| lifecycle.persistence_gate())
        .collect::<Vec<_>>();
    for gate in &gates {
        gate.close();
    }
    EncoderBridgeLifecyclePersistenceGate {
        gates,
        released: false,
    }
}

pub fn begin_encoder_bridge_shutdown(
    sessions: Vec<EncoderBridgeRecordingSession>,
    deadline: Duration,
) -> Option<EncoderBridgeShutdownBatch> {
    if sessions.is_empty() {
        return None;
    }
    let started_at = Instant::now();
    let deadline_at = started_at + deadline;
    let persistence_gate = gate_encoder_bridge_lifecycle_persistence(&sessions);
    // Signal every leg before spawning the blocking reap and before callers
    // drop any other ActiveRecording-owned resource.
    for session in &sessions {
        session.stop();
    }
    let reap_task = tokio::task::spawn_blocking(move || {
        sessions
            .into_iter()
            .map(|session| session.stop_and_reap_until(deadline_at))
            .collect()
    });
    Some(EncoderBridgeShutdownBatch {
        started_at,
        reap_task: Some(reap_task),
        persistence_gate,
    })
}

impl EncoderBridgeShutdownBatch {
    pub async fn finish(mut self) -> EncoderBridgeShutdownBatchReport {
        let (reports, task_error) = match self
            .reap_task
            .take()
            .expect("encoder bridge reap task exists")
            .await
        {
            Ok(reports) => (reports, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        // Release only after the blocking reap resolves. The autonomous worker
        // may now persist all queued transitions; late detached exits use the
        // same already-open gate and persist without another recording.
        self.persistence_gate.release();
        EncoderBridgeShutdownBatchReport {
            reports,
            lifecycle: encoder_bridge_lifecycle_snapshot(),
            teardown_duration_ms: self.started_at.elapsed().as_millis() as u64,
            task_error,
        }
    }
}

pub async fn run_synthetic_encoder_bridge(
    state: AppState,
    params: EncoderBridgeSyntheticParams,
) -> Result<EncoderBridgeSyntheticResult> {
    let settings = EncoderBridgeSettings::from_params(params)?;
    if let Some(parent) = settings.output_path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }

    let session_id = format!("encoder-bridge-{}", Uuid::new_v4());
    let _capture_permit = state.ffmpeg_work.begin_capture_when_available().await;
    emit_encoder_bridge_diagnostics(
        &state,
        &session_id,
        settings.fps,
        EncoderBridgeRuntimeStats {
            queue_depth: 0,
            input_fps: None,
            dropped_frames: 0,
            encoder_speed: None,
            ..Default::default()
        },
        EncoderBridgeDiagnosticsContext::default(),
        None,
    )
    .await;

    let progress = Arc::new(Mutex::new(EncoderBridgeProgress::default()));
    let mut command = Command::new(&settings.ffmpeg_path);
    command
        .args(encoder_bridge_ffmpeg_args(&settings))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = spawn_owned_tokio(&mut command)
        .with_context(|| format!("Could not start {}", settings.ffmpeg_path))?;

    let mut stdin = child
        .stdin
        .take()
        .context("FFmpeg encoder bridge stdin was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("FFmpeg encoder bridge stderr was unavailable")?;
    let progress_task = tokio::spawn(read_encoder_progress(stderr, progress.clone()));

    let write_started_at = Instant::now();
    let mut window_started_at = Instant::now();
    let mut frames_in_window = 0_u64;
    let mut frames_written = 0_u64;
    let dropped_frames = 0_u64;
    let mut queue_depth = 0_u64;
    let mut max_queue_depth = 0_u64;
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(settings.fps));
    let frame_count = frame_count(settings.duration_ms, settings.fps);
    let source = SyntheticMovingSource;
    let mut bytes = vec![0; raw_rgba_len(settings.width, settings.height)?];
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    for sequence in 1..=frame_count {
        ticker.tick().await;
        let frame = source.render(sequence, settings.width, settings.height);
        render_synthetic_rgba_frame(&frame, &mut bytes);

        queue_depth = 1;
        max_queue_depth = max_queue_depth.max(queue_depth);
        stdin
            .write_all(&bytes)
            .await
            .context("Could not write compositor frame into FFmpeg")?;
        queue_depth = 0;
        frames_written = frames_written.saturating_add(1);
        frames_in_window = frames_in_window.saturating_add(1);

        if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
            let input_fps = Some(
                frames_in_window as f64 / window_started_at.elapsed().as_secs_f64().max(0.001),
            );
            let encoder_progress = progress.lock().await.clone();
            emit_encoder_bridge_diagnostics(
                &state,
                &session_id,
                settings.fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    input_fps,
                    dropped_frames: dropped_frames.saturating_add(encoder_progress.dropped_frames),
                    encoder_speed: encoder_progress.encoder_speed,
                    raw_video_copied_frames: frames_written,
                    ..Default::default()
                },
                EncoderBridgeDiagnosticsContext::default(),
                encoder_progress.last_error,
            )
            .await;
            window_started_at = Instant::now();
            frames_in_window = 0;
        }
    }

    stdin
        .shutdown()
        .await
        .context("Could not close FFmpeg encoder bridge stdin")?;
    drop(stdin);

    let status = child
        .wait()
        .await
        .context("Could not wait for encoder bridge FFmpeg")?;
    let final_progress = progress_task
        .await
        .context("Could not join encoder progress reader")?;
    if !status.success() {
        let error = final_progress
            .last_error
            .unwrap_or_else(|| format!("FFmpeg exited with {status}"));
        emit_encoder_bridge_diagnostics(
            &state,
            &session_id,
            settings.fps,
            EncoderBridgeRuntimeStats {
                queue_depth,
                input_fps: measured_input_fps(frames_written, write_started_at),
                dropped_frames: dropped_frames.saturating_add(final_progress.dropped_frames),
                encoder_speed: final_progress.encoder_speed,
                raw_video_copied_frames: frames_written,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            Some(error.clone()),
        )
        .await;
        bail!("{error}");
    }

    let input_fps = measured_input_fps(frames_written, write_started_at);
    let dropped_frames = dropped_frames.saturating_add(final_progress.dropped_frames);
    emit_encoder_bridge_diagnostics(
        &state,
        &session_id,
        settings.fps,
        EncoderBridgeRuntimeStats {
            queue_depth,
            input_fps,
            dropped_frames,
            encoder_speed: final_progress.encoder_speed,
            raw_video_copied_frames: frames_written,
            ..Default::default()
        },
        EncoderBridgeDiagnosticsContext::default(),
        final_progress.last_error,
    )
    .await;

    let file_bytes = tokio::fs::metadata(&settings.output_path)
        .await
        .with_context(|| format!("Could not inspect {}", settings.output_path.display()))?
        .len();

    Ok(EncoderBridgeSyntheticResult {
        output_path: settings.output_path.display().to_string(),
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        duration_ms: settings.duration_ms,
        frames_written,
        queue_depth_max: max_queue_depth,
        input_fps,
        dropped_frames,
        encoder_speed: final_progress.encoder_speed,
        file_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn start_synthetic_recording_bridge(
    state: AppState,
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    fifo_path: PathBuf,
    frame_store: Option<CompositorFrameStore>,
    direct_d3d11_source: Option<PreviewScreenD3D11FrameSource>,
    #[cfg(target_os = "windows")] direct_d3d11_camera_overlay: Option<DirectD3D11CameraOverlay>,
    #[cfg(target_os = "windows")] d3d11_input: Option<WindowsD3d11EncoderTicketSource>,
    video_output: EncoderBridgeVideoOutput,
    bitrate_kbps: Option<u32>,
    // True when a live leg consumes this output (streaming posture: speed over
    // quality, 1-frame delay cap). Record-only outputs pass false and the
    // VideoToolbox session spends its headroom on quality instead.
    low_latency: bool,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    // Set once at the bridge's first delivered frame: the shared session epoch the
    // audio FIFO writer aligns to (Studio Shell And Live Control Plan, slice A2).
    video_epoch: Arc<OnceLock<Instant>>,
) -> Result<EncoderBridgeRecordingSession> {
    let byte_len = raw_yuv420p_len(width, height)?;
    let lifecycle = EncoderBridgeWriterLifecycle::register(
        state.clone(),
        session_id.clone(),
        effective_encoder_bridge_output_role(diagnostics_context),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let terminal_failure = Arc::new(StdMutex::new(None));
    let (startup_ready_tx, startup_ready_rx) = oneshot::channel();
    let writer_stop = stop.clone();
    let writer_terminal_failure = terminal_failure.clone();
    let writer_fifo_path = fifo_path.clone();
    #[cfg(target_os = "windows")]
    let writer_d3d11_input = d3d11_input.clone();
    let (diagnostics_tx, mut diagnostics_rx) =
        watch::channel::<Option<EncoderBridgeWriterEvent>>(None);
    let diagnostics_state = state.clone();
    let diagnostics_task = tokio::spawn(async move {
        while diagnostics_rx.changed().await.is_ok() {
            let Some(event) = diagnostics_rx.borrow_and_update().clone() else {
                continue;
            };
            emit_encoder_bridge_diagnostics(
                &diagnostics_state,
                &event.session_id,
                event.target_fps,
                event.stats,
                event.diagnostics_context,
                event.error,
            )
            .await;
        }
    });
    let writer_lifecycle = lifecycle.clone();
    let writer = thread::Builder::new()
        .name("videorc-recording-encoder-bridge".to_string())
        .spawn(move || {
            let params = SyntheticRecordingWriterParams {
                session_id,
                target_fps: target_fps.max(1),
                width: width.max(1),
                height: height.max(1),
                byte_len,
                fifo_path: writer_fifo_path,
                frame_store,
                direct_d3d11_source,
                #[cfg(target_os = "windows")]
                direct_d3d11_camera_overlay,
                #[cfg(target_os = "windows")]
                d3d11_input: writer_d3d11_input,
                video_output,
                bitrate_kbps,
                low_latency,
                diagnostics_context,
                stop: writer_stop,
                terminal_failure: writer_terminal_failure,
                startup_ready_tx: Some(startup_ready_tx),
                diagnostics_tx,
                video_epoch,
                lifecycle: writer_lifecycle,
            };
            write_synthetic_recording_frames(params);
        });
    let writer = match writer {
        Ok(writer) => writer,
        Err(error) => {
            lifecycle.cancel_failed_start();
            return Err(error).context("Could not start recording encoder bridge writer thread");
        }
    };

    Ok(EncoderBridgeRecordingSession {
        stop,
        terminal_failure,
        startup_ready: Some(startup_ready_rx),
        fifo_path,
        writer: Some(writer),
        diagnostics_task: Some(diagnostics_task),
        lifecycle: Some(lifecycle),
        #[cfg(target_os = "windows")]
        d3d11_input,
    })
}

impl EncoderBridgeSettings {
    fn from_params(params: EncoderBridgeSyntheticParams) -> Result<Self> {
        let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path);
        let output_path = params
            .output_path
            .map(|path| PathBuf::from(path.trim()))
            .filter(|path| !path.as_os_str().is_empty())
            .context("outputPath is required")?;
        let width = params.width.unwrap_or(640);
        let height = params.height.unwrap_or(360);
        let fps = params.fps.unwrap_or(30);
        let duration_ms = params.duration_ms.unwrap_or(2_000);
        let bitrate_kbps = params.bitrate_kbps.unwrap_or(2_000);

        if !(16..=3840).contains(&width) || !(16..=2160).contains(&height) {
            bail!("Encoder bridge resolution must be between 16x16 and 3840x2160");
        }
        if !(1..=120).contains(&fps) {
            bail!("Encoder bridge FPS must be between 1 and 120");
        }
        if !(100..=60_000).contains(&duration_ms) {
            bail!("Encoder bridge duration must be between 100ms and 60000ms");
        }
        if !(100..=50_000).contains(&bitrate_kbps) {
            bail!("Encoder bridge bitrate must be between 100 and 50000 kbps");
        }

        Ok(Self {
            ffmpeg_path,
            output_path,
            width,
            height,
            fps,
            duration_ms,
            bitrate_kbps,
        })
    }
}

fn encoder_bridge_ffmpeg_args(settings: &EncoderBridgeSettings) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-stats".to_string(),
        "-stats_period".to_string(),
        "1".to_string(),
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgba".to_string(),
        "-video_size".to_string(),
        format!("{}x{}", settings.width, settings.height),
        "-framerate".to_string(),
        settings.fps.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
        "-an".to_string(),
        "-vf".to_string(),
        "format=yuv420p".to_string(),
        "-r".to_string(),
        settings.fps.to_string(),
        "-c:v".to_string(),
        "mpeg4".to_string(),
        "-b:v".to_string(),
        format!("{}k", settings.bitrate_kbps),
        "-movflags".to_string(),
        "+faststart".to_string(),
        settings.output_path.display().to_string(),
    ]
}

fn render_synthetic_rgba_frame(frame: &SyntheticCompositorFrame, bytes: &mut [u8]) {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let marker_size = (width.min(height) / 10).clamp(8, 48);
    let marker_x = frame.marker_x as usize;
    let marker_y = frame.marker_y as usize;

    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) * 4;
            let in_marker =
                x.abs_diff(marker_x) < marker_size && y.abs_diff(marker_y) < marker_size;
            if in_marker {
                bytes[index] = 255;
                bytes[index + 1] = 240;
                bytes[index + 2] = 32;
                bytes[index + 3] = 255;
                continue;
            }

            bytes[index] = ((x * 255) / width.max(1)) as u8;
            bytes[index + 1] = ((y * 255) / height.max(1)) as u8;
            bytes[index + 2] = frame.sequence.wrapping_mul(3) as u8;
            bytes[index + 3] = 255;
        }
    }
}

fn render_synthetic_yuv420p_frame(frame: &SyntheticCompositorFrame, bytes: &mut [u8]) {
    let width = frame.width.max(1) as usize;
    let height = frame.height.max(1) as usize;
    let y_len = width * height;
    let uv_width = width.div_ceil(2);
    let uv_height = height.div_ceil(2);
    let u_start = y_len;
    let v_start = y_len + uv_width * uv_height;
    let marker_size = (width.min(height) / 10).clamp(8, 48);
    let marker_x = (frame.marker_x as usize).min(width.saturating_sub(1));
    let marker_y = (frame.marker_y as usize).min(height.saturating_sub(1));
    let marker_left = marker_x.saturating_sub(marker_size);
    let marker_top = marker_y.saturating_sub(marker_size);
    let marker_right = marker_x.saturating_add(marker_size).min(width);
    let marker_bottom = marker_y.saturating_add(marker_size).min(height);

    bytes[..y_len].fill(48_u8.saturating_add((frame.sequence % 96) as u8));
    bytes[u_start..v_start].fill(128);
    bytes[v_start..].fill(128);

    for y in marker_top..marker_bottom {
        let row_start = y * width + marker_left;
        let row_end = y * width + marker_right;
        bytes[row_start..row_end].fill(235);
    }

    let uv_left = marker_left / 2;
    let uv_top = marker_top / 2;
    let uv_right = marker_right.div_ceil(2).min(uv_width);
    let uv_bottom = marker_bottom.div_ceil(2).min(uv_height);
    for y in uv_top..uv_bottom {
        let row_start = y * uv_width + uv_left;
        let row_end = y * uv_width + uv_right;
        bytes[u_start + row_start..u_start + row_end].fill(60);
        bytes[v_start + row_start..v_start + row_end].fill(190);
    }
}

fn raw_rgba_len(width: u32, height: u32) -> Result<usize> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .context("Raw RGBA frame size overflowed")?;
    usize::try_from(pixels).context("Raw RGBA frame size did not fit in memory")
}

fn raw_yuv420p_len(width: u32, height: u32) -> Result<usize> {
    let width = u64::from(width.max(1));
    let height = u64::from(height.max(1));
    let y = width
        .checked_mul(height)
        .context("Raw YUV frame size overflowed")?;
    let uv = width
        .div_ceil(2)
        .checked_mul(height.div_ceil(2))
        .and_then(|plane| plane.checked_mul(2))
        .context("Raw YUV frame size overflowed")?;
    usize::try_from(y.saturating_add(uv)).context("Raw YUV frame size did not fit in memory")
}

struct SyntheticRecordingWriterParams {
    session_id: String,
    target_fps: u32,
    width: u32,
    height: u32,
    byte_len: usize,
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    startup_ready_tx: Option<oneshot::Sender<std::result::Result<(), String>>>,
    fifo_path: PathBuf,
    frame_store: Option<CompositorFrameStore>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    direct_d3d11_source: Option<PreviewScreenD3D11FrameSource>,
    #[cfg(target_os = "windows")]
    direct_d3d11_camera_overlay: Option<DirectD3D11CameraOverlay>,
    #[cfg(target_os = "windows")]
    d3d11_input: Option<WindowsD3d11EncoderTicketSource>,
    video_output: EncoderBridgeVideoOutput,
    bitrate_kbps: Option<u32>,
    low_latency: bool,
    diagnostics_tx: watch::Sender<Option<EncoderBridgeWriterEvent>>,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    video_epoch: Arc<OnceLock<Instant>>,
    lifecycle: EncoderBridgeWriterLifecycle,
}

#[derive(Debug, Clone)]
struct EncoderBridgeWriterEvent {
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
}

fn write_synthetic_recording_frames(params: SyntheticRecordingWriterParams) {
    let SyntheticRecordingWriterParams {
        session_id,
        target_fps,
        width,
        height,
        byte_len,
        stop,
        terminal_failure,
        mut startup_ready_tx,
        fifo_path,
        frame_store,
        #[cfg(target_os = "windows")]
        direct_d3d11_source,
        #[cfg(not(target_os = "windows"))]
            direct_d3d11_source: _,
        #[cfg(target_os = "windows")]
        direct_d3d11_camera_overlay,
        #[cfg(target_os = "windows")]
        d3d11_input,
        video_output,
        bitrate_kbps,
        low_latency,
        diagnostics_tx,
        diagnostics_context,
        video_epoch,
        lifecycle,
    } = params;
    // Declared after destructuring and before every writer-owned resource so
    // the registry cannot release admission until the outer thread has
    // dropped its encoder/FIFO state.
    let _outer_writer_guard = EncoderBridgeOuterWriterGuard {
        lifecycle: lifecycle.clone(),
    };
    #[cfg(target_os = "windows")]
    let direct_d3d11_enabled = direct_d3d11_source.is_some();
    #[cfg(not(target_os = "windows"))]
    let direct_d3d11_enabled = false;
    let output_queue_policy = encoder_bridge_output_queue_policy(diagnostics_context);
    // Only the recording leg (or the shared leg) feeds the session's frame
    // accounting; a dedicated stream writer must not double-count it.
    let accounts_session_frames = output_queue_policy.role != EncoderBridgeOutputRole::Stream;
    let fifo = match open_recording_fifo_writer(&fifo_path, &stop, true) {
        Ok(fifo) => fifo,
        Err(error) => {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "Could not open recording encoder bridge FIFO {}: {error}",
                    fifo_path.display()
                ),
            );
            signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth: 0,
                    input_fps: None,
                    dropped_frames: 0,
                    encoder_speed: None,
                    ..Default::default()
                },
                diagnostics_context,
                Some(error),
            );
            return;
        }
    };
    #[cfg(target_os = "windows")]
    if let Some(d3d11_input) = d3d11_input {
        if !video_output.uses_media_foundation() {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                "D3D11 encoder tickets require the Media Foundation H.264 output".to_string(),
            );
            signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id,
                target_fps,
                EncoderBridgeRuntimeStats::default(),
                diagnostics_context,
                Some(error),
            );
            return;
        }
        write_windows_d3d11_recording_frames(WindowsD3d11RecordingWriterParams {
            session_id,
            target_fps,
            fifo,
            input: d3d11_input,
            stop,
            terminal_failure,
            startup_ready_tx,
            diagnostics_tx,
            diagnostics_context,
            video_epoch,
        });
        return;
    }
    #[cfg(target_os = "macos")]
    let (mut raw_fifo_writer, mut video_toolbox_fifo_writer) = if video_output.uses_video_toolbox()
    {
        (
            None,
            Some(VideoToolboxFifoWriter::start(
                fifo,
                video_output,
                output_queue_policy,
                stop.clone(),
                Some(lifecycle.clone()),
            )),
        )
    } else {
        (
            Some(RawVideoFifoWriter::start(
                fifo,
                output_queue_policy,
                stop.clone(),
                terminal_failure.clone(),
                Some(lifecycle.clone()),
            )),
            None,
        )
    };
    #[cfg(target_os = "windows")]
    let (
        mut raw_fifo_writer,
        mut media_foundation_encoder,
        mut media_foundation_fifo,
        mut media_foundation_ts_writer,
    ) = if video_output.uses_media_foundation() {
        let config = MediaFoundationEncoderConfig {
            width,
            height,
            fps: target_fps.max(1),
            bitrate_kbps: bitrate_kbps.unwrap_or(6_000),
            low_latency,
        };
        let first_direct_texture = direct_d3d11_source
            .as_ref()
            .and_then(PreviewScreenD3D11FrameSource::latest_frame)
            .and_then(|frame| frame.source_d3d11_texture.clone());
        let encoder_result = match first_direct_texture.as_ref() {
            Some(texture) => MediaFoundationH264Encoder::new_with_d3d11_texture(config, texture),
            None if direct_d3d11_source.is_some() => Err(anyhow::anyhow!(
                "direct D3D11 recording source had no retained capture texture"
            )),
            None => MediaFoundationH264Encoder::new(config),
        };
        let encoder = match encoder_result {
            Ok(mut encoder) => {
                encoder.configure_for_bridge_writer(
                    media_foundation_writer_input_credit_timeout(target_fps),
                    accounts_session_frames,
                );
                encoder
            }
            Err(error) => {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!("Could not prepare Media Foundation encoder bridge output: {error}"),
                );
                signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
                emit_encoder_bridge_diagnostics_from_thread(
                    &diagnostics_tx,
                    session_id.clone(),
                    target_fps,
                    EncoderBridgeRuntimeStats::default(),
                    diagnostics_context,
                    Some(error),
                );
                return;
            }
        };
        (
            None,
            Some(encoder),
            Some(fifo),
            Some(MpegTsH264Writer::new()),
        )
    } else {
        (
            Some(RawVideoFifoWriter::start(
                fifo,
                output_queue_policy,
                stop.clone(),
                terminal_failure.clone(),
                Some(lifecycle.clone()),
            )),
            None,
            None,
            None,
        )
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut raw_fifo_writer = Some(RawVideoFifoWriter::start(
        fifo,
        output_queue_policy,
        stop.clone(),
        terminal_failure.clone(),
        Some(lifecycle.clone()),
    ));
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let source = SyntheticMovingSource;
    let mut sequence = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut raw_frames_delivered_in_window = 0_u64;
    let mut queue_depth = 0_u64;
    let mut repeated_fed_frames = 0_u64;
    let mut repeated_frame_bursts = 0_u64;
    let mut max_repeated_frame_run = 0_u64;
    let mut synthetic_fallback_frames = 0_u64;
    let mut max_source_to_encode_age_ms: Option<u64> = None;
    let mut source_to_encode_age_times_ms = Vec::with_capacity(128);
    let mut repeated_frame_age_times_ms = Vec::with_capacity(128);
    let mut max_repeated_frame_age_ms: Option<u64> = None;
    let mut metal_target_frames = 0_u64;
    let mut raw_video_copied_frames = 0_u64;
    let mut metal_target_copied_frames = 0_u64;
    let mut metal_target_handle_frames = 0_u64;
    let mut zero_copy_frames = 0_u64;
    let mut video_toolbox_probe_frames = 0_u64;
    let mut video_toolbox_probe_bytes = 0_u64;
    let mut video_toolbox_probe_errors = 0_u64;
    let mut video_toolbox_output_frames = 0_u64;
    let mut video_toolbox_output_bytes = 0_u64;
    let mut max_video_toolbox_output_encode_ms: Option<u64> = None;
    let mut pending_video_toolbox_output_frames = 0_u64;
    let mut pending_video_toolbox_fifo_frames = 0_u64;
    let mut pending_raw_fifo_frames = 0_u64;
    let mut pending_raw_fifo_started_at = VecDeque::<Instant>::new();
    // The raw queue is a zero-capacity rendezvous, so at most one synthetic
    // frame can be in flight. Retain at most one returned fallback allocation.
    let mut recycled_synthetic_buffer = None::<Vec<u8>>;
    #[cfg(target_os = "windows")]
    let mut direct_camera_overlay_bytes = Vec::new();
    #[cfg(target_os = "windows")]
    let mut direct_camera_overlay_sequence = None::<u64>;
    #[cfg(target_os = "macos")]
    let mut pending_video_toolbox_output_started_at = HashMap::<u64, Instant>::new();
    #[cfg(target_os = "macos")]
    let mut pending_video_toolbox_fifo_started_at = VecDeque::<Instant>::new();
    #[cfg(target_os = "macos")]
    let mut pending_completed_video_toolbox_frame = None::<CompletedVideoToolboxOutputFrame>;
    let mut output_queue_capacity_pressure_events = 0_u64;
    let mut output_queue_dropped_frames = 0_u64;
    let mut output_queue_high_water_frames = 0_u64;
    let mut output_queue_oldest_frame_age_high_water_ms = None::<u64>;
    let mut output_pressure_recovery_events = 0_u64;
    let mut output_pre_encode_skipped_frames = 0_u64;
    // Encoded access units are retained across callback and FIFO pressure.
    // This remains an explicit zero-valued integrity invariant for smoke gates.
    let encoded_access_unit_dropped_frames = 0_u64;
    let mut output_pressure_active = false;
    let mut last_output_progress_at = Instant::now();
    // First instant the output queue went over its hard budget; cleared the
    // moment it recovers. Drives the sustained-violation escalation.
    let mut output_over_budget_since: Option<Instant> = None;
    #[cfg(target_os = "macos")]
    macro_rules! oldest_output_queue_age {
        () => {
            if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
                pending_raw_fifo_started_at
                    .front()
                    .copied()
                    .map(|started_at| started_at.elapsed())
            } else {
                oldest_pending_video_toolbox_frame_age(
                    &pending_video_toolbox_output_started_at,
                    &pending_video_toolbox_fifo_started_at,
                )
            }
        };
    }
    #[cfg(not(target_os = "macos"))]
    macro_rules! oldest_output_queue_age {
        () => {
            pending_raw_fifo_started_at
                .front()
                .copied()
                .map(|started_at| started_at.elapsed())
        };
    }
    #[cfg(target_os = "macos")]
    macro_rules! oldest_output_queue_age_ms {
        () => {
            oldest_output_queue_age!().map(|age| age.as_millis() as u64)
        };
    }
    macro_rules! observe_output_queue {
        ($depth:expr) => {{
            output_queue_high_water_frames = output_queue_high_water_frames.max($depth);
            if let Some(age_ms) = oldest_output_queue_age_ms!() {
                output_queue_oldest_frame_age_high_water_ms = Some(
                    output_queue_oldest_frame_age_high_water_ms
                        .map_or(age_ms, |current| current.max(age_ms)),
                );
            }
        }};
    }
    #[cfg(not(target_os = "macos"))]
    macro_rules! oldest_output_queue_age_ms {
        () => {
            oldest_output_queue_age!().map(|age| age.as_millis() as u64)
        };
    }
    let mut compositor_wait_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_submit_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_fifo_write_times_ms = Vec::with_capacity(128);
    let mut raw_video_fifo_write_times_ms = Vec::with_capacity(128);
    let mut video_toolbox_fifo_enqueue_times_ms = Vec::with_capacity(128);
    let mut max_video_toolbox_fifo_enqueue_ms: Option<f64> = None;
    let mut writer_loop_times_ms = Vec::with_capacity(128);
    let mut writer_sleep_times_ms = Vec::with_capacity(128);
    let mut writer_active_times_ms = Vec::with_capacity(128);
    let mut deadline_lag_times_ms = Vec::with_capacity(128);
    let mut max_deadline_lag_ms: Option<f64> = None;
    let mut late_deadline_ticks = 0_u64;
    let mut schedule_skipped_ms = 0_u64;
    #[cfg(target_os = "macos")]
    let mut video_toolbox_probe = EncoderBridgeVideoToolboxProbe::new(
        video_output.uses_video_toolbox() || encoder_bridge_video_toolbox_probe_enabled(),
        width,
        height,
        target_fps,
        bitrate_kbps,
        low_latency,
    );
    #[cfg(target_os = "macos")]
    if video_output.uses_video_toolbox()
        && let Err(error) = video_toolbox_probe.prepare_session()
    {
        let error = record_encoder_bridge_terminal_failure(
            &terminal_failure,
            format!("Could not prepare VideoToolbox encoder bridge output: {error}"),
        );
        signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
        emit_encoder_bridge_diagnostics_from_thread(
            &diagnostics_tx,
            session_id.clone(),
            target_fps,
            EncoderBridgeRuntimeStats {
                queue_depth: 0,
                input_fps: None,
                dropped_frames: 0,
                encoder_speed: None,
                ..Default::default()
            },
            diagnostics_context,
            Some(error),
        );
        return;
    }
    // VideoToolbox session creation can take several frame intervals. Start
    // the absolute CFR clock only after that one-time setup; otherwise the
    // first loop tries to catch up the setup delay by immediately re-feeding
    // one compositor frame, creating a visible startup freeze.
    let mut window_started_at = Instant::now();
    let mut next_frame_at = Instant::now();
    let mut last_fed_sequence: Option<u64> = None;
    let mut first_frame_wait_sequence =
        initial_bridge_wait_sequence(video_output, frame_store.as_ref());
    let mut consecutive_repeated_frames = 0_u64;
    let mut terminal_writer_error = None;
    let mut drain_state = EncoderBridgeDrainState::default();

    macro_rules! current_input_fps {
        () => {
            measured_input_fps(
                encoder_bridge_input_frame_count(
                    video_output,
                    frames_in_window,
                    raw_frames_delivered_in_window,
                ),
                window_started_at,
            )
        };
    }

    macro_rules! current_runtime_stats {
        ($depth:expr) => {
            EncoderBridgeRuntimeStats {
                queue_depth: $depth,
                output_queue_high_water_frames,
                output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                output_queue_oldest_frame_age_high_water_ms,
                output_last_progress_age_ms: Some(
                    last_output_progress_at.elapsed().as_millis() as u64
                ),
                output_queue_capacity_pressure_events,
                output_pressure_recovery_events,
                output_queue_dropped_frames,
                output_pre_encode_skipped_frames,
                video_toolbox_pending_encode_frames: pending_video_toolbox_output_frames,
                video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
                encoded_access_unit_dropped_frames,
                input_fps: current_input_fps!(),
                dropped_frames: 0,
                encoder_speed: None,
                repeated_fed_frames,
                repeated_frame_bursts,
                max_repeated_frame_run,
                synthetic_fallback_frames,
                source_to_encode_age_ms: max_source_to_encode_age_ms,
                source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                metal_target_frames,
                raw_video_copied_frames,
                metal_target_copied_frames,
                metal_target_handle_frames,
                zero_copy_frames,
                video_toolbox_probe_frames,
                video_toolbox_probe_bytes,
                video_toolbox_probe_errors,
                video_toolbox_output_frames,
                video_toolbox_output_bytes,
                video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                deadline_lag_max_ms: max_deadline_lag_ms,
                late_deadline_ticks,
                schedule_skipped_ms,
            }
        };
    }

    if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
        // FFmpeg can take hundreds of milliseconds to initialise its input
        // graph and hardware encoder after opening the raw FIFO. Advancing the
        // 30fps clock during that one-time warmup creates avoidable pressure
        // before the wall-clock-stamped input has delivered any usable video.
        // Deliver exactly one complete priming frame first; only then start the
        // wall-clock input schedule and publish the recording as ready.
        let prime_wait_started_at = Instant::now();
        let prime_frame = next_raw_compositor_frame(
            frame_store.as_ref(),
            first_frame_wait_sequence,
            frame_interval + frame_interval,
            byte_len,
        );
        compositor_wait_times_ms.push(prime_wait_started_at.elapsed().as_secs_f64() * 1000.0);
        let submitted_at = Instant::now();
        let queued_prime = match prime_frame.as_ref() {
            Some(frame) => QueuedRawVideoFrame::compositor(frame),
            None => {
                synthetic_fallback_frames = synthetic_fallback_frames.saturating_add(1);
                let frame = source.render(1, width, height);
                let mut bytes =
                    take_recycled_synthetic_buffer(&mut recycled_synthetic_buffer, byte_len);
                render_synthetic_yuv420p_frame(&frame, &mut bytes);
                QueuedRawVideoFrame::synthetic(bytes)
            }
        };
        let prime_enqueue = raw_fifo_writer
            .as_ref()
            .expect("raw encoder bridge FIFO writer must be running")
            .enqueue_startup(queued_prime);
        if let Err(error) = prime_enqueue {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder startup prime failed: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(0),
                diagnostics_context,
                Some(error),
            );
            return;
        }
        pending_raw_fifo_frames = 1;
        pending_raw_fifo_started_at.push_back(submitted_at);
        let prime_deadline = Instant::now() + RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT;
        while pending_raw_fifo_frames > 0 && !stop.load(Ordering::Relaxed) {
            let writer = raw_fifo_writer
                .as_mut()
                .expect("raw encoder bridge FIFO writer must be running");
            if let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            ) {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder startup prime stopped: {error}",
                        encoder_bridge_output_role_label(output_queue_policy.role)
                    ),
                );
                signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
                emit_encoder_bridge_diagnostics_from_thread(
                    &diagnostics_tx,
                    session_id.clone(),
                    target_fps,
                    current_runtime_stats!(pending_raw_fifo_frames),
                    diagnostics_context,
                    Some(error),
                );
                return;
            }
            if pending_raw_fifo_frames == 0 {
                break;
            }
            if Instant::now() >= prime_deadline {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder did not accept a complete startup frame within {}ms",
                        encoder_bridge_output_role_label(output_queue_policy.role),
                        RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT.as_millis()
                    ),
                );
                signal_encoder_bridge_startup(&mut startup_ready_tx, Err(error.clone()));
                emit_encoder_bridge_diagnostics_from_thread(
                    &diagnostics_tx,
                    session_id.clone(),
                    target_fps,
                    current_runtime_stats!(pending_raw_fifo_frames),
                    diagnostics_context,
                    Some(error),
                );
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
        if stop.load(Ordering::Relaxed) {
            signal_encoder_bridge_startup(
                &mut startup_ready_tx,
                Err("Encoder bridge stopped during raw-video startup priming".to_string()),
            );
            return;
        }
        if let Some(frame) = prime_frame {
            last_fed_sequence = Some(frame.sequence);
            let source_age_ms = frame.captured_at.elapsed().as_millis() as u64;
            max_source_to_encode_age_ms = Some(source_age_ms);
            source_to_encode_age_times_ms.push(source_age_ms as f64);
        }
        // Audio captured while FFmpeg was initialising is pre-roll. Start its
        // shared epoch only after the complete video prime reached the reader.
        let _ = video_epoch.set(Instant::now());
        sequence = 1;
        frames_in_window = 1;
        window_started_at = Instant::now();
        next_frame_at = window_started_at + frame_interval;
        first_frame_wait_sequence = None;
        signal_encoder_bridge_startup(&mut startup_ready_tx, Ok(()));
    } else {
        signal_encoder_bridge_startup(&mut startup_ready_tx, Ok(()));
    }

    while !stop.load(Ordering::Relaxed) {
        if let Some(writer) = raw_fifo_writer.as_mut()
            && let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            )
        {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(pending_raw_fifo_frames),
                diagnostics_context,
                Some(error),
            );
            break;
        }
        let loop_started_at = Instant::now();
        let now = Instant::now();
        let tick_lag = now.saturating_duration_since(next_frame_at);
        if now > next_frame_at && tick_lag >= ENCODER_BRIDGE_DEADLINE_LAG_THRESHOLD {
            let lag_ms = tick_lag.as_secs_f64() * 1000.0;
            deadline_lag_times_ms.push(lag_ms);
            max_deadline_lag_ms =
                Some(max_deadline_lag_ms.map_or(lag_ms, |current| current.max(lag_ms)));
            late_deadline_ticks = late_deadline_ticks.saturating_add(1);
        }
        let tick_plan = plan_bridge_tick(tick_lag, frame_interval);
        if tick_plan.reanchor_skipped_intervals > 0 {
            // Pathological stall: drop whole intervals as an EXPLICIT gap. The
            // schedule stays wall-true (sequence advances by the same count,
            // keeping synthetic PTS honest on the encoded path) and the loss is
            // counted, never silent.
            next_frame_at += frame_interval * tick_plan.reanchor_skipped_intervals as u32;
            sequence = sequence.saturating_add(tick_plan.reanchor_skipped_intervals);
            let skipped_ms = (frame_interval.as_secs_f64()
                * tick_plan.reanchor_skipped_intervals as f64
                * 1000.0) as u64;
            schedule_skipped_ms = schedule_skipped_ms.saturating_add(skipped_ms);
            tracing::warn!(
                skipped_intervals = tick_plan.reanchor_skipped_intervals,
                skipped_ms,
                "encoder bridge schedule stalled; dropped intervals as an explicit gap"
            );
        }
        let sleep_started_at = Instant::now();
        if now < next_frame_at {
            thread::sleep(next_frame_at - now);
        }
        let active_started_at = Instant::now();
        writer_sleep_times_ms.push(
            active_started_at
                .duration_since(sleep_started_at)
                .as_secs_f64()
                * 1000.0,
        );
        next_frame_at += frame_interval;
        sequence = sequence.saturating_add(1);

        // Drain completions before admitting another compositor frame. The old
        // path submitted first and only observed pressure afterwards, allowing
        // a 240-frame blocking FIFO to turn a slow sink into seconds of hidden
        // latency.
        #[cfg(target_os = "macos")]
        let mut pipeline_error = if video_output.uses_video_toolbox() {
            let writer = video_toolbox_fifo_writer
                .as_mut()
                .expect("VideoToolbox FIFO writer must be running");
            let pending_encode_before = pending_video_toolbox_output_frames;
            let written_frames_before = video_toolbox_output_frames;
            let drain_result = drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                writer,
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut pending_completed_video_toolbox_frame,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                Some(VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK),
            )
            .and_then(|progress| {
                if progress.callback_completions > 0 {
                    last_output_progress_at = Instant::now();
                }
                drain_video_toolbox_fifo_writer_results(
                    writer,
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
            });
            if pending_video_toolbox_output_frames < pending_encode_before
                || video_toolbox_output_frames > written_frames_before
            {
                last_output_progress_at = Instant::now();
            }
            drain_result.err()
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let mut pipeline_error: Option<io::Error> = None;

        queue_depth = if video_output.uses_media_foundation() {
            #[cfg(target_os = "windows")]
            {
                media_foundation_encoder
                    .as_ref()
                    .map_or(0, |encoder| encoder.pending_frame_count() as u64)
            }
            #[cfg(not(target_os = "windows"))]
            {
                0
            }
        } else if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        observe_output_queue!(queue_depth);
        let admission = if pipeline_error.is_some() || !video_output.uses_encoded_h264() {
            EncoderBridgePreEncodeAdmission::Submit
        } else {
            encoder_bridge_progress_aware_pre_encode_admission(
                output_queue_policy,
                queue_depth,
                oldest_output_queue_age!(),
                last_output_progress_at.elapsed(),
            )
        };
        // Over-budget is a death sentence only when SUSTAINED (or the queue is
        // truly full): a transient downstream stall degrades to latest-wins
        // coalescing and recovers, instead of one over-age sample killing a
        // live session (2026-07-15 incident).
        let admission = match admission {
            EncoderBridgePreEncodeAdmission::FailOutput
                if output_queue_policy.role == EncoderBridgeOutputRole::Stream =>
            {
                let now = Instant::now();
                let since = *output_over_budget_since.get_or_insert(now);
                match encoder_bridge_over_budget_escalation(
                    output_queue_policy,
                    queue_depth,
                    since,
                    now,
                ) {
                    EncoderBridgeOverBudgetEscalation::Degrade => {
                        EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
                    }
                    EncoderBridgeOverBudgetEscalation::Fail => {
                        EncoderBridgePreEncodeAdmission::FailOutput
                    }
                }
            }
            EncoderBridgePreEncodeAdmission::FailOutput => {
                // Recording reaches this arm only after the independent
                // no-progress timeout. Do not restart another age/depth grace
                // window: that was the coupling which converted pressure into
                // either premature death or one last overflowing submission.
                EncoderBridgePreEncodeAdmission::FailOutput
            }
            other => {
                output_over_budget_since = None;
                other
            }
        };
        match admission {
            EncoderBridgePreEncodeAdmission::Submit => {
                if output_pressure_active {
                    output_pressure_active = false;
                    output_pressure_recovery_events =
                        output_pressure_recovery_events.saturating_add(1);
                    tracing::info!(
                        role = encoder_bridge_output_role_label(output_queue_policy.role),
                        queue_depth,
                        recoveries = output_pressure_recovery_events,
                        "encoder output queue recovered after bounded pressure"
                    );
                }
            }
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
            | EncoderBridgePreEncodeAdmission::PauseRecordingFrame => {
                let recording_pause =
                    admission == EncoderBridgePreEncodeAdmission::PauseRecordingFrame;
                output_pressure_active = true;
                output_queue_capacity_pressure_events =
                    output_queue_capacity_pressure_events.saturating_add(1);
                if recording_pause {
                    output_pre_encode_skipped_frames =
                        output_pre_encode_skipped_frames.saturating_add(1);
                } else {
                    output_queue_dropped_frames = output_queue_dropped_frames.saturating_add(1);
                }
                writer_active_times_ms.push(active_started_at.elapsed().as_secs_f64() * 1000.0);
                writer_loop_times_ms.push(loop_started_at.elapsed().as_secs_f64() * 1000.0);
                if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
                    emit_encoder_bridge_diagnostics_from_thread(
                        &diagnostics_tx,
                        session_id.clone(),
                        target_fps,
                        current_runtime_stats!(queue_depth),
                        diagnostics_context,
                        None,
                    );
                    window_started_at = Instant::now();
                    frames_in_window = 0;
                    raw_frames_delivered_in_window = 0;
                    compositor_wait_times_ms.clear();
                    video_toolbox_submit_times_ms.clear();
                    video_toolbox_fifo_write_times_ms.clear();
                    raw_video_fifo_write_times_ms.clear();
                    video_toolbox_fifo_enqueue_times_ms.clear();
                    writer_loop_times_ms.clear();
                    writer_sleep_times_ms.clear();
                    writer_active_times_ms.clear();
                    source_to_encode_age_times_ms.clear();
                    repeated_frame_age_times_ms.clear();
                }
                // `last_fed_sequence` intentionally does not advance. The next
                // admitted tick asks the latest-wins compositor store for the
                // newest frame and skips every superseded frame before encode.
                // The bridge timing sequence did advance above, so the next
                // MPEG-TS PTS carries an explicit wall-time gap; the maintained
                // final-artifact cadence/freeze gate checks that this remains
                // honest rather than compressing the timeline. For recording,
                // every already-encoded AU remains queued and ordered; only this
                // not-yet-encoded compositor tick is skipped.
                continue;
            }
            EncoderBridgePreEncodeAdmission::FailOutput => {
                output_pressure_active = true;
                output_queue_capacity_pressure_events =
                    output_queue_capacity_pressure_events.saturating_add(1);
                pipeline_error = Some(encoder_bridge_output_pressure_error(
                    output_queue_policy,
                    queue_depth,
                    oldest_output_queue_age!(),
                    last_output_progress_at.elapsed(),
                ));
            }
        }
        let startup_wait_sequence = if last_fed_sequence.is_none() {
            first_frame_wait_sequence
        } else {
            None
        };
        let wait_budget = if startup_wait_sequence.is_some() {
            frame_interval + frame_interval
        } else if tick_plan.skip_fresh_wait {
            // Behind schedule: feed the latest available frame immediately (a
            // repeat if unchanged) so the absolute schedule converges by
            // emitting honest repeats instead of compressing the timeline.
            Duration::ZERO
        } else {
            compositor_frame_wait_budget(video_output, consecutive_repeated_frames, frame_interval)
        };
        let previous_sequence = last_fed_sequence.or(startup_wait_sequence);
        let compositor_wait_started_at = Instant::now();
        #[cfg(target_os = "windows")]
        let direct_d3d11_frame = direct_d3d11_source
            .as_ref()
            .and_then(PreviewScreenD3D11FrameSource::latest_frame);
        #[cfg(target_os = "windows")]
        let direct_camera_frame = direct_d3d11_camera_overlay
            .as_ref()
            .and_then(|overlay| overlay.source.latest_frame_blocking())
            .map(|(frame, _layout)| frame);
        let fed = if direct_d3d11_enabled {
            None
        } else {
            match video_output {
                EncoderBridgeVideoOutput::RawYuv420p => next_raw_compositor_frame(
                    frame_store.as_ref(),
                    previous_sequence,
                    wait_budget,
                    byte_len,
                ),
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
                | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
                | EncoderBridgeVideoOutput::WindowsMediaFoundationH264MpegTs => {
                    next_compositor_frame(frame_store.as_ref(), previous_sequence, wait_budget)
                }
            }
        };
        compositor_wait_times_ms.push(compositor_wait_started_at.elapsed().as_secs_f64() * 1000.0);
        #[cfg(target_os = "windows")]
        let direct_sequence = direct_d3d11_frame.as_ref().map(|frame| frame.sequence);
        #[cfg(not(target_os = "windows"))]
        let direct_sequence = None;
        let current_sequence = direct_sequence.or_else(|| fed.as_ref().map(|frame| frame.sequence));
        let frame_source = classify_bridge_frame(last_fed_sequence, current_sequence);
        if accounts_session_frames {
            crate::diagnostics::RECORDING_FRAME_ACCOUNTING
                .record_bridge_input(frame_source.accounting_kind());
        }
        match frame_source {
            BridgeFrameSource::SyntheticFallback => {
                synthetic_fallback_frames = synthetic_fallback_frames.saturating_add(1);
                consecutive_repeated_frames = 0;
                if video_output.uses_encoded_h264() {
                    emit_encoder_bridge_diagnostics_from_thread(
                        &diagnostics_tx,
                        session_id.clone(),
                        target_fps,
                        EncoderBridgeRuntimeStats {
                            queue_depth,
                            output_queue_high_water_frames,
                            output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                            output_queue_oldest_frame_age_high_water_ms,
                            output_last_progress_age_ms: Some(
                                last_output_progress_at.elapsed().as_millis() as u64,
                            ),
                            output_queue_capacity_pressure_events,
                            output_pressure_recovery_events,
                            output_queue_dropped_frames,
                            output_pre_encode_skipped_frames,
                            video_toolbox_pending_encode_frames:
                                pending_video_toolbox_output_frames,
                            video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
                            encoded_access_unit_dropped_frames,
                            input_fps: current_input_fps!(),
                            dropped_frames: 0,
                            encoder_speed: None,
                            repeated_fed_frames,
                            repeated_frame_bursts,
                            max_repeated_frame_run,
                            synthetic_fallback_frames,
                            source_to_encode_age_ms: max_source_to_encode_age_ms,
                            source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                            repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                            repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                            metal_target_frames,
                            raw_video_copied_frames,
                            metal_target_copied_frames,
                            metal_target_handle_frames,
                            zero_copy_frames,
                            video_toolbox_probe_frames,
                            video_toolbox_probe_bytes,
                            video_toolbox_probe_errors,
                            video_toolbox_output_frames,
                            video_toolbox_output_bytes,
                            video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                            compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                            video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                            raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                            video_toolbox_fifo_write_p95_ms: p95_ms(
                                &video_toolbox_fifo_write_times_ms,
                            ),
                            video_toolbox_fifo_enqueue_p95_ms: p95_ms(
                                &video_toolbox_fifo_enqueue_times_ms,
                            ),
                            video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                            deadline_lag_max_ms: max_deadline_lag_ms,
                            late_deadline_ticks,
                            schedule_skipped_ms,
                        },
                        diagnostics_context,
                        Some(
                            "VideoToolbox encoder bridge had no compositor frame to encode"
                                .to_string(),
                        ),
                    );
                    break;
                }
            }
            BridgeFrameSource::Repeated => {
                if consecutive_repeated_frames == 0 {
                    repeated_frame_bursts = repeated_frame_bursts.saturating_add(1);
                }
                repeated_fed_frames = repeated_fed_frames.saturating_add(1);
                consecutive_repeated_frames = consecutive_repeated_frames.saturating_add(1);
                max_repeated_frame_run = max_repeated_frame_run.max(consecutive_repeated_frames);
            }
            BridgeFrameSource::Fresh => {
                consecutive_repeated_frames = 0;
            }
        }
        #[cfg(target_os = "windows")]
        let direct_frame_metadata = direct_d3d11_frame.as_ref().map(|frame| {
            (
                frame.sequence,
                frame.captured_at,
                frame.captured_at.elapsed().as_millis() as u64,
            )
        });
        #[cfg(not(target_os = "windows"))]
        let direct_frame_metadata: Option<(u64, Instant, u64)> = None;
        let frame_metadata = direct_frame_metadata.or_else(|| {
            fed.as_ref()
                .map(|frame| (frame.sequence, frame.captured_at, frame.age_ms))
        });
        if let Some((frame_sequence, captured_at, frame_age_ms)) = frame_metadata {
            if last_fed_sequence.is_none() {
                // First video content of the session: everything the audio writer
                // captured before the composited frame's timestamp is pre-roll and
                // must be trimmed. Using the encoder-observed instant here would
                // bake source-to-encode latency into the finished recording.
                let _ = video_epoch.set(captured_at);
            }
            last_fed_sequence = Some(frame_sequence);
            max_source_to_encode_age_ms =
                Some(max_source_to_encode_age_ms.map_or(frame_age_ms, |age| age.max(frame_age_ms)));
            source_to_encode_age_times_ms.push(frame_age_ms as f64);
            if frame_source == BridgeFrameSource::Repeated {
                repeated_frame_age_times_ms.push(frame_age_ms as f64);
                max_repeated_frame_age_ms = Some(
                    max_repeated_frame_age_ms.map_or(frame_age_ms, |age| age.max(frame_age_ms)),
                );
            }
        }
        #[cfg(target_os = "macos")]
        let wrote_metal_target_frame = fed
            .as_ref()
            .is_some_and(|frame| frame.has_metal_iosurface_target);
        #[cfg(target_os = "macos")]
        let wrote_metal_target_handle = fed
            .as_ref()
            .is_some_and(|frame| frame.has_metal_export_handle);
        #[cfg(target_os = "macos")]
        if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p)
            && let Some(frame) = fed.as_ref()
        {
            match video_toolbox_probe.encode_frame(frame, sequence.saturating_sub(1)) {
                VideoToolboxProbeOutcome::Encoded { frame } => {
                    video_toolbox_probe_frames = video_toolbox_probe_frames.saturating_add(1);
                    video_toolbox_probe_bytes =
                        video_toolbox_probe_bytes.saturating_add(frame.bytes.len() as u64);
                }
                VideoToolboxProbeOutcome::Failed => {
                    video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
                }
                VideoToolboxProbeOutcome::Disabled
                | VideoToolboxProbeOutcome::NoTarget
                | VideoToolboxProbeOutcome::Submitted => {}
            }
        }

        queue_depth = if video_output.uses_media_foundation() {
            #[cfg(target_os = "windows")]
            {
                media_foundation_encoder
                    .as_ref()
                    .map_or(0, |encoder| encoder.pending_frame_count() as u64)
            }
            #[cfg(not(target_os = "windows"))]
            {
                0
            }
        } else if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        let output_frames_before_write = video_toolbox_output_frames;
        let write_result = if let Some(error) = pipeline_error {
            Err(error)
        } else {
            match video_output {
                EncoderBridgeVideoOutput::RawYuv420p => {
                    let submitted_at = Instant::now();
                    let queued_frame = match fed.as_ref() {
                        Some(frame) => QueuedRawVideoFrame::compositor(frame),
                        None => {
                            let frame = source.render(sequence, width, height);
                            let mut bytes = take_recycled_synthetic_buffer(
                                &mut recycled_synthetic_buffer,
                                byte_len,
                            );
                            render_synthetic_yuv420p_frame(&frame, &mut bytes);
                            QueuedRawVideoFrame::synthetic(bytes)
                        }
                    };
                    match raw_fifo_writer
                        .as_ref()
                        .expect("raw encoder bridge FIFO writer must be running")
                        .enqueue(queued_frame, &mut output_queue_capacity_pressure_events)
                    {
                        Ok(RawVideoFifoEnqueueOutcome::Enqueued) => {
                            pending_raw_fifo_frames = pending_raw_fifo_frames.saturating_add(1);
                            pending_raw_fifo_started_at.push_back(submitted_at);
                            Ok(())
                        }
                        Ok(RawVideoFifoEnqueueOutcome::Coalesced(frame)) => {
                            output_queue_dropped_frames =
                                output_queue_dropped_frames.saturating_add(1);
                            // The one-slot mailbox retained the new latest frame
                            // and returned the superseded pending frame. Keep the
                            // age queue aligned with that replacement so health
                            // reports the frame the writer will actually consume.
                            if let Some(pending_started_at) = pending_raw_fifo_started_at.back_mut()
                            {
                                *pending_started_at = submitted_at;
                            }
                            retain_recycled_synthetic_buffer(
                                &mut recycled_synthetic_buffer,
                                frame.into_synthetic_buffer(),
                            );
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB
                | EncoderBridgeVideoOutput::VideoToolboxH264MpegTs => {
                    #[cfg(target_os = "macos")]
                    {
                        match fed.as_ref() {
                            Some(frame) => {
                                let encode_started_at = Instant::now();
                                match video_toolbox_probe
                                    .submit_output_frame(frame, sequence.saturating_sub(1))
                                {
                                    VideoToolboxProbeOutcome::Submitted => {
                                        let encode_ms =
                                            encode_started_at.elapsed().as_millis() as u64;
                                        video_toolbox_submit_times_ms.push(
                                            encode_started_at.elapsed().as_secs_f64() * 1000.0,
                                        );
                                        max_video_toolbox_output_encode_ms = Some(
                                            max_video_toolbox_output_encode_ms
                                                .map_or(encode_ms, |current| {
                                                    current.max(encode_ms)
                                                }),
                                        );
                                        pending_video_toolbox_output_frames =
                                            pending_video_toolbox_output_frames.saturating_add(1);
                                        pending_video_toolbox_output_started_at
                                            .insert(sequence.saturating_sub(1), encode_started_at);
                                        if wrote_metal_target_frame {
                                            metal_target_frames =
                                                metal_target_frames.saturating_add(1);
                                        }
                                        if wrote_metal_target_handle {
                                            metal_target_handle_frames =
                                                metal_target_handle_frames.saturating_add(1);
                                        }
                                        Ok(())
                                    }
                                    VideoToolboxProbeOutcome::Failed => {
                                        video_toolbox_probe_errors =
                                            video_toolbox_probe_errors.saturating_add(1);
                                        Err(io::Error::other(
                                            "VideoToolbox encoder bridge failed to encode retained target",
                                        ))
                                    }
                                    VideoToolboxProbeOutcome::Disabled
                                    | VideoToolboxProbeOutcome::NoTarget
                                    | VideoToolboxProbeOutcome::Encoded { .. } => {
                                        Err(io::Error::other(
                                            "VideoToolbox encoder bridge had no retained target",
                                        ))
                                    }
                                }
                            }
                            None => Err(io::Error::other(
                                "VideoToolbox encoder bridge had no compositor frame",
                            )),
                        }
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        Err(io::Error::other(
                            "VideoToolbox encoder bridge output is only available on macOS",
                        ))
                    }
                }
                EncoderBridgeVideoOutput::WindowsMediaFoundationH264MpegTs => {
                    #[cfg(target_os = "windows")]
                    {
                        match (direct_d3d11_frame.as_ref(), fed.as_ref()) {
                            (Some(frame), _) => {
                                let encode_started_at = Instant::now();
                                let texture = frame.source_d3d11_texture.as_ref().ok_or_else(|| {
                                    io::Error::other(
                                        "direct D3D11 recording frame lost its retained texture",
                                    )
                                });
                                let overlay = direct_d3d11_camera_overlay
                                    .as_ref()
                                    .zip(direct_camera_frame.as_ref())
                                    .map(|(config, camera_frame)| {
                                        if direct_camera_overlay_sequence
                                            != Some(camera_frame.sequence)
                                        {
                                            if !render_camera_overlay_bgra(
                                                &camera_frame.bytes,
                                                camera_frame.width,
                                                camera_frame.height,
                                                config.destination.width,
                                                config.destination.height,
                                                config.crop,
                                                config.contain,
                                                config.mirror_x,
                                                config.mask,
                                                &mut direct_camera_overlay_bytes,
                                            ) {
                                                return Err(io::Error::other(
                                                    "could not render direct D3D11 camera overlay",
                                                ));
                                            }
                                            direct_camera_overlay_sequence =
                                                Some(camera_frame.sequence);
                                        }
                                        Ok(D3D11BgraOverlay {
                                            bytes: &direct_camera_overlay_bytes,
                                            width: config.destination.width,
                                            height: config.destination.height,
                                            sequence: camera_frame.sequence,
                                            destination: config.destination,
                                        })
                                    })
                                    .transpose();
                                match texture.and_then(|texture| {
                                    let overlay = overlay?;
                                    media_foundation_encoder
                                        .as_mut()
                                        .expect("Media Foundation encoder must be prepared")
                                        .encode_d3d11_texture_with_overlay(
                                            texture,
                                            overlay.as_ref(),
                                            sequence.saturating_sub(1),
                                        )
                                        .map_err(|error| io::Error::other(error.to_string()))
                                }) {
                                    Ok(frames) => {
                                        let encode_elapsed = encode_started_at.elapsed();
                                        video_toolbox_submit_times_ms
                                            .push(encode_elapsed.as_secs_f64() * 1000.0);
                                        let encode_ms = encode_elapsed.as_millis() as u64;
                                        max_video_toolbox_output_encode_ms = Some(
                                            max_video_toolbox_output_encode_ms
                                                .map_or(encode_ms, |current| {
                                                    current.max(encode_ms)
                                                }),
                                        );
                                        write_media_foundation_frames(
                                            frames,
                                            media_foundation_fifo
                                                .as_mut()
                                                .expect("Media Foundation FIFO must be prepared"),
                                            media_foundation_ts_writer.as_mut().expect(
                                                "Media Foundation MPEG-TS writer must be prepared",
                                            ),
                                            &stop,
                                            &mut zero_copy_frames,
                                            &mut video_toolbox_output_frames,
                                            &mut video_toolbox_output_bytes,
                                            &mut video_toolbox_fifo_write_times_ms,
                                        )
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            (None, Some(frame)) => {
                                let encode_started_at = Instant::now();
                                match media_foundation_encoder
                                    .as_mut()
                                    .expect("Media Foundation encoder must be prepared")
                                    .encode_frame(&frame.frame.bytes, sequence.saturating_sub(1))
                                {
                                    Ok(frames) => {
                                        let encode_elapsed = encode_started_at.elapsed();
                                        video_toolbox_submit_times_ms
                                            .push(encode_elapsed.as_secs_f64() * 1000.0);
                                        let encode_ms = encode_elapsed.as_millis() as u64;
                                        max_video_toolbox_output_encode_ms = Some(
                                            max_video_toolbox_output_encode_ms
                                                .map_or(encode_ms, |current| {
                                                    current.max(encode_ms)
                                                }),
                                        );
                                        write_media_foundation_frames(
                                            frames,
                                            media_foundation_fifo
                                                .as_mut()
                                                .expect("Media Foundation FIFO must be prepared"),
                                            media_foundation_ts_writer.as_mut().expect(
                                                "Media Foundation MPEG-TS writer must be prepared",
                                            ),
                                            &stop,
                                            &mut zero_copy_frames,
                                            &mut video_toolbox_output_frames,
                                            &mut video_toolbox_output_bytes,
                                            &mut video_toolbox_fifo_write_times_ms,
                                        )
                                    }
                                    Err(error) => Err(io::Error::other(error.to_string())),
                                }
                            }
                            (None, None) => Err(io::Error::other(
                                "Media Foundation encoder bridge had no compositor frame",
                            )),
                        }
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        Err(io::Error::other(
                            "Media Foundation encoder bridge output is only available on Windows",
                        ))
                    }
                }
            }
        };
        if write_result.is_ok() && video_toolbox_output_frames > output_frames_before_write {
            last_output_progress_at = Instant::now();
        }
        if let Err(error) = write_result {
            // A closed downstream (EPIPE/EOF: FFmpeg exited or was stopped)
            // is not this bridge's verdict — the process exit status decides
            // the session outcome. Recording it as terminal made a STREAM
            // death condemn a healthy recording: the stream writer died, the
            // shared FFmpeg exited cleanly, and the recording writer's EPIPE
            // was then indistinguishable from a real encoder failure.
            let error = drain_state.record_main_loop_error(
                &terminal_failure,
                output_queue_policy.role,
                &error,
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    output_queue_high_water_frames,
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_oldest_frame_age_high_water_ms,
                    output_last_progress_age_ms: Some(
                        last_output_progress_at.elapsed().as_millis() as u64,
                    ),
                    output_queue_capacity_pressure_events,
                    output_pressure_recovery_events,
                    output_queue_dropped_frames,
                    output_pre_encode_skipped_frames,
                    video_toolbox_pending_encode_frames: pending_video_toolbox_output_frames,
                    video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
                    encoded_access_unit_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                Some(error),
            );
            break;
        }
        #[cfg(target_os = "macos")]
        if video_output.uses_video_toolbox()
            && let Err(error) = drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                video_toolbox_fifo_writer
                    .as_mut()
                    .expect("VideoToolbox FIFO writer must be running"),
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut pending_completed_video_toolbox_frame,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                Some(VIDEOTOOLBOX_OUTPUT_DRAIN_MAX_FRAMES_PER_TICK),
            )
            .and_then(|progress| {
                if progress.callback_completions > 0 {
                    last_output_progress_at = Instant::now();
                }
                let written_frames_before = video_toolbox_output_frames;
                let result = drain_video_toolbox_fifo_writer_results(
                    video_toolbox_fifo_writer
                        .as_mut()
                        .expect("VideoToolbox FIFO writer must be running"),
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                );
                if video_toolbox_output_frames > written_frames_before {
                    last_output_progress_at = Instant::now();
                }
                result
            })
        {
            let error = drain_state.record_video_toolbox_loop_error(
                &terminal_failure,
                output_queue_policy.role,
                &error,
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth: pending_video_toolbox_output_frames
                        .saturating_add(pending_video_toolbox_fifo_frames),
                    output_queue_high_water_frames,
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_oldest_frame_age_high_water_ms,
                    output_last_progress_age_ms: Some(
                        last_output_progress_at.elapsed().as_millis() as u64,
                    ),
                    output_queue_capacity_pressure_events,
                    output_pressure_recovery_events,
                    output_queue_dropped_frames,
                    output_pre_encode_skipped_frames,
                    video_toolbox_pending_encode_frames: pending_video_toolbox_output_frames,
                    video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
                    encoded_access_unit_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                Some(error),
            );
            break;
        }
        if let Some(writer) = raw_fifo_writer.as_mut()
            && let Err(error) = drain_raw_video_fifo_writer_results(
                writer,
                &mut pending_raw_fifo_frames,
                &mut pending_raw_fifo_started_at,
                &mut recycled_synthetic_buffer,
                &mut raw_video_copied_frames,
                &mut raw_frames_delivered_in_window,
                &mut metal_target_frames,
                &mut metal_target_copied_frames,
                &mut metal_target_handle_frames,
                &mut raw_video_fifo_write_times_ms,
            )
        {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} raw-video encoder output stopped: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                ),
            );
            terminal_writer_error = Some(error.clone());
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                current_runtime_stats!(pending_raw_fifo_frames),
                diagnostics_context,
                Some(error),
            );
            break;
        }
        queue_depth = if video_output.uses_media_foundation() {
            #[cfg(target_os = "windows")]
            {
                media_foundation_encoder
                    .as_ref()
                    .map_or(0, |encoder| encoder.pending_frame_count() as u64)
            }
            #[cfg(not(target_os = "windows"))]
            {
                0
            }
        } else if video_output.uses_video_toolbox() {
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames)
        } else {
            pending_raw_fifo_frames
        };
        writer_active_times_ms.push(active_started_at.elapsed().as_secs_f64() * 1000.0);
        writer_loop_times_ms.push(loop_started_at.elapsed().as_secs_f64() * 1000.0);
        // Plan 026: the schedule is absolute — no re-anchor. A tick that
        // overruns starts the next iteration behind, which zeroes the
        // fresh-frame wait (above) and converges with repeats; wall time is
        // never silently dropped from the video timeline.
        frames_in_window = frames_in_window.saturating_add(1);
        if startup_wait_sequence.is_some() {
            next_frame_at = Instant::now() + frame_interval;
            first_frame_wait_sequence = None;
        }

        if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    output_queue_high_water_frames,
                    output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
                    output_queue_oldest_frame_age_high_water_ms,
                    output_last_progress_age_ms: Some(
                        last_output_progress_at.elapsed().as_millis() as u64,
                    ),
                    output_queue_capacity_pressure_events,
                    output_pressure_recovery_events,
                    output_queue_dropped_frames,
                    output_pre_encode_skipped_frames,
                    video_toolbox_pending_encode_frames: pending_video_toolbox_output_frames,
                    video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
                    encoded_access_unit_dropped_frames,
                    input_fps: current_input_fps!(),
                    dropped_frames: 0,
                    encoder_speed: None,
                    repeated_fed_frames,
                    repeated_frame_bursts,
                    max_repeated_frame_run,
                    synthetic_fallback_frames,
                    source_to_encode_age_ms: max_source_to_encode_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
                    repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
                    repeated_frame_age_max_ms: max_repeated_frame_age_ms,
                    metal_target_frames,
                    raw_video_copied_frames,
                    metal_target_copied_frames,
                    metal_target_handle_frames,
                    zero_copy_frames,
                    video_toolbox_probe_frames,
                    video_toolbox_probe_bytes,
                    video_toolbox_probe_errors,
                    video_toolbox_output_frames,
                    video_toolbox_output_bytes,
                    video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
                    compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
                    video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
                    raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
                    video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
                    video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
                    video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
                    writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
                    writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
                    writer_active_p95_ms: p95_ms(&writer_active_times_ms),
                    deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
                    deadline_lag_max_ms: max_deadline_lag_ms,
                    late_deadline_ticks,
                    schedule_skipped_ms,
                },
                diagnostics_context,
                None,
            );
            window_started_at = Instant::now();
            frames_in_window = 0;
            raw_frames_delivered_in_window = 0;
            compositor_wait_times_ms.clear();
            video_toolbox_submit_times_ms.clear();
            video_toolbox_fifo_write_times_ms.clear();
            raw_video_fifo_write_times_ms.clear();
            video_toolbox_fifo_enqueue_times_ms.clear();
            writer_loop_times_ms.clear();
            writer_sleep_times_ms.clear();
            writer_active_times_ms.clear();
            source_to_encode_age_times_ms.clear();
            repeated_frame_age_times_ms.clear();
        }
    }

    #[cfg(target_os = "macos")]
    if video_output.uses_encoded_h264() {
        if let Err(error) = video_toolbox_probe.complete_pending() {
            video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} encoder final drain failed while completing VideoToolbox frames: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role),
                ),
            );
            terminal_writer_error.get_or_insert(error);
        }
        let drain_started_at = Instant::now();
        while (pending_video_toolbox_output_frames > 0 || pending_video_toolbox_fifo_frames > 0)
            && drain_started_at.elapsed() < Duration::from_secs(2)
        {
            let writer = video_toolbox_fifo_writer
                .as_mut()
                .expect("VideoToolbox FIFO writer must be running");
            let drain_result = drain_video_toolbox_output_frames(
                &mut video_toolbox_probe,
                writer,
                &mut pending_video_toolbox_output_frames,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_output_started_at,
                &mut pending_video_toolbox_fifo_started_at,
                &mut pending_completed_video_toolbox_frame,
                &mut output_queue_capacity_pressure_events,
                &mut video_toolbox_probe_errors,
                &mut video_toolbox_fifo_enqueue_times_ms,
                &mut max_video_toolbox_fifo_enqueue_ms,
                None,
            )
            .and_then(|_progress| {
                drain_video_toolbox_fifo_writer_results(
                    writer,
                    &mut pending_video_toolbox_fifo_frames,
                    &mut pending_video_toolbox_fifo_started_at,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
            });
            if let Err(error) = drain_result {
                if !drain_state.observe_error(&error) {
                    let error = record_encoder_bridge_terminal_failure(
                        &terminal_failure,
                        format!(
                            "{} encoder final drain failed: {error}",
                            encoder_bridge_output_role_label(output_queue_policy.role),
                        ),
                    );
                    terminal_writer_error.get_or_insert(error);
                }
                break;
            }
            if pending_video_toolbox_output_frames > 0 || pending_video_toolbox_fifo_frames > 0 {
                thread::sleep(Duration::from_millis(2));
            }
        }
        if drain_state.pending_timeout_is_terminal(
            pending_video_toolbox_output_frames,
            pending_video_toolbox_fifo_frames,
        ) {
            let error = record_encoder_bridge_terminal_failure(
                &terminal_failure,
                format!(
                    "{} encoder final drain timed out with {} VideoToolbox frame(s) and {} FIFO frame(s) pending",
                    encoder_bridge_output_role_label(output_queue_policy.role),
                    pending_video_toolbox_output_frames,
                    pending_video_toolbox_fifo_frames,
                ),
            );
            terminal_writer_error.get_or_insert(error);
        }
        if let Some(writer) = video_toolbox_fifo_writer.as_mut() {
            writer.close_and_join();
            if let Err(error) = drain_video_toolbox_fifo_writer_results(
                writer,
                &mut pending_video_toolbox_fifo_frames,
                &mut pending_video_toolbox_fifo_started_at,
                &mut zero_copy_frames,
                &mut video_toolbox_output_frames,
                &mut video_toolbox_output_bytes,
                &mut video_toolbox_fifo_write_times_ms,
            ) && !io_error_is_downstream_closed(&error)
            {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} encoder FIFO final drain failed: {error}",
                        encoder_bridge_output_role_label(output_queue_policy.role),
                    ),
                );
                terminal_writer_error.get_or_insert(error);
            }
        }
        queue_depth =
            pending_video_toolbox_output_frames.saturating_add(pending_video_toolbox_fifo_frames);
    }

    #[cfg(target_os = "windows")]
    if video_output.uses_media_foundation()
        && let (Some(encoder), Some(fifo), Some(ts_writer)) = (
            media_foundation_encoder.as_mut(),
            media_foundation_fifo.as_mut(),
            media_foundation_ts_writer.as_mut(),
        )
    {
        match encoder
            .drain(MEDIA_FOUNDATION_DRAIN_TIMEOUT)
            .and_then(|frames| {
                write_media_foundation_frames(
                    frames,
                    fifo,
                    ts_writer,
                    &stop,
                    &mut zero_copy_frames,
                    &mut video_toolbox_output_frames,
                    &mut video_toolbox_output_bytes,
                    &mut video_toolbox_fifo_write_times_ms,
                )
                .map_err(anyhow::Error::from)
            }) {
            Ok(()) => {
                queue_depth = encoder.pending_frame_count() as u64;
            }
            Err(error) => {
                let error = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!("Media Foundation encoder drain failed: {error}"),
                );
                terminal_writer_error = Some(error);
            }
        }
    }

    if let Some(writer) = raw_fifo_writer.as_mut() {
        writer.close_and_join();
        if let Err(error) = drain_raw_video_fifo_writer_results(
            writer,
            &mut pending_raw_fifo_frames,
            &mut pending_raw_fifo_started_at,
            &mut recycled_synthetic_buffer,
            &mut raw_video_copied_frames,
            &mut raw_frames_delivered_in_window,
            &mut metal_target_frames,
            &mut metal_target_copied_frames,
            &mut metal_target_handle_frames,
            &mut raw_video_fifo_write_times_ms,
        ) {
            terminal_writer_error.get_or_insert_with(|| {
                format!(
                    "{} raw-video encoder output stopped while draining: {error}",
                    encoder_bridge_output_role_label(output_queue_policy.role)
                )
            });
        }
        queue_depth = pending_raw_fifo_frames;
    }
    // Final-drain failures retain their exact depth/age in the high-water
    // fields and terminal error, while current-depth fields become truthful
    // for an output thread that no longer exists.
    output_queue_high_water_frames = output_queue_high_water_frames.max(queue_depth);
    if let Some(age_ms) = oldest_output_queue_age_ms!() {
        output_queue_oldest_frame_age_high_water_ms = Some(
            output_queue_oldest_frame_age_high_water_ms
                .map_or(age_ms, |current| current.max(age_ms)),
        );
    }
    emit_encoder_bridge_diagnostics_from_thread(
        &diagnostics_tx,
        session_id,
        target_fps,
        mark_encoder_bridge_output_inactive(EncoderBridgeRuntimeStats {
            queue_depth,
            output_queue_high_water_frames,
            output_queue_oldest_frame_age_ms: oldest_output_queue_age_ms!(),
            output_queue_oldest_frame_age_high_water_ms,
            output_last_progress_age_ms: Some(last_output_progress_at.elapsed().as_millis() as u64),
            output_queue_capacity_pressure_events,
            output_pressure_recovery_events,
            output_queue_dropped_frames,
            output_pre_encode_skipped_frames,
            video_toolbox_pending_encode_frames: pending_video_toolbox_output_frames,
            video_toolbox_pending_fifo_frames: pending_video_toolbox_fifo_frames,
            encoded_access_unit_dropped_frames,
            input_fps: current_input_fps!(),
            dropped_frames: 0,
            encoder_speed: None,
            repeated_fed_frames,
            repeated_frame_bursts,
            max_repeated_frame_run,
            synthetic_fallback_frames,
            source_to_encode_age_ms: max_source_to_encode_age_ms,
            source_to_encode_age_p95_ms: p95_ms(&source_to_encode_age_times_ms),
            repeated_frame_age_p95_ms: p95_ms(&repeated_frame_age_times_ms),
            repeated_frame_age_max_ms: max_repeated_frame_age_ms,
            metal_target_frames,
            raw_video_copied_frames,
            metal_target_copied_frames,
            metal_target_handle_frames,
            zero_copy_frames,
            video_toolbox_probe_frames,
            video_toolbox_probe_bytes,
            video_toolbox_probe_errors,
            video_toolbox_output_frames,
            video_toolbox_output_bytes,
            video_toolbox_output_encode_ms: max_video_toolbox_output_encode_ms,
            compositor_wait_p95_ms: p95_ms(&compositor_wait_times_ms),
            video_toolbox_submit_p95_ms: p95_ms(&video_toolbox_submit_times_ms),
            raw_video_fifo_write_p95_ms: p95_ms(&raw_video_fifo_write_times_ms),
            video_toolbox_fifo_write_p95_ms: p95_ms(&video_toolbox_fifo_write_times_ms),
            video_toolbox_fifo_enqueue_p95_ms: p95_ms(&video_toolbox_fifo_enqueue_times_ms),
            video_toolbox_fifo_enqueue_max_ms: max_video_toolbox_fifo_enqueue_ms,
            writer_loop_p95_ms: p95_ms(&writer_loop_times_ms),
            writer_sleep_p95_ms: p95_ms(&writer_sleep_times_ms),
            writer_active_p95_ms: p95_ms(&writer_active_times_ms),
            deadline_lag_p95_ms: p95_ms(&deadline_lag_times_ms),
            deadline_lag_max_ms: max_deadline_lag_ms,
            late_deadline_ticks,
            schedule_skipped_ms,
        }),
        diagnostics_context,
        terminal_writer_error,
    );
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct VideoToolboxBridgeEncoderConfig {
    width: usize,
    height: usize,
    expected_frame_rate: i32,
    max_key_frame_interval: i32,
    average_bit_rate_bps: Option<i64>,
    low_latency: bool,
}

#[cfg(target_os = "macos")]
impl VideoToolboxBridgeEncoderConfig {
    fn from_recording_profile(
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: Option<u32>,
        low_latency: bool,
    ) -> Self {
        let expected_frame_rate = i32::try_from(fps.max(1)).unwrap_or(i32::MAX);
        Self {
            width: width.max(1) as usize,
            height: height.max(1) as usize,
            expected_frame_rate,
            max_key_frame_interval: expected_frame_rate.saturating_mul(2).max(1),
            average_bit_rate_bps: bitrate_kbps
                .map(|bitrate_kbps| i64::from(bitrate_kbps).saturating_mul(1_000)),
            low_latency,
        }
    }
}

#[cfg(target_os = "macos")]
struct EncoderBridgeVideoToolboxProbe {
    enabled: bool,
    config: VideoToolboxBridgeEncoderConfig,
    session: Option<VideoToolboxH264Session>,
    output_tx: std_mpsc::Sender<VideoToolboxH264AsyncAnnexBFrame>,
    output_rx: std_mpsc::Receiver<VideoToolboxH264AsyncAnnexBFrame>,
    disabled_after_error: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
enum VideoToolboxProbeOutcome {
    Disabled,
    NoTarget,
    Submitted,
    Encoded { frame: VideoToolboxH264AnnexBFrame },
    Failed,
}

#[cfg(target_os = "macos")]
impl EncoderBridgeVideoToolboxProbe {
    fn new(
        enabled: bool,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: Option<u32>,
        low_latency: bool,
    ) -> Self {
        // The callback must never block while complete_pending_frames waits on
        // the bridge thread. Admission caps submitted frames at the output
        // policy ceiling, so this unbounded transport is logically bounded.
        let (output_tx, output_rx) = std_mpsc::channel();
        Self {
            enabled,
            config: VideoToolboxBridgeEncoderConfig::from_recording_profile(
                width,
                height,
                fps,
                bitrate_kbps,
                low_latency,
            ),
            session: None,
            output_tx,
            output_rx,
            disabled_after_error: false,
        }
    }

    fn encode_frame(
        &mut self,
        frame: &FedCompositorFrame,
        frame_index: u64,
    ) -> VideoToolboxProbeOutcome {
        if !self.enabled || self.disabled_after_error {
            return VideoToolboxProbeOutcome::Disabled;
        }
        let Some(target) = frame.metal_target.as_ref() else {
            return VideoToolboxProbeOutcome::NoTarget;
        };
        if self.session.is_none() && self.prepare_session().is_err() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        let Some(session) = self.session.as_ref() else {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        };
        let frame_index = match i64::try_from(frame_index) {
            Ok(frame_index) => frame_index,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let timing = match VideoToolboxFrameTiming::frame_index(
            frame_index,
            self.config.expected_frame_rate,
        ) {
            Ok(timing) => timing,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let frame =
            match session.encode_retained_target_annex_b_with_timing(target.as_ref(), timing) {
                Ok(frame) => frame,
                Err(_) => {
                    self.disabled_after_error = true;
                    return VideoToolboxProbeOutcome::Failed;
                }
            };
        if frame.bytes.is_empty() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        VideoToolboxProbeOutcome::Encoded { frame }
    }

    fn submit_output_frame(
        &mut self,
        frame: &FedCompositorFrame,
        frame_index: u64,
    ) -> VideoToolboxProbeOutcome {
        if !self.enabled || self.disabled_after_error {
            return VideoToolboxProbeOutcome::Disabled;
        }
        let Some(target) = frame.metal_target.as_ref() else {
            return VideoToolboxProbeOutcome::NoTarget;
        };
        if self.session.is_none() && self.prepare_session().is_err() {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        let Some(session) = self.session.as_ref() else {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        };
        let frame_index_i64 = match i64::try_from(frame_index) {
            Ok(frame_index) => frame_index,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        let timing = match VideoToolboxFrameTiming::frame_index(
            frame_index_i64,
            self.config.expected_frame_rate,
        ) {
            Ok(timing) => timing,
            Err(_) => {
                self.disabled_after_error = true;
                return VideoToolboxProbeOutcome::Failed;
            }
        };
        if session
            .submit_retained_target_annex_b_with_timing(
                target.clone(),
                timing,
                frame_index,
                self.output_tx.clone(),
            )
            .is_err()
        {
            self.disabled_after_error = true;
            return VideoToolboxProbeOutcome::Failed;
        }
        VideoToolboxProbeOutcome::Submitted
    }

    fn try_recv_output(&mut self) -> Option<VideoToolboxH264AsyncAnnexBFrame> {
        self.output_rx.try_recv().ok()
    }

    fn complete_pending(&self) -> Result<()> {
        if let Some(session) = self.session.as_ref() {
            session.complete_pending_frames()?;
        }
        Ok(())
    }

    fn prepare_session(&mut self) -> Result<()> {
        let session = VideoToolboxH264Session::new_tuned(
            self.config.width,
            self.config.height,
            self.config.expected_frame_rate,
            self.config.max_key_frame_interval,
            self.config.average_bit_rate_bps,
            self.config.low_latency,
        )?;
        session.prepare()?;
        self.session = Some(session);
        Ok(())
    }
}

struct RawVideoFifoWriter {
    frame_mailbox: Arc<LatestRawVideoFrameMailbox>,
    result_rx: std_mpsc::Receiver<RawVideoFifoWriterResult>,
    join: Option<thread::JoinHandle<()>>,
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
}

#[derive(Default)]
struct LatestRawVideoFrameMailbox {
    state: StdMutex<LatestRawVideoFrameMailboxState>,
    ready: Condvar,
}

#[derive(Default)]
struct LatestRawVideoFrameMailboxState {
    pending: Option<QueuedRawVideoFrame>,
    closed: bool,
}

enum LatestRawVideoFrameOffer {
    Enqueued,
    Replaced(QueuedRawVideoFrame),
}

impl LatestRawVideoFrameMailbox {
    fn offer(
        &self,
        frame: QueuedRawVideoFrame,
    ) -> std::result::Result<LatestRawVideoFrameOffer, QueuedRawVideoFrame> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return Err(frame);
        }
        let replaced = state.pending.replace(frame);
        self.ready.notify_one();
        Ok(match replaced {
            Some(frame) => LatestRawVideoFrameOffer::Replaced(frame),
            None => LatestRawVideoFrameOffer::Enqueued,
        })
    }

    fn receive(&self) -> Option<QueuedRawVideoFrame> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(frame) = state.pending.take() {
                return Some(frame);
            }
            if state.closed {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.closed = true;
        self.ready.notify_all();
    }
}

enum RawVideoFramePayload {
    /// Immutable compositor allocation retained until the FIFO write finishes.
    Compositor(CompositorFrameHandle),
    /// Only synthetic fallback frames need bridge-owned storage.
    Synthetic(Vec<u8>),
}

impl RawVideoFramePayload {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Compositor(frame) => &frame.bytes,
            Self::Synthetic(bytes) => bytes,
        }
    }

    fn into_synthetic_buffer(self) -> Option<Vec<u8>> {
        match self {
            Self::Compositor(_) => None,
            Self::Synthetic(bytes) => Some(bytes),
        }
    }
}

// Carries NO timestamp on purpose (#149): frame age is a queue-admission
// concern; once a frame reaches the writer it is written or the pipe is
// declared stalled — the writer must be structurally unable to drop by age.
struct QueuedRawVideoFrame {
    payload: RawVideoFramePayload,
    had_metal_target: bool,
    had_metal_export_handle: bool,
}

impl QueuedRawVideoFrame {
    fn compositor(frame: &FedCompositorFrame) -> Self {
        Self {
            payload: RawVideoFramePayload::Compositor(frame.frame.clone()),
            had_metal_target: frame.has_metal_iosurface_target,
            had_metal_export_handle: frame.has_metal_export_handle,
        }
    }

    fn synthetic(bytes: Vec<u8>) -> Self {
        Self {
            payload: RawVideoFramePayload::Synthetic(bytes),
            had_metal_target: false,
            had_metal_export_handle: false,
        }
    }

    fn bytes(&self) -> &[u8] {
        self.payload.bytes()
    }

    fn into_synthetic_buffer(self) -> Option<Vec<u8>> {
        self.payload.into_synthetic_buffer()
    }
}

enum RawVideoFifoEnqueueOutcome {
    Enqueued,
    Coalesced(QueuedRawVideoFrame),
}

#[derive(Debug)]
enum RawVideoFifoWriterResult {
    FrameWritten {
        synthetic_buffer: Option<Vec<u8>>,
        write_ms: f64,
        had_metal_target: bool,
        had_metal_export_handle: bool,
    },
    Error {
        synthetic_buffer: Option<Vec<u8>>,
        message: String,
    },
}

impl RawVideoFifoWriter {
    fn start(
        fifo: File,
        policy: EncoderBridgeOutputQueuePolicy,
        stop: Arc<AtomicBool>,
        terminal_failure: Arc<StdMutex<Option<String>>>,
        lifecycle: Option<EncoderBridgeWriterLifecycle>,
    ) -> Self {
        Self::start_with_sink(fifo, policy, stop, terminal_failure, lifecycle)
    }

    fn start_with_sink<W>(
        fifo: W,
        policy: EncoderBridgeOutputQueuePolicy,
        stop: Arc<AtomicBool>,
        terminal_failure: Arc<StdMutex<Option<String>>>,
        lifecycle: Option<EncoderBridgeWriterLifecycle>,
    ) -> Self
    where
        W: StdWrite + Send + 'static,
    {
        let max_frames = RAW_VIDEO_FIFO_QUEUE_MAX_FRAMES;
        let frame_mailbox = Arc::new(LatestRawVideoFrameMailbox::default());
        let writer_mailbox = frame_mailbox.clone();
        // Queue + one in-flight result + one terminal flush result.
        let (result_tx, result_rx) = std_mpsc::sync_channel(max_frames + 2);
        let join = spawn_registered_fifo_writer(
            lifecycle.clone(),
            thread::Builder::new().name(format!("videorc-{:?}-raw-video-fifo-writer", policy.role)),
            move || {
                run_raw_video_fifo_writer_loop_with_receiver(
                    fifo,
                    || writer_mailbox.receive(),
                    result_tx,
                    stop,
                    terminal_failure,
                    policy.role,
                );
            },
        )
        .expect("could not start raw-video FIFO writer thread");
        Self {
            frame_mailbox,
            result_rx,
            join: Some(join),
            lifecycle,
        }
    }

    fn enqueue(
        &self,
        frame: QueuedRawVideoFrame,
        capacity_pressure_events: &mut u64,
    ) -> io::Result<RawVideoFifoEnqueueOutcome> {
        match self.frame_mailbox.offer(frame) {
            Ok(LatestRawVideoFrameOffer::Enqueued) => Ok(RawVideoFifoEnqueueOutcome::Enqueued),
            Ok(LatestRawVideoFrameOffer::Replaced(frame)) => {
                *capacity_pressure_events = capacity_pressure_events.saturating_add(1);
                Ok(RawVideoFifoEnqueueOutcome::Coalesced(frame))
            }
            Err(_) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw-video FIFO writer stopped",
            )),
        }
    }

    fn enqueue_startup(&self, frame: QueuedRawVideoFrame) -> io::Result<()> {
        self.frame_mailbox.offer(frame).map(|_| ()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw-video FIFO writer stopped during startup priming",
            )
        })
    }

    fn try_recv_result(&mut self) -> Option<RawVideoFifoWriterResult> {
        self.result_rx.try_recv().ok()
    }

    fn close_and_join(&mut self) {
        const WRITER_CLOSE_JOIN_GRACE: Duration = Duration::from_secs(3);
        self.close_and_join_until(Instant::now() + WRITER_CLOSE_JOIN_GRACE);
    }

    fn close_and_join_until(&mut self, deadline_at: Instant) -> BoundedWriterJoinOutcome {
        self.frame_mailbox.close();
        if let Some(join) = self.join.take() {
            let outcome = bounded_writer_join_until(join, deadline_at);
            if outcome == BoundedWriterJoinOutcome::Detached
                && let Some(lifecycle) = self.lifecycle.as_ref()
            {
                lifecycle.mark_detached();
            }
            outcome
        } else {
            BoundedWriterJoinOutcome::Joined
        }
    }
}

impl Drop for RawVideoFifoWriter {
    fn drop(&mut self) {
        self.close_and_join();
    }
}

#[cfg(test)]
fn run_raw_video_fifo_writer_loop<W: StdWrite>(
    mut sink: W,
    frame_rx: std_mpsc::Receiver<QueuedRawVideoFrame>,
    result_tx: std_mpsc::SyncSender<RawVideoFifoWriterResult>,
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    role: EncoderBridgeOutputRole,
) {
    run_raw_video_fifo_writer_loop_with_receiver(
        &mut sink,
        || frame_rx.recv().ok(),
        result_tx,
        stop,
        terminal_failure,
        role,
    );
}

fn run_raw_video_fifo_writer_loop_with_receiver<W, F>(
    mut sink: W,
    mut receive: F,
    result_tx: std_mpsc::SyncSender<RawVideoFifoWriterResult>,
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    role: EncoderBridgeOutputRole,
) where
    W: StdWrite,
    F: FnMut() -> Option<QueuedRawVideoFrame>,
{
    while let Some(frame) = receive() {
        let write_started_at = Instant::now();
        // The deadline anchors at WRITE START, not submit time: a latest-wins
        // frame that waited out an encoder pause is still valid recording
        // content — a recording tolerates late frames, never dropped ones
        // (issue #149). Progress is judged by the platform stall tolerance;
        // the hard timeout bounds the whole frame.
        let deadline = write_started_at + RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE;
        // Once any raw frame bytes reach FFmpeg, stopping mid-frame would
        // misalign every following YUV plane and can corrupt the final file.
        // Finish the in-flight frame; closing the queue prevents any new work
        // from being admitted during stop.
        match write_all_until(
            &mut sink,
            frame.bytes(),
            &stop,
            deadline,
            RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE,
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            false,
        ) {
            Ok(()) => {
                let had_metal_target = frame.had_metal_target;
                let had_metal_export_handle = frame.had_metal_export_handle;
                let _ = result_tx.send(RawVideoFifoWriterResult::FrameWritten {
                    synthetic_buffer: frame.into_synthetic_buffer(),
                    write_ms: write_started_at.elapsed().as_secs_f64() * 1000.0,
                    had_metal_target,
                    had_metal_export_handle,
                });
            }
            Err(error) => {
                let message = record_encoder_bridge_terminal_failure(
                    &terminal_failure,
                    format!(
                        "{} raw-video encoder output stopped: {error}",
                        encoder_bridge_output_role_label(role)
                    ),
                );
                let _ = result_tx.send(RawVideoFifoWriterResult::Error {
                    synthetic_buffer: frame.into_synthetic_buffer(),
                    message,
                });
                return;
            }
        }
    }
    if !stop.load(Ordering::Relaxed)
        && let Err(error) = sink.flush()
    {
        let message = record_encoder_bridge_terminal_failure(
            &terminal_failure,
            format!(
                "{} raw-video encoder output flush failed: {error}",
                encoder_bridge_output_role_label(role)
            ),
        );
        let _ = result_tx.send(RawVideoFifoWriterResult::Error {
            synthetic_buffer: None,
            message,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn drain_raw_video_fifo_writer_results(
    fifo_writer: &mut RawVideoFifoWriter,
    pending_frames: &mut u64,
    pending_started_at: &mut VecDeque<Instant>,
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    raw_video_copied_frames: &mut u64,
    raw_frames_delivered_in_window: &mut u64,
    metal_target_frames: &mut u64,
    metal_target_copied_frames: &mut u64,
    metal_target_handle_frames: &mut u64,
    fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    while let Some(result) = fifo_writer.try_recv_result() {
        match result {
            RawVideoFifoWriterResult::FrameWritten {
                synthetic_buffer,
                write_ms,
                had_metal_target,
                had_metal_export_handle,
            } => {
                *pending_frames = pending_frames.saturating_sub(1);
                pending_started_at.pop_front();
                *raw_video_copied_frames = raw_video_copied_frames.saturating_add(1);
                *raw_frames_delivered_in_window = raw_frames_delivered_in_window.saturating_add(1);
                if had_metal_target {
                    *metal_target_frames = metal_target_frames.saturating_add(1);
                    *metal_target_copied_frames = metal_target_copied_frames.saturating_add(1);
                }
                if had_metal_export_handle {
                    *metal_target_handle_frames = metal_target_handle_frames.saturating_add(1);
                }
                fifo_write_times_ms.push(write_ms);
                retain_recycled_synthetic_buffer(recycled_synthetic_buffer, synthetic_buffer);
            }
            RawVideoFifoWriterResult::Error {
                synthetic_buffer,
                message,
            } => {
                retain_recycled_synthetic_buffer(recycled_synthetic_buffer, synthetic_buffer);
                *pending_frames = 0;
                pending_started_at.clear();
                return Err(io::Error::other(message));
            }
        }
    }
    Ok(())
}

fn take_recycled_synthetic_buffer(
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    byte_len: usize,
) -> Vec<u8> {
    let mut buffer = recycled_synthetic_buffer
        .take()
        .unwrap_or_else(|| vec![0; byte_len]);
    buffer.resize(byte_len, 0);
    buffer
}

fn retain_recycled_synthetic_buffer(
    recycled_synthetic_buffer: &mut Option<Vec<u8>>,
    returned: Option<Vec<u8>>,
) {
    if recycled_synthetic_buffer.is_none() {
        *recycled_synthetic_buffer = returned;
    }
}

#[cfg(target_os = "macos")]
struct VideoToolboxFifoWriter {
    frame_tx: Option<std_mpsc::SyncSender<QueuedVideoToolboxFrame>>,
    result_rx: std_mpsc::Receiver<VideoToolboxFifoWriterResult>,
    join: Option<thread::JoinHandle<()>>,
    lifecycle: Option<EncoderBridgeWriterLifecycle>,
}

#[cfg(target_os = "macos")]
struct QueuedVideoToolboxFrame {
    frame: VideoToolboxH264AnnexBFrame,
}

#[cfg(target_os = "macos")]
struct CompletedVideoToolboxOutputFrame {
    frame_index: u64,
    frame: VideoToolboxH264AnnexBFrame,
    submitted_at: Instant,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct VideoToolboxOutputDrainProgress {
    callback_completions: u64,
}

#[cfg(target_os = "macos")]
enum VideoToolboxFifoEnqueueOutcome {
    Enqueued,
    CapacityPressure(VideoToolboxH264AnnexBFrame),
}

#[cfg(target_os = "macos")]
struct VideoToolboxFifoTestPause {
    after_frames: u64,
    duration: Duration,
    fired: bool,
}

#[cfg(target_os = "macos")]
impl VideoToolboxFifoTestPause {
    fn take_before_write(&mut self, written_frames: u64) -> Option<Duration> {
        if self.fired || written_frames < self.after_frames {
            return None;
        }
        self.fired = true;
        Some(self.duration)
    }
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn parse_video_toolbox_fifo_test_pause(
    role: EncoderBridgeOutputRole,
    after_frames: Option<&str>,
    pause_ms: Option<&str>,
) -> Option<VideoToolboxFifoTestPause> {
    if !matches!(
        role,
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared
    ) {
        return None;
    }
    let after_frames = after_frames?.trim().parse::<u64>().ok()?;
    let pause_ms = pause_ms?.trim().parse::<u64>().ok()?;
    if pause_ms == 0 {
        return None;
    }
    Some(VideoToolboxFifoTestPause {
        after_frames,
        duration: Duration::from_millis(pause_ms),
        fired: false,
    })
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn video_toolbox_fifo_test_pause_from_env(
    role: EncoderBridgeOutputRole,
) -> Option<VideoToolboxFifoTestPause> {
    parse_video_toolbox_fifo_test_pause(
        role,
        std::env::var(VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES_ENV)
            .ok()
            .as_deref(),
        std::env::var(VIDEORC_TEST_VT_FIFO_PAUSE_MS_ENV)
            .ok()
            .as_deref(),
    )
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum VideoToolboxFifoWriterResult {
    FrameWritten {
        encoded_bytes: u64,
        write_ms: f64,
    },
    Error {
        message: String,
        /// True when the write side saw EPIPE/EOF — the downstream FFmpeg
        /// closed or exited. That is not a bridge verdict: the process exit
        /// status is the authority, and treating it as a terminal bridge
        /// failure condemned healthy recordings when the STREAM writer died
        /// first and FFmpeg exited cleanly (2026-07-15 incident cascade).
        downstream_closed: bool,
    },
}

#[cfg(target_os = "macos")]
impl VideoToolboxFifoWriter {
    fn start(
        fifo: File,
        video_output: EncoderBridgeVideoOutput,
        policy: EncoderBridgeOutputQueuePolicy,
        stop: Arc<AtomicBool>,
        lifecycle: Option<EncoderBridgeWriterLifecycle>,
    ) -> Self {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(policy.max_frames);
        // The writer can have the full input queue plus one frame in flight.
        // One extra slot preserves a terminal flush error without deadlocking
        // close_and_join if the bridge is already tearing down.
        let (result_tx, result_rx) = std_mpsc::sync_channel(policy.max_frames + 2);
        #[cfg(debug_assertions)]
        let test_pause = video_toolbox_fifo_test_pause_from_env(policy.role);
        #[cfg(not(debug_assertions))]
        let test_pause = None;
        let join = spawn_registered_fifo_writer(
            lifecycle.clone(),
            thread::Builder::new().name(format!("videorc-{:?}-h264-fifo-writer", policy.role)),
            move || {
                run_video_toolbox_fifo_writer_loop(
                    fifo,
                    VideoToolboxH264PipeWriter::for_output(video_output),
                    frame_rx,
                    result_tx,
                    stop,
                    VIDEOTOOLBOX_FIFO_WRITE_STALL_TOLERANCE,
                    test_pause,
                );
            },
        )
        .expect("could not start VideoToolbox FIFO writer thread");
        Self {
            frame_tx: Some(frame_tx),
            result_rx,
            join: Some(join),
            lifecycle,
        }
    }

    fn enqueue(
        &self,
        frame: VideoToolboxH264AnnexBFrame,
    ) -> io::Result<VideoToolboxFifoEnqueueOutcome> {
        let tx = self
            .frame_tx
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "H.264 FIFO writer closed"))?;
        match offer_preserving_output_frame(tx, QueuedVideoToolboxFrame { frame }) {
            Ok(PreservingOutputFrameOffer::Enqueued) => {
                Ok(VideoToolboxFifoEnqueueOutcome::Enqueued)
            }
            Ok(PreservingOutputFrameOffer::CapacityPressure(queued)) => Ok(
                VideoToolboxFifoEnqueueOutcome::CapacityPressure(queued.frame),
            ),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "H.264 FIFO writer stopped",
            )),
        }
    }

    fn try_recv_result(&mut self) -> Option<VideoToolboxFifoWriterResult> {
        self.result_rx.try_recv().ok()
    }

    fn close_and_join(&mut self) {
        self.frame_tx.take();
        if let Some(join) = self.join.take()
            && bounded_writer_join(join) == BoundedWriterJoinOutcome::Detached
            && let Some(lifecycle) = self.lifecycle.as_ref()
        {
            lifecycle.mark_detached();
        }
    }
}

/// Join a writer thread with a bounded grace, then DETACH it. A writer blocked
/// on a stalled sink (dead RTMP ingest, wedged fifo consumer) must not wedge
/// session teardown — the unbounded join here was one of the two places a
/// stop against an unresponsive Twitch endpoint hung until Force stop
/// (owner report, 2026-08-19). A detached thread is reaped when the fifo/pipe
/// closes or at process teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundedWriterJoinOutcome {
    Joined,
    Detached,
}

fn bounded_writer_join<T>(join: std::thread::JoinHandle<T>) -> BoundedWriterJoinOutcome {
    const WRITER_CLOSE_JOIN_GRACE: Duration = Duration::from_secs(3);
    bounded_writer_join_until(join, Instant::now() + WRITER_CLOSE_JOIN_GRACE)
}

fn bounded_writer_join_until<T>(
    join: std::thread::JoinHandle<T>,
    deadline_at: Instant,
) -> BoundedWriterJoinOutcome {
    while !join.is_finished() {
        if Instant::now() >= deadline_at {
            drop(join);
            return BoundedWriterJoinOutcome::Detached;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = join.join();
    BoundedWriterJoinOutcome::Joined
}

enum PreservingOutputFrameOffer<T> {
    Enqueued,
    CapacityPressure(T),
}

fn offer_preserving_output_frame<T>(
    tx: &std_mpsc::SyncSender<T>,
    frame: T,
) -> std::result::Result<PreservingOutputFrameOffer<T>, T> {
    match tx.try_send(frame) {
        Ok(()) => Ok(PreservingOutputFrameOffer::Enqueued),
        Err(std_mpsc::TrySendError::Full(frame)) => {
            Ok(PreservingOutputFrameOffer::CapacityPressure(frame))
        }
        Err(std_mpsc::TrySendError::Disconnected(frame)) => Err(frame),
    }
}

#[cfg(target_os = "macos")]
impl Drop for VideoToolboxFifoWriter {
    fn drop(&mut self) {
        self.close_and_join();
    }
}

#[cfg(target_os = "macos")]
fn run_video_toolbox_fifo_writer_loop<W: StdWrite>(
    mut sink: W,
    mut h264_pipe_writer: VideoToolboxH264PipeWriter,
    frame_rx: std_mpsc::Receiver<QueuedVideoToolboxFrame>,
    result_tx: std_mpsc::SyncSender<VideoToolboxFifoWriterResult>,
    stop: Arc<AtomicBool>,
    write_stall_tolerance: Duration,
    mut test_pause: Option<VideoToolboxFifoTestPause>,
) {
    let mut written_frames = 0_u64;
    while let Ok(queued) = frame_rx.recv() {
        let encoded_bytes = queued.frame.bytes.len() as u64;
        if let Some(duration) = test_pause
            .as_mut()
            .and_then(|pause| pause.take_before_write(written_frames))
        {
            tracing::warn!(
                target: "videorc::encoder_bridge",
                test_hook = "videotoolbox-fifo-pause",
                written_frames,
                pause_ms = duration.as_millis() as u64,
                "VIDEORC_TEST_VT_FIFO_PAUSE_FIRED"
            );
            thread::sleep(duration);
        }
        let write_started_at = Instant::now();
        // Queue age is pressure diagnostics, not FIFO liveness. A recording
        // access unit that waited behind transient encoder pressure is still
        // valid content and must receive a fresh write window (#149's raw
        // writer contract). The hard timeout still bounds the complete write.
        let deadline = write_started_at + write_stall_tolerance;
        match h264_pipe_writer.write_frame_until(
            &mut sink,
            &queued.frame,
            &stop,
            deadline,
            write_stall_tolerance,
        ) {
            Ok(()) => {
                written_frames = written_frames.saturating_add(1);
                let _ = result_tx.send(VideoToolboxFifoWriterResult::FrameWritten {
                    encoded_bytes,
                    write_ms: write_started_at.elapsed().as_secs_f64() * 1000.0,
                });
            }
            Err(error) => {
                let _ = result_tx.send(VideoToolboxFifoWriterResult::Error {
                    message: error.to_string(),
                    downstream_closed: io_error_is_downstream_closed(&error),
                });
                return;
            }
        }
    }
    if !stop.load(Ordering::Relaxed)
        && let Err(error) = sink.flush()
    {
        let _ = result_tx.send(VideoToolboxFifoWriterResult::Error {
            message: error.to_string(),
            downstream_closed: io_error_is_downstream_closed(&error),
        });
    }
}

/// EPIPE/EOF class: the reader (FFmpeg) went away. The writer must stop, but
/// the SESSION verdict belongs to the process exit status, not this error.
fn io_error_is_downstream_closed(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::WriteZero | io::ErrorKind::UnexpectedEof
    )
}

#[cfg(target_os = "macos")]
enum VideoToolboxH264PipeWriter {
    AnnexB,
    MpegTs {
        writer: MpegTsH264Writer,
        access_unit_buffer: Vec<u8>,
        base_pts_90khz: Option<u64>,
    },
}

#[cfg(target_os = "macos")]
impl VideoToolboxH264PipeWriter {
    fn for_output(video_output: EncoderBridgeVideoOutput) -> Self {
        match video_output {
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs
            | EncoderBridgeVideoOutput::WindowsMediaFoundationH264MpegTs => Self::MpegTs {
                writer: MpegTsH264Writer::new(),
                access_unit_buffer: Vec::new(),
                base_pts_90khz: None,
            },
            EncoderBridgeVideoOutput::RawYuv420p
            | EncoderBridgeVideoOutput::VideoToolboxH264AnnexB => Self::AnnexB,
        }
    }

    #[cfg(test)]
    fn write_frame<W: StdWrite>(
        &mut self,
        sink: &mut W,
        frame: &VideoToolboxH264AnnexBFrame,
    ) -> io::Result<()> {
        let bytes = self.frame_bytes(frame)?;
        sink.write_all(bytes)
    }

    fn write_frame_until<W: StdWrite>(
        &mut self,
        sink: &mut W,
        frame: &VideoToolboxH264AnnexBFrame,
        stop: &AtomicBool,
        deadline: Instant,
        write_stall_tolerance: Duration,
    ) -> io::Result<()> {
        let bytes = self.frame_bytes(frame)?;
        write_all_until(
            sink,
            bytes,
            stop,
            deadline,
            write_stall_tolerance,
            FIFO_FRAME_WRITE_HARD_TIMEOUT,
            // Stop closes the sender and prevents new access units. Finish the
            // one already in flight so an ordinary user stop cannot manufacture
            // a bridge failure and strand a complete recording as recovery MKV.
            false,
        )
    }

    fn frame_bytes<'a>(
        &'a mut self,
        frame: &'a VideoToolboxH264AnnexBFrame,
    ) -> io::Result<&'a [u8]> {
        match self {
            Self::AnnexB => Ok(&frame.bytes),
            Self::MpegTs {
                writer,
                access_unit_buffer,
                base_pts_90khz,
            } => {
                let raw_pts_90khz = timing_to_90khz(
                    frame.timing.presentation_time_value,
                    frame.timing.presentation_time_scale,
                )
                .ok_or_else(|| {
                    io::Error::other("VideoToolbox frame timing cannot be mapped to MPEG-TS PTS")
                })?;
                // Rebase to the first frame: VideoToolbox stamps carry the
                // session-startup offset (seconds of host time), while the
                // audio leg starts at the shared video epoch = first frame.
                // Without this the container starts video ~startup-latency
                // AFTER audio (plan 023: 4000ms skew in the split baseline).
                let base = *base_pts_90khz.get_or_insert(raw_pts_90khz);
                let pts_90khz = raw_pts_90khz.saturating_sub(base);
                access_unit_buffer.clear();
                writer
                    .write_h264_access_unit(access_unit_buffer, pts_90khz, &frame.bytes)
                    .map(|_| ())?;
                Ok(access_unit_buffer)
            }
        }
    }
}

fn write_all_until<W: StdWrite>(
    sink: &mut W,
    mut bytes: &[u8],
    stop: &AtomicBool,
    mut deadline: Instant,
    progress_timeout: Duration,
    hard_timeout: Duration,
    cancel_on_stop: bool,
) -> io::Result<()> {
    let hard_deadline = Instant::now()
        .checked_add(hard_timeout)
        .unwrap_or_else(Instant::now);
    let mut consecutive_no_progress = 0_u32;
    while !bytes.is_empty() {
        if cancel_on_stop && stop.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Encoder FIFO writer stopped during a bounded write",
            ));
        }
        if Instant::now() >= deadline || Instant::now() >= hard_deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Encoder FIFO write exceeded the complete-frame delivery budget",
            ));
        }
        match sink.write(bytes) {
            Ok(0) => {
                consecutive_no_progress = consecutive_no_progress.saturating_add(1);
                wait_for_fifo_write_progress(consecutive_no_progress, deadline.min(hard_deadline));
            }
            Ok(written) => {
                bytes = &bytes[written..];
                consecutive_no_progress = 0;
                // Raw frames are indivisible. Once part of one reaches FFmpeg,
                // aborting on the original queue-age deadline leaves a terminal
                // short packet and corrupts/truncates the recording. Continued
                // byte progress proves the reader is alive, so use a sliding
                // no-progress deadline until this frame is complete.
                if !bytes.is_empty() {
                    deadline = Instant::now()
                        .checked_add(progress_timeout)
                        .unwrap_or_else(Instant::now)
                        .min(hard_deadline);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                consecutive_no_progress = consecutive_no_progress.saturating_add(1);
                wait_for_fifo_write_progress(consecutive_no_progress, deadline.min(hard_deadline));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
struct WindowsD3d11RecordingWriterParams {
    session_id: String,
    target_fps: u32,
    fifo: File,
    input: WindowsD3d11EncoderTicketSource,
    stop: Arc<AtomicBool>,
    terminal_failure: Arc<StdMutex<Option<String>>>,
    startup_ready_tx: Option<oneshot::Sender<std::result::Result<(), String>>>,
    diagnostics_tx: watch::Sender<Option<EncoderBridgeWriterEvent>>,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    video_epoch: Arc<OnceLock<Instant>>,
}

#[cfg(target_os = "windows")]
fn write_windows_d3d11_recording_frames(params: WindowsD3d11RecordingWriterParams) {
    let WindowsD3d11RecordingWriterParams {
        session_id,
        target_fps,
        mut fifo,
        input,
        stop,
        terminal_failure,
        mut startup_ready_tx,
        diagnostics_tx,
        diagnostics_context,
        video_epoch,
    } = params;
    let target_fps = target_fps.max(1);
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps));
    let encoder_started_at = Instant::now();
    let mut generation_started_at = encoder_started_at;
    let mut next_frame_at = encoder_started_at;
    let mut schedule_index = 0_u64;
    let mut last_submitted_sequence = None;
    let mut first_output_written = false;
    let mut window_started_at = Instant::now();
    let mut input_frames = 0_u64;
    let mut output_frames = 0_u64;
    let mut output_bytes = 0_u64;
    let mut fifo_write_times_ms = Vec::with_capacity(128);
    let mut ts_writer = MpegTsH264Writer::new();
    let mut pressure_skips = 0_u64;
    let mut max_source_age_ms = None;
    let mut source_age_times_ms = Vec::with_capacity(128);
    let mut terminal_error = None;
    let mut current_input = input.current();
    let mut recovery_wait_started_at = None;
    // The frame store is single-slot latest-wins: a publish that lands while
    // this loop sleeps destroys the previous frame before it is read. Track
    // the newest sequence we have seen published so the pacing wait below can
    // wake the moment fresh work exists instead of one clock period late.
    let mut last_seen_published = current_input.latest_published_sequence();

    if let Err(error) = validate_windows_d3d11_encoder_input(&current_input) {
        finish_windows_d3d11_writer_failure(
            &terminal_failure,
            &mut startup_ready_tx,
            &diagnostics_tx,
            &session_id,
            target_fps,
            diagnostics_context,
            error,
        );
        return;
    }

    while !stop.load(Ordering::Relaxed) {
        if let Some(error) = current_input.terminal_error() {
            match wait_for_windows_d3d11_generation_replacement(
                &input,
                &current_input,
                &mut recovery_wait_started_at,
                format!(
                    "Unified D3D11 media pump stopped before the {:?} encoder input: {error}",
                    current_input.role
                ),
            ) {
                Ok(Some(replacement)) => {
                    current_input = replacement;
                    last_submitted_sequence = None;
                    last_seen_published = current_input.latest_published_sequence();
                    recovery_wait_started_at = None;
                    generation_started_at = Instant::now();
                    next_frame_at = generation_started_at;
                    schedule_index =
                        windows_d3d11_schedule_index_at(encoder_started_at.elapsed(), target_fps);
                }
                Ok(None) => {}
                Err(error) => {
                    terminal_error = Some(error);
                    break;
                }
            }
            continue;
        }
        let now = Instant::now();
        if now < next_frame_at {
            // Bounded wait for the scheduled tick, cut short as soon as the
            // pump publishes a sequence newer than the last one observed.
            // Polling at 1ms costs at most ~33 wakeups per second while
            // preserving the wall-anchored CFR schedule.
            let mut wait_now = now;
            while wait_now < next_frame_at {
                let published = current_input.latest_published_sequence();
                if windows_d3d11_primary_sequence_is_newer(published, last_seen_published) {
                    last_seen_published = published;
                    break;
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(WINDOWS_D3D11_ENCODER_DRAIN_POLL_INTERVAL);
                wait_now = Instant::now();
            }
            let published = current_input.latest_published_sequence();
            if windows_d3d11_primary_sequence_is_newer(published, last_seen_published) {
                last_seen_published = published;
            }
        }
        next_frame_at += frame_interval;
        schedule_index = schedule_index.saturating_add(1);

        let mut queue_depth = match current_input.client.poll_encoder(current_input.role) {
            Ok(progress) => {
                let queue_depth = progress.status.pending_frame_count as u64;
                if let Err(error) = write_windows_d3d11_encoder_progress(
                    progress,
                    &mut fifo,
                    &mut ts_writer,
                    &stop,
                    &mut output_frames,
                    &mut output_bytes,
                    &mut fifo_write_times_ms,
                ) {
                    terminal_error = Some(format!(
                        "{:?} D3D11 Media Foundation output stopped: {error}",
                        current_input.role
                    ));
                    break;
                }
                queue_depth
            }
            Err(error) => {
                match wait_for_windows_d3d11_generation_replacement(
                    &input,
                    &current_input,
                    &mut recovery_wait_started_at,
                    format!(
                        "Polling the {:?} D3D11 Media Foundation encoder failed: {error}",
                        current_input.role
                    ),
                ) {
                    Ok(Some(replacement)) => {
                        current_input = replacement;
                        last_submitted_sequence = None;
                        last_seen_published = current_input.latest_published_sequence();
                        recovery_wait_started_at = None;
                        generation_started_at = Instant::now();
                        next_frame_at = generation_started_at;
                        schedule_index = windows_d3d11_schedule_index_at(
                            encoder_started_at.elapsed(),
                            target_fps,
                        );
                    }
                    Ok(None) => {}
                    Err(error) => terminal_error = Some(error),
                }
                if terminal_error.is_some() {
                    break;
                }
                continue;
            }
        };

        if let Some((sequence, captured_at, ticket)) = current_input.latest_ticket()
            && last_submitted_sequence != Some(sequence)
        {
            let source_age_ms = captured_at.elapsed().as_millis() as u64;
            max_source_age_ms = Some(
                max_source_age_ms.map_or(source_age_ms, |current: u64| current.max(source_age_ms)),
            );
            source_age_times_ms.push(source_age_ms as f64);
            let pts_100ns =
                scheduled_windows_d3d11_time_100ns(schedule_index.saturating_sub(1), target_fps);
            let next_pts_100ns = scheduled_windows_d3d11_time_100ns(schedule_index, target_fps);
            let duration_100ns = next_pts_100ns.saturating_sub(pts_100ns).max(1);
            match current_input.client.submit_encoder_texture(
                ticket,
                pts_100ns,
                duration_100ns,
                encoder_started_at.elapsed().as_micros() as u64,
            ) {
                Ok(progress) => {
                    last_submitted_sequence = Some(sequence);
                    input_frames = input_frames.saturating_add(1);
                    queue_depth = progress.status.pending_frame_count as u64;
                    if let Err(error) = write_windows_d3d11_encoder_progress(
                        progress,
                        &mut fifo,
                        &mut ts_writer,
                        &stop,
                        &mut output_frames,
                        &mut output_bytes,
                        &mut fifo_write_times_ms,
                    ) {
                        terminal_error = Some(format!(
                            "{:?} D3D11 Media Foundation output stopped: {error}",
                            current_input.role
                        ));
                        break;
                    }
                }
                Err(failure) => {
                    if let Some(progress) = failure.progress
                        && let Err(error) = write_windows_d3d11_encoder_progress(
                            *progress,
                            &mut fifo,
                            &mut ts_writer,
                            &stop,
                            &mut output_frames,
                            &mut output_bytes,
                            &mut fifo_write_times_ms,
                        )
                    {
                        terminal_error = Some(format!(
                            "{:?} D3D11 Media Foundation output stopped: {error}",
                            current_input.role
                        ));
                        break;
                    }
                    if matches!(
                        failure.error.code,
                        WindowsD3d11ErrorCode::CommandQueueFull
                            | WindowsD3d11ErrorCode::EncoderBackpressure
                    ) {
                        pressure_skips = pressure_skips.saturating_add(1);
                    } else {
                        match wait_for_windows_d3d11_generation_replacement(
                            &input,
                            &current_input,
                            &mut recovery_wait_started_at,
                            format!(
                                "{:?} D3D11 Media Foundation surface submission failed: {}",
                                current_input.role, failure.error
                            ),
                        ) {
                            Ok(Some(replacement)) => {
                                current_input = replacement;
                                last_submitted_sequence = None;
                                recovery_wait_started_at = None;
                                generation_started_at = Instant::now();
                                next_frame_at = generation_started_at;
                                schedule_index = windows_d3d11_schedule_index_at(
                                    encoder_started_at.elapsed(),
                                    target_fps,
                                );
                            }
                            Ok(None) => {}
                            Err(error) => terminal_error = Some(error),
                        }
                        if terminal_error.is_some() {
                            break;
                        }
                        continue;
                    }
                }
            }
        }
        // A complete poll/submission iteration proves that the current media
        // generation is responsive again; only consecutive failures share a
        // bounded recovery deadline.
        recovery_wait_started_at = None;

        if !first_output_written && output_frames > 0 {
            first_output_written = true;
            let _ = video_epoch.set(Instant::now());
            signal_encoder_bridge_startup(&mut startup_ready_tx, Ok(()));
        }
        if !first_output_written
            && generation_started_at.elapsed() >= RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT
        {
            terminal_error = Some(format!(
                "{:?} D3D11 Media Foundation encoder did not deliver a startup access unit within {}ms",
                current_input.role,
                RAW_VIDEO_FIFO_STARTUP_PRIME_TIMEOUT.as_millis()
            ));
            break;
        }
        if window_started_at.elapsed() >= ENCODER_BRIDGE_DIAGNOSTIC_WINDOW {
            emit_encoder_bridge_diagnostics_from_thread(
                &diagnostics_tx,
                session_id.clone(),
                target_fps,
                EncoderBridgeRuntimeStats {
                    queue_depth,
                    output_queue_capacity_pressure_events: pressure_skips,
                    input_fps: measured_input_fps(input_frames, window_started_at),
                    source_to_encode_age_ms: max_source_age_ms,
                    source_to_encode_age_p95_ms: p95_ms(&source_age_times_ms),
                    zero_copy_frames: output_frames,
                    video_toolbox_output_frames: output_frames,
                    video_toolbox_output_bytes: output_bytes,
                    video_toolbox_fifo_write_p95_ms: p95_ms(&fifo_write_times_ms),
                    ..Default::default()
                },
                diagnostics_context,
                None,
            );
            input_frames = 0;
            output_frames = 0;
            output_bytes = 0;
            pressure_skips = 0;
            max_source_age_ms = None;
            source_age_times_ms.clear();
            fifo_write_times_ms.clear();
            window_started_at = Instant::now();
        }
    }

    if terminal_error.is_none() {
        match current_input.client.drain_encoder(
            current_input.role,
            u32::try_from(MEDIA_FOUNDATION_DRAIN_TIMEOUT.as_millis()).unwrap_or(2_000),
        ) {
            Ok(progress) => {
                if let Err(error) = write_windows_d3d11_encoder_progress(
                    progress,
                    &mut fifo,
                    &mut ts_writer,
                    &stop,
                    &mut output_frames,
                    &mut output_bytes,
                    &mut fifo_write_times_ms,
                ) {
                    terminal_error = Some(format!(
                        "Draining {:?} D3D11 Media Foundation output failed: {error}",
                        current_input.role
                    ));
                }
            }
            Err(error) => {
                terminal_error = Some(format!(
                    "Draining the {:?} D3D11 Media Foundation encoder failed: {error}",
                    current_input.role
                ));
            }
        }
    }
    let _ = current_input
        .client
        .shutdown_encoder(current_input.role, 2_000);
    if terminal_error.is_none()
        && let Err(error) = fifo.flush()
    {
        terminal_error = Some(format!(
            "Flushing {:?} D3D11 Media Foundation FIFO failed: {error}",
            current_input.role
        ));
    }
    if let Some(error) = terminal_error {
        if io_error_message_is_downstream_closed(&error) && stop.load(Ordering::Relaxed) {
            signal_encoder_bridge_startup(
                &mut startup_ready_tx,
                Err("D3D11 encoder bridge stopped before startup completed".to_string()),
            );
            return;
        }
        finish_windows_d3d11_writer_failure(
            &terminal_failure,
            &mut startup_ready_tx,
            &diagnostics_tx,
            &session_id,
            target_fps,
            diagnostics_context,
            error,
        );
    } else if !first_output_written {
        signal_encoder_bridge_startup(
            &mut startup_ready_tx,
            Err("D3D11 encoder bridge stopped before startup completed".to_string()),
        );
    }
}

#[cfg(target_os = "windows")]
fn wait_for_windows_d3d11_generation_replacement(
    input: &WindowsD3d11EncoderTicketSource,
    current: &WindowsD3d11EncoderTicketSourceSnapshot,
    recovery_wait_started_at: &mut Option<Instant>,
    cause: String,
) -> Result<Option<WindowsD3d11EncoderTicketSourceSnapshot>, String> {
    if current.recovery_count() != 0 {
        return Err(format!(
            "Recovered unified D3D11 generation {} failed again before the {:?} encoder input: {cause}",
            current.generation(),
            current.role
        ));
    }
    let recovery_started_at = recovery_wait_started_at.get_or_insert_with(Instant::now);
    let observed_generation = current.generation();
    if recovery_started_at.elapsed() >= WINDOWS_D3D11_GENERATION_RECOVERY_TIMEOUT {
        return Err(format!(
            "Unified D3D11 generation {observed_generation} was not replaced before the {:?} encoder recovery deadline: {cause}",
            current.role
        ));
    }
    let Some(replacement) = input
        .wait_for_generation_change(observed_generation, WINDOWS_D3D11_GENERATION_RECOVERY_POLL)
    else {
        return Ok(None);
    };
    validate_windows_d3d11_encoder_input(&replacement)?;
    Ok(Some(replacement))
}

#[cfg(target_os = "windows")]
fn windows_d3d11_schedule_index_at(elapsed: Duration, fps: u32) -> u64 {
    let frame_index = elapsed.as_nanos().saturating_mul(u128::from(fps.max(1))) / 1_000_000_000;
    u64::try_from(frame_index).unwrap_or(u64::MAX)
}

#[cfg(target_os = "windows")]
fn validate_windows_d3d11_encoder_input(
    input: &WindowsD3d11EncoderTicketSourceSnapshot,
) -> Result<(), String> {
    match input.client.encoder_status(input.role) {
        Ok(status)
            if status.role == input.role
                && status.diagnostics.d3d11_aware
                && status.diagnostics.dxgi_manager_bound =>
        {
            Ok(())
        }
        Ok(_) => Err(format!(
            "{:?} Media Foundation encoder did not confirm D3D11/DXGI authority",
            input.role
        )),
        Err(error) => Err(format!(
            "Could not inspect the {:?} D3D11 Media Foundation encoder: {error}",
            input.role
        )),
    }
}

#[cfg(target_os = "windows")]
fn scheduled_windows_d3d11_time_100ns(frame_index: u64, fps: u32) -> i64 {
    let value = u128::from(frame_index)
        .saturating_mul(10_000_000)
        .checked_div(u128::from(fps.max(1)))
        .unwrap_or_default();
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn write_windows_d3d11_encoder_progress<W: StdWrite>(
    progress: WindowsD3d11EncoderProgress,
    sink: &mut W,
    ts_writer: &mut MpegTsH264Writer,
    stop: &AtomicBool,
    output_frames: &mut u64,
    output_bytes: &mut u64,
    fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    let mut zero_copy_frames = 0;
    write_media_foundation_frames(
        progress.encoded_frames,
        sink,
        ts_writer,
        stop,
        &mut zero_copy_frames,
        output_frames,
        output_bytes,
        fifo_write_times_ms,
    )
}

#[cfg(target_os = "windows")]
fn finish_windows_d3d11_writer_failure(
    terminal_failure: &Arc<StdMutex<Option<String>>>,
    startup_ready_tx: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    diagnostics_tx: &watch::Sender<Option<EncoderBridgeWriterEvent>>,
    session_id: &str,
    target_fps: u32,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: String,
) {
    let error = record_encoder_bridge_terminal_failure(terminal_failure, error);
    signal_encoder_bridge_startup(startup_ready_tx, Err(error.clone()));
    emit_encoder_bridge_diagnostics_from_thread(
        diagnostics_tx,
        session_id.to_string(),
        target_fps,
        EncoderBridgeRuntimeStats::default(),
        diagnostics_context,
        Some(error),
    );
}

#[cfg(target_os = "windows")]
fn io_error_message_is_downstream_closed(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("broken pipe")
        || message.contains("write zero")
        || message.contains("unexpected eof")
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn write_media_foundation_frames<W: StdWrite>(
    frames: Vec<MediaFoundationEncodedFrame>,
    sink: &mut W,
    ts_writer: &mut MpegTsH264Writer,
    stop: &AtomicBool,
    zero_copy_frames: &mut u64,
    output_frames: &mut u64,
    output_bytes: &mut u64,
    fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    for frame in frames {
        let pts_90khz = timing_to_90khz(frame.pts_100ns, 10_000_000).ok_or_else(|| {
            io::Error::other("Media Foundation frame timing cannot be mapped to MPEG-TS PTS")
        })?;
        let mut packetized = Vec::with_capacity(frame.bytes.len().saturating_add(564));
        ts_writer.write_h264_access_unit(&mut packetized, pts_90khz, &frame.bytes)?;
        let write_started_at = Instant::now();
        write_all_until(
            sink,
            &packetized,
            stop,
            Instant::now() + MEDIA_FOUNDATION_FIFO_WRITE_HARD_TIMEOUT,
            MEDIA_FOUNDATION_FIFO_WRITE_HARD_TIMEOUT,
            MEDIA_FOUNDATION_FIFO_WRITE_HARD_TIMEOUT,
            false,
        )?;
        fifo_write_times_ms.push(write_started_at.elapsed().as_secs_f64() * 1000.0);
        *zero_copy_frames = zero_copy_frames.saturating_add(1);
        *output_frames = output_frames.saturating_add(1);
        *output_bytes = output_bytes.saturating_add(frame.bytes.len() as u64);
    }
    Ok(())
}

fn wait_for_fifo_write_progress(consecutive_no_progress: u32, deadline: Instant) {
    // A 1080p YUV420 frame is 3.11 MiB, while Unix FIFOs commonly accept only
    // a few KiB per nonblocking write. Sleeping milliseconds after every full
    // pipe therefore turns one frame into hundreds of sleeps (~800ms in the
    // Windows regression repro). While the reader is actively draining, yield
    // so it can run and retry immediately. Only back off once repeated attempts
    // show that no progress is being made; the caller's deadlines stay binding.
    if consecutive_no_progress <= FIFO_WRITE_PROGRESS_YIELD_BUDGET {
        thread::yield_now();
        return;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        thread::sleep(remaining.min(FIFO_WRITE_STALL_BACKOFF));
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn drain_video_toolbox_output_frames(
    video_toolbox: &mut EncoderBridgeVideoToolboxProbe,
    fifo_writer: &mut VideoToolboxFifoWriter,
    pending_video_toolbox_output_frames: &mut u64,
    pending_video_toolbox_fifo_frames: &mut u64,
    pending_video_toolbox_output_started_at: &mut HashMap<u64, Instant>,
    pending_video_toolbox_fifo_started_at: &mut VecDeque<Instant>,
    pending_completed_video_toolbox_frame: &mut Option<CompletedVideoToolboxOutputFrame>,
    output_queue_capacity_pressure_events: &mut u64,
    video_toolbox_probe_errors: &mut u64,
    video_toolbox_fifo_enqueue_times_ms: &mut Vec<f64>,
    max_video_toolbox_fifo_enqueue_ms: &mut Option<f64>,
    max_frames: Option<usize>,
) -> io::Result<VideoToolboxOutputDrainProgress> {
    let mut drained = 0_usize;
    let mut progress = VideoToolboxOutputDrainProgress::default();

    // A callback may have completed after the bounded FIFO filled. Retain that
    // already-encoded AU in the bridge and retry it before receiving another
    // callback so encoded order cannot change and capacity never implies loss.
    if let Some(completed) = pending_completed_video_toolbox_frame.take() {
        match enqueue_completed_video_toolbox_output_frame(
            fifo_writer,
            completed,
            pending_video_toolbox_output_frames,
            pending_video_toolbox_fifo_frames,
            pending_video_toolbox_output_started_at,
            pending_video_toolbox_fifo_started_at,
            video_toolbox_fifo_enqueue_times_ms,
            max_video_toolbox_fifo_enqueue_ms,
        )? {
            Some(completed) => {
                *output_queue_capacity_pressure_events =
                    output_queue_capacity_pressure_events.saturating_add(1);
                *pending_completed_video_toolbox_frame = Some(completed);
                return Ok(progress);
            }
            None => drained = drained.saturating_add(1),
        }
    }

    while max_frames.is_none_or(|limit| drained < limit) {
        let Some(message) = video_toolbox.try_recv_output() else {
            break;
        };
        progress.callback_completions = progress.callback_completions.saturating_add(1);
        let frame_index = message.frame_index;
        let submitted_at = pending_video_toolbox_output_started_at
            .get(&frame_index)
            .copied()
            .unwrap_or_else(Instant::now);
        match message.result {
            Ok(frame) => {
                let completed = CompletedVideoToolboxOutputFrame {
                    frame_index,
                    frame,
                    submitted_at,
                };
                if let Some(completed) = enqueue_completed_video_toolbox_output_frame(
                    fifo_writer,
                    completed,
                    pending_video_toolbox_output_frames,
                    pending_video_toolbox_fifo_frames,
                    pending_video_toolbox_output_started_at,
                    pending_video_toolbox_fifo_started_at,
                    video_toolbox_fifo_enqueue_times_ms,
                    max_video_toolbox_fifo_enqueue_ms,
                )? {
                    *output_queue_capacity_pressure_events =
                        output_queue_capacity_pressure_events.saturating_add(1);
                    *pending_completed_video_toolbox_frame = Some(completed);
                    break;
                }
            }
            Err(error) => {
                pending_video_toolbox_output_started_at.remove(&frame_index);
                *pending_video_toolbox_output_frames =
                    pending_video_toolbox_output_frames.saturating_sub(1);
                *video_toolbox_probe_errors = video_toolbox_probe_errors.saturating_add(1);
                return Err(io::Error::other(error));
            }
        }
        drained = drained.saturating_add(1);
    }
    Ok(progress)
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn enqueue_completed_video_toolbox_output_frame(
    fifo_writer: &VideoToolboxFifoWriter,
    completed: CompletedVideoToolboxOutputFrame,
    pending_video_toolbox_output_frames: &mut u64,
    pending_video_toolbox_fifo_frames: &mut u64,
    pending_video_toolbox_output_started_at: &mut HashMap<u64, Instant>,
    pending_video_toolbox_fifo_started_at: &mut VecDeque<Instant>,
    video_toolbox_fifo_enqueue_times_ms: &mut Vec<f64>,
    max_video_toolbox_fifo_enqueue_ms: &mut Option<f64>,
) -> io::Result<Option<CompletedVideoToolboxOutputFrame>> {
    let enqueue_started_at = Instant::now();
    let CompletedVideoToolboxOutputFrame {
        frame_index,
        frame,
        submitted_at,
    } = completed;
    match fifo_writer.enqueue(frame)? {
        VideoToolboxFifoEnqueueOutcome::Enqueued => {
            let enqueue_ms = enqueue_started_at.elapsed().as_secs_f64() * 1000.0;
            video_toolbox_fifo_enqueue_times_ms.push(enqueue_ms);
            *max_video_toolbox_fifo_enqueue_ms = Some(
                max_video_toolbox_fifo_enqueue_ms
                    .map_or(enqueue_ms, |current| current.max(enqueue_ms)),
            );
            pending_video_toolbox_output_started_at.remove(&frame_index);
            *pending_video_toolbox_output_frames =
                pending_video_toolbox_output_frames.saturating_sub(1);
            *pending_video_toolbox_fifo_frames =
                pending_video_toolbox_fifo_frames.saturating_add(1);
            pending_video_toolbox_fifo_started_at.push_back(submitted_at);
            Ok(None)
        }
        VideoToolboxFifoEnqueueOutcome::CapacityPressure(frame) => {
            Ok(Some(CompletedVideoToolboxOutputFrame {
                frame_index,
                frame,
                submitted_at,
            }))
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn drain_video_toolbox_fifo_writer_results(
    fifo_writer: &mut VideoToolboxFifoWriter,
    pending_video_toolbox_fifo_frames: &mut u64,
    pending_video_toolbox_fifo_started_at: &mut VecDeque<Instant>,
    zero_copy_frames: &mut u64,
    video_toolbox_output_frames: &mut u64,
    video_toolbox_output_bytes: &mut u64,
    video_toolbox_fifo_write_times_ms: &mut Vec<f64>,
) -> io::Result<()> {
    while let Some(result) = fifo_writer.try_recv_result() {
        match result {
            VideoToolboxFifoWriterResult::FrameWritten {
                encoded_bytes,
                write_ms,
            } => {
                *pending_video_toolbox_fifo_frames =
                    pending_video_toolbox_fifo_frames.saturating_sub(1);
                pending_video_toolbox_fifo_started_at.pop_front();
                *zero_copy_frames = zero_copy_frames.saturating_add(1);
                *video_toolbox_output_frames = video_toolbox_output_frames.saturating_add(1);
                *video_toolbox_output_bytes =
                    video_toolbox_output_bytes.saturating_add(encoded_bytes);
                video_toolbox_fifo_write_times_ms.push(write_ms);
            }
            VideoToolboxFifoWriterResult::Error {
                message,
                downstream_closed,
            } => {
                // Preserve the classification through the io::Error kind so
                // the terminal-failure funnel can tell "FFmpeg went away"
                // apart from a real bridge failure.
                let kind = if downstream_closed {
                    io::ErrorKind::BrokenPipe
                } else {
                    io::ErrorKind::Other
                };
                return Err(io::Error::new(kind, message));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn oldest_pending_video_toolbox_frame_age(
    encoder_pending: &HashMap<u64, Instant>,
    fifo_pending: &VecDeque<Instant>,
) -> Option<Duration> {
    encoder_pending
        .values()
        .copied()
        .chain(fifo_pending.front().copied())
        .min()
        .map(|started_at| started_at.elapsed())
}

fn encoder_bridge_video_toolbox_probe_enabled() -> bool {
    parse_video_toolbox_probe_enabled(std::env::var(VIDEOTOOLBOX_PROBE_ENV).ok().as_deref())
}

fn parse_video_toolbox_probe_enabled(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn latest_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
) -> Option<FedCompositorFrame> {
    let frame = frame_store?
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .latest()?;
    #[cfg(target_os = "macos")]
    let metal_target = frame.metadata.metal_target_pixel_buffer();
    Some(FedCompositorFrame {
        frame: frame.clone(),
        sequence: frame.sequence,
        captured_at: frame.captured_at,
        age_ms: frame.captured_at.elapsed().as_millis() as u64,
        has_metal_iosurface_target: frame.pixel_format.has_metal_iosurface_target(),
        has_metal_export_handle: frame.metadata.has_metal_iosurface_target(),
        #[cfg(target_os = "macos")]
        metal_target,
    })
}

fn initial_bridge_wait_sequence(
    video_output: EncoderBridgeVideoOutput,
    frame_store: Option<&CompositorFrameStore>,
) -> Option<u64> {
    if video_output.uses_encoded_h264() {
        return None;
    }
    latest_compositor_frame(frame_store).map(|frame| frame.sequence)
}

fn next_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    previous_sequence: Option<u64>,
    wait_budget: Duration,
) -> Option<FedCompositorFrame> {
    if previous_sequence.is_none() || wait_budget.is_zero() {
        return latest_compositor_frame(frame_store);
    }

    let started_at = Instant::now();
    loop {
        let frame = latest_compositor_frame(frame_store);
        if frame
            .as_ref()
            .is_some_and(|frame| Some(frame.sequence) != previous_sequence)
            || started_at.elapsed() >= wait_budget
        {
            return frame;
        }
        let remaining = wait_budget.saturating_sub(started_at.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(2)));
    }
}

fn next_raw_compositor_frame(
    frame_store: Option<&CompositorFrameStore>,
    previous_sequence: Option<u64>,
    wait_budget: Duration,
    expected_byte_len: usize,
) -> Option<FedCompositorFrame> {
    let frame = next_compositor_frame(frame_store, previous_sequence, wait_budget)?;
    (frame.frame.bytes.len() == expected_byte_len).then_some(frame)
}

fn open_recording_fifo_writer(
    path: &Path,
    stop: &AtomicBool,
    nonblocking_writes: bool,
) -> io::Result<File> {
    crate::fifo::open_writer(
        path,
        stop,
        Duration::from_millis(10),
        // Keep Unix FIFOs nonblocking. The VideoToolbox writer applies a
        // role-specific deadline and cancellation check around every partial
        // write, so a stalled FFmpeg reader cannot retain a worker forever.
        // Windows keeps the named pipe in PIPE_NOWAIT for the same bounded
        // writer contract; full buffers surface as zero-byte writes and retry
        // only until the role-specific deadline.
        !nonblocking_writes,
        "recording encoder bridge writer stopped before FIFO opened",
    )
}

fn emit_encoder_bridge_diagnostics_from_thread(
    diagnostics_tx: &watch::Sender<Option<EncoderBridgeWriterEvent>>,
    session_id: String,
    target_fps: u32,
    stats: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
) {
    let mut next = EncoderBridgeWriterEvent {
        session_id,
        target_fps,
        stats,
        diagnostics_context,
        error,
    };
    // Capacity-one/latest-wins diagnostics must never block the media writer.
    // Preserve a terminal error when final stats supersede it before the async
    // consumer observes the channel.
    diagnostics_tx.send_modify(move |current| {
        if next.error.is_none() {
            next.error = current.as_ref().and_then(|event| event.error.clone());
        }
        *current = Some(next);
    });
}

async fn read_encoder_progress(
    stderr: tokio::process::ChildStderr,
    progress: Arc<Mutex<EncoderBridgeProgress>>,
) -> EncoderBridgeProgress {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let Some(update) = parse_encoder_progress_line(&line) else {
            if is_ffmpeg_error_line(&line) {
                progress.lock().await.last_error = Some(line.trim().to_string());
            }
            continue;
        };
        let mut progress = progress.lock().await;
        if let Some(encoded_fps) = update.encoded_fps {
            progress.encoded_fps = Some(encoded_fps);
        }
        if let Some(encoder_speed) = update.encoder_speed {
            progress.encoder_speed = Some(encoder_speed);
        }
        if let Some(dropped_frames) = update.dropped_frames {
            progress.dropped_frames = dropped_frames;
        }
    }
    progress.lock().await.clone()
}

#[derive(Debug, Default, PartialEq)]
struct EncoderProgressUpdate {
    encoded_fps: Option<f64>,
    encoder_speed: Option<f64>,
    dropped_frames: Option<u64>,
}

fn parse_encoder_progress_line(line: &str) -> Option<EncoderProgressUpdate> {
    let update = EncoderProgressUpdate {
        encoded_fps: parse_stat_f64(line, "fps="),
        encoder_speed: parse_stat_f64(line, "speed="),
        dropped_frames: parse_stat_u64(line, "drop_frames=")
            .or_else(|| parse_stat_u64(line, "drop=")),
    };
    if update.encoded_fps.is_none()
        && update.encoder_speed.is_none()
        && update.dropped_frames.is_none()
    {
        return None;
    }
    Some(update)
}

fn parse_stat_f64(line: &str, label: &str) -> Option<f64> {
    stat_value(line, label)?
        .trim_end_matches('x')
        .parse::<f64>()
        .ok()
}

fn parse_stat_u64(line: &str, label: &str) -> Option<u64> {
    stat_value(line, label)?.parse::<u64>().ok()
}

fn stat_value<'line>(line: &'line str, label: &str) -> Option<&'line str> {
    let start = line.find(label)? + label.len();
    let tail = &line[start..];
    let value = tail.split_whitespace().next()?.trim();
    if value.is_empty() || value == "N/A" {
        None
    } else {
        Some(value)
    }
}

fn is_ffmpeg_error_line(line: &str) -> bool {
    let normalized = line.to_lowercase();
    normalized.contains("error") || normalized.contains("failed") || normalized.contains("invalid")
}

// --- Recording-leg degraded watch (plan 023 L4) ----------------------------
// The recording leg's input fps sitting below 80% of target for 5s is a
// mid-session quality incident (the owner found a 9fps 4K file AFTER the
// stream): say so while there is still time to act, like the mic-silent
// warning. Pure decision core; the diagnostics consumer drives it.

const RECORDING_DEGRADED_FPS_RATIO: f64 = 0.8;
const RECORDING_DEGRADED_HOLD_MS: u128 = 5_000;

#[derive(Default)]
pub(crate) struct RecordingFpsWatch {
    session_id: String,
    low_since_ms: Option<u128>,
    fired: bool,
}

/// Feed one recording-leg diagnostics sample; returns true exactly once per
/// session when the low-fps condition has held for the full window.
pub(crate) fn recording_fps_watch_update(
    watch: &mut RecordingFpsWatch,
    session_id: &str,
    input_fps: Option<f64>,
    target_fps: u32,
    now_ms: u128,
) -> bool {
    if watch.session_id != session_id {
        *watch = RecordingFpsWatch {
            session_id: session_id.to_string(),
            ..RecordingFpsWatch::default()
        };
    }
    let Some(input_fps) = input_fps else {
        return false;
    };
    if target_fps == 0 || watch.fired {
        return false;
    }
    if input_fps >= f64::from(target_fps) * RECORDING_DEGRADED_FPS_RATIO {
        watch.low_since_ms = None;
        return false;
    }
    let since = *watch.low_since_ms.get_or_insert(now_ms);
    if now_ms.saturating_sub(since) >= RECORDING_DEGRADED_HOLD_MS {
        watch.fired = true;
        return true;
    }
    false
}

static RECORDING_FPS_WATCH: std::sync::Mutex<Option<RecordingFpsWatch>> =
    std::sync::Mutex::new(None);

#[derive(Default)]
struct RecordingQueueDropWatch {
    session_id: String,
    fired: bool,
}

fn recording_queue_drop_watch_update(
    watch: &mut RecordingQueueDropWatch,
    session_id: &str,
    dropped_frames: u64,
) -> bool {
    if watch.session_id != session_id {
        *watch = RecordingQueueDropWatch {
            session_id: session_id.to_string(),
            ..RecordingQueueDropWatch::default()
        };
    }
    if dropped_frames == 0 || watch.fired {
        return false;
    }
    watch.fired = true;
    true
}

static RECORDING_QUEUE_DROP_WATCH: std::sync::Mutex<Option<RecordingQueueDropWatch>> =
    std::sync::Mutex::new(None);

// The stream twin: pressure on the STREAM output was previously counted in
// diagnostics but never surfaced — the 2026-07-15 incident sessions logged 11
// silent pressure events and then died with no prior warning. Fires once per
// session so a jittery platform cannot spam the session log.
static STREAM_QUEUE_PRESSURE_WATCH: std::sync::Mutex<Option<RecordingQueueDropWatch>> =
    std::sync::Mutex::new(None);

async fn emit_encoder_bridge_diagnostics(
    state: &AppState,
    session_id: &str,
    target_fps: u32,
    runtime: EncoderBridgeRuntimeStats,
    diagnostics_context: EncoderBridgeDiagnosticsContext,
    error: Option<String>,
) {
    let recording_diagnostics_target_fps =
        encoder_bridge_recording_diagnostics_target_fps(target_fps, diagnostics_context);
    if matches!(
        effective_encoder_bridge_output_role(diagnostics_context),
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared
    ) {
        let fire = {
            let mut guard = RECORDING_QUEUE_DROP_WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let watch = guard.get_or_insert_with(RecordingQueueDropWatch::default);
            recording_queue_drop_watch_update(
                watch,
                session_id,
                runtime.output_pre_encode_skipped_frames,
            )
        };
        if fire {
            let message = format!(
                "Recording output is recovering from pressure: {} compositor tick(s) were skipped before encode. Every already-encoded frame is being preserved; the saved file keeps truthful timing but may show a brief held frame.",
                runtime.output_pre_encode_skipped_frames
            );
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "recording-output-pressure",
                &message,
            );
        }
    }

    // Stream pressure must be audible BEFORE any failure: the watchdog now
    // degrades (drops to latest-wins) instead of dying on one over-age
    // sample, and this is the user's signal that a platform connection is
    // struggling while the stream still runs.
    if effective_encoder_bridge_output_role(diagnostics_context) == EncoderBridgeOutputRole::Stream
    {
        let fire = {
            let mut guard = STREAM_QUEUE_PRESSURE_WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let watch = guard.get_or_insert_with(RecordingQueueDropWatch::default);
            recording_queue_drop_watch_update(
                watch,
                session_id,
                runtime.output_queue_capacity_pressure_events,
            )
        };
        if fire {
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "stream-output-pressure",
                "Stream output is under pressure: a destination is accepting data slower than the stream produces it. Frames are being dropped from the live stream to keep latency; the recording is unaffected.",
            );
        }
    }

    // L4 (plan 023): announce a degraded recording leg mid-session.
    if matches!(
        effective_encoder_bridge_output_role(diagnostics_context),
        EncoderBridgeOutputRole::Recording | EncoderBridgeOutputRole::Shared
    ) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let fire = {
            let mut guard = RECORDING_FPS_WATCH
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let watch = guard.get_or_insert_with(RecordingFpsWatch::default);
            recording_fps_watch_update(
                watch,
                session_id,
                runtime.input_fps,
                recording_diagnostics_target_fps,
                now_ms,
            )
        };
        if fire {
            let message = format!(
                "Recording quality is degraded while streaming: the recording leg is producing                  {:.0} fps against the selected {recording_diagnostics_target_fps} fps. The stream continues; the                  saved file will be choppy.",
                runtime.input_fps.unwrap_or(0.0)
            );
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                crate::protocol::HealthLevel::Warn,
                "recording-degraded",
                &message,
            );
        }
    }

    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let base = if diagnostics.session_id.as_deref() == Some(session_id) {
            diagnostics.clone()
        } else {
            starting_diagnostics(
                session_id,
                recording_diagnostics_target_fps,
                "encoder-bridge",
            )
        };
        let recording_output = diagnostics_context.recording_output;
        let stream_output = diagnostics_context.stream_output;
        let role_process_diagnostics =
            merge_encoder_bridge_role_process_diagnostics(&base, runtime, diagnostics_context);
        let recording_artifact_diagnostics = merge_encoder_bridge_recording_artifact_diagnostics(
            &base,
            runtime,
            diagnostics_context,
        );
        let role_diagnostics =
            merge_encoder_bridge_role_diagnostics(&base, runtime, diagnostics_context);
        let role_output_pressure =
            merge_encoder_bridge_role_output_pressure(&base, runtime, diagnostics_context);
        let (
            recording_output_frames,
            recording_output_bytes,
            stream_output_frames,
            stream_output_bytes,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.video_toolbox_output_frames,
                runtime.video_toolbox_output_bytes,
                base.encoder_bridge_stream_video_toolbox_output_frames,
                base.encoder_bridge_stream_video_toolbox_output_bytes,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_video_toolbox_output_frames,
                base.encoder_bridge_recording_video_toolbox_output_bytes,
                runtime.video_toolbox_output_frames,
                runtime.video_toolbox_output_bytes,
            ),
            EncoderBridgeOutputRole::Shared => (0, 0, 0, 0),
        };
        let video_toolbox_output_frames = if diagnostics_context.separate_output_encoders_active {
            recording_output_frames.saturating_add(stream_output_frames)
        } else {
            runtime.video_toolbox_output_frames
        };
        let video_toolbox_output_bytes = if diagnostics_context.separate_output_encoders_active {
            recording_output_bytes.saturating_add(stream_output_bytes)
        } else {
            runtime.video_toolbox_output_bytes
        };
        let (
            recording_input_fps,
            stream_input_fps,
            recording_writer_loop_p95_ms,
            stream_writer_loop_p95_ms,
            recording_writer_active_p95_ms,
            stream_writer_active_p95_ms,
            recording_video_toolbox_fifo_enqueue_p95_ms,
            stream_video_toolbox_fifo_enqueue_p95_ms,
            recording_video_toolbox_fifo_enqueue_max_ms,
            stream_video_toolbox_fifo_enqueue_max_ms,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.input_fps,
                base.encoder_bridge_stream_input_fps,
                runtime.writer_loop_p95_ms,
                base.encoder_bridge_stream_writer_loop_p95_ms,
                runtime.writer_active_p95_ms,
                base.encoder_bridge_stream_writer_active_p95_ms,
                runtime.video_toolbox_fifo_enqueue_p95_ms,
                base.encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms,
                runtime.video_toolbox_fifo_enqueue_max_ms,
                base.encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_input_fps,
                runtime.input_fps,
                base.encoder_bridge_recording_writer_loop_p95_ms,
                runtime.writer_loop_p95_ms,
                base.encoder_bridge_recording_writer_active_p95_ms,
                runtime.writer_active_p95_ms,
                base.encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms,
                runtime.video_toolbox_fifo_enqueue_p95_ms,
                base.encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms,
                runtime.video_toolbox_fifo_enqueue_max_ms,
            ),
            EncoderBridgeOutputRole::Shared => {
                (None, None, None, None, None, None, None, None, None, None)
            }
        };
        let (
            recording_queue_depth,
            recording_queue_oldest_frame_age_ms,
            recording_queue_capacity_pressure_events,
            recording_queue_dropped_frames,
            stream_queue_depth,
            stream_queue_oldest_frame_age_ms,
            stream_queue_capacity_pressure_events,
            stream_queue_dropped_frames,
        ) = match diagnostics_context.role {
            EncoderBridgeOutputRole::Recording => (
                runtime.queue_depth,
                runtime.output_queue_oldest_frame_age_ms,
                runtime.output_queue_capacity_pressure_events,
                runtime.output_queue_dropped_frames,
                base.encoder_bridge_stream_queue_depth,
                base.encoder_bridge_stream_queue_oldest_frame_age_ms,
                base.encoder_bridge_stream_queue_capacity_pressure_events,
                base.encoder_bridge_stream_queue_dropped_frames,
            ),
            EncoderBridgeOutputRole::Stream => (
                base.encoder_bridge_recording_queue_depth,
                base.encoder_bridge_recording_queue_oldest_frame_age_ms,
                base.encoder_bridge_recording_queue_capacity_pressure_events,
                base.encoder_bridge_recording_queue_dropped_frames,
                runtime.queue_depth,
                runtime.output_queue_oldest_frame_age_ms,
                runtime.output_queue_capacity_pressure_events,
                runtime.output_queue_dropped_frames,
            ),
            EncoderBridgeOutputRole::Shared => (
                recording_output.map_or(0, |_| runtime.queue_depth),
                recording_output.and(runtime.output_queue_oldest_frame_age_ms),
                recording_output.map_or(0, |_| runtime.output_queue_capacity_pressure_events),
                recording_output.map_or(0, |_| runtime.output_queue_dropped_frames),
                stream_output.map_or(0, |_| runtime.queue_depth),
                stream_output.and(runtime.output_queue_oldest_frame_age_ms),
                stream_output.map_or(0, |_| runtime.output_queue_capacity_pressure_events),
                stream_output.map_or(0, |_| runtime.output_queue_dropped_frames),
            ),
        };
        let output_queue_oldest_frame_age_ms =
            if diagnostics_context.separate_output_encoders_active {
                match (
                    recording_queue_oldest_frame_age_ms,
                    stream_queue_oldest_frame_age_ms,
                ) {
                    (Some(recording), Some(stream)) => Some(recording.max(stream)),
                    (Some(age), None) | (None, Some(age)) => Some(age),
                    (None, None) => None,
                }
            } else {
                runtime.output_queue_oldest_frame_age_ms
            };
        let output_queue_capacity_pressure_events =
            if diagnostics_context.separate_output_encoders_active {
                recording_queue_capacity_pressure_events
                    .saturating_add(stream_queue_capacity_pressure_events)
            } else {
                runtime.output_queue_capacity_pressure_events
            };
        let output_queue_dropped_frames = if diagnostics_context.separate_output_encoders_active {
            recording_queue_dropped_frames.saturating_add(stream_queue_dropped_frames)
        } else {
            runtime.output_queue_dropped_frames
        };
        let queue_depth = if diagnostics_context.separate_output_encoders_active {
            recording_queue_depth.saturating_add(stream_queue_depth)
        } else {
            runtime.queue_depth
        };
        let error = merge_encoder_bridge_recording_error(&base, error, diagnostics_context);
        let next = apply_encoder_bridge_stats(
            base,
            EncoderBridgeDiagnosticSnapshot {
                queue_depth,
                output_queue_high_water_frames: role_output_pressure
                    .aggregate
                    .output_queue_high_water_frames,
                output_queue_oldest_frame_age_ms,
                output_queue_oldest_frame_age_high_water_ms: role_output_pressure
                    .aggregate
                    .output_queue_oldest_frame_age_high_water_ms,
                output_last_progress_age_ms: role_output_pressure
                    .aggregate
                    .output_last_progress_age_ms,
                output_queue_capacity_pressure_events,
                output_pressure_recovery_events: role_output_pressure
                    .aggregate
                    .output_pressure_recovery_events,
                output_queue_dropped_frames,
                output_pre_encode_skipped_frames: role_output_pressure
                    .aggregate
                    .output_pre_encode_skipped_frames,
                video_toolbox_pending_encode_frames: role_output_pressure
                    .aggregate
                    .video_toolbox_pending_encode_frames,
                video_toolbox_pending_fifo_frames: role_output_pressure
                    .aggregate
                    .video_toolbox_pending_fifo_frames,
                encoded_access_unit_dropped_frames: role_output_pressure
                    .aggregate
                    .encoded_access_unit_dropped_frames,
                recording_output_pressure: role_output_pressure.recording,
                stream_output_pressure: role_output_pressure.stream,
                recording_role_diagnostics: role_diagnostics.recording,
                stream_role_diagnostics: role_diagnostics.stream,
                input_fps: recording_artifact_diagnostics.input_fps,
                dropped_frames: role_process_diagnostics.dropped_frames,
                encoder_speed: role_process_diagnostics.encoder_speed,
                recording_dropped_frames: role_process_diagnostics.recording_dropped_frames,
                stream_dropped_frames: role_process_diagnostics.stream_dropped_frames,
                recording_encoder_speed: role_process_diagnostics.recording_encoder_speed,
                stream_encoder_speed: role_process_diagnostics.stream_encoder_speed,
                repeated_fed_frames: recording_artifact_diagnostics.repeated_fed_frames,
                repeated_frame_bursts: recording_artifact_diagnostics.repeated_frame_bursts,
                max_repeated_frame_run: recording_artifact_diagnostics.max_repeated_frame_run,
                synthetic_fallback_frames: recording_artifact_diagnostics.synthetic_fallback_frames,
                source_to_encode_age_ms: recording_artifact_diagnostics.source_to_encode_age_ms,
                source_to_encode_age_p95_ms: recording_artifact_diagnostics
                    .source_to_encode_age_p95_ms,
                repeated_frame_age_p95_ms: recording_artifact_diagnostics.repeated_frame_age_p95_ms,
                repeated_frame_age_max_ms: recording_artifact_diagnostics.repeated_frame_age_max_ms,
                metal_target_frames: role_diagnostics.aggregate.metal_target_frames,
                raw_video_copied_frames: role_process_diagnostics.raw_video_copied_frames,
                recording_raw_video_copied_frames: role_process_diagnostics
                    .recording_raw_video_copied_frames,
                stream_raw_video_copied_frames: role_process_diagnostics
                    .stream_raw_video_copied_frames,
                metal_target_copied_frames: role_diagnostics.aggregate.metal_target_copied_frames,
                metal_target_handle_frames: role_diagnostics.aggregate.metal_target_handle_frames,
                zero_copy_frames: role_diagnostics.aggregate.zero_copy_frames,
                video_toolbox_probe_frames: role_diagnostics.aggregate.video_toolbox_probe_frames,
                video_toolbox_probe_bytes: role_diagnostics.aggregate.video_toolbox_probe_bytes,
                video_toolbox_probe_errors: role_diagnostics.aggregate.video_toolbox_probe_errors,
                video_toolbox_output_frames,
                video_toolbox_output_bytes,
                video_toolbox_output_encode_ms: role_diagnostics
                    .aggregate
                    .video_toolbox_output_encode_ms,
                recording_output_width: recording_output.map(|output| output.width),
                recording_output_height: recording_output.map(|output| output.height),
                recording_output_fps: recording_output.map(|output| output.fps),
                recording_output_bitrate_kbps: recording_output.map(|output| output.bitrate_kbps),
                stream_output_width: stream_output.map(|output| output.width),
                stream_output_height: stream_output.map(|output| output.height),
                stream_output_fps: stream_output.map(|output| output.fps),
                stream_output_bitrate_kbps: stream_output.map(|output| output.bitrate_kbps),
                active_video_toolbox_output_encoders: diagnostics_context
                    .active_video_toolbox_output_encoders,
                active_encoded_output_encoders: diagnostics_context.active_encoded_output_encoders,
                recording_video_toolbox_output_frames: recording_output_frames,
                recording_video_toolbox_output_bytes: recording_output_bytes,
                stream_video_toolbox_output_frames: stream_output_frames,
                stream_video_toolbox_output_bytes: stream_output_bytes,
                separate_output_encoders_active: diagnostics_context
                    .separate_output_encoders_active,
                compositor_wait_p95_ms: role_diagnostics.aggregate.compositor_wait_p95_ms,
                video_toolbox_submit_p95_ms: role_diagnostics.aggregate.video_toolbox_submit_p95_ms,
                raw_video_fifo_write_p95_ms: role_diagnostics.aggregate.raw_video_fifo_write_p95_ms,
                video_toolbox_fifo_write_p95_ms: role_diagnostics
                    .aggregate
                    .video_toolbox_fifo_write_p95_ms,
                video_toolbox_fifo_enqueue_p95_ms: role_diagnostics
                    .aggregate
                    .video_toolbox_fifo_enqueue_p95_ms,
                video_toolbox_fifo_enqueue_max_ms: role_diagnostics
                    .aggregate
                    .video_toolbox_fifo_enqueue_max_ms,
                writer_loop_p95_ms: role_diagnostics.aggregate.writer_loop_p95_ms,
                writer_sleep_p95_ms: role_diagnostics.aggregate.writer_sleep_p95_ms,
                writer_active_p95_ms: role_diagnostics.aggregate.writer_active_p95_ms,
                deadline_lag_p95_ms: role_diagnostics.aggregate.deadline_lag_p95_ms,
                deadline_lag_max_ms: role_diagnostics.aggregate.deadline_lag_max_ms,
                late_deadline_ticks: role_diagnostics.aggregate.late_deadline_ticks,
                schedule_skipped_ms: role_diagnostics.aggregate.schedule_skipped_ms,
                recording_input_fps,
                stream_input_fps,
                recording_queue_depth,
                recording_queue_oldest_frame_age_ms,
                recording_queue_capacity_pressure_events,
                recording_queue_dropped_frames,
                stream_queue_depth,
                stream_queue_oldest_frame_age_ms,
                stream_queue_capacity_pressure_events,
                stream_queue_dropped_frames,
                recording_writer_loop_p95_ms,
                stream_writer_loop_p95_ms,
                recording_writer_active_p95_ms,
                stream_writer_active_p95_ms,
                recording_video_toolbox_fifo_enqueue_p95_ms,
                stream_video_toolbox_fifo_enqueue_p95_ms,
                recording_video_toolbox_fifo_enqueue_max_ms,
                stream_video_toolbox_fifo_enqueue_max_ms,
                error,
            },
            recording_diagnostics_target_fps,
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

fn measured_input_fps(frames_written: u64, started_at: Instant) -> Option<f64> {
    if frames_written == 0 {
        return None;
    }
    Some(frames_written as f64 / started_at.elapsed().as_secs_f64().max(0.001))
}

fn encoder_bridge_input_frame_count(
    video_output: EncoderBridgeVideoOutput,
    scheduled_frames: u64,
    raw_delivered_frames: u64,
) -> u64 {
    if matches!(video_output, EncoderBridgeVideoOutput::RawYuv420p) {
        raw_delivered_frames
    } else {
        scheduled_frames
    }
}

fn p95_ms(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let index = (((95.0 / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    Some(sorted[index])
}

fn frame_count(duration_ms: u64, fps: u32) -> u64 {
    duration_ms
        .saturating_mul(u64::from(fps))
        .saturating_add(999)
        / 1000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::idle_diagnostics;

    fn store_recording_artifact_diagnostics(
        stats: &mut DiagnosticStats,
        recording: EncoderBridgeRecordingArtifactDiagnostics,
    ) {
        stats.encoder_bridge_input_fps = recording.input_fps;
        stats.encoder_bridge_repeated_frames = recording.repeated_fed_frames;
        stats.encoder_bridge_repeated_frame_bursts = recording.repeated_frame_bursts;
        stats.encoder_bridge_max_repeated_frame_run = recording.max_repeated_frame_run;
        stats.encoder_bridge_synthetic_frames = recording.synthetic_fallback_frames;
        stats.encoder_bridge_source_age_ms = recording.source_to_encode_age_ms;
        stats.encoder_bridge_source_age_p95_ms = recording.source_to_encode_age_p95_ms;
        stats.encoder_bridge_repeated_frame_age_p95_ms = recording.repeated_frame_age_p95_ms;
        stats.encoder_bridge_repeated_frame_age_max_ms = recording.repeated_frame_age_max_ms;
    }

    fn store_role_diagnostics(
        stats: &mut DiagnosticStats,
        diagnostics: EncoderBridgeMergedRoleDiagnostics,
    ) {
        stats.encoder_bridge_recording_role_diagnostics = diagnostics.recording;
        stats.encoder_bridge_stream_role_diagnostics = diagnostics.stream;
    }

    fn test_lifecycle_publisher(
        capacity: usize,
        start: Option<std_mpsc::Receiver<()>>,
    ) -> (
        EncoderBridgeLifecycleTransitionPublisher,
        std_mpsc::Receiver<EncoderBridgeLifecycleWorkerRecord>,
        thread::JoinHandle<()>,
    ) {
        let (record_tx, record_rx) = std_mpsc::channel();
        let (publisher, worker) =
            spawn_encoder_bridge_lifecycle_publisher(capacity, start, move |record, _state| {
                let _ = record_tx.send(record);
            });
        (publisher, record_rx, worker)
    }

    fn recv_lifecycle_records(
        receiver: &std_mpsc::Receiver<EncoderBridgeLifecycleWorkerRecord>,
        count: usize,
    ) -> Vec<EncoderBridgeLifecycleWorkerRecord> {
        (0..count)
            .map(|_| {
                receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("autonomous lifecycle worker persists the next record")
            })
            .collect()
    }

    #[test]
    fn encoder_bridge_lifecycle_admission_refuses_a_live_previous_session_resource() {
        let mut registry = EncoderBridgeWriterRegistry::default();
        registry.register(
            "writer-previous",
            "session-previous",
            EncoderBridgeOutputRole::Shared,
        );

        let blocker = registry
            .admission_blocker("session-next")
            .expect("a capture-relevant writer from another session must fail admission");

        assert_eq!(blocker.live_outer_writers, 1);
        assert_eq!(blocker.live_fifo_writers, 0);
        assert_eq!(blocker.live_resources, 1);
        let writer = registry
            .writers
            .get("writer-previous")
            .expect("registered writer identity");
        assert_eq!(writer.session_id, "session-previous");
        assert_eq!(writer.role, EncoderBridgeOutputRole::Shared);
    }

    #[test]
    fn autonomous_lifecycle_worker_persists_without_a_recording_side_drain() {
        let (publisher, persisted, worker) = test_lifecycle_publisher(4, None);
        let gate = publisher.persistence_gate();
        publisher.publish(EncoderBridgeLifecycleTransitionEnvelope {
            transition: EncoderBridgeLifecycleTransition {
                sequence: 1,
                writer_id: "writer-autonomous".to_string(),
                session_id: "session-autonomous".to_string(),
                role: EncoderBridgeOutputRole::Recording,
                state: "outer-exited/resource-released",
                lifecycle: EncoderBridgeLifecycleSnapshot::default(),
            },
            state: None,
            gate: gate.clone(),
        });

        assert!(matches!(
            persisted
                .recv_timeout(Duration::from_secs(1))
                .expect("dedicated worker consumes on every platform"),
            EncoderBridgeLifecycleWorkerRecord::Transition(transition)
                if transition.sequence == 1
                    && transition.state == "outer-exited/resource-released"
        ));
        drop(gate);
        drop(publisher);
        worker.join().expect("test persistence worker joins");
    }

    #[test]
    fn lifecycle_queue_overflow_coalesces_the_latest_authoritative_snapshot() {
        let (start_tx, start_rx) = std_mpsc::channel();
        let (publisher, persisted, worker) = test_lifecycle_publisher(1, Some(start_rx));
        let gate = publisher.persistence_gate();
        for sequence in 1..=3 {
            publisher.publish(EncoderBridgeLifecycleTransitionEnvelope {
                transition: EncoderBridgeLifecycleTransition {
                    sequence,
                    writer_id: format!("writer-{sequence}"),
                    session_id: "session-overflow".to_string(),
                    role: EncoderBridgeOutputRole::Recording,
                    state: "overflow-fixture",
                    lifecycle: EncoderBridgeLifecycleSnapshot {
                        live_outer_writers: sequence as usize,
                        live_fifo_writers: sequence as usize,
                        live_resources: sequence as usize,
                        detached_writers: sequence as usize,
                    },
                },
                state: None,
                gate: gate.clone(),
            });
        }
        start_tx.send(()).expect("release persistence worker");

        let records = recv_lifecycle_records(&persisted, 2);
        assert!(matches!(
            &records[0],
            EncoderBridgeLifecycleWorkerRecord::Transition(transition)
                if transition.sequence == 1
        ));
        assert!(matches!(
            &records[1],
            EncoderBridgeLifecycleWorkerRecord::Overflow {
                dropped_transitions: 2,
                latest_sequence: 3,
                lifecycle,
            } if lifecycle.live_outer_writers == 3
                && lifecycle.live_fifo_writers == 3
                && lifecycle.live_resources == 3
                && lifecycle.detached_writers == 3
        ));
        drop(gate);
        drop(publisher);
        worker.join().expect("test persistence worker joins");
    }

    #[test]
    fn fifo_registration_precedes_spawn_and_failed_spawn_rolls_it_back() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (publisher, persisted, worker) = test_lifecycle_publisher(8, None);
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test_with_publisher(
            "session-failed-fifo-spawn",
            EncoderBridgeOutputRole::Recording,
            publisher.clone(),
        );

        let error = spawn_registered_fifo_writer_with(
            Some(lifecycle.clone()),
            || panic!("writer body must not run when spawn fails"),
            |task| {
                assert_eq!(encoder_bridge_lifecycle_snapshot().live_fifo_writers, 1);
                drop(task);
                Err(io::Error::other("injected thread spawn failure"))
            },
        )
        .expect_err("injected spawner fails");

        assert!(error.to_string().contains("injected thread spawn failure"));
        assert_eq!(encoder_bridge_lifecycle_snapshot().live_fifo_writers, 0);
        let records = recv_lifecycle_records(&persisted, 2);
        let transitions = records
            .iter()
            .filter_map(|record| match record {
                EncoderBridgeLifecycleWorkerRecord::Transition(transition) => Some(transition),
                EncoderBridgeLifecycleWorkerRecord::Overflow { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            transitions
                .iter()
                .map(|transition| transition.state)
                .collect::<Vec<_>>(),
            vec!["fifo-started", "fifo-exited"]
        );
        assert!(transitions[0].sequence < transitions[1].sequence);
        lifecycle.cancel_failed_start();
        assert_eq!(encoder_bridge_lifecycle_snapshot().live_resources, 0);
        drop(lifecycle);
        drop(publisher);
        worker.join().expect("test persistence worker joins");
    }

    #[test]
    fn main_loop_downstream_close_survives_into_final_drain_timeout_verdict() {
        let terminal_failure = Arc::new(StdMutex::new(None));
        let mut drain_state = EncoderBridgeDrainState::default();
        let message = drain_state.record_main_loop_error(
            &terminal_failure,
            EncoderBridgeOutputRole::Recording,
            &io::Error::new(io::ErrorKind::BrokenPipe, "muxer closed FIFO"),
        );

        assert!(message.contains("downstream closed"));
        assert_eq!(
            read_encoder_bridge_terminal_failure(&terminal_failure),
            None
        );
        assert!(drain_state.downstream_closed);
        assert!(!drain_state.pending_timeout_is_terminal(3, 2));
    }

    fn test_session_with_writer(
        stop: Arc<AtomicBool>,
        writer: thread::JoinHandle<()>,
        lifecycle: EncoderBridgeWriterLifecycle,
    ) -> EncoderBridgeRecordingSession {
        EncoderBridgeRecordingSession {
            stop,
            terminal_failure: Arc::new(StdMutex::new(None)),
            startup_ready: None,
            fifo_path: PathBuf::from("/nonexistent-test-fifo"),
            writer: Some(writer),
            diagnostics_task: None,
            lifecycle: Some(lifecycle),
            #[cfg(target_os = "windows")]
            d3d11_input: None,
        }
    }

    fn wait_for_lifecycle_resources_to_clear() {
        let deadline = Instant::now() + Duration::from_secs(2);
        while encoder_bridge_lifecycle_snapshot().live_resources != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(encoder_bridge_lifecycle_snapshot().live_resources, 0);
    }

    #[test]
    fn stop_and_reap_joins_a_cooperative_writer_and_reports_success() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-cooperative",
            EncoderBridgeOutputRole::Shared,
        );
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = stop.clone();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle,
            };
            while !writer_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(5));
            }
        });
        let session = test_session_with_writer(stop, writer, lifecycle);
        let report = session.stop_and_reap(Duration::from_secs(2));
        assert!(report.reaped);
        assert_eq!(report.lifecycle.live_resources, 0);
    }

    #[test]
    fn encoder_bridge_lifecycle_tracks_cooperative_outer_and_fifo_exit() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-outer-fifo",
            EncoderBridgeOutputRole::Recording,
        );
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = stop.clone();
        let (fifo_ready_tx, fifo_ready_rx) = std_mpsc::channel();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle.clone(),
            };
            let fifo_stop = writer_stop.clone();
            let fifo_lifecycle = writer_lifecycle.clone();
            let fifo = thread::spawn(move || {
                let _fifo = EncoderBridgeFifoWriterGuard::enter(Some(fifo_lifecycle));
                fifo_ready_tx.send(()).expect("publish FIFO readiness");
                while !fifo_stop.load(Ordering::Relaxed) {
                    thread::yield_now();
                }
            });
            while !writer_stop.load(Ordering::Relaxed) {
                thread::yield_now();
            }
            fifo.join().expect("cooperative FIFO writer joins");
        });
        fifo_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO writer became live");
        let live = encoder_bridge_lifecycle_snapshot();
        assert_eq!(live.live_outer_writers, 1);
        assert_eq!(live.live_fifo_writers, 1);
        assert_eq!(live.live_resources, 1);

        let session = test_session_with_writer(stop, writer, lifecycle);
        let report = session.stop_and_reap(Duration::from_secs(1));
        assert!(report.reaped);
        assert!(!report.detached);
        assert_eq!(report.lifecycle, EncoderBridgeLifecycleSnapshot::default());
    }

    #[test]
    fn raw_fifo_close_and_join_detach_remains_visible_after_outer_exit() {
        struct BlockingSink {
            started: Option<std_mpsc::SyncSender<()>>,
            release: std_mpsc::Receiver<()>,
        }

        impl StdWrite for BlockingSink {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if let Some(started) = self.started.take() {
                    started.send(()).map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "test observer closed")
                    })?;
                }
                self.release.recv().map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "test release closed")
                })?;
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (publisher, persisted, worker) = test_lifecycle_publisher(16, None);
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test_with_publisher(
            "session-nested-fifo-detach",
            EncoderBridgeOutputRole::Recording,
            publisher.clone(),
        );
        let outer_guard = EncoderBridgeOuterWriterGuard {
            lifecycle: lifecycle.clone(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let terminal_failure = Arc::new(StdMutex::new(None));
        let (started_tx, started_rx) = std_mpsc::sync_channel(1);
        let (release_tx, release_rx) = std_mpsc::channel();
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Recording,
            ..EncoderBridgeDiagnosticsContext::default()
        });
        let mut fifo_writer = RawVideoFifoWriter::start_with_sink(
            BlockingSink {
                started: Some(started_tx),
                release: release_rx,
            },
            policy,
            stop.clone(),
            terminal_failure.clone(),
            Some(lifecycle.clone()),
        );
        fifo_writer
            .enqueue_startup(QueuedRawVideoFrame::synthetic(vec![1, 2, 3, 4]))
            .expect("enqueue frame into production mailbox path");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("nested FIFO entered its real sink write");
        assert_eq!(
            fifo_writer.close_and_join_until(Instant::now() + Duration::from_millis(80)),
            BoundedWriterJoinOutcome::Detached,
        );
        drop(outer_guard);

        let session = EncoderBridgeRecordingSession {
            stop,
            terminal_failure,
            startup_ready: None,
            fifo_path: PathBuf::from("/nonexistent-test-fifo"),
            writer: None,
            diagnostics_task: None,
            lifecycle: Some(lifecycle),
            #[cfg(target_os = "windows")]
            d3d11_input: None,
        };
        let report = session.stop_and_reap(Duration::ZERO);
        assert!(report.detached);
        assert!(!report.reaped);
        assert_eq!(report.lifecycle.live_outer_writers, 0);
        assert_eq!(report.lifecycle.live_fifo_writers, 1);
        assert_eq!(report.lifecycle.live_resources, 1);
        assert_eq!(report.lifecycle.detached_writers, 1);
        assert!(
            encoder_bridge_writer_registry()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .admission_blocker("session-after-nested-detach")
                .is_some(),
            "a detached nested FIFO must block the next session"
        );

        release_tx.send(()).expect("release nested FIFO sink");
        drop(fifo_writer);
        wait_for_lifecycle_resources_to_clear();
        assert!(
            report.detached,
            "the per-bridge report retains detach history"
        );
        let records = recv_lifecycle_records(&persisted, 5);
        let transitions = records
            .iter()
            .filter_map(|record| match record {
                EncoderBridgeLifecycleWorkerRecord::Transition(transition) => Some(transition),
                EncoderBridgeLifecycleWorkerRecord::Overflow { .. } => None,
            })
            .collect::<Vec<_>>();
        assert!(transitions.iter().any(|transition| {
            transition.state == "fifo-started"
                && transition.session_id == "session-nested-fifo-detach"
                && transition.role == EncoderBridgeOutputRole::Recording
        }));
        assert!(transitions.iter().any(|transition| {
            transition.state == "detached"
                && transition.lifecycle.live_fifo_writers == 1
                && transition.lifecycle.detached_writers == 1
        }));
        assert!(transitions.iter().any(|transition| {
            transition.state == "fifo-exited/resource-released"
                && transition.lifecycle.live_resources == 0
        }));
        assert!(
            transitions
                .windows(2)
                .all(|pair| pair[0].sequence < pair[1].sequence),
            "autonomous persistence preserves registry mutation order"
        );
        drop(publisher);
        worker.join().expect("test persistence worker joins");
    }

    #[test]
    fn encoder_bridge_lifecycle_reaps_after_unsolicited_outer_exit() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-unsolicited-exit",
            EncoderBridgeOutputRole::Shared,
        );
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let (exited_tx, exited_rx) = std_mpsc::channel();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle,
            };
            exit_rx.recv().expect("simulate muxer exit");
            drop(_outer);
            exited_tx.send(()).expect("publish writer exit");
        });
        let session = test_session_with_writer(stop.clone(), writer, lifecycle);
        exit_tx
            .send(())
            .expect("release writer without stop intent");
        exited_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer exited before monitor reap");
        assert!(!stop.load(Ordering::Relaxed));

        let report = session.stop_and_reap(Duration::from_secs(1));
        assert!(report.reaped);
        assert!(stop.load(Ordering::Relaxed));
        assert_eq!(report.lifecycle.live_resources, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_batch_signals_both_bridges_and_shares_one_absolute_deadline() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (publisher, persisted, worker) = test_lifecycle_publisher(16, None);
        let mut sessions = Vec::new();
        let mut releases = Vec::new();
        let mut stops = Vec::new();
        for (suffix, role) in [
            ("recording", EncoderBridgeOutputRole::Recording),
            ("stream", EncoderBridgeOutputRole::Stream),
        ] {
            let lifecycle = EncoderBridgeWriterLifecycle::register_for_test_with_publisher(
                &format!("session-two-bridges-{suffix}"),
                role,
                publisher.clone(),
            );
            let writer_lifecycle = lifecycle.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let (ready_tx, ready_rx) = std_mpsc::channel();
            let (release_tx, release_rx) = std_mpsc::channel();
            let writer = thread::spawn(move || {
                let _outer = EncoderBridgeOuterWriterGuard {
                    lifecycle: writer_lifecycle,
                };
                ready_tx.send(()).expect("publish writer readiness");
                release_rx.recv().expect("release detached writer");
            });
            ready_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("writer became live");
            stops.push(stop.clone());
            sessions.push(test_session_with_writer(stop, writer, lifecycle));
            releases.push(release_tx);
        }
        let started_at = Instant::now();
        let batch = begin_encoder_bridge_shutdown(sessions, Duration::from_millis(120))
            .expect("two sessions start one batch");
        assert!(
            stops.iter().all(|stop| stop.load(Ordering::Relaxed)),
            "both bridge stop edges happen synchronously before reap begins"
        );
        assert!(
            matches!(
                persisted.recv_timeout(Duration::from_millis(50)),
                Err(std_mpsc::RecvTimeoutError::Timeout)
            ),
            "deadline gate withholds lifecycle I/O until reap finishes"
        );
        let report = batch.finish().await;
        assert!(report.reports.iter().all(|bridge| bridge.detached));
        assert!(
            started_at.elapsed() < Duration::from_millis(300),
            "two bridges must not receive sequential teardown budgets"
        );
        assert!(report.task_error.is_none());
        let teardown_records = recv_lifecycle_records(&persisted, 4);
        assert_eq!(
            teardown_records
                .iter()
                .filter(|record| matches!(
                    record,
                    EncoderBridgeLifecycleWorkerRecord::Transition(transition)
                        if transition.state == "stop-signalled"
                ))
                .count(),
            2
        );
        assert_eq!(encoder_bridge_lifecycle_snapshot().detached_writers, 2);
        for release in releases {
            release.send(()).expect("release detached writer");
        }
        wait_for_lifecycle_resources_to_clear();
        let late_records = recv_lifecycle_records(&persisted, 2);
        assert!(late_records.iter().all(|record| matches!(
            record,
            EncoderBridgeLifecycleWorkerRecord::Transition(transition)
                if transition.state == "outer-exited/resource-released"
        )));
        drop(publisher);
        worker.join().expect("test persistence worker joins");
    }

    #[test]
    fn encoder_bridge_lifecycle_preserves_failure_discovered_during_final_drain() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-final-drain-failure",
            EncoderBridgeOutputRole::Recording,
        );
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = stop.clone();
        let terminal_failure = Arc::new(StdMutex::new(None));
        let writer_failure = terminal_failure.clone();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle,
            };
            while !writer_stop.load(Ordering::Relaxed) {
                thread::yield_now();
            }
            record_encoder_bridge_terminal_failure(
                &writer_failure,
                "final FIFO drain failed".to_string(),
            );
        });
        let session = EncoderBridgeRecordingSession {
            stop,
            terminal_failure,
            startup_ready: None,
            fifo_path: PathBuf::from("/nonexistent-test-fifo"),
            writer: Some(writer),
            diagnostics_task: None,
            lifecycle: Some(lifecycle),
            #[cfg(target_os = "windows")]
            d3d11_input: None,
        };

        let report = session.stop_and_reap(Duration::from_secs(1));
        assert!(report.reaped);
        assert_eq!(
            report.terminal_failure.as_deref(),
            Some("final FIFO drain failed")
        );
        assert_eq!(report.lifecycle.live_resources, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn encoder_bridge_lifecycle_start_admission_refuses_live_resource() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-admission-blocker",
            EncoderBridgeOutputRole::Shared,
        );
        let error =
            wait_for_encoder_bridge_start_admission("session-admission-next", Duration::ZERO)
                .await
                .expect_err("a previous live writer must fail closed");
        assert!(error.to_string().contains("Restart Videorc"));
        lifecycle.cancel_failed_start();
        assert_eq!(encoder_bridge_lifecycle_snapshot().live_resources, 0);
    }

    #[test]
    fn stop_and_reap_detaches_a_hung_writer_and_reports_the_leak() {
        let _serial = ENCODER_BRIDGE_LIFECYCLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lifecycle = EncoderBridgeWriterLifecycle::register_for_test(
            "session-hung",
            EncoderBridgeOutputRole::Shared,
        );
        let writer_lifecycle = lifecycle.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let writer = thread::spawn(move || {
            let _outer = EncoderBridgeOuterWriterGuard {
                lifecycle: writer_lifecycle,
            };
            // Deliberately ignores the stop flag until released, like the
            // leaked writers in the 2026-08-24 incident.
            let _ = release_rx.recv();
        });
        let session = test_session_with_writer(stop.clone(), writer, lifecycle);
        let report = session.stop_and_reap(Duration::from_millis(120));
        assert!(!report.reaped);
        assert!(report.detached);
        assert!(stop.load(Ordering::Relaxed), "stop flag must still be set");
        assert_eq!(report.lifecycle.live_outer_writers, 1);
        assert_eq!(report.lifecycle.live_resources, 1);
        assert_eq!(report.lifecycle.detached_writers, 1);
        let blocker = encoder_bridge_writer_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .admission_blocker("session-next");
        assert!(blocker.is_some(), "detached writer must fail admission");
        release_tx.send(()).expect("release the fake writer");
        wait_for_lifecycle_resources_to_clear();
    }

    #[test]
    fn media_foundation_writer_input_credit_cap_is_two_frame_intervals() {
        assert_eq!(
            media_foundation_writer_input_credit_timeout(60),
            Duration::from_secs_f64(2.0 / 60.0)
        );
        assert_eq!(
            media_foundation_writer_input_credit_timeout(30),
            Duration::from_secs_f64(2.0 / 30.0)
        );
        // A zero target can never produce an infinite wait.
        assert_eq!(
            media_foundation_writer_input_credit_timeout(0),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn bridge_frame_sources_map_onto_session_accounting_kinds() {
        use crate::diagnostics::BridgeInputKind;
        assert_eq!(
            BridgeFrameSource::Fresh.accounting_kind(),
            BridgeInputKind::Fresh
        );
        assert_eq!(
            BridgeFrameSource::Repeated.accounting_kind(),
            BridgeInputKind::Repeated
        );
        assert_eq!(
            BridgeFrameSource::SyntheticFallback.accounting_kind(),
            BridgeInputKind::Synthetic
        );
    }

    #[test]
    fn windows_d3d11_primary_sequence_newer_only_for_unseen_publications() {
        assert!(!windows_d3d11_primary_sequence_is_newer(None, None));
        assert!(!windows_d3d11_primary_sequence_is_newer(None, Some(7)));
        assert!(windows_d3d11_primary_sequence_is_newer(Some(1), None));
        assert!(windows_d3d11_primary_sequence_is_newer(Some(8), Some(7)));
        assert!(!windows_d3d11_primary_sequence_is_newer(Some(7), Some(7)));
        assert!(!windows_d3d11_primary_sequence_is_newer(Some(6), Some(7)));
    }

    #[test]
    fn diagnostics_channel_is_latest_wins_without_losing_terminal_error() {
        let (tx, rx) = watch::channel::<Option<EncoderBridgeWriterEvent>>(None);
        emit_encoder_bridge_diagnostics_from_thread(
            &tx,
            "session".to_string(),
            30,
            EncoderBridgeRuntimeStats {
                queue_depth: 1,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            Some("encoder failed".to_string()),
        );
        emit_encoder_bridge_diagnostics_from_thread(
            &tx,
            "session".to_string(),
            30,
            EncoderBridgeRuntimeStats {
                queue_depth: 2,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext::default(),
            None,
        );

        let latest = rx.borrow().clone().expect("latest diagnostics event");
        assert_eq!(latest.stats.queue_depth, 2);
        assert_eq!(latest.error.as_deref(), Some("encoder failed"));
    }

    #[test]
    fn stream_policy_coalesces_before_encode_then_fails_at_the_hard_latency_ceiling() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..EncoderBridgeDiagnosticsContext::default()
        });

        assert_eq!(policy.max_frames, 8);
        assert_eq!(policy.max_age, Duration::from_millis(150));
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 3, Some(Duration::from_millis(99))),
            EncoderBridgePreEncodeAdmission::Submit
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 4, Some(Duration::from_millis(35))),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 2, Some(Duration::from_millis(100))),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 8, Some(Duration::from_millis(35))),
            EncoderBridgePreEncodeAdmission::FailOutput
        );
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 2, Some(Duration::from_millis(150))),
            EncoderBridgePreEncodeAdmission::FailOutput
        );
    }

    #[test]
    fn stream_over_budget_degrades_first_and_fails_only_when_sustained() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..EncoderBridgeDiagnosticsContext::default()
        });
        let since = Instant::now();

        // A fresh over-age sample (the 2026-07-15 incident shape: depth 2/8,
        // oldest 166ms) degrades instead of killing the stream.
        assert_eq!(
            encoder_bridge_over_budget_escalation(policy, 2, since, since),
            EncoderBridgeOverBudgetEscalation::Degrade
        );
        assert_eq!(
            encoder_bridge_over_budget_escalation(
                policy,
                2,
                since,
                since + STREAM_OUTPUT_SUSTAINED_FAIL_WINDOW - Duration::from_millis(1),
            ),
            EncoderBridgeOverBudgetEscalation::Degrade
        );
        // Continuously over budget for the whole window → real failure.
        assert_eq!(
            encoder_bridge_over_budget_escalation(
                policy,
                2,
                since,
                since + STREAM_OUTPUT_SUSTAINED_FAIL_WINDOW,
            ),
            EncoderBridgeOverBudgetEscalation::Fail
        );
        // A queue at its frame ceiling is not jitter — fail immediately.
        assert_eq!(
            encoder_bridge_over_budget_escalation(policy, 8, since, since),
            EncoderBridgeOverBudgetEscalation::Fail
        );
    }

    #[test]
    fn recording_pressure_pauses_while_progressing_and_fails_only_after_no_progress() {
        for role in [
            EncoderBridgeOutputRole::Recording,
            EncoderBridgeOutputRole::Shared,
        ] {
            let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
                role,
                ..EncoderBridgeDiagnosticsContext::default()
            });
            assert_eq!(
                encoder_bridge_progress_aware_pre_encode_admission(
                    policy,
                    6,
                    Some(Duration::from_millis(528)),
                    Duration::from_millis(20),
                ),
                EncoderBridgePreEncodeAdmission::Submit,
                "recording age is diagnostic while bounded depth remains"
            );
            assert_eq!(
                encoder_bridge_progress_aware_pre_encode_admission(
                    policy,
                    16,
                    Some(Duration::from_millis(528)),
                    RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT - Duration::from_millis(1),
                ),
                EncoderBridgePreEncodeAdmission::PauseRecordingFrame
            );
            assert_eq!(
                encoder_bridge_progress_aware_pre_encode_admission(
                    policy,
                    16,
                    Some(Duration::from_millis(528)),
                    RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT,
                ),
                EncoderBridgePreEncodeAdmission::FailOutput
            );
        }
    }

    #[test]
    fn recording_policy_preserves_every_frame_and_fails_before_hidden_latency() {
        for role in [
            EncoderBridgeOutputRole::Recording,
            EncoderBridgeOutputRole::Shared,
        ] {
            let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
                role,
                ..EncoderBridgeDiagnosticsContext::default()
            });
            assert_eq!(policy.coalesce_at_frames, None);
            assert_eq!(policy.coalesce_at_age, None);
            assert_eq!(policy.max_frames, 16);
            assert_eq!(policy.max_age, Duration::from_millis(250));
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 15, Some(Duration::from_millis(249))),
                EncoderBridgePreEncodeAdmission::Submit
            );
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 16, Some(Duration::from_millis(99))),
                EncoderBridgePreEncodeAdmission::FailOutput
            );
            assert_eq!(
                encoder_bridge_pre_encode_admission(policy, 4, Some(Duration::from_millis(250))),
                EncoderBridgePreEncodeAdmission::FailOutput
            );
        }
    }

    #[test]
    fn progressing_recording_pressure_at_the_incident_ceiling_does_not_stop_output() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Recording,
            recording_output: Some(EncoderBridgeOutputProfile {
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 8_000,
            }),
            ..EncoderBridgeDiagnosticsContext::default()
        });

        assert_eq!(
            encoder_bridge_progress_aware_pre_encode_admission(
                policy,
                16,
                Some(Duration::from_millis(528)),
                Duration::from_millis(12),
            ),
            EncoderBridgePreEncodeAdmission::PauseRecordingFrame,
            "the reproduced 4K30 depth 16/16, oldest 528ms sample was still making downstream progress and must pause before encode instead of stopping the recording",
        );
    }

    #[test]
    fn hard_pressure_error_names_the_role_budget_and_integrity_choice() {
        let recording_policy =
            encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
                role: EncoderBridgeOutputRole::Recording,
                ..EncoderBridgeDiagnosticsContext::default()
            });
        let recording_error = encoder_bridge_output_pressure_error(
            recording_policy,
            16,
            Some(Duration::from_millis(251)),
            RECORDING_OUTPUT_NO_PROGRESS_TIMEOUT,
        )
        .to_string();
        assert!(recording_error.contains("recording encoder output"));
        assert!(recording_error.contains("depth 16/16"));
        assert!(recording_error.contains("oldest 251/250ms"));
        assert!(recording_error.contains("no progress for 2000ms"));
        assert!(recording_error.contains("all queued encoded access units were preserved"));

        let stream_policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..EncoderBridgeDiagnosticsContext::default()
        });
        let stream_error = encoder_bridge_output_pressure_error(
            stream_policy,
            8,
            Some(Duration::from_millis(151)),
            Duration::from_millis(20),
        )
        .to_string();
        assert!(stream_error.contains("stream encoder output"));
        assert!(stream_error.contains("encoded H.264 access units were preserved"));
    }

    #[test]
    fn stream_only_shared_diagnostics_use_stream_overload_policy() {
        let policy = encoder_bridge_output_queue_policy(EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Shared,
            recording_output: None,
            stream_output: Some(EncoderBridgeOutputProfile {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6_000,
            }),
            ..EncoderBridgeDiagnosticsContext::default()
        });

        assert_eq!(policy.role, EncoderBridgeOutputRole::Stream);
        assert_eq!(
            encoder_bridge_pre_encode_admission(policy, 4, None),
            EncoderBridgePreEncodeAdmission::CoalesceLatestStreamFrame
        );
    }

    #[test]
    fn record_only_shared_diagnostics_use_recording_role_and_label() {
        let context = EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Shared,
            recording_output: Some(EncoderBridgeOutputProfile {
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 8_000,
            }),
            stream_output: None,
            ..EncoderBridgeDiagnosticsContext::default()
        };

        let policy = encoder_bridge_output_queue_policy(context);
        assert_eq!(policy.role, EncoderBridgeOutputRole::Recording);
        assert_eq!(encoder_bridge_output_role_label(policy.role), "recording");
    }

    #[test]
    fn split_output_process_diagnostics_preserve_both_roles_and_use_conservative_aggregate() {
        let mut base = idle_diagnostics();
        base.encoder_bridge_recording_raw_video_copied_frames = 120;
        base.encoder_bridge_recording_dropped_frames = 3;
        base.encoder_bridge_recording_encoder_speed = Some(0.82);

        let merged = merge_encoder_bridge_role_process_diagnostics(
            &base,
            EncoderBridgeRuntimeStats {
                raw_video_copied_frames: 90,
                dropped_frames: 1,
                encoder_speed: Some(1.03),
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext {
                role: EncoderBridgeOutputRole::Stream,
                recording_output: Some(EncoderBridgeOutputProfile {
                    width: 3840,
                    height: 2160,
                    fps: 30,
                    bitrate_kbps: 30_000,
                }),
                stream_output: Some(EncoderBridgeOutputProfile {
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 6_000,
                }),
                separate_output_encoders_active: true,
                ..EncoderBridgeDiagnosticsContext::default()
            },
        );

        assert_eq!(merged.recording_raw_video_copied_frames, 120);
        assert_eq!(merged.stream_raw_video_copied_frames, 90);
        assert_eq!(merged.raw_video_copied_frames, 210);
        assert_eq!(merged.recording_dropped_frames, 3);
        assert_eq!(merged.stream_dropped_frames, 1);
        assert_eq!(merged.dropped_frames, 4);
        assert_eq!(merged.recording_encoder_speed, Some(0.82));
        assert_eq!(merged.stream_encoder_speed, Some(1.03));
        assert_eq!(merged.encoder_speed, Some(0.82));
    }

    #[test]
    fn split_output_diagnostics_are_order_independent_and_reset_between_sessions() {
        let recording_context = EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Recording,
            recording_output: Some(EncoderBridgeOutputProfile {
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            }),
            stream_output: Some(EncoderBridgeOutputProfile {
                width: 1920,
                height: 1080,
                fps: 60,
                bitrate_kbps: 6_000,
            }),
            separate_output_encoders_active: true,
            ..EncoderBridgeDiagnosticsContext::default()
        };
        let stream_context = EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Stream,
            ..recording_context
        };
        let recording_runtime = EncoderBridgeRuntimeStats {
            input_fps: Some(29.7),
            repeated_fed_frames: 737,
            repeated_frame_bursts: 11,
            max_repeated_frame_run: 303,
            synthetic_fallback_frames: 2,
            source_to_encode_age_ms: Some(211),
            source_to_encode_age_p95_ms: Some(48.0),
            repeated_frame_age_p95_ms: Some(132.0),
            repeated_frame_age_max_ms: Some(211),
            metal_target_frames: 1_001,
            metal_target_copied_frames: 3,
            metal_target_handle_frames: 1_001,
            zero_copy_frames: 998,
            video_toolbox_probe_frames: 7,
            video_toolbox_probe_bytes: 8_192,
            video_toolbox_probe_errors: 1,
            video_toolbox_output_encode_ms: Some(44),
            compositor_wait_p95_ms: Some(4.5),
            video_toolbox_submit_p95_ms: Some(2.5),
            raw_video_fifo_write_p95_ms: Some(11.0),
            video_toolbox_fifo_write_p95_ms: Some(3.0),
            video_toolbox_fifo_enqueue_p95_ms: Some(7.0),
            video_toolbox_fifo_enqueue_max_ms: Some(14.0),
            writer_loop_p95_ms: Some(12.0),
            writer_sleep_p95_ms: Some(8.0),
            writer_active_p95_ms: Some(4.0),
            deadline_lag_p95_ms: Some(4.0),
            deadline_lag_max_ms: Some(9.0),
            late_deadline_ticks: 7,
            schedule_skipped_ms: 33,
            ..Default::default()
        };
        let stream_runtime = EncoderBridgeRuntimeStats {
            input_fps: Some(8.88),
            repeated_fed_frames: 0,
            repeated_frame_bursts: 0,
            max_repeated_frame_run: 0,
            synthetic_fallback_frames: 91,
            source_to_encode_age_ms: Some(900),
            source_to_encode_age_p95_ms: Some(800.0),
            repeated_frame_age_p95_ms: Some(700.0),
            repeated_frame_age_max_ms: Some(900),
            metal_target_frames: 88,
            metal_target_copied_frames: 77,
            metal_target_handle_frames: 66,
            zero_copy_frames: 55,
            video_toolbox_probe_frames: 44,
            video_toolbox_probe_bytes: 33,
            video_toolbox_probe_errors: 22,
            video_toolbox_output_encode_ms: Some(999),
            compositor_wait_p95_ms: Some(662.0),
            video_toolbox_submit_p95_ms: Some(661.0),
            raw_video_fifo_write_p95_ms: Some(660.0),
            video_toolbox_fifo_write_p95_ms: Some(659.0),
            video_toolbox_fifo_enqueue_p95_ms: Some(658.0),
            video_toolbox_fifo_enqueue_max_ms: Some(657.0),
            writer_loop_p95_ms: Some(656.0),
            writer_sleep_p95_ms: Some(655.0),
            writer_active_p95_ms: Some(654.0),
            deadline_lag_p95_ms: Some(653.0),
            deadline_lag_max_ms: Some(652.0),
            late_deadline_ticks: 651,
            schedule_skipped_ms: 650,
            ..Default::default()
        };
        let expected_artifact =
            EncoderBridgeRecordingArtifactDiagnostics::from_runtime(recording_runtime);
        let recording_role = runtime_role_diagnostics(recording_runtime);
        let stream_role = runtime_role_diagnostics(stream_runtime);
        let expected_role_diagnostics = EncoderBridgeMergedRoleDiagnostics {
            recording: recording_role,
            stream: stream_role,
            aggregate: aggregate_role_diagnostics(recording_role, stream_role),
        };
        let recording_error = Some("recording encoder failed".to_string());
        let stream_error = Some("stream encoder failed".to_string());

        let mut stream_then_recording_stats = idle_diagnostics();
        let stream_first_artifact = merge_encoder_bridge_recording_artifact_diagnostics(
            &stream_then_recording_stats,
            stream_runtime,
            stream_context,
        );
        assert_eq!(
            stream_first_artifact,
            EncoderBridgeRecordingArtifactDiagnostics::from_stats(&stream_then_recording_stats),
            "a stream report cannot claim recording-owned artifact diagnostics"
        );
        let stream_first_role_diagnostics = merge_encoder_bridge_role_diagnostics(
            &stream_then_recording_stats,
            stream_runtime,
            stream_context,
        );
        let stream_first_error = merge_encoder_bridge_recording_error(
            &stream_then_recording_stats,
            stream_error.clone(),
            stream_context,
        );
        assert_eq!(stream_first_error, None);
        store_recording_artifact_diagnostics(
            &mut stream_then_recording_stats,
            stream_first_artifact,
        );
        store_role_diagnostics(
            &mut stream_then_recording_stats,
            stream_first_role_diagnostics,
        );
        stream_then_recording_stats.encoder_bridge_error = stream_first_error;
        let retained_stream_high_water = merge_encoder_bridge_role_diagnostics(
            &stream_then_recording_stats,
            EncoderBridgeRuntimeStats {
                metal_target_frames: 1,
                compositor_wait_p95_ms: Some(1.0),
                late_deadline_ticks: 1,
                ..Default::default()
            },
            stream_context,
        );
        assert_eq!(retained_stream_high_water.stream, stream_role);

        let stream_then_recording_artifact = merge_encoder_bridge_recording_artifact_diagnostics(
            &stream_then_recording_stats,
            recording_runtime,
            recording_context,
        );
        let stream_then_recording_role_diagnostics = merge_encoder_bridge_role_diagnostics(
            &stream_then_recording_stats,
            recording_runtime,
            recording_context,
        );
        let stream_then_recording_error = merge_encoder_bridge_recording_error(
            &stream_then_recording_stats,
            recording_error.clone(),
            recording_context,
        );

        let mut recording_then_stream_stats = idle_diagnostics();
        let recording_first_artifact = merge_encoder_bridge_recording_artifact_diagnostics(
            &recording_then_stream_stats,
            recording_runtime,
            recording_context,
        );
        let recording_first_role_diagnostics = merge_encoder_bridge_role_diagnostics(
            &recording_then_stream_stats,
            recording_runtime,
            recording_context,
        );
        let recording_first_error = merge_encoder_bridge_recording_error(
            &recording_then_stream_stats,
            recording_error,
            recording_context,
        );
        store_recording_artifact_diagnostics(
            &mut recording_then_stream_stats,
            recording_first_artifact,
        );
        store_role_diagnostics(
            &mut recording_then_stream_stats,
            recording_first_role_diagnostics,
        );
        recording_then_stream_stats.encoder_bridge_error = recording_first_error;
        assert_eq!(
            merge_encoder_bridge_recording_error(
                &recording_then_stream_stats,
                None,
                recording_context,
            ),
            recording_then_stream_stats.encoder_bridge_error,
            "a later healthy sample cannot erase a recorded recording-leg error"
        );
        let recording_then_stream_artifact = merge_encoder_bridge_recording_artifact_diagnostics(
            &recording_then_stream_stats,
            stream_runtime,
            stream_context,
        );
        let recording_then_stream_role_diagnostics = merge_encoder_bridge_role_diagnostics(
            &recording_then_stream_stats,
            stream_runtime,
            stream_context,
        );
        let recording_then_stream_error = merge_encoder_bridge_recording_error(
            &recording_then_stream_stats,
            stream_error,
            stream_context,
        );

        assert_eq!(stream_then_recording_artifact, expected_artifact);
        assert_eq!(recording_then_stream_artifact, expected_artifact);
        assert_eq!(
            stream_then_recording_artifact,
            recording_then_stream_artifact
        );
        assert_eq!(
            stream_then_recording_role_diagnostics,
            expected_role_diagnostics
        );
        assert_eq!(
            recording_then_stream_role_diagnostics,
            expected_role_diagnostics
        );
        assert_eq!(
            stream_then_recording_error.as_deref(),
            Some("recording encoder failed")
        );
        assert_eq!(recording_then_stream_error, stream_then_recording_error);
        assert_eq!(
            expected_role_diagnostics.aggregate.metal_target_frames,
            1_089
        );
        assert_eq!(
            expected_role_diagnostics
                .aggregate
                .video_toolbox_probe_errors,
            23
        );
        assert_eq!(
            expected_role_diagnostics
                .aggregate
                .video_toolbox_output_encode_ms,
            Some(999)
        );
        assert_eq!(
            expected_role_diagnostics.aggregate.compositor_wait_p95_ms,
            Some(662.0)
        );
        assert_eq!(expected_role_diagnostics.aggregate.late_deadline_ticks, 658);
        assert_eq!(expected_role_diagnostics.aggregate.schedule_skipped_ms, 683);
        assert_eq!(
            encoder_bridge_recording_diagnostics_target_fps(60, recording_context),
            30
        );
        assert_eq!(
            encoder_bridge_recording_diagnostics_target_fps(60, stream_context),
            30,
            "stream-first diagnostics must classify recording cadence against the recording profile"
        );
        assert_eq!(
            merge_encoder_bridge_recording_artifact_diagnostics(
                &idle_diagnostics(),
                stream_runtime,
                EncoderBridgeDiagnosticsContext::default(),
            ),
            EncoderBridgeRecordingArtifactDiagnostics::from_runtime(stream_runtime),
            "a non-split bridge remains the owner of generic diagnostics"
        );
        assert_eq!(
            merge_encoder_bridge_role_diagnostics(
                &idle_diagnostics(),
                stream_runtime,
                EncoderBridgeDiagnosticsContext::default(),
            )
            .aggregate,
            stream_role
        );
        assert_eq!(
            merge_encoder_bridge_recording_error(
                &idle_diagnostics(),
                Some("shared encoder failed".to_string()),
                EncoderBridgeDiagnosticsContext::default(),
            )
            .as_deref(),
            Some("shared encoder failed")
        );
        assert_eq!(
            encoder_bridge_recording_diagnostics_target_fps(
                60,
                EncoderBridgeDiagnosticsContext::default(),
            ),
            60
        );

        store_recording_artifact_diagnostics(
            &mut recording_then_stream_stats,
            recording_then_stream_artifact,
        );
        store_role_diagnostics(
            &mut recording_then_stream_stats,
            recording_then_stream_role_diagnostics,
        );
        recording_then_stream_stats.encoder_bridge_error = recording_then_stream_error;
        let next_session = starting_diagnostics("next-session", 30, "encoder-bridge");
        assert_eq!(
            next_session.encoder_bridge_recording_role_diagnostics,
            EncoderBridgeRoleDiagnosticStats::default()
        );
        assert_eq!(
            next_session.encoder_bridge_stream_role_diagnostics,
            EncoderBridgeRoleDiagnosticStats::default()
        );
        assert_eq!(next_session.encoder_bridge_repeated_frames, 0);
        assert_eq!(next_session.encoder_bridge_error, None);
        assert_eq!(
            merge_encoder_bridge_recording_artifact_diagnostics(
                &next_session,
                stream_runtime,
                stream_context,
            ),
            EncoderBridgeRecordingArtifactDiagnostics::default()
        );
        let next_session_stream =
            merge_encoder_bridge_role_diagnostics(&next_session, stream_runtime, stream_context);
        assert_eq!(next_session_stream.recording, Default::default());
        assert_eq!(next_session_stream.stream, stream_role);
        assert_eq!(next_session_stream.aggregate, stream_role);
        assert_eq!(
            merge_encoder_bridge_recording_error(
                &next_session,
                Some("new stream error".to_string()),
                stream_context,
            ),
            None
        );
    }

    #[test]
    fn split_output_pressure_diagnostics_preserve_recording_incident_when_stream_reports_last() {
        let recording_context = EncoderBridgeDiagnosticsContext {
            role: EncoderBridgeOutputRole::Recording,
            recording_output: Some(EncoderBridgeOutputProfile {
                width: 3840,
                height: 2160,
                fps: 30,
                bitrate_kbps: 30_000,
            }),
            stream_output: Some(EncoderBridgeOutputProfile {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6_000,
            }),
            separate_output_encoders_active: true,
            ..EncoderBridgeDiagnosticsContext::default()
        };
        let recording = merge_encoder_bridge_role_output_pressure(
            &idle_diagnostics(),
            EncoderBridgeRuntimeStats {
                output_queue_high_water_frames: 16,
                output_queue_oldest_frame_age_high_water_ms: Some(528),
                output_last_progress_age_ms: Some(42),
                output_pressure_recovery_events: 1,
                output_pre_encode_skipped_frames: 3,
                video_toolbox_pending_encode_frames: 10,
                video_toolbox_pending_fifo_frames: 6,
                encoded_access_unit_dropped_frames: 0,
                ..Default::default()
            },
            recording_context,
        );
        let mut base = idle_diagnostics();
        base.encoder_bridge_recording_output_pressure = recording.recording;
        base.encoder_bridge_stream_output_pressure = recording.stream;

        let stream = merge_encoder_bridge_role_output_pressure(
            &base,
            EncoderBridgeRuntimeStats {
                output_queue_high_water_frames: 2,
                output_queue_oldest_frame_age_high_water_ms: Some(35),
                output_last_progress_age_ms: Some(7),
                output_pressure_recovery_events: 2,
                output_pre_encode_skipped_frames: 0,
                video_toolbox_pending_encode_frames: 1,
                video_toolbox_pending_fifo_frames: 1,
                encoded_access_unit_dropped_frames: 0,
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext {
                role: EncoderBridgeOutputRole::Stream,
                ..recording_context
            },
        );

        assert_eq!(stream.recording, recording.recording);
        assert_eq!(stream.stream.output_queue_high_water_frames, 2);
        assert_eq!(stream.aggregate.output_queue_high_water_frames, 16);
        assert_eq!(
            stream.aggregate.output_queue_oldest_frame_age_high_water_ms,
            Some(528)
        );
        assert_eq!(stream.aggregate.output_last_progress_age_ms, Some(42));
        assert_eq!(stream.aggregate.output_pressure_recovery_events, 3);
        assert_eq!(stream.aggregate.output_pre_encode_skipped_frames, 3);
        assert_eq!(stream.aggregate.video_toolbox_pending_encode_frames, 11);
        assert_eq!(stream.aggregate.video_toolbox_pending_fifo_frames, 7);
        assert_eq!(stream.aggregate.encoded_access_unit_dropped_frames, 0);
    }

    #[test]
    fn stopped_split_output_clears_current_depth_but_retains_incident_evidence() {
        let inactive = mark_encoder_bridge_output_inactive(EncoderBridgeRuntimeStats {
            queue_depth: 16,
            output_queue_high_water_frames: 16,
            output_queue_oldest_frame_age_ms: Some(528),
            output_queue_oldest_frame_age_high_water_ms: Some(528),
            output_last_progress_age_ms: Some(2_000),
            output_queue_capacity_pressure_events: 9,
            output_pressure_recovery_events: 1,
            output_pre_encode_skipped_frames: 4,
            video_toolbox_pending_encode_frames: 10,
            video_toolbox_pending_fifo_frames: 6,
            encoded_access_unit_dropped_frames: 0,
            ..Default::default()
        });

        assert_eq!(inactive.queue_depth, 0);
        assert_eq!(inactive.output_queue_oldest_frame_age_ms, None);
        assert_eq!(inactive.output_last_progress_age_ms, None);
        assert_eq!(inactive.video_toolbox_pending_encode_frames, 0);
        assert_eq!(inactive.video_toolbox_pending_fifo_frames, 0);
        assert_eq!(inactive.output_queue_high_water_frames, 16);
        assert_eq!(
            inactive.output_queue_oldest_frame_age_high_water_ms,
            Some(528)
        );
        assert_eq!(inactive.output_queue_capacity_pressure_events, 9);
        assert_eq!(inactive.output_pressure_recovery_events, 1);
        assert_eq!(inactive.output_pre_encode_skipped_frames, 4);
        assert_eq!(inactive.encoded_access_unit_dropped_frames, 0);
    }

    #[test]
    fn shared_output_attributes_runtime_to_each_active_role_without_double_counting() {
        let merged = merge_encoder_bridge_role_process_diagnostics(
            &idle_diagnostics(),
            EncoderBridgeRuntimeStats {
                raw_video_copied_frames: 60,
                dropped_frames: 2,
                encoder_speed: Some(0.91),
                ..Default::default()
            },
            EncoderBridgeDiagnosticsContext {
                role: EncoderBridgeOutputRole::Shared,
                recording_output: Some(EncoderBridgeOutputProfile {
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 8_000,
                }),
                stream_output: Some(EncoderBridgeOutputProfile {
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 8_000,
                }),
                ..EncoderBridgeDiagnosticsContext::default()
            },
        );

        assert_eq!(merged.recording_raw_video_copied_frames, 60);
        assert_eq!(merged.stream_raw_video_copied_frames, 60);
        assert_eq!(merged.raw_video_copied_frames, 60);
        assert_eq!(merged.recording_dropped_frames, 2);
        assert_eq!(merged.stream_dropped_frames, 2);
        assert_eq!(merged.dropped_frames, 2);
        assert_eq!(merged.recording_encoder_speed, Some(0.91));
        assert_eq!(merged.stream_encoder_speed, Some(0.91));
        assert_eq!(merged.encoder_speed, Some(0.91));
    }

    #[test]
    fn bounded_fifo_offer_reports_pressure_without_blocking_the_realtime_bridge() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        frame_tx.send(1_u64).expect("fill bounded queue");
        let offered = offer_preserving_output_frame(&frame_tx, 2_u64)
            .expect("bounded FIFO remains connected");
        let PreservingOutputFrameOffer::CapacityPressure(preserved) = offered else {
            panic!("full FIFO must report capacity pressure")
        };
        assert_eq!(preserved, 2);
        assert_eq!(frame_rx.recv().expect("drain oldest frame"), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn full_videotoolbox_fifo_retries_completed_access_unit_without_dropping_it() {
        let frame = |value| VideoToolboxH264AnnexBFrame {
            timing: VideoToolboxFrameTiming::new(value, 30, 1, 30),
            bytes: vec![value as u8; 4],
            nal_types: vec![5],
            is_idr: true,
        };
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        frame_tx
            .send(QueuedVideoToolboxFrame { frame: frame(1) })
            .expect("fill bounded FIFO");
        let (_result_tx, result_rx) = std_mpsc::channel();
        let mut fifo_writer = VideoToolboxFifoWriter {
            frame_tx: Some(frame_tx),
            result_rx,
            join: None,
            lifecycle: None,
        };
        let mut video_toolbox =
            EncoderBridgeVideoToolboxProbe::new(false, 3_840, 2_160, 30, Some(8_000), false);
        video_toolbox
            .output_tx
            .send(VideoToolboxH264AsyncAnnexBFrame {
                frame_index: 2,
                result: Ok(frame(2)),
            })
            .expect("queue completed callback AU");

        let submitted_at = Instant::now();
        let mut pending_output_frames = 1;
        let mut pending_fifo_frames = 1;
        let mut pending_output_started_at = HashMap::from([(2, submitted_at)]);
        let mut pending_fifo_started_at = VecDeque::from([submitted_at]);
        let mut retained_completed_frame = None;
        let mut pressure_events = 0;
        let mut probe_errors = 0;
        let mut enqueue_times_ms = Vec::new();
        let mut max_enqueue_ms = None;

        let first_progress = drain_video_toolbox_output_frames(
            &mut video_toolbox,
            &mut fifo_writer,
            &mut pending_output_frames,
            &mut pending_fifo_frames,
            &mut pending_output_started_at,
            &mut pending_fifo_started_at,
            &mut retained_completed_frame,
            &mut pressure_events,
            &mut probe_errors,
            &mut enqueue_times_ms,
            &mut max_enqueue_ms,
            None,
        )
        .expect("full FIFO is pressure, not loss");

        assert_eq!(first_progress.callback_completions, 1);
        assert!(retained_completed_frame.is_some());
        assert_eq!(pending_output_frames, 1);
        assert_eq!(pending_fifo_frames, 1);
        assert!(pending_output_started_at.contains_key(&2));
        assert_eq!(pressure_events, 1);
        assert_eq!(probe_errors, 0);
        let first = frame_rx.recv().expect("drain first AU");
        assert_eq!(first.frame.bytes, vec![1; 4]);

        let retry_progress = drain_video_toolbox_output_frames(
            &mut video_toolbox,
            &mut fifo_writer,
            &mut pending_output_frames,
            &mut pending_fifo_frames,
            &mut pending_output_started_at,
            &mut pending_fifo_started_at,
            &mut retained_completed_frame,
            &mut pressure_events,
            &mut probe_errors,
            &mut enqueue_times_ms,
            &mut max_enqueue_ms,
            None,
        )
        .expect("retained AU retries after drain");

        assert_eq!(
            retry_progress.callback_completions, 0,
            "retrying a retained AU must not double-count encoder progress",
        );
        assert!(retained_completed_frame.is_none());
        assert_eq!(pending_output_frames, 0);
        assert_eq!(pending_fifo_frames, 2);
        assert!(!pending_output_started_at.contains_key(&2));
        assert_eq!(pressure_events, 1);
        assert_eq!(probe_errors, 0);
        let second = frame_rx.recv().expect("receive preserved second AU");
        assert_eq!(second.frame.bytes, vec![2; 4]);
    }

    #[test]
    fn busy_raw_fifo_replaces_the_pending_frame_with_the_latest_tick() {
        let mailbox = LatestRawVideoFrameMailbox::default();
        assert!(matches!(
            mailbox.offer(QueuedRawVideoFrame::synthetic(vec![1])),
            Ok(LatestRawVideoFrameOffer::Enqueued)
        ));
        let replaced = mailbox
            .offer(QueuedRawVideoFrame::synthetic(vec![2]))
            .unwrap_or_else(|_| panic!("latest frame mailbox remains open"));
        let LatestRawVideoFrameOffer::Replaced(frame) = replaced else {
            panic!("second tick must replace the pending first tick")
        };
        assert_eq!(frame.into_synthetic_buffer(), Some(vec![1]));
        assert_eq!(
            mailbox
                .receive()
                .and_then(QueuedRawVideoFrame::into_synthetic_buffer),
            Some(vec![2])
        );
    }

    #[test]
    fn raw_bridge_cadence_counts_only_frames_delivered_to_ffmpeg() {
        assert_eq!(
            encoder_bridge_input_frame_count(EncoderBridgeVideoOutput::RawYuv420p, 30, 11),
            11
        );
        assert_eq!(
            encoder_bridge_input_frame_count(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                30,
                11,
            ),
            30
        );
    }

    #[test]
    fn recording_session_exposes_the_first_terminal_bridge_failure() {
        let terminal_failure = Arc::new(StdMutex::new(None));
        let session = EncoderBridgeRecordingSession {
            stop: Arc::new(AtomicBool::new(false)),
            terminal_failure: terminal_failure.clone(),
            startup_ready: None,
            fifo_path: std::env::temp_dir().join(format!(
                "videorc-missing-terminal-signal-test-{}",
                Uuid::new_v4()
            )),
            writer: None,
            diagnostics_task: None,
            lifecycle: None,
            #[cfg(target_os = "windows")]
            d3d11_input: None,
        };

        assert_eq!(session.terminal_failure(), None);
        record_encoder_bridge_terminal_failure(&terminal_failure, "raw FIFO timed out");
        record_encoder_bridge_terminal_failure(&terminal_failure, "later secondary error");

        assert_eq!(
            session.terminal_failure().as_deref(),
            Some("raw FIFO timed out")
        );
    }

    #[test]
    fn raw_fifo_writer_returns_the_owned_buffer_after_an_ordered_write() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(2);
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        let sink = SharedCountingSink::default();
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(vec![1, 2, 3, 4]))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            sink.clone(),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(sink.bytes(), vec![1, 2, 3, 4]);
        let result = result_rx.recv().expect("raw writer result");
        let RawVideoFifoWriterResult::FrameWritten {
            synthetic_buffer, ..
        } = result
        else {
            panic!("raw frame must be reported as written")
        };
        assert_eq!(synthetic_buffer, Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn raw_fifo_writer_reads_and_releases_the_shared_compositor_allocation() {
        let width = 8;
        let height = 8;
        let expected = vec![0x5a; raw_yuv420p_len(width, height).unwrap()];
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            1,
        )));
        let published = publish_test_compositor_frame(&frame_store, 1, width, height, &expected);
        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("shared compositor frame");
        assert!(CompositorFrameHandle::ptr_eq(&published, &fed.frame));

        let queued = QueuedRawVideoFrame::compositor(&fed);
        assert_eq!(queued.bytes().as_ptr(), published.bytes.as_ptr());
        let retained_before_write = published.strong_count();
        drop(fed);

        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let sink = SharedCountingSink::default();
        frame_tx.send(queued).expect("queue shared raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            sink.clone(),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(sink.bytes(), expected);
        let result = result_rx.recv().expect("raw writer result");
        let RawVideoFifoWriterResult::FrameWritten {
            synthetic_buffer, ..
        } = result
        else {
            panic!("shared raw frame must be reported as written")
        };
        assert!(synthetic_buffer.is_none());
        assert_eq!(published.strong_count(), retained_before_write - 2);
    }

    #[test]
    fn slow_raw_writer_consumes_pending_latest_frames_without_waiting_for_another_tick() {
        let mailbox = Arc::new(LatestRawVideoFrameMailbox::default());
        let writer_mailbox = mailbox.clone();
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        let (first_write_started_tx, first_write_started_rx) = std_mpsc::sync_channel(1);
        let (release_first_write_tx, release_first_write_rx) = std_mpsc::sync_channel(1);
        let sink = SharedCountingSink::default();
        let writer_sink = sink.clone();
        let writer = thread::spawn(move || {
            run_raw_video_fifo_writer_loop_with_receiver(
                GatedFirstWriteSink {
                    written: writer_sink,
                    first_write_started: Some(first_write_started_tx),
                    release_first_write: release_first_write_rx,
                },
                || writer_mailbox.receive(),
                result_tx,
                Arc::new(AtomicBool::new(false)),
                Arc::new(StdMutex::new(None)),
                EncoderBridgeOutputRole::Recording,
            );
        });

        assert!(matches!(
            mailbox
                .offer(QueuedRawVideoFrame::synthetic(vec![0]))
                .unwrap_or_else(|_| panic!("raw mailbox remains open")),
            LatestRawVideoFrameOffer::Enqueued
        ));
        first_write_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer starts the first frame");
        assert!(matches!(
            mailbox
                .offer(QueuedRawVideoFrame::synthetic(vec![1]))
                .unwrap_or_else(|_| panic!("raw mailbox remains open")),
            LatestRawVideoFrameOffer::Enqueued
        ));
        let replacement = mailbox
            .offer(QueuedRawVideoFrame::synthetic(vec![2]))
            .unwrap_or_else(|_| panic!("raw mailbox remains open"));
        let LatestRawVideoFrameOffer::Replaced(replaced) = replacement else {
            panic!("latest tick must replace the pending frame while the writer is blocked")
        };
        assert_eq!(replaced.into_synthetic_buffer(), Some(vec![1]));
        mailbox.close();
        release_first_write_tx
            .send(())
            .expect("release the first frame write");
        writer.join().expect("slow raw writer joins");

        let delivered = result_rx
            .try_iter()
            .filter(|result| matches!(result, RawVideoFifoWriterResult::FrameWritten { .. }))
            .count();
        assert_eq!(delivered, 2);
        assert_eq!(sink.bytes(), vec![0, 2]);
    }

    #[test]
    fn synthetic_buffer_recycling_retains_at_most_one_spare() {
        let mut recycled = None;
        retain_recycled_synthetic_buffer(&mut recycled, Some(vec![1; 4]));
        retain_recycled_synthetic_buffer(&mut recycled, Some(vec![2; 8]));

        assert_eq!(recycled.as_deref(), Some([1, 1, 1, 1].as_slice()));
        let reused = take_recycled_synthetic_buffer(&mut recycled, 6);
        assert_eq!(reused.len(), 6);
        assert!(recycled.is_none());
    }

    #[test]
    fn raw_fifo_writer_writes_a_frame_older_than_any_queue_age_budget() {
        // Issue #149: the deadline was anchored at SUBMIT time with the
        // recording queue's 250ms age budget, so a latest-wins frame that
        // waited out a Media Foundation pause was declared dead before its
        // first byte. Recording semantics: late frames are written, not
        // dropped — QueuedRawVideoFrame now carries no timestamp at all, so
        // the writer cannot even observe how long a frame waited; only a
        // truly stalled pipe (zero byte progress for the platform stall
        // tolerance) is fatal.
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        let stale = QueuedRawVideoFrame::synthetic(vec![7; 32]);
        let mut frames = vec![stale].into_iter();
        let mut sink: Vec<u8> = Vec::new();
        run_raw_video_fifo_writer_loop_with_receiver(
            &mut sink,
            || frames.next(),
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );
        assert_eq!(sink, vec![7; 32], "the stale frame must still be written");
        assert!(matches!(
            result_rx.try_recv(),
            Ok(RawVideoFifoWriterResult::FrameWritten { .. })
        ));
    }

    #[test]
    fn raw_fifo_write_stall_tolerance_is_a_platform_contract_not_the_queue_age() {
        // The sliding no-progress window must come from the platform contract
        // (Media Foundation pauses for seconds on Windows), never from the
        // 250ms recording queue budget that killed real recordings in #149.
        assert!(RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE > RECORDING_OUTPUT_QUEUE_MAX_AGE);
        assert!(RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE <= RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT);
        #[cfg(target_os = "windows")]
        assert_eq!(
            RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE,
            Duration::from_secs(10)
        );
    }

    #[test]
    fn raw_fifo_writer_uses_a_windows_safe_complete_frame_timeout() {
        #[cfg(target_os = "windows")]
        assert_eq!(
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            Duration::from_secs(30)
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            RAW_VIDEO_FIFO_FRAME_WRITE_HARD_TIMEOUT,
            FIFO_FRAME_WRITE_HARD_TIMEOUT
        );
    }

    #[test]
    fn raw_fifo_writer_finishes_an_inflight_frame_when_stop_arrives_mid_write() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let stop = Arc::new(AtomicBool::new(false));
        let written = SharedCountingSink::default();
        let frame = vec![1, 2, 3, 4, 5, 6, 7, 8];
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(frame.clone()))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            StopAfterPartialWriteSink {
                written: written.clone(),
                stop: stop.clone(),
                first_write: true,
            },
            frame_rx,
            result_tx,
            stop,
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(written.bytes(), frame);
        let result = result_rx.recv().expect("raw writer result");
        assert!(matches!(
            result,
            RawVideoFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[test]
    fn raw_fifo_writer_finishes_a_frame_while_the_reader_keeps_making_progress() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let written = SharedCountingSink::default();
        let frame = vec![1, 2, 3, 4, 5, 6, 7, 8];
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(frame.clone()))
            .expect("queue raw frame");
        drop(frame_tx);

        run_raw_video_fifo_writer_loop(
            SlowProgressSink {
                written: written.clone(),
                chunk_size: 2,
                delay: Duration::from_millis(12),
            },
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(StdMutex::new(None)),
            EncoderBridgeOutputRole::Recording,
        );

        assert_eq!(written.bytes(), frame);
        let result = result_rx.recv().expect("raw writer result");
        assert!(matches!(
            result,
            RawVideoFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[test]
    fn intermittent_pipe_pressure_does_not_throttle_a_full_hd_raw_frame() {
        for pressure in [PipePressure::WouldBlock, PipePressure::ZeroWrite] {
            let mut sink = AlternatingBackpressureSink {
                written: 0,
                chunk_size: 8 * 1024,
                pressure_next: true,
                pressure,
            };
            let stop = AtomicBool::new(false);
            let bytes = vec![7; raw_yuv420p_len(1920, 1080).expect("1080p frame size")];
            let deadline = Instant::now() + Duration::from_millis(500);

            write_all_until(
                &mut sink,
                &bytes,
                &stop,
                deadline,
                Duration::from_millis(500),
                Duration::from_millis(500),
                false,
            )
            .expect("active FIFO draining must not pay a millisecond sleep per pipe-sized chunk");

            assert_eq!(sink.written, bytes.len());
        }
    }

    #[test]
    fn progressing_fifo_write_still_honors_a_complete_frame_hard_limit() {
        let written = SharedCountingSink::default();
        let mut sink = SlowProgressSink {
            written: written.clone(),
            chunk_size: 1,
            delay: Duration::from_millis(10),
        };
        let stop = AtomicBool::new(false);
        let bytes = vec![7; 100];
        let started_at = Instant::now();

        let error = write_all_until(
            &mut sink,
            &bytes,
            &stop,
            Instant::now() + Duration::from_millis(20),
            Duration::from_millis(20),
            Duration::from_millis(55),
            false,
        )
        .expect_err("continuous one-byte progress must not keep shutdown blocked forever");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started_at.elapsed() < Duration::from_millis(250));
        assert!(written.bytes().len() < bytes.len());
    }

    #[test]
    fn stalled_raw_fifo_writer_times_out_without_blocking_the_scheduler() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        frame_tx
            .send(QueuedRawVideoFrame::synthetic(vec![0x44; 64]))
            .expect("queue raw frame");
        drop(frame_tx);

        let started_at = Instant::now();
        let terminal_failure = Arc::new(StdMutex::new(None));
        run_raw_video_fifo_writer_loop(
            AlwaysWouldBlockSink,
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            terminal_failure.clone(),
            EncoderBridgeOutputRole::Recording,
        );

        // A wedged pipe fails within the PLATFORM stall tolerance (#149: no
        // longer the 250ms queue budget) plus scheduling slack.
        assert!(
            started_at.elapsed() < RAW_VIDEO_FIFO_WRITE_STALL_TOLERANCE + Duration::from_secs(1)
        );
        let result = result_rx.recv().expect("terminal raw writer result");
        let RawVideoFifoWriterResult::Error { message, .. } = result else {
            panic!("stalled raw writer must fail explicitly")
        };
        assert!(message.contains("complete-frame delivery budget"));
        assert_eq!(
            read_encoder_bridge_terminal_failure(&terminal_failure).as_deref(),
            Some(message.as_str())
        );
    }

    // Plan 023 L4: the recording-degraded watch fires exactly once per session
    // after the low-fps condition holds for the full 5s window.
    #[test]
    fn recording_fps_watch_fires_once_after_sustained_low_fps() {
        use super::{RecordingFpsWatch, recording_fps_watch_update};
        let mut watch = RecordingFpsWatch::default();
        // Healthy: 30 target, 29 input — never fires.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(29.0),
            30,
            0
        ));
        // Low but not yet sustained.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            1_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            4_000
        ));
        // Recovery resets the window.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(28.0),
            30,
            5_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            6_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            10_000
        ));
        // Sustained past the hold window: fire once…
        assert!(recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(9.0),
            30,
            11_100
        ));
        // …and never again for the same session.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s1",
            Some(2.0),
            30,
            30_000
        ));
        // A NEW session re-arms.
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s2",
            Some(9.0),
            30,
            40_000
        ));
        assert!(recording_fps_watch_update(
            &mut watch,
            "s2",
            Some(9.0),
            30,
            45_100
        ));
        // Missing fps samples and zero targets never fire.
        assert!(!recording_fps_watch_update(
            &mut watch, "s3", None, 30, 50_000
        ));
        assert!(!recording_fps_watch_update(
            &mut watch,
            "s3",
            Some(1.0),
            0,
            55_100
        ));
    }

    #[test]
    fn recording_queue_drop_watch_surfaces_each_affected_session_once() {
        let mut watch = RecordingQueueDropWatch::default();
        assert!(!recording_queue_drop_watch_update(&mut watch, "s1", 0));
        assert!(recording_queue_drop_watch_update(&mut watch, "s1", 1));
        assert!(!recording_queue_drop_watch_update(&mut watch, "s1", 9));
        assert!(!recording_queue_drop_watch_update(&mut watch, "s2", 0));
        assert!(recording_queue_drop_watch_update(&mut watch, "s2", 2));
    }

    use crate::compositor::{CompositorFrameExportHandle, CompositorPixelFormat};
    #[cfg(target_os = "macos")]
    use crate::metal_compositor::{GpuSource, GpuSourceKind, MetalSceneCompositor};

    #[test]
    fn video_toolbox_probe_env_is_opt_in() {
        assert!(!parse_video_toolbox_probe_enabled(None));
        assert!(!parse_video_toolbox_probe_enabled(Some("")));
        assert!(!parse_video_toolbox_probe_enabled(Some("0")));
        assert!(!parse_video_toolbox_probe_enabled(Some("false")));
        assert!(parse_video_toolbox_probe_enabled(Some("1")));
        assert!(parse_video_toolbox_probe_enabled(Some("true")));
        assert!(parse_video_toolbox_probe_enabled(Some(" yes ")));
        assert!(parse_video_toolbox_probe_enabled(Some("ON")));
    }

    #[test]
    fn bridge_frame_with_no_compositor_frame_is_synthetic_fallback() {
        assert_eq!(
            classify_bridge_frame(Some(4), None),
            BridgeFrameSource::SyntheticFallback
        );
        assert_eq!(
            classify_bridge_frame(None, None),
            BridgeFrameSource::SyntheticFallback
        );
    }

    #[test]
    fn bridge_frame_with_unchanged_sequence_is_a_repeat() {
        assert_eq!(
            classify_bridge_frame(Some(7), Some(7)),
            BridgeFrameSource::Repeated
        );
    }

    #[test]
    fn bridge_frame_with_advancing_or_first_sequence_is_fresh() {
        assert_eq!(
            classify_bridge_frame(Some(7), Some(8)),
            BridgeFrameSource::Fresh
        );
        assert_eq!(
            classify_bridge_frame(None, Some(1)),
            BridgeFrameSource::Fresh
        );
    }

    #[test]
    fn videotoolbox_bridge_keeps_bounded_fresh_frame_grace() {
        let frame_interval = Duration::from_millis(33);
        let normal_grace = videotoolbox_fresh_frame_grace(frame_interval);

        assert_eq!(normal_grace, Duration::from_millis(29));
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                0,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                0,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                1,
                frame_interval
            ),
            normal_grace
        );
        assert_eq!(
            compositor_frame_wait_budget(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                1,
                frame_interval
            ),
            normal_grace
        );
    }

    #[test]
    fn raw_bridge_keeps_fresh_frame_wait_budget() {
        let frame_interval = Duration::from_millis(33);

        assert_eq!(
            compositor_frame_wait_budget(EncoderBridgeVideoOutput::RawYuv420p, 0, frame_interval),
            frame_interval
        );
        assert_eq!(
            compositor_frame_wait_budget(EncoderBridgeVideoOutput::RawYuv420p, 1, frame_interval),
            frame_interval + frame_interval
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_config_maps_4k30_recording_profile_to_realtime_h264_settings() {
        let config = VideoToolboxBridgeEncoderConfig::from_recording_profile(
            3840,
            2160,
            30,
            Some(30_000),
            false,
        );

        assert_eq!(config.width, 3840);
        assert_eq!(config.height, 2160);
        assert_eq!(config.expected_frame_rate, 30);
        assert_eq!(config.max_key_frame_interval, 60);
        assert_eq!(config.average_bit_rate_bps, Some(30_000_000));
        // Record-only 4K encodes for quality, not for a live leg's deadline.
        assert!(!config.low_latency);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_config_maps_4k60_recording_profile_to_two_second_keyframes() {
        let config = VideoToolboxBridgeEncoderConfig::from_recording_profile(
            3840,
            2160,
            60,
            Some(50_000),
            true,
        );

        assert_eq!(config.expected_frame_rate, 60);
        assert_eq!(config.max_key_frame_interval, 120);
        assert_eq!(config.average_bit_rate_bps, Some(50_000_000));
        assert!(config.low_latency);
    }

    #[test]
    fn first_bridge_tick_consumes_ready_compositor_frame() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![42; raw_yuv420p_len(width, height).unwrap()];
        let captured_at = Instant::now()
            .checked_sub(Duration::from_millis(80))
            .unwrap_or_else(Instant::now);
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish(
                11,
                width,
                height,
                CompositorPixelFormat::yuv420p_cpu_buffer(),
                captured_at,
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(CompositorFrameHandle::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 11);
        assert_eq!(fed.captured_at, captured_at);
        assert!(fed.age_ms >= 80);
        assert!(!fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(
            classify_bridge_frame(None, Some(fed.sequence)),
            BridgeFrameSource::Fresh
        );
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn copied_compositor_frame_reports_metal_target_candidate() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![84; raw_yuv420p_len(width, height).unwrap()];
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish(
                12,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                Instant::now(),
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(CompositorFrameHandle::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 12);
        assert!(fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn next_compositor_frame_reports_metadata_without_yuv_copy_buffer() {
        let width = 64;
        let height = 36;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        {
            let mut store = frame_store.lock().unwrap();
            let buffer = store.checkout_buffer(raw_yuv420p_len(width, height).unwrap());
            store.publish(
                14,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                Instant::now(),
                buffer,
            );
        }

        let fed = next_compositor_frame(Some(&frame_store), None, Duration::ZERO)
            .expect("ready compositor frame");

        assert_eq!(fed.sequence, 14);
        assert!(fed.has_metal_iosurface_target);
        assert!(!fed.has_metal_export_handle);
        assert_eq!(
            fed.frame.bytes.len(),
            raw_yuv420p_len(width, height).unwrap()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copied_compositor_frame_retains_metal_target_handle_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let width = 64;
        let height = 64;
        let sources = [GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &[0, 64, 255, 255],
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
            chroma_key: None,
        }];
        compositor
            .compose_bgra(
                width as usize,
                height as usize,
                [0.0, 0.0, 0.0, 1.0],
                &sources,
            )
            .expect("compose retained Metal target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed Metal target unavailable");
            return;
        };
        if !target.has_iosurface() {
            eprintln!("skipping: retained Metal target is not IOSurface-backed");
            return;
        }

        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![21; raw_yuv420p_len(width, height).unwrap()];
        let published = {
            let mut store = frame_store.lock().unwrap();
            let mut buffer = store.checkout_buffer(expected.len());
            buffer.copy_from_slice(&expected);
            store.publish_with_metadata(
                13,
                width,
                height,
                CompositorPixelFormat::yuv420p_with_metal_iosurface_target(width, height),
                CompositorFrameExportHandle::metal_target(target),
                Instant::now(),
                buffer,
            )
        };

        let fed =
            next_raw_compositor_frame(Some(&frame_store), None, Duration::ZERO, expected.len())
                .expect("ready compositor frame");

        assert!(CompositorFrameHandle::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.sequence, 13);
        assert!(fed.has_metal_iosurface_target);
        assert!(fed.has_metal_export_handle);
        assert!(fed.metal_target.is_some());
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn bridge_waits_for_fresh_compositor_sequence_before_repeating() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let first = vec![1; raw_yuv420p_len(width, height).unwrap()];
        let second = vec![2; first.len()];
        let _first = publish_test_compositor_frame(&frame_store, 11, width, height, &first);

        let publisher = {
            let frame_store = Arc::clone(&frame_store);
            let second = second.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(5));
                let _ = publish_test_compositor_frame(&frame_store, 12, width, height, &second);
            })
        };

        let fed = next_raw_compositor_frame(
            Some(&frame_store),
            Some(11),
            Duration::from_millis(50),
            first.len(),
        )
        .expect("fresh compositor frame");
        publisher.join().expect("publisher");
        let latest = frame_store.lock().unwrap().latest().expect("latest frame");

        assert_eq!(fed.sequence, 12);
        assert!(CompositorFrameHandle::ptr_eq(&fed.frame, &latest));
        assert_eq!(fed.frame.bytes, second);
    }

    #[test]
    fn bridge_reuses_latest_compositor_sequence_after_wait_budget() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let expected = vec![3; raw_yuv420p_len(width, height).unwrap()];
        let published = publish_test_compositor_frame(&frame_store, 11, width, height, &expected);

        let fed = next_raw_compositor_frame(
            Some(&frame_store),
            Some(11),
            Duration::from_millis(1),
            expected.len(),
        )
        .expect("latest compositor frame");

        assert_eq!(fed.sequence, 11);
        assert!(CompositorFrameHandle::ptr_eq(&fed.frame, &published));
        assert_eq!(fed.frame.bytes, expected);
    }

    #[test]
    fn videotoolbox_bridge_waits_bounded_for_fresh_compositor_sequence() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            21,
            width,
            height,
            &vec![5; raw_yuv420p_len(width, height).unwrap()],
        );

        let publisher = {
            let frame_store = Arc::clone(&frame_store);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(5));
                let _ = publish_test_compositor_frame(
                    &frame_store,
                    22,
                    width,
                    height,
                    &vec![6; raw_yuv420p_len(width, height).unwrap()],
                );
            })
        };
        let fed = next_compositor_frame(Some(&frame_store), Some(21), Duration::from_millis(50))
            .expect("fresh compositor frame");
        publisher.join().expect("publisher");

        assert_eq!(fed.sequence, 22);
    }

    #[test]
    fn videotoolbox_bridge_reuses_latest_compositor_sequence_after_wait_budget() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            21,
            width,
            height,
            &vec![5; raw_yuv420p_len(width, height).unwrap()],
        );

        let fed = next_compositor_frame(Some(&frame_store), Some(21), Duration::from_millis(1))
            .expect("latest compositor frame");

        assert_eq!(fed.sequence, 21);
        assert_eq!(
            classify_bridge_frame(Some(21), Some(fed.sequence)),
            BridgeFrameSource::Repeated
        );
    }

    #[test]
    fn encoded_bridge_consumes_startup_validated_frame_without_waiting() {
        let width = 8;
        let height = 8;
        let frame_store = Arc::new(std::sync::Mutex::new(crate::frame_store::FrameStore::new(
            2,
        )));
        let _ = publish_test_compositor_frame(
            &frame_store,
            31,
            width,
            height,
            &vec![7; raw_yuv420p_len(width, height).unwrap()],
        );

        assert_eq!(
            initial_bridge_wait_sequence(EncoderBridgeVideoOutput::RawYuv420p, Some(&frame_store)),
            Some(31)
        );
        assert_eq!(
            initial_bridge_wait_sequence(
                EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
                Some(&frame_store)
            ),
            None
        );
        assert_eq!(
            initial_bridge_wait_sequence(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
                Some(&frame_store)
            ),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mpeg_ts_pipe_writer_coalesces_access_unit_to_single_fifo_write() {
        let mut pipe_writer = VideoToolboxH264PipeWriter::for_output(
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        );
        let frame = VideoToolboxH264AnnexBFrame {
            timing: VideoToolboxFrameTiming::new(1, 30, 1, 30),
            bytes: vec![0x55; 600],
            nal_types: vec![5],
            is_idr: true,
        };
        let mut sink = CountingSink::default();

        pipe_writer
            .write_frame(&mut sink, &frame)
            .expect("write MPEG-TS frame");

        assert_eq!(sink.write_calls, 1);
        assert_eq!(sink.bytes.len() % 188, 0);
        assert!(sink.bytes.len() > frame.bytes.len());
        assert_eq!(sink.bytes[0], 0x47);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mpeg_ts_pipe_writer_preserves_intentional_pre_encode_pts_gaps() {
        let mut pipe_writer = VideoToolboxH264PipeWriter::for_output(
            EncoderBridgeVideoOutput::VideoToolboxH264MpegTs,
        );
        let mut sink = CountingSink::default();
        for frame_index in [0, 3] {
            pipe_writer
                .write_frame(
                    &mut sink,
                    &VideoToolboxH264AnnexBFrame {
                        timing: VideoToolboxFrameTiming::new(frame_index, 30, 1, 30),
                        bytes: vec![0x55; 64],
                        nal_types: vec![1],
                        is_idr: false,
                    },
                )
                .expect("write MPEG-TS frame");
        }

        let pts = sink
            .bytes
            .chunks_exact(188)
            .filter(|packet| {
                let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
                pid == 0x0101 && packet[1] & 0x40 != 0
            })
            .filter_map(|packet| {
                let payload = match (packet[3] >> 4) & 0x03 {
                    1 => &packet[4..],
                    3 => &packet[5 + usize::from(packet[4])..],
                    _ => return None,
                };
                (payload.len() >= 14 && payload.starts_with(&[0x00, 0x00, 0x01, 0xe0]))
                    .then(|| decode_test_pts(&payload[9..14]))
            })
            .collect::<Vec<_>>();

        // Stream coalescing advances the bridge tick/VideoToolbox timing while
        // skipping only the pre-encode submission. MPEG-TS therefore carries a
        // wall-true 100ms gap instead of compressing three ticks into one.
        assert_eq!(pts, vec![0, 9_000]);
    }

    #[cfg(target_os = "macos")]
    fn decode_test_pts(bytes: &[u8]) -> u64 {
        (u64::from((bytes[0] >> 1) & 0x07) << 30)
            | (u64::from(bytes[1]) << 22)
            | (u64::from((bytes[2] >> 1) & 0x7f) << 15)
            | (u64::from(bytes[3]) << 7)
            | u64::from((bytes[4] >> 1) & 0x7f)
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn videotoolbox_fifo_test_pause_is_disabled_for_missing_or_invalid_configuration() {
        for (after_frames, pause_ms) in [
            (None, None),
            (Some("60"), None),
            (None, Some("350")),
            (Some(""), Some("350")),
            (Some("sixty"), Some("350")),
            (Some("60"), Some("")),
            (Some("60"), Some("0")),
            (Some("60"), Some("-1")),
        ] {
            assert!(
                parse_video_toolbox_fifo_test_pause(
                    EncoderBridgeOutputRole::Recording,
                    after_frames,
                    pause_ms,
                )
                .is_none(),
                "invalid pause configuration must remain disabled"
            );
        }
        assert!(
            parse_video_toolbox_fifo_test_pause(
                EncoderBridgeOutputRole::Stream,
                Some("60"),
                Some("350"),
            )
            .is_none(),
            "the recording-pressure hook must never pause the stream-only writer"
        );
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn videotoolbox_fifo_test_pause_parses_recording_and_shared_configuration() {
        for role in [
            EncoderBridgeOutputRole::Recording,
            EncoderBridgeOutputRole::Shared,
        ] {
            let pause = parse_video_toolbox_fifo_test_pause(role, Some(" 60 "), Some(" 350 "))
                .expect("valid recording pressure hook");
            assert_eq!(pause.after_frames, 60);
            assert_eq!(pause.duration, Duration::from_millis(350));
        }
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn videotoolbox_fifo_test_pause_fires_once_before_the_selected_access_unit() {
        let mut pause = parse_video_toolbox_fifo_test_pause(
            EncoderBridgeOutputRole::Recording,
            Some("2"),
            Some("350"),
        )
        .expect("valid recording pressure hook");

        assert_eq!(pause.take_before_write(0), None);
        assert_eq!(pause.take_before_write(1), None);
        assert_eq!(pause.take_before_write(2), Some(Duration::from_millis(350)));
        assert_eq!(pause.take_before_write(2), None);
        assert_eq!(pause.take_before_write(3), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_reports_written_frames() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(2);
        let (result_tx, result_rx) = std_mpsc::sync_channel(4);
        for frame_index in 0..2 {
            frame_tx
                .send(QueuedVideoToolboxFrame {
                    frame: VideoToolboxH264AnnexBFrame {
                        timing: VideoToolboxFrameTiming::new(frame_index, 30, 1, 30),
                        bytes: vec![0x44; 64],
                        nal_types: vec![1],
                        is_idr: false,
                    },
                })
                .expect("queue frame");
        }
        drop(frame_tx);

        run_video_toolbox_fifo_writer_loop(
            CountingSink::default(),
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(250),
            None,
        );

        let results = result_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        for result in results {
            match result {
                VideoToolboxFifoWriterResult::FrameWritten {
                    encoded_bytes,
                    write_ms,
                } => {
                    assert_eq!(encoded_bytes, 64);
                    assert!(write_ms >= 0.0);
                }
                VideoToolboxFifoWriterResult::Error { message, .. } => {
                    panic!("unexpected FIFO writer error: {message}");
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_writes_an_access_unit_older_than_the_queue_age_budget() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let bytes = vec![0x44; 64];
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: bytes.clone(),
                    nal_types: vec![1],
                    is_idr: false,
                },
            })
            .expect("queue frame");
        drop(frame_tx);
        // Model an access unit that has already waited behind transient
        // encoder/FIFO pressure for longer than the queue-health budget.
        thread::sleep(RECORDING_OUTPUT_QUEUE_MAX_AGE + Duration::from_millis(50));
        let sink = SharedCountingSink::default();

        run_video_toolbox_fifo_writer_loop(
            sink.clone(),
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            RECORDING_OUTPUT_QUEUE_MAX_AGE,
            None,
        );

        assert_eq!(
            sink.bytes(),
            bytes,
            "a late recording access unit must still be written completely"
        );
        assert!(matches!(
            result_rx.recv().expect("written frame result"),
            VideoToolboxFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_write_stall_tolerance_is_not_the_queue_age_budget() {
        assert!(
            VIDEOTOOLBOX_FIFO_WRITE_STALL_TOLERANCE > RECORDING_OUTPUT_QUEUE_MAX_AGE,
            "queue pressure must not become a FIFO liveness verdict"
        );
        assert_eq!(
            VIDEOTOOLBOX_FIFO_WRITE_STALL_TOLERANCE,
            FIFO_FRAME_WRITE_HARD_TIMEOUT
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_finishes_in_flight_access_unit_after_stop() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let bytes = vec![0x44; 64];
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: bytes.clone(),
                    nal_types: vec![1],
                    is_idr: false,
                },
            })
            .expect("queue frame");
        drop(frame_tx);
        let stop = Arc::new(AtomicBool::new(true));
        let sink = SharedCountingSink::default();

        run_video_toolbox_fifo_writer_loop(
            sink.clone(),
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            stop,
            Duration::from_millis(250),
            None,
        );

        assert_eq!(sink.bytes(), bytes);
        assert!(matches!(
            result_rx.recv().expect("written frame result"),
            VideoToolboxFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stalled_videotoolbox_fifo_writer_times_out_and_joins_without_detaching() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: vec![0x44; 64],
                    nal_types: vec![1],
                    is_idr: false,
                },
            })
            .expect("queue frame");
        drop(frame_tx);

        let started_at = Instant::now();
        run_video_toolbox_fifo_writer_loop(
            AlwaysWouldBlockSink,
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(20),
            None,
        );

        assert!(started_at.elapsed() < Duration::from_millis(500));
        let result = result_rx.recv().expect("terminal writer result");
        let VideoToolboxFifoWriterResult::Error {
            message,
            downstream_closed,
        } = result
        else {
            panic!("stalled writer must fail explicitly")
        };
        assert!(message.contains("complete-frame delivery budget"));
        // A timeout is a REAL failure, not a closed downstream — it must
        // still reach the terminal-failure funnel.
        assert!(!downstream_closed);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_finishes_an_access_unit_while_the_sink_makes_progress() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        let bytes = vec![0x44; 8];
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: bytes.clone(),
                    nal_types: vec![1],
                    is_idr: false,
                },
            })
            .expect("queue frame");
        drop(frame_tx);
        let written = SharedCountingSink::default();

        run_video_toolbox_fifo_writer_loop(
            SlowProgressSink {
                written: written.clone(),
                chunk_size: 2,
                delay: Duration::from_millis(10),
            },
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(25),
            None,
        );

        assert_eq!(written.bytes(), bytes);
        assert!(matches!(
            result_rx.recv().expect("written frame result"),
            VideoToolboxFifoWriterResult::FrameWritten { .. }
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_fifo_writer_classifies_a_closed_downstream() {
        let (frame_tx, frame_rx) = std_mpsc::sync_channel(1);
        let (result_tx, result_rx) = std_mpsc::sync_channel(3);
        frame_tx
            .send(QueuedVideoToolboxFrame {
                frame: VideoToolboxH264AnnexBFrame {
                    timing: VideoToolboxFrameTiming::new(0, 30, 1, 30),
                    bytes: vec![0x44; 64],
                    nal_types: vec![1],
                    is_idr: false,
                },
            })
            .expect("queue frame");
        drop(frame_tx);

        struct BrokenPipeSink;
        impl StdWrite for BrokenPipeSink {
            fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "EPIPE"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        run_video_toolbox_fifo_writer_loop(
            BrokenPipeSink,
            VideoToolboxH264PipeWriter::for_output(
                EncoderBridgeVideoOutput::VideoToolboxH264AnnexB,
            ),
            frame_rx,
            result_tx,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(250),
            None,
        );

        let result = result_rx.recv().expect("terminal writer result");
        let VideoToolboxFifoWriterResult::Error {
            downstream_closed, ..
        } = result
        else {
            panic!("EPIPE must surface as a writer error")
        };
        // FFmpeg going away is the process exit's story, not a bridge verdict.
        assert!(downstream_closed);
    }

    struct AlwaysWouldBlockSink;

    impl StdWrite for AlwaysWouldBlockSink {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::WouldBlock))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct SharedCountingSink(Arc<std::sync::Mutex<Vec<u8>>>);

    impl SharedCountingSink {
        fn bytes(&self) -> Vec<u8> {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    impl StdWrite for SharedCountingSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct GatedFirstWriteSink {
        written: SharedCountingSink,
        first_write_started: Option<std_mpsc::SyncSender<()>>,
        release_first_write: std_mpsc::Receiver<()>,
    }

    impl StdWrite for GatedFirstWriteSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.first_write_started.take() {
                started
                    .send(())
                    .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test gate closed"))?;
                self.release_first_write
                    .recv_timeout(Duration::from_secs(1))
                    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "test gate timed out"))?;
            }
            self.written.write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct StopAfterPartialWriteSink {
        written: SharedCountingSink,
        stop: Arc<AtomicBool>,
        first_write: bool,
    }

    struct SlowProgressSink {
        written: SharedCountingSink,
        chunk_size: usize,
        delay: Duration,
    }

    #[derive(Clone, Copy)]
    enum PipePressure {
        WouldBlock,
        ZeroWrite,
    }

    struct AlternatingBackpressureSink {
        written: usize,
        chunk_size: usize,
        pressure_next: bool,
        pressure: PipePressure,
    }

    impl StdWrite for AlternatingBackpressureSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.pressure_next {
                self.pressure_next = false;
                return match self.pressure {
                    PipePressure::WouldBlock => Err(io::Error::from(io::ErrorKind::WouldBlock)),
                    PipePressure::ZeroWrite => Ok(0),
                };
            }
            self.pressure_next = true;
            let written = bytes.len().min(self.chunk_size);
            self.written += written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl StdWrite for SlowProgressSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            thread::sleep(self.delay);
            let written = bytes.len().min(self.chunk_size);
            self.written
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(&bytes[..written]);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl StdWrite for StopAfterPartialWriteSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let written = if self.first_write {
                bytes.len().div_ceil(2)
            } else {
                bytes.len()
            };
            self.written
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .extend_from_slice(&bytes[..written]);
            if self.first_write {
                self.first_write = false;
                self.stop.store(true, Ordering::Relaxed);
            }
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    #[derive(Default)]
    struct CountingSink {
        write_calls: usize,
        bytes: Vec<u8>,
    }

    #[cfg(target_os = "macos")]
    impl StdWrite for CountingSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.write_calls += 1;
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn publish_test_compositor_frame(
        frame_store: &CompositorFrameStore,
        sequence: u64,
        width: u32,
        height: u32,
        bytes: &[u8],
    ) -> CompositorFrameHandle {
        let mut store = frame_store.lock().unwrap();
        let mut buffer = store.checkout_buffer(bytes.len());
        buffer.copy_from_slice(bytes);
        store.publish(
            sequence,
            width,
            height,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            Instant::now(),
            buffer,
        )
    }

    fn test_settings() -> EncoderBridgeSettings {
        EncoderBridgeSettings {
            ffmpeg_path: "ffmpeg".to_string(),
            output_path: PathBuf::from("/tmp/bridge.mp4"),
            width: 640,
            height: 360,
            fps: 30,
            duration_ms: 2_000,
            bitrate_kbps: 2_000,
        }
    }

    #[test]
    fn bridge_args_feed_raw_rgba_frames_into_ffmpeg() {
        let args = encoder_bridge_ffmpeg_args(&test_settings());

        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&"rawvideo".to_string()));
        assert!(args.contains(&"-pix_fmt".to_string()));
        assert!(args.contains(&"rgba".to_string()));
        assert!(args.contains(&"-video_size".to_string()));
        assert!(args.contains(&"640x360".to_string()));
        assert!(args.contains(&"-framerate".to_string()));
        assert!(args.contains(&"30".to_string()));
        assert!(args.contains(&"pipe:0".to_string()));
        assert!(args.contains(&"-progress".to_string()));
        assert!(args.contains(&"pipe:2".to_string()));
    }

    #[test]
    fn synthetic_frame_renders_rgba_pixels_and_marker() {
        let frame = SyntheticMovingSource.render(1, 32, 24);
        let mut bytes = vec![0; raw_rgba_len(frame.width, frame.height).unwrap()];

        render_synthetic_rgba_frame(&frame, &mut bytes);

        assert_eq!(bytes.len(), 32 * 24 * 4);
        assert!(bytes.chunks_exact(4).all(|pixel| pixel[3] == 255));
        assert!(
            bytes
                .chunks_exact(4)
                .any(|pixel| pixel[0] == 255 && pixel[1] == 240 && pixel[2] == 32)
        );
    }

    #[test]
    fn synthetic_recording_frame_renders_yuv420p_pixels_and_marker() {
        let frame = SyntheticMovingSource.render(1, 32, 24);
        let mut bytes = vec![0; raw_yuv420p_len(frame.width, frame.height).unwrap()];

        render_synthetic_yuv420p_frame(&frame, &mut bytes);

        let y_len = 32 * 24;
        let uv_len = 16 * 12;
        assert_eq!(bytes.len(), y_len + uv_len * 2);
        assert!(bytes[..y_len].iter().any(|value| *value == 235));
        assert!(
            bytes[y_len..y_len + uv_len]
                .iter()
                .any(|value| *value == 60)
        );
    }

    #[test]
    fn progress_parser_reads_speed_fps_and_drops() {
        let progress =
            parse_encoder_progress_line("fps=29.95 speed=0.99x drop_frames=3").expect("progress");

        assert_eq!(progress.encoded_fps, Some(29.95));
        assert_eq!(progress.encoder_speed, Some(0.99));
        assert_eq!(progress.dropped_frames, Some(3));
    }

    #[test]
    fn frame_count_rounds_up_to_cover_duration() {
        assert_eq!(frame_count(2_000, 30), 60);
        assert_eq!(frame_count(1_001, 30), 31);
    }

    #[test]
    fn params_reject_empty_output_path() {
        let params = EncoderBridgeSyntheticParams {
            ffmpeg_path: None,
            output_path: Some(" ".to_string()),
            width: Some(640),
            height: Some(360),
            fps: Some(30),
            duration_ms: Some(2_000),
            bitrate_kbps: Some(2_000),
        };

        assert!(EncoderBridgeSettings::from_params(params).is_err());
    }

    #[test]
    fn params_accept_4k30_recording_profile_bitrate() {
        let params = EncoderBridgeSyntheticParams {
            ffmpeg_path: None,
            output_path: Some("/tmp/bridge-4k30.mp4".to_string()),
            width: Some(3840),
            height: Some(2160),
            fps: Some(30),
            duration_ms: Some(2_000),
            bitrate_kbps: Some(30_000),
        };

        let settings = EncoderBridgeSettings::from_params(params).expect("4K30 bridge settings");

        assert_eq!(settings.width, 3840);
        assert_eq!(settings.height, 2160);
        assert_eq!(settings.fps, 30);
        assert_eq!(settings.bitrate_kbps, 30_000);
    }

    // Plan 026 S1: the writer schedule must NEVER silently compress the video
    // timeline. Simulates the loop arithmetic against a compositor slower than
    // the target fps (the exact shape that produced audio drifting ~0.7s/min on
    // macOS and ~8% timeline compression in the first Windows artifact): every
    // on-schedule tick waits ~34ms for a fresh 29.4fps frame, so the loop
    // overruns its 33.33ms deadline every single iteration. With the absolute
    // schedule + zero-wait catch-up the emitted frame count must track wall
    // time; the old re-anchor design fails this by ~1.3% (≈780ms over 60s).
    #[test]
    fn bridge_schedule_never_compresses_under_a_slow_compositor() {
        let interval = Duration::from_nanos(1_000_000_000 / 30);
        let fresh_wait = Duration::from_micros(34_000); // 29.4fps compositor
        let catchup_cost = Duration::from_millis(2); // instant repeat + write

        let mut wall = Duration::ZERO;
        let mut next_frame_at = Duration::ZERO;
        let mut frames = 0_u64;
        let simulated = Duration::from_secs(60);

        while wall < simulated {
            let lag = wall.saturating_sub(next_frame_at);
            let plan = plan_bridge_tick(lag, interval);
            assert_eq!(
                plan.reanchor_skipped_intervals, 0,
                "a merely-slow compositor must never trigger the stall gap"
            );
            if wall < next_frame_at {
                wall = next_frame_at; // sleep to the deadline
            }
            next_frame_at += interval;
            wall += if plan.skip_fresh_wait {
                catchup_cost
            } else {
                fresh_wait
            };
            frames += 1;
        }

        let timeline = interval * frames as u32;
        let drift = if timeline > wall {
            timeline - wall
        } else {
            wall - timeline
        };
        assert!(
            drift <= Duration::from_millis(100),
            "video timeline drifted {}ms from wall clock over 60s (frames {frames})",
            drift.as_millis()
        );
    }

    #[test]
    fn bridge_schedule_stall_gap_is_explicit_and_wall_true() {
        let interval = Duration::from_nanos(1_000_000_000 / 30);

        // Sub-threshold lag: catch up with repeats, never drop intervals.
        let behind = plan_bridge_tick(Duration::from_millis(500), interval);
        assert!(behind.skip_fresh_wait);
        assert_eq!(behind.reanchor_skipped_intervals, 0);

        // On schedule: normal fresh-frame wait.
        let on_time = plan_bridge_tick(Duration::ZERO, interval);
        assert!(!on_time.skip_fresh_wait);
        assert_eq!(on_time.reanchor_skipped_intervals, 0);

        // Pathological stall (app nap): drop WHOLE intervals as an explicit,
        // counted gap so PTS stay wall-true instead of compressing.
        let raw_stalled = plan_bridge_tick(Duration::from_secs(5), interval);
        assert!(raw_stalled.skip_fresh_wait);
        assert_eq!(raw_stalled.reanchor_skipped_intervals, 150);

        let raw_just_below_threshold = plan_bridge_tick(
            ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD - Duration::from_nanos(1),
            interval,
        );
        assert_eq!(raw_just_below_threshold.reanchor_skipped_intervals, 0);
        let raw_at_threshold = plan_bridge_tick(ENCODER_BRIDGE_STALL_REANCHOR_THRESHOLD, interval);
        assert!(raw_at_threshold.reanchor_skipped_intervals > 0);

        let timestamped_stalled = plan_bridge_tick(Duration::from_secs(5), interval);
        assert!(timestamped_stalled.skip_fresh_wait);
        assert_eq!(timestamped_stalled.reanchor_skipped_intervals, 150); // 5s / 33.33ms
    }
}
